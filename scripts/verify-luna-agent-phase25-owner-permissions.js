/**
 * Phase 25j — Verifier for Owner Insights permission gate.
 *
 * Usage:
 *   npm run verify:luna-agent-phase25-owner-permissions
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const PORTAL = path.join(__dirname, 'lib', 'staff-portal-clients.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-25j-OWNER-INSIGHTS-PERMISSIONS.md');
const PKG = path.join(ROOT, 'package.json');

const DOWNSTREAM = [
  'verify:luna-agent-phase25-command-center-ui',
  'verify:luna-agent-phase25-owner-command-center-answer',
  'verify:luna-agent-phase25-owner-plan-execute',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase25-owner-permissions.js  (Phase 25j)\n');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api.js passes node --check');
} catch {
  fail('0', 'staff-query-api syntax check failed');
}

try {
  execSync(`node --check "${PORTAL}"`, { stdio: 'pipe' });
  pass('0b', 'staff-portal-clients.js passes node --check');
} catch {
  fail('0b', 'staff-portal-clients syntax check failed');
}

const apiSrc = readOrEmpty(API);
const portalSrc = readOrEmpty(PORTAL);
const pkg = JSON.parse(readOrEmpty(PKG) || '{}');

const { canUseOwnerInsights, resolveStaffRole } = require('./lib/staff-portal-clients');

section('A. canUseOwnerInsights helper');

if (portalSrc.includes('function canUseOwnerInsights') && portalSrc.includes("role === 'owner' || role === 'admin'")) {
  pass('A1', 'helper exported with owner/admin check');
} else fail('A1', 'canUseOwnerInsights missing or incomplete');

if (canUseOwnerInsights({ email: 'o@test.com', role: 'owner' })) {
  pass('A2', 'allows owner role');
} else fail('A2', 'owner should be allowed');

if (canUseOwnerInsights({ email: 'a@test.com', role: 'admin' })) {
  pass('A3', 'allows admin role');
} else fail('A3', 'admin should be allowed');

if (!canUseOwnerInsights({ email: 'op@test.com', role: 'operator' })) {
  pass('A4', 'blocks operator role');
} else fail('A4', 'operator must be blocked');

if (!canUseOwnerInsights({ email: 'v@test.com', role: 'viewer' })) {
  pass('A5', 'blocks viewer role');
} else fail('A5', 'viewer must be blocked');

if (!canUseOwnerInsights(null)) {
  pass('A6', 'blocks null user');
} else fail('A6', 'null user must be blocked');

section('B. API gate — plan + plan-and-execute');

if (apiSrc.includes('async function requireOwnerInsightsAuth') && apiSrc.includes('owner_insights_forbidden')) {
  pass('B1', 'requireOwnerInsightsAuth returns owner_insights_forbidden');
} else fail('B1', 'API auth helper missing');

const planRouter = apiSrc.slice(
  apiSrc.indexOf("if (pathname === '/staff/owner/sql/plan')"),
  apiSrc.indexOf("if (pathname === '/staff/owner/sql/plan')") + 450,
);
if (/requireOwnerInsightsAuth\(req, res\)/.test(planRouter)) {
  pass('B2', '/staff/owner/sql/plan uses owner insights auth');
} else fail('B2', 'plan route auth not gated');

const peRouter = apiSrc.slice(
  apiSrc.indexOf("if (pathname === '/staff/owner/sql/plan-and-execute')"),
  apiSrc.indexOf("if (pathname === '/staff/owner/sql/plan-and-execute')") + 500,
);
if (/requireOwnerInsightsAuth\(req, res\)/.test(peRouter)) {
  pass('B3', '/staff/owner/sql/plan-and-execute uses owner insights auth');
} else fail('B3', 'plan-and-execute route auth not gated');

const validateRouter = apiSrc.slice(
  apiSrc.indexOf("if (pathname === '/staff/owner/sql/validate')"),
  apiSrc.indexOf("if (pathname === '/staff/owner/sql/execute')") + 400,
);
if (/requireAuth\(req, res, 'operator'\)/.test(validateRouter)) {
  pass('B4', 'validate/execute routes still operator+ (unchanged)');
} else fail('B4', 'validate/execute auth changed unexpectedly');

if (apiSrc.includes('can_use_owner_insights') && apiSrc.includes('canUseOwnerInsights(user)')) {
  pass('B5', '/staff/auth/session exposes can_use_owner_insights');
} else fail('B5', 'session endpoint missing owner insights flag');

section('C. UI gate — Command Center');

const ccStart = apiSrc.indexOf('<!-- ── Command Center tab');
const ccEnd = apiSrc.indexOf('</div><!-- /tab-ask-luna -->', ccStart);
const ccPanel = ccStart >= 0 && ccEnd > ccStart ? apiSrc.slice(ccStart, ccEnd) : '';

const jsStart = apiSrc.indexOf('COMMAND CENTER TAB — Operations');
const jsEnd = apiSrc.indexOf('QUERY TOOLS TAB — existing staff query interface', jsStart);
const ccJs = jsStart >= 0 && jsEnd > jsStart ? apiSrc.slice(jsStart, jsEnd) : '';

if (ccPanel.includes('cc-owner-insights-denied') && ccPanel.includes('Owner Insights requires owner access')) {
  pass('C1', 'denied message for non-owner sessions');
} else fail('C1', 'UI denied message missing');

if (ccPanel.includes('id="cc-owner-insights-active"') && ccPanel.includes('id="oi-btn"')) {
  pass('C2', 'Owner Insights form wrapped for gating');
} else fail('C2', 'Owner Insights active wrapper missing');

if (apiSrc.includes('function applyOwnerInsightsGate') && apiSrc.includes('function canUseOwnerInsightsPortal')) {
  pass('C3', 'UI applies owner insights gate from session');
} else fail('C3', 'UI gate functions missing');

if (apiSrc.includes('applyOwnerInsightsGate()') && apiSrc.includes('function initStaffPortalSession')) {
  pass('C4', 'gate runs after session init');
} else fail('C4', 'gate not wired to session init');

if (ccJs.includes("fetch('/staff/ask-luna'") && ccPanel.includes('cc-section-hdr">Operations</div>')) {
  pass('C5', 'Operations still available (not owner-gated in UI)');
} else fail('C5', 'Operations panel missing');

if (!ccPanel.includes('TODO(owner-role)') && !ccPanel.includes('Visible to operator+ in staging')) {
  pass('C6', 'staging operator+ TODO removed');
} else fail('C6', 'old operator+ TODO still present');

if (ccJs.includes('owner_insights_forbidden')) {
  pass('C7', 'UI handles 403 owner_insights_forbidden safely');
} else fail('C7', '403 handling missing in oiAsk');

section('D. Role inventory + WhatsApp unchanged');

if (apiSrc.includes("ROLE_RANK = { viewer: 1, operator: 2, admin: 3, owner: 4 }")) {
  pass('D1', 'ROLE_RANK includes owner (rank 4)');
} else fail('D1', 'ROLE_RANK owner missing');

const ownerWa = readOrEmpty(path.join(__dirname, 'lib', 'luna-owner-whatsapp-inbound.js'));
if (ownerWa && ownerWa.includes('planAndExecuteOwnerSqlQuestion') && !ownerWa.includes('canUseOwnerInsights')) {
  pass('D2', 'owner WhatsApp path unchanged (uses phone allowlist, not portal gate)');
} else fail('D2', 'owner WhatsApp module touched unexpectedly');

const phoneAccess = readOrEmpty(path.join(__dirname, 'lib', 'staff-phone-access.js'));
if (phoneAccess && phoneAccess.includes('owner') && !portalSrc.includes('staff_phone_access')) {
  pass('D3', 'staff_phone_access separate from portal session auth');
} else if (!phoneAccess) {
  pass('D3', 'staff-phone-access module not found (skip)');
} else fail('D3', 'portal auth incorrectly tied to staff_phone_access');

section('E. Safety + guest flow');

const guestDraft = readOrEmpty(path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'));
if (guestDraft && !guestDraft.includes('canUseOwnerInsights') && !guestDraft.includes('owner_insights_forbidden')) {
  pass('E1', 'guest reply draft untouched');
} else fail('E1', 'guest draft touched');

if (!apiSrc.includes('graph.facebook') || !ccJs.includes('graph.facebook')) {
  if (!ccJs.includes('/staff/bot/guest-reply-send') && !ccJs.includes('stripe.com')) {
    pass('E2', 'no WhatsApp/Stripe send routes added to Command Center JS');
  } else fail('E2', 'forbidden send route in UI');
} else fail('E2', 'Meta references in UI');

if (!portalSrc.includes('n8n') && !apiSrc.slice(apiSrc.indexOf('requireOwnerInsightsAuth'), apiSrc.indexOf('requireOwnerInsightsAuth') + 800).includes('n8n')) {
  pass('E3', 'no n8n in permission gate');
} else fail('E3', 'n8n referenced in gate');

section('F. Docs + npm script');

if (fs.existsSync(DOC)) pass('F1', 'PHASE-25j doc exists');
else fail('F1', 'doc missing');

if (pkg.scripts && pkg.scripts['verify:luna-agent-phase25-owner-permissions']) {
  pass('F2', 'npm script registered');
} else fail('F2', 'npm script missing');

section('G. Downstream listed (not run)');
for (const s of DOWNSTREAM) {
  if (pkg.scripts && pkg.scripts[s]) pass('G', `downstream registered: ${s}`);
  else fail('G', `missing downstream: ${s}`);
}

void resolveStaffRole;

console.log('\n' + '─'.repeat(60));
if (failures === 0) {
  console.log(`PASS  (${passes} checks)\n`);
  process.exit(0);
}
console.log(`FAIL  (${passes} passed, ${failures} failed)\n`);
process.exit(1);
