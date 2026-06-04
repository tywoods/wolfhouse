/**
 * Phase 11l — Verifier for Staff Ask Luna free-bed snapshot queries.
 *
 * Usage:
 *   npm run verify:staff-ask-luna-free-beds
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const FB_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-free-beds.js');
const REG_FILE = path.join(__dirname, 'lib', 'staff-query-registry.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-ask-luna-free-beds.js  (Phase 11l)\n');

for (const f of [API_FILE, FB_FILE, REG_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const fbSrc = fs.readFileSync(FB_FILE, 'utf8');
const regSrc = fs.readFileSync(REG_FILE, 'utf8');
const pkg    = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${FB_FILE}"`, { stdio: 'ignore' });
  ok('staff-ask-luna-free-beds.js passes node --check');
} catch (_) {
  fail('staff-ask-luna-free-beds.js passes node --check');
}

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-free-beds']
    === 'node scripts/verify-staff-ask-luna-free-beds.js',
  'package.json verify script',
);

console.log('\nA. Registry');
check(regSrc.includes("'inventory.free_beds_tonight'"), 'registry: inventory.free_beds_tonight');
check(regSrc.includes("'inventory.free_beds_tomorrow_night'"), 'registry: inventory.free_beds_tomorrow_night');
check(regSrc.includes("category:        'inventory'"), 'registry category inventory');

console.log('\nB. Query — inventory + bookings, night occupancy');
check(fbSrc.includes('FROM beds'), 'SQL uses beds inventory');
check(fbSrc.includes('FROM rooms'), 'SQL uses rooms inventory');
check(fbSrc.includes('booking_beds'), 'SQL uses booking_beds for occupancy');
check(fbSrc.includes('FROM bookings'), 'SQL uses bookings');
check(fbSrc.includes('bd.active = TRUE'), 'SQL excludes inactive beds');
check(fbSrc.includes('bd.sellable = TRUE'), 'SQL excludes unsellable beds');
check(fbSrc.includes('r.active = TRUE'), 'SQL excludes inactive rooms');
check(fbSrc.includes('b.check_in <= $2::date'), 'SQL: check_in <= night');
check(fbSrc.includes('b.check_out > $2::date'), 'SQL: check_out > night (checkout today free)');
check(
  fbSrc.includes("'cancelled', 'canceled', 'expired', 'hold'"),
  'SQL excludes cancelled/canceled/expired/hold bookings',
);
check(!fbSrc.match(/FROM\s+conversations|message_log|chat_log/i), 'no chat log queries');
check(!fbSrc.match(/\b(INSERT|UPDATE|DELETE)\b/i), 'no write SQL');
check(!fbSrc.match(/stripe|whatsapp|n8n|deploy|migration/i), 'no Stripe/WhatsApp/n8n/deploy');
check(
  fbSrc.includes('Snapshot only') && fbSrc.includes('booking flow'),
  'snapshot-only caveat in lib',
);
check(
  !fbSrc.match(/create\s+hold|quote|price|confirm\s+availability\s+to\s+guest/i),
  'no hold/quote/guest-confirm language',
);

console.log('\nC. Ask Luna wiring');
check(apiSrc.includes('resolveAskLunaFreeBedsIntentKey'), 'API uses free-beds resolver');
check(apiSrc.includes('freeBedsIntentEarly'), 'resolved before arrivals/checkouts');
check(apiSrc.includes("'inventory.free_beds_tonight'"), 'ASK_LUNA_LOCAL_QUERY wired');
check(apiSrc.includes('formatAskLunaFreeBedsAnswer'), 'formatAnswer uses formatter');

console.log('\nD. Phrase routing');

const {
  resolveAskLunaFreeBedsIntentKey,
  getAskLunaFreeBedsOnNightQuery,
  formatAskLunaFreeBedsAnswer,
  buildFreeBedsByRoom,
  SNAPSHOT_CAVEAT,
  FREE_BEDS_TONIGHT_KEY,
  FREE_BEDS_TOMORROW_NIGHT_KEY,
} = require('./lib/staff-ask-luna-free-beds');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');

const REF_THU = new Date('2026-06-04T12:00:00Z');

const PHRASES = [
  ['Which beds are free tonight?', FREE_BEDS_TONIGHT_KEY],
  ['What beds are available tonight?', FREE_BEDS_TONIGHT_KEY],
  ['How many beds are free tonight?', FREE_BEDS_TONIGHT_KEY],
  ['Which rooms have free beds tonight?', FREE_BEDS_TONIGHT_KEY],
  ['Which beds are free tomorrow night?', FREE_BEDS_TOMORROW_NIGHT_KEY],
  ['What beds are available tomorrow night?', FREE_BEDS_TOMORROW_NIGHT_KEY],
  ['How many beds are free tomorrow night?', FREE_BEDS_TOMORROW_NIGHT_KEY],
  ['Which rooms have free beds tomorrow night?', FREE_BEDS_TOMORROW_NIGHT_KEY],
  ['inventory.free_beds_tonight', FREE_BEDS_TONIGHT_KEY],
  ['inventory.free_beds_tomorrow_night', FREE_BEDS_TOMORROW_NIGHT_KEY],
];

for (const [phrase, expected] of PHRASES) {
  const got = resolveAskLunaFreeBedsIntentKey(phrase, REGISTRY_BY_KEY, REF_THU);
  check(got && got.intentKey === expected, `routes "${phrase}" → ${expected}`);
  check(got && got.extraParams.date, `date param for "${phrase}"`);
}

const tonight = resolveAskLunaFreeBedsIntentKey('Which beds are free tonight?', REGISTRY_BY_KEY, REF_THU);
check(tonight && tonight.extraParams.date === '2026-06-04', 'tonight date');
const tomorrow = resolveAskLunaFreeBedsIntentKey(
  'How many beds are free tomorrow night?', REGISTRY_BY_KEY, REF_THU,
);
check(tomorrow && tomorrow.extraParams.date === '2026-06-05', 'tomorrow night date');

const notStaying = resolveAskLunaFreeBedsIntentKey(
  'Who is staying tonight?', REGISTRY_BY_KEY, REF_THU,
);
check(notStaying === null, 'staying tonight routes to occupancy not free beds');

console.log('\nE. Formatter');

const sampleRows = [
  { room_code: 'R1', bed_code: 'B3' },
  { room_code: 'R1', bed_code: 'B4' },
  { room_code: 'R3', bed_code: 'B1' },
  { room_code: 'R3', bed_code: 'B2' },
  { room_code: 'R3', bed_code: 'B5' },
  { room_code: 'R7', bed_code: 'B1' },
  { room_code: 'R10', bed_code: 'B2' },
  { room_code: 'R10', bed_code: 'B3' },
];

const groups = buildFreeBedsByRoom(sampleRows);
check(groups.freeBedCount === 8, 'groups: 8 free beds');
check(groups.roomsWithFreeBeds === 4, 'groups: 4 rooms with free beds');
check(groups.rooms.find((r) => r.room_code === 'R1').beds.length === 2, 'R1 has 2 beds');

const answer = formatAskLunaFreeBedsAnswer(sampleRows, { nightLabel: 'tonight' });
check(answer.includes('8 free beds across 4 rooms'), 'answer headline totals');
check(answer.includes('R1: B3, B4'), 'answer room R1 bed list');
check(answer.includes('R3: B1, B2, B5'), 'answer room R3 bed list');
check(answer.includes(SNAPSHOT_CAVEAT), 'answer includes snapshot caveat');

const empty = formatAskLunaFreeBedsAnswer([], { nightLabel: 'tonight' });
check(empty.includes('No sellable beds appear free tonight'), 'empty tonight message');
check(empty.includes(SNAPSHOT_CAVEAT), 'empty answer includes caveat');

const sql = getAskLunaFreeBedsOnNightQuery();
check(sql.includes('sellable_beds'), 'query CTE sellable_beds from inventory');
check(sql.includes('occupied_beds'), 'query CTE occupied_beds');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
