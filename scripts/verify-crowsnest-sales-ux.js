'use strict';

/**
 * Deterministic presentation-contract verifier for Project Clear Deck.
 *
 * Slice A — North Star Baseline (preserved contracts + target UX).
 * Slice B — Sales Cockpit (default /sales operator home; intake gated behind mode=add).
 * Slice C — Prospect Flight Deck (lifecycle workspace on prospect detail).
 * Slice D — Quiet Supporting Rooms (review/analytics/discovery/CRM/outreach local badges).
 * Slice E — Polished Hull (Sales CSS/structural hooks, a11y, responsive one-column fallback).
 *
 * Static source + renderer checks only — no DB, no network, no screenshots,
 * no invented pipeline scores/data.
 *
 * Slice A prior RED baseline (pre–Slice B renderer): 34 passed, 9 failed
 * (cockpit heading, Add prospect, action/pipeline, default omits intake, mode=add gate,
 * add-mode intake contract, CRM/Outreach/Discovery contextual badges).
 * Slice D prior RED: 76 passed, 3 failed (CRM Preview only / Outreach Draft only /
 * Discovery sample|dry-run local safety-badge or safety-context).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const PAGE_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js');
const PKG_PATH = path.join(ROOT, 'package.json');
const PRODUCT_DOC = path.join(ROOT, 'docs', 'CROWSNEST.md');
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'SALES-UX-CLEAR-DECK.md');
const VERIFY_PATH = path.join(ROOT, 'scripts', 'verify-crowsnest-sales-ux.js');
const UMBRELLA_PATH = path.join(ROOT, 'scripts', 'verify-crowsnest.js');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function renderPageHtml(options) {
  try {
    const { renderCrowsnestPage } = require(PAGE_PATH);
    return typeof renderCrowsnestPage === 'function' ? renderCrowsnestPage(options) : '';
  } catch {
    return '';
  }
}

function hasFullIntakeForm(html) {
  const text = String(html || '');
  return /<form\b[^>]*\baction=["']\/sales\/prospects["']/i.test(text)
    && /\bname=["']business_name["']/.test(text)
    && /\bname=["']website_url["']/.test(text);
}

function hasPrimaryAddProspect(html) {
  const text = String(html || '');
  if (!/>\s*Add prospect\s*</i.test(text) && !/\bAdd prospect\b/i.test(text)) return false;
  return /btn-primary[\s\S]{0,240}Add prospect|Add prospect[\s\S]{0,240}btn-primary|<a\b[^>]*\bhref=["']\/sales\?mode=add["'][^>]*>[\s\S]*?Add prospect/i.test(text);
}

function hasActionPipelineRegion(html) {
  const text = String(html || '');
  return /id=["']sales-(?:action-queue|pipeline|actions|cockpit-actions)["']/i.test(text)
    || /class=["'][^"']*\bsales-(?:action-queue|pipeline|actions)\b[^"']*["']/i.test(text)
    || /aria-label=["'][^"']*(?:action queue|pipeline)[^"']*["']/i.test(text);
}

function hasCockpitHeading(html) {
  const text = String(html || '');
  return /id=["']sales-cockpit(?:-title)?["']/i.test(text)
    || /<h1\b[^>]*>[\s\S]*Sales cockpit/i.test(text)
    || /aria-labelledby=["']sales-cockpit-title["']/i.test(text);
}

function hasLocalSafetyBadge(html, phrase) {
  const text = String(html || '');
  const badge = /class=["'][^"']*\b(?:safety-badge|safety-context|contextual-safety)\b[^"']*["']/i.test(text);
  return badge && new RegExp(phrase, 'i').test(text);
}

function hasGroupedSecondaryNav(html) {
  const text = String(html || '');
  const hasWork = /\bWork\b/i.test(text)
    && /href=["']\/sales\/review["']/i.test(text)
    && /Review queue/i.test(text)
    && (/href=["']\/sales\?mode=add["'][^>]*>[\s\S]*?Prospect intake|Prospect intake[\s\S]{0,80}href=["']\/sales\?mode=add["']/i.test(text));
  const hasTools = /\bTools\b/i.test(text) && /href=["']\/sales\/discovery["']/i.test(text) && /\bDiscovery\b/i.test(text);
  const hasMonitor = /\bMonitor\b/i.test(text) && /href=["']\/sales\/analytics["']/i.test(text) && /\bAnalytics\b/i.test(text);
  const hasReference = /\bReference\b/i.test(text) && /\bGovernance\b/i.test(text);
  return hasWork && hasTools && hasMonitor && hasReference;
}

function hasCompactProspectCards(html) {
  const text = String(html || '');
  return /class=["'][^"']*\b(?:prospect-card|sales-prospect-card|compact-prospect)\b[^"']*["']/i.test(text)
    || /class=["'][^"']*\bprospect-list\b[^"']*["'][\s\S]*?class=["'][^"']*\bcard\b[^"']*["']/i.test(text);
}

function hasTruthfulStageCounts(html) {
  const text = String(html || '');
  // Counts must come from real lifecycle labels already used in Sales — no invented scores.
  return /id=["']sales-(?:pipeline|stage-counts|cockpit-pipeline)["']/i.test(text)
    || /aria-label=["'][^"']*pipeline[^"']*["']/i.test(text)
    || (
      /ready[_ ]for[_ ]review|Ready for review/i.test(text)
      && /needs[_ ]more[_ ]research|Needs more research/i.test(text)
    );
}

function hasAttentionOrNextActionList(html) {
  const text = String(html || '');
  return /id=["']sales-(?:action-queue|attention|next-actions)["']/i.test(text)
    || /aria-label=["'][^"']*(?:action queue|attention|next action)[^"']*["']/i.test(text)
    || /No prospects need attention|Nothing needs attention|No actionable prospects/i.test(text);
}

function hasBackToCockpit(html) {
  const text = String(html || '');
  return /href=["']\/sales["'][^>]*>[\s\S]*?(?:Back to (?:Sales )?cockpit|Sales cockpit)/i.test(text)
    || /Back to (?:Sales )?cockpit/i.test(text);
}

function hasWorkspaceHeader(html) {
  const text = String(html || '');
  return /id=["']sales-workspace-header["']/i.test(text)
    || /class=["'][^"']*\bsales-workspace-header\b[^"']*["']/i.test(text);
}

function hasNextStepRegion(html) {
  const text = String(html || '');
  return /id=["']sales-next-step["']/i.test(text)
    || /class=["'][^"']*\bsales-next-step\b[^"']*["']/i.test(text)
    || /aria-label=["'][^"']*next step[^"']*["']/i.test(text);
}

function lifecycleSectionIndexes(html) {
  const text = String(html || '');
  const ids = [
    'sales-workspace-overview',
    'sales-workspace-research',
    'sales-workspace-qualification',
    'sales-workspace-crm',
    'sales-workspace-outreach',
  ];
  return ids.map((id) => {
    const re = new RegExp(`id=["']${id}["']`, 'i');
    const m = re.exec(text);
    return m ? m.index : -1;
  });
}

function hasLifecycleSectionOrder(html) {
  const idxs = lifecycleSectionIndexes(html);
  if (idxs.some((i) => i < 0)) return false;
  for (let i = 1; i < idxs.length; i += 1) {
    if (idxs[i] <= idxs[i - 1]) return false;
  }
  return true;
}

function hasSecondarySupportingDetails(html) {
  const text = String(html || '');
  const contactsSecondary = /<details\b[^>]*\bsales-workspace-(?:contacts|secondary)[^>]*>[\s\S]*?<summary\b[^>]*>[\s\S]*?contact/i.test(text)
    || /id=["']sales-workspace-contacts["'][\s\S]{0,400}<details\b/i.test(text)
    || (/<details\b[\s\S]*?<summary\b[^>]*>[\s\S]*?Manual contact/i.test(text)
      && /id=["']sales-workspace-contacts["']|class=["'][^"']*\bsales-workspace-secondary\b/i.test(text));
  const auditSecondary = /<details\b[\s\S]*?<summary\b[^>]*>[\s\S]*?(?:audit|Append-only)/i.test(text);
  const adminSecondary = /<details\b[\s\S]*?<summary\b[^>]*>[\s\S]*?Admin status decision/i.test(text)
    || (/id=["']sales-workspace-admin-decision["']/i.test(text)
      && /class=["'][^"']*\bsales-workspace-secondary\b[^"']*["']/i.test(text));
  return Boolean(contactsSecondary && auditSecondary && adminSecondary);
}

function detailKeepsFormContracts(html) {
  const text = String(html || '');
  const actions = [
    /action=["']\/sales\/prospects\/[^"']+\/evidence["']/i,
    /action=["']\/sales\/prospects\/[^"']+\/contacts["']/i,
    /action=["']\/sales\/prospects\/[^"']+\/qualification["']/i,
    /action=["']\/sales\/prospects\/[^"']+\/decision["']/i,
    /action=["']\/sales\/prospects\/[^"']+\/crm-ready["']/i,
  ];
  const fields = [
    'source_label', 'source_url', 'summary', 'factual_notes', 'limitations', 'confidence',
    'full_name', 'role', 'email', 'phone', 'linkedin_url', 'source',
    'qualification_decision', 'rationale', 'evidence_ids',
    'decision', 'reason',
  ];
  if (!actions.every((re) => re.test(text))) return false;
  return fields.every((field) => new RegExp(`name=["']${field}["']`).test(text));
}

function nextStepCopy(html) {
  const text = String(html || '');
  const m = text.match(/id=["']sales-next-step["'][^>]*>([\s\S]*?)<\/(?:p|div|aside|section)>/i)
    || text.match(/class=["'][^"']*\bsales-next-step\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:p|div|aside|section)>/i);
  return m ? String(m[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function extractCrowsnestCss(src) {
  const text = String(src || '');
  const m = text.match(/const CROWSNEST_CSS\s*=\s*`([\s\S]*?)`;/);
  return m ? m[1] : '';
}

function hasSalesCockpitGrid(html) {
  const text = String(html || '');
  return /id=["']sales-cockpit-grid["']/i.test(text)
    || /class=["'][^"']*\bsales-cockpit-grid\b[^"']*["']/i.test(text);
}

function hasSalesStatusChip(html, status) {
  const text = String(html || '');
  const chip = /class=["'][^"']*\bsales-status-chip\b[^"']*["']/i.test(text);
  if (!chip) return false;
  if (!status) return true;
  const escaped = String(status).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `class=["'][^"']*\\bsales-status-chip\\b[^"']*["'][^>]*>[\\s\\S]{0,160}${escaped}`,
    'i',
  ).test(text);
}

function hasSalesActionCardHierarchy(html) {
  const text = String(html || '');
  return /id=["']sales-action-queue["'][\s\S]{0,1200}class=["'][^"']*\bsales-action-card\b[^"']*["']/i.test(text)
    || /class=["'][^"']*\bsales-action-card\b[^"']*["'][\s\S]{0,400}id=["']sales-action-queue["']/i.test(text);
}

function hasSupportingRoomNav(html) {
  const text = String(html || '');
  return /class=["'][^"']*\bsales-secondary-nav\b[^"']*["']/i.test(text)
    && /aria-label=["']Sales secondary navigation["']/i.test(text)
    && /class=["'][^"']*\bsales-room-back\b[^"']*["']/i.test(text);
}

function cssHasOneColumnSalesFallback(css) {
  const text = String(css || '');
  const cockpitOneCol = /\.sales-cockpit-grid\s*\{[^}]*grid-template-columns\s*:\s*1fr/i.test(text)
    || /\.sales-cockpit-grid\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/i.test(text);
  const pipelineOneCol = /\.sales-pipeline\s*\{[^}]*grid-template-columns\s*:\s*(?:1fr|repeat\(\s*1\b)/i.test(text);
  const navOneCol = /\.sales-secondary-nav\s*\{[^}]*grid-template-columns\s*:\s*1fr/i.test(text)
    || (
      /\.sales-secondary-nav\s*\{[^}]*display\s*:\s*grid/i.test(text)
      && !/\.sales-secondary-nav\s*\{[^}]*grid-template-columns\s*:\s*repeat\(/i.test(text)
    );
  const desktopExpand = /@media\s*\(\s*min-width\s*:\s*720px\s*\)\s*\{[\s\S]{0,2400}\.sales-(?:pipeline|secondary-nav|cockpit-grid)/i.test(text);
  return cockpitOneCol && pipelineOneCol && navOneCol && desktopExpand;
}

function cssHidesEssentialSalesAtNarrow(css) {
  const text = String(css || '');
  const narrowBlocks = text.match(/@media\s*\([^)]*(?:max-width)\s*:[^)]+\)\s*\{[\s\S]*?\n\}/gi) || [];
  const essential = [
    'sales-cockpit',
    'sales-pipeline',
    'sales-action-queue',
    'sales-workspace-header',
    'sales-secondary-nav',
    'sales-status-chip',
    'sales-action-card',
  ];
  return narrowBlocks.some((block) => essential.some((hook) => (
    new RegExp(`\\.${hook}\\b[^}]*display\\s*:\\s*none`, 'i').test(block)
    || new RegExp(`#${hook}\\b[^}]*display\\s*:\\s*none`, 'i').test(block)
  )));
}

function cssHasKeyboardVisibleFocus(css) {
  const text = String(css || '');
  const focusRule = /:focus-visible[^{]*\{[^}]*box-shadow\s*:\s*var\(--focus\)/i.test(text)
    || /:focus-visible[^{]*\{[^}]*outline\s*:/i.test(text);
  const coversControls = /a:focus-visible/i.test(text)
    && /button:focus-visible/i.test(text)
    && /input:focus-visible/i.test(text)
    && /select:focus-visible/i.test(text)
    && /textarea:focus-visible/i.test(text);
  return focusRule && coversControls;
}

function cssUsesExistingSalesTokens(css) {
  const text = String(css || '');
  return /--sand\s*:/i.test(text)
    && /--sea\s*:/i.test(text)
    && /--navy\s*:/i.test(text)
    && /\.sales-status-chip\s*\{[^}]*var\(--(?:sea|navy|sand)/i.test(text);
}

console.log('verify:crowsnest-sales-ux — Clear Deck Slice A–E presentation contract\n');

const apiSrc = read(API_PATH) || '';
const pageSrc = read(PAGE_PATH) || '';
const productDoc = read(PRODUCT_DOC) || '';
const uxDoc = read(DOC_PATH) || '';
const umbrellaSrc = read(UMBRELLA_PATH) || '';

const defaultSalesHtml = renderPageHtml({ view: 'sales' });
const addModeSalesHtml = renderPageHtml({ view: 'sales', mode: 'add', salesMode: 'add' });
const populatedSalesHtml = renderPageHtml({
  view: 'sales',
  prospects: [
    {
      id: 'ux-p1',
      canonical_name: 'UX Ready Hostel',
      website_url: 'https://ready.example.invalid',
      lifecycle_status: 'ready_for_review',
    },
    {
      id: 'ux-p2',
      canonical_name: 'UX Research Hostel',
      website_url: 'https://research.example.invalid',
      lifecycle_status: 'needs_more_research',
    },
    {
      id: 'ux-p3',
      canonical_name: 'UX Qualified Hostel',
      website_url: 'https://qualified.example.invalid',
      lifecycle_status: 'qualified',
    },
  ],
});
const crmHtml = renderPageHtml({
  view: 'sales_crm_preview',
  prospect: {
    id: 'ux-fixture-prospect',
    canonical_name: 'UX Fixture Hostel',
    website_url: 'https://example.invalid',
    lifecycle_status: 'qualified',
  },
  crmPreview: {
    company: {
      name: 'UX Fixture Hostel',
      website_url: 'https://example.invalid',
      domain: 'example.invalid',
      lifecycle_stage: 'lead',
      properties: { luna_sales_prospect_id: 'ux-fixture-prospect' },
    },
    contacts: [],
    traceability: {
      decision: 'qualified',
      rationale: 'Fit for pilot',
      qualification_assessment_id: 'ux-qual-1',
      evidence_ids: ['ux-ev-1'],
    },
    disclaimer: 'Preview only — no CRM record has been sent.',
  },
});
const outreachHtml = renderPageHtml({
  view: 'sales_outreach_draft',
  prospect: {
    id: 'ux-fixture-prospect',
    canonical_name: 'UX Fixture Hostel',
    website_url: 'https://example.invalid',
    lifecycle_status: 'crm_ready',
  },
  draftReady: true,
  draftPresent: false,
});
const discoveryHtml = renderPageHtml({ view: 'sales_discovery' });
const reviewHtml = renderPageHtml({
  view: 'sales_review',
  reviewQueueFilter: 'actionable',
  reviewQueueItems: [{
    id: 'ux-review-1',
    canonical_name: 'UX Review Hostel',
    website_url: 'https://review.example.invalid',
    bucket: 'ready_for_review',
    evidence_count: 1,
    latest_qualification_decision: null,
    draft_ready: false,
    draft_present: false,
    most_recent_activity: '2026-07-01T00:00:00.000Z',
  }],
});
const analyticsHtml = renderPageHtml({
  view: 'sales_analytics',
  analyticsCounts: {
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
  },
  analyticsRecentActivity: [],
  analyticsDataQualityAlerts: [],
});

const detailBaseProspect = {
  id: 'ux-detail-1',
  canonical_name: 'UX Flight Deck Hostel',
  website_url: 'https://flight-deck.example.invalid',
  lifecycle_status: 'researching',
};
const detailEvidenceJob = {
  id: 'ux-ev-1',
  source: 'manual',
  job_label: 'Manual evidence',
  summary: 'Operator note',
  status: 'completed',
  facts: ['Has website'],
  limitations: ['No phone yet'],
  confidence: 'medium',
  created_at: '2026-07-01T00:00:00.000Z',
};
const detailNoEvidenceHtml = renderPageHtml({
  view: 'sales_detail',
  prospect: detailBaseProspect,
  researchJobs: [],
  qualificationAssessments: [],
  auditEvents: [],
});
const detailReadyToQualifyHtml = renderPageHtml({
  view: 'sales_detail',
  prospect: { ...detailBaseProspect, lifecycle_status: 'ready_for_review' },
  researchJobs: [detailEvidenceJob],
  qualificationAssessments: [],
  auditEvents: [],
});
const detailQualifiedHtml = renderPageHtml({
  view: 'sales_detail',
  prospect: { ...detailBaseProspect, lifecycle_status: 'qualified' },
  researchJobs: [detailEvidenceJob],
  latestQualification: {
    id: 'ux-qual-1',
    decision: 'qualified',
    rationale: 'Fit for pilot',
    evidence_ids: ['ux-ev-1'],
    reviewer_id: 'Admin',
    created_at: '2026-07-02T00:00:00.000Z',
  },
  qualificationAssessments: [{
    id: 'ux-qual-1',
    decision: 'qualified',
    rationale: 'Fit for pilot',
    evidence_ids: ['ux-ev-1'],
    reviewer_id: 'Admin',
    created_at: '2026-07-02T00:00:00.000Z',
  }],
  auditEvents: [],
});
const detailCrmReadyHtml = renderPageHtml({
  view: 'sales_detail',
  prospect: { ...detailBaseProspect, lifecycle_status: 'crm_ready' },
  researchJobs: [detailEvidenceJob],
  latestQualification: {
    id: 'ux-qual-1',
    decision: 'qualified',
    rationale: 'Fit for pilot',
    evidence_ids: ['ux-ev-1'],
    reviewer_id: 'Admin',
    created_at: '2026-07-02T00:00:00.000Z',
  },
  latestCrmReviewMark: {
    id: 'ux-crm-1',
    qualification_assessment_id: 'ux-qual-1',
    reviewer_id: 'Admin',
    created_at: '2026-07-03T00:00:00.000Z',
  },
  draftReady: true,
  draftPresent: false,
  auditEvents: [{
    id: 'ux-audit-1',
    actor: 'Admin',
    action: 'crm_review_marked_ready',
    entity_type: 'crm_review',
    entity_id: 'ux-crm-1',
    created_at: '2026-07-03T00:00:00.000Z',
    detail: {},
  }],
});
const detailDraftPresentHtml = renderPageHtml({
  view: 'sales_detail',
  prospect: { ...detailBaseProspect, lifecycle_status: 'crm_ready' },
  researchJobs: [detailEvidenceJob],
  latestQualification: {
    id: 'ux-qual-1',
    decision: 'qualified',
    rationale: 'Fit for pilot',
    evidence_ids: ['ux-ev-1'],
    reviewer_id: 'Admin',
    created_at: '2026-07-02T00:00:00.000Z',
  },
  latestCrmReviewMark: {
    id: 'ux-crm-1',
    qualification_assessment_id: 'ux-qual-1',
    reviewer_id: 'Admin',
    created_at: '2026-07-03T00:00:00.000Z',
  },
  currentOutreachDraft: {
    id: 'ux-draft-1',
    revision_number: 1,
    channel: 'email',
    subject: 'Hello',
    body: 'Draft body',
  },
  draftReady: true,
  draftPresent: true,
  auditEvents: [],
});
const detailErrorHtml = renderPageHtml({
  view: 'sales_detail',
  prospect: { ...detailBaseProspect, lifecycle_status: 'ready_for_review' },
  researchJobs: [detailEvidenceJob],
  evidenceError: 'Evidence validation failed fixture',
  qualificationError: 'Qualification validation failed fixture',
  contactError: 'Contact validation failed fixture',
  crmReadyError: 'CRM ready validation failed fixture',
  outreachDraftError: 'Outreach draft validation failed fixture',
  decisionError: 'Decision validation failed fixture',
});

console.log('\n▸ Slice A prior RED baseline proof (cockpit + contextual badges)');
ok('Sales cockpit heading', hasCockpitHeading(defaultSalesHtml), 'need Sales cockpit heading / sales-cockpit hook');
ok('visible primary Add prospect action', hasPrimaryAddProspect(defaultSalesHtml), 'need primary Add prospect control');
ok('action/pipeline region', hasActionPipelineRegion(defaultSalesHtml), 'need sales action queue or pipeline region');
ok(
  'default Sales omits full intake form',
  !hasFullIntakeForm(defaultSalesHtml),
  'default /sales still renders full intake form',
);
ok(
  'explicit add mode is represented for intake',
  /mode\s*===\s*['"]add['"]|\bsalesMode\b[\s\S]{0,40}add|\/sales\?mode=add/i.test(pageSrc),
  'no mode=add / salesMode add gate in renderer source',
);
ok(
  'add-mode Sales keeps intake POST field contract when gated',
  (/mode\s*===\s*['"]add['"]|\bsalesMode\b[\s\S]{0,40}add|\/sales\?mode=add/i.test(pageSrc)
    && hasFullIntakeForm(addModeSalesHtml)),
  'add mode must gate and still surface POST /sales/prospects + business_name + website_url',
);
ok(
  'CRM preview uses local contextual Preview only badge',
  hasLocalSafetyBadge(crmHtml, 'Preview only'),
  'need safety-badge/safety-context near CRM preview action',
);
ok(
  'Outreach uses local contextual Draft only badge',
  hasLocalSafetyBadge(outreachHtml, 'Draft only'),
  'need safety-badge/safety-context near outreach draft action',
);
ok(
  'Discovery uses local contextual sample/dry-run badge',
  hasLocalSafetyBadge(discoveryHtml, 'sample|dry-run'),
  'need safety-badge/safety-context near discovery actions',
);

console.log('\n▸ Slice B — Sales cockpit (default + add mode)');
ok('cockpit has Sales cockpit heading', hasCockpitHeading(defaultSalesHtml));
ok('cockpit primary Add prospect links to mode=add', hasPrimaryAddProspect(defaultSalesHtml)
  && /href=["']\/sales\?mode=add["']/i.test(defaultSalesHtml));
ok('cockpit action/pipeline region present', hasActionPipelineRegion(defaultSalesHtml));
ok(
  'cockpit stage counts use truthful lifecycle labels only',
  /id=["']sales-(?:pipeline|stage-counts|cockpit-pipeline)["']/i.test(populatedSalesHtml)
    || /aria-label=["'][^"']*pipeline[^"']*["']/i.test(populatedSalesHtml),
  'need dedicated pipeline / stage-count region (not raw status text alone)',
);
ok('cockpit attention / next-action list present', hasAttentionOrNextActionList(defaultSalesHtml)
  || hasAttentionOrNextActionList(populatedSalesHtml));
ok(
  'cockpit empty attention state is truthful when no prospects',
  /id=["']sales-(?:action-queue|attention|next-actions)["'][\s\S]{0,500}(?:No prospects yet|No prospects need attention|Nothing needs attention|No actionable prospects)/i.test(defaultSalesHtml)
    || /(?:No prospects yet|No prospects need attention|Nothing needs attention|No actionable prospects)[\s\S]{0,200}id=["']sales-(?:action-queue|attention|next-actions)["']/i.test(defaultSalesHtml),
);
ok(
  'cockpit compact prospect cards when prospects exist',
  /class=["'][^"']*\b(?:prospect-card|sales-prospect-card|compact-prospect)\b[^"']*["']/i.test(populatedSalesHtml),
  'need prospect-card / compact-prospect class hooks',
);
ok(
  'populated cockpit lists existing prospect names/status only',
  populatedSalesHtml.includes('UX Ready Hostel')
    && populatedSalesHtml.includes('ready_for_review')
    && !/priority\s*score|ai\s*score|invented/i.test(populatedSalesHtml),
);
ok('cockpit secondary nav grouped Work/Tools/Monitor/Reference', hasGroupedSecondaryNav(defaultSalesHtml));
ok('Work group promotes Review queue', /\bWork\b[\s\S]{0,500}href=["']\/sales\/review["'][\s\S]{0,80}Review queue/i.test(defaultSalesHtml));
ok(
  'Work group includes Prospect intake',
  /href=["']\/sales\?mode=add["'][^>]*>[\s\S]*?Prospect intake|Prospect intake[\s\S]{0,80}href=["']\/sales\?mode=add["']/i.test(defaultSalesHtml),
);
ok('Tools group includes Discovery', /\bTools\b[\s\S]{0,500}href=["']\/sales\/discovery["']/i.test(defaultSalesHtml));
ok('Monitor group includes Analytics', /\bMonitor\b[\s\S]{0,500}href=["']\/sales\/analytics["']/i.test(defaultSalesHtml));
ok('Reference group includes Governance', /\bReference\b[\s\S]{0,500}Governance/i.test(defaultSalesHtml));
ok('default cockpit does not render full intake form', !hasFullIntakeForm(defaultSalesHtml));
ok('add mode renders unchanged intake POST + fields', hasFullIntakeForm(addModeSalesHtml));
ok('add mode has clear back-to-cockpit link', hasBackToCockpit(addModeSalesHtml));
ok(
  'API GET /sales reads mode query for presentation',
  /mode|salesMode/i.test(apiSrc)
    && /getRequestSearchParams|searchParams/i.test(apiSrc)
    && /pathname\s*===\s*['"]\/sales['"]|view\s*===\s*['"]sales['"]/.test(apiSrc),
  'need mode=add presentation pass-through on GET /sales',
);

console.log('\n▸ Slice C — Prospect Flight Deck (detail workspace)');
ok(
  'detail workspace header present',
  hasWorkspaceHeader(detailNoEvidenceHtml),
  'need sales-workspace-header hook',
);
ok(
  'detail header shows compact identity + status',
  hasWorkspaceHeader(detailNoEvidenceHtml)
    && /UX Flight Deck Hostel/i.test(detailNoEvidenceHtml)
    && /flight-deck\.example\.invalid/i.test(detailNoEvidenceHtml)
    && /<code[^>]*>researching<\/code>|lifecycle_status|Lifecycle/i.test(detailNoEvidenceHtml),
  'header must surface name, website, and lifecycle status',
);
ok(
  'detail next-step region present',
  hasNextStepRegion(detailNoEvidenceHtml),
  'need sales-next-step hook',
);
ok(
  'next step when no evidence: record research evidence',
  /record(?:\s+manual)?\s+research\s+evidence|record\s+manual\s+evidence/i.test(nextStepCopy(detailNoEvidenceHtml)),
  nextStepCopy(detailNoEvidenceHtml) || 'missing next-step copy',
);
ok(
  'next step when evidence only: record qualification',
  /record\s+(?:a\s+)?qualification/i.test(nextStepCopy(detailReadyToQualifyHtml)),
  nextStepCopy(detailReadyToQualifyHtml) || 'missing next-step copy',
);
ok(
  'next step when qualified: mark CRM ready',
  /mark\s+ready\s+for\s+CRM\s+review/i.test(nextStepCopy(detailQualifiedHtml)),
  nextStepCopy(detailQualifiedHtml) || 'missing next-step copy',
);
ok(
  'next step when CRM-ready without draft: open outreach draft',
  /open\s+outreach\s+draft|create\s+outreach\s+draft|draft\s+outreach/i.test(nextStepCopy(detailCrmReadyHtml)),
  nextStepCopy(detailCrmReadyHtml) || 'missing next-step copy',
);
ok(
  'next step when draft present: review outreach draft',
  /review\s+outreach\s+draft/i.test(nextStepCopy(detailDraftPresentHtml)),
  nextStepCopy(detailDraftPresentHtml) || 'missing next-step copy',
);
ok(
  'lifecycle sections Overview → Research → Qualification → CRM → Draft outreach',
  hasLifecycleSectionOrder(detailQualifiedHtml),
  'need ordered sales-workspace-* section ids',
);
ok(
  'lifecycle section headings present in order',
  (() => {
    const text = detailQualifiedHtml;
    const overview = text.search(/id=["']sales-workspace-overview["'][\s\S]{0,200}Overview/i);
    const research = text.search(/id=["']sales-workspace-research["'][\s\S]{0,200}Research/i);
    const qualification = text.search(/id=["']sales-workspace-qualification["'][\s\S]{0,200}Qualification/i);
    const crm = text.search(/id=["']sales-workspace-crm["'][\s\S]{0,240}CRM review/i);
    const outreach = text.search(/id=["']sales-workspace-outreach["'][\s\S]{0,240}Draft outreach/i);
    return overview >= 0 && research > overview && qualification > research && crm > qualification && outreach > crm;
  })(),
);
ok(
  'detail preserves all current form actions and field names',
  detailKeepsFormContracts(detailQualifiedHtml),
  'evidence/contacts/qualification/decision/crm-ready forms must remain reachable',
);
ok(
  'validation errors stay next to their forms',
  /Evidence validation failed fixture/i.test(detailErrorHtml)
    && /Qualification validation failed fixture/i.test(detailErrorHtml)
    && /Contact validation failed fixture/i.test(detailErrorHtml)
    && /CRM ready validation failed fixture/i.test(detailErrorHtml)
    && /Outreach draft validation failed fixture/i.test(detailErrorHtml)
    && /Decision validation failed fixture/i.test(detailErrorHtml)
    && /role=["']alert["']/i.test(detailErrorHtml),
);
ok(
  'CRM preview and outreach draft links remain when gated open',
  /href=["']\/sales\/prospects\/ux-detail-1\/crm-preview["']/i.test(detailQualifiedHtml)
    && /href=["']\/sales\/prospects\/ux-detail-1\/outreach-draft["']/i.test(detailCrmReadyHtml),
);
ok(
  'contacts, admin decision, and audit are reachable but secondary',
  hasSecondarySupportingDetails(detailCrmReadyHtml)
    && /name=["']full_name["']/.test(detailCrmReadyHtml)
    && /name=["']decision["']/.test(detailCrmReadyHtml)
    && /crm_review_marked_ready|Append-only audit|audit/i.test(detailCrmReadyHtml),
  'use accessible details/summary (or secondary region) without hiding forms/data',
);
ok(
  'admin decision remains after qualification and is visually secondary',
  (() => {
    const text = detailQualifiedHtml;
    const qualIdx = text.search(/id=["']sales-workspace-qualification["']/i);
    const adminIdx = text.search(/Admin status decision/i);
    const secondary = /sales-workspace-secondary|<\/summary>[\s\S]*Admin status decision|<details\b[\s\S]*Admin status decision/i.test(text);
    return qualIdx >= 0 && adminIdx > qualIdx && secondary;
  })(),
);
ok(
  'detail omits local preview/draft badges (live on CRM/outreach rooms)',
  !hasLocalSafetyBadge(detailQualifiedHtml, 'Preview only')
    && !hasLocalSafetyBadge(detailCrmReadyHtml, 'Draft only'),
);
ok(
  'detail does not invent scores or AI statuses',
  !/priority\s*score|ai\s*score|lead_score\s*[:=]|invented/i.test(detailQualifiedHtml),
);
ok(
  'safety source claims still present on detail',
  /no CRM (?:record has been sent|writes)/i.test(detailQualifiedHtml)
    && /no message has been sent/i.test(detailCrmReadyHtml),
);

console.log('\n▸ Slice D — Quiet Supporting Rooms');
ok(
  'CRM preview uses local contextual Preview only badge',
  hasLocalSafetyBadge(crmHtml, 'Preview only'),
  'need safety-badge/safety-context near CRM preview action',
);
ok(
  'Outreach uses local contextual Draft only badge',
  hasLocalSafetyBadge(outreachHtml, 'Draft only'),
  'need safety-badge/safety-context near outreach draft action',
);
ok(
  'Discovery uses local contextual sample/dry-run badge',
  hasLocalSafetyBadge(discoveryHtml, 'sample|dry-run'),
  'need safety-badge/safety-context near discovery actions',
);
ok(
  'CRM Preview only badge sits near primary CRM-ready action',
  /safety-badge|safety-context|contextual-safety/i.test(crmHtml)
    && /Preview only[\s\S]{0,400}crm-ready|crm-ready[\s\S]{0,400}Preview only/i.test(crmHtml),
);
ok(
  'Outreach Draft only badge sits near draft form action',
  /safety-badge|safety-context|contextual-safety/i.test(outreachHtml)
    && /Draft only[\s\S]{0,500}outreach-draft|outreach-draft[\s\S]{0,500}Draft only/i.test(outreachHtml),
);
ok(
  'Discovery sample/dry-run badge sits near Maps dry-run section',
  /id=["']maps-discovery-dry-run["'][\s\S]{0,600}(?:safety-badge|safety-context|contextual-safety)/i.test(discoveryHtml)
    || /(?:safety-badge|safety-context|contextual-safety)[\s\S]{0,600}id=["']maps-discovery-dry-run["']/i.test(discoveryHtml)
    || /(?:safety-badge|safety-context)[^>]*>[\s\S]{0,80}(?:sample|dry-run)/i.test(discoveryHtml),
);
ok(
  'Review is focused filter + actionable queue',
  /id=["']sales-review["']/i.test(reviewHtml)
    && /name=["']state["']/i.test(reviewHtml)
    && (/aria-label=["']Sales review queue["']/i.test(reviewHtml) || /class=["'][^"']*\breview-queue-list\b/i.test(reviewHtml))
    && /Apply filter/i.test(reviewHtml)
    && /UX Review Hostel/i.test(reviewHtml),
);
ok(
  'Review retains all six filter values',
  ['all', 'actionable', 'needs_more_research', 'qualified', 'not_qualified', 'crm_ready']
    .every((value) => new RegExp(`value=["']${value}["']`).test(reviewHtml)),
);
ok(
  'Discovery keeps manual proposal primary and Maps sample/dry-run separate',
  /Manual discovery proposal/i.test(discoveryHtml)
    && /maps-discovery-dry-run/i.test(discoveryHtml)
    && /action=["']\/sales\/discovery\/preview["']/i.test(discoveryHtml)
    && /action=["']\/sales\/discovery\/maps\/preview["']/i.test(discoveryHtml),
);
ok(
  'Discovery preview and import remain distinct explicit actions',
  /action=["']\/sales\/discovery\/preview["']/i.test(pageSrc)
    && /action=["']\/sales\/discovery\/import["']/i.test(pageSrc)
    && /action=["']\/sales\/discovery\/maps\/preview["']/i.test(pageSrc)
    && /action=["']\/sales\/discovery\/maps\/import["']/i.test(pageSrc)
    && /Import as prospect \(explicit\)|Import candidate \(explicit\)/i.test(pageSrc),
);
ok(
  'Analytics stays read-only with no remediation controls',
  /id=["']sales-analytics["']/i.test(analyticsHtml)
    && /read-only|informational|operators decide/i.test(analyticsHtml)
    && !/<button\b[^>]*>\s*(?:Fix|Remediat\w*|Auto-?heal|Sync now)\b/i.test(analyticsHtml)
    && !/action=["']\/sales\/analytics/i.test(analyticsHtml)
    && !/\bautomatic remediation\b/i.test(analyticsHtml),
);
ok(
  'Governance holds detailed policy / safeguards',
  /id=["']sales-governance["']/i.test(defaultSalesHtml)
    && /no CRM writes|no CRM record has been sent/i.test(defaultSalesHtml)
    && /no message has been sent|draft only/i.test(defaultSalesHtml)
    && /no live Maps|sample|dry-run/i.test(defaultSalesHtml),
);
ok(
  'Supporting rooms share Sales secondary navigation helper',
  hasGroupedSecondaryNav(reviewHtml)
    && hasGroupedSecondaryNav(analyticsHtml)
    && hasGroupedSecondaryNav(discoveryHtml),
);
ok(
  'Supporting CRM/outreach/discovery pages avoid fresh page-wide disclaimer walls',
  !/<div class=["']safety["']>[\s\S]*?(?:Safety:|Preview-only CRM|Internal outreach drafts only|Manual discovery plus Maps)/i.test(crmHtml)
    && !/<div class=["']safety["']>[\s\S]*?(?:Safety:|Internal outreach drafts only)/i.test(outreachHtml)
    && !/<div class=["']safety["']>[\s\S]*?(?:Safety:|Manual discovery plus Maps)/i.test(discoveryHtml),
);

const crowsnestCss = extractCrowsnestCss(pageSrc);

console.log('\n▸ Slice E — Polished Hull (structure, a11y, responsive CSS)');
ok(
  'cockpit uses sales-cockpit-grid structural hook',
  hasSalesCockpitGrid(defaultSalesHtml) && hasSalesCockpitGrid(populatedSalesHtml),
  'need sales-cockpit-grid class or id on default /sales cockpit',
);
ok(
  'action queue uses sales-action-card hierarchy',
  hasSalesActionCardHierarchy(populatedSalesHtml),
  'need sales-action-card inside sales-action-queue when attention items exist',
);
ok(
  'cockpit status chips carry visible lifecycle text (not colour alone)',
  hasSalesStatusChip(populatedSalesHtml, 'ready_for_review')
    && hasSalesStatusChip(populatedSalesHtml, 'needs_more_research'),
  'need sales-status-chip with lifecycle status text on action/prospect cards',
);
ok(
  'workspace header keeps hook and compact status chip',
  hasWorkspaceHeader(detailNoEvidenceHtml)
    && hasSalesStatusChip(detailNoEvidenceHtml, 'researching')
    && /id=["']sales-workspace-title["']/i.test(detailNoEvidenceHtml)
    && /<h1\b[^>]*id=["']sales-workspace-title["']/i.test(detailNoEvidenceHtml),
  'header needs h1#sales-workspace-title plus sales-status-chip with lifecycle text',
);
ok(
  'supporting rooms keep Sales secondary navigation + back link',
  hasSupportingRoomNav(reviewHtml)
    && hasSupportingRoomNav(analyticsHtml)
    && hasSupportingRoomNav(discoveryHtml)
    && hasSupportingRoomNav(crmHtml)
    && hasSupportingRoomNav(outreachHtml),
);
ok(
  'CSS one-column Sales fallback + desktop expand at 720px',
  cssHasOneColumnSalesFallback(crowsnestCss),
  'sales-cockpit-grid / sales-pipeline / sales-secondary-nav must default to one column and expand at min-width:720px',
);
ok(
  'narrow CSS does not hide essential Sales regions',
  !cssHidesEssentialSalesAtNarrow(crowsnestCss),
  'must not display:none cockpit/pipeline/action-queue/workspace/nav/status/action hooks at max-width',
);
ok(
  'keyboard-visible focus covers links and Sales form controls',
  cssHasKeyboardVisibleFocus(crowsnestCss),
  'need :focus-visible rules for a/button/input/select/textarea',
);
ok(
  'Sales status chip styles use existing sand/sea/navy tokens',
  cssUsesExistingSalesTokens(crowsnestCss),
  'sales-status-chip must reference var(--sea|--navy|--sand)',
);
ok(
  'semantic headings: cockpit h2 + workspace section h2s',
  /<h2\b[^>]*id=["']sales-cockpit-title["'][^>]*>\s*Sales cockpit/i.test(defaultSalesHtml)
    && /id=["']sales-workspace-overview["'][\s\S]{0,120}<h2\b/i.test(detailQualifiedHtml)
    && /id=["']sales-workspace-research["'][\s\S]{0,120}<h2\b/i.test(detailQualifiedHtml)
    && /id=["']sales-workspace-qualification["'][\s\S]{0,120}<h2\b/i.test(detailQualifiedHtml),
);
ok(
  'labelled Sales controls retained (intake + review filter)',
  /<label\b[^>]*\bfor=["']business_name["']/i.test(addModeSalesHtml)
    && /<label\b[^>]*\bfor=["']website_url["']/i.test(addModeSalesHtml)
    && /<label\b[^>]*\bfor=["']state["']/i.test(reviewHtml)
    && /id=["']business_name["']/i.test(addModeSalesHtml)
    && /id=["']website_url["']/i.test(addModeSalesHtml)
    && /id=["']state["']/i.test(reviewHtml),
);
ok(
  'validation errors remain role=alert beside forms',
  /role=["']alert["']/i.test(detailErrorHtml)
    && /Evidence validation failed fixture/i.test(detailErrorHtml),
);
ok(
  'prospect list stays distinct from action-card hierarchy',
  /class=["'][^"']*\bprospect-list\b[^"']*["'][\s\S]{0,800}class=["'][^"']*\b(?:prospect-card|compact-prospect)\b/i.test(populatedSalesHtml)
    && /sales-action-queue[\s\S]{0,800}sales-action-card/i.test(populatedSalesHtml),
);
ok(
  'no new client JS / animation framework in Sales CSS hooks',
  !/\bsales-[\w-]+\s*\{[^}]*animation\s*:/i.test(crowsnestCss)
    && !/framer-motion|tailwind|bootstrap|animate\.css/i.test(pageSrc),
);

console.log('\n▸ Preserved Sales GET routes (source/router + renderer)');
const getRoutes = [
  ['GET /sales', /pathname\s*===\s*['"]\/sales['"]/, /view:\s*['"]sales['"]|href:\s*['"]\/sales['"]|renderSalesMain/],
  ['GET /sales/review', /pathname\s*===\s*['"]\/sales\/review['"]/, /sales_review|\/sales\/review|renderSalesReviewMain/],
  ['GET /sales/analytics', /pathname\s*===\s*['"]\/sales\/analytics['"]/, /sales_analytics|\/sales\/analytics|renderSalesAnalyticsMain/],
  ['GET /sales/discovery', /pathname\s*===\s*['"]\/sales\/discovery['"]/, /sales_discovery|\/sales\/discovery|renderSalesDiscoveryMain/],
  ['GET /sales/prospects/:id', /matchSalesProspectDetailPath|\/sales\/prospects\//, /sales_detail|renderSalesDetailMain/],
  ['GET /sales/prospects/:id/crm-preview', /matchSalesCrmPreviewPath|crm-preview/, /sales_crm_preview|renderSalesCrmPreviewMain|crm-preview/],
  ['GET /sales/prospects/:id/outreach-draft', /matchSalesOutreachDraftPath|outreach-draft/, /sales_outreach_draft|renderSalesOutreachDraftMain|outreach-draft/],
];
for (const [label, apiRe, pageRe] of getRoutes) {
  ok(`${label} represented`, apiRe.test(apiSrc) && pageRe.test(pageSrc));
}

console.log('\n▸ Preserved Sales POST actions + field names (renderer contracts)');
const postActions = [
  ['POST /sales/prospects', /action=["']\/sales\/prospects["']/, ['business_name', 'website_url']],
  ['POST /sales/prospects/:id/evidence', /action=["']\/sales\/prospects\/\$\{[^}]+\}\/evidence["']/, ['source_label', 'source_url', 'summary', 'factual_notes', 'limitations', 'confidence']],
  ['POST /sales/prospects/:id/contacts', /action=["']\/sales\/prospects\/\$\{[^}]+\}\/contacts["']/, ['full_name', 'role', 'email', 'phone', 'linkedin_url', 'source', 'confidence']],
  ['POST /sales/prospects/:id/qualification', /action=["']\/sales\/prospects\/\$\{[^}]+\}\/qualification["']/, ['qualification_decision', 'rationale', 'evidence_ids']],
  ['POST /sales/prospects/:id/decision', /action=["']\/sales\/prospects\/\$\{[^}]+\}\/decision["']/, ['decision', 'reason']],
  ['POST /sales/prospects/:id/crm-ready', /action=["']\/sales\/prospects\/\$\{[^}]+\}\/crm-ready["']/, []],
  ['POST /sales/prospects/:id/outreach-draft', /action=["']\/sales\/prospects\/\$\{[^}]+\}\/outreach-draft["']/, ['subject', 'body', 'channel']],
  ['POST /sales/discovery/preview', /action=["']\/sales\/discovery\/preview["']/, ['business_name', 'website_url']],
  ['POST /sales/discovery/import', /action=["']\/sales\/discovery\/import["']/, []],
  ['POST /sales/discovery/maps/preview', /action=["']\/sales\/discovery\/maps\/preview["']/, []],
  ['POST /sales/discovery/maps/import', /action=["']\/sales\/discovery\/maps\/import["']/, []],
];
for (const [label, actionRe, fields] of postActions) {
  const fieldsOk = fields.every((field) => new RegExp(`name=["']${field}["']`).test(pageSrc));
  ok(`${label} form action retained`, actionRe.test(pageSrc), 'missing form action in page source');
  if (fields.length) {
    ok(
      `${label} field names retained`,
      fieldsOk,
      fields.filter((f) => !new RegExp(`name=["']${f}["']`).test(pageSrc)).join(', '),
    );
  }
}

console.log('\n▸ Preserved safety claims (must not be deleted)');
ok(
  'CRM safety claims retained',
  /preview only/i.test(pageSrc) && /no CRM (?:record has been sent|writes)/i.test(pageSrc),
);
ok(
  'Outreach safety claims retained',
  /draft only/i.test(pageSrc) && /no message has been sent/i.test(pageSrc),
);
ok(
  'Discovery safety claims retained',
  /(sample|dry-run)/i.test(pageSrc) && /no live Maps|No live Maps|no external discovery/i.test(pageSrc),
);

console.log('\n▸ Package / umbrella / docs registration');
let pkg = null;
try {
  pkg = JSON.parse(read(PKG_PATH) || '');
} catch {
  pkg = null;
}
ok('scripts/verify-crowsnest-sales-ux.js exists', fs.existsSync(VERIFY_PATH));
ok(
  'package.json has verify:crowsnest-sales-ux',
  pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-sales-ux'] === 'string',
);
ok(
  'umbrella verify-crowsnest registers sales-ux script',
  /verify:crowsnest-sales-ux/.test(umbrellaSrc),
);
ok('Clear Deck Sales UX doc exists', fs.existsSync(DOC_PATH));
ok(
  'UX doc names north-star / Clear Deck contract',
  /Clear Deck|Sales cockpit|north.?star|mode=add|Polished Hull|sales-cockpit-grid/i.test(uxDoc),
);
ok(
  'product doc mentions Clear Deck Sales UX',
  /Clear Deck|Sales UX|Sales cockpit/i.test(productDoc),
);

console.log(`\n── verify:crowsnest-sales-ux: ${pass} passed, ${fail} failed ──`);
if (fail === 0) {
  console.log('verify:crowsnest-sales-ux — ALL CHECKS PASSED');
  process.exit(0);
}
console.error('verify:crowsnest-sales-ux — FAILED (Slice A–E presentation contracts)');
process.exit(1);
