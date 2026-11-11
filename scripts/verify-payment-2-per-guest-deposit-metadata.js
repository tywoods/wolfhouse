'use strict';

const assert = require('node:assert/strict');
const {
  buildGuestPaymentAmountsMap,
  overlayPerPersonFromGuests,
  paymentLinkIntendedAmountCents,
} = require('./lib/payment-ledger-stale-links');

const guestId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const staleQuote = [{
  booking_guest_id: guestId,
  guest_number: 1,
  deposit_cents: 0,
  amount_paid_cents: 0,
  payment_status: 'not_requested',
  subtotal_cents: 20000,
}];
const liveGuests = [{
  booking_guest_id: guestId,
  guest_number: 1,
  deposit_amount_cents: 10000,
  amount_paid_cents: 10000,
  payment_status: 'paid',
  metadata: { subtotal_cents: 20000 },
}];

const map = buildGuestPaymentAmountsMap(liveGuests, staleQuote);
assert.equal(map[guestId].deposit_cents, 10000, JSON.stringify(map));

const over = overlayPerPersonFromGuests(staleQuote, liveGuests);
assert.equal(over[0].payment_status, 'paid');
assert.equal(over[0].amount_paid_cents, 10000);
assert.equal(over[0].deposit_cents, 10000);

const unpaidGuests = [{
  booking_guest_id: guestId,
  guest_number: 1,
  deposit_amount_cents: 10000,
  amount_paid_cents: 0,
  payment_status: 'checkout_created',
  metadata: { subtotal_cents: 20000 },
}];
const intended = paymentLinkIntendedAmountCents({
  payment_kind: 'deposit_only',
  amount_due_cents: 10000,
  booking_guest_id: guestId,
  metadata: { source: 'bot_guest_payment_link_slice_a', payment_target: 'deposit', booking_guest_id: guestId },
}, {
  deposit_required_cents: 30000,
  guest_amounts_by_id: buildGuestPaymentAmountsMap(unpaidGuests, staleQuote),
});
assert.equal(intended, 10000, 'payment-link path must use guest row €100, not stale quote €0');

console.log('verify-payment-2-per-guest-deposit-metadata: PASS');
