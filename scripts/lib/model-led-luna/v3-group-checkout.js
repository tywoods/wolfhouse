'use strict';
const crypto = require('node:crypto');

const {
  buildPaymentLinkCommand: defaultBuild,
  createPaymentLink: defaultCreate,
  PAYMENT_LINK_CHANNELS,
  PAYMENT_LINK_OPERATIONS,
} = require('../luna-front-desk-payment-link-service');
const { validUrl } = require('../per-guest-checkout');

function error(code, status = 503) {
  const value = new Error(code); value.code = code; value.httpStatus = status; return value;
}
function providerIntentKey(args) {
  return `luna-v3:${crypto.createHash('sha256').update(JSON.stringify({
    bookingId: args.bookingId,
    paymentChoice: args.paymentChoice,
    operationKey: args.operationKey,
    principalId: args.principalId,
  })).digest('hex')}`;
}

function createBookingCheckoutAuthority(deps = {}) {
  const build = deps.buildPaymentLinkCommand || defaultBuild;
  const create = deps.createPaymentLink || defaultCreate;
  if (typeof deps.withPgClient !== 'function') throw error('booking_checkout_db_unavailable');
  async function createBookingCheckout(args) {
    const built = build({
      operation: PAYMENT_LINK_OPERATIONS.CREATE,
      channel: PAYMENT_LINK_CHANNELS.STAFF_PORTAL,
      trustedClientSlug: 'wolfhouse-somo',
      bookingId: args.bookingId,
      idempotencyKey: providerIntentKey(args),
      actor: { staff_user_id: args.principalId },
      target: 'booking',
      paymentChoice: args.paymentChoice,
      transportBody: { booking_id: args.bookingId, payment_target: args.paymentChoice === 'deposit' ? 'deposit' : 'balance' },
    });
    if (!built.ok) throw error(built.body.reason_code || 'booking_checkout_rejected', built.status || 400);
    const result = await deps.withPgClient(pg => create(pg, built.command, deps.paymentExecOpts || {}));
    if (!result || !result.ok) throw error(result && result.body && (result.body.reason_code || result.body.error) || 'booking_checkout_failed', result && result.status || 503);
    const body = result.body;
    const checkoutId = body.stripe_checkout_session_id;
    if (!checkoutId || typeof deps.readStripeCheckout !== 'function') throw error('provider_readback_unavailable');
    const provider = await deps.readStripeCheckout(checkoutId);
    const md = provider && provider.metadata || {};
    const valid = provider && provider.id === checkoutId && provider.livemode === false
      && provider.status === 'open' && String(provider.payment_status).toLowerCase() === 'unpaid'
      && Number(provider.expires_at) > Math.floor(Date.now() / 1000) && validUrl(provider.url)
      && provider.url === body.checkout_url && Number(provider.amount_total) === Number(body.amount_due_cents)
      && String(provider.currency).toUpperCase() === String(body.currency || 'EUR').toUpperCase()
      && md.client_slug === 'wolfhouse-somo' && md.booking_id === args.bookingId
      && md.payment_id === body.payment_id && md.payment_scope === 'booking';
    if (!valid) throw error('provider_readback_mismatch', 409);
    return { scope: 'booking', bookingId: args.bookingId, paymentId: body.payment_id,
      amountCents: Number(body.amount_due_cents), currency: String(body.currency || 'EUR').toUpperCase(),
      checkoutId, url: provider.url, provider };
  }
  return { create: createBookingCheckout, read: deps.readStripeCheckout };
}

module.exports = { createBookingCheckoutAuthority };
