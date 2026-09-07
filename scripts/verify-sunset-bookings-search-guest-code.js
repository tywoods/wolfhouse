'use strict';

/**
 * Bookings search must match guest name / booking code substrings — not flood
 * unrelated rows via incidental digits extracted from a name query.
 *
 * Bug Finder P1 (sunset-staging 2026-09-07): searching "BF Deep 7 Sep" returned
 * dozens of unrelated bookings because digitsOnly("BF Deep 7 Sep") === "7" and
 * phoneDigits.includes("7") matched almost every Spanish mobile.
 *
 * Owner: scripts/lib/sunset-bookings-admin.js (bookingMatchesSearch).
 * Stay off inbox-thread, email inbound/poller, Luna Personality / Hermes.
 */

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const {
  bookingMatchesSearch,
  filterBookingRows,
  parseListQuery,
} = require(path.join(ROOT, 'scripts/lib/sunset-bookings-admin.js'));

function row(overrides) {
  return Object.assign({
    booking_code: 'SUNSET-OTHER',
    guest_name: 'Unrelated Guest',
    phone: '+34612345678',
    service_dates: ['2026-09-07'],
    service_date_start: '2026-09-07',
    hidden: false,
    status: 'confirmed',
  }, overrides || {});
}

const LABEL = 'BF Deep 7 Sep';
const MATCHING = [
  row({
    booking_code: 'SUNSET-20260907-1FFEA5',
    guest_name: LABEL + ' Alpha',
    phone: '+34600111222',
  }),
  row({
    booking_code: 'SUNSET-20260907-70FB2A',
    guest_name: LABEL,
    phone: '+34777777777',
  }),
  row({
    booking_code: 'SUNSET-20260907-ED3B34',
    guest_name: 'Prefix ' + LABEL + ' Suffix',
    phone: null,
  }),
];
const UNRELATED_WITH_DIGIT_7 = [
  row({ booking_code: 'SUNSET-NOISE-A', guest_name: 'Alice', phone: '+34677777777' }),
  row({ booking_code: 'SUNSET-NOISE-B', guest_name: 'Bob', phone: '+34612345678' }),
  row({ booking_code: 'SUNSET-NOISE-C', guest_name: 'Carol', phone: '+34987654321' }),
  row({ booking_code: 'SUNSET-NOISE-D', guest_name: 'Dana', phone: '+34111111111' }),
];
const rows = MATCHING.concat(UNRELATED_WITH_DIGIT_7);

// ── 1) Core regression: name label must not phone-flood ──
assert.strictEqual(
  bookingMatchesSearch(MATCHING[0], LABEL),
  true,
  'guest-name substring matches'
);
assert.strictEqual(
  bookingMatchesSearch(UNRELATED_WITH_DIGIT_7[0], LABEL),
  false,
  'phone containing digit 7 must NOT match name query with incidental 7'
);
assert.strictEqual(
  bookingMatchesSearch(UNRELATED_WITH_DIGIT_7[1], LABEL),
  false,
  'phone containing digit 7 (middle) must NOT match name query'
);

const filtered = filterBookingRows(rows, { q: LABEL });
assert.strictEqual(filtered.length, MATCHING.length, 'only guest/code matches');
assert.deepStrictEqual(
  filtered.map((r) => r.booking_code).sort(),
  MATCHING.map((r) => r.booking_code).sort()
);

// Code substring still works (distinctive fragment).
const byCode = filterBookingRows(rows, { q: '1FFEA5' });
assert.strictEqual(byCode.length, 1);
assert.strictEqual(byCode[0].booking_code, 'SUNSET-20260907-1FFEA5');

// ── 2) Phone-shaped queries still match (product placeholder advertises phone) ──
assert.strictEqual(
  bookingMatchesSearch(row({ phone: '+34612345678' }), '612345678'),
  true,
  'digit-only phone query still matches'
);
assert.strictEqual(
  bookingMatchesSearch(row({ phone: '+34612345678' }), '+34 612 345 678'),
  true,
  'punctuated phone query still matches'
);
assert.strictEqual(
  bookingMatchesSearch(row({ phone: '+34612345678' }), '12'),
  false,
  '1–2 digit queries must not phone-flood'
);
assert.strictEqual(
  bookingMatchesSearch(row({ phone: '+34612345678' }), '7'),
  false,
  'single digit must not phone-flood'
);

// ── 3) Empty / whitespace query is a no-op (show all) ──
assert.strictEqual(filterBookingRows(rows, { q: '' }).length, rows.length);
assert.strictEqual(filterBookingRows(rows, { q: '   ' }).length, rows.length);
assert.strictEqual(bookingMatchesSearch(rows[0], ''), true);

// ── 4) parseListQuery preserves distinctive guest labels ──
const parsed = parseListQuery({ q: LABEL });
assert.strictEqual(parsed.q, LABEL);

console.log('verify-sunset-bookings-search-guest-code: PASS');
