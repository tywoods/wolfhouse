'use strict';

/**
 * verify:sunset-bot-booking-cancel-payments
 *
 * Bot test-booking cancel must neutralize unpaid checkout rows (including
 * idempotent re-cancel) without touching paid rows.
 *
 * Run: node scripts/verify-sunset-bot-booking-cancel-payments.js
 */

const fs = require('fs');
const path = require('path');
const {
  paymentRowEligibleForBotCancelNeutralization,
  paymentRowProtectedFromBotCancelNeutralization,
  buildBotTestBookingCancelPaymentMetadata,
  isStripeTestCheckoutSessionId,
} = require('./lib/bot-test-booking-cancel-payments');

const ROOT = path.join(__dirname, '..');
const STAFF = path.join(__dirname, 'staff-query-api.js');
const staffSrc = fs.readFileSync(STAFF, 'utf8');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

console.log('\nverify:sunset-bot-booking-cancel-payments\n');

console.log('[1] Eligibility — unpaid checkout rows');
const activeCheckout = {
  payment_status: 'checkout_created',
  amount_paid_cents: 0,
  checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_x',
};
assert('checkout_created eligible', paymentRowEligibleForBotCancelNeutralization(activeCheckout));
assert('draft eligible', paymentRowEligibleForBotCancelNeutralization({ ...activeCheckout, payment_status: 'draft' }));
assert('pending eligible', paymentRowEligibleForBotCancelNeutralization({ ...activeCheckout, payment_status: 'pending' }));

console.log('\n[2] Protected rows');
assert('paid protected', paymentRowProtectedFromBotCancelNeutralization({ payment_status: 'paid', amount_paid_cents: 100 }));
assert('partially_paid protected', paymentRowProtectedFromBotCancelNeutralization({ payment_status: 'partially_paid', amount_paid_cents: 50 }));
assert('paid cents protected even if status draft', paymentRowProtectedFromBotCancelNeutralization({ payment_status: 'draft', amount_paid_cents: 1 }));

console.log('\n[3] Already-cancelled row with checkout URL still neutralized');
assert(
  'cancelled + checkout_url eligible',
  paymentRowEligibleForBotCancelNeutralization({ payment_status: 'cancelled', amount_paid_cents: 0, checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_old' }),
);
assert(
  'cancelled without checkout not eligible',
  !paymentRowEligibleForBotCancelNeutralization({ payment_status: 'cancelled', amount_paid_cents: 0, checkout_url: null }),
);

console.log('\n[4] Cancel metadata');
const meta = buildBotTestBookingCancelPaymentMetadata();
assert('test_booking_cancelled flag', meta.test_booking_cancelled === true);
assert('cancel_reason', meta.cancel_reason === 'test_booking_cancelled');

console.log('\n[5] Stripe test session guard');
assert('cs_test allowed', isStripeTestCheckoutSessionId('cs_test_abc123'));
assert('cs_live refused', !isStripeTestCheckoutSessionId('cs_live_abc123'));

console.log('\n[6] Staff API wiring');
assert('neutralize helper exists', staffSrc.includes('neutralizeBotTestBookingUnpaidPayments'));
assert('idempotent path neutralizes (no early return before cleanup)', !staffSrc.includes("'Booking is already cancelled.'"));
assert('executeBotTestBookingCancel used', staffSrc.includes('executeBotTestBookingCancel'));
assert('clears checkout_url on neutralize', /checkout_url\s*=\s*NULL/.test(staffSrc));
assert('sets cancelled payment status', /status = 'cancelled'::payment_record_status/.test(staffSrc));
assert('stripe expire helper', staffSrc.includes('expireBotCancelStripeTestSession'));
assert('cancel metadata via helper import', staffSrc.includes('bot-test-booking-cancel-payments') && staffSrc.includes('buildBotTestBookingCancelPaymentMetadata'));

console.log(`\n── verify:sunset-bot-booking-cancel-payments ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail > 0) process.exit(1);
