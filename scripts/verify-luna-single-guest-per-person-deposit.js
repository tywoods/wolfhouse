'use strict';

/**
 * Solo Luna bookings must persist the real per-guest deposit, package_code and
 * subtotal. Groups already store €200/guest — do not change them.
 *
 * Independent expected values (Staff Pricing short €100 / long €200 per person):
 *   1 guest, 3-night stay-only → deposit €100, one per_person row
 *   2 guests, 7-night malibu   → each deposit €200 (unchanged)
 */

const assert = require('node:assert/strict');
const {
  calculateWolfhouseQuote: calculateWolfhouseQuoteRaw,
  loadConfig,
} = require('./lib/wolfhouse-quote-calculator');
const { applyAuthoritativeSeasonsToConfig } = require('./lib/wolfhouse-pricing-resolve');
const {
  insertBookingGuestsForBooking,
  buildPerPersonBreakdown,
} = require('./lib/booking-guests');
const {
  wolfhouseBookingDepositCents,
} = require('./lib/wolfhouse-stay-deposit');

const pricingFixture = applyAuthoritativeSeasonsToConfig(loadConfig(), [
  { code: 'summer', label: 'Summer', priority: 0, sort_order: 1, bookable: true, active: true,
    ranges: [{ start_month: 7, start_day: 1, end_month: 7, end_day: 31 }] },
  { code: 'august', label: 'August', priority: 10, sort_order: 2, bookable: true, active: true,
    ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }] },
]);
function calculateWolfhouseQuote(input) {
  return calculateWolfhouseQuoteRaw(input, pricingFixture);
}

const SOLO_SHORT_DEPOSIT_CENTS = 10000; // €100 short-stay per person
const GROUP_LONG_DEPOSIT_CENTS = 20000; // €200 long-stay per person

function soloShortQuote() {
  return calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-07-10',
    check_out: '2026-07-13',
    guest_count: 1,
    package_code: 'package_none',
    payment_choice: 'deposit',
    uses_per_guest_deposits: false,
  });
}

function groupLongQuote() {
  return calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-08-01',
    check_out: '2026-08-08',
    guest_count: 2,
    package_code: 'malibu',
    payment_choice: 'deposit',
    uses_per_guest_deposits: true,
  });
}

function fakePg(capture) {
  return {
    async query(sql, params) {
      if (/INSERT INTO booking_guests/i.test(String(sql))) {
        capture.push({
          deposit_amount_cents: params[6],
          metadata: JSON.parse(params[7]),
        });
        return {
          rows: [{
            booking_guest_id: 'g-solo',
            guest_number: params[2],
            guest_name: params[3],
            deposit_amount_cents: params[6],
            payment_status: 'not_requested',
          }],
        };
      }
      return { rows: [] };
    },
  };
}

async function main() {
  const solo = soloShortQuote();
  assert.equal(solo.success, true, 'solo quote succeeds');
  assert.equal(solo.deposit_required_cents, SOLO_SHORT_DEPOSIT_CENTS,
    'solo booking deposit is the €100 short-stay tier');
  assert.ok(Array.isArray(solo.per_person), 'solo quote emits per_person');
  assert.equal(solo.per_person.length, 1, 'solo per_person has one row');
  const row = solo.per_person[0];
  assert.equal(row.guest_number, 1);
  assert.equal(row.deposit_cents, SOLO_SHORT_DEPOSIT_CENTS,
    'solo per_person deposit is €100, not omitted/0');
  assert.equal(typeof row.package_code, 'string');
  assert.ok(row.package_code.trim(), 'solo per_person has package_code');
  assert.equal(typeof row.subtotal_cents, 'number');
  assert.ok(Number.isInteger(row.subtotal_cents) && row.subtotal_cents > 0,
    'solo per_person has a positive subtotal');

  const inserted = [];
  const guests = await insertBookingGuestsForBooking(fakePg(inserted), {
    clientId: 'client-1',
    bookingId: 'bk-solo',
    guests: [{ guest_number: 1, guest_name: 'Sam' }],
    bedAssignments: [],
    perPersonBreakdown: solo.per_person,
  });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].deposit_amount_cents, SOLO_SHORT_DEPOSIT_CENTS,
    'INSERT stores solo deposit_amount_cents, not 0');
  assert.equal(inserted[0].metadata.package_code, row.package_code,
    'INSERT stores solo package_code, not null');
  assert.equal(inserted[0].metadata.subtotal_cents, row.subtotal_cents,
    'INSERT stores solo subtotal_cents, not null');
  assert.equal(guests[0].deposit_amount_cents, SOLO_SHORT_DEPOSIT_CENTS);

  const financials = wolfhouseBookingDepositCents({
    guest_count: 1,
    check_in: '2026-07-10',
    check_out: '2026-07-13',
    package_code: row.package_code,
    metadata: { quote_snapshot: { per_person: solo.per_person, package_code: row.package_code } },
  }, { nights_threshold: 6, long_stay_cents: 20000, short_stay_cents: 10000, source: 'admin_pricing' });
  assert.equal(financials, SOLO_SHORT_DEPOSIT_CENTS,
    'financials deposit_required_cents is €100, not null/unknown:required_owner_input');

  const emptyBreakdown = [];
  await insertBookingGuestsForBooking(fakePg(emptyBreakdown), {
    clientId: 'client-1',
    bookingId: 'bk-fallback',
    guests: [{ guest_number: 1, guest_name: 'Eva' }],
    bedAssignments: [],
    perPersonBreakdown: [],
    quote: solo,
  });
  assert.equal(emptyBreakdown[0].deposit_amount_cents, SOLO_SHORT_DEPOSIT_CENTS,
    'INSERT fallback uses quote deposit when per_person row is missing, not 0');
  assert.equal(emptyBreakdown[0].metadata.package_code, solo.package_code || row.package_code);
  assert.ok(Number.isInteger(emptyBreakdown[0].metadata.subtotal_cents)
    && emptyBreakdown[0].metadata.subtotal_cents > 0);

  const group = groupLongQuote();
  assert.equal(group.success, true);
  assert.equal(group.per_person.length, 2, 'group per_person unchanged (2 rows)');
  assert.ok(group.per_person.every((p) => p.deposit_cents === GROUP_LONG_DEPOSIT_CENTS),
    'group still stores €200 per guest');

  const rebuilt = buildPerPersonBreakdown(group, { guest_names: ['A', 'B'], payment_choice: 'deposit' });
  assert.equal(rebuilt.length, 2);
  assert.ok(rebuilt.every((p) => p.deposit_cents === GROUP_LONG_DEPOSIT_CENTS
    || p.deposit_cents === group.deposit_required_cents),
    'group breakdown still has real deposits');

  console.log(JSON.stringify({
    ok: true,
    solo_deposit_cents: inserted[0].deposit_amount_cents,
    solo_package_code: inserted[0].metadata.package_code,
    solo_subtotal_cents: inserted[0].metadata.subtotal_cents,
    financials_deposit_cents: financials,
    group_deposits: group.per_person.map((p) => p.deposit_cents),
  }));
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
