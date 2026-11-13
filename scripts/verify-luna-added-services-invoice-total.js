'use strict';

/**
 * Luna-added yoga/rentals must roll into invoice total + balance due.
 * WH-20271015-01957358 class: 2× Malibu €415 + Yoga 2×€15 → €445.
 *
 * Usage: node scripts/verify-luna-added-services-invoice-total.js
 */

const assert = require('assert');
const {
  bookingLedgerInvoicePaidBalance,
  snapshotStayOnly,
} = require('./lib/booking-invoice-totals');

const ACC = 41500;
const YOGA = 3000; // 2 × €15
const RENTAL = 5000;
const BOOKING_ID = 'saved-yoga-services-1';
const BOOKING_CODE = 'WH-TEST-YOGA-445';

const staySnapshot = {
  total_cents: ACC,
  line_items: [
    { code: 'guest_package', total_cents: 20750 },
    { code: 'guest_package', total_cents: 20750 },
  ],
};

assert.strictEqual(snapshotStayOnly(staySnapshot), true, 'Malibu guest_package lines are stay-only');

function savedBooking(snapshot) {
  return {
    booking_id: BOOKING_ID,
    booking_code: BOOKING_CODE,
    total_amount_cents: ACC,
    amount_paid_cents: 0,
    deposit_required_cents: 20000,
    metadata: { quote_snapshot: snapshot },
  };
}

// INSERT-shaped saved booking (create wrote €415). Luna later added yoga
// without invoice_total_inclusion=additional (addon-requests/create path).
const inserted = savedBooking(staySnapshot);
assert.ok(inserted.booking_id, 'saved booking_id');
assert.ok(inserted.booking_code, 'saved booking_code');

const yogaOnly = bookingLedgerInvoicePaidBalance(inserted, YOGA, 0, 0, 0);
assert.strictEqual(yogaOnly.invoice_total_cents, ACC + YOGA, 'invoice = stay + yoga');
assert.strictEqual(yogaOnly.balance_due_cents, ACC + YOGA, 'balance due includes yoga');

const yogaAndRental = bookingLedgerInvoicePaidBalance(inserted, YOGA + RENTAL, 0, 0, 0);
assert.strictEqual(
  yogaAndRental.invoice_total_cents,
  ACC + YOGA + RENTAL,
  'invoice = stay + yoga + rental',
);
assert.strictEqual(
  yogaAndRental.balance_due_cents,
  ACC + YOGA + RENTAL,
  'balance due includes rentals',
);

// Quote that already priced yoga must not double-count (snapshot not stay-only).
const withYogaLine = {
  total_cents: ACC + YOGA,
  line_items: [
    { code: 'guest_package', total_cents: 20750 },
    { code: 'guest_package', total_cents: 20750 },
    { code: 'yoga_class', total_cents: YOGA },
  ],
};
assert.strictEqual(snapshotStayOnly(withYogaLine), false);
const pricedAtCreate = bookingLedgerInvoicePaidBalance(
  {
    booking_id: BOOKING_ID,
    booking_code: BOOKING_CODE,
    total_amount_cents: ACC + YOGA,
    metadata: { quote_snapshot: withYogaLine },
  },
  YOGA,
  0,
  0,
  0,
);
assert.strictEqual(
  pricedAtCreate.invoice_total_cents,
  ACC + YOGA,
  'create-time yoga already in total is not added twice',
);

console.log('PASS verify-luna-added-services-invoice-total', {
  booking_id: BOOKING_ID,
  booking_code: BOOKING_CODE,
  stay: ACC,
  stay_plus_yoga: yogaOnly.invoice_total_cents,
  stay_plus_yoga_rental: yogaAndRental.invoice_total_cents,
});
