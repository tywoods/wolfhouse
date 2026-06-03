/**
 * Phase 10.1 — Static verifier for manual booking create UX polish.
 *
 * Usage:
 *   npm run verify:staff-manual-booking-polish
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)  { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg){ console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-manual-booking-polish.js  (Phase 10.1)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');
check(src.length > 10000, 'staff-query-api.js readable');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const createFn = src.match(/function runManualBookingCreate[\s\S]*?\n\}/)?.[0] || '';
const resultFn = src.match(/function renderCreateResult[\s\S]*?\n\}/)?.[0] || '';
const errFn = src.match(/function bcManualCreateErrorMessage[\s\S]*?\n\}/)?.[0] || '';
const drawerFn = src.match(/function bcOpenDrawerAfterManualCreate[\s\S]*?\n\}/)?.[0] || '';

console.log('\nA. Double-click protection + in-flight state');

check(/var bcManualCreateInFlight/.test(src), 'bcManualCreateInFlight guard variable present');
check(/if \(bcManualCreateInFlight\) return/.test(createFn),
  'create handler returns early when request already in flight');
check(/bcManualCreateInFlight = true/.test(createFn),
  'create handler sets in-flight flag before fetch');
check(/bcManualCreateInFlight = false/.test(createFn),
  'create handler clears in-flight flag after fetch');
check(/Creating booking/.test(createFn),
  'in-flight copy "Creating booking…" present');
check(/createBtn\.disabled = true/.test(createFn),
  'create button disabled during request');

console.log('\nB. Success message');

check(/function renderCreateResult\(res, ctx\)/.test(src),
  'renderCreateResult accepts create context');
check(/Booking created/.test(resultFn),
  'success banner mentions booking created');
check(/d\.booking_code/.test(resultFn),
  'success message includes booking code when available');
check(/ctx\.guestName|guestLabel/.test(resultFn),
  'success message includes guest name when available');
check(/bcStayNightsFromCheckInOut/.test(resultFn),
  'success message uses check-in/check-out night count');
check(/service_records_created/.test(resultFn),
  'add-on/service confirmation uses service_records_created when present');
check(/payment_id|payReady|Payment:/.test(resultFn),
  'payment readiness copy present when response exposes payment fields');

console.log('\nC. Error/conflict clarity');

check(/function bcManualCreateErrorMessage/.test(src),
  'bcManualCreateErrorMessage helper present');
check(/invalid_payment_amounts|Invalid payment amount/.test(errFn),
  'invalid_payment_amounts handling present');
check(/overlap_conflict|Dates or beds unavailable/.test(errFn),
  'date/bed conflict handling present');
check(/Missing or invalid field/.test(errFn),
  'missing required field handling present');
check(/Add-on issue/.test(errFn),
  'add-on/service issue handling present');
check(/Debug:/.test(resultFn) || /block_reason/.test(resultFn),
  'error view retains staging debug detail');

console.log('\nD. Drawer auto-open');

check(/function bcOpenDrawerAfterManualCreate/.test(src),
  'drawer auto-open helper present');
check(/showBlockDetail\(blk\)/.test(drawerFn),
  'drawer opens via existing showBlockDetail');
check(/loadBedCalendar\(function\(calData\)/.test(createFn) ||
  /loadBedCalendar\(function/.test(createFn),
  'calendar reload triggers drawer open after create');
check(/open from calendar/.test(drawerFn),
  'safe fallback when booking_code missing');

console.log('\nE. Safety — no forbidden side effects');

check(!/graph\.facebook\.com/.test(createFn + resultFn + drawerFn),
  'manual create UI path has no graph.facebook.com');
check(!/api\.stripe\.com/.test(createFn),
  'create handler does not call Stripe API directly');
check(!/n8n\.cloud|activate.*workflow/i.test(createFn),
  'create handler has no n8n activation URL');
check(!/INSERT INTO bookings|UPDATE bookings|DELETE FROM booking_beds/i.test(createFn + resultFn),
  'UI polish slice does not mutate bookings in create handler');
check(!/function alAsk|resolveNaturalLanguageIntent/.test(
  src.match(/function bcManualCreateErrorMessage[\s\S]*?function runCreateStripeLink/)?.[0] || ''),
  'no Ask Luna logic changes in polish slice');
check(!/renderBedCalendar\s*=\s*function|\/\/\s*TODO:\s*refactor entire calendar/i.test(
  src.match(/function bcManualCreateErrorMessage[\s\S]*?function runCreateStripeLink/)?.[0] || ''),
  'no broad calendar/booking engine refactor markers');

console.log('\nF. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-manual-booking-polish'] ===
      'node scripts/verify-staff-manual-booking-polish.js',
    'package.json has verify:staff-manual-booking-polish script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
