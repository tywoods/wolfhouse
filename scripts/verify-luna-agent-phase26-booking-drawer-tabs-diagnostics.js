/**
 * Phase 26f.2 — Verifier for booking drawer tabs + flight lookup diagnostics.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-booking-drawer-tabs-diagnostics
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUTES = path.join(__dirname, 'lib', 'staff-booking-transfers-routes.js');
const PROVIDER = path.join(__dirname, 'lib', 'aviationstack-flight-lookup.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26f-2-BOOKING-DRAWER-TABS-DIAGNOSTICS.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-booking-drawer-tabs-diagnostics';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

const DOWNSTREAM = [
  'verify:luna-agent-phase26-transfer-ui-cleanup',
  'verify:luna-agent-phase26-flight-lookup-editor',
  'verify:luna-agent-phase26-transfer-editor',
  'verify:luna-agent-phase26-transfer-calendar-pebble',
  'verify:luna-agent-phase26-aviationstack-provider',
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

console.log('\nverify-luna-agent-phase26-booking-drawer-tabs-diagnostics.js  (Phase 26f.2)\n');

try {
  execSync(`node --check "${ROUTES}"`, { stdio: 'pipe' });
  execSync(`node --check "${PROVIDER}"`, { stdio: 'pipe' });
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'routes + provider + staff-query-api pass node --check');
} catch {
  fail('0', 'syntax check failed');
}

const routesSrc = readOrEmpty(ROUTES);
const providerSrc = readOrEmpty(PROVIDER);
const apiSrc = readOrEmpty(API);
const drawerSlice = (apiSrc.match(/function renderBookingContextDrawer[\s\S]{0,9000}/) || [''])[0];

section('A. Drawer tabs');

for (const [id, label] of [['A1', 'Overview'], ['A2', 'Services'], ['A3', 'Transfers'], ['A4', 'Payments']]) {
  if (new RegExp(`bcDrawerTabBtn\\('${label.toLowerCase()}', '${label}'`).test(apiSrc)
    || drawerSlice.includes(`'${label.toLowerCase()}', '${label}'`)) {
    pass(id, `${label} tab present`);
  } else fail(id, `${label} tab missing`);
}
if (/bcInitDrawerTabs/.test(apiSrc) && /bc-drawer-tab-panel/.test(apiSrc)) {
  pass('A5', 'in-place tab switching wired');
} else fail('A5', 'tab init missing');
if (/bc-drawer-tab-overview[\s\S]{0,200}is-active/.test(drawerSlice) || /Overview', true/.test(apiSrc)) {
  pass('A6', 'Overview default active');
} else fail('A6', 'default tab');

section('B. Tab content placement');

if (/bcRenderPaymentSummaryBriefHtml/.test(apiSrc) && /bc-drawer-tab-overview/.test(drawerSlice)) {
  pass('B1', 'Overview brief payment summary');
} else fail('B1', 'overview payment summary');
if (/ctx-move-bed/.test(drawerSlice) && /bc-drawer-tab-overview/.test(drawerSlice)) {
  pass('B2', 'Move bed in Overview');
} else fail('B2', 'move bed placement');
if (/Conversation \/ Handoff/.test(drawerSlice) && /bc-drawer-tab-overview/.test(drawerSlice)) {
  pass('B3', 'Conversation/Handoff in Overview');
} else fail('B3', 'conversation placement');
if (/bcRenderRunningInvoiceHtml/.test(drawerSlice) && /bc-drawer-tab-payments/.test(drawerSlice)) {
  pass('B4', 'full Payment section in Payments tab');
} else fail('B4', 'payments tab content');
if (/bc-drawer-tab-transfers[\s\S]{0,500}bcRenderTransferDetailsShell/.test(drawerSlice)) {
  pass('B5', 'Flight / Transfer Details in Transfers tab');
} else fail('B5', 'transfers tab content');
if (/bcRenderServicesTabHtml/.test(apiSrc) && /bc-add-ons-btn/.test(apiSrc)) {
  pass('B6', 'Services tab retains add/remove service controls');
} else fail('B6', 'services controls');
if (/bc-add-ons-title">Services/.test(apiSrc) && !/bc-add-ons-title">Add-ons/.test(apiSrc)) {
  pass('B7', 'visible Add-ons label replaced by Services in drawer');
} else fail('B7', 'services label');
if (/Package services|Service schedule|Unscheduled services/.test(apiSrc)) {
  pass('B8', 'Services tab placeholder groups');
} else fail('B8', 'services placeholders');

section('C. Lookup diagnostics — provider');

const {
  lookupAviationstackFlight,
  classifyAviationstackFailure,
} = require('./lib/aviationstack-flight-lookup');

if (/classifyAviationstackFailure/.test(providerSrc)) pass('C1', 'classifyAviationstackFailure exists');
else fail('C1', 'classifier missing');

const authCls = classifyAviationstackFailure(401, { error: { code: 'invalid_access_key' } });
if (authCls.error === 'aviationstack_auth_error') pass('C2', '401 → auth error');
else fail('C2', 'auth classification');

const quotaCls = classifyAviationstackFailure(403, { error: { message: 'subscription plan limit' } });
if (quotaCls.error === 'aviationstack_quota_or_plan_error') pass('C3', '403/quota → plan error');
else fail('C3', 'quota classification');

const rateCls = classifyAviationstackFailure(429, { error: { message: 'rate limit' } });
if (rateCls.error === 'aviationstack_rate_limited') pass('C4', '429 → rate limited');
else fail('C4', 'rate classification');

section('D. Lookup diagnostics — routes');

const lookupHandler = (routesSrc.match(/async function handlePostBookingTransferLookupFlight[\s\S]*?(?=async function dispatchBookingTransferLookupRoute)/) || [''])[0];
if (/lookup_dates_tried/.test(lookupHandler) && /diagnostic:/.test(lookupHandler)) {
  pass('D1', 'lookup route returns diagnostic + lookup_dates_tried');
} else fail('D1', 'diagnostic payload');
if (/lookupFailureMessage/.test(routesSrc) && /logSafeFlightLookupFailure/.test(routesSrc)) {
  pass('D2', 'safe messages + server logging');
} else fail('D2', 'messages/logging');
if (!/access_key|AVIATIONSTACK_API_KEY/.test(lookupHandler.replace(/secretRef/g, ''))) {
  pass('D3', 'lookup handler response path avoids key strings');
} else fail('D3', 'key leak risk in handler');

section('E. UI lookup messages');

if (/aviationstack_auth_error|aviationstack_quota_or_plan_error|airport_mismatch/.test(apiSrc)) {
  pass('E1', 'UI maps specific lookup error categories');
} else fail('E1', 'UI error map');
if (/res\.data\.message/.test(apiSrc) && /res\.data\.diagnostic/.test(apiSrc)) {
  pass('E2', 'UI prefers API message + diagnostic');
} else fail('E2', 'UI diagnostic wiring');
if (!/Flight lookup provider error/.test(apiSrc)) pass('E3', 'generic provider error string removed');
else fail('E3', 'generic provider error remains');

section('F. Docs + npm');

const doc = readOrEmpty(DOC);
if (/Overview|Services|Transfers|Payments/.test(doc)) pass('F1', 'doc describes tabs');
else fail('F1', 'doc tabs');
if (/lookup_dates_tried|diagnostic/.test(doc)) pass('F2', 'doc lookup diagnostics');
else fail('F2', 'doc diagnostics');
if (/no.*API key|no raw/i.test(doc)) pass('F3', 'doc safety');
else fail('F3', 'doc safety');

const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('F4', 'npm script registered');
else fail('F4', 'npm script');

section('G. Safety');

if (!routesSrc.match(/\bstripe\b/i) && !routesSrc.includes('guest_message_sends')) {
  pass('G1', 'routes no Stripe/WhatsApp writes');
} else fail('G1', 'Stripe/WhatsApp in routes');
if (!lookupHandler.includes('upsertBookingTransfer')) pass('G2', 'lookup still no DB write');
else fail('G2', 'lookup DB write');

for (const f of GUEST_UNTOUCHED) {
  const base = path.basename(f);
  const src = readOrEmpty(f);
  if (!/bc-drawer-tabs|lookupFailureMessage/.test(src)) pass(`G.${base}`, `${base} unchanged`);
  else fail(`G.${base}`, `${base} touched`);
}

section('H. Mocked lookup behaviors');

(async function runAsync() {
  const {
    lookupAviationstackFlightWithDateRetry,
    lookupFailureMessage,
    buildLookupDiagnostic,
  } = require('./lib/staff-booking-transfers-routes');

  const mismatch = await lookupAviationstackFlight({
    flight_number: 'FR1',
    flight_date: '2026-06-08',
    direction: 'arrival',
    airport_code: 'SDR',
    env: { AVIATIONSTACK_API_KEY: 'mock' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{
          flight_status: 'scheduled',
          flight: { iata: 'FR1' },
          airline: { name: 'Test' },
          departure: { iata: 'MAD', scheduled: '2026-06-08T10:00:00+00:00' },
          arrival: { iata: 'MAD', scheduled: '2026-06-08T12:00:00+00:00' },
        }],
      }),
    }),
  });
  if (mismatch.success === false && mismatch.error === 'airport_mismatch') {
    pass('H1', 'airport mismatch when flight airport differs');
  } else fail('H1', 'airport mismatch');

  const { lookup_dates_tried } = await lookupAviationstackFlightWithDateRetry({
    flight_number: 'XX1',
    direction: 'arrival',
    lookupDate: '2026-06-08',
    env: { AVIATIONSTACK_API_KEY: 'mock' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
  });
  if (Array.isArray(lookup_dates_tried) && lookup_dates_tried.length >= 2) {
    pass('H2', 'date retry lists lookup_dates_tried');
  } else fail('H2', 'lookup_dates_tried');

  const msg = lookupFailureMessage('flight_not_found', {
    flight_number: 'ANE1064',
    lookup_dates_tried: ['2026-06-08', '2026-06-07'],
  });
  if (/ANE1064/.test(msg) && /2026-06-08/.test(msg) && /2026-06-07/.test(msg)) {
    pass('H3', 'flight_not_found message lists dates tried');
  } else fail('H3', 'not-found message');

  const diag = buildLookupDiagnostic({
    flight_number: 'RYR7153',
    lookup_dates_tried: ['2026-06-08'],
    http_status: 403,
    provider_error_code: 'function_access_restricted',
  });
  if (diag.flight_number === 'RYR7153' && !JSON.stringify(diag).includes('mock-key')) {
    pass('H4', 'diagnostic safe shape');
  } else fail('H4', 'diagnostic shape');

  section('I. Downstream verifiers');

  for (const script of DOWNSTREAM) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 180000 });
      pass('I.' + script, `${script} still passes`);
    } catch {
      fail('I.' + script, `${script} failed`);
    }
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
