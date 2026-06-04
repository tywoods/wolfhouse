/**
 * Phase 10.5f — Static verifier for cancel reservation UI + API + calendar hide.
 *
 * Usage:
 *   npm run verify:staff-booking-cancel-ui
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');
const MIG_DIR  = path.join(__dirname, '..', 'database', 'migrations');
const CAL_QUERIES = path.join(__dirname, 'lib', 'staff-bed-calendar-queries.js');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-booking-cancel-ui.js  (Phase 10.5f / 10.5f.1)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');
const calSrc = fs.existsSync(CAL_QUERIES) ? fs.readFileSync(CAL_QUERIES, 'utf8') : '';

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const cancelHandlerMatch = src.match(
  /async function handleBookingCancel[\s\S]*?async function handleBookingAddService/
);
const cancelHandlerBlock = cancelHandlerMatch ? cancelHandlerMatch[0] : '';
const cancelSqlBlock = (
  src.match(/const BOOKING_CANCEL_[\s\S]*?async function handleBookingCancel/)?.[0] || ''
) + cancelHandlerBlock;

const cancelUiBlock =
  (src.match(/function bcInitBookingCancelShell[\s\S]*?function bcInitFieldEditShell/)?.[0] || '') +
  (src.match(/function bcRunCancelReservation[\s\S]*?function bcInitBookingCancelShell/)?.[0] || '') +
  (src.match(/function bcRenderCancelConfirmPanel[\s\S]*?function bcRunCancelReservation/)?.[0] || '');

function extractRenderBookingContextDrawer(source) {
  const start = source.indexOf('function renderBookingContextDrawer(data){');
  if (start < 0) return '';
  const end = source.indexOf('\n/* ── Tour Operator forms', start);
  return end > start ? source.slice(start, end) : '';
}
const renderDrawerBlock = extractRenderBookingContextDrawer(src);
const cancelFooterBlock = src.match(
  /function bcRenderBookingCancelFooterHtml[\s\S]*?function bcRenderCancelConfirmPanel/
)?.[0] || '';

const buildBlocksBlock = src.match(/function buildCalendarBlocks[\s\S]*?async function handleBedCalendar/)?.[0] || '';

console.log('\nA. UI — Cancel reservation button + danger-light');

check(/btn-danger-light/.test(src), 'btn-danger-light style class exists');
check(/bcRenderBookingCancelFooterHtml/.test(src), 'bcRenderBookingCancelFooterHtml helper exists');
check(/Cancel reservation/.test(cancelFooterBlock), 'footer includes Cancel reservation label');
check(/id="bc-cancel-reservation-btn"/.test(cancelFooterBlock),
  'cancel button id bc-cancel-reservation-btn in footer');
check(/bcBookingStatusIsCancelled/.test(cancelFooterBlock),
  'cancel footer hidden when booking already cancelled');
check(/btn-danger-light/.test(cancelFooterBlock),
  'cancel button uses danger-light style');
check(/ctx-booking-cancel-footer/.test(cancelFooterBlock),
  'cancel section uses drawer footer class');

console.log('\nA2. Drawer bottom placement');

const drawerIdx = renderDrawerBlock.indexOf('function renderBookingContextDrawer');
const fieldEditIdx = renderDrawerBlock.indexOf('bcRenderFieldEditSectionsHtml');
const cancelFooterCallIdx = renderDrawerBlock.indexOf('bcRenderBookingCancelFooterHtml');
const convIdx = renderDrawerBlock.indexOf('Conversation / Handoff');
check(cancelFooterCallIdx > fieldEditIdx && cancelFooterCallIdx > convIdx,
  'cancel footer rendered after field edits and conversation');
check(!/ctx-planned/.test(renderDrawerBlock),
  '10.6a.4: stale planned-ops block removed from drawer');
check(!/Planned operations/.test(renderDrawerBlock),
  '10.6a.4: Planned operations copy removed');
check(!/bcRenderFieldEditSectionsHtml[\s\S]{0,800}bc-cancel-reservation-btn/.test(renderDrawerBlock),
  'cancel button not immediately under field edit sections');
check(!/id="bc-cancel-confirm-host"/.test(src),
  'no top-level bc-cancel-confirm-host outside drawer body');

console.log('\nB. Confirmation UI (inline below button)');

check(/Cancel reservation\?/.test(cancelUiBlock), 'confirmation title Cancel reservation?');
check(/bc-cancel-confirm-inline/.test(cancelFooterBlock + cancelUiBlock),
  'inline confirm host below cancel button');
check(/id="bc-cancel-reservation-btn"[\s\S]*?id="bc-cancel-confirm-inline"/.test(cancelFooterBlock),
  'confirm host immediately after cancel button in footer HTML');
check(/bc-cancel-confirm-inline/.test(cancelUiBlock) && /el\('bc-cancel-confirm-inline'\)/.test(cancelUiBlock),
  'confirm panel renders into bc-cancel-confirm-inline');
check(/bc-cancel-confirm/.test(cancelUiBlock), 'confirmation panel present');
check(/Confirm cancellation/.test(cancelUiBlock), 'Confirm cancellation button');
check(/Back \/ Keep reservation/.test(cancelUiBlock), 'Back / Keep reservation button');
check(/release assigned beds/.test(cancelUiBlock) && /No refund or Stripe/.test(cancelUiBlock),
  'warning mentions beds released and no Stripe/refund');
check(/booking_code|Booking:/.test(cancelUiBlock) && /Guest:/.test(cancelUiBlock) && /Dates:/.test(cancelUiBlock),
  'confirmation shows booking code, guest, dates');

console.log('\nC. API — POST /staff/bookings/cancel');

check(/async function handleBookingCancel/.test(src), 'handleBookingCancel handler exists');
check(/pathname === '\/staff\/bookings\/cancel'/.test(src), 'route POST /staff/bookings/cancel registered');
check(/requireAuth\(req, res, 'operator'\)/.test(
  src.slice(src.indexOf("pathname === '/staff/bookings/cancel'"), src.indexOf("pathname === '/staff/bookings/cancel'") + 400)
), 'cancel route requires operator auth');
check(/client_slug/.test(cancelHandlerBlock) && /idempotency_key/.test(cancelHandlerBlock),
  'cancel body accepts client_slug and idempotency_key');
check(/Cancelled from Staff Portal/.test(cancelHandlerBlock), 'default reason Cancelled from Staff Portal');

console.log('\nD. Cancel behavior — status + beds + idempotency');

check(/status = 'cancelled'::booking_status/.test(cancelSqlBlock),
  'booking status set to cancelled');
check(/DELETE FROM booking_beds/.test(cancelSqlBlock),
  'booking_beds release via DELETE');
check(/c\.slug = \$1/.test(cancelSqlBlock) && /b\.id::text = \$2/.test(cancelSqlBlock),
  'bed DELETE scoped by client slug and booking id');
check(/idempotent:\s*true/.test(cancelHandlerBlock) && /cancelled:\s*false/.test(cancelHandlerBlock),
  'already-cancelled returns success idempotent cancelled:false');
check(/bookingStatusIsCancelled/.test(cancelHandlerBlock),
  'terminal status check before mutation');
check(/beds_released_count/.test(cancelHandlerBlock), 'response includes beds_released_count');
check(/before/.test(cancelHandlerBlock) && /after/.test(cancelHandlerBlock),
  'response includes before/after snapshots');

console.log('\nE. Calendar — cancelled hidden from blocks');

check(/b\.status NOT IN \('cancelled', 'expired'\)/.test(calSrc),
  'bed calendar SQL excludes cancelled/expired');
check(/bookingStatusIsCancelled/.test(buildBlocksBlock),
  'buildCalendarBlocks filters cancelled booking_status');
check(/loadBedCalendar/.test(cancelUiBlock),
  'successful cancel reloads bed calendar');

console.log('\nF. Legend — Cancelled removed');

check(!/bc-legend-sw-cancelled"><\/span>Cancelled/.test(src),
  'legend no longer shows Cancelled item');
check(!/<span class="bc-legend-item">[\s\S]*?Cancelled<\/span>/.test(
  src.match(/id="bc-legend"[\s\S]*?<\/div>/)?.[0] || ''
), 'bc-legend block has no Cancelled entry');

console.log('\nG. Post-cancel UI reload');

check(/loadBlockDetail\(code\)/.test(cancelUiBlock), 'successful cancel reloads drawer');
check(/function bcRenderCancelResult/.test(src), 'cancel result message helper');

console.log('\nH. Safety — no payment/service/Stripe/n8n/WhatsApp');

check(!/amount_paid_cents/.test(
  (cancelSqlBlock.match(/BOOKING_CANCEL_UPDATE_STATUS_SQL[\s\S]*?`;/))?.[0] || cancelSqlBlock
), 'cancel booking UPDATE does not touch amount_paid_cents');
check(!/UPDATE payments|INSERT INTO payments|DELETE FROM payments/i.test(cancelHandlerBlock),
  'no payments table mutation in cancel handler');
check(!/UPDATE booking_service_records|INSERT INTO booking_service_records|DELETE FROM booking_service_records/i.test(cancelHandlerBlock),
  'no booking_service_records mutation in cancel handler');
check(!/api\.stripe\.com|stripe\.com\/v1/i.test(cancelHandlerBlock + cancelUiBlock),
  'no Stripe API in cancel slice');
check(!/graph\.facebook\.com/i.test(cancelHandlerBlock + cancelUiBlock),
  'no WhatsApp in cancel slice');
check(!/n8n\.cloud|activate.*workflow/i.test(cancelHandlerBlock + cancelUiBlock),
  'no n8n activation in cancel slice');
check(!/refund/i.test(cancelHandlerBlock) || /No refund/.test(cancelHandlerBlock),
  'cancel handler does not perform refund (message may mention no refund)');

console.log('\nI. No docs / migration / deploy');

if (fs.existsSync(MIG_DIR)) {
  const migHit = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /handleBookingCancel|BOOKING_CANCEL_/i.test(body);
  });
  check(!migHit, 'no migration references booking cancel');
} else {
  ok('migrations directory not present (skip)');
}

try {
  const docOut = execSync('git diff --name-only HEAD -- docs/', {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
  check(!docOut, 'no docs changes in working tree');
} catch (_) {
  ok('no docs changes in working tree (skip git diff)');
}

check(!/deploy-staff|az containerapp/i.test(cancelHandlerBlock + cancelUiBlock),
  'no deploy scripts in cancel slice');

console.log('\nJ. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-booking-cancel-ui'] ===
      'node scripts/verify-staff-booking-cancel-ui.js',
    'package.json has verify:staff-booking-cancel-ui script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
