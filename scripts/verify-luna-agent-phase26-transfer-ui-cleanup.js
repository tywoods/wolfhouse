/**
 * Phase 26f.1 — Verifier for compact Flight / Transfer Details UI cleanup.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-transfer-ui-cleanup
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUTES = path.join(__dirname, 'lib', 'staff-booking-transfers-routes.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26f-1-TRANSFER-UI-CLEANUP.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-transfer-ui-cleanup';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
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

function transferUiSlice(apiSrc) {
  const m = apiSrc.match(/Phase 26c\/26f\/26f\.1[\s\S]{0,12000}/);
  return m ? m[0] : '';
}

console.log('\nverify-luna-agent-phase26-transfer-ui-cleanup.js  (Phase 26f.1)\n');

try {
  execSync(`node --check "${ROUTES}"`, { stdio: 'pipe' });
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'routes + staff-query-api pass node --check');
} catch {
  fail('0', 'syntax check failed');
}

const routesSrc = readOrEmpty(ROUTES);
const apiSrc = readOrEmpty(API);
const uiSlice = transferUiSlice(apiSrc);
const lookupHandler = (routesSrc.match(/async function handlePostBookingTransferLookupFlight[\s\S]*?(?=async function dispatchBookingTransferLookupRoute)/) || [''])[0];
const postHandler = (routesSrc.match(/async function handlePostBookingTransfer[\s\S]*?(?=async function handlePostBookingTransferLookupFlight)/) || [''])[0];

section('A. Removed UI fields');

const removedPatterns = [
  ['A1', 'Status dropdown', /prefix \+ '-status'|bc-transfer-.*-status|bcTransferStatusOptions/],
  ['A2', 'Guest count field', /prefix \+ '-guest-count'|bc-transfer-.*-guest-count/],
  ['A3', 'Lookup date field', /prefix \+ '-lookup-date'|bc-transfer-.*-lookup-date/],
  ['A4', 'Pickup location field', /prefix \+ '-pickup'|Pickup location/],
  ['A5', 'Dropoff location field', /prefix \+ '-dropoff'|Dropoff location/],
];
for (const [id, label, re] of removedPatterns) {
  if (!re.test(uiSlice)) pass(id, `UI no longer contains ${label}`);
  else fail(id, `${label} still in transfer UI slice`);
}

section('B. Compact UI retained');

if (/bc-transfer-cards/.test(apiSrc) && /bcRenderTransferCard\('arrival'/.test(apiSrc) && /bcRenderTransferCard\('departure'/.test(apiSrc)) {
  pass('B1', 'arrival/departure cards exist');
} else fail('B1', 'cards missing');
if (/bc-transfer-grid/.test(apiSrc)) pass('B2', 'compact grid layout CSS');
else fail('B2', 'grid CSS missing');
if (/default_airport_code|'\s*SDR\s*'/.test(uiSlice)) pass('B3', 'empty form defaults airport to SDR');
else fail('B3', 'SDR default missing');
for (const [id, field] of [['B4', 'flight'], ['B5', 'scheduled'], ['B6', 'notes']]) {
  if (new RegExp(`prefix \\+ '-${field}'`).test(uiSlice)) pass(id, `${field} field present`);
  else fail(id, `${field} field missing`);
}
if (/Lookup flight/.test(uiSlice) && /bc-transfer-lookup/.test(uiSlice)) pass('B7', 'Lookup flight button');
else fail('B7', 'lookup button missing');
if (/bc-transfer-save/.test(uiSlice)) pass('B8', 'Save buttons present');
else fail('B8', 'save buttons missing');
if (/bcTransferPricingHtml/.test(uiSlice)) pass('B9', 'pricing summary compact');
else fail('B9', 'pricing missing');

section('C. UI lookup request');

if (/bcLookupFlight/.test(uiSlice) && !/lookup_date:/.test(uiSlice)) {
  pass('C1', 'lookup POST omits lookup_date from UI body');
} else fail('C1', 'UI still sends lookup_date');
if (/flight_number:\s*flight/.test(uiSlice) && /airport_code:\s*airport/.test(uiSlice)) {
  pass('C2', 'lookup sends flight_number, direction, airport_code');
} else fail('C2', 'lookup payload incomplete');
if (/bcTransferUpdateLookupButtonState/.test(uiSlice) && !/lookupDate/.test(uiSlice.replace(/lookupMeta/g, ''))) {
  pass('C3', 'lookup button enabled on flight number only');
} else fail('C3', 'lookup button still requires lookup date');
if (/bcTransferApplyLookupPatch/.test(uiSlice) && !/lookupEl/.test(uiSlice)) {
  pass('C4', 'autofill does not set lookup_date field');
} else fail('C4', 'autofill still sets lookup date input');
if (/review and Save when ready/.test(apiSrc.match(/function bcLookupFlight[\s\S]{0,2000}/)?.[0] || '')) {
  pass('C5', 'lookup does not autosave');
} else fail('C5', 'save-after-lookup messaging missing');

section('D. Backend lookup defaults + retry');

if (/lookupAviationstackFlightWithDateRetry/.test(routesSrc)) pass('D1', 'date retry helper exists');
else fail('D1', 'date retry missing');
if (/defaultTransferLookupDate/.test(lookupHandler) && /body\.lookup_date/.test(lookupHandler)) {
  pass('D2', 'lookup_date optional; defaults from booking');
} else fail('D2', 'booking date default missing');
if (/addDaysToDateOnly\(lookupDate,\s*-1\)/.test(routesSrc)) pass('D3', 'retries one day before on flight_not_found');
else fail('D3', 'one-day retry missing');
if (/lookupFailureMessage/.test(routesSrc) && /case 'flight_not_found'/.test(routesSrc)) {
  pass('D4', 'flight_not_found returns safe message via lookupFailureMessage');
} else fail('D4', 'safe error message missing');
if (!/upsertBookingTransfer/.test(lookupHandler)) pass('D5', 'lookup route still no DB write');
else fail('D5', 'lookup writes DB');

section('E. Backend save behavior');

if (/inferTransferStatusFromInput/.test(routesSrc)) pass('E1', 'status inferred from visible fields');
else fail('E1', 'status inference missing');
if (/pickup_location:\s*null/.test(postHandler) && /dropoff_location:\s*null/.test(postHandler)) {
  pass('E2', 'pickup/dropoff cleared from staff UI path');
} else fail('E2', 'pickup/dropoff not cleared');
if (/booking\.guest_count/.test(postHandler)) pass('E3', 'guest_count from booking on save');
else fail('E3', 'guest_count from booking missing');
if (/sanitizeFlightLookupSummaryForStorage/.test(postHandler)) pass('E4', 'save sanitizes flight_lookup_summary');
else fail('E4', 'summary sanitize missing');
if (!/INSERT INTO payments|payment_intent/.test(postHandler)) pass('E5', 'no payment writes on save');
else fail('E5', 'payment writes');

section('F. Layout + safety');

if (/bc-drawer-tab-overview/.test(apiSrc) && /ctx-move-bed/.test(apiSrc)
  && /bc-drawer-tab-services/.test(apiSrc) && /bcRenderServicesTabHtml/.test(apiSrc)) {
  pass('F1', 'drawer tabs: Move bed in Overview, Services in Services tab (26f.2)');
} else fail('F1', 'drawer tab placement');
if (!routesSrc.match(/\bstripe\b/i) && !routesSrc.includes('guest_message_sends')) {
  pass('F2', 'routes have no Stripe/WhatsApp writes');
} else fail('F2', 'Stripe/WhatsApp in routes');

for (const f of GUEST_UNTOUCHED) {
  const base = path.basename(f);
  const src = readOrEmpty(f);
  if (!/26f\.1|transfer-ui-cleanup|bc-transfer-grid/.test(src)) pass(`F.${base}`, `${base} unchanged`);
  else fail(`F.${base}`, `${base} touched`);
}

section('G. Docs + npm');

const doc = readOrEmpty(DOC);
if (/SDR|Santander/.test(doc) && /check-in|check-out/i.test(doc)) pass('G1', 'doc describes defaults + booking dates');
else fail('G1', 'doc defaults/dates');
if (/no visible status|implicit/i.test(doc)) pass('G2', 'doc implicit status');
else fail('G2', 'doc status');
if (/one day before|retry/i.test(doc)) pass('G3', 'doc lookup retry');
else fail('G3', 'doc retry');

const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('G4', 'npm script registered');
else fail('G4', 'npm script missing');

section('H. Unit — date retry + status inference');

(async function runAsync() {
  const {
    addDaysToDateOnly,
    inferTransferStatusFromInput,
    FLIGHT_NOT_FOUND_MESSAGE,
  } = require('./lib/staff-booking-transfers-routes');

  if (addDaysToDateOnly('2029-10-01', -1) === '2029-09-30') pass('H1', 'addDaysToDateOnly works');
  else fail('H1', 'addDaysToDateOnly');

  if (inferTransferStatusFromInput({ flight_number: 'IB1' }, null) === 'requested') pass('H2', 'content → requested');
  else fail('H2', 'requested inference');
  if (inferTransferStatusFromInput({}, null) === 'not_needed') pass('H3', 'empty → not_needed');
  else fail('H3', 'not_needed inference');
  if (inferTransferStatusFromInput({ flight_number: 'X' }, 'confirmed') === 'confirmed') pass('H4', 'preserves confirmed');
  else fail('H4', 'confirmed preserve');
  if (FLIGHT_NOT_FOUND_MESSAGE.includes('Enter the flight details manually')) pass('H5', 'safe manual message constant');
  else fail('H5', 'message constant');
  if (/addDaysToDateOnly\(lookupDate,\s*-1\)/.test(routesSrc)) pass('H6', 'lookup retries one day before in routes');
  else fail('H6', 'retry wiring');

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
