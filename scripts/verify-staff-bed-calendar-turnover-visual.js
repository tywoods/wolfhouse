/**
 * Phase 10.0b — Static verifier for Bed Calendar same-day turnover visual.
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

console.log('\nverify-staff-bed-calendar-turnover-visual.js  (Phase 10.0b)\n');

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

const turnoverFn = src.match(/function renderBcTurnoverDayCell[\s\S]*?\n\}/)?.[0] || '';

console.log('\nA. Turnover visual — incoming primary, checkout subtle');

check(/function bcTurnoverVisibleLabel/.test(src),
  'bcTurnoverVisibleLabel prefers guest name');
check(/blk\.guest_name \|\| blk\.booking_code/.test(src.match(/function bcTurnoverVisibleLabel[\s\S]*?\n\}/)?.[0] || ''),
  'visible label uses guest_name before booking_code');
check(/function bcTurnoverPrimarySeg/.test(src) && /layer === 'checkin'/.test(src),
  'turnover primary segment prefers checkin layer');
check(/bc-block-checkout-marker/.test(turnoverFn),
  'turnover uses checkout marker (not competing full block)');
check(!/bc-block-checkout-layer/.test(turnoverFn),
  'turnover renderer does not stack old checkout-layer full blocks');
check(/bcTurnoverVisibleLabel\(primary\.blk\)/.test(turnoverFn),
  'turnover visible text uses guest-name helper on primary block');
check(!/bcBlockLabel\(/.test(turnoverFn),
  'turnover cell does not use bcBlockLabel (avoids booking-code chip)');
check(/function bcTurnoverCellTooltip/.test(src),
  'combined turnover tooltip helper present');
check(/Out:/.test(src.match(/function bcTurnoverCellTooltip[\s\S]*?\n\}/)?.[0] || ''),
  'tooltip can mention outgoing booking on turnover day');

console.log('\nB. Layer ordering + click wiring');

check(/bc-block-checkout-marker\{[^}]*z-index:\s*1/.test(src),
  'checkout marker z-index 1 (behind)');
check(/\.bc-block-checkin-layer\{[^}]*z-index:\s*2/.test(src),
  'checkin layer z-index 2 (foreground)');
check(/querySelectorAll\('\.bc-block, \.bc-block-checkout-marker'\)/.test(src),
  'checkout marker wired for drawer clicks');

console.log('\nC. Preserved stay-count + half-open semantics');

check(/function bcSelectedNightsFromRange/.test(src),
  'selected nights helper still present');
check(/Math\.max\(0,\s*bcSelectedDatesCount\(selStart,\s*selEnd\)\s*-\s*1\)/.test(src),
  'selected nights still count minus 1');
check(/coDate\.setUTCDate\(coDate\.getUTCDate\(\) \+ 1\)/.test(src),
  'half-open checkout = day after last selected date preserved');
check(/dayDate >= blk\.start_date && dayDate < blk\.end_date/.test(src),
  'half-open block visibility rule preserved');
check(/segsAt\.length > 1/.test(src.match(/function renderBedCalendar[\s\S]*?\n\}/)?.[0] || ''),
  'normal colspan merge still breaks on turnover days');

console.log('\nD. Safety');

check(!/graph\.facebook\.com/.test(turnoverFn),
  'turnover renderer has no graph.facebook.com');
check(!/api\.stripe\.com/.test(turnoverFn),
  'turnover renderer has no api.stripe.com');
check(!/INSERT INTO bookings|UPDATE bookings|DELETE FROM booking_beds|INSERT INTO payments/i.test(
  src.match(/function renderBcTurnoverDayCell[\s\S]*?function renderBookingBlock/)?.[0] || ''),
  'turnover render path does not mutate bookings/payments');
check(!/renderBedCalendar\s*=\s*function|\/\/\s*TODO:\s*refactor entire calendar/i.test(src),
  'no broad calendar refactor markers');

console.log('\nE. package.json script');

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
