/**
 * Phase 11k — Verifier for Staff Ask Luna occupancy / staying tonight.
 *
 * Usage:
 *   npm run verify:staff-ask-luna-occupancy
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const OC_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-occupancy.js');
const REG_FILE = path.join(__dirname, 'lib', 'staff-query-registry.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-ask-luna-occupancy.js  (Phase 11k)\n');

for (const f of [API_FILE, OC_FILE, REG_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const ocSrc = fs.readFileSync(OC_FILE, 'utf8');
const regSrc = fs.readFileSync(REG_FILE, 'utf8');
const pkg    = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${OC_FILE}"`, { stdio: 'ignore' });
  ok('staff-ask-luna-occupancy.js passes node --check');
} catch (_) {
  fail('staff-ask-luna-occupancy.js passes node --check');
}

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-occupancy']
    === 'node scripts/verify-staff-ask-luna-occupancy.js',
  'package.json verify script',
);

console.log('\nA. Registry');
check(regSrc.includes("'bookings.occupancy_tonight'"), 'registry: bookings.occupancy_tonight');
check(regSrc.includes("'bookings.occupancy_tomorrow_night'"), 'registry: bookings.occupancy_tomorrow_night');

console.log('\nB. Query — nights-based occupancy, exclusions');
check(ocSrc.includes('FROM bookings'), 'SQL uses bookings');
check(ocSrc.includes('booking_beds'), 'SQL uses booking_beds');
check(ocSrc.includes('INNER JOIN clients'), 'SQL joins clients');
check(ocSrc.includes('b.check_in <= $2::date'), 'SQL: check_in <= night');
check(ocSrc.includes('b.check_out > $2::date'), 'SQL: check_out > night (checkout today excluded)');
check(
  ocSrc.includes("'cancelled', 'canceled', 'expired', 'hold'"),
  'SQL excludes cancelled/canceled/expired/hold',
);
check(!ocSrc.match(/FROM\s+conversations|message_log|chat_log/i), 'no chat/conversation log queries');
check(!ocSrc.match(/\b(INSERT|UPDATE|DELETE)\b/i), 'no write SQL in occupancy lib');
check(!ocSrc.match(/stripe|whatsapp|n8n|deploy|migration/i), 'occupancy lib has no Stripe/WhatsApp/n8n/deploy');

console.log('\nC. Ask Luna wiring');
check(apiSrc.includes('resolveAskLunaOccupancyIntentKey'), 'API uses occupancy resolver');
check(apiSrc.includes('occupancyIntentEarly'), 'resolved before arrivals/checkouts');
check(apiSrc.includes("'bookings.occupancy_tonight'"), 'ASK_LUNA_LOCAL_QUERY occupancy_tonight');
check(apiSrc.includes('formatAskLunaOccupancyAnswer'), 'formatAnswer uses formatter');
check(apiSrc.includes('getAskLunaOccupancyOnNightQuery'), 'local query wired');

console.log('\nD. Phrase routing');

const {
  resolveAskLunaOccupancyIntentKey,
  getAskLunaOccupancyOnNightQuery,
  formatAskLunaOccupancyAnswer,
  buildOccupancyGroups,
  OCCUPANCY_TONIGHT_KEY,
  OCCUPANCY_TOMORROW_NIGHT_KEY,
} = require('./lib/staff-ask-luna-occupancy');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');

const REF_THU = new Date('2026-06-04T12:00:00Z');

const PHRASES = [
  ['Who is staying tonight?', OCCUPANCY_TONIGHT_KEY],
  ['Who is in house tonight?', OCCUPANCY_TONIGHT_KEY],
  ['How many guests are staying tonight?', OCCUPANCY_TONIGHT_KEY],
  ['Which rooms are occupied tonight?', OCCUPANCY_TONIGHT_KEY],
  ['Who is staying tomorrow night?', OCCUPANCY_TOMORROW_NIGHT_KEY],
  ['How many guests tomorrow night?', OCCUPANCY_TOMORROW_NIGHT_KEY],
  ['Which rooms are occupied tomorrow night?', OCCUPANCY_TOMORROW_NIGHT_KEY],
  ['Who is currently in house?', OCCUPANCY_TONIGHT_KEY],
  ['bookings.occupancy_tonight', OCCUPANCY_TONIGHT_KEY],
  ['bookings.occupancy_tomorrow_night', OCCUPANCY_TOMORROW_NIGHT_KEY],
];

for (const [phrase, expected] of PHRASES) {
  const got = resolveAskLunaOccupancyIntentKey(phrase, REGISTRY_BY_KEY, REF_THU);
  check(got && got.intentKey === expected, `routes "${phrase}" → ${expected}`);
  check(got && got.extraParams && got.extraParams.date, `date param for "${phrase}"`);
}

const tonight = resolveAskLunaOccupancyIntentKey('Who is staying tonight?', REGISTRY_BY_KEY, REF_THU);
check(tonight && tonight.extraParams.date === '2026-06-04', 'tonight date on 2026-06-04 ref');
check(tonight && tonight.extraParams.nightLabel === 'tonight', 'tonight label');

const tomorrow = resolveAskLunaOccupancyIntentKey(
  'Who is staying tomorrow night?', REGISTRY_BY_KEY, REF_THU,
);
check(tomorrow && tomorrow.extraParams.date === '2026-06-05', 'tomorrow night date');
check(tomorrow && tomorrow.extraParams.nightLabel === 'tomorrow night', 'tomorrow night label');

const notCheckout = resolveAskLunaOccupancyIntentKey(
  'Who is checking out tonight?', REGISTRY_BY_KEY, REF_THU,
);
check(notCheckout === null, 'checkout tonight does not route to occupancy');

console.log('\nE. Nights logic (check-in today / check-out today)');

const sql = getAskLunaOccupancyOnNightQuery();
check(sql.includes('check_in <= $2::date'), 'verifier: check_in <= night');
check(sql.includes('check_out > $2::date'), 'verifier: check_out > night');

console.log('\nF. Formatter output');

const sampleRows = [
  {
    booking_code: 'WH-260615-ABCD',
    guest_name: 'Jimmy',
    guest_count: 1,
    check_in: '2026-06-15',
    check_out: '2026-06-22',
    room_code: 'R1',
    bed_code: 'B1',
    payment_status: 'paid',
  },
  {
    booking_code: 'WH-260616-EFGH',
    guest_name: 'Anna',
    guest_count: 1,
    check_in: '2026-06-16',
    check_out: '2026-06-20',
    room_code: 'R1',
    bed_code: 'B2',
    payment_status: 'deposit_paid',
  },
  {
    booking_code: 'WH-260617-IJKL',
    guest_name: 'Marco',
    guest_count: 2,
    check_in: '2026-06-17',
    check_out: '2026-06-24',
    room_code: 'R3',
    bed_code: 'B1',
    payment_status: 'waiting_payment',
  },
];

const groups = buildOccupancyGroups(sampleRows);
check(groups.bookingCount === 3, 'groups: 3 bookings');
check(groups.guestTotal === 4, 'groups: 4 guests');
check(groups.bedCount === 3, 'groups: 3 beds');

const answer = formatAskLunaOccupancyAnswer(sampleRows, { nightLabel: 'tonight' });
check(answer.includes('4 guests staying across 3 bookings'), 'answer headline with totals');
check(answer.includes('R1:'), 'answer room R1');
check(answer.includes('Jimmy'), 'answer guest Jimmy');
check(answer.includes('WH-260615-ABCD'), 'answer booking code');
check(answer.includes('R1-B1'), 'answer room-bed label');
check(answer.includes('Jun 15–22'), 'answer stay dates');
check(answer.includes('Total: 4 guests, 3 bookings'), 'answer footer totals');

const emptyTonight = formatAskLunaOccupancyAnswer([], { nightLabel: 'tonight' });
check(
  emptyTonight === 'No active guests are staying tonight.',
  'empty tonight message',
);
const emptyTomorrow = formatAskLunaOccupancyAnswer([], { nightLabel: 'tomorrow night' });
check(
  emptyTomorrow === 'No active guests are staying tomorrow night.',
  'empty tomorrow night message',
);

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
