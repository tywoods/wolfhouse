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

console.log('PASS verify-luna-pay-amount-switch deposit/full/deposit', seen.join('→'));
