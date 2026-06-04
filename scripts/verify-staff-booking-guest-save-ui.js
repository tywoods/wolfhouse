/**
 * Phase 10.5e — Static verifier for guests Save → write API + UI wiring.
 *
 * Usage:
 *   npm run verify:staff-booking-guest-save-ui
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

console.log('\nverify-staff-booking-guest-save-ui.js  (Phase 10.5e)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const guestsHandlerMatch = src.match(
  /async function handleBookingEditWriteGuests[\s\S]*?async function handleBookingEditWrite\(/
);
const guestsHandlerBlock = guestsHandlerMatch ? guestsHandlerMatch[0] : '';

const releaseHelperMatch = src.match(
  /function editPreviewGuestBedRelease[\s\S]*?async function editWriteDatesEvaluateAvailability/
);
const releaseHelperBlock = releaseHelperMatch ? releaseHelperMatch[0] : '';

const writeHandlerMatch = src.match(
  /async function handleBookingEditWrite\(req[\s\S]*?async function handleQuotePreview/
);
const writeHandlerBlock = writeHandlerMatch ? writeHandlerMatch[0] : '';

const writeSlice = guestsHandlerBlock + writeHandlerBlock;

const guestsUpdateBooking = src.match(/const EDIT_WRITE_GUESTS_UPDATE_BOOKING_SQL = `([\s\S]*?)`;/);
const guestsDeleteBeds = src.match(/const EDIT_WRITE_GUESTS_DELETE_BEDS_SQL = `([\s\S]*?)`;/);
const guestsBookingSql = guestsUpdateBooking ? guestsUpdateBooking[1] : '';
const guestsDeleteSql = guestsDeleteBeds ? guestsDeleteBeds[1] : '';

const guestsSaveFn = src.match(/function bcFieldEditBuildGuestsWritePayload[\s\S]*?\/\* Phase 10\.4e/)?.[0] || '';
const actionsFn = src.match(/function bcRenderFieldEditActionsHtml[\s\S]*?\n\}/)?.[0] || '';
const renderField = src.match(/function bcRenderFieldEditSectionsHtml[\s\S]*?function bcFieldEditBuildPreviewPayload/)?.[0] || '';

console.log('\nA. API — guests write supported');

check(/EDIT_WRITE_SUPPORTED_TYPES/.test(src) && /'guests'/.test(src),
  'EDIT_WRITE_SUPPORTED_TYPES includes guests');
check(/handleBookingEditWriteGuests/.test(src), 'handleBookingEditWriteGuests handler exists');
check(/if \(editType === 'guests'\)/.test(writeHandlerBlock),
  'main handler routes edit_type guests');
check(/guest_count is required/.test(guestsHandlerBlock),
  'guest_count validation present');
check(/guest_increase_not_supported/.test(guestsHandlerBlock),
  'guest increase blocked in write handler');
check(/guest_count must be at least 1/.test(guestsHandlerBlock),
  'guest_count minimum enforced');

console.log('\nB. Release last N assignments');

check(/editPreviewGuestBedRelease/.test(guestsHandlerBlock),
  'write handler uses editPreviewGuestBedRelease');
check(/\.slice\(-nRelease\)/.test(releaseHelperBlock),
  'release helper takes last N assignment rows');
check(/release_booking_bed_ids/.test(guestsHandlerBlock),
  'release_booking_bed_ids used for bed delete');
check(/requires_manual_review/.test(guestsHandlerBlock),
  'insufficient rows returns requires_manual_review without mutation');
check(/No changes were made/.test(guestsHandlerBlock),
  'blocked path documents no mutation');

console.log('\nC. Idempotent no-change path');

check(/idempotent:\s*true/.test(guestsHandlerBlock),
  'idempotent path when guest_count unchanged');
check(/updated:\s*false/.test(guestsHandlerBlock) && /!release\.changed/.test(guestsHandlerBlock),
  'zero release_count uses idempotent response');

console.log('\nD. Booking + booking_beds updates');

check(/EDIT_WRITE_GUESTS_UPDATE_BOOKING_SQL/.test(src), 'guests booking UPDATE SQL present');
check(/guest_count = \$3/.test(guestsBookingSql), 'UPDATE sets guest_count');
check(/EDIT_WRITE_GUESTS_DELETE_BEDS_SQL/.test(src), 'guests bed DELETE SQL present');
check(/DELETE FROM booking_beds/.test(guestsDeleteSql),
  'DELETE only selected booking_beds rows');
check(/bb\.id = ANY\(\$3::uuid\[\]\)/.test(guestsDeleteSql),
  'DELETE scoped to explicit booking_bed ids');
check(!/amount_paid_cents/.test(guestsBookingSql.split(/RETURNING/i)[0] || guestsBookingSql),
  'booking UPDATE SET does not touch amount_paid_cents');
check(!/UPDATE payments|INSERT INTO payments|DELETE FROM payments/i.test(writeSlice),
  'no payments table mutation in guests write slice');
check(!/UPDATE booking_service_records|INSERT INTO booking_service_records/i.test(writeSlice),
  'no booking_service_records mutation in guests write slice');

console.log('\nE. Invoice / refund review + short-stay no-package');

check(/editPreviewBuildInvoicePreview/.test(guestsHandlerBlock),
  'guest write recalculates invoice preview');
check(/editWriteStayRequiresPackageCode/.test(src),
  'guest write uses package min nights helper');
check(/editWriteScaleAccommodationCents/.test(src),
  'guest write can scale accommodation for short no-package stays');
check(/package_required_for_long_stay/.test(guestsHandlerBlock),
  'guest write handles package_required_for_long_stay');
check(/editWriteShouldBlockPricingWrite/.test(guestsHandlerBlock),
  'guest write uses pricing block helper');
check(!/guests_reprice_calculation_unavailable[\s\S]*?package_code is required/.test(guestsHandlerBlock),
  'guest write does not hard-code package_code is required blocker');
check(/needs_refund/.test(guestsHandlerBlock),
  'response includes needs_refund when applicable');
check(/refund_review_needed/.test(guestsHandlerBlock),
  'response includes refund_review_needed when applicable');
check(!/api\.stripe\.com/.test(guestsHandlerBlock),
  'no Stripe API in guests write handler');

console.log('\nF. UI — Guests Save → write');

check(/function bcFieldEditRunGuestsSave/.test(src), 'guests save runner exists');
check(/fetch\('\/staff\/bookings\/edit'/.test(guestsSaveFn),
  'guests Save calls POST /staff/bookings/edit');
check(/edit_type:\s*'guests'/.test(guestsSaveFn), 'guests write payload edit_type guests');
check(/guest_count:/.test(guestsSaveFn), 'guests payload includes guest_count');
check(/data-bc-field-guests-save/.test(actionsFn), 'guests Save uses dedicated guests-save button');
check(/bcFieldEditUpdateGuestsSaveState/.test(src), 'guests save enablement helper exists');
check(/bcFieldEditGuestsCountLowerThanCurrent/.test(src),
  'Save enabled only when count lower than current');
check(/loadBlockDetail\(code\)/.test(guestsSaveFn), 'successful guests save reloads drawer');
check(/loadBedCalendar/.test(guestsSaveFn), 'successful guests save refreshes bed calendar');

console.log('\nG. No guest increase UI');

check(/for \(var g = guestCount; g >= 1; g--\)/.test(renderField),
  'guest dropdown only decreases from current count');
check(!/g <= guestCount \+ 1|guestCount \+ 1/.test(renderField),
  'no guest increase option in dropdown');
check(/increases are not supported/i.test(guestsSaveFn + src),
  'UI blocks save when count not lower than current');

console.log('\nH. Contact/package/dates preserved');

check(/function bcFieldEditRunContactSave/.test(src), 'contact save still exists');
check(/function bcFieldEditRunPackageSave/.test(src), 'package save still exists');
check(/function bcFieldEditRunDatesSave/.test(src), 'dates save still exists');

console.log('\nI. Safety');

check(!/graph\.facebook\.com/.test(guestsSaveFn + guestsHandlerBlock),
  'no WhatsApp in guests save slice');
check(!/n8n\.cloud|activate.*workflow/i.test(guestsSaveFn + guestsHandlerBlock),
  'no n8n activation in guests save slice');

console.log('\nJ. No docs / migration / deploy');

if (fs.existsSync(MIG_DIR)) {
  const migHit = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /handleBookingEditWriteGuests|EDIT_WRITE_GUESTS/i.test(body);
  });
  check(!migHit, 'no migration references guests edit write');
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

console.log('\nK. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-booking-guest-save-ui'] ===
      'node scripts/verify-staff-booking-guest-save-ui.js',
    'package.json has verify:staff-booking-guest-save-ui script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
