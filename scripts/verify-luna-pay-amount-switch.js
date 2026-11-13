'use strict';

/**
 * Deposit ↔ full must change the /pay amount.
 * Usage: node scripts/verify-luna-pay-amount-switch.js
 */

const assert = require('assert');
const {
  savedPayAmountCents,
  findLatestActiveCheckoutPayment,
  resolvePaymentShortLinkRedirect,
  shouldReplacePayAmount,
} = require('./lib/luna-payment-short-link');

const TOTAL = 41500;
const DEPOSIT = 20000;
const BOOKING = {
  booking_code: 'WH-20270615-14908309',
  booking_status: 'pending',
  total_amount_cents: TOTAL,
  deposit_required_cents: DEPOSIT,
  amount_paid_cents: 0,
};

function row(amount, url) {
  return {
    payment_id: `pay-${amount}`,
    payment_status: 'checkout_created',
    amount_due_cents: amount,
    checkout_url: url,
    payment_kind: amount === TOTAL ? 'full_amount' : 'deposit_only',
  };
}

const FULL_URL = 'https://checkout.stripe.com/c/pay/cs_test_full415';
const DEPOSIT_URL = 'https://checkout.stripe.com/c/pay/cs_test_dep200';

function payAmountForChoice(choice) {
  const booking = { ...BOOKING, payment_choice: choice };
  const wanted = savedPayAmountCents(booking, choice);
  const rows = [row(TOTAL, FULL_URL), row(DEPOSIT, DEPOSIT_URL)];
  const resolved = resolvePaymentShortLinkRedirect({
    token: BOOKING.booking_code,
    booking_code: BOOKING.booking_code,
    booking_row: booking,
    payment_rows: rows,
    env: { ALLOW_LIVE_PAYMENT_REDIRECT: 'false' },
  });
  assert.strictEqual(resolved.status, 'redirect', `choice ${choice} should redirect`);
  assert.strictEqual(
    resolved.redirect_url,
    choice === 'full' ? FULL_URL : DEPOSIT_URL,
    `choice ${choice} must hit the matching session`,
  );
  const picked = findLatestActiveCheckoutPayment(rows, null, { amount_due_cents: wanted });
  return picked.row.amount_due_cents;
}

assert.strictEqual(savedPayAmountCents(BOOKING, 'deposit'), DEPOSIT);
assert.strictEqual(savedPayAmountCents(BOOKING, 'full'), TOTAL);

const seen = ['deposit', 'full', 'deposit'].map(payAmountForChoice);
assert.deepStrictEqual(seen, [DEPOSIT, TOTAL, DEPOSIT], 'deposit→full→deposit pay amounts');

const G1_SHARE = 10000;
const G1_URL = 'https://checkout.stripe.com/c/pay/cs_test_g1share';
const g1Row = {
  payment_id: 'pay-g1',
  payment_status: 'checkout_created',
  amount_due_cents: G1_SHARE,
  checkout_url: G1_URL,
  payment_kind: 'deposit_only',
  booking_guest_id: 'guest-1',
  metadata: { guest_number: 1 },
};
const bookingFull = { ...BOOKING, payment_choice: 'full' };
const g1Resolved = resolvePaymentShortLinkRedirect({
  token: BOOKING.booking_code,
  booking_code: BOOKING.booking_code,
  guest_number: 1,
  booking_row: bookingFull,
  payment_rows: [row(TOTAL, FULL_URL), g1Row],
  env: { ALLOW_LIVE_PAYMENT_REDIRECT: 'false' },
});
assert.strictEqual(g1Resolved.status, 'redirect', 'per-guest /g1 must stay active');
assert.strictEqual(g1Resolved.redirect_url, G1_URL, 'per-guest /g1 is not the whole-booking session');
const g1Picked = findLatestActiveCheckoutPayment(
  [row(TOTAL, FULL_URL), g1Row],
  null,
  { guest_number: 1, amount_due_cents: TOTAL },
);
assert.ok(g1Picked && g1Picked.row.amount_due_cents === G1_SHARE, 'amount filter skipped for /g1');

const SHARE = 10000;
const shareRow = {
  payment_id: 'pay-share',
  payment_status: 'checkout_created',
  amount_due_cents: SHARE,
  checkout_url: G1_URL,
  payment_kind: 'deposit_only',
  booking_guest_id: 'guest-1',
};
assert.strictEqual(
  shouldReplacePayAmount(shareRow, DEPOSIT),
  false,
  'per-guest €100 share must not become the €200 deposit',
);
const wholeBookingFromShare = findLatestActiveCheckoutPayment(
  [shareRow, row(DEPOSIT, DEPOSIT_URL)],
  null,
  { amount_due_cents: DEPOSIT },
);
assert.ok(wholeBookingFromShare);
assert.strictEqual(
  wholeBookingFromShare.row.amount_due_cents,
  DEPOSIT,
  'whole-booking /pay uses the deposit row, not the €100 share',
);

const draftDeposit = {
  payment_id: 'pay-draft',
  payment_status: 'draft',
  amount_due_cents: DEPOSIT,
  checkout_url: null,
  payment_kind: 'deposit_only',
};
assert.strictEqual(
  shouldReplacePayAmount(draftDeposit, TOTAL),
  true,
  'together then full must retarget a €200 DRAFT to €415',
);
assert.strictEqual(savedPayAmountCents(BOOKING, 'full'), TOTAL);

const STAY_300 = 30000;
const STAY_URL = 'https://checkout.stripe.com/c/pay/cs_test_stay300';
const stayGuestBound = {
  payment_id: 'pay-stay-lead',
  payment_status: 'checkout_created',
  amount_due_cents: STAY_300,
  checkout_url: STAY_URL,
  payment_kind: 'deposit_only',
  booking_guest_id: 'lead-guest',
};
const stayResolved = resolvePaymentShortLinkRedirect({
  token: BOOKING.booking_code,
  booking_code: BOOKING.booking_code,
  booking_row: { ...BOOKING, total_amount_cents: STAY_300, deposit_required_cents: STAY_300, payment_choice: 'deposit' },
  payment_rows: [g1Row, stayGuestBound],
  env: { ALLOW_LIVE_PAYMENT_REDIRECT: 'false' },
});
assert.strictEqual(stayResolved.status, 'redirect', 'whole-booking /pay/{code} must resolve');
assert.strictEqual(stayResolved.redirect_url, STAY_URL, 'guest-bound stay row is the €300 checkout, not undefined');
const stayPicked = findLatestActiveCheckoutPayment(
  [g1Row, stayGuestBound],
  null,
  { amount_due_cents: STAY_300 },
);
assert.ok(stayPicked && stayPicked.row.amount_due_cents === STAY_300, 'stay row with booking_guest_id still matches /pay/{code}');

console.log('PASS verify-luna-pay-amount-switch deposit/full/deposit', seen.join('→'));
console.log('PASS per-guest /g1 stays active at', G1_SHARE);
