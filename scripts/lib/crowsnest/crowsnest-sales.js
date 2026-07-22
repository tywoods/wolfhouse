'use strict';

/**
 * Crowsnest Luna Sales — prospects, fixture research, manual evidence, qualification, decisions, audit.
 *
 * Persistence goes through crowsnest-sales-store (dedicated CROWSNEST_SALES_DATABASE_URL).
 * In-memory fallback is explicit for non-production/test when the durable DSN is absent.
 * Production without the dedicated DSN fails closed on Sales mutations.
 */

const {
  createMemorySalesRepository,
  createSalesRepository,
  isSalesStoreUnavailableError,
  newSalesUuid,
  resolveSalesStoreConfig,
  salesUnavailableResult,
} = require('./crowsnest-sales-store');

const ALLOWED_DECISIONS = new Set(['approved', 'rejected', 'needs_research']);
const ALLOWED_QUALIFICATION_DECISIONS = new Set(['qualified', 'not_qualified', 'needs_more_research']);
const ALLOWED_EVIDENCE_CONFIDENCE = new Set(['low', 'medium', 'high']);

const EVIDENCE_BOUNDS = {
  sourceLabelMax: 200,
  sourceUrlMax: 2000,
  summaryMax: 4000,
  factualNotesMax: 8000,
  limitationsMax: 4000,
  maxLines: 40,
  maxLineLength: 500,
};

const QUALIFICATION_BOUNDS = {
  rationaleMax: 2000,
  maxEvidenceRefs: 40,
};

/** @type {ReturnType<typeof createMemorySalesRepository> | null} */
let repository = null;
let repositoryInit = null;

function nowIso() {
  return new Date().toISOString();
}

async function getRepository() {
  if (repository) return repository;
  if (!repositoryInit) {
    repositoryInit = createSalesRepository(process.env).then((repo) => {
      repository = repo;
      return repo;
    });
  }
  return repositoryInit;
}

function _setSalesRepositoryForTests(repo) {
  repository = repo || null;
  repositoryInit = repo ? Promise.resolve(repo) : null;
}

async function appendAudit(event) {
  const repo = await getRepository();
  const entry = {
    id: newSalesUuid(),
    at: nowIso(),
    ...event,
  };
  const result = await repo.appendAuditEvent(entry);
  if (result && result.ok === false) {
    return result;
  }
  return (result && result.event) || entry;
}

function normalizeWebsiteUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  return value;
}

function normalizeBusinessName(raw) {
  return String(raw || '').trim();
}

function splitBoundedLines(raw, fieldLabel, maxChars, maxLines, maxLineLength) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) {
    return { ok: false, error: `${fieldLabel} is required.` };
  }
  if (text.length > maxChars) {
    return { ok: false, error: `${fieldLabel} must be at most ${maxChars} characters.` };
  }
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return { ok: false, error: `${fieldLabel} is required.` };
  }
  if (lines.length > maxLines) {
    return { ok: false, error: `${fieldLabel} must have at most ${maxLines} lines.` };
  }
  for (const line of lines) {
    if (line.length > maxLineLength) {
      return {
        ok: false,
        error: `Each ${fieldLabel.toLowerCase()} line must be at most ${maxLineLength} characters.`,
      };
    }
  }
  return { ok: true, lines };
}

function validateManualIntake(input = {}) {
  const websiteUrl = normalizeWebsiteUrl(input.websiteUrl != null ? input.websiteUrl : input.website_url);
  const businessName = normalizeBusinessName(
    input.businessName != null ? input.businessName : input.business_name,
  );
  if (!websiteUrl && !businessName) {
    return {
      ok: false,
      error: 'Provide a business website or a business name.',
      websiteUrl: '',
      businessName: '',
    };
  }
  if (websiteUrl) {
    try {
      const parsed = new URL(websiteUrl.includes('://') ? websiteUrl : `https://${websiteUrl}`);
      if (!parsed.hostname || !parsed.hostname.includes('.')) {
        return {
          ok: false,
          error: 'Website must be a valid URL with a hostname.',
          websiteUrl,
          businessName,
        };
      }
    } catch {
      return {
        ok: false,
        error: 'Website must be a valid URL.',
        websiteUrl,
        businessName,
      };
    }
  }
  return { ok: true, websiteUrl, businessName };
}

function validateManualEvidence(input = {}) {
  const sourceLabel = String(
    input.source_label != null ? input.source_label : (input.sourceLabel || ''),
  ).trim();
  const sourceUrl = String(
    input.source_url != null ? input.source_url : (input.sourceUrl || ''),
  ).trim();
  const summary = String(input.summary || '').trim();
  const factualRaw = input.factual_notes != null ? input.factual_notes : input.factualNotes;
  const limitationsRaw = input.limitations;
  const confidence = String(input.confidence || '').trim().toLowerCase();

  if (!sourceLabel) {
    return { ok: false, error: 'Source label is required.' };
  }
  if (sourceLabel.length > EVIDENCE_BOUNDS.sourceLabelMax) {
    return {
      ok: false,
      error: `Source label must be at most ${EVIDENCE_BOUNDS.sourceLabelMax} characters.`,
    };
  }

  if (!sourceUrl) {
    return { ok: false, error: 'Source URL is required.' };
  }
  if (sourceUrl.length > EVIDENCE_BOUNDS.sourceUrlMax) {
    return {
      ok: false,
      error: `Source URL must be at most ${EVIDENCE_BOUNDS.sourceUrlMax} characters.`,
    };
  }
  try {
    const parsed = new URL(sourceUrl.includes('://') ? sourceUrl : `https://${sourceUrl}`);
    if (!parsed.hostname || !parsed.hostname.includes('.')) {
      return { ok: false, error: 'Source URL must be a valid URL with a hostname.' };
    }
  } catch {
    return { ok: false, error: 'Source URL must be a valid URL.' };
  }

  if (!summary) {
    return { ok: false, error: 'Summary is required.' };
  }
  if (summary.length > EVIDENCE_BOUNDS.summaryMax) {
    return {
      ok: false,
      error: `Summary must be at most ${EVIDENCE_BOUNDS.summaryMax} characters.`,
    };
  }

  const notes = splitBoundedLines(
    factualRaw,
    'Factual notes',
    EVIDENCE_BOUNDS.factualNotesMax,
    EVIDENCE_BOUNDS.maxLines,
    EVIDENCE_BOUNDS.maxLineLength,
  );
  if (!notes.ok) return notes;

  const limits = splitBoundedLines(
    Array.isArray(limitationsRaw) ? limitationsRaw.join('\n') : limitationsRaw,
    'Limitations',
    EVIDENCE_BOUNDS.limitationsMax,
    EVIDENCE_BOUNDS.maxLines,
    EVIDENCE_BOUNDS.maxLineLength,
  );
  if (!limits.ok) return limits;

  if (!ALLOWED_EVIDENCE_CONFIDENCE.has(confidence)) {
    return { ok: false, error: 'Confidence must be low, medium, or high.' };
  }

  return {
    ok: true,
    source_label: sourceLabel,
    source_url: sourceUrl.includes('://') ? sourceUrl : `https://${sourceUrl}`,
    summary,
    factual_notes: notes.lines,
    limitations: limits.lines,
    confidence,
  };
}

function normalizeEvidenceIdList(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((id) => String(id || '').trim()).filter(Boolean);
  }
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.includes(',')) {
    return text.split(',').map((part) => part.trim()).filter(Boolean);
  }
  return [text];
}

function validateQualification(input = {}, availableEvidenceIds = []) {
  const decision = String(
    input.qualification_decision != null ? input.qualification_decision : (input.decision || ''),
  ).trim().toLowerCase();
  const rationale = String(input.rationale || '').trim();
  const evidenceIds = normalizeEvidenceIdList(
    input.evidence_ids != null ? input.evidence_ids : input.evidenceIds,
  );
  const available = new Set(
    (Array.isArray(availableEvidenceIds) ? availableEvidenceIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  );

  if (!ALLOWED_QUALIFICATION_DECISIONS.has(decision)) {
    return {
      ok: false,
      error: 'Qualification decision must be qualified, not_qualified, or needs_more_research.',
    };
  }
  if (!rationale) {
    return { ok: false, error: 'A rationale is required for qualification assessments.' };
  }
  if (rationale.length > QUALIFICATION_BOUNDS.rationaleMax) {
    return {
      ok: false,
      error: `Rationale must be at most ${QUALIFICATION_BOUNDS.rationaleMax} characters.`,
    };
  }
  if (!evidenceIds.length) {
    return { ok: false, error: 'Select at least one evidence reference already on this prospect.' };
  }
  if (evidenceIds.length > QUALIFICATION_BOUNDS.maxEvidenceRefs) {
    return {
      ok: false,
      error: `Select at most ${QUALIFICATION_BOUNDS.maxEvidenceRefs} evidence references.`,
    };
  }
  const unique = [];
  const seen = new Set();
  for (const id of evidenceIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!available.has(id)) {
      return {
        ok: false,
        error: 'Evidence references must belong to this prospect.',
      };
    }
    unique.push(id);
  }

  return {
    ok: true,
    decision,
    rationale,
    evidence_ids: unique,
  };
}

function buildFixtureResearch(prospect) {
  const canonicalName = prospect.canonical_name || prospect.website_url || 'Unknown business';
  return {
    id: newSalesUuid(),
    prospect_id: prospect.id,
    source: 'fixture',
    status: 'completed',
    job_label: 'Manual / fixture research job',
    summary: `Fixture research packet for ${canonicalName}. No live website crawl or AI analysis ran in this slice.`,
    facts: [
      {
        type: 'business_name',
        value: prospect.canonical_name || 'n/a (name not provided)',
        citation: 'manual_intake',
      },
      {
        type: 'website',
        value: prospect.website_url || 'n/a (website not provided)',
        citation: 'manual_intake',
      },
      {
        type: 'market_hint',
        value: 'Northern Spain hospitality pilot scope (fixture)',
        citation: 'fixture_policy',
      },
    ],
    limitations: [
      'Fixture/manual research only — not live crawled.',
      'No automated AI qualification in Slice 1.',
      'Evidence is illustrative for the Admin review loop.',
    ],
    source_url: '',
    confidence: '',
    created_at: nowIso(),
  };
}

function buildManualEvidenceResearch(prospectId, validation) {
  return {
    id: newSalesUuid(),
    prospect_id: prospectId,
    source: 'manual',
    status: 'completed',
    job_label: validation.source_label,
    summary: validation.summary,
    facts: validation.factual_notes.map((value) => ({
      type: 'factual_note',
      value,
      citation: validation.source_label,
    })),
    limitations: validation.limitations,
    source_url: validation.source_url,
    confidence: validation.confidence,
    created_at: nowIso(),
  };
}

async function createProspect(input = {}, actor = 'Admin') {
  const validation = validateManualIntake(input);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  const repo = await getRepository();
  const id = newSalesUuid();
  const createdAt = nowIso();
  const prospect = {
    id,
    canonical_name: validation.businessName || '',
    website_url: validation.websiteUrl || '',
    lifecycle_status: 'ready_for_review',
    owner_id: String(actor || 'Admin'),
    created_at: createdAt,
    updated_at: createdAt,
    last_decision: null,
  };

  const research = buildFixtureResearch(prospect);

  // Postgres path: atomic prospect + fixture research + initial audit records.
  if (typeof repo.createProspectBundle === 'function') {
    const auditEvents = [
      {
        id: newSalesUuid(),
        at: createdAt,
        actor: String(actor || 'Admin'),
        action: 'prospect_created',
        entity_type: 'prospect',
        entity_id: id,
        detail: {
          canonical_name: prospect.canonical_name,
          website_url: prospect.website_url,
          lifecycle_status: prospect.lifecycle_status,
          prospect_id: id,
        },
      },
      {
        id: newSalesUuid(),
        at: createdAt,
        actor: 'system',
        action: 'research_fixture_attached',
        entity_type: 'research',
        entity_id: research.id,
        detail: {
          prospect_id: id,
          source: research.source,
          status: research.status,
        },
      },
    ];
    const bundled = await repo.createProspectBundle({ prospect, research, auditEvents });
    if (bundled && bundled.ok === false) {
      return bundled;
    }
    return { ok: true, prospect, research };
  }

  const created = await repo.createProspectRecord(prospect);
  if (created && created.ok === false) {
    return created;
  }

  const savedResearch = await repo.saveResearchJob(research);
  if (savedResearch && savedResearch.ok === false) {
    return savedResearch;
  }

  const auditCreate = await appendAudit({
    actor: String(actor || 'Admin'),
    action: 'prospect_created',
    entity_type: 'prospect',
    entity_id: id,
    detail: {
      canonical_name: prospect.canonical_name,
      website_url: prospect.website_url,
      lifecycle_status: prospect.lifecycle_status,
      prospect_id: id,
    },
  });
  if (auditCreate && auditCreate.ok === false) {
    return auditCreate;
  }

  const auditResearch = await appendAudit({
    actor: 'system',
    action: 'research_fixture_attached',
    entity_type: 'research',
    entity_id: research.id,
    detail: {
      prospect_id: id,
      source: research.source,
      status: research.status,
    },
  });
  if (auditResearch && auditResearch.ok === false) {
    return auditResearch;
  }

  return { ok: true, prospect, research };
}

const REVIEW_QUEUE_FILTERS = new Set([
  'all',
  'actionable',
  'needs_more_research',
  'qualified',
  'not_qualified',
]);

const ACTIONABLE_REVIEW_BUCKETS = new Set(['ready_for_review', 'needs_more_research']);

function normalizeReviewQueueFilter(raw) {
  const value = String(raw == null ? 'all' : raw).trim().toLowerCase();
  if (!value) return 'all';
  return REVIEW_QUEUE_FILTERS.has(value) ? value : 'all';
}

/**
 * Truthful operating bucket from persisted evidence + latest qualification only.
 * No invented scores or AI priority.
 */
function assignReviewBucket(summary = {}) {
  const decision = String(
    summary.latest_qualification_decision != null
      ? summary.latest_qualification_decision
      : (summary.latestQualification && summary.latestQualification.decision) || '',
  ).trim().toLowerCase();
  const evidenceCount = Number(
    summary.evidence_count != null
      ? summary.evidence_count
      : (Array.isArray(summary.researchJobs) ? summary.researchJobs.length : 0),
  ) || 0;

  if (decision === 'qualified') return 'qualified';
  if (decision === 'not_qualified') return 'not_qualified';
  if (decision === 'needs_more_research') return 'needs_more_research';
  if (evidenceCount > 0) return 'ready_for_review';
  return null;
}

function isActionableReviewBucket(bucket) {
  return ACTIONABLE_REVIEW_BUCKETS.has(String(bucket || ''));
}

function compareReviewQueueItems(a, b) {
  const aActionable = isActionableReviewBucket(a && a.bucket) ? 0 : 1;
  const bActionable = isActionableReviewBucket(b && b.bucket) ? 0 : 1;
  if (aActionable !== bActionable) return aActionable - bActionable;

  const aActivity = String((a && a.most_recent_activity) || '');
  const bActivity = String((b && b.most_recent_activity) || '');
  if (aActivity !== bActivity) return bActivity.localeCompare(aActivity);

  return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
}

function sortReviewQueueItems(items) {
  return (Array.isArray(items) ? items.slice() : []).sort(compareReviewQueueItems);
}

function filterReviewQueueItems(items, state) {
  const filter = normalizeReviewQueueFilter(state);
  const list = Array.isArray(items) ? items : [];
  if (filter === 'all') return list.slice();
  if (filter === 'actionable') {
    return list.filter((item) => isActionableReviewBucket(item && item.bucket));
  }
  return list.filter((item) => String(item && item.bucket) === filter);
}

function maxIsoTimestamp(values) {
  let best = '';
  for (const value of values) {
    const iso = value instanceof Date ? value.toISOString() : String(value || '').trim();
    if (!iso) continue;
    if (!best || iso > best) best = iso;
  }
  return best || nowIso();
}

function buildReviewQueueItem(summary = {}) {
  const evidenceCount = Number(summary.evidence_count) || 0;
  const latestDecision = summary.latest_qualification_decision != null
    ? summary.latest_qualification_decision
    : null;
  const bucket = assignReviewBucket({
    evidence_count: evidenceCount,
    latest_qualification_decision: latestDecision,
  });
  if (!bucket) return null;

  const mostRecentActivity = summary.most_recent_activity
    ? (summary.most_recent_activity instanceof Date
      ? summary.most_recent_activity.toISOString()
      : String(summary.most_recent_activity))
    : maxIsoTimestamp([
      summary.created_at,
      summary.updated_at,
      summary.latest_qualification_at,
    ]);

  return {
    id: String(summary.id),
    canonical_name: summary.canonical_name || '',
    website_url: summary.website_url || '',
    evidence_count: evidenceCount,
    latest_qualification_decision: latestDecision,
    latest_qualification_at: summary.latest_qualification_at
      ? (summary.latest_qualification_at instanceof Date
        ? summary.latest_qualification_at.toISOString()
        : String(summary.latest_qualification_at))
      : null,
    most_recent_activity: mostRecentActivity,
    bucket,
  };
}

async function listReviewQueue(options = {}) {
  try {
    const repo = await getRepository();
    if (repo.backend === 'fail_closed') {
      if (typeof repo.listReviewQueueSummaries === 'function') {
        return repo.listReviewQueueSummaries();
      }
      return {
        ok: false,
        status: 503,
        code: 'sales_store_misconfigured',
        error: 'Crowsnest Sales durable store is not configured.',
      };
    }

    let summaries;
    if (typeof repo.listReviewQueueSummaries === 'function') {
      summaries = await repo.listReviewQueueSummaries();
    } else {
      const prospects = await repo.listProspects();
      summaries = [];
      for (const prospect of prospects) {
        const research = typeof repo.listResearchForProspect === 'function'
          ? await repo.listResearchForProspect(prospect.id)
          : [];
        const latestQual = typeof repo.getLatestQualification === 'function'
          ? await repo.getLatestQualification(prospect.id)
          : null;
        summaries.push({
          id: prospect.id,
          canonical_name: prospect.canonical_name,
          website_url: prospect.website_url,
          created_at: prospect.created_at,
          updated_at: prospect.updated_at,
          evidence_count: (research || []).length,
          latest_qualification_decision: latestQual ? latestQual.decision : null,
          latest_qualification_at: latestQual ? latestQual.created_at : null,
          most_recent_activity: maxIsoTimestamp([
            prospect.created_at,
            prospect.updated_at,
            ...((research || []).map((row) => row.created_at)),
            latestQual && latestQual.created_at,
          ]),
        });
      }
    }

    if (summaries && summaries.ok === false) {
      return summaries;
    }

    const items = sortReviewQueueItems(
      filterReviewQueueItems(
        (summaries || []).map(buildReviewQueueItem).filter(Boolean),
        options.state,
      ),
    );

    return {
      ok: true,
      filter: normalizeReviewQueueFilter(options.state),
      items,
    };
  } catch (err) {
    if (isSalesStoreUnavailableError(err)) {
      return salesUnavailableResult();
    }
    throw err;
  }
}

async function listProspects() {
  const repo = await getRepository();
  return repo.listProspects();
}

async function getProspect(id) {
  const repo = await getRepository();
  return repo.getProspect(id);
}

async function getResearchForProspect(id) {
  const repo = await getRepository();
  return repo.getResearchForProspect(id);
}

async function listResearchForProspect(id) {
  const repo = await getRepository();
  if (typeof repo.listResearchForProspect === 'function') {
    return repo.listResearchForProspect(id);
  }
  const single = await repo.getResearchForProspect(id);
  return single ? [single] : [];
}

async function listAuditEvents(prospectId) {
  const repo = await getRepository();
  return repo.listAuditEvents(prospectId);
}

async function recordManualEvidence(prospectId, input = {}, actor = 'Admin') {
  try {
    const repo = await getRepository();
    if (repo.backend === 'fail_closed') {
      return repo.saveResearchJob({});
    }

    const prospect = await repo.getProspect(prospectId);
    if (!prospect) {
      return { ok: false, error: 'Prospect not found.', status: 404 };
    }

    const validation = validateManualEvidence(input);
    if (!validation.ok) {
      return { ok: false, error: validation.error, status: 400 };
    }

    const research = buildManualEvidenceResearch(prospect.id, validation);
    const saved = await repo.saveResearchJob(research);
    if (saved && saved.ok === false) {
      return saved;
    }

    const audit = await appendAudit({
      actor: String(actor || 'Admin'),
      action: 'research_evidence_recorded',
      entity_type: 'research',
      entity_id: research.id,
      detail: {
        prospect_id: prospect.id,
        source: research.source,
        status: research.status,
        source_label: research.job_label,
        source_url: research.source_url,
        confidence: research.confidence,
        reviewer_id: String(actor || 'Admin'),
      },
    });
    if (audit && audit.ok === false) {
      return audit;
    }

    return {
      ok: true,
      research: (saved && saved.research) || research,
      audit,
    };
  } catch (err) {
    if (isSalesStoreUnavailableError(err)) {
      return salesUnavailableResult();
    }
    throw err;
  }
}

async function listQualificationsForProspect(id) {
  const repo = await getRepository();
  if (typeof repo.listQualificationsForProspect === 'function') {
    return repo.listQualificationsForProspect(id);
  }
  return [];
}

async function getLatestQualification(id) {
  const repo = await getRepository();
  if (typeof repo.getLatestQualification === 'function') {
    return repo.getLatestQualification(id);
  }
  const list = await listQualificationsForProspect(id);
  return list.length ? list[0] : null;
}

async function recordQualification(prospectId, input = {}, actor = 'Admin') {
  try {
    const repo = await getRepository();
    if (repo.backend === 'fail_closed') {
      return repo.saveQualificationAssessment({});
    }

    const prospect = await repo.getProspect(prospectId);
    if (!prospect) {
      return { ok: false, error: 'Prospect not found.', status: 404 };
    }

    const researchJobs = typeof repo.listResearchForProspect === 'function'
      ? await repo.listResearchForProspect(prospect.id)
      : [];
    const availableIds = (researchJobs || []).map((job) => String(job.id));

    const validation = validateQualification(input, availableIds);
    if (!validation.ok) {
      return { ok: false, error: validation.error, status: 400 };
    }

    const assessment = {
      id: newSalesUuid(),
      prospect_id: prospect.id,
      decision: validation.decision,
      rationale: validation.rationale,
      evidence_ids: validation.evidence_ids,
      reviewer_id: String(actor || 'Admin'),
      created_at: nowIso(),
    };

    const saved = await repo.saveQualificationAssessment(assessment);
    if (saved && saved.ok === false) {
      return saved;
    }

    const audit = await appendAudit({
      actor: String(actor || 'Admin'),
      action: 'qualification_assessed',
      entity_type: 'qualification',
      entity_id: assessment.id,
      detail: {
        prospect_id: prospect.id,
        decision: assessment.decision,
        rationale: assessment.rationale,
        evidence_ids: assessment.evidence_ids,
        reviewer_id: String(actor || 'Admin'),
      },
    });
    if (audit && audit.ok === false) {
      return audit;
    }

    return {
      ok: true,
      assessment: (saved && saved.assessment) || assessment,
      audit,
    };
  } catch (err) {
    if (isSalesStoreUnavailableError(err)) {
      return salesUnavailableResult();
    }
    throw err;
  }
}

async function decideProspect(id, input = {}, actor = 'Admin') {
  const prospect = await getProspect(id);
  if (!prospect) {
    return { ok: false, error: 'Prospect not found.', status: 404 };
  }

  const decision = String(input.decision || '').trim().toLowerCase();
  const reason = String(input.reason || '').trim();
  if (!ALLOWED_DECISIONS.has(decision)) {
    return {
      ok: false,
      error: 'Decision must be approved, rejected, or needs_research.',
      status: 400,
    };
  }
  if (!reason) {
    return { ok: false, error: 'A reason is required for Admin decisions.', status: 400 };
  }

  const previous = prospect.lifecycle_status;
  const updatedAt = nowIso();
  const lastDecision = {
    decision,
    reason,
    reviewer_id: String(actor || 'Admin'),
    created_at: updatedAt,
  };

  const repo = await getRepository();
  const updated = await repo.updateProspectDecision(prospect.id, {
    lifecycle_status: decision,
    updated_at: updatedAt,
    last_decision: lastDecision,
  });
  if (updated && updated.ok === false) {
    return updated;
  }

  const audit = await appendAudit({
    actor: String(actor || 'Admin'),
    action: 'review_decision',
    entity_type: 'prospect',
    entity_id: prospect.id,
    detail: {
      prospect_id: prospect.id,
      decision,
      reason,
      previous_status: previous,
      reviewer_id: String(actor || 'Admin'),
    },
  });
  if (audit && audit.ok === false) {
    return audit;
  }

  return { ok: true, prospect: (updated && updated.prospect) || { ...prospect, lifecycle_status: decision, updated_at: updatedAt, last_decision: lastDecision } };
}

async function resetSalesStore() {
  const repo = await getRepository();
  if (typeof repo.reset === 'function') {
    await repo.reset();
  }
}

function getSalesStoreMode() {
  return resolveSalesStoreConfig(process.env);
}

module.exports = {
  ALLOWED_DECISIONS,
  ALLOWED_EVIDENCE_CONFIDENCE,
  ALLOWED_QUALIFICATION_DECISIONS,
  ACTIONABLE_REVIEW_BUCKETS,
  EVIDENCE_BOUNDS,
  QUALIFICATION_BOUNDS,
  REVIEW_QUEUE_FILTERS,
  appendAudit,
  assignReviewBucket,
  compareReviewQueueItems,
  createProspect,
  decideProspect,
  filterReviewQueueItems,
  getLatestQualification,
  getProspect,
  getResearchForProspect,
  getSalesStoreMode,
  isActionableReviewBucket,
  listAuditEvents,
  listProspects,
  listQualificationsForProspect,
  listResearchForProspect,
  listReviewQueue,
  normalizeReviewQueueFilter,
  recordManualEvidence,
  recordQualification,
  resetSalesStore,
  sortReviewQueueItems,
  validateManualEvidence,
  validateManualIntake,
  validateQualification,
  _setSalesRepositoryForTests,
};
