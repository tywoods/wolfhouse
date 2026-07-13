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

console.log(`\n── verify:sunset-payment-short-link ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
if (fail > 0) process.exit(1);
