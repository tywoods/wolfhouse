/**
 * Phase 10.0c — Static verifier for Bed Calendar same-day turnover visual.
 *
 * Usage:
 *   npm run verify:staff-bed-calendar-turnover-visual
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

console.log('\nverify-staff-bed-calendar-turnover-visual.js  (Phase 10.0c)\n');

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

const renderCal = src.match(/function renderBedCalendar[\s\S]*?\n\}/)?.[0] || '';
const visibleFn = src.match(/function bcBlockVisibleOnDay[\s\S]*?\n\}/)?.[0] || '';
const bookingFn = src.match(/function renderBookingBlock[\s\S]*?\n\}/)?.[0] || '';
const turnoverFn = src.match(/function renderBcTurnoverDayCell[\s\S]*?\n\}/)?.[0] || '';

console.log('\nA. Continuous incoming bar — no duplicate/split on turnover day');

check(/function bcTurnoverCheckoutOnDay/.test(src),
  'bcTurnoverCheckoutOnDay helper detects same-day turnover');
check(/bcTurnoverCheckoutOnDay\(bedBlocks,\s*spanStartDate,\s*spanBlkIdx\)/.test(renderCal),
  'merge path passes turnover checkout into continuous bar render');
check(/renderBookingBlock\([^)]*turnoverOut\)/.test(renderCal),
  'continuous bar renderer receives optional turnover checkout');
check(/bc-block-checkout-marker/.test(bookingFn),
  'checkout marker rendered inside merged booking block (not split cell)');
check(!/bcBlockLabel\(/.test(bookingFn.match(/if \(turnoverCheckout\)[\s\S]*?\} else \{/)?.[0] || ''),
  'turnover first cell uses guest name helper, not booking-code label');
check(/bcTurnoverVisibleLabel\(blk\)/.test(bookingFn),
  'merged turnover bar visible label prioritizes guest name');

console.log('\nB. Outgoing checkout date — not a full visible block');

check(/dayDate >= blk\.start_date && dayDate < blk\.end_date/.test(visibleFn),
  'visible-on-day uses half-open occupied nights only');
check(!/is_departure && dayDate === blk\.end_date/.test(visibleFn),
  'checkout date excluded from normal block visibility');
check(/function bcTurnoverVisibleLabel/.test(src),
  'bcTurnoverVisibleLabel prefers guest name');
check(/blk\.guest_name \|\| blk\.booking_code/.test(src.match(/function bcTurnoverVisibleLabel[\s\S]*?\n\}/)?.[0] || ''),
  'visible label uses guest_name before booking_code');
check(!/bc-block-checkout-layer/.test(turnoverFn),
  'no competing checkout-layer full blocks in turnover cell fallback');

console.log('\nC. Layer ordering + conflict fallback');

check(/bc-block-checkout-marker\{[^}]*z-index:\s*1/.test(src),
  'checkout marker z-index 1 (behind)');
check(/bc-day-cell-turnover \.bc-block\{[^}]*z-index:\s*2/.test(src),
  'foreground booking block z-index 2 on turnover bar');
check(/querySelectorAll\('\.bc-block, \.bc-block-checkout-marker'\)/.test(src),
  'checkout marker wired for drawer clicks');
check(/segsAt\.length > 1/.test(renderCal),
  'conflict/overlap days still use dedicated turnover cell path');

console.log('\nD. Preserved stay-count + half-open semantics');

check(/function bcSelectedNightsFromRange/.test(src),
  'selected nights helper still present');
check(/Math\.max\(0,\s*bcSelectedDatesCount\(selStart,\s*selEnd\)\s*-\s*1\)/.test(src),
  'selected nights still count minus 1');
check(/coDate\.setUTCDate\(coDate\.getUTCDate\(\) \+ 1\)/.test(src),
  'half-open checkout = day after last selected date preserved');

console.log('\nE. Safety');

check(!/graph\.facebook\.com/.test(renderCal),
  'bed calendar render path has no graph.facebook.com');
check(!/api\.stripe\.com/.test(renderCal),
  'bed calendar render path has no api.stripe.com');
check(!/INSERT INTO bookings|UPDATE bookings|DELETE FROM booking_beds|INSERT INTO payments/i.test(
  src.match(/function renderBedCalendar[\s\S]*?function bcBlockVisibleOnDay/)?.[0] || ''),
  'calendar render path does not mutate bookings/payments');
check(!/renderBedCalendar\s*=\s*function|\/\/\s*TODO:\s*refactor entire calendar/i.test(src),
  'no broad calendar refactor markers');

console.log('\nF. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-bed-calendar-turnover-visual'] ===
      'node scripts/verify-staff-bed-calendar-turnover-visual.js',
    'package.json has verify:staff-bed-calendar-turnover-visual script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
