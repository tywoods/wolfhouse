/**
 * Phase 11e — Verifier for Staff Ask Luna arrivals/checkouts queries.
 *
 * Usage:
 *   npm run verify:staff-ask-luna-arrivals-checkouts
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const AC_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-arrivals-checkouts.js');
const REG_FILE = path.join(__dirname, 'lib', 'staff-query-registry.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-ask-luna-arrivals-checkouts.js  (Phase 11e)\n');

for (const f of [API_FILE, AC_FILE, REG_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const acSrc = fs.readFileSync(AC_FILE, 'utf8');
const regSrc = fs.readFileSync(REG_FILE, 'utf8');
const pkg    = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${AC_FILE}"`, { stdio: 'ignore' });
  ok('staff-ask-luna-arrivals-checkouts.js passes node --check');
} catch (_) {
  fail('staff-ask-luna-arrivals-checkouts.js passes node --check');
}

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-arrivals-checkouts']
    === 'node scripts/verify-staff-ask-luna-arrivals-checkouts.js',
  'package.json verify script',
);

console.log('\nA. Registry');

check(regSrc.includes("'bookings.arrivals_today'"), 'registry: bookings.arrivals_today');
check(regSrc.includes("'bookings.arrivals_tomorrow'"), 'registry: bookings.arrivals_tomorrow');
check(regSrc.includes("'bookings.arrivals_on_date'"), 'registry: bookings.arrivals_on_date');
check(regSrc.includes("'bookings.checkouts_today'"), 'registry: bookings.checkouts_today');
check(regSrc.includes("'bookings.checkouts_tomorrow'"), 'registry: bookings.checkouts_tomorrow');
check(regSrc.includes("'bookings.checkouts_on_date'"), 'registry: bookings.checkouts_on_date');

console.log('\nB. Query — structured data, exclusions, weekday window');

check(acSrc.includes('FROM bookings'), 'SQL uses bookings');
check(acSrc.includes('booking_beds'), 'SQL uses booking_beds');
check(acSrc.includes('INNER JOIN clients'), 'SQL joins clients');
check(acSrc.includes('check_in'), 'SQL filters check_in for arrivals');
check(acSrc.includes('check_out'), 'SQL filters check_out for checkouts');
check(
  acSrc.includes("'cancelled', 'canceled', 'expired', 'hold'"),
  'SQL excludes cancelled/canceled/expired/hold',
);
check(acSrc.includes('resolveAskLunaWeekdayWithin5Days'), 'reuses Phase 11d weekday resolver');
check(!acSrc.match(/FROM\s+conversations|message_log|chat_log/i), 'no chat/conversation log queries');

console.log('\nC. Ask Luna wiring');

check(apiSrc.includes('resolveAskLunaArrivalsCheckoutsIntentKey'), 'API uses arrivals/checkouts resolver');
check(apiSrc.includes('arrivalsCheckoutsIntentEarly'), 'resolved before generic registry passthrough');
check(apiSrc.includes("'bookings.arrivals_today'"), 'ASK_LUNA_LOCAL_QUERY arrivals_today');
check(apiSrc.includes('formatAskLunaArrivalsCheckoutsAnswer'), 'formatAnswer uses formatter');

console.log('\nD. Phrase routing');

const {
  resolveAskLunaArrivalsCheckoutsIntentKey,
} = require('./lib/staff-ask-luna-arrivals-checkouts');
const { resolveAskLunaWeekdayWithin5Days } = require('./lib/staff-ask-luna-meals-yoga');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');

const REF_THU = new Date('2026-06-04T12:00:00Z');

const PHRASES = [
  ['Who checks in today?', 'bookings.arrivals_today'],
  ['Who is arriving today?', 'bookings.arrivals_today'],
  ['How many arrivals today?', 'bookings.arrivals_today'],
  ['Who checks out today?', 'bookings.checkouts_today'],
  ['Who is leaving today?', 'bookings.checkouts_today'],
  ['How many checkouts today?', 'bookings.checkouts_today'],
  ['Who checks in tomorrow?', 'bookings.arrivals_tomorrow'],
  ['Who checks out tomorrow?', 'bookings.checkouts_tomorrow'],
  ['Who arrives on Friday?', 'bookings.arrivals_on_date'],
  ['Who leaves on Saturday?', 'bookings.checkouts_on_date'],
  ['How many arrivals on Monday?', 'bookings.arrivals_on_date'],
  ['How many checkouts on Tuesday?', 'bookings.checkouts_on_date'],
  ['bookings.arrivals_today', 'bookings.arrivals_today'],
  ['bookings.arrivals_tomorrow', 'bookings.arrivals_tomorrow'],
  ['bookings.checkouts_today', 'bookings.checkouts_today'],
  ['bookings.checkouts_tomorrow', 'bookings.checkouts_tomorrow'],
];

for (const [phrase, expected] of PHRASES) {
  const got = resolveAskLunaArrivalsCheckoutsIntentKey(phrase, REGISTRY_BY_KEY, REF_THU);
  check(got && got.intentKey === expected, `routes "${phrase}" → ${expected}`);
  check(got && got.extraParams && got.extraParams.date, `date param for "${phrase}"`);
}

const wed = resolveAskLunaWeekdayWithin5Days('arrivals on wednesday', REF_THU);
check(wed && wed.rejected, 'Wednesday from Thursday outside 5 days');

const rejectQ = resolveAskLunaArrivalsCheckoutsIntentKey(
  'Who arrives on Wednesday?', REGISTRY_BY_KEY, REF_THU,
);
check(
  rejectQ && rejectQ.intentKey === 'unsupported_intent' && rejectQ.intentHint,
  'weekday outside 5 days → unsupported_intent',
);

console.log('\nE. Response format');

const { formatAskLunaArrivalsCheckoutsAnswer } = require('./lib/staff-ask-luna-arrivals-checkouts');

const emptyArr = formatAskLunaArrivalsCheckoutsAnswer([], { dateLabel: 'today', flow: 'arrivals' });
check(emptyArr.includes('No arrivals are currently scheduled for today'), 'empty arrivals today');

const emptyCo = formatAskLunaArrivalsCheckoutsAnswer([], { dateLabel: 'friday', flow: 'checkouts' });
check(emptyCo.includes('No checkouts are currently scheduled for Friday'), 'empty checkouts friday');

const sample = formatAskLunaArrivalsCheckoutsAnswer([
  {
    guest_name: 'Jimmy',
    booking_code: 'WH-260615-ABCD',
    check_in: '2026-06-15',
    check_out: '2026-06-22',
    guest_count: 2,
    bed_summary: 'DEMO-R1',
    payment_status: 'deposit_paid',
    balance_due_cents: 0,
  },
], { dateLabel: 'today', flow: 'arrivals' });

check(sample.includes('1 arrival'), 'includes total arrivals');
check(sample.includes('Jimmy'), 'includes guest name');
check(sample.includes('WH-260615-ABCD'), 'includes booking code');
check(sample.includes('DEMO-R1'), 'includes room/bed');
check(sample.includes('Jun 15'), 'includes stay dates');
check(sample.includes('Deposit paid'), 'includes payment label');
check(sample.includes('Total: 1 arrival'), 'includes totals footer');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
