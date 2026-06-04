/**
 * Phase 11d — Verifier for Staff Ask Luna meals & yoga queries.
 *
 * Usage:
 *   npm run verify:staff-ask-luna-meals-yoga
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const MY_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-meals-yoga.js');
const REG_FILE = path.join(__dirname, 'lib', 'staff-query-registry.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-ask-luna-meals-yoga.js  (Phase 11d)\n');

for (const f of [API_FILE, MY_FILE, REG_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const mySrc = fs.readFileSync(MY_FILE, 'utf8');
const regSrc = fs.readFileSync(REG_FILE, 'utf8');
const pkg    = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${MY_FILE}"`, { stdio: 'ignore' });
  ok('staff-ask-luna-meals-yoga.js passes node --check');
} catch (_) {
  fail('staff-ask-luna-meals-yoga.js passes node --check');
}

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-meals-yoga']
    === 'node scripts/verify-staff-ask-luna-meals-yoga.js',
  'package.json verify script',
);

console.log('\nA. Registry');

check(regSrc.includes("'services.meals_today'"), 'registry: services.meals_today');
check(regSrc.includes("'services.meals_tomorrow'"), 'registry: services.meals_tomorrow');
check(regSrc.includes("'services.yoga_today'"), 'registry: services.yoga_today');
check(regSrc.includes("'services.yoga_tomorrow'"), 'registry: services.yoga_tomorrow');
check(regSrc.includes("'services.meals_on_date'"), 'registry: services.meals_on_date');
check(regSrc.includes("'services.yoga_on_date'"), 'registry: services.yoga_on_date');

console.log('\nB. Query — structured data, exclusions, weekday window');

check(mySrc.includes('booking_service_records'), 'SQL uses booking_service_records');
check(mySrc.includes('INNER JOIN bookings'), 'SQL joins bookings');
check(mySrc.includes('booking_beds'), 'SQL uses booking_beds');
check(mySrc.includes("service_type = 'meal'") || mySrc.includes("'meal'"), 'SQL filters meal type');
check(mySrc.includes("service_type = 'yoga'") || mySrc.includes("'yoga'"), 'SQL filters yoga type');
check(mySrc.includes("status <> 'cancelled'"), 'SQL excludes cancelled service records');
check(
  mySrc.includes("'cancelled', 'canceled', 'expired', 'hold'"),
  'SQL excludes cancelled/canceled/expired/hold bookings',
);
check(mySrc.includes('MEALS_YOGA_WEEKDAY_MAX'), 'weekday within 5 days guard');
check(mySrc.includes('daysUntil > MEALS_YOGA_WEEKDAY_MAX'), 'rejects weekday outside window');
check(!mySrc.match(/FROM\s+conversations|message_log|chat_log/i), 'no chat/conversation log queries');

console.log('\nC. Ask Luna wiring');

check(apiSrc.includes('resolveAskLunaMealsYogaIntentKey'), 'API uses meals/yoga intent resolver');
check(apiSrc.includes('mealsYogaIntentEarly'), 'meals/yoga resolved before generic registry passthrough');
check(apiSrc.includes("'services.meals_today'"), 'ASK_LUNA_LOCAL_QUERY meals_today');
check(apiSrc.includes('formatAskLunaMealsYogaAnswer'), 'formatAnswer uses formatAskLunaMealsYogaAnswer');
check(
  !apiSrc.slice(apiSrc.indexOf("'services.meals_today'"), apiSrc.indexOf("'services.meals_today'") + 400)
    .match(/\b(stripe|n8n)\b/i),
  'meals/yoga wiring has no Stripe/n8n',
);

console.log('\nD. Phrase routing');

const {
  resolveAskLunaMealsYogaIntentKey,
  resolveAskLunaWeekdayWithin5Days,
  formatAskLunaMealsYogaAnswer,
} = require('./lib/staff-ask-luna-meals-yoga');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');

const REF_THU = new Date('2026-06-04T12:00:00Z');

const PHRASES = [
  ['Who has meals today?', 'services.meals_today'],
  ['Who paid for meals today?', 'services.meals_today'],
  ['Who has dinner today?', 'services.meals_today'],
  ['Who has yoga today?', 'services.yoga_today'],
  ['Who paid for yoga today?', 'services.yoga_today'],
  ['Who has meals tomorrow?', 'services.meals_tomorrow'],
  ['Who has yoga tomorrow?', 'services.yoga_tomorrow'],
  ['How many meals today?', 'services.meals_today'],
  ['How many people are in yoga tomorrow?', 'services.yoga_tomorrow'],
  ['How many people do I have in yoga on Friday?', 'services.yoga_on_date'],
  ['Who has yoga on Friday?', 'services.yoga_on_date'],
  ['Who paid for yoga on Saturday?', 'services.yoga_on_date'],
  ['How many meals on Monday?', 'services.meals_on_date'],
  ['Who has dinner on Tuesday?', 'services.meals_on_date'],
  ['services.meals_today', 'services.meals_today'],
  ['services.meals_tomorrow', 'services.meals_tomorrow'],
  ['services.yoga_today', 'services.yoga_today'],
  ['services.yoga_tomorrow', 'services.yoga_tomorrow'],
];

for (const [phrase, expected] of PHRASES) {
  const got = resolveAskLunaMealsYogaIntentKey(phrase, REGISTRY_BY_KEY, REF_THU);
  check(got && got.intentKey === expected, `routes "${phrase}" → ${expected}`);
  check(got && got.extraParams && got.extraParams.date, `date param for "${phrase}"`);
}

const fri = resolveAskLunaWeekdayWithin5Days('yoga on friday', REF_THU);
check(fri && !fri.rejected && fri.label === 'friday' && fri.daysUntil === 1,
  'Friday from Thursday is within 5 days');

const wed = resolveAskLunaWeekdayWithin5Days('yoga on wednesday', REF_THU);
check(wed && wed.rejected && wed.daysUntil === 6, 'Wednesday from Thursday is outside 5 days');

const rejectQ = resolveAskLunaMealsYogaIntentKey('Who has yoga on Wednesday?', REGISTRY_BY_KEY, REF_THU);
check(
  rejectQ && rejectQ.intentKey === 'unsupported_intent' && rejectQ.intentHint,
  'weekday outside 5 days → unsupported_intent',
);

console.log('\nE. Response format');

const emptyMeals = formatAskLunaMealsYogaAnswer([], { dateLabel: 'today', serviceCategory: 'meals' });
check(emptyMeals.includes('No meals are currently booked for today'), 'empty meals today');

const emptyYoga = formatAskLunaMealsYogaAnswer([], { dateLabel: 'friday', serviceCategory: 'yoga' });
check(emptyYoga.includes('No yoga classes are currently booked for Friday'), 'empty yoga friday');

const sample = formatAskLunaMealsYogaAnswer([
  {
    guest_name: 'Jimmy',
    booking_code: 'WH-260615-ABCD',
    service_type: 'meal',
    quantity: 2,
    bed_summary: 'DEMO-R1',
    payment_status: 'paid',
  },
  {
    guest_name: 'Anna',
    booking_code: 'WH-260616-EFGH',
    service_type: 'meal',
    quantity: 1,
    bed_summary: 'DEMO-R2-B1',
    payment_status: 'pending',
  },
], { dateLabel: 'tuesday', serviceCategory: 'meals' });

check(sample.includes('3 meal'), 'includes total meals');
check(sample.includes('Jimmy'), 'includes guest name');
check(sample.includes('WH-260615-ABCD'), 'includes booking code');
check(sample.includes('DEMO-R1'), 'includes room/bed');
check(sample.includes('paid'), 'includes payment status');
check(sample.includes('Total:'), 'includes totals footer');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
