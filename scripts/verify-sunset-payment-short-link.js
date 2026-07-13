'use strict';

/**
 * verify:sunset-payment-short-link
 *
 * Sunset compact /pay/<booking_code> guest URLs — not raw checkout.stripe.com.
 *
 * Run: node scripts/verify-sunset-payment-short-link.js
 */

const {
  attachGuestPaymentFields,
  sunsetPaymentLinkObservability,
  SUNSET_STAGING_PUBLIC_PAYMENT_BASE,
} = require('./lib/sunset-stripe-payment-links');
const {
  buildPaymentShortLink,
  resolvePaymentShortLinkRedirect,
  resolvePublicPaymentBaseUrl,
  bookingRowIsInactiveForPayment,
} = require('./lib/luna-payment-short-link');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

console.log('\nverify:sunset-payment-short-link\n');

const bookingCode = 'SUNSET-20260802-ABC123';
const stripeUrl = 'https://checkout.stripe.com/c/pay/cs_test_sunset123';

console.log('[1] Observability fields');
const obs = sunsetPaymentLinkObservability(bookingCode, stripeUrl, 'cs_test_sunset123', {});
assert('payment_short_url ends with /pay/<code>', obs.payment_short_url === `${SUNSET_STAGING_PUBLIC_PAYMENT_BASE}/pay/${bookingCode}`, obs.payment_short_url);
assert('guest_payment_url is compact', obs.guest_payment_url === obs.payment_short_url);
assert('guest URL not raw Stripe', !obs.guest_payment_url.includes('checkout.stripe.com'));
assert('raw checkout preserved for redirect', obs.stripe_checkout_url_present === true);

console.log('\n[2] attachGuestPaymentFields');
const body = attachGuestPaymentFields({ success: true, booking_code: bookingCode }, bookingCode, stripeUrl, 'cs_test_sunset123', {});
assert('body guest_payment_url compact', body.guest_payment_url && body.guest_payment_url.endsWith(`/pay/${bookingCode}`));
assert('body checkout_url still raw Stripe', body.checkout_url === stripeUrl);
assert('secure path via guest_payment_url not stripe', body.guest_payment_url !== stripeUrl);

console.log('\n[3] Redirect resolver uses stored checkout');
const redirect = resolvePaymentShortLinkRedirect({
  booking_code: bookingCode,
  client_slug: 'sunset',
  booking_row: { payment_status: 'waiting_payment', amount_paid_cents: 0, balance_due_cents: 4500, total_amount_cents: 4500 },
  payment_rows: [{
    payment_status: 'checkout_created',
    checkout_url: stripeUrl,
    stripe_checkout_session_id: 'cs_test_sunset123',
    amount_due_cents: 4500,
    amount_paid_cents: 0,
  }],
  env: { STRIPE_SECRET_KEY: 'sk_test_x' },
});
assert('redirect resolves to Stripe checkout', redirect.status === 'redirect' && redirect.redirect_url === stripeUrl);
assert('redirect exposes compact short url', redirect.payment_short_url && redirect.payment_short_url.includes(`/pay/${bookingCode}`));

console.log('\n[4] Invalid booking code fails closed');
const bad = resolvePaymentShortLinkRedirect({ booking_code: 'NOT-A-VALID-CODE!!!' });
assert('invalid token rejected', bad.status === 'invalid_token');

console.log('\n[5] Sunset messaging config base URL');
const base = resolvePublicPaymentBaseUrl({ client_slug: 'sunset' });
assert('sunset config resolves staging base', base === SUNSET_STAGING_PUBLIC_PAYMENT_BASE, base);

const short = buildPaymentShortLink({ booking_code: bookingCode, client_slug: 'sunset' });
assert('buildPaymentShortLink for sunset tenant', short && short.endsWith(`/pay/${bookingCode}`));

console.log('\n[6] Cancelled booking must not redirect (fail-closed)');
const activeCheckoutRow = {
  payment_status: 'checkout_created',
  checkout_url: stripeUrl,
  stripe_checkout_session_id: 'cs_test_sunset123',
  amount_due_cents: 12000,
  amount_paid_cents: 0,
};
const cancelledBookingRow = {
  status: 'cancelled',
  payment_status: 'payment_link_sent',
  amount_paid_cents: 0,
  balance_due_cents: 12000,
  total_amount_cents: 12000,
};

const preFixWouldRedirect = resolvePaymentShortLinkRedirect({
  booking_code: bookingCode,
  client_slug: 'sunset',
  booking_row: { ...cancelledBookingRow, status: 'confirmed' },
  payment_rows: [activeCheckoutRow],
  env: { STRIPE_SECRET_KEY: 'sk_test_x' },
});
assert('RED baseline: active booking still redirects', preFixWouldRedirect.status === 'redirect' && preFixWouldRedirect.redirect_url === stripeUrl);

const cancelledBlocked = resolvePaymentShortLinkRedirect({
  booking_code: bookingCode,
  client_slug: 'sunset',
  booking_row: cancelledBookingRow,
  payment_rows: [activeCheckoutRow],
  env: { STRIPE_SECRET_KEY: 'sk_test_x' },
});
assert('cancelled booking inactive', cancelledBlocked.status === 'inactive');
assert('cancelled booking no redirect_url', !cancelledBlocked.redirect_url);
assert('cancelled booking no payment_id', cancelledBlocked.payment_id == null);
assert('cancelled booking no stripe_session_id', cancelledBlocked.stripe_session_id == null);
assert('cancelled message', /no longer active/i.test(cancelledBlocked.message));

const canceledSpelling = resolvePaymentShortLinkRedirect({
  booking_code: bookingCode,
  booking_row: { ...cancelledBookingRow, status: 'canceled' },
  payment_rows: [activeCheckoutRow],
});
assert('canceled spelling inactive', canceledSpelling.status === 'inactive' && !canceledSpelling.redirect_url);

const expiredBooking = resolvePaymentShortLinkRedirect({
  booking_code: bookingCode,
  booking_row: { ...cancelledBookingRow, status: 'expired' },
  payment_rows: [activeCheckoutRow],
});
assert('expired booking inactive', expiredBooking.status === 'inactive');

const activeStill = resolvePaymentShortLinkRedirect({
  booking_code: bookingCode,
  booking_row: { status: 'confirmed', payment_status: 'payment_link_sent', amount_paid_cents: 0, balance_due_cents: 12000, total_amount_cents: 12000 },
  payment_rows: [activeCheckoutRow],
  env: { STRIPE_SECRET_KEY: 'sk_test_x' },
});
assert('active booking still redirects', activeStill.status === 'redirect');

const paidUnchanged = resolvePaymentShortLinkRedirect({
  booking_code: bookingCode,
  booking_row: { status: 'confirmed', payment_status: 'paid', amount_paid_cents: 12000, balance_due_cents: 0, total_amount_cents: 12000 },
  payment_rows: [{ payment_status: 'paid', amount_paid_cents: 12000, checkout_url: stripeUrl }],
});
assert('paid behavior unchanged', paidUnchanged.status === 'paid');

const missing = resolvePaymentShortLinkRedirect({ booking_code: bookingCode, booking_row: null, payment_rows: [] });
assert('missing booking not_found', missing.status === 'not_found');

assert('helper detects cancelled', bookingRowIsInactiveForPayment({ status: 'cancelled' }));

console.log(`\n── verify:sunset-payment-short-link ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail > 0) process.exit(1);
