'use strict';

/**
 * Crowsnest Luna Sales — prospects, fixture research, manual evidence, qualification,
 * CRM sync preview (provider-neutral), CRM review readiness, outreach drafts,
 * decisions, audit.
 *
 * Persistence goes through crowsnest-sales-store (dedicated CROWSNEST_SALES_DATABASE_URL).
 * In-memory fallback is explicit for non-production/test when the durable DSN is absent.
 * Production without the dedicated DSN fails closed on Sales mutations.
 *
 * Chapter 5 builds a CRM sync *preview* and manual "ready for CRM review" mark only —
 * no CRM provider SDK/HTTP/env keys, no automatic writes.
 * Chapter 6 adds manual internal outreach drafts only — no SMTP/WhatsApp/LinkedIn/HubSpot
 * send, no webhooks, no auto-generation.
 * Chapter 7 adds a provider-neutral discovery source contract + manual adapter only —
 * validation/dedup preview and explicit operator import; no live Maps/Apollo/web search,
 * no auto-create prospects.
 * Chapter 8 adds a Google Maps discovery *dry-run* adapter shell (local fixtures only) —
 * no real HTTP, API key, Google SDK, or scraping; operators inspect/import explicitly.
 * Chapter 9 adds manual contact candidates only — no Apollo/other external enrichment,
 * no auto-find, no CRM write, no outreach send.
 * Chapter 10 adds a read-only analytics dashboard — truthful pipeline counts, recent audit
 * activity, and informational data-quality alerts only; no AI/agent scores, external calls,
 * writes, or automatic actions.
 * Chapter 11 adds a read-only scale/governance page — workflow safeguards, human-approval
 * rules, data retention/ownership notes, external integration state, and action-boundary
 * audit summary; no automatic CRM writes/outreach, no external calls, no roles changes.
 */

const {
  createMemorySalesRepository,
  createSalesRepository,
  isSalesStoreUnavailableError,
  newSalesUuid,
  resolveSalesStoreConfig,
  salesUnavailableResult,
} = require('./crowsnest-sales-store');
const {
  PREVIEW_DISCLAIMER: DISCOVERY_PREVIEW_DISCLAIMER,
  previewDiscoveryDeduplication,
} = require('./crowsnest-sales-discovery-contract');
const { adaptManualDiscoveryProposal } = require('./crowsnest-sales-discovery-manual');
const {
  UI_SAMPLE_DISCLAIMER: MAPS_SAMPLE_DISCLAIMER,
  resolveMapsFixtureCandidate,
  search: searchMapsDryRun,
} = require('./crowsnest-sales-discovery-maps');

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

const ALLOWED_OUTREACH_CHANNELS = new Set(['email', 'linkedin', 'other']);
const ALLOWED_CONTACT_CONFIDENCE = new Set(['low', 'medium', 'high']);

const OUTREACH_DRAFT_BOUNDS = {
  subjectMax: 500,
  bodyMax: 10000,
  nextStepNoteMax: 2000,
};

const CONTACT_BOUNDS = {
  fullNameMax: 200,
  roleMax: 200,
  emailMax: 320,
  phoneMax: 40,
  linkedinUrlMax: 2000,
  sourceMax: 200,
};

const OUTREACH_DRAFT_DISCLAIMER = 'Draft only — no message has been sent.';
const CONTACT_ENRICHMENT_DISCLAIMER = 'Manual contact records only — no Apollo lookup, no auto-find, no CRM write, no message sent.';
const ANALYTICS_DISCLAIMER = 'Read-only monitoring from persisted Sales records. Informational data-quality alerts only — operators decide. No AI/agent scores, no external calls, no writes, no automatic actions.';
const ANALYTICS_RECENT_ACTIVITY_LIMIT = 25;

const GOVERNANCE_DISCLAIMER = 'Read-only Sales scale and governance. Explicit human approval required for workflow gates. No automatic CRM writes, no automatic outreach, no external provider calls, and no roles changes in this chapter.';

/** Accepted future CRM Company mapping (provider-neutral domain terms). */
const CRM_PREVIEW_LIFECYCLE_STAGE = 'Lead';
const CRM_PREVIEW_STATUS_PROPERTY = 'Luna Sales Status';
const CRM_PREVIEW_STATUS_VALUE = 'Qualified Prospect';

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

function validateOutreachDraft(input = {}) {
  const subject = String(input.subject || '').trim();
  const body = String(input.body || '').replace(/\r\n/g, '\n').trim();
  const channel = String(input.channel || '').trim().toLowerCase();
  const nextStepNote = String(
    input.next_step_note != null ? input.next_step_note : (input.nextStepNote || ''),
  ).trim();

  if (!subject) {
    return { ok: false, error: 'Subject is required.' };
  }
  if (subject.length > OUTREACH_DRAFT_BOUNDS.subjectMax) {
    return {
      ok: false,
      error: `Subject must be at most ${OUTREACH_DRAFT_BOUNDS.subjectMax} characters.`,
    };
  }
  if (!body) {
    return { ok: false, error: 'Body is required.' };
  }
  if (body.length > OUTREACH_DRAFT_BOUNDS.bodyMax) {
    return {
      ok: false,
      error: `Body must be at most ${OUTREACH_DRAFT_BOUNDS.bodyMax} characters.`,
    };
  }
  if (!ALLOWED_OUTREACH_CHANNELS.has(channel)) {
    return {
      ok: false,
      error: 'Channel must be email, linkedin, or other.',
    };
  }
  if (!nextStepNote) {
    return { ok: false, error: 'A clear next-step note is required.' };
  }
  if (nextStepNote.length > OUTREACH_DRAFT_BOUNDS.nextStepNoteMax) {
    return {
      ok: false,
      error: `Next-step note must be at most ${OUTREACH_DRAFT_BOUNDS.nextStepNoteMax} characters.`,
    };
  }

  return {
    ok: true,
    draft: {
      subject,
      body,
      channel,
      next_step_note: nextStepNote,
      message_sent: false,
      disclaimer: OUTREACH_DRAFT_DISCLAIMER,
    },
  };
}

function decorateOutreachDraft(revision) {
  if (!revision) return null;
  return {
    ...revision,
    message_sent: false,
    disclaimer: OUTREACH_DRAFT_DISCLAIMER,
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
  'crm_ready',
]);

const ACTIONABLE_REVIEW_BUCKETS = new Set(['ready_for_review', 'needs_more_research']);

function normalizeReviewQueueFilter(raw) {
  const value = String(raw == null ? 'all' : raw).trim().toLowerCase();
  if (!value) return 'all';
  return REVIEW_QUEUE_FILTERS.has(value) ? value : 'all';
}

function isCrmReadyFlag(summary = {}) {
  if (summary.crm_ready === true || summary.has_crm_review_mark === true) return true;
  if (summary.latest_crm_review_mark_at) return true;
  if (summary.latestCrmReviewMark && summary.latestCrmReviewMark.id) return true;
  return false;
}

/**
 * Truthful operating bucket from persisted evidence + latest qualification +
 * CRM review readiness. No invented scores or AI priority.
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

  if (isCrmReadyFlag(summary) && decision === 'qualified') return 'crm_ready';
  if (decision === 'qualified') return 'qualified';
  if (decision === 'not_qualified') return 'not_qualified';
  if (decision === 'needs_more_research') return 'needs_more_research';
  if (evidenceCount > 0) return 'ready_for_review';
  return null;
}

function extractCompanyDomain(websiteUrl) {
  const raw = String(websiteUrl || '').trim();
  if (!raw) return '';
  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const hostname = new URL(withProtocol).hostname || '';
    return hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function normalizeCrmContactCandidates(contacts) {
  if (!Array.isArray(contacts)) return [];
  return contacts
    .map((contact) => {
      if (!contact || typeof contact !== 'object') return null;
      const email = String(contact.email || '').trim();
      const fullName = String(
        contact.full_name != null ? contact.full_name : (contact.fullName || contact.name || ''),
      ).trim();
      const role = String(contact.role || contact.title || '').trim();
      if (!email && !fullName) return null;
      return {
        full_name: fullName,
        email,
        role,
      };
    })
    .filter(Boolean);
}

function normalizeOptionalHttpUrl(raw, fieldLabel) {
  const value = String(raw || '').trim();
  if (!value) return { ok: true, value: '' };
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: `${fieldLabel} must be an http(s) URL.` };
    }
    return { ok: true, value: parsed.toString().replace(/\/$/, '') };
  } catch {
    return { ok: false, error: `${fieldLabel} must be a valid URL.` };
  }
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Validate a manually entered contact candidate (Chapter 9).
 * Name, role, source, and confidence are required. Email / phone / LinkedIn are optional.
 */
function validateManualContact(input = {}) {
  const fullName = String(
    input.full_name != null ? input.full_name : (input.fullName || input.name || ''),
  ).trim();
  const role = String(input.role || input.title || '').trim();
  const email = String(input.email || '').trim();
  const phone = String(input.phone || '').trim();
  const linkedinRaw = String(
    input.linkedin_url != null ? input.linkedin_url : (input.linkedinUrl || input.linkedin || ''),
  ).trim();
  const source = String(
    input.source != null ? input.source : (input.source_label || input.sourceLabel || ''),
  ).trim();
  const confidence = String(input.confidence || '').trim().toLowerCase();

  if (!fullName) {
    return { ok: false, error: 'Contact name is required.' };
  }
  if (fullName.length > CONTACT_BOUNDS.fullNameMax) {
    return {
      ok: false,
      error: `Contact name must be at most ${CONTACT_BOUNDS.fullNameMax} characters.`,
    };
  }
  if (!role) {
    return { ok: false, error: 'Contact role is required.' };
  }
  if (role.length > CONTACT_BOUNDS.roleMax) {
    return {
      ok: false,
      error: `Contact role must be at most ${CONTACT_BOUNDS.roleMax} characters.`,
    };
  }
  if (!source) {
    return { ok: false, error: 'Contact source is required.' };
  }
  if (source.length > CONTACT_BOUNDS.sourceMax) {
    return {
      ok: false,
      error: `Contact source must be at most ${CONTACT_BOUNDS.sourceMax} characters.`,
    };
  }
  if (!ALLOWED_CONTACT_CONFIDENCE.has(confidence)) {
    return { ok: false, error: 'Confidence must be low, medium, or high.' };
  }
  if (email) {
    if (email.length > CONTACT_BOUNDS.emailMax) {
      return {
        ok: false,
        error: `Email must be at most ${CONTACT_BOUNDS.emailMax} characters.`,
      };
    }
    if (!looksLikeEmail(email)) {
      return { ok: false, error: 'Email must be a valid email address.' };
    }
  }
  if (phone) {
    if (phone.length > CONTACT_BOUNDS.phoneMax) {
      return {
        ok: false,
        error: `Phone must be at most ${CONTACT_BOUNDS.phoneMax} characters.`,
      };
    }
  }
  const linkedin = normalizeOptionalHttpUrl(linkedinRaw, 'LinkedIn URL');
  if (!linkedin.ok) return linkedin;
  if (linkedin.value && linkedin.value.length > CONTACT_BOUNDS.linkedinUrlMax) {
    return {
      ok: false,
      error: `LinkedIn URL must be at most ${CONTACT_BOUNDS.linkedinUrlMax} characters.`,
    };
  }

  return {
    ok: true,
    contact: {
      full_name: fullName,
      role,
      email,
      phone,
      linkedin_url: linkedin.value,
      source,
      confidence,
      disclaimer: CONTACT_ENRICHMENT_DISCLAIMER,
      external_lookup_used: false,
      auto_found: false,
      message_sent: false,
    },
  };
}

/**
 * Provider-neutral CRM sync preview for a currently qualified prospect.
 * Maps to one Company + zero-or-more Contacts; accepted future mapping uses
 * lifecycle Lead and Company property Luna Sales Status = Qualified Prospect.
 * Explicitly no Deal. Preview only — nothing is sent.
 */
function buildCrmSyncPreview(input = {}) {
  const prospect = input.prospect || null;
  const qualification = input.qualification
    || input.latestQualification
    || input.latest_qualification
    || null;
  const contacts = normalizeCrmContactCandidates(input.contacts);

  if (!prospect || !prospect.id) {
    return { ok: false, error: 'Prospect is required for CRM preview.', status: 400 };
  }
  if (!qualification || !qualification.id) {
    return {
      ok: false,
      error: 'A current qualification assessment is required for CRM preview.',
      status: 400,
    };
  }
  const decision = String(qualification.decision || '').trim().toLowerCase();
  if (decision !== 'qualified') {
    return {
      ok: false,
      error: 'CRM preview requires the prospect’s latest qualification to be qualified.',
      status: 400,
    };
  }

  const websiteUrl = String(prospect.website_url || '').trim();
  const companyName = String(prospect.canonical_name || '').trim() || websiteUrl || String(prospect.id);
  const domain = extractCompanyDomain(websiteUrl);

  return {
    ok: true,
    preview: {
      preview_only: true,
      record_sent: false,
      disclaimer: 'Preview only — no CRM record has been sent.',
      company: {
        name: companyName,
        website_url: websiteUrl,
        domain,
        lifecycle_stage: CRM_PREVIEW_LIFECYCLE_STAGE,
        properties: {
          [CRM_PREVIEW_STATUS_PROPERTY]: CRM_PREVIEW_STATUS_VALUE,
        },
      },
      contacts,
      deal: null,
      traceability: {
        prospect_id: String(prospect.id),
        qualification_assessment_id: String(qualification.id),
        decision: 'qualified',
        rationale: String(qualification.rationale || ''),
        evidence_ids: Array.isArray(qualification.evidence_ids)
          ? qualification.evidence_ids.map((id) => String(id))
          : [],
        qualification_reviewer_id: String(qualification.reviewer_id || ''),
        qualification_created_at: qualification.created_at
          ? String(qualification.created_at)
          : '',
      },
    },
  };
}

async function getCrmSyncPreview(prospectId, options = {}) {
  try {
    const repo = await getRepository();
    if (repo.backend === 'fail_closed') {
      if (typeof repo.getLatestQualification === 'function') {
        const closed = await repo.getLatestQualification(prospectId);
        if (closed && closed.ok === false) return closed;
      }
      return {
        ok: false,
        status: 503,
        code: 'sales_store_misconfigured',
        error: 'Crowsnest Sales durable store is not configured.',
      };
    }

    const prospect = await repo.getProspect(prospectId);
    if (!prospect) {
      return { ok: false, error: 'Prospect not found.', status: 404 };
    }

    const qualification = typeof repo.getLatestQualification === 'function'
      ? await repo.getLatestQualification(prospect.id)
      : null;
    let contacts = options.contacts;
    if (contacts == null && typeof repo.listContactCandidatesForProspect === 'function') {
      contacts = await repo.listContactCandidatesForProspect(prospect.id);
    }
    const built = buildCrmSyncPreview({
      prospect,
      qualification,
      contacts: contacts || [],
    });
    if (!built.ok) return built;

    const latestMark = typeof repo.getLatestCrmReviewMark === 'function'
      ? await repo.getLatestCrmReviewMark(prospect.id)
      : null;

    return {
      ok: true,
      prospect,
      qualification,
      latestCrmReviewMark: latestMark || null,
      preview: built.preview,
    };
  } catch (err) {
    if (isSalesStoreUnavailableError(err)) {
      return salesUnavailableResult();
    }
    throw err;
  }
}

async function listCrmReviewMarksForProspect(id) {
  const repo = await getRepository();
  if (typeof repo.listCrmReviewMarksForProspect === 'function') {
    return repo.listCrmReviewMarksForProspect(id);
  }
  return [];
}

async function getLatestCrmReviewMark(id) {
  const repo = await getRepository();
  if (typeof repo.getLatestCrmReviewMark === 'function') {
    return repo.getLatestCrmReviewMark(id);
  }
  const list = await listCrmReviewMarksForProspect(id);
  return list.length ? list[0] : null;
}

async function markReadyForCrmReview(prospectId, actor = 'Admin') {
  try {
    const repo = await getRepository();
    if (repo.backend === 'fail_closed') {
      return typeof repo.saveCrmReviewMark === 'function'
        ? repo.saveCrmReviewMark({})
        : {
          ok: false,
          status: 503,
          code: 'sales_store_misconfigured',
          error: 'Crowsnest Sales durable store is not configured.',
        };
    }

    const prospect = await repo.getProspect(prospectId);
    if (!prospect) {
      return { ok: false, error: 'Prospect not found.', status: 404 };
    }

    const qualification = typeof repo.getLatestQualification === 'function'
      ? await repo.getLatestQualification(prospect.id)
      : null;
    if (!qualification || String(qualification.decision || '').trim().toLowerCase() !== 'qualified') {
      return {
        ok: false,
        error: 'Mark ready for CRM review requires the prospect’s latest qualification to be qualified.',
        status: 400,
      };
    }

    const mark = {
      id: newSalesUuid(),
      prospect_id: prospect.id,
      qualification_assessment_id: qualification.id,
      reviewer_id: String(actor || 'Admin'),
      created_at: nowIso(),
    };

    const saved = await repo.saveCrmReviewMark(mark);
    if (saved && saved.ok === false) {
      return saved;
    }

    const audit = await appendAudit({
      actor: String(actor || 'Admin'),
      action: 'crm_review_ready_marked',
      entity_type: 'crm_review',
      entity_id: mark.id,
      detail: {
        prospect_id: prospect.id,
        qualification_assessment_id: qualification.id,
        decision: qualification.decision,
        rationale: qualification.rationale,
        evidence_ids: Array.isArray(qualification.evidence_ids)
          ? qualification.evidence_ids.map((id) => String(id))
          : [],
        reviewer_id: String(actor || 'Admin'),
      },
    });
    if (audit && audit.ok === false) {
      return audit;
    }

    return {
      ok: true,
      mark: (saved && saved.mark) || mark,
      qualification,
      audit,
    };
  } catch (err) {
    if (isSalesStoreUnavailableError(err)) {
      return salesUnavailableResult();
    }
    throw err;
  }
}

async function listOutreachDraftRevisionsForProspect(id) {
  const repo = await getRepository();
  if (typeof repo.listOutreachDraftRevisionsForProspect === 'function') {
    const list = await repo.listOutreachDraftRevisionsForProspect(id);
    return (Array.isArray(list) ? list : []).map(decorateOutreachDraft);
  }
  return [];
}

async function getCurrentOutreachDraft(id) {
  const repo = await getRepository();
  if (typeof repo.getCurrentOutreachDraftRevision === 'function') {
    return decorateOutreachDraft(await repo.getCurrentOutreachDraftRevision(id));
  }
  const list = await listOutreachDraftRevisionsForProspect(id);
  return list.length ? list[0] : null;
}

async function getOutreachDraftWorkspace(prospectId) {
  try {
    const repo = await getRepository();
    if (repo.backend === 'fail_closed') {
      if (typeof repo.getCurrentOutreachDraftRevision === 'function') {
        const closed = await repo.getCurrentOutreachDraftRevision(prospectId);
        if (closed && closed.ok === false) return closed;
      }
      return {
        ok: false,
        status: 503,
        code: 'sales_store_misconfigured',
        error: 'Crowsnest Sales durable store is not configured.',
      };
    }

    const prospect = await repo.getProspect(prospectId);
    if (!prospect) {
      return { ok: false, error: 'Prospect not found.', status: 404 };
    }

    const latestCrmReviewMark = typeof repo.getLatestCrmReviewMark === 'function'
      ? await repo.getLatestCrmReviewMark(prospect.id)
      : null;
    const draftReady = Boolean(latestCrmReviewMark && latestCrmReviewMark.id);
    if (!draftReady) {
      return {
        ok: false,
        error: 'Outreach drafts require the prospect to be marked CRM-ready.',
        status: 400,
        prospect,
        draft_ready: false,
        draft_present: false,
        currentDraft: null,
        revisions: [],
        latestCrmReviewMark: null,
      };
    }

    const revisions = typeof repo.listOutreachDraftRevisionsForProspect === 'function'
      ? (await repo.listOutreachDraftRevisionsForProspect(prospect.id)).map(decorateOutreachDraft)
      : [];
    const currentDraft = revisions.length ? revisions[0] : null;

    return {
      ok: true,
      prospect,
      latestCrmReviewMark,
      draft_ready: true,
      draft_present: Boolean(currentDraft),
      currentDraft,
      revisions,
      disclaimer: OUTREACH_DRAFT_DISCLAIMER,
    };
  } catch (err) {
    if (isSalesStoreUnavailableError(err)) {
      return salesUnavailableResult();
    }
    throw err;
  }
}

async function saveOutreachDraft(prospectId, input = {}, actor = 'Admin') {
  try {
    const repo = await getRepository();
    if (repo.backend === 'fail_closed') {
      return typeof repo.saveOutreachDraftRevision === 'function'
        ? repo.saveOutreachDraftRevision({})
        : {
          ok: false,
          status: 503,
          code: 'sales_store_misconfigured',
          error: 'Crowsnest Sales durable store is not configured.',
        };
    }

    const prospect = await repo.getProspect(prospectId);
    if (!prospect) {
      return { ok: false, error: 'Prospect not found.', status: 404 };
    }

    const latestCrmReviewMark = typeof repo.getLatestCrmReviewMark === 'function'
      ? await repo.getLatestCrmReviewMark(prospect.id)
      : null;
    if (!latestCrmReviewMark || !latestCrmReviewMark.id) {
      return {
        ok: false,
        error: 'Outreach drafts require the prospect to be marked CRM-ready.',
        status: 400,
      };
    }

    const validated = validateOutreachDraft(input);
    if (!validated.ok) {
      return { ok: false, error: validated.error, status: 400 };
    }

    let revisionNumber = 1;
    if (typeof repo.getNextOutreachDraftRevisionNumber === 'function') {
      const next = await repo.getNextOutreachDraftRevisionNumber(prospect.id);
      if (next && typeof next === 'object' && next.ok === false) {
        return next;
      }
      revisionNumber = Number(next) || 1;
    } else if (typeof repo.listOutreachDraftRevisionsForProspect === 'function') {
      const existing = await repo.listOutreachDraftRevisionsForProspect(prospect.id);
      let max = 0;
      for (const row of existing || []) {
        const n = Number(row.revision_number) || 0;
        if (n > max) max = n;
      }
      revisionNumber = max + 1;
    }

    const revision = {
      id: newSalesUuid(),
      prospect_id: prospect.id,
      revision_number: revisionNumber,
      subject: validated.draft.subject,
      body: validated.draft.body,
      channel: validated.draft.channel,
      next_step_note: validated.draft.next_step_note,
      author_id: String(actor || 'Admin'),
      created_at: nowIso(),
      message_sent: false,
      disclaimer: OUTREACH_DRAFT_DISCLAIMER,
    };

    const saved = await repo.saveOutreachDraftRevision(revision);
    if (saved && saved.ok === false) {
      return saved;
    }

    const draft = decorateOutreachDraft((saved && saved.revision) || revision);

    const audit = await appendAudit({
      actor: String(actor || 'Admin'),
      action: 'outreach_draft_saved',
      entity_type: 'outreach_draft',
      entity_id: draft.id,
      detail: {
        prospect_id: prospect.id,
        revision_id: draft.id,
        revision_number: draft.revision_number,
        subject: draft.subject,
        channel: draft.channel,
        next_step_note: draft.next_step_note,
        author_id: draft.author_id,
        message_sent: false,
        crm_review_mark_id: latestCrmReviewMark.id,
      },
    });
    if (audit && audit.ok === false) {
      return audit;
    }

    return {
      ok: true,
      draft,
      audit,
      latestCrmReviewMark,
    };
  } catch (err) {
    if (isSalesStoreUnavailableError(err)) {
      return salesUnavailableResult();
    }
    throw err;
  }
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
  const crmReady = isCrmReadyFlag(summary);
  const draftPresent = summary.draft_present === true
    || Boolean(summary.latest_outreach_draft_at)
    || Boolean(summary.current_outreach_draft_id);
  const draftReady = summary.draft_ready === true || crmReady;
  const bucket = assignReviewBucket({
    evidence_count: evidenceCount,
    latest_qualification_decision: latestDecision,
    crm_ready: crmReady,
    latest_crm_review_mark_at: summary.latest_crm_review_mark_at || null,
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
      summary.latest_crm_review_mark_at,
      summary.latest_outreach_draft_at,
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
    crm_ready: crmReady,
    latest_crm_review_mark_at: summary.latest_crm_review_mark_at
      ? (summary.latest_crm_review_mark_at instanceof Date
        ? summary.latest_crm_review_mark_at.toISOString()
        : String(summary.latest_crm_review_mark_at))
      : null,
    draft_ready: draftReady,
    draft_present: draftPresent,
    latest_outreach_draft_at: summary.latest_outreach_draft_at
      ? (summary.latest_outreach_draft_at instanceof Date
        ? summary.latest_outreach_draft_at.toISOString()
        : String(summary.latest_outreach_draft_at))
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
        const latestCrmMark = typeof repo.getLatestCrmReviewMark === 'function'
          ? await repo.getLatestCrmReviewMark(prospect.id)
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
          crm_ready: Boolean(latestCrmMark),
          latest_crm_review_mark_at: latestCrmMark ? latestCrmMark.created_at : null,
          most_recent_activity: maxIsoTimestamp([
            prospect.created_at,
            prospect.updated_at,
            ...((research || []).map((row) => row.created_at)),
            latestQual && latestQual.created_at,
            latestCrmMark && latestCrmMark.created_at,
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

function emptyPipelineCounts() {
  return {
    prospects: 0,
    evidence_records: 0,
    crm_ready: 0,
    drafts_present: 0,
    contacts: 0,
    qualification: {
      qualified: 0,
      not_qualified: 0,
      needs_more_research: 0,
      unassessed: 0,
    },
  };
}

/**
 * Truthful pipeline counts from analytics summaries. No invented scores.
 */
function buildPipelineCounts(summaries = []) {
  const counts = emptyPipelineCounts();
  const list = Array.isArray(summaries) ? summaries : [];
  for (const row of list) {
    counts.prospects += 1;
    counts.evidence_records += Number(row && row.evidence_count) || 0;
    counts.contacts += Number(row && row.contact_count) || 0;
    if (isCrmReadyFlag(row)) counts.crm_ready += 1;
    const draftPresent = row && (
      row.draft_present === true
      || Boolean(row.latest_outreach_draft_at)
      || Boolean(row.current_outreach_draft_id)
    );
    if (draftPresent) counts.drafts_present += 1;

    const decision = String(
      row && row.latest_qualification_decision != null
        ? row.latest_qualification_decision
        : '',
    ).trim().toLowerCase();
    if (decision === 'qualified') counts.qualification.qualified += 1;
    else if (decision === 'not_qualified') counts.qualification.not_qualified += 1;
    else if (decision === 'needs_more_research') counts.qualification.needs_more_research += 1;
    else counts.qualification.unassessed += 1;
  }
  return counts;
}

/**
 * Informational data-quality alerts only — never auto-remediate.
 */
function buildDataQualityAlerts(summaries = []) {
  const alerts = [];
  const list = Array.isArray(summaries) ? summaries : [];
  for (const row of list) {
    if (!row || !row.id) continue;
    const prospectId = String(row.id);
    const name = String(row.canonical_name || '').trim();
    const website = String(row.website_url || '').trim();
    const evidenceCount = Number(row.evidence_count) || 0;
    const contactCount = Number(row.contact_count) || 0;
    const decision = String(row.latest_qualification_decision || '').trim().toLowerCase();
    const crmReady = isCrmReadyFlag(row);
    const draftPresent = row.draft_present === true
      || Boolean(row.latest_outreach_draft_at)
      || Boolean(row.current_outreach_draft_id);

    if (!website) {
      alerts.push({
        code: 'missing_website',
        prospect_id: prospectId,
        canonical_name: name,
        message: 'Prospect has no website URL recorded.',
      });
    }
    if (evidenceCount <= 0) {
      alerts.push({
        code: 'no_evidence',
        prospect_id: prospectId,
        canonical_name: name,
        message: 'Prospect has no research evidence recorded.',
      });
    }
    if (decision === 'qualified' && !crmReady) {
      alerts.push({
        code: 'qualified_without_crm_ready',
        prospect_id: prospectId,
        canonical_name: name,
        message: 'Prospect is qualified but not marked ready for CRM review.',
      });
    }
    if (crmReady && !draftPresent) {
      alerts.push({
        code: 'crm_ready_without_draft',
        prospect_id: prospectId,
        canonical_name: name,
        message: 'Prospect is CRM-ready but has no outreach draft yet.',
      });
    }
    if (crmReady && contactCount <= 0) {
      alerts.push({
        code: 'crm_ready_without_contact',
        prospect_id: prospectId,
        canonical_name: name,
        message: 'Prospect is CRM-ready but has no contact candidates recorded.',
      });
    }
  }
  return alerts;
}

function resolveAuditProspectId(event = {}) {
  if (event.entity_type === 'prospect' && event.entity_id) {
    return String(event.entity_id);
  }
  const detail = event.detail || {};
  if (detail.prospect_id) return String(detail.prospect_id);
  return '';
}

/**
 * Newest-first recent audit activity (bounded). Read-only view of append-only events.
 */
function buildRecentActivity(events = [], options = {}) {
  const limitRaw = Number(options.limit != null ? options.limit : ANALYTICS_RECENT_ACTIVITY_LIMIT);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), 100)
    : ANALYTICS_RECENT_ACTIVITY_LIMIT;
  const list = Array.isArray(events) ? events.slice() : [];
  list.sort((a, b) => {
    const aAt = String((a && a.at) || '');
    const bAt = String((b && b.at) || '');
    if (aAt !== bAt) return bAt.localeCompare(aAt);
    return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
  });
  return list.slice(0, limit).map((event) => {
    const prospectId = resolveAuditProspectId(event);
    return {
      id: String((event && event.id) || ''),
      at: event && event.at
        ? (event.at instanceof Date ? event.at.toISOString() : String(event.at))
        : '',
      actor: String((event && event.actor) || ''),
      action: String((event && event.action) || ''),
      entity_type: String((event && event.entity_type) || ''),
      entity_id: String((event && event.entity_id) || ''),
      prospect_id: prospectId || null,
    };
  });
}

async function getSalesAnalytics(options = {}) {
  try {
    const repo = await getRepository();
    if (repo.backend === 'fail_closed') {
      if (typeof repo.listAnalyticsSummaries === 'function') {
        return repo.listAnalyticsSummaries();
      }
      return {
        ok: false,
        status: 503,
        code: 'sales_store_misconfigured',
        error: 'Crowsnest Sales durable store is not configured.',
      };
    }

    let summaries;
    if (typeof repo.listAnalyticsSummaries === 'function') {
      summaries = await repo.listAnalyticsSummaries();
    } else if (typeof repo.listReviewQueueSummaries === 'function') {
      summaries = await repo.listReviewQueueSummaries();
    } else {
      summaries = [];
    }

    if (summaries && summaries.ok === false) {
      return summaries;
    }

    let auditEvents = [];
    if (typeof repo.listAuditEvents === 'function') {
      auditEvents = await repo.listAuditEvents();
      if (auditEvents && auditEvents.ok === false) {
        return auditEvents;
      }
    }

    const list = Array.isArray(summaries) ? summaries : [];
    const nameById = new Map(
      list.map((row) => [String(row.id), String(row.canonical_name || '')]),
    );
    const recent = buildRecentActivity(auditEvents, {
      limit: options.recentLimit != null ? options.recentLimit : ANALYTICS_RECENT_ACTIVITY_LIMIT,
    }).map((item) => ({
      ...item,
      canonical_name: item.prospect_id ? (nameById.get(String(item.prospect_id)) || '') : '',
    }));

    return {
      ok: true,
      counts: buildPipelineCounts(list),
      recent_activity: recent,
      data_quality_alerts: buildDataQualityAlerts(list),
      disclaimer: ANALYTICS_DISCLAIMER,
    };
  } catch (err) {
    if (isSalesStoreUnavailableError(err)) {
      return salesUnavailableResult();
    }
    throw err;
  }
}

/**
 * Static workflow safeguards for Luna Sales (Chapter 11).
 * Every listed gate requires an authenticated human operator — nothing auto-advances.
 */
function buildWorkflowSafeguards() {
  return [
    {
      id: 'intake_and_evidence',
      title: 'Manual intake and evidence',
      summary: 'Prospects and research evidence are recorded by authenticated operators only.',
      human_approval_required: true,
    },
    {
      id: 'qualification_gate',
      title: 'Qualification assessment',
      summary: 'Qualified / not qualified / needs more research requires an explicit operator assessment with rationale and evidence references.',
      human_approval_required: true,
    },
    {
      id: 'crm_review_gate',
      title: 'CRM review readiness',
      summary: 'Marking ready for CRM review is a manual operator action on currently qualified prospects; CRM sync remains preview-only.',
      human_approval_required: true,
    },
    {
      id: 'outreach_draft_gate',
      title: 'Outreach drafts',
      summary: 'Outreach content is saved as internal drafts only; sending requires a future human-approved channel outside this chapter.',
      human_approval_required: true,
    },
    {
      id: 'discovery_import_gate',
      title: 'Discovery import',
      summary: 'Manual and Maps dry-run discovery stay preview-only until an operator explicitly imports a candidate.',
      human_approval_required: true,
    },
    {
      id: 'review_decision_gate',
      title: 'Review decision',
      summary: 'Approved / rejected / needs research decisions are operator-recorded and append-audited.',
      human_approval_required: true,
    },
  ];
}

/**
 * Explicit human-approval rules (Chapter 11). Policy surface only — not a roles system.
 */
function buildHumanApprovalRules() {
  return [
    {
      id: 'no_automatic_crm_writes',
      rule: 'No automatic CRM writes — HubSpot/CRM sync stays preview-only until a human operator acts outside automatic paths.',
    },
    {
      id: 'no_automatic_outreach',
      rule: 'No automatic outreach — drafts are operator-authored; messages are not sent by the Sales workflow.',
    },
    {
      id: 'no_external_provider_calls',
      rule: 'No external provider calls from governance or Sales automation — Maps dry-run, manual discovery, and manual contacts only.',
    },
    {
      id: 'no_roles_changes',
      rule: 'No roles changes — Crowsnest Sales does not grant, revoke, or mutate operator roles from this surface.',
    },
    {
      id: 'operator_gates',
      rule: 'Workflow gates (qualification, CRM-ready, discovery import, review decision) require authenticated human approval.',
    },
    {
      id: 'append_only_audit',
      rule: 'Operator actions that mutate Sales records must append an audit event; governance itself is read-only.',
    },
  ];
}

/**
 * Data retention and ownership notes for the dedicated Sales store.
 */
function buildDataRetentionNotes() {
  return {
    schema: 'luna_sales',
    dsn_env: 'CROWSNEST_SALES_DATABASE_URL',
    ownership: 'Crowsnest / Luna Sales operators own Sales prospect, evidence, qualification, CRM-ready, draft, contact, and audit records in schema luna_sales.',
    retention_note: 'Records persist in the dedicated Sales store for operator review and append-only audit. Retention policy is operator-owned; this chapter does not auto-delete or export data.',
    isolation_note: 'Sales must use dedicated CROWSNEST_SALES_DATABASE_URL — never the Wolfhouse guest booking database connection.',
    audit_note: 'Audit events are append-only; governance page does not rewrite history.',
  };
}

/**
 * Truthful external integration state — none perform live writes from Sales.
 */
function buildExternalIntegrationState() {
  return [
    {
      id: 'hubspot_crm',
      name: 'HubSpot / CRM',
      state: 'preview_only',
      write_enabled: false,
      automatic: false,
      note: 'CRM sync preview and manual ready-for-review mark only — no HubSpot SDK, HTTP, or automatic CRM writes.',
    },
    {
      id: 'google_maps',
      name: 'Google Maps discovery',
      state: 'dry_run_fixtures',
      write_enabled: false,
      automatic: false,
      note: 'Maps discovery uses local fixtures only — no live Google Maps HTTP, API key, SDK, or scraping.',
    },
    {
      id: 'apollo_enrichment',
      name: 'Apollo / contact enrichment',
      state: 'manual_only',
      write_enabled: false,
      automatic: false,
      note: 'Contact candidates are typed in by operators — no Apollo lookup or auto-find.',
    },
    {
      id: 'outreach_delivery',
      name: 'Outreach delivery (SMTP / WhatsApp / LinkedIn)',
      state: 'drafts_only',
      write_enabled: false,
      automatic: false,
      note: 'Outreach workspace stores drafts only — no SMTP, WhatsApp, LinkedIn send, or webhooks.',
    },
    {
      id: 'live_ai_research',
      name: 'Live AI research providers',
      state: 'not_connected',
      write_enabled: false,
      automatic: false,
      note: 'Research evidence is manual or fixture-based — no live AI research provider calls.',
    },
  ];
}

/**
 * Action-boundary audit summary: what operators may do vs what must never auto-run.
 */
function buildActionBoundaryAuditSummary() {
  return {
    allowed_manual: [
      {
        id: 'prospect_created',
        action: 'Create prospect via manual intake or explicit discovery import',
        human_approval_required: true,
        operator_triggered: true,
        audited_as: 'prospect_created / discovery_proposal_imported',
      },
      {
        id: 'research_evidence_recorded',
        action: 'Record manual research evidence',
        human_approval_required: true,
        operator_triggered: true,
        audited_as: 'research_evidence_recorded',
      },
      {
        id: 'qualification_assessed',
        action: 'Record qualification assessment',
        human_approval_required: true,
        operator_triggered: true,
        audited_as: 'qualification_assessed',
      },
      {
        id: 'crm_review_ready_marked',
        action: 'Mark ready for CRM review (preview boundary only)',
        human_approval_required: true,
        operator_triggered: true,
        audited_as: 'crm_review_ready_marked',
      },
      {
        id: 'outreach_draft_saved',
        action: 'Save outreach draft (not sent)',
        human_approval_required: true,
        operator_triggered: true,
        audited_as: 'outreach_draft_saved',
      },
      {
        id: 'contact_candidate_recorded',
        action: 'Record manual contact candidate',
        human_approval_required: true,
        operator_triggered: true,
        audited_as: 'contact_candidate_recorded',
      },
      {
        id: 'review_decision',
        action: 'Record review decision',
        human_approval_required: true,
        operator_triggered: true,
        audited_as: 'review_decision',
      },
    ],
    forbidden_automatic: [
      {
        id: 'automatic_crm_write',
        action: 'Automatic CRM write / HubSpot upsert',
      },
      {
        id: 'automatic_outreach_send',
        action: 'Automatic outreach send (SMTP / WhatsApp / LinkedIn)',
      },
      {
        id: 'external_provider_calls',
        action: 'External provider calls (live Maps, Apollo, web search, live AI research)',
      },
      {
        id: 'roles_changes',
        action: 'Roles changes (grant, revoke, or mutate operator roles)',
      },
    ],
  };
}

/**
 * Read-only governance payload (Chapter 11). Pure policy surface — no store writes,
 * no external calls, no roles mutations.
 */
async function getSalesGovernance() {
  return {
    ok: true,
    disclaimer: GOVERNANCE_DISCLAIMER,
    workflow_safeguards: buildWorkflowSafeguards(),
    human_approval_rules: buildHumanApprovalRules(),
    data_retention: buildDataRetentionNotes(),
    external_integrations: buildExternalIntegrationState(),
    action_boundaries: buildActionBoundaryAuditSummary(),
  };
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

async function listContactCandidatesForProspect(id) {
  const repo = await getRepository();
  if (typeof repo.listContactCandidatesForProspect === 'function') {
    return repo.listContactCandidatesForProspect(id);
  }
  return [];
}

async function recordManualContact(prospectId, input = {}, actor = 'Admin') {
  try {
    const repo = await getRepository();
    if (repo.backend === 'fail_closed') {
      return typeof repo.saveContactCandidate === 'function'
        ? repo.saveContactCandidate({})
        : {
          ok: false,
          status: 503,
          code: 'sales_store_misconfigured',
          error: 'Crowsnest Sales durable store is not configured.',
        };
    }

    const prospect = await repo.getProspect(prospectId);
    if (!prospect) {
      return { ok: false, error: 'Prospect not found.', status: 404 };
    }

    const validation = validateManualContact(input);
    if (!validation.ok) {
      return { ok: false, error: validation.error, status: 400 };
    }

    const contact = {
      id: newSalesUuid(),
      prospect_id: prospect.id,
      full_name: validation.contact.full_name,
      role: validation.contact.role,
      email: validation.contact.email,
      phone: validation.contact.phone,
      linkedin_url: validation.contact.linkedin_url,
      source: validation.contact.source,
      confidence: validation.contact.confidence,
      author_id: String(actor || 'Admin'),
      created_at: nowIso(),
      disclaimer: CONTACT_ENRICHMENT_DISCLAIMER,
      external_lookup_used: false,
      auto_found: false,
      message_sent: false,
    };

    const saved = await repo.saveContactCandidate(contact);
    if (saved && saved.ok === false) {
      return saved;
    }

    const stored = (saved && saved.contact) || contact;

    const audit = await appendAudit({
      actor: String(actor || 'Admin'),
      action: 'contact_candidate_recorded',
      entity_type: 'contact_candidate',
      entity_id: stored.id,
      detail: {
        prospect_id: prospect.id,
        contact_id: stored.id,
        full_name: stored.full_name,
        role: stored.role,
        email: stored.email,
        phone: stored.phone,
        linkedin_url: stored.linkedin_url,
        source: stored.source,
        confidence: stored.confidence,
        author_id: stored.author_id,
        external_lookup_used: false,
        auto_found: false,
        message_sent: false,
      },
    });
    if (audit && audit.ok === false) {
      return audit;
    }

    return {
      ok: true,
      contact: stored,
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

/**
 * Preview one manual discovery proposal: normalize, quality signals, dedup.
 * Never creates a prospect.
 */
async function previewManualDiscovery(input = {}) {
  const adapted = adaptManualDiscoveryProposal(input);
  if (!adapted.ok) {
    return {
      ok: false,
      error: (adapted.errors && adapted.errors[0]) || 'Invalid discovery proposal.',
      errors: adapted.errors || [],
      preview_only: true,
      prospect_created: false,
      auto_created: false,
      status: 400,
    };
  }

  let existing = [];
  try {
    const listed = await listProspects();
    existing = Array.isArray(listed) ? listed : [];
  } catch (err) {
    if (isSalesStoreUnavailableError(err)) {
      return salesUnavailableResult();
    }
    throw err;
  }

  const dedup = previewDiscoveryDeduplication({
    proposal: adapted.proposal,
    existingProspects: existing,
  });
  if (!dedup.ok) {
    return {
      ok: false,
      error: (dedup.errors && dedup.errors[0]) || 'Dedup preview failed.',
      errors: dedup.errors || [],
      preview_only: true,
      prospect_created: false,
      auto_created: false,
      status: 400,
    };
  }

  return {
    ok: true,
    preview_only: true,
    prospect_created: false,
    auto_created: false,
    disclaimer: DISCOVERY_PREVIEW_DISCLAIMER,
    schema_version: adapted.schema_version,
    proposal: adapted.proposal,
    provenance: adapted.provenance,
    quality: adapted.quality,
    dedup,
  };
}

/**
 * Explicit operator import of one manual discovery proposal.
 * Creates a durable prospect via createProspect — never auto-runs from search.
 */
async function importManualDiscoveryProposal(input = {}, actor = 'Admin') {
  const adapted = adaptManualDiscoveryProposal(input);
  if (!adapted.ok) {
    return {
      ok: false,
      error: (adapted.errors && adapted.errors[0]) || 'Invalid discovery proposal.',
      errors: adapted.errors || [],
      prospect_created: false,
      auto_created: false,
      status: 400,
    };
  }

  const created = await createProspect(
    {
      business_name: adapted.proposal.business_name,
      website_url: adapted.proposal.website_url,
    },
    actor,
  );
  if (!created || created.ok === false) {
    return {
      ...(created || { ok: false, error: 'Unable to create prospect.' }),
      prospect_created: false,
      auto_created: false,
    };
  }

  const audit = await appendAudit({
    actor: String(actor || 'Admin'),
    action: 'discovery_proposal_imported',
    entity_type: 'prospect',
    entity_id: created.prospect.id,
    detail: {
      prospect_id: created.prospect.id,
      source_name: adapted.provenance.source_name,
      source_reference: adapted.proposal.source_reference,
      location: adapted.proposal.location,
      category: adapted.proposal.category,
      source_note: adapted.proposal.source_reference.request_reference,
      schema_version: adapted.schema_version,
      auto_created: false,
    },
  });
  if (audit && audit.ok === false) {
    return {
      ...audit,
      prospect_created: false,
      auto_created: false,
    };
  }

  return {
    ok: true,
    prospect: created.prospect,
    research: created.research,
    proposal: adapted.proposal,
    provenance: adapted.provenance,
    prospect_created: true,
    auto_created: false,
  };
}

/**
 * Preview Maps dry-run search candidates with per-candidate dedup.
 * Never creates prospects. Sample / dry-run data only.
 */
async function previewMapsDiscoverySearch(input = {}) {
  const searched = searchMapsDryRun({
    city: input.city,
    country_code: input.country_code != null ? input.country_code : input.countryCode,
    category: input.category,
    query: input.query,
    market: input.market || 'northern_spain',
    search_area: input.search_area != null ? input.search_area : input.searchArea,
  });
  if (!searched.ok) {
    return {
      ok: false,
      error: (searched.errors && searched.errors[0]) || 'Invalid Maps dry-run search.',
      errors: searched.errors || [],
      preview_only: true,
      dry_run: true,
      sample_data: true,
      prospect_created: false,
      auto_created: false,
      candidates: [],
      disclaimer: MAPS_SAMPLE_DISCLAIMER,
      status: 400,
    };
  }

  let existing = [];
  try {
    const listed = await listProspects();
    existing = Array.isArray(listed) ? listed : [];
  } catch (err) {
    if (isSalesStoreUnavailableError(err)) {
      return salesUnavailableResult();
    }
    throw err;
  }

  const candidates = [];
  for (const entry of searched.candidates || []) {
    const dedup = previewDiscoveryDeduplication({
      proposal: entry.proposal,
      existingProspects: existing,
    });
    candidates.push({
      ...entry,
      dedup: dedup && dedup.ok
        ? dedup
        : {
          ok: false,
          preview_only: true,
          prospect_created: false,
          matches: [],
          errors: (dedup && dedup.errors) || ['dedup_preview_failed'],
          disclaimer: DISCOVERY_PREVIEW_DISCLAIMER,
        },
    });
  }

  return {
    ok: true,
    preview_only: true,
    dry_run: true,
    sample_data: true,
    prospect_created: false,
    auto_created: false,
    disclaimer: MAPS_SAMPLE_DISCLAIMER,
    schema_version: searched.schema_version,
    source_name: searched.source_name,
    search_area: searched.search_area,
    criteria: searched.criteria,
    discarded_out_of_scope_count: searched.discarded_out_of_scope_count,
    candidates,
    rate_controls: searched.rate_controls,
  };
}

/**
 * Explicit operator import of one Maps dry-run fixture candidate (by place_id).
 * Re-resolves from fixture so provenance/place ID stay exact. Never auto-creates from search.
 */
async function importMapsDiscoveryCandidate(input = {}, actor = 'Admin') {
  const placeId = String(
    input.place_id != null ? input.place_id : (input.placeId || ''),
  ).trim();
  const searchArea = String(
    input.search_area != null ? input.search_area : (input.searchArea || ''),
  ).trim();

  const adapted = resolveMapsFixtureCandidate(placeId, { search_area: searchArea });
  if (!adapted.ok) {
    return {
      ok: false,
      error: (adapted.errors && adapted.errors[0]) || 'Invalid Maps dry-run candidate.',
      errors: adapted.errors || [],
      dry_run: true,
      sample_data: true,
      prospect_created: false,
      auto_created: false,
      status: 400,
    };
  }

  const created = await createProspect(
    {
      business_name: adapted.proposal.business_name,
      website_url: adapted.proposal.website_url,
    },
    actor,
  );
  if (!created || created.ok === false) {
    return {
      ...(created || { ok: false, error: 'Unable to create prospect.' }),
      dry_run: true,
      sample_data: true,
      prospect_created: false,
      auto_created: false,
    };
  }

  const audit = await appendAudit({
    actor: String(actor || 'Admin'),
    action: 'discovery_proposal_imported',
    entity_type: 'prospect',
    entity_id: created.prospect.id,
    detail: {
      prospect_id: created.prospect.id,
      source_name: adapted.provenance.source_name,
      source_reference: adapted.proposal.source_reference,
      place_id: adapted.place_id,
      search_area: adapted.search_area,
      location: adapted.proposal.location,
      category: adapted.proposal.category,
      schema_version: adapted.schema_version,
      dry_run: true,
      sample_data: true,
      auto_created: false,
    },
  });
  if (audit && audit.ok === false) {
    return {
      ...audit,
      dry_run: true,
      sample_data: true,
      prospect_created: false,
      auto_created: false,
    };
  }

  return {
    ok: true,
    prospect: created.prospect,
    research: created.research,
    proposal: adapted.proposal,
    provenance: adapted.provenance,
    place_id: adapted.place_id,
    search_area: adapted.search_area,
    dry_run: true,
    sample_data: true,
    prospect_created: true,
    auto_created: false,
    disclaimer: MAPS_SAMPLE_DISCLAIMER,
  };
}

module.exports = {
  ALLOWED_CONTACT_CONFIDENCE,
  ALLOWED_DECISIONS,
  ALLOWED_EVIDENCE_CONFIDENCE,
  ALLOWED_OUTREACH_CHANNELS,
  ALLOWED_QUALIFICATION_DECISIONS,
  ACTIONABLE_REVIEW_BUCKETS,
  ANALYTICS_DISCLAIMER,
  ANALYTICS_RECENT_ACTIVITY_LIMIT,
  CONTACT_BOUNDS,
  CONTACT_ENRICHMENT_DISCLAIMER,
  CRM_PREVIEW_LIFECYCLE_STAGE,
  CRM_PREVIEW_STATUS_PROPERTY,
  CRM_PREVIEW_STATUS_VALUE,
  DISCOVERY_PREVIEW_DISCLAIMER,
  EVIDENCE_BOUNDS,
  GOVERNANCE_DISCLAIMER,
  OUTREACH_DRAFT_BOUNDS,
  OUTREACH_DRAFT_DISCLAIMER,
  QUALIFICATION_BOUNDS,
  REVIEW_QUEUE_FILTERS,
  appendAudit,
  assignReviewBucket,
  buildActionBoundaryAuditSummary,
  buildCrmSyncPreview,
  buildDataQualityAlerts,
  buildDataRetentionNotes,
  buildExternalIntegrationState,
  buildHumanApprovalRules,
  buildPipelineCounts,
  buildRecentActivity,
  buildWorkflowSafeguards,
  compareReviewQueueItems,
  createProspect,
  decideProspect,
  extractCompanyDomain,
  filterReviewQueueItems,
  getCrmSyncPreview,
  getCurrentOutreachDraft,
  getLatestCrmReviewMark,
  getLatestQualification,
  getOutreachDraftWorkspace,
  getProspect,
  getResearchForProspect,
  getSalesAnalytics,
  getSalesGovernance,
  getSalesStoreMode,
  importManualDiscoveryProposal,
  importMapsDiscoveryCandidate,
  isActionableReviewBucket,
  listAuditEvents,
  listContactCandidatesForProspect,
  listCrmReviewMarksForProspect,
  listOutreachDraftRevisionsForProspect,
  listProspects,
  listQualificationsForProspect,
  listResearchForProspect,
  listReviewQueue,
  markReadyForCrmReview,
  normalizeReviewQueueFilter,
  previewManualDiscovery,
  previewMapsDiscoverySearch,
  recordManualContact,
  recordManualEvidence,
  recordQualification,
  resetSalesStore,
  saveOutreachDraft,
  sortReviewQueueItems,
  validateManualContact,
  validateManualEvidence,
  validateManualIntake,
  validateOutreachDraft,
  validateQualification,
  _setSalesRepositoryForTests,
};
