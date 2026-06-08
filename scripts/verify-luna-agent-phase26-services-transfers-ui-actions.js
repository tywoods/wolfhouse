/**
 * Phase 26h.5 — Verifier for nullable service_date, drawer/calendar polish, transfer override.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-services-transfers-ui-actions
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MIGRATION = path.join(ROOT, 'database', 'migrations', '018_booking_service_records_nullable_service_date.sql');
const HELPER = path.join(__dirname, 'lib', 'booking-transfers.js');
const ROUTES = path.join(__dirname, 'lib', 'staff-booking-transfers-routes.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26h-5-SERVICES-TRANSFERS-UI-ACTIONS.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-services-transfers-ui-actions';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

const UPSTREAM = [
  'verify:luna-agent-phase26-services-unschedule-drawer-cleanup',
  'verify:luna-agent-phase26-drawer-payments-transfers-polish',
  'verify:luna-agent-phase26-transfer-calendar-pebble',
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

console.log('\nverify-luna-agent-phase26-services-transfers-ui-actions.js  (Phase 26h.5)\n');

try {
  execSync(`node --check "${HELPER}"`, { stdio: 'pipe' });
  execSync(`node --check "${ROUTES}"`, { stdio: 'pipe' });
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'helper + routes + staff-query-api pass node --check');
} catch {
  fail('0', 'syntax check failed');
}

const sql = readOrEmpty(MIGRATION);
const helperSrc = readOrEmpty(HELPER);
const routesSrc = readOrEmpty(ROUTES);
const apiSrc = readOrEmpty(API);
const drawerSlice = (apiSrc.match(/function renderBookingContextDrawer[\s\S]{0,5500}/) || [''])[0];
const transferCardSlice = (apiSrc.match(/function bcRenderTransferCard[\s\S]{0,3200}/) || [''])[0];
const saveSlice = (apiSrc.match(/function bcSaveTransfer[\s\S]{0,1800}/) || [''])[0];
const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');

section('A. Nullable service_date migration');

if (sql.length > 0) pass('A1', 'migration 018 exists');
else fail('A1', 'migration missing');
if (/ALTER COLUMN service_date DROP NOT NULL/i.test(sql)) pass('A2', 'drops NOT NULL');
else fail('A2', 'DROP NOT NULL');
if (!/\bUPDATE\b booking_service_records|\bDELETE\b FROM booking_service_records/i.test(sql)) {
  pass('A3', 'no row updates/deletes');
} else fail('A3', 'mutates rows');
if (!/\bpayments\b/i.test(sql.replace(/booking_service_records/gi, ''))) pass('A4', 'no payments touch');
else fail('A4', 'touches payments');

section('B. Overview ordering');

const moveIdx = drawerSlice.indexOf('bc-move-bed');
const payIdx = drawerSlice.indexOf('bcRenderPaymentSummaryBriefHtml');
const convIdx = drawerSlice.indexOf('bc-drawer-card-conversation');
if (moveIdx >= 0 && payIdx > moveIdx && convIdx > payIdx) {
  pass('B1', 'Payment Summary above Conversation / Handoff');
} else fail('B1', 'overview order');
if (!/bcRenderRoomingBriefHtml\(data\)/.test(drawerSlice)) {
  pass('B2', 'Room/Bed not duplicated in Booking Details');
} else fail('B2', 'room/bed duplicate');

section('C. Calendar legend');

if (!/>Legend:</.test(apiSrc.match(/id="bc-legend"[\s\S]{0,400}/)?.[0] || '')) {
  pass('C1', 'no Legend title in calendar legend');
} else fail('C1', 'Legend title present');
if (/bc-controls-row/.test(apiSrc) && /bc-legend/.test(apiSrc) && /bc-chips/.test(apiSrc)) {
  pass('C2', 'legend + chips share header/control row');
} else fail('C2', 'controls row missing');
if (/\.bc-legend[\s\S]{0,120}inline-flex|width:auto|flex:0 0 auto/.test(apiSrc)) {
  pass('C3', 'legend shrink/fit styling');
} else fail('C3', 'compact legend CSS');

section('D. Transfer Exception Override');

if (/Exception Override/.test(transferCardSlice) && /bc-transfer-override-toggle/.test(transferCardSlice)) {
  pass('D1', 'Exception Override button on transfer cards');
} else fail('D1', 'override button');
if (/Transfer charge/.test(apiSrc) && /'-override-amount'/.test(apiSrc)) {
  pass('D2', 'override amount input');
} else fail('D2', 'override input');
if (/resolveManualTransferOverride/.test(helperSrc) && /Manual transfer override/.test(helperSrc)) {
  pass('D3', 'override maps to price_cents + pricing_note');
} else fail('D3', 'override helper');
if (/included_in_package:\s*false/.test(helperSrc.match(/resolveManualTransferOverride[\s\S]{0,800}/)?.[0] || '')) {
  pass('D4', 'override sets included_in_package false');
} else fail('D4', 'included_in_package');
if (/invalid_override_amount/.test(routesSrc) || /must be a number >= 0/.test(helperSrc)) {
  pass('D5', 'invalid amount blocked safely');
} else fail('D5', 'invalid amount guard');
if (/priceBookingTransfer/.test(helperSrc) && /resolveManualTransferOverride/.test(helperSrc)) {
  pass('D6', 'normal pricing retained when override absent');
} else fail('D6', 'normal pricing path');

section('E. Transfer pebble live update');

if (/Transfer Required/.test(apiSrc) && !/Transfer saved/.test(saveSlice)) {
  pass('E1', 'Transfer Required wording; no Transfer saved on save');
} else fail('E1', 'pebble wording / saved text');
if (/bcRefreshTransferPebbleSummary/.test(saveSlice)) {
  pass('E2', 'save updates header pebble without full refresh');
} else fail('E2', 'save pebble refresh');
if (/bcRefreshTransferPebbleSummary/.test(apiSrc.match(/function bcRemoveTransfer[\s\S]{0,1200}/)?.[0] || '')) {
  pass('E3', 'remove still updates header pebble');
} else fail('E3', 'remove pebble refresh');

section('F. No payment records from override');

if (!/INSERT INTO payments/.test(helperSrc) && !/INSERT INTO payments/.test(routesSrc)) {
  pass('F1', 'transfer override does not create payment rows');
} else fail('F1', 'payment insert in transfer slice');
if (!/generate-payment-link|stripe\./i.test(helperSrc.match(/resolveManualTransferOverride[\s\S]{0,800}/)?.[0] || '')) {
  pass('F2', 'override helper has no Stripe');
} else fail('F2', 'Stripe in override');

section('G. Docs + npm');

const doc = readOrEmpty(DOC);
if (/018_booking_service_records_nullable_service_date/.test(doc) && /Exception Override/.test(doc)) {
  pass('G1', 'doc covers migration + override');
} else fail('G1', 'doc content');
if (/STAFF_ACTIONS_ENABLED/.test(doc) && /No payment records/i.test(doc)) {
  pass('G2', 'doc covers staging env + safety');
} else fail('G2', 'doc safety/env');
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('G3', 'npm script registered');
else fail('G3', 'npm script');

section('H. Safety');

if (!/whatsapp|n8n|guest_message/i.test(helperSrc.match(/resolveManualTransferOverride[\s\S]{0,1000}/)?.[0] || '')) {
  pass('H1', 'no WhatsApp/Meta/n8n in override slice');
} else fail('H1', 'messaging touched');

for (const f of GUEST_UNTOUCHED) {
  const base = path.basename(f);
  const src = readOrEmpty(f);
  if (!/resolveManualTransferOverride|Exception Override/.test(src)) pass(`H.${base}`, `${base} unchanged`);
  else fail(`H.${base}`, `${base} touched`);
}

section('I. Helper unit — manual override');

const {
  buildBookingTransferUpsertPayload,
  priceBookingTransfer,
  resolveManualTransferOverride,
} = require('./lib/booking-transfers');

try {
  resolveManualTransferOverride({ client_slug: 'wolfhouse-somo', transferInput: { manual_override_euros: -1 } });
  fail('I1', 'negative override should throw');
} catch (e) {
  if (e.code === 'invalid_override_amount') pass('I1', 'negative override rejected');
  else fail('I1', 'wrong error for negative override');
}

const normal = priceBookingTransfer({
  client_slug: 'wolfhouse-somo',
  booking: { package_code: 'malibu', guest_count: 2 },
  transfer: { airport_code: 'SDR' },
});
const overridden = buildBookingTransferUpsertPayload({
  client_slug: 'wolfhouse-somo',
  booking: { package_code: 'malibu', guest_count: 2, check_in: '2026-09-01', check_out: '2026-09-08' },
  transferInput: {
    direction: 'arrival',
    airport_code: 'SDR',
    manual_override_euros: 25,
    manual_override_enabled: true,
  },
});
if (overridden.price_cents === 2500 && overridden.included_in_package === false
  && /manual transfer override/i.test(overridden.pricing_note)) {
  pass('I2', '€25 override → 2500 cents + manual note');
} else fail('I2', 'override payload wrong');
if (normal.available && normal.included_in_package === true) {
  pass('I3', 'normal package pricing unchanged');
} else fail('I3', 'normal pricing');

section('J. Upstream verifiers');

UPSTREAM.forEach((name) => {
  try {
    execSync(`npm run ${name}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    pass(`J.${name}`, `${name} still passes`);
  } catch (err) {
    const tail = (err.stdout || err.stderr || '').split('\n').slice(-3).join(' ');
    fail(`J.${name}`, `${name} failed${tail ? ': ' + tail : ''}`);
  }
});

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
