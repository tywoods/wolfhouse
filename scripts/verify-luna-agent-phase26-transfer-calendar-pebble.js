/**
 * Phase 26d — Verifier for Booking Calendar transfer pebble.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-transfer-calendar-pebble
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(__dirname, 'lib', 'booking-transfers.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26d-TRANSFER-CALENDAR-PEBBLE.md');
const EDITOR_VERIFIER = path.join(__dirname, 'verify-luna-agent-phase26-transfer-editor.js');
const FOUNDATION_VERIFIER = path.join(__dirname, 'verify-luna-agent-phase26-transfer-foundation.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-transfer-calendar-pebble';

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

console.log('\nverify-luna-agent-phase26-transfer-calendar-pebble.js  (Phase 26d)\n');

try {
  execSync(`node --check "${HELPER}"`, { stdio: 'pipe' });
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'helper + staff-query-api pass node --check');
} catch {
  fail('0', 'syntax check failed');
}

section('A. Calendar transfer range loading');

const helperSrc = readOrEmpty(HELPER);
const apiSrc = readOrEmpty(API);

if (/listBookingTransfersForCalendarRange/.test(helperSrc)) {
  pass('A1', 'listBookingTransfersForCalendarRange helper exists');
} else fail('A1', 'calendar range helper missing');

if (/buildTransferSummariesByBookingId/.test(helperSrc)) {
  pass('A2', 'buildTransferSummariesByBookingId helper exists');
} else fail('A2', 'summary builder missing');

if (/ACTIVE_TRANSFER_PEBBLE_STATUSES/.test(helperSrc)
  && /requested/.test(helperSrc)
  && /confirmed/.test(helperSrc)) {
  pass('A3', 'active pebble statuses requested/confirmed');
} else fail('A3', 'active status set missing');

if (/listBookingTransfersForCalendarRange/.test(apiSrc)
  && /buildTransferSummariesByBookingId/.test(apiSrc)
  && /handleBedCalendar/.test(apiSrc)) {
  pass('A4', 'bed-calendar handler loads transfers in one range call');
} else fail('A4', 'bed-calendar transfer loading missing');

if (/transfer_summary/.test(apiSrc)) {
  pass('A5', 'transfer_summary attached to calendar blocks');
} else fail('A5', 'transfer_summary not attached');

if (!/\/staff\/bookings\/[^'"]+\/transfers[\s\S]{0,200}loadBedCalendar/.test(apiSrc)
  && !/loadBedCalendar[\s\S]{0,400}\/transfers/.test(apiSrc)) {
  pass('A6', 'calendar load does not N+1 per-booking transfer fetch');
} else fail('A6', 'possible N+1 transfer fetch on calendar load');

section('B. Active vs inactive transfer summary');

const {
  buildTransferSummaryFromRows,
  emptyTransferSummary,
} = require('./lib/booking-transfers');

const activeSummary = buildTransferSummaryFromRows([
  { direction: 'arrival', status: 'requested', airport_code: 'SDR' },
  { direction: 'departure', status: 'confirmed', airport_code: 'SDR' },
]);
if (activeSummary.has_transfer && activeSummary.transfer_count === 2) {
  pass('B1', 'requested/confirmed produce has_transfer true');
} else fail('B1', 'active summary wrong');

const cancelledSummary = buildTransferSummaryFromRows([
  { direction: 'arrival', status: 'cancelled', airport_code: 'SDR' },
]);
if (!cancelledSummary.has_transfer) {
  pass('B2', 'cancelled does not produce pebble');
} else fail('B2', 'cancelled should not show pebble');

const notNeededSummary = buildTransferSummaryFromRows([
  { direction: 'departure', status: 'not_needed', airport_code: 'BIO' },
]);
if (!notNeededSummary.has_transfer) {
  pass('B3', 'not_needed does not produce pebble');
} else fail('B3', 'not_needed should not show pebble');

if (emptyTransferSummary().has_transfer === false) {
  pass('B4', 'emptyTransferSummary defaults has_transfer false');
} else fail('B4', 'empty summary wrong');

section('C. UI pebble + drawer');

if (/transfer-pebble/.test(apiSrc) && />Transfer</.test(apiSrc)) {
  pass('C1', 'Transfer pebble text in UI');
} else fail('C1', 'Transfer pebble text missing');

if (/\.transfer-pebble[\s\S]{0,200}#EDE7F6|#5E35B1/.test(apiSrc)) {
  pass('C2', 'light-purple transfer-pebble CSS');
} else fail('C2', 'light-purple styling missing');

if (/bcTransferPebbleHtml|bcCalendarBlockInnerHtml/.test(apiSrc)
  && /bc-block/.test(apiSrc)
  && /transfer_summary/.test(apiSrc)) {
  pass('C3', 'pebble attached to booking blocks via block inner HTML');
} else fail('C3', 'pebble not on booking blocks');

if (/bcFormatTransferSummaryLabel|bcDetailHeaderMetaHtml/.test(apiSrc)
  && /Flight \/ Transfer Details|bcRenderTransferDetailsShell/.test(apiSrc)) {
  pass('C4', 'drawer header summary + transfer details section');
} else fail('C4', 'drawer transfer UI missing');

section('D. Docs + npm script');

const doc = readOrEmpty(DOC);
if (doc.includes('listBookingTransfersForCalendarRange')) pass('D1', 'doc describes range loading');
else fail('D1', 'doc range loading');
if (/requested|confirmed/.test(doc) && /cancelled|not_needed/.test(doc)) {
  pass('D2', 'doc describes active/inactive statuses');
} else fail('D2', 'doc statuses');
if (/transfer-pebble|Transfer pebble/i.test(doc)) pass('D3', 'doc describes pebble');
else fail('D3', 'doc pebble');
if (/No payment|No Stripe|Aviationstack deferred/i.test(doc)) pass('D4', 'doc safety + deferred scope');
else fail('D4', 'doc safety');

const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('D5', 'npm script registered');
else fail('D5', 'npm script missing');

section('E. Safety — no Stripe/payment/WhatsApp/guest AI/Aviationstack');

if (!apiSrc.match(/handleBedCalendar[\s\S]{0,2500}INSERT INTO payments/i)) {
  pass('E1', 'bed-calendar handler has no payment writes');
} else fail('E1', 'payment writes in bed-calendar');
const bedCalSlice = (apiSrc.match(/async function handleBedCalendar[\s\S]{0,5000}/) || [''])[0];
if (!/aviationstack/i.test(bedCalSlice) && !/aviationstack/i.test(helperSrc)) {
  pass('E2', 'no Aviationstack in phase26d slice');
} else fail('E2', 'Aviationstack touched');
if (!/INSERT INTO payments|payment_intent|stripe\./i.test(helperSrc.slice(helperSrc.indexOf('buildTransferSummariesByBookingId')))) {
  pass('E3', 'new helpers have no payment/Stripe writes');
} else fail('E3', 'payment/Stripe in new helpers');

let guestOk = true;
for (const p of GUEST_UNTOUCHED) {
  const stat = fs.existsSync(p) ? fs.statSync(p) : null;
  if (stat && stat.mtimeMs > Date.now() - 60000) guestOk = false;
}
if (guestOk) pass('E4', 'guest AI intake files not modified in this slice');
else fail('E4', 'guest AI files touched');

section('F. Downstream verifiers still present');

if (fs.existsSync(EDITOR_VERIFIER)) pass('F1', 'transfer editor verifier exists');
else fail('F1', 'editor verifier missing');
if (fs.existsSync(FOUNDATION_VERIFIER)) pass('F2', 'transfer foundation verifier exists');
else fail('F2', 'foundation verifier missing');

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
