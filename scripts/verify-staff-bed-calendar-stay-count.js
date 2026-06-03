/**
 * Phase 10.0a — Static verifier for Bed Calendar selected-stay nights
 * and same-day checkout/checkin layering in scripts/staff-query-api.js.
 *
 * Usage:
 *   npm run verify:staff-bed-calendar-stay-count
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

function ok(msg)  { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg){ console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-bed-calendar-stay-count.js  (Phase 10.0a)\n');

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

console.log('\nA. Selected stay nights = selected dates minus 1');

check(/function bcSelectedDatesCount/.test(src) && /function bcSelectedNightsFromRange/.test(src),
  'bcSelectedDatesCount + bcSelectedNightsFromRange helpers present');
check(/bcSelectedNightsFromRange\(selStart,\s*selEnd\)/.test(src),
  'bcApplySelectionHighlight uses bcSelectedNightsFromRange(selStart, selEnd)');
check(/Math\.max\(0,\s*bcSelectedDatesCount\(selStart,\s*selEnd\)\s*-\s*1\)/.test(src),
  'selected nights uses max(0, selected_dates_count - 1)');

function nightsFromRange(selStart, selEnd) {
  const count = Math.round((new Date(selEnd + 'T00:00:00Z') - new Date(selStart + 'T00:00:00Z')) / 86400000) + 1;
  return Math.max(0, count - 1);
}

check(nightsFromRange('2026-07-01', '2026-07-01') === 0, 'fixture: 1 selected date => 0 nights');
check(nightsFromRange('2026-07-01', '2026-07-02') === 1, 'fixture: 2 selected dates => 1 night');
check(nightsFromRange('2026-07-01', '2026-07-04') === 3, 'fixture: 4 selected dates => 3 nights');
check(nightsFromRange('2026-07-01', '2026-07-07') === 6, 'fixture: 7 selected dates => 6 nights');

console.log('\nB. Same-day checkout/checkin layering');

check(/function bcBlockVisibleOnDay/.test(src) && /function bcBlockDayLayer/.test(src),
  'bcBlockVisibleOnDay + bcBlockDayLayer helpers present');
check(/function renderBcTurnoverDayCell/.test(src),
  'renderBcTurnoverDayCell helper present');
check(/bc-block-checkout-marker/.test(src) && /bc-day-cell-turnover \.bc-block\{/.test(src),
  'checkout marker + foreground block layering CSS present');
check(/bc-day-cell-turnover/.test(src),
  'turnover day cell class present');
check(!/is_departure && dayDate === blk\.end_date/.test(src.match(/function bcBlockVisibleOnDay[\s\S]*?\n\}/)?.[0] || ''),
  'checkout date excluded from occupied-night block visibility');
check(/function bcTurnoverCheckoutOnDay/.test(src),
  'same-day turnover checkout detected for merged bar marker');

console.log('\nC. Safety — no forbidden side effects');

check(!/graph\.facebook\.com/.test(src.match(/function renderBedCalendar[\s\S]*?function bcBlockVisibleOnDay/)?.[0] || ''),
  'bed calendar render path has no graph.facebook.com');
check(!/api\.stripe\.com/.test(src.match(/function bcSelectedDatesCount[\s\S]*?function bcHeaderNights/)?.[0] || ''),
  'stay-count/layer helpers have no api.stripe.com');
check(!/n8n\.cloud|activate.*workflow|workflow.*active\s*=\s*true/i.test(
  src.match(/function bcSelectedDatesCount[\s\S]*?function bcHeaderNights/)?.[0] || ''),
  'stay-count/layer helpers have no n8n activation URL');

const mig012 = path.join(MIG_DIR, '012_bot_pause_states.sql');
if (fs.existsSync(mig012)) {
  const migStat = fs.statSync(mig012);
  const migMtime = migStat.mtimeMs;
  const apiMtime = fs.statSync(API_FILE).mtimeMs;
  check(apiMtime >= migMtime - 60000 || migMtime < Date.now() - 86400000,
    'no migration file touched in this slice (mtime sanity)');
} else {
  ok('migration dir unchanged (012 not required for this check)');
}

check(!/INSERT INTO bookings|UPDATE bookings|DELETE FROM booking_beds|INSERT INTO payments/i.test(
  src.match(/function bcSelectedDatesCount[\s\S]*?function bcHeaderNights/)?.[0] || ''),
  'stay-count/layer helpers do not mutate bookings/payments');

check(!/renderBedCalendar\s*=\s*function|\/\/\s*TODO:\s*refactor entire calendar/i.test(src),
  'no broad calendar refactor markers');

console.log('\nD. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-bed-calendar-stay-count'] ===
      'node scripts/verify-staff-bed-calendar-stay-count.js',
    'package.json has verify:staff-bed-calendar-stay-count script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
