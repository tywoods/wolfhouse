'use strict';

/**
 * Crowsnest Luna Sales Slice 1 — prospects, fixture research, decisions, audit.
 *
 * Persistence goes through crowsnest-sales-store (dedicated CROWSNEST_SALES_DATABASE_URL).
 * In-memory fallback is explicit for non-production/test when the durable DSN is absent.
 * Production without the dedicated DSN fails closed on Sales mutations.
 */

const {
  createMemorySalesRepository,
  createSalesRepository,
  newSalesUuid,
  resolveSalesStoreConfig,
} = require('./crowsnest-sales-store');

const ALLOWED_DECISIONS = new Set(['approved', 'rejected', 'needs_research']);

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

async function listAuditEvents(prospectId) {
  const repo = await getRepository();
  return repo.listAuditEvents(prospectId);
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
  appendAudit,
  createProspect,
  decideProspect,
  getProspect,
  getResearchForProspect,
  getSalesStoreMode,
  listAuditEvents,
  listProspects,
  resetSalesStore,
  validateManualIntake,
  _setSalesRepositoryForTests,
};
