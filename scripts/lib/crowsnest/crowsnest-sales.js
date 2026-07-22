'use strict';

/**
 * Crowsnest Luna Sales Slice 1 — in-memory prospects, fixture research, decisions, audit.
 * No DB, HubSpot, Maps, Apollo, live AI, or outreach sending.
 */

const crypto = require('crypto');

const ALLOWED_DECISIONS = new Set(['approved', 'rejected', 'needs_research']);

/** @type {{ prospects: Map<string, object>, researchByProspect: Map<string, object>, auditEvents: object[] }} */
const store = {
  prospects: new Map(),
  researchByProspect: new Map(),
  auditEvents: [],
};

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function appendAudit(event) {
  const entry = {
    id: newId('aud'),
    at: nowIso(),
    ...event,
  };
  store.auditEvents.push(entry);
  return entry;
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
    id: newId('res'),
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

function createProspect(input = {}, actor = 'Admin') {
  const validation = validateManualIntake(input);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  const id = newId('prs');
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
  store.prospects.set(id, prospect);
  store.researchByProspect.set(id, research);

  appendAudit({
    actor: String(actor || 'Admin'),
    action: 'prospect_created',
    entity_type: 'prospect',
    entity_id: id,
    detail: {
      canonical_name: prospect.canonical_name,
      website_url: prospect.website_url,
      lifecycle_status: prospect.lifecycle_status,
    },
  });
  appendAudit({
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

  return { ok: true, prospect, research };
}

function listProspects() {
  return Array.from(store.prospects.values()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function getProspect(id) {
  return store.prospects.get(String(id || '')) || null;
}

function getResearchForProspect(id) {
  return store.researchByProspect.get(String(id || '')) || null;
}

function listAuditEvents(prospectId) {
  const events = store.auditEvents.slice();
  if (!prospectId) return events;
  const pid = String(prospectId);
  return events.filter((event) => {
    if (event.entity_id === pid) return true;
    if (event.detail && event.detail.prospect_id === pid) return true;
    return false;
  });
}

function decideProspect(id, input = {}, actor = 'Admin') {
  const prospect = getProspect(id);
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
  prospect.lifecycle_status = decision;
  prospect.updated_at = nowIso();
  prospect.last_decision = {
    decision,
    reason,
    reviewer_id: String(actor || 'Admin'),
    created_at: prospect.updated_at,
  };

  appendAudit({
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

  return { ok: true, prospect };
}

function resetSalesStore() {
  store.prospects.clear();
  store.researchByProspect.clear();
  store.auditEvents.length = 0;
}

module.exports = {
  ALLOWED_DECISIONS,
  appendAudit,
  createProspect,
  decideProspect,
  getProspect,
  getResearchForProspect,
  listAuditEvents,
  listProspects,
  resetSalesStore,
  validateManualIntake,
};
