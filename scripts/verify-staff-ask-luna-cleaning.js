/**
 * Phase 11f — Verifier for Staff Ask Luna cleaning / turnover queries.
 *
 * Usage:
 *   npm run verify:staff-ask-luna-cleaning
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const HK_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-cleaning.js');
const REG_FILE = path.join(__dirname, 'lib', 'staff-query-registry.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-ask-luna-cleaning.js  (Phase 11f)\n');

for (const f of [API_FILE, HK_FILE, REG_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const hkSrc = fs.readFileSync(HK_FILE, 'utf8');
const regSrc = fs.readFileSync(REG_FILE, 'utf8');
const pkg    = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${HK_FILE}"`, { stdio: 'ignore' });
  ok('staff-ask-luna-cleaning.js passes node --check');
} catch (_) {
  fail('staff-ask-luna-cleaning.js passes node --check');
}

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-cleaning']
    === 'node scripts/verify-staff-ask-luna-cleaning.js',
  'package.json verify script',
);

console.log('\nA. Registry');

check(regSrc.includes("'housekeeping.cleaning_today'"), 'registry: housekeeping.cleaning_today');
check(regSrc.includes("'housekeeping.cleaning_tomorrow'"), 'registry: housekeeping.cleaning_tomorrow');
check(regSrc.includes("'housekeeping.cleaning_on_date'"), 'registry: housekeeping.cleaning_on_date');

console.log('\nB. Query — structured data, exclusions, weekday window');

check(hkSrc.includes('FROM bookings'), 'SQL uses bookings');
check(hkSrc.includes('booking_beds'), 'SQL uses booking_beds');
check(hkSrc.includes('INNER JOIN clients'), 'SQL joins clients');
check(hkSrc.includes('check_out'), 'SQL filters check_out');
check(
  hkSrc.includes("'cancelled', 'canceled', 'expired', 'hold'"),
  'SQL excludes cancelled/canceled/expired/hold',
);
check(hkSrc.includes('resolveAskLunaWeekdayWithin5Days'), 'reuses Phase 11d weekday resolver');
check(!hkSrc.match(/FROM\s+conversations|message_log|chat_log/i), 'no chat/conversation log queries');
check(!hkSrc.match(/\b(INSERT|UPDATE|DELETE)\b/i), 'no write SQL in cleaning lib');
check(!hkSrc.match(/stripe|whatsapp|n8n/i), 'cleaning lib has no Stripe/WhatsApp/n8n');

console.log('\nC. Ask Luna wiring');

check(apiSrc.includes('resolveAskLunaCleaningIntentKey'), 'API uses cleaning resolver');
check(apiSrc.includes('cleaningIntentEarly'), 'resolved before arrivals/checkouts');
check(apiSrc.includes("'housekeeping.cleaning_today'"), 'ASK_LUNA_LOCAL_QUERY cleaning_today');
check(apiSrc.includes('formatAskLunaCleaningAnswer'), 'formatAnswer uses formatter');
check(apiSrc.includes('getAskLunaCleaningOnDateQuery'), 'local query wired');

console.log('\nD. Phrase routing');

const {
  resolveAskLunaCleaningIntentKey,
  buildCleaningGroups,
  formatAskLunaCleaningAnswer,
} = require('./lib/staff-ask-luna-cleaning');
const { resolveAskLunaWeekdayWithin5Days } = require('./lib/staff-ask-luna-meals-yoga');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');

const REF_THU = new Date('2026-06-04T12:00:00Z');

const PHRASES = [
  ['What rooms need cleaning today?', 'housekeeping.cleaning_today'],
  ['Which beds need cleaning today?', 'housekeeping.cleaning_today'],
  ['Who checks out and needs cleaning today?', 'housekeeping.cleaning_today'],
  ['What needs cleaning tomorrow?', 'housekeeping.cleaning_tomorrow'],
  ['Which rooms need turnover tomorrow?', 'housekeeping.cleaning_tomorrow'],
  ['What rooms need cleaning on Friday?', 'housekeeping.cleaning_on_date'],
  ['Which beds need cleaning on Saturday?', 'housekeeping.cleaning_on_date'],
  ['How many beds need cleaning today?', 'housekeeping.cleaning_today'],
  ['housekeeping.cleaning_today', 'housekeeping.cleaning_today'],
  ['housekeeping.cleaning_tomorrow', 'housekeeping.cleaning_tomorrow'],
];

for (const [phrase, expected] of PHRASES) {
  const got = resolveAskLunaCleaningIntentKey(phrase, REGISTRY_BY_KEY, REF_THU);
  check(got && got.intentKey === expected, `routes "${phrase}" → ${expected}`);
  check(got && got.extraParams && got.extraParams.date, `date param for "${phrase}"`);
}

const fri = resolveAskLunaCleaningIntentKey(
  'What rooms need cleaning on Friday?', REGISTRY_BY_KEY, REF_THU,
);
check(fri && fri.extraParams.dateLabel === 'friday', 'Friday label on 2026-06-04 ref');

const wed = resolveAskLunaWeekdayWithin5Days('cleaning on wednesday', REF_THU);
check(wed && wed.rejected, 'Wednesday from Thursday outside 5 days');

const rejectQ = resolveAskLunaCleaningIntentKey(
  'What needs cleaning on Wednesday?', REGISTRY_BY_KEY, REF_THU,
);
check(
  rejectQ && rejectQ.intentKey === 'unsupported_intent' && rejectQ.intentHint,
  'weekday outside 5 days → unsupported_intent',
);

console.log('\nE. Response format');

const emptyToday = formatAskLunaCleaningAnswer([], { dateLabel: 'today' });
check(
  emptyToday.includes('No rooms or beds are currently flagged for checkout cleaning today'),
  'empty cleaning today',
);

const emptyFri = formatAskLunaCleaningAnswer([], { dateLabel: 'friday' });
check(
  emptyFri.includes('No rooms or beds are currently flagged for checkout cleaning on Friday'),
  'empty cleaning friday',
);

const bedSample = formatAskLunaCleaningAnswer([
  {
    booking_code: 'WH-260615-ABCD',
    guest_name: 'Jimmy',
    guest_count: 1,
    check_out: '2026-06-04',
    room_code: 'R1',
    bed_code: 'B1',
    planning_row_label: null,
  },
  {
    booking_code: 'WH-260616-EFGH',
    guest_name: 'Anna',
    guest_count: 1,
    check_out: '2026-06-04',
    room_code: 'R1',
    bed_code: 'B2',
    planning_row_label: null,
  },
  {
    booking_code: 'WH-260617-IJKL',
    guest_name: 'Marco',
    guest_count: 1,
    check_out: '2026-06-04',
    room_code: 'R3',
    bed_code: 'B4',
    planning_row_label: null,
  },
], { dateLabel: 'today' });

check(bedSample.includes('3 beds'), 'bed sample total beds');
check(bedSample.includes('Jimmy'), 'bed sample guest');
check(bedSample.includes('WH-260615-ABCD'), 'bed sample booking code');
check(bedSample.includes('R1:'), 'bed sample room grouping');
check(bedSample.includes('Bed B1'), 'bed sample bed label');

const groups = buildCleaningGroups([
  {
    booking_code: 'WH-1',
    guest_name: 'A',
    guest_count: 1,
    check_out: '2026-06-04',
    room_code: 'R1',
    bed_code: 'B1',
  },
  {
    booking_code: 'WH-2',
    guest_name: 'B',
    guest_count: 1,
    check_out: '2026-06-04',
    room_code: 'R1',
    bed_code: 'B2',
  },
]);
check(groups.bedCount === 2 && groups.bookingCount === 2, 'shared room counts beds separately');

const roomOnly = formatAskLunaCleaningAnswer([
  {
    booking_code: 'WH-260610-MNOP',
    guest_name: 'Sophie',
    guest_count: 2,
    check_out: '2026-06-04',
    room_code: 'R5',
    bed_code: null,
  },
], { dateLabel: 'today' });
check(roomOnly.includes('R5'), 'room-only includes room');
check(roomOnly.includes('Sophie'), 'room-only includes guest');
check(roomOnly.includes('WH-260610-MNOP'), 'room-only includes booking code');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
