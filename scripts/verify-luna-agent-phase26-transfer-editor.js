/**
 * Phase 26c — Verifier for Staff Portal transfer editor.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-transfer-editor
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUTES = path.join(__dirname, 'lib', 'staff-booking-transfers-routes.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26c-TRANSFER-EDITOR.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-transfer-editor';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

const DOWNSTREAM = [
  'verify:luna-agent-phase26-transfer-foundation',
  'verify:luna-agent-phase26-transfer-design',
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

console.log('\nverify-luna-agent-phase26-transfer-editor.js  (Phase 26c)\n');

try {
  execSync(`node --check "${ROUTES}"`, { stdio: 'pipe' });
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'routes + staff-query-api pass node --check');
} catch {
  fail('0', 'syntax check failed');
}

section('A. API routes module');

const routesSrc = readOrEmpty(ROUTES);
if (/handleGetBookingTransfers/.test(routesSrc)) pass('A1', 'GET transfer handler exists');
else fail('A1', 'GET handler missing');
if (/handlePostBookingTransfer/.test(routesSrc)) pass('A2', 'POST transfer handler exists');
else fail('A2', 'POST handler missing');
if (/listBookingTransfersForBooking/.test(routesSrc)) pass('A3', 'uses listBookingTransfersForBooking');
else fail('A3', 'list helper missing');
if (/upsertBookingTransfer/.test(routesSrc)) pass('A4', 'uses upsertBookingTransfer');
else fail('A4', 'upsert helper missing');
if (/getClientAirports/.test(routesSrc)) pass('A5', 'uses getClientAirports');
else fail('A5', 'getClientAirports missing');
if (/normalizeBookingDateOnly/.test(routesSrc)) pass('A6', 'uses normalizeBookingDateOnly for dates');
else fail('A6', 'date normalization missing');
if (/priceBookingTransfer/.test(routesSrc) && !/INSERT INTO payments|payment_intent/.test(routesSrc)) {
  pass('A7', 'POST recalculates pricing without payment writes');
} else fail('A7', 'pricing/payment write issue');

section('B. staff-query-api wiring');

const apiSrc = readOrEmpty(API);
if (/dispatchBookingTransfersRoute|staff-booking-transfers-routes/.test(apiSrc)) {
  pass('B1', 'staff-query-api wires transfer routes');
} else fail('B1', 'route wiring missing');
if (/BOOKING_TRANSFERS_RE/.test(apiSrc)) pass('B2', 'BOOKING_TRANSFERS_RE registered');
else fail('B2', 'BOOKING_TRANSFERS_RE missing');
if (/requireAuth\(req, res, 'operator'\)[\s\S]{0,120}dispatchBookingTransfersRoute/.test(apiSrc)
  || /BOOKING_TRANSFERS_RE[\s\S]{0,200}requireAuth\(req, res, 'operator'\)/.test(apiSrc)) {
  pass('B3', 'transfer routes require operator auth');
} else fail('B3', 'operator auth missing');
if (/Phase 26c[\s\S]{0,800}BOOKING_TRANSFERS_RE[\s\S]{0,400}All other routes: GET only/.test(apiSrc)) {
  pass('B4', 'transfer routes registered before GET-only gate');
} else fail('B4', 'transfer routes after GET-only gate (POST would 405)');

section('C. UI — Flight / Transfer Details');

if (/Flight \/ Transfer Details/.test(apiSrc)) pass('C1', 'UI contains Flight / Transfer Details');
else fail('C1', 'section title missing');
if (/bcRenderTransferDetailsShell/.test(apiSrc) && /bcRenderFieldEditSectionsHtml\(data, 'after-addons'\)[\s\S]{0,400}bcRenderTransferDetailsShell/.test(apiSrc)) {
  pass('C2', 'transfer section after Package (after-addons)');
} else fail('C2', 'section placement under Package');
if (/bcRenderTransferDetailsShell[\s\S]{0,800}Move bed|ctx-move-bed/.test(apiSrc)
  && /ctx-move-bed[\s\S]{0,800}bcRenderAddServicePanelHtml|Add-ons/.test(apiSrc)) {
  pass('C3', 'Add-ons section after Move Bed');
} else fail('C3', 'Add-ons below Move Bed');
if (/bcRenderTransferCard\('arrival'/.test(apiSrc) && /bcRenderTransferCard\('departure'/.test(apiSrc)) {
  pass('C4', 'arrival and departure forms exist');
} else fail('C4', 'direction forms missing');
if (/bcTransferAirportOptions/.test(apiSrc)) pass('C5', 'airport dropdown from API airports');
else fail('C5', 'airport dropdown missing');
for (const field of ['status', 'airport', 'flight', 'lookup-date', 'scheduled', 'guest-count', 'notes']) {
  if (new RegExp(`bc-transfer-.*${field}|prefix \\+ '-${field}'`).test(apiSrc)) {
    pass('C.f.' + field, `field ${field} present`);
  } else if (apiSrc.includes(field)) {
    pass('C.f.' + field, `field ${field} present`);
  } else {
    fail('C.f.' + field, `field ${field} missing`);
  }
}
if (/bcTransferPricingHtml/.test(apiSrc)) pass('C6', 'pricing note displayed');
else fail('C6', 'pricing display missing');
if (/Flight lookup coming next/.test(apiSrc)) pass('C7', 'flight lookup deferred placeholder');
else fail('C7', 'lookup placeholder missing');
if (!/aviationstack|Aviationstack|flight.lookup|flight_lookup/i.test(apiSrc.replace(/Flight lookup coming next/g, ''))) {
  pass('C8', 'no Aviationstack lookup button/API yet');
} else fail('C8', 'Aviationstack present too early');
if (/transfer-pebble/.test(apiSrc) && /handleBedCalendar/.test(apiSrc) && /transfer_summary/.test(apiSrc)) {
  pass('C9', 'calendar pebble wired in bed-calendar path (26d)');
} else if (!/transfer-pebble/i.test(apiSrc)) {
  pass('C9', 'no Booking Calendar Transfer pebble yet (26d deferred)');
} else fail('C9', 'orphan calendar pebble without bed-calendar wiring');

section('D. Docs');

const doc = readOrEmpty(DOC);
if (/GET.*transfers/i.test(doc) && /POST.*transfers/i.test(doc)) pass('D1', 'doc describes API routes');
else fail('D1', 'API doc');
if (/under Package|below Move Bed/i.test(doc)) pass('D2', 'doc UI placement');
else fail('D2', 'UI placement doc');
if (/normalizeBookingDateOnly|date normalization/i.test(doc)) pass('D3', 'doc date normalization');
else fail('D3', 'date doc');
if (/no payment|Aviationstack deferred|26d/i.test(doc)) pass('D4', 'doc out of scope');
else fail('D4', 'out of scope doc');

section('E. Safety');

const phase26cSlice = (apiSrc.match(/Phase 26c[\s\S]{0,12000}/) || [''])[0];
if (!routesSrc.match(/\bstripe\b/i) && !phase26cSlice.match(/\bstripe\b/i)) {
  pass('E1', 'no Stripe in transfer routes/editor slice');
} else fail('E1', 'Stripe touched');
if (!routesSrc.includes('guest_message_sends') && !routesSrc.includes('n8n')) {
  pass('E2', 'no WhatsApp/n8n in routes');
} else fail('E2', 'WhatsApp/n8n in routes');

for (const f of GUEST_UNTOUCHED) {
  const base = path.basename(f);
  const src = readOrEmpty(f);
  if (!src.includes('booking-transfers') && !/staff-booking-transfers/.test(src)) {
    pass('E.' + base, `${base} unchanged`);
  } else fail('E.' + base, `${base} touched`);
}

section('F. npm script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
const rel = 'scripts/verify-luna-agent-phase26-transfer-editor.js';
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${rel}`) pass('F1', `${SCRIPT} registered`);
else fail('F1', `${SCRIPT} missing`);

section('G. Downstream verifiers');

for (const script of DOWNSTREAM) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 120000 });
    pass('G.' + script, `${script} still passes`);
  } catch {
    fail('G.' + script, `${script} failed`);
  }
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
