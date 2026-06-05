/**
 * Phase 11g — Verifier for Staff Ask Luna booking / guest lookup.
 *
 * Usage:
 *   npm run verify:staff-ask-luna-booking-lookup
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const BL_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-booking-lookup.js');
const REG_FILE = path.join(__dirname, 'lib', 'staff-query-registry.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-ask-luna-booking-lookup.js  (Phase 11g)\n');

for (const f of [API_FILE, BL_FILE, REG_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const blSrc = fs.readFileSync(BL_FILE, 'utf8');
const regSrc = fs.readFileSync(REG_FILE, 'utf8');
const pkg    = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${BL_FILE}"`, { stdio: 'ignore' });
  ok('staff-ask-luna-booking-lookup.js passes node --check');
} catch (_) {
  fail('staff-ask-luna-booking-lookup.js passes node --check');
}

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-booking-lookup']
    === 'node scripts/verify-staff-ask-luna-booking-lookup.js',
  'package.json verify script',
);

console.log('\nA. Registry');
check(regSrc.includes("'bookings.lookup'"), 'registry: bookings.lookup');

console.log('\nB. Query — structured data, exclusions');
check(blSrc.includes('FROM bookings'), 'SQL uses bookings');
check(blSrc.includes('booking_beds'), 'SQL uses booking_beds');
check(blSrc.includes('booking_service_records'), 'SQL uses booking_service_records');
check(blSrc.includes('INNER JOIN clients'), 'SQL joins clients');
check(
  blSrc.includes("'cancelled', 'canceled', 'expired', 'hold'"),
  'guest/room/bed SQL excludes cancelled/canceled/expired/hold',
);
check(!blSrc.match(/FROM\s+conversations|message_log|chat_log/i), 'no chat/conversation log queries');
check(!blSrc.match(/\b(INSERT|UPDATE|DELETE)\b/i), 'no write SQL in lookup lib');
check(!blSrc.match(/stripe|whatsapp|n8n/i), 'lookup lib has no Stripe/WhatsApp/n8n');

console.log('\nC. Ask Luna wiring');
check(apiSrc.includes('resolveAskLunaBookingLookupIntentKey'), 'API uses booking lookup resolver');
check(apiSrc.includes('bookingLookupIntentEarly'), 'resolved before cleaning/arrivals');
check(apiSrc.includes("'bookings.lookup'"), 'ASK_LUNA_LOCAL_QUERY bookings.lookup');
check(apiSrc.includes('buildAskLunaBookingLookupQuery'), 'handler uses dynamic lookup query bundle');
check(apiSrc.includes('formatAskLunaBookingLookupAnswer'), 'formatAnswer uses formatter');

console.log('\nD. Phrase routing');

const {
  resolveAskLunaBookingLookupIntentKey,
  buildAskLunaBookingLookupQuery,
  formatAskLunaBookingLookupAnswer,
  dedupeBookings,
} = require('./lib/staff-ask-luna-booking-lookup');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');

const PHRASES = [
  ['Show Jimmy\'s booking', 'guest_name', 'Jimmy'],
  ['Find Anna\'s booking', 'guest_name', 'Anna'],
  ['What room is Jimmy in?', 'guest_name', 'Jimmy'],
  ['What bed is Anna in?', 'guest_name', 'Anna'],
  ['When does Jimmy check out?', 'guest_name', 'Jimmy'],
  ['When does Anna arrive?', 'guest_name', 'Anna'],
  ['Show booking WH-260615-ABCD', 'booking_code', 'WH-260615-ABCD'],
  ['Lookup WH-260615-ABCD', 'booking_code', 'WH-260615-ABCD'],
  ['Show booking MB-WOLFHO-20260920-b6f9c7', 'booking_code', 'MB-WOLFHO-20260920-B6F9C7'],
  ['Lookup MB-WOLFHO-20260920-b6f9c7', 'booking_code', 'MB-WOLFHO-20260920-B6F9C7'],
  ['Find booking MB-WOLFHO-20260920-b6f9c7', 'booking_code', 'MB-WOLFHO-20260920-B6F9C7'],
  ['show booking mb-wolfho-20260920-b6f9c7', 'booking_code', 'MB-WOLFHO-20260920-B6F9C7'],
  ['Who is in R1?', 'room', 'R1'],
  ['Who is in bed R2-B1?', 'bed', 'R2-B1'],
  ['bookings.lookup', null, null],
];

for (const [phrase, mode, value] of PHRASES) {
  const got = resolveAskLunaBookingLookupIntentKey(phrase, REGISTRY_BY_KEY);
  if (mode === null) {
    check(got && got.intentKey === 'unsupported_intent', `registry key alone → unsupported: ${phrase}`);
    continue;
  }
  check(got && got.intentKey === 'bookings.lookup', `routes "${phrase}" → bookings.lookup`);
  check(got.extraParams.lookupMode === mode, `mode ${mode} for "${phrase}"`);
  if (mode === 'guest_name') {
    check(
      got.extraParams.searchValue.toLowerCase() === value.toLowerCase(),
      `guest search ${value}`,
    );
  } else if (mode === 'booking_code') {
    check(got.extraParams.searchValue === value, `code ${value}`);
  } else if (mode === 'room') {
    check(got.extraParams.searchValue === value, `room ${value}`);
  } else if (mode === 'bed') {
    check(got.extraParams.roomCode === 'R2' && got.extraParams.bedCode === 'B1', 'bed R2-B1 parsed');
  }
}

const bundle = buildAskLunaBookingLookupQuery(
  { lookupMode: 'booking_code', searchValue: 'WH-260615-ABCD' },
  'wolfhouse-somo',
);
check(bundle.sql.includes('UPPER(b.booking_code)'), 'code query uses exact booking code match');
check(bundle.params.length === 2, 'code query param count');

console.log('\nE. Response format');

const empty = formatAskLunaBookingLookupAnswer([], { lookupMode: 'guest_name' });
check(empty.includes('couldn\'t find an active booking'), 'empty lookup message');

const multi = formatAskLunaBookingLookupAnswer([
  {
    guest_name: 'Anna Rossi',
    booking_code: 'WH-260615-ABCD',
    check_in: '2026-06-15',
    check_out: '2026-06-22',
    bed_summary: 'R2-B1',
  },
  {
    guest_name: 'Anna Müller',
    booking_code: 'WH-260620-EFGH',
    check_in: '2026-06-20',
    check_out: '2026-06-24',
    bed_summary: 'R4',
  },
], { lookupMode: 'guest_name', searchValue: 'Anna' });
check(multi.includes('2 active/upcoming bookings'), 'disambiguation header');
check(multi.includes('WH-260615-ABCD'), 'disambiguation booking code');
check(multi.includes('Please ask with the booking code'), 'disambiguation hint');

const single = formatAskLunaBookingLookupAnswer([
  {
    guest_name: 'Jimmy',
    booking_code: 'WH-260615-ABCD',
    guest_count: 2,
    check_in: '2026-06-15',
    check_out: '2026-06-22',
    booking_status: 'confirmed',
    payment_status: 'deposit_paid',
    balance_due_cents: 30000,
    bed_summary: 'R1',
    services_summary: '2 meals, 1 surf lesson',
  },
], { lookupMode: 'guest_name', lookupFocus: 'general' });
check(single.includes('Jimmy'), 'single includes guest');
check(single.includes('WH-260615-ABCD'), 'single includes booking code');
check(single.includes('Status:'), 'single includes status');
check(single.includes('Jun 15'), 'single includes dates');
check(single.includes('R1'), 'single includes room/bed');
check(single.includes('Deposit paid'), 'single includes payment');
check(single.includes('Services:'), 'single includes services');

const cancelled = formatAskLunaBookingLookupAnswer([
  {
    guest_name: 'Old Guest',
    booking_code: 'WH-260610-OLD',
    booking_status: 'cancelled',
    check_in: '2026-06-01',
    check_out: '2026-06-05',
    bed_summary: 'R9',
  },
], { lookupMode: 'booking_code' });
check(cancelled.includes('Cancelled'), 'code lookup shows cancelled status');

const roomOcc = formatAskLunaBookingLookupAnswer([
  {
    guest_name: 'Jimmy',
    booking_code: 'WH-260615-ABCD',
    check_in: '2026-06-15',
    check_out: '2026-06-22',
    bed_summary: 'R1-B1',
  },
  {
    guest_name: 'Marco',
    booking_code: 'WH-260616-EFGH',
    check_in: '2026-06-16',
    check_out: '2026-06-19',
    bed_summary: 'R1-B2',
  },
], { lookupMode: 'room', searchValue: 'R1' });
check(roomOcc.includes('R1 currently has 2'), 'room occupancy header');
check(roomOcc.includes('Total: 2'), 'room occupancy total');

check(dedupeBookings([
  { booking_code: 'A' },
  { booking_code: 'A' },
  { booking_code: 'B' },
]).length === 2, 'dedupe bookings by code');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
