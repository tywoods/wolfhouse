/**
 * Phase 10.5d — Static verifier for dates Save → write API + UI wiring.
 *
 * Usage:
 *   npm run verify:staff-booking-date-save-ui
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');
const MIG_DIR  = path.join(__dirname, '..', 'database', 'migrations');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-booking-date-save-ui.js  (Phase 10.5d)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const datesHandlerMatch = src.match(
  /async function handleBookingEditWriteDates[\s\S]*?async function handleBookingEditWrite\(/
);
const datesHandlerBlock = datesHandlerMatch ? datesHandlerMatch[0] : '';

const availHelperMatch = src.match(
  /async function editWriteDatesEvaluateAvailability[\s\S]*?function editWriteDatesSnapshot/
);
const datesAvailBlock = availHelperMatch ? availHelperMatch[0] : '';

const writeHandlerMatch = src.match(
  /async function handleBookingEditWrite\(req[\s\S]*?async function handleQuotePreview/
);
const writeHandlerBlock = writeHandlerMatch ? writeHandlerMatch[0] : '';

const writeSlice = datesHandlerBlock + writeHandlerBlock;

const datesUpdateBooking = src.match(/const EDIT_WRITE_DATES_UPDATE_BOOKING_SQL = `([\s\S]*?)`;/);
const datesUpdateBeds = src.match(/const EDIT_WRITE_DATES_UPDATE_BEDS_SQL = `([\s\S]*?)`;/);
const datesBookingSql = datesUpdateBooking ? datesUpdateBooking[1] : '';
const datesBedsSql = datesUpdateBeds ? datesUpdateBeds[1] : '';

const writeUiBlock = src.match(/\/\* Phase 10\.5f-lite[\s\S]*?\/\* Phase 10\.4e/)?.[0] || '';
const datesSaveFn = (
  src.match(/function bcFieldEditBuildDatesWritePayload[\s\S]*?function bcFieldEditFormatDatesLine/)?.[0] || ''
) + (
  src.match(/function bcFieldEditRunDatesSave[\s\S]*?function bcFieldEditGuestsCountLowerThanCurrent/)?.[0] || ''
);
const actionsFn = src.match(/function bcRenderFieldEditActionsHtml[\s\S]*?\n\}/)?.[0] || '';
const previewFn = src.match(/function bcFieldEditRunPreview[\s\S]*?function bcFieldEditRestoreForms/)?.[0] || '';
const initFn = src.match(/function bcInitFieldEditShell[\s\S]*?function renderBookingContextDrawer/)?.[0] || '';

console.log('\nA. API — dates write supported');

check(/EDIT_WRITE_SUPPORTED_TYPES/.test(src) && /'dates'/.test(src),
  'EDIT_WRITE_SUPPORTED_TYPES includes dates');
check(/handleBookingEditWriteDates/.test(src), 'handleBookingEditWriteDates handler exists');
check(/if \(editType === 'dates'\)/.test(writeHandlerBlock),
  'main handler routes edit_type dates');
check(/editWriteDatesEvaluateAvailability/.test(src),
  'dates availability recheck helper exists');
check(/editWriteDatesEvaluateAvailability/.test(datesHandlerBlock),
  'dates handler calls availability recheck helper');
check(/editPreviewDatesBuildConflicts/.test(datesAvailBlock),
  'dates write uses editPreviewDatesBuildConflicts');
check(/MOVE_TARGETS_RANGE_ASSIGNMENTS_SQL/.test(datesAvailBlock),
  'dates write queries range assignments for overlap');
check(/movePreviewHalfOpenOverlaps/.test(src) || /editPreviewDatesBuildConflicts/.test(src),
  'half-open overlap logic used for date conflicts');

console.log('\nB. Conflict blocks mutation');

check(/can_apply:\s*false/.test(datesHandlerBlock),
  'blocked response includes can_apply:false');
check(/conflicts/.test(datesHandlerBlock), 'blocked response includes conflicts');
check(/No changes were made/.test(datesHandlerBlock),
  'conflict path documents no mutation');
check(/updated:\s*false/.test(datesHandlerBlock) && /would_mutate:\s*false/.test(datesHandlerBlock),
  'blocked path sets updated:false');

console.log('\nC. Booking + booking_beds updates');

check(/EDIT_WRITE_DATES_UPDATE_BOOKING_SQL/.test(src), 'dates booking UPDATE SQL present');
check(/check_in = \$3/.test(datesBookingSql) && /check_out = \$4/.test(datesBookingSql),
  'UPDATE sets check_in and check_out');
check(/EDIT_WRITE_DATES_UPDATE_BEDS_SQL/.test(src), 'dates booking_beds UPDATE SQL present');
check(/WHERE booking_beds\.id IN \(/.test(datesBedsSql),
  'beds UPDATE uses subquery (no invalid bb FROM alias)');
check(!/UPDATE booking_beds bb[\s\S]*?FROM clients c[\s\S]*?bb\.booking_id/.test(datesBedsSql),
  'beds UPDATE avoids invalid PostgreSQL bb FROM reference');
check(/assignment_start_date = \$3/.test(datesBedsSql) && /assignment_end_date = \$4/.test(datesBedsSql),
  'UPDATE sets bed assignment dates');
check(!/amount_paid_cents/.test(datesBookingSql.split(/RETURNING/i)[0] || datesBookingSql),
  'booking UPDATE SET does not touch amount_paid_cents');
check(!/UPDATE payments|INSERT INTO payments|DELETE FROM payments/i.test(writeSlice),
  'no payments table mutation in dates write slice');
check(!/UPDATE booking_service_records|INSERT INTO booking_service_records/i.test(writeSlice),
  'no booking_service_records mutation in dates write slice');

console.log('\nD. Idempotency + reprice + short-stay no-package');

check(/idempotent:\s*true/.test(datesHandlerBlock),
  'dates idempotent path present');
check(/editWriteDatesFieldsMatch/.test(src), 'dates match helper for idempotency');
check(/EDIT_WRITE_PACKAGE_MIN_NIGHTS/.test(src) && /editWriteStayRequiresPackageCode/.test(src),
  'package min nights helper for edit writes');
check(/editWriteResolveProposedAccommodation/.test(src),
  'shared proposed accommodation resolver for short stays');
check(/editWriteShortStayAccFromQuoteSnapshot/.test(src),
  'short stay can reprice from quote_snapshot without package');
check(/package_required_for_long_stay/.test(src),
  'long stay missing package returns package_required_for_long_stay');
check(/editWriteShouldBlockPricingWrite/.test(datesHandlerBlock),
  'dates write uses pricing block helper');
check(/dates_reprice_calculation_unavailable/.test(datesHandlerBlock),
  'blocks write when reprice truly unavailable');
check(/Stays of 6 nights or longer require a package/.test(datesHandlerBlock),
  'dates long-stay package message present');

console.log('\nE. UI — Dates Save → write');

check(/function bcFieldEditRunDatesSave/.test(src), 'dates save runner exists');
check(/fetch\('\/staff\/bookings\/edit'/.test(datesSaveFn),
  'dates Save calls POST /staff/bookings/edit');
check(/edit_type:\s*'dates'/.test(datesSaveFn), 'dates write payload edit_type dates');
check(/check_in:/.test(datesSaveFn) && /check_out:/.test(datesSaveFn),
  'dates payload includes check_in and check_out');
check(/idempotency_key:/.test(datesSaveFn), 'dates write sends idempotency_key');
check(/data-bc-field-dates-save/.test(actionsFn), 'dates Save uses dedicated dates-save button');
check(/id="bc-field-save-dates"/.test(actionsFn), 'dates Save button id present');
check(/bcFieldEditUpdateDatesSaveState/.test(src), 'dates save enablement helper exists');
check(/btn\.disabled = !valid \|\| !changed/.test(src),
  'dates Save disabled when invalid or unchanged');
check(/loadBlockDetail\(code\)/.test(datesSaveFn), 'successful dates save reloads drawer');
check(/loadBedCalendar/.test(datesSaveFn), 'successful dates save refreshes bed calendar');
check(/function pickCalendarGuestDisplayName/.test(src) && /function bcBlockLabel/.test(src),
  '10.6h.1: calendar reload uses shared guest-first label helper');
check(/pickCalendarGuestDisplayName\(blk\)/.test(src.match(/function bcCalendarBlockDisplayLabel[\s\S]*?\n\}/)?.[0] || ''),
  '10.6h.1: client calendar label delegates to pick helper');
check(!/codeShort/.test(src.match(/function bcBlockLabel[\s\S]*?\n\}/)?.[0] || ''),
  '10.6h.1: date-save calendar path does not use booking-code-first short labels');
check(/toLowerCase\(\) === code\.toLowerCase\(\)/.test(src.match(/function pickCalendarGuestDisplayName[\s\S]*?\n\}/)?.[0] || ''),
  '10.6h.1: booking_code stored as guest_name does not win over bed guest name');

console.log('\nF. All field groups wired; contact/package/dates preserved');

check(/function bcFieldEditRunContactSave/.test(src), 'contact save still exists');
check(/function bcFieldEditRunPackageSave/.test(src), 'package save still exists');
check(/function bcFieldEditRunGuestsSave/.test(src), 'guests save exists (10.5e)');
check(!/data-bc-field-preview="dates"|data-bc-field-preview="contact"|data-bc-field-preview="package"|data-bc-field-preview="guests"/.test(actionsFn),
  'contact/package/dates/guests use dedicated Save buttons');
check(/data-bc-field-guests-save/.test(actionsFn), 'guests uses guests-save Save button');
check(!/edit_type:\s*'guests'/.test(datesSaveFn), 'dates UI write has no guests edit_type');

console.log('\nG. Safety');

check(!/api\.stripe\.com/.test(datesSaveFn + datesHandlerBlock),
  'no Stripe API in dates save slice');
check(!/graph\.facebook\.com/.test(datesSaveFn + datesHandlerBlock),
  'no WhatsApp in dates save slice');
check(!/n8n\.cloud|activate.*workflow/i.test(datesSaveFn + datesHandlerBlock),
  'no n8n activation in dates save slice');

console.log('\nH. No docs / migration / deploy');

if (fs.existsSync(MIG_DIR)) {
  const migHit = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /handleBookingEditWriteDates|EDIT_WRITE_DATES/i.test(body);
  });
  check(!migHit, 'no migration references dates edit write');
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

console.log('\nI. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-booking-date-save-ui'] ===
      'node scripts/verify-staff-booking-date-save-ui.js',
    'package.json has verify:staff-booking-date-save-ui script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
