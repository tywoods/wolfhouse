'use strict';

/**
 * Crowsnest Luna Sales durable store (Chapters 1–6 + 9–11: durable prospects, evidence,
 * qualification, review queue, CRM review readiness / preview support, outreach drafts,
 * manual contact candidates, read-only analytics summaries, approved CRM sync attempts).
 * Chapter 11 governance is a pure policy surface and does not add store tables.
 *
 * Owns config validation, repository adapters (memory / postgres / fail-closed),
 * and a bounded pg pool lifecycle. Never reads WOLFHOUSE_DATABASE_URL.
 * Never reads HubSpot Service Keys / HUBSPOT_* env; attempt rows store IDs/status
 * categories only (no tokens, raw payloads, email/phone, or JSON blobs).
 *
 * Production without CROWSNEST_SALES_DATABASE_URL fails closed for mutations.
 * Non-production / test may fall back to an explicit in-memory repository.
 */

const crypto = require('crypto');

const SALES_DSN_ENV = 'CROWSNEST_SALES_DATABASE_URL';
const SALES_SCHEMA = 'luna_sales';
const POOL_MAX = 4;
const POOL_IDLE_MS = 30_000;
const POOL_CONNECT_MS = 10_000;

const APPROVED_CRM_SYNC_STATUSES = Object.freeze(['pending', 'succeeded', 'failed']);
const APPROVED_CRM_SYNC_PROVIDER = 'hubspot';
const APPROVED_CRM_SYNC_ERROR_CATEGORIES = Object.freeze([
  '',
  'auth_failed',
  'rate_limited',
  'timeout',
  'provider_rejected',
  'transport_failed',
  'transport_required',
  'invalid_command',
  'automatic_forbidden',
  'deal_forbidden',
  'hubspot_not_configured',
  'store_failed',
  'unknown',
]);

/** @type {import('pg').Pool | null} */
let salesPool = null;

function isProductionEnv(env = process.env) {
  return String(env.NODE_ENV || '').toLowerCase() === 'production';
}

function misconfiguredResult(message) {
  return {
    ok: false,
    status: 503,
    code: 'sales_store_misconfigured',
    error: message || 'Crowsnest Sales durable store is not configured.',
  };
}

const SALES_UNAVAILABLE_MESSAGE = 'Crowsnest Sales store is temporarily unavailable. Please retry.';

function salesUnavailableResult() {
  return {
    ok: false,
    status: 503,
    code: 'sales_unavailable',
    error: SALES_UNAVAILABLE_MESSAGE,
    retryable: true,
  };
}

class SalesStoreUnavailableError extends Error {
  constructor(message = SALES_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'SalesStoreUnavailableError';
    this.code = 'sales_unavailable';
    this.status = 503;
    this.retryable = true;
  }
}

function isSalesStoreUnavailableError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err instanceof SalesStoreUnavailableError) return true;
  return err.name === 'SalesStoreUnavailableError'
    || err.code === 'sales_unavailable'
    || (err.status === 503 && err.retryable === true && err.code === 'sales_unavailable');
}

function isSalesUnavailableResult(result) {
  return Boolean(
    result
      && result.ok === false
      && result.status === 503
      && result.code === 'sales_unavailable'
      && result.retryable === true,
  );
}

/**
 * Resolve which Sales persistence backend to use.
 * Never consults WOLFHOUSE_DATABASE_URL or DATABASE_URL.
 */
function resolveSalesStoreConfig(env = process.env) {
  const dsn = String(env[SALES_DSN_ENV] || '').trim();
  if (dsn) {
    return {
      ok: true,
      backend: 'postgres',
      databaseUrl: dsn,
      dsnEnv: SALES_DSN_ENV,
      schema: SALES_SCHEMA,
    };
  }
  if (isProductionEnv(env)) {
    return {
      ok: false,
      backend: 'fail_closed',
      code: 'sales_store_misconfigured',
      error: `${SALES_DSN_ENV} is required in production for Sales mutations.`,
      schema: SALES_SCHEMA,
    };
  }
  return {
    ok: true,
    backend: 'memory',
    reason: 'non_production_memory_fallback',
    schema: SALES_SCHEMA,
  };
}

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function isUniqueViolation(err) {
  if (!err || typeof err !== 'object') return false;
  if (String(err.code || '') === '23505') return true;
  return /duplicate key value violates unique constraint/i.test(String(err.message || ''));
}

function normalizeProviderContactIds(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((id) => String(id == null ? '' : id).trim())
    .filter(Boolean);
}

function normalizeApprovedCrmSyncStatus(value) {
  const status = String(value == null ? '' : value).trim().toLowerCase();
  return APPROVED_CRM_SYNC_STATUSES.includes(status) ? status : 'pending';
}

/**
 * Persist only a short sanitized error category — never tokens, payloads, or prose.
 */
function sanitizeApprovedCrmSyncErrorCategory(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  if (APPROVED_CRM_SYNC_ERROR_CATEGORIES.includes(raw)) return raw;
  const firstToken = raw.split(/[\s{,:;]+/)[0];
  if (APPROVED_CRM_SYNC_ERROR_CATEGORIES.includes(firstToken)) return firstToken;
  if (
    /pat-na1-|Bearer\s|postgres:\/\/|hubspot-service-key|[{}\n]|https?:\/\//i.test(raw)
    || raw.length > 64
  ) {
    return 'unknown';
  }
  if (/^[a-z][a-z0-9_]{0,63}$/.test(raw)) return raw;
  return 'unknown';
}

function normalizeApprovedCrmSyncAttempt(input = {}) {
  const provider = String(input.provider == null ? '' : input.provider).trim().toLowerCase();
  if (provider && provider !== APPROVED_CRM_SYNC_PROVIDER) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_provider',
      error: 'Approved CRM sync attempts only support provider hubspot.',
    };
  }
  const idempotencyKey = String(input.idempotency_key == null ? '' : input.idempotency_key).trim();
  if (!idempotencyKey) {
    return {
      ok: false,
      status: 400,
      code: 'idempotency_key_required',
      error: 'Approved CRM sync attempts require an idempotency key.',
    };
  }
  const prospectId = String(input.prospect_id == null ? '' : input.prospect_id).trim();
  const markId = String(input.crm_review_mark_id == null ? '' : input.crm_review_mark_id).trim();
  if (!prospectId || !markId) {
    return {
      ok: false,
      status: 400,
      code: 'attempt_refs_required',
      error: 'Approved CRM sync attempts require prospect_id and crm_review_mark_id.',
    };
  }
  const now = new Date().toISOString();
  return {
    ok: true,
    attempt: {
      id: String(input.id || ''),
      prospect_id: prospectId,
      crm_review_mark_id: markId,
      provider: APPROVED_CRM_SYNC_PROVIDER,
      idempotency_key: idempotencyKey,
      status: normalizeApprovedCrmSyncStatus(input.status),
      provider_company_id: String(input.provider_company_id == null ? '' : input.provider_company_id).trim(),
      provider_contact_ids: normalizeProviderContactIds(input.provider_contact_ids),
      actor_id: String(input.actor_id == null ? 'Admin' : input.actor_id).trim() || 'Admin',
      error_category: sanitizeApprovedCrmSyncErrorCategory(input.error_category),
      created_at: input.created_at || now,
      updated_at: input.updated_at || input.created_at || now,
    },
  };
}

function mapApprovedCrmSyncAttemptRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    prospect_id: String(row.prospect_id),
    crm_review_mark_id: String(row.crm_review_mark_id),
    provider: row.provider || APPROVED_CRM_SYNC_PROVIDER,
    idempotency_key: String(row.idempotency_key || ''),
    status: normalizeApprovedCrmSyncStatus(row.status),
    provider_company_id: row.provider_company_id || '',
    provider_contact_ids: normalizeProviderContactIds(row.provider_contact_ids),
    actor_id: row.actor_id || 'Admin',
    error_category: sanitizeApprovedCrmSyncErrorCategory(row.error_category),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function createMemorySalesRepository() {
  const prospects = new Map();
  /** @type {Map<string, object[]>} */
  const researchByProspect = new Map();
  /** @type {Map<string, object[]>} */
  const qualificationsByProspect = new Map();
  /** @type {Map<string, object[]>} */
  const crmReviewMarksByProspect = new Map();
  /** @type {Map<string, object[]>} */
  const outreachDraftRevisionsByProspect = new Map();
  /** @type {Map<string, object[]>} */
  const contactCandidatesByProspect = new Map();
  /** @type {Map<string, object>} idempotency_key -> attempt */
  const approvedCrmSyncAttemptsByKey = new Map();
  /** @type {Map<string, object>} id -> attempt */
  const approvedCrmSyncAttemptsById = new Map();
  const auditEvents = [];

  function researchListFor(id) {
    const list = researchByProspect.get(String(id || '')) || [];
    return list
      .map((row) => cloneJson(row))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  function qualificationListFor(id) {
    const list = qualificationsByProspect.get(String(id || '')) || [];
    return list
      .map((row) => cloneJson(row))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  function crmReviewMarkListFor(id) {
    const list = crmReviewMarksByProspect.get(String(id || '')) || [];
    return list
      .map((row) => cloneJson(row))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  function outreachDraftRevisionListFor(id) {
    const list = outreachDraftRevisionsByProspect.get(String(id || '')) || [];
    return list
      .map((row) => cloneJson(row))
      .sort((a, b) => {
        const revDiff = Number(b.revision_number || 0) - Number(a.revision_number || 0);
        if (revDiff !== 0) return revDiff;
        return String(b.created_at || '').localeCompare(String(a.created_at || ''));
      });
  }

  function contactCandidateListFor(id) {
    const list = contactCandidatesByProspect.get(String(id || '')) || [];
    return list
      .map((row) => cloneJson(row))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  return {
    backend: 'memory',
    async createProspectRecord(prospect) {
      const row = cloneJson(prospect);
      prospects.set(String(row.id), row);
      return { ok: true, prospect: cloneJson(row) };
    },
    async saveResearchJob(research) {
      const row = cloneJson(research);
      const key = String(row.prospect_id);
      const list = researchByProspect.get(key) || [];
      list.push(row);
      researchByProspect.set(key, list);
      return { ok: true, research: cloneJson(row) };
    },
    async saveQualificationAssessment(assessment) {
      const row = cloneJson(assessment);
      const key = String(row.prospect_id);
      const list = qualificationsByProspect.get(key) || [];
      list.push(row);
      qualificationsByProspect.set(key, list);
      return { ok: true, assessment: cloneJson(row) };
    },
    async saveCrmReviewMark(mark) {
      const row = cloneJson(mark);
      const key = String(row.prospect_id);
      const list = crmReviewMarksByProspect.get(key) || [];
      list.push(row);
      crmReviewMarksByProspect.set(key, list);
      return { ok: true, mark: cloneJson(row) };
    },
    async saveOutreachDraftRevision(revision) {
      const row = cloneJson(revision);
      const key = String(row.prospect_id);
      const list = outreachDraftRevisionsByProspect.get(key) || [];
      list.push(row);
      outreachDraftRevisionsByProspect.set(key, list);
      return { ok: true, revision: cloneJson(row) };
    },
    async saveContactCandidate(contact) {
      const row = cloneJson(contact);
      const key = String(row.prospect_id);
      const list = contactCandidatesByProspect.get(key) || [];
      list.push(row);
      contactCandidatesByProspect.set(key, list);
      return { ok: true, contact: cloneJson(row) };
    },
    async saveApprovedCrmSyncAttempt(attemptInput) {
      const normalized = normalizeApprovedCrmSyncAttempt(attemptInput);
      if (!normalized.ok) return normalized;
      const row = cloneJson(normalized.attempt);
      if (!row.id) {
        return {
          ok: false,
          status: 400,
          code: 'attempt_id_required',
          error: 'Approved CRM sync attempts require an id.',
        };
      }
      const existing = approvedCrmSyncAttemptsByKey.get(row.idempotency_key);
      if (existing) {
        return {
          ok: true,
          attempt: cloneJson(existing),
          idempotent_replay: true,
        };
      }
      approvedCrmSyncAttemptsByKey.set(row.idempotency_key, row);
      approvedCrmSyncAttemptsById.set(String(row.id), row);
      return { ok: true, attempt: cloneJson(row) };
    },
    async updateApprovedCrmSyncAttemptOutcome(id, patch = {}) {
      const existing = approvedCrmSyncAttemptsById.get(String(id || ''));
      if (!existing) {
        return { ok: false, error: 'Approved CRM sync attempt not found.', status: 404 };
      }
      const next = {
        ...existing,
        status: normalizeApprovedCrmSyncStatus(patch.status != null ? patch.status : existing.status),
        provider_company_id: patch.provider_company_id != null
          ? String(patch.provider_company_id).trim()
          : existing.provider_company_id,
        provider_contact_ids: patch.provider_contact_ids != null
          ? normalizeProviderContactIds(patch.provider_contact_ids)
          : existing.provider_contact_ids,
        error_category: patch.error_category != null
          ? sanitizeApprovedCrmSyncErrorCategory(patch.error_category)
          : existing.error_category,
        updated_at: patch.updated_at || new Date().toISOString(),
      };
      approvedCrmSyncAttemptsById.set(String(next.id), next);
      approvedCrmSyncAttemptsByKey.set(next.idempotency_key, next);
      return { ok: true, attempt: cloneJson(next) };
    },
    async getApprovedCrmSyncAttemptByIdempotencyKey(idempotencyKey) {
      const row = approvedCrmSyncAttemptsByKey.get(String(idempotencyKey || '').trim());
      return row ? cloneJson(row) : null;
    },
    async listApprovedCrmSyncAttemptsForProspect(prospectId) {
      const pid = String(prospectId || '');
      return Array.from(approvedCrmSyncAttemptsById.values())
        .filter((row) => String(row.prospect_id) === pid)
        .map((row) => cloneJson(row))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    },
    async appendAuditEvent(event) {
      const row = cloneJson(event);
      auditEvents.push(row);
      return { ok: true, event: cloneJson(row) };
    },
    async updateProspectDecision(id, patch) {
      const existing = prospects.get(String(id || ''));
      if (!existing) {
        return { ok: false, error: 'Prospect not found.', status: 404 };
      }
      const next = {
        ...existing,
        lifecycle_status: patch.lifecycle_status,
        updated_at: patch.updated_at,
        last_decision: cloneJson(patch.last_decision),
      };
      prospects.set(String(id), next);
      return { ok: true, prospect: cloneJson(next) };
    },
    async getProspect(id) {
      const row = prospects.get(String(id || ''));
      return row ? cloneJson(row) : null;
    },
    async listProspects() {
      return Array.from(prospects.values())
        .map((row) => cloneJson(row))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    },
    async getResearchForProspect(id) {
      const list = researchListFor(id);
      return list.length ? list[0] : null;
    },
    async listResearchForProspect(id) {
      return researchListFor(id);
    },
    async listQualificationsForProspect(id) {
      return qualificationListFor(id);
    },
    async getLatestQualification(id) {
      const list = qualificationListFor(id);
      return list.length ? list[0] : null;
    },
    async listCrmReviewMarksForProspect(id) {
      return crmReviewMarkListFor(id);
    },
    async getLatestCrmReviewMark(id) {
      const list = crmReviewMarkListFor(id);
      return list.length ? list[0] : null;
    },
    async listOutreachDraftRevisionsForProspect(id) {
      return outreachDraftRevisionListFor(id);
    },
    async getCurrentOutreachDraftRevision(id) {
      const list = outreachDraftRevisionListFor(id);
      return list.length ? list[0] : null;
    },
    async getNextOutreachDraftRevisionNumber(id) {
      const list = outreachDraftRevisionListFor(id);
      if (!list.length) return 1;
      let max = 0;
      for (const row of list) {
        const n = Number(row.revision_number) || 0;
        if (n > max) max = n;
      }
      return max + 1;
    },
    async listContactCandidatesForProspect(id) {
      return contactCandidateListFor(id);
    },
    async listReviewQueueSummaries() {
      const rows = [];
      for (const prospect of prospects.values()) {
        const research = researchListFor(prospect.id);
        const quals = qualificationListFor(prospect.id);
        const crmMarks = crmReviewMarkListFor(prospect.id);
        const drafts = outreachDraftRevisionListFor(prospect.id);
        const latestQual = quals.length ? quals[0] : null;
        const latestCrmMark = crmMarks.length ? crmMarks[0] : null;
        const latestDraft = drafts.length ? drafts[0] : null;
        const timestamps = [
          prospect.created_at,
          prospect.updated_at,
          ...research.map((row) => row.created_at),
          ...quals.map((row) => row.created_at),
          ...crmMarks.map((row) => row.created_at),
          ...drafts.map((row) => row.created_at),
        ];
        let mostRecent = '';
        for (const value of timestamps) {
          const iso = String(value || '');
          if (iso && (!mostRecent || iso > mostRecent)) mostRecent = iso;
        }
        rows.push({
          id: String(prospect.id),
          canonical_name: prospect.canonical_name || '',
          website_url: prospect.website_url || '',
          created_at: prospect.created_at,
          updated_at: prospect.updated_at,
          evidence_count: research.length,
          latest_qualification_decision: latestQual ? latestQual.decision : null,
          latest_qualification_at: latestQual ? latestQual.created_at : null,
          crm_ready: Boolean(latestCrmMark),
          latest_crm_review_mark_at: latestCrmMark ? latestCrmMark.created_at : null,
          draft_ready: Boolean(latestCrmMark),
          draft_present: Boolean(latestDraft),
          latest_outreach_draft_at: latestDraft ? latestDraft.created_at : null,
          most_recent_activity: mostRecent || String(prospect.updated_at || prospect.created_at || ''),
        });
      }
      return rows;
    },
    async listAnalyticsSummaries() {
      const rows = [];
      for (const prospect of prospects.values()) {
        const research = researchListFor(prospect.id);
        const quals = qualificationListFor(prospect.id);
        const crmMarks = crmReviewMarkListFor(prospect.id);
        const drafts = outreachDraftRevisionListFor(prospect.id);
        const contacts = contactCandidateListFor(prospect.id);
        const latestQual = quals.length ? quals[0] : null;
        const latestCrmMark = crmMarks.length ? crmMarks[0] : null;
        const latestDraft = drafts.length ? drafts[0] : null;
        const timestamps = [
          prospect.created_at,
          prospect.updated_at,
          ...research.map((row) => row.created_at),
          ...quals.map((row) => row.created_at),
          ...crmMarks.map((row) => row.created_at),
          ...drafts.map((row) => row.created_at),
          ...contacts.map((row) => row.created_at),
        ];
        let mostRecent = '';
        for (const value of timestamps) {
          const iso = String(value || '');
          if (iso && (!mostRecent || iso > mostRecent)) mostRecent = iso;
        }
        rows.push({
          id: String(prospect.id),
          canonical_name: prospect.canonical_name || '',
          website_url: prospect.website_url || '',
          created_at: prospect.created_at,
          updated_at: prospect.updated_at,
          evidence_count: research.length,
          contact_count: contacts.length,
          latest_qualification_decision: latestQual ? latestQual.decision : null,
          latest_qualification_at: latestQual ? latestQual.created_at : null,
          crm_ready: Boolean(latestCrmMark),
          latest_crm_review_mark_at: latestCrmMark ? latestCrmMark.created_at : null,
          draft_ready: Boolean(latestCrmMark),
          draft_present: Boolean(latestDraft),
          latest_outreach_draft_at: latestDraft ? latestDraft.created_at : null,
          most_recent_activity: mostRecent || String(prospect.updated_at || prospect.created_at || ''),
        });
      }
      return rows;
    },
    async listAuditEvents(prospectId) {
      const events = auditEvents.map((row) => cloneJson(row));
      if (!prospectId) return events;
      const pid = String(prospectId);
      return events.filter((event) => {
        if (event.entity_id === pid) return true;
        if (event.detail && event.detail.prospect_id === pid) return true;
        return false;
      });
    },
    async reset() {
      prospects.clear();
      researchByProspect.clear();
      qualificationsByProspect.clear();
      crmReviewMarksByProspect.clear();
      outreachDraftRevisionsByProspect.clear();
      contactCandidatesByProspect.clear();
      approvedCrmSyncAttemptsByKey.clear();
      approvedCrmSyncAttemptsById.clear();
      auditEvents.length = 0;
    },
  };
}

function createFailClosedSalesRepository(config = {}) {
  const message = config.error
    || `${SALES_DSN_ENV} is required in production for Sales mutations.`;
  const reject = async () => misconfiguredResult(message);
  return {
    backend: 'fail_closed',
    createProspectRecord: reject,
    saveResearchJob: reject,
    saveQualificationAssessment: reject,
    saveCrmReviewMark: reject,
    saveOutreachDraftRevision: reject,
    saveContactCandidate: reject,
    saveApprovedCrmSyncAttempt: reject,
    updateApprovedCrmSyncAttemptOutcome: reject,
    appendAuditEvent: reject,
    updateProspectDecision: reject,
    async getProspect() {
      return null;
    },
    async listProspects() {
      return [];
    },
    async getResearchForProspect() {
      return null;
    },
    async listResearchForProspect() {
      return [];
    },
    async listQualificationsForProspect() {
      return [];
    },
    async getLatestQualification() {
      return null;
    },
    async listCrmReviewMarksForProspect() {
      return [];
    },
    async getLatestCrmReviewMark() {
      return null;
    },
    async listOutreachDraftRevisionsForProspect() {
      return [];
    },
    async getCurrentOutreachDraftRevision() {
      return null;
    },
    async getNextOutreachDraftRevisionNumber() {
      return misconfiguredResult(message);
    },
    async listContactCandidatesForProspect() {
      return [];
    },
    async getApprovedCrmSyncAttemptByIdempotencyKey() {
      return null;
    },
    async listApprovedCrmSyncAttemptsForProspect() {
      return [];
    },
    async listReviewQueueSummaries() {
      return misconfiguredResult(message);
    },
    async listAnalyticsSummaries() {
      return misconfiguredResult(message);
    },
    async listAuditEvents() {
      return [];
    },
    async reset() {},
  };
}

function mapProspectRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    canonical_name: row.canonical_name || '',
    website_url: row.website_url || '',
    lifecycle_status: row.lifecycle_status,
    owner_id: row.owner_id || 'Admin',
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    last_decision: row.last_decision == null ? null : cloneJson(row.last_decision),
  };
}

function mapResearchRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    prospect_id: String(row.prospect_id),
    source: row.source,
    status: row.status,
    job_label: row.job_label || '',
    summary: row.summary || '',
    facts: cloneJson(row.facts || []),
    limitations: cloneJson(row.limitations || []),
    source_url: row.source_url || '',
    confidence: row.confidence || '',
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function mapAuditRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
    actor: row.actor,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: String(row.entity_id),
    detail: cloneJson(row.detail || {}),
  };
}

function mapQualificationRow(row) {
  if (!row) return null;
  const evidenceIds = Array.isArray(row.evidence_ids)
    ? row.evidence_ids.map((id) => String(id))
    : cloneJson(row.evidence_ids || []);
  return {
    id: String(row.id),
    prospect_id: String(row.prospect_id),
    decision: row.decision,
    rationale: row.rationale || '',
    evidence_ids: evidenceIds,
    reviewer_id: row.reviewer_id || 'Admin',
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function mapCrmReviewMarkRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    prospect_id: String(row.prospect_id),
    qualification_assessment_id: String(row.qualification_assessment_id),
    reviewer_id: row.reviewer_id || 'Admin',
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function mapOutreachDraftRevisionRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    prospect_id: String(row.prospect_id),
    revision_number: Number(row.revision_number) || 0,
    subject: row.subject || '',
    body: row.body || '',
    channel: row.channel || '',
    next_step_note: row.next_step_note || '',
    author_id: row.author_id || 'Admin',
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    message_sent: false,
    disclaimer: 'Draft only — no message has been sent.',
  };
}

function mapContactCandidateRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    prospect_id: String(row.prospect_id),
    full_name: row.full_name || '',
    role: row.role || '',
    email: row.email || '',
    phone: row.phone || '',
    linkedin_url: row.linkedin_url || '',
    source: row.source || '',
    confidence: row.confidence || '',
    author_id: row.author_id || 'Admin',
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    disclaimer: 'Manual contact records only — no Apollo lookup, no auto-find, no CRM write, no message sent.',
    external_lookup_used: false,
    auto_found: false,
    message_sent: false,
  };
}

/**
 * Postgres repository. Inject `query(sql, params)` for tests; otherwise uses
 * the bounded Crowsnest Sales pool opened from CROWSNEST_SALES_DATABASE_URL.
 * Inject `runTransaction(fn)` for offline atomic-create tests.
 */
function createPgSalesRepository(options = {}) {
  const queryFn = options.query
    || (async (sql, params) => {
      const pool = getSalesPool(options);
      return pool.query(sql, params);
    });

  const runTransaction = options.runTransaction
    || (async (fn) => {
      const pool = getSalesPool(options);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await fn((sql, params) => client.query(sql, params));
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback failure; original error is authoritative
        }
        throw err;
      } finally {
        client.release();
      }
    });

  async function insertProspect(txQuery, prospect) {
    await txQuery(
      `INSERT INTO luna_sales.prospects (
          id, canonical_name, website_url, lifecycle_status, owner_id,
          last_decision, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz)`,
      [
        prospect.id,
        prospect.canonical_name || '',
        prospect.website_url || '',
        prospect.lifecycle_status,
        prospect.owner_id || 'Admin',
        JSON.stringify(prospect.last_decision),
        prospect.created_at,
        prospect.updated_at,
      ],
    );
  }

  async function insertResearch(txQuery, research) {
    await txQuery(
      `INSERT INTO luna_sales.research_jobs (
          id, prospect_id, source, status, job_label, summary, facts, limitations,
          source_url, confidence, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::timestamptz)`,
      [
        research.id,
        research.prospect_id,
        research.source,
        research.status,
        research.job_label || '',
        research.summary || '',
        JSON.stringify(research.facts || []),
        JSON.stringify(research.limitations || []),
        research.source_url || '',
        research.confidence || '',
        research.created_at,
      ],
    );
  }

  async function insertAudit(txQuery, event) {
    await txQuery(
      `INSERT INTO luna_sales.audit_events (
          id, at, actor, action, entity_type, entity_id, detail
        ) VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7::jsonb)`,
      [
        event.id,
        event.at,
        event.actor,
        event.action,
        event.entity_type,
        event.entity_id,
        JSON.stringify(event.detail || {}),
      ],
    );
  }

  async function insertQualification(txQuery, assessment) {
    await txQuery(
      `INSERT INTO luna_sales.qualification_assessments (
          id, prospect_id, decision, rationale, evidence_ids, reviewer_id, created_at
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz)`,
      [
        assessment.id,
        assessment.prospect_id,
        assessment.decision,
        assessment.rationale || '',
        JSON.stringify(assessment.evidence_ids || []),
        assessment.reviewer_id || 'Admin',
        assessment.created_at,
      ],
    );
  }

  async function insertCrmReviewMark(txQuery, mark) {
    await txQuery(
      `INSERT INTO luna_sales.crm_review_marks (
          id, prospect_id, qualification_assessment_id, reviewer_id, created_at
        ) VALUES ($1, $2, $3, $4, $5::timestamptz)`,
      [
        mark.id,
        mark.prospect_id,
        mark.qualification_assessment_id,
        mark.reviewer_id || 'Admin',
        mark.created_at,
      ],
    );
  }

  async function insertOutreachDraftRevision(txQuery, revision) {
    await txQuery(
      `INSERT INTO luna_sales.outreach_draft_revisions (
          id, prospect_id, revision_number, subject, body, channel, next_step_note, author_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
      [
        revision.id,
        revision.prospect_id,
        revision.revision_number,
        revision.subject || '',
        revision.body || '',
        revision.channel,
        revision.next_step_note || '',
        revision.author_id || 'Admin',
        revision.created_at,
      ],
    );
  }

  async function insertContactCandidate(txQuery, contact) {
    await txQuery(
      `INSERT INTO luna_sales.contact_candidates (
          id, prospect_id, full_name, role, email, phone, linkedin_url, source, confidence, author_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
      [
        contact.id,
        contact.prospect_id,
        contact.full_name || '',
        contact.role || '',
        contact.email || '',
        contact.phone || '',
        contact.linkedin_url || '',
        contact.source || '',
        contact.confidence || '',
        contact.author_id || 'Admin',
        contact.created_at,
      ],
    );
  }

  async function insertApprovedCrmSyncAttempt(txQuery, attempt) {
    await txQuery(
      `INSERT INTO luna_sales.approved_crm_sync_attempts (
          id, prospect_id, crm_review_mark_id, provider, idempotency_key, status,
          provider_company_id, provider_contact_ids, actor_id, error_category,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8::text[], $9, $10,
          $11::timestamptz, $12::timestamptz
        )`,
      [
        attempt.id,
        attempt.prospect_id,
        attempt.crm_review_mark_id,
        attempt.provider,
        attempt.idempotency_key,
        attempt.status,
        attempt.provider_company_id || '',
        normalizeProviderContactIds(attempt.provider_contact_ids),
        attempt.actor_id || 'Admin',
        attempt.error_category || '',
        attempt.created_at,
        attempt.updated_at,
      ],
    );
  }

  return {
    backend: 'postgres',
    async createProspectBundle({ prospect, research, auditEvents = [] } = {}) {
      try {
        await runTransaction(async (txQuery) => {
          await insertProspect(txQuery, prospect);
          await insertResearch(txQuery, research);
          for (const event of auditEvents) {
            await insertAudit(txQuery, event);
          }
        });
        return { ok: true, prospect: cloneJson(prospect), research: cloneJson(research) };
      } catch {
        return salesUnavailableResult();
      }
    },
    async createProspectRecord(prospect) {
      try {
        await insertProspect(queryFn, prospect);
        return { ok: true, prospect: cloneJson(prospect) };
      } catch {
        return salesUnavailableResult();
      }
    },
    async saveResearchJob(research) {
      try {
        await insertResearch(queryFn, research);
        return { ok: true, research: cloneJson(research) };
      } catch {
        return salesUnavailableResult();
      }
    },
    async saveQualificationAssessment(assessment) {
      try {
        await insertQualification(queryFn, assessment);
        return { ok: true, assessment: cloneJson(assessment) };
      } catch {
        return salesUnavailableResult();
      }
    },
    async saveCrmReviewMark(mark) {
      try {
        await insertCrmReviewMark(queryFn, mark);
        return { ok: true, mark: cloneJson(mark) };
      } catch {
        return salesUnavailableResult();
      }
    },
    async saveOutreachDraftRevision(revision) {
      try {
        await insertOutreachDraftRevision(queryFn, revision);
        return { ok: true, revision: cloneJson(revision) };
      } catch {
        return salesUnavailableResult();
      }
    },
    async saveContactCandidate(contact) {
      try {
        await insertContactCandidate(queryFn, contact);
        return { ok: true, contact: cloneJson(contact) };
      } catch {
        return salesUnavailableResult();
      }
    },
    async saveApprovedCrmSyncAttempt(attemptInput) {
      const normalized = normalizeApprovedCrmSyncAttempt(attemptInput);
      if (!normalized.ok) return normalized;
      const attempt = normalized.attempt;
      if (!attempt.id) {
        return {
          ok: false,
          status: 400,
          code: 'attempt_id_required',
          error: 'Approved CRM sync attempts require an id.',
        };
      }
      try {
        await insertApprovedCrmSyncAttempt(queryFn, attempt);
        return { ok: true, attempt: cloneJson(attempt) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          try {
            const existingResult = await queryFn(
              `SELECT id, prospect_id, crm_review_mark_id, provider, idempotency_key, status,
                      provider_company_id, provider_contact_ids, actor_id, error_category,
                      created_at, updated_at
               FROM luna_sales.approved_crm_sync_attempts
               WHERE idempotency_key = $1`,
              [attempt.idempotency_key],
            );
            const existing = mapApprovedCrmSyncAttemptRow(
              existingResult.rows && existingResult.rows[0],
            );
            if (existing) {
              return { ok: true, attempt: existing, idempotent_replay: true };
            }
          } catch {
            // fall through to conflict without leaking DB detail
          }
          return {
            ok: false,
            status: 409,
            code: 'idempotency_conflict',
            error: 'An approved CRM sync attempt with this idempotency key already exists.',
          };
        }
        return salesUnavailableResult();
      }
    },
    async updateApprovedCrmSyncAttemptOutcome(id, patch = {}) {
      try {
        const status = normalizeApprovedCrmSyncStatus(patch.status);
        const providerCompanyId = patch.provider_company_id != null
          ? String(patch.provider_company_id).trim()
          : '';
        const providerContactIds = normalizeProviderContactIds(patch.provider_contact_ids);
        const errorCategory = sanitizeApprovedCrmSyncErrorCategory(patch.error_category);
        const updatedAt = patch.updated_at || new Date().toISOString();
        const result = await queryFn(
          `UPDATE luna_sales.approved_crm_sync_attempts
           SET status = $2,
               provider_company_id = $3,
               provider_contact_ids = $4::text[],
               error_category = $5,
               updated_at = $6::timestamptz
           WHERE id = $1
           RETURNING id, prospect_id, crm_review_mark_id, provider, idempotency_key, status,
                     provider_company_id, provider_contact_ids, actor_id, error_category,
                     created_at, updated_at`,
          [id, status, providerCompanyId, providerContactIds, errorCategory, updatedAt],
        );
        const row = mapApprovedCrmSyncAttemptRow(result.rows && result.rows[0]);
        if (!row) {
          return { ok: false, error: 'Approved CRM sync attempt not found.', status: 404 };
        }
        return { ok: true, attempt: row };
      } catch {
        return salesUnavailableResult();
      }
    },
    async getApprovedCrmSyncAttemptByIdempotencyKey(idempotencyKey) {
      try {
        const result = await queryFn(
          `SELECT id, prospect_id, crm_review_mark_id, provider, idempotency_key, status,
                  provider_company_id, provider_contact_ids, actor_id, error_category,
                  created_at, updated_at
           FROM luna_sales.approved_crm_sync_attempts
           WHERE idempotency_key = $1`,
          [String(idempotencyKey || '').trim()],
        );
        return mapApprovedCrmSyncAttemptRow(result.rows && result.rows[0]);
      } catch {
        return null;
      }
    },
    async listApprovedCrmSyncAttemptsForProspect(prospectId) {
      try {
        const result = await queryFn(
          `SELECT id, prospect_id, crm_review_mark_id, provider, idempotency_key, status,
                  provider_company_id, provider_contact_ids, actor_id, error_category,
                  created_at, updated_at
           FROM luna_sales.approved_crm_sync_attempts
           WHERE prospect_id = $1
           ORDER BY created_at DESC`,
          [prospectId],
        );
        return (result.rows || []).map(mapApprovedCrmSyncAttemptRow).filter(Boolean);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async appendAuditEvent(event) {
      try {
        await insertAudit(queryFn, event);
        return { ok: true, event: cloneJson(event) };
      } catch {
        return salesUnavailableResult();
      }
    },
    async updateProspectDecision(id, patch) {
      try {
        const result = await queryFn(
          `UPDATE luna_sales.prospects
           SET lifecycle_status = $2,
               last_decision = $3::jsonb,
               updated_at = $4::timestamptz
           WHERE id = $1
           RETURNING id, canonical_name, website_url, lifecycle_status, owner_id,
                     last_decision, created_at, updated_at`,
          [
            id,
            patch.lifecycle_status,
            JSON.stringify(patch.last_decision),
            patch.updated_at,
          ],
        );
        const row = result.rows && result.rows[0];
        if (!row) {
          return { ok: false, error: 'Prospect not found.', status: 404 };
        }
        return { ok: true, prospect: mapProspectRow(row) };
      } catch {
        return salesUnavailableResult();
      }
    },
    async getProspect(id) {
      try {
        const result = await queryFn(
          `SELECT id, canonical_name, website_url, lifecycle_status, owner_id,
                  last_decision, created_at, updated_at
           FROM luna_sales.prospects
           WHERE id = $1`,
          [id],
        );
        return mapProspectRow(result.rows && result.rows[0]);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async listProspects() {
      try {
        const result = await queryFn(
          `SELECT id, canonical_name, website_url, lifecycle_status, owner_id,
                  last_decision, created_at, updated_at
           FROM luna_sales.prospects
           ORDER BY created_at DESC`,
        );
        return (result.rows || []).map(mapProspectRow);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async getResearchForProspect(id) {
      try {
        const result = await queryFn(
          `SELECT id, prospect_id, source, status, job_label, summary, facts, limitations,
                  source_url, confidence, created_at
           FROM luna_sales.research_jobs
           WHERE prospect_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [id],
        );
        return mapResearchRow(result.rows && result.rows[0]);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async listResearchForProspect(id) {
      try {
        const result = await queryFn(
          `SELECT id, prospect_id, source, status, job_label, summary, facts, limitations,
                  source_url, confidence, created_at
           FROM luna_sales.research_jobs
           WHERE prospect_id = $1
           ORDER BY created_at DESC`,
          [id],
        );
        return (result.rows || []).map(mapResearchRow);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async listQualificationsForProspect(id) {
      try {
        const result = await queryFn(
          `SELECT id, prospect_id, decision, rationale, evidence_ids, reviewer_id, created_at
           FROM luna_sales.qualification_assessments
           WHERE prospect_id = $1
           ORDER BY created_at DESC`,
          [id],
        );
        return (result.rows || []).map(mapQualificationRow);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async getLatestQualification(id) {
      try {
        const result = await queryFn(
          `SELECT id, prospect_id, decision, rationale, evidence_ids, reviewer_id, created_at
           FROM luna_sales.qualification_assessments
           WHERE prospect_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [id],
        );
        return mapQualificationRow(result.rows && result.rows[0]);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async listCrmReviewMarksForProspect(id) {
      try {
        const result = await queryFn(
          `SELECT id, prospect_id, qualification_assessment_id, reviewer_id, created_at
           FROM luna_sales.crm_review_marks
           WHERE prospect_id = $1
           ORDER BY created_at DESC`,
          [id],
        );
        return (result.rows || []).map(mapCrmReviewMarkRow);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async getLatestCrmReviewMark(id) {
      try {
        const result = await queryFn(
          `SELECT id, prospect_id, qualification_assessment_id, reviewer_id, created_at
           FROM luna_sales.crm_review_marks
           WHERE prospect_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [id],
        );
        return mapCrmReviewMarkRow(result.rows && result.rows[0]);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async listOutreachDraftRevisionsForProspect(id) {
      try {
        const result = await queryFn(
          `SELECT id, prospect_id, revision_number, subject, body, channel, next_step_note, author_id, created_at
           FROM luna_sales.outreach_draft_revisions
           WHERE prospect_id = $1
           ORDER BY revision_number DESC, created_at DESC`,
          [id],
        );
        return (result.rows || []).map(mapOutreachDraftRevisionRow);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async getCurrentOutreachDraftRevision(id) {
      try {
        const result = await queryFn(
          `SELECT id, prospect_id, revision_number, subject, body, channel, next_step_note, author_id, created_at
           FROM luna_sales.outreach_draft_revisions
           WHERE prospect_id = $1
           ORDER BY revision_number DESC, created_at DESC
           LIMIT 1`,
          [id],
        );
        return mapOutreachDraftRevisionRow(result.rows && result.rows[0]);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async getNextOutreachDraftRevisionNumber(id) {
      try {
        const result = await queryFn(
          `SELECT COALESCE(MAX(revision_number), 0)::int AS max
           FROM luna_sales.outreach_draft_revisions
           WHERE prospect_id = $1`,
          [id],
        );
        const max = result.rows && result.rows[0] && result.rows[0].max != null
          ? Number(result.rows[0].max)
          : 0;
        return (Number.isFinite(max) ? max : 0) + 1;
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async listContactCandidatesForProspect(id) {
      try {
        const result = await queryFn(
          `SELECT id, prospect_id, full_name, role, email, phone, linkedin_url, source, confidence, author_id, created_at
           FROM luna_sales.contact_candidates
           WHERE prospect_id = $1
           ORDER BY created_at DESC`,
          [id],
        );
        return (result.rows || []).map(mapContactCandidateRow);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async listReviewQueueSummaries() {
      try {
        const result = await queryFn(
          `SELECT
             p.id,
             p.canonical_name,
             p.website_url,
             p.created_at,
             p.updated_at,
             (
               SELECT COUNT(*)::int
               FROM luna_sales.research_jobs r
               WHERE r.prospect_id = p.id
             ) AS evidence_count,
             (
               SELECT q.decision
               FROM luna_sales.qualification_assessments q
               WHERE q.prospect_id = p.id
               ORDER BY q.created_at DESC
               LIMIT 1
             ) AS latest_qualification_decision,
             (
               SELECT q.created_at
               FROM luna_sales.qualification_assessments q
               WHERE q.prospect_id = p.id
               ORDER BY q.created_at DESC
               LIMIT 1
             ) AS latest_qualification_at,
             (
               SELECT m.created_at
               FROM luna_sales.crm_review_marks m
               WHERE m.prospect_id = p.id
               ORDER BY m.created_at DESC
               LIMIT 1
             ) AS latest_crm_review_mark_at,
             (
               SELECT d.created_at
               FROM luna_sales.outreach_draft_revisions d
               WHERE d.prospect_id = p.id
               ORDER BY d.revision_number DESC, d.created_at DESC
               LIMIT 1
             ) AS latest_outreach_draft_at,
             GREATEST(
               p.created_at,
               p.updated_at,
               COALESCE(
                 (SELECT MAX(r.created_at) FROM luna_sales.research_jobs r WHERE r.prospect_id = p.id),
                 p.created_at
               ),
               COALESCE(
                 (SELECT MAX(q.created_at) FROM luna_sales.qualification_assessments q WHERE q.prospect_id = p.id),
                 p.created_at
               ),
               COALESCE(
                 (SELECT MAX(m.created_at) FROM luna_sales.crm_review_marks m WHERE m.prospect_id = p.id),
                 p.created_at
               ),
               COALESCE(
                 (SELECT MAX(d.created_at) FROM luna_sales.outreach_draft_revisions d WHERE d.prospect_id = p.id),
                 p.created_at
               )
             ) AS most_recent_activity
           FROM luna_sales.prospects p`,
        );
        return (result.rows || []).map((row) => ({
          id: String(row.id),
          canonical_name: row.canonical_name || '',
          website_url: row.website_url || '',
          created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
          updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || ''),
          evidence_count: Number(row.evidence_count) || 0,
          latest_qualification_decision: row.latest_qualification_decision || null,
          latest_qualification_at: row.latest_qualification_at == null
            ? null
            : (row.latest_qualification_at instanceof Date
              ? row.latest_qualification_at.toISOString()
              : String(row.latest_qualification_at)),
          crm_ready: Boolean(row.latest_crm_review_mark_at),
          latest_crm_review_mark_at: row.latest_crm_review_mark_at == null
            ? null
            : (row.latest_crm_review_mark_at instanceof Date
              ? row.latest_crm_review_mark_at.toISOString()
              : String(row.latest_crm_review_mark_at)),
          draft_ready: Boolean(row.latest_crm_review_mark_at),
          draft_present: Boolean(row.latest_outreach_draft_at),
          latest_outreach_draft_at: row.latest_outreach_draft_at == null
            ? null
            : (row.latest_outreach_draft_at instanceof Date
              ? row.latest_outreach_draft_at.toISOString()
              : String(row.latest_outreach_draft_at)),
          most_recent_activity: row.most_recent_activity instanceof Date
            ? row.most_recent_activity.toISOString()
            : String(row.most_recent_activity || ''),
        }));
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async listAnalyticsSummaries() {
      try {
        const result = await queryFn(
          `SELECT
             p.id,
             p.canonical_name,
             p.website_url,
             p.created_at,
             p.updated_at,
             (
               SELECT COUNT(*)::int
               FROM luna_sales.research_jobs r
               WHERE r.prospect_id = p.id
             ) AS evidence_count,
             (
               SELECT COUNT(*)::int
               FROM luna_sales.contact_candidates c
               WHERE c.prospect_id = p.id
             ) AS contact_count,
             (
               SELECT q.decision
               FROM luna_sales.qualification_assessments q
               WHERE q.prospect_id = p.id
               ORDER BY q.created_at DESC
               LIMIT 1
             ) AS latest_qualification_decision,
             (
               SELECT q.created_at
               FROM luna_sales.qualification_assessments q
               WHERE q.prospect_id = p.id
               ORDER BY q.created_at DESC
               LIMIT 1
             ) AS latest_qualification_at,
             (
               SELECT m.created_at
               FROM luna_sales.crm_review_marks m
               WHERE m.prospect_id = p.id
               ORDER BY m.created_at DESC
               LIMIT 1
             ) AS latest_crm_review_mark_at,
             (
               SELECT d.created_at
               FROM luna_sales.outreach_draft_revisions d
               WHERE d.prospect_id = p.id
               ORDER BY d.revision_number DESC, d.created_at DESC
               LIMIT 1
             ) AS latest_outreach_draft_at,
             GREATEST(
               p.created_at,
               p.updated_at,
               COALESCE(
                 (SELECT MAX(r.created_at) FROM luna_sales.research_jobs r WHERE r.prospect_id = p.id),
                 p.created_at
               ),
               COALESCE(
                 (SELECT MAX(q.created_at) FROM luna_sales.qualification_assessments q WHERE q.prospect_id = p.id),
                 p.created_at
               ),
               COALESCE(
                 (SELECT MAX(m.created_at) FROM luna_sales.crm_review_marks m WHERE m.prospect_id = p.id),
                 p.created_at
               ),
               COALESCE(
                 (SELECT MAX(d.created_at) FROM luna_sales.outreach_draft_revisions d WHERE d.prospect_id = p.id),
                 p.created_at
               ),
               COALESCE(
                 (SELECT MAX(c.created_at) FROM luna_sales.contact_candidates c WHERE c.prospect_id = p.id),
                 p.created_at
               )
             ) AS most_recent_activity
           FROM luna_sales.prospects p`,
        );
        return (result.rows || []).map((row) => ({
          id: String(row.id),
          canonical_name: row.canonical_name || '',
          website_url: row.website_url || '',
          created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
          updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || ''),
          evidence_count: Number(row.evidence_count) || 0,
          contact_count: Number(row.contact_count) || 0,
          latest_qualification_decision: row.latest_qualification_decision || null,
          latest_qualification_at: row.latest_qualification_at == null
            ? null
            : (row.latest_qualification_at instanceof Date
              ? row.latest_qualification_at.toISOString()
              : String(row.latest_qualification_at)),
          crm_ready: Boolean(row.latest_crm_review_mark_at),
          latest_crm_review_mark_at: row.latest_crm_review_mark_at == null
            ? null
            : (row.latest_crm_review_mark_at instanceof Date
              ? row.latest_crm_review_mark_at.toISOString()
              : String(row.latest_crm_review_mark_at)),
          draft_ready: Boolean(row.latest_crm_review_mark_at),
          draft_present: Boolean(row.latest_outreach_draft_at),
          latest_outreach_draft_at: row.latest_outreach_draft_at == null
            ? null
            : (row.latest_outreach_draft_at instanceof Date
              ? row.latest_outreach_draft_at.toISOString()
              : String(row.latest_outreach_draft_at)),
          most_recent_activity: row.most_recent_activity instanceof Date
            ? row.most_recent_activity.toISOString()
            : String(row.most_recent_activity || ''),
        }));
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async listAuditEvents(prospectId) {
      try {
        if (!prospectId) {
          const result = await queryFn(
            `SELECT id, at, actor, action, entity_type, entity_id, detail
             FROM luna_sales.audit_events
             ORDER BY at ASC`,
          );
          return (result.rows || []).map(mapAuditRow);
        }
        const result = await queryFn(
          `SELECT id, at, actor, action, entity_type, entity_id, detail
           FROM luna_sales.audit_events
           WHERE entity_id = $1 OR detail->>'prospect_id' = $1
           ORDER BY at ASC`,
          [String(prospectId)],
        );
        return (result.rows || []).map(mapAuditRow);
      } catch {
        throw new SalesStoreUnavailableError();
      }
    },
    async reset() {
      throw new Error('reset is not supported on postgres Sales repository');
    },
  };
}

function getSalesPool(options = {}) {
  if (options.pool) return options.pool;
  if (salesPool) return salesPool;
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (err) {
    const wrapped = new Error(
      'pg is required for Crowsnest Sales durable store but is not installed',
    );
    wrapped.cause = err;
    throw wrapped;
  }
  const databaseUrl = options.databaseUrl
    || String((options.env || process.env)[SALES_DSN_ENV] || '').trim();
  if (!databaseUrl) {
    throw new Error(`${SALES_DSN_ENV} is required to open the Sales durable pool`);
  }
  salesPool = new Pool({
    connectionString: databaseUrl,
    max: Number(options.max || POOL_MAX),
    idleTimeoutMillis: Number(options.idleTimeoutMillis || POOL_IDLE_MS),
    connectionTimeoutMillis: Number(options.connectionTimeoutMillis || POOL_CONNECT_MS),
    allowExitOnIdle: true,
  });
  return salesPool;
}

async function closeSalesStore() {
  if (!salesPool) return;
  const ending = salesPool;
  salesPool = null;
  await ending.end();
}

/**
 * Create the repository for the current env (or injected env).
 * @param {NodeJS.ProcessEnv|{[k:string]:string}} [env]
 */
async function createSalesRepository(env = process.env) {
  const config = resolveSalesStoreConfig(env);
  if (config.backend === 'fail_closed') {
    return createFailClosedSalesRepository(config);
  }
  if (config.backend === 'memory') {
    return createMemorySalesRepository();
  }
  return createPgSalesRepository({
    env,
    databaseUrl: config.databaseUrl,
  });
}

function newSalesUuid() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = {
  SALES_DSN_ENV,
  SALES_SCHEMA,
  POOL_MAX,
  APPROVED_CRM_SYNC_PROVIDER,
  APPROVED_CRM_SYNC_STATUSES,
  SalesStoreUnavailableError,
  closeSalesStore,
  createFailClosedSalesRepository,
  createMemorySalesRepository,
  createPgSalesRepository,
  createSalesRepository,
  getSalesPool,
  isSalesStoreUnavailableError,
  isSalesUnavailableResult,
  newSalesUuid,
  resolveSalesStoreConfig,
  sanitizeApprovedCrmSyncErrorCategory,
  salesUnavailableResult,
};
