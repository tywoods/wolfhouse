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

function validProviderReadback(provider, expected) {
  const md = provider && provider.metadata || {};
  const localMd = expected.localMetadata && typeof expected.localMetadata === 'object'
    ? expected.localMetadata : {};
  const localMetadataMatches = (!localMd.payment_scope || md.payment_scope === localMd.payment_scope)
    && (!localMd.payment_target || md.payment_target === localMd.payment_target)
    && (!localMd.idempotency_key || md.idempotency_key === localMd.idempotency_key);
  return !!(provider && provider.id === expected.checkoutId && provider.livemode === false
    && provider.status === 'open' && String(provider.payment_status).toLowerCase() === 'unpaid'
    && Number(provider.expires_at) > Math.floor(Date.now() / 1000) && validUrl(provider.url)
    && provider.url === expected.url && Number(provider.amount_total) === Number(expected.amountCents)
    && String(provider.currency).toUpperCase() === String(expected.currency || 'EUR').toUpperCase()
    && md.client_slug === 'wolfhouse-somo' && md.booking_id === expected.bookingId
    && md.payment_id === expected.paymentId && md.payment_scope === 'booking'
    && localMetadataMatches);
}

function createBookingCheckoutAuthority(deps = {}) {
  const build = deps.buildPaymentLinkCommand || defaultBuild;
  const create = deps.createPaymentLink || defaultCreate;
  if (typeof deps.withPgClient !== 'function') throw error('booking_checkout_db_unavailable');

  async function createBookingCheckout(args) {
    const intentKey = providerIntentKey(args);
    const overlap = await deps.withPgClient(async (pg) => (await pg.query(
      `SELECT EXISTS(SELECT 1 FROM payments p WHERE p.booking_id=$1 AND p.booking_guest_id IS NOT NULL
        AND LOWER(COALESCE(p.status::text,'')) IN ('draft','checkout_created','open','pending')
        AND COALESCE(NULLIF(to_jsonb(p)->>'stripe_checkout_session_id',''),NULLIF(to_jsonb(p)->>'checkout_url',''),
          NULLIF(p.metadata->>'stripe_checkout_session_id',''),NULLIF(p.metadata->>'stripe_session_id',''),
          NULLIF(p.metadata->>'checkout_url',''),NULLIF(p.metadata->>'provider_idempotency_key','')) IS NOT NULL) AS guest_active,
        EXISTS(SELECT 1 FROM payments p WHERE p.booking_id=$1 AND p.booking_guest_id IS NULL
          AND LOWER(COALESCE(p.status::text,'')) IN ('draft','checkout_created','open','pending')
          AND COALESCE(p.metadata->>'provider_idempotency_key',p.metadata->>'idempotency_key','')<>$2
          AND NOT (LOWER(COALESCE(p.status::text,''))='draft' AND COALESCE(p.amount_paid_cents,0)=0
            AND COALESCE(NULLIF(to_jsonb(p)->>'stripe_checkout_session_id',''),NULLIF(to_jsonb(p)->>'checkout_url',''),
              NULLIF(p.metadata->>'stripe_checkout_session_id',''),NULLIF(p.metadata->>'stripe_session_id',''),
              NULLIF(p.metadata->>'checkout_url',''),NULLIF(p.metadata->>'provider_idempotency_key',''),
              NULLIF(p.metadata->>'idempotency_key',''),NULLIF(p.metadata->>'checkout_preparation','')) IS NULL
            AND EXISTS(SELECT 1 FROM bookings b WHERE b.id=p.booking_id
              AND b.metadata->>'luna_v3_provenance'='fresh_one_try'))
          AND ($3<>'balance' OR COALESCE(NULLIF(to_jsonb(p)->>'stripe_checkout_session_id',''),
            NULLIF(p.metadata->>'stripe_checkout_session_id',''),NULLIF(p.metadata->>'stripe_session_id','')) IS NULL)) AS other_group_active`,
      [args.bookingId,intentKey,args.paymentChoice])).rows[0]);
    if (overlap && overlap.guest_active) throw error('booking_payment_guest_checkout_active', 409);
    if (overlap && overlap.other_group_active) throw error('booking_payment_group_checkout_active', 409);

    // A balance checkout replaces, rather than coexists with, an earlier group
    // deposit checkout. Provider expiration is verified before publication.
    if (args.paymentChoice === 'balance') {
      const previous = await deps.withPgClient(async (pg) => {
        const row = (await pg.query(`SELECT p.id::text payment_id,COALESCE(NULLIF(to_jsonb(p)->>'stripe_checkout_session_id',''),
          NULLIF(p.metadata->>'stripe_checkout_session_id',''),NULLIF(p.metadata->>'stripe_session_id','')) checkout_id,
          COALESCE(p.metadata->>'provider_idempotency_key',p.metadata->>'idempotency_key') intent_key
          FROM payments p WHERE p.booking_id=$1 AND p.booking_guest_id IS NULL
            AND LOWER(COALESCE(p.status::text,'')) IN ('draft','checkout_created','open','pending')
          ORDER BY p.created_at DESC NULLS LAST,p.id DESC LIMIT 1`, [args.bookingId])).rows[0];
        return row || null;
      });
      if (previous && previous.checkout_id && previous.intent_key !== intentKey) {
        const previousId = previous.checkout_id;
        if (typeof deps.readStripeCheckout !== 'function' || typeof deps.expireStripeCheckout !== 'function')
          throw error('provider_expiration_unavailable');
        const providerBefore = await deps.readStripeCheckout(previousId);
        if (!providerBefore || providerBefore.id !== previousId || providerBefore.livemode !== false
            || String(providerBefore.payment_status).toLowerCase() !== 'unpaid') throw error('prior_provider_readback_mismatch', 409);
        if (providerBefore.status === 'open') await deps.expireStripeCheckout(previousId);
        const expired = await deps.readStripeCheckout(previousId);
        if (!expired || expired.id !== previousId || expired.status !== 'expired'
            || String(expired.payment_status).toLowerCase() !== 'unpaid') throw error('prior_provider_expiration_unverified');
        await deps.withPgClient(async (pg) => {
          await pg.query('BEGIN');
          try {
            const retired = await pg.query(`UPDATE payments SET status='expired',
              metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('superseded_at',now(),'superseded_by_choice','balance')
              WHERE id=$1 AND booking_id=$2 AND booking_guest_id IS NULL
                AND LOWER(COALESCE(status::text,'')) IN ('draft','checkout_created','open','pending') RETURNING id`,
            [previous.payment_id,args.bookingId]);
            if (!retired.rows[0]) throw error('prior_checkout_retirement_conflict', 409);
            await pg.query('COMMIT');
          } catch (e) { await pg.query('ROLLBACK'); throw e; }
        });
      }
    }

    const built = build({
      operation: PAYMENT_LINK_OPERATIONS.CREATE,
      channel: PAYMENT_LINK_CHANNELS.STAFF_PORTAL,
      trustedClientSlug: 'wolfhouse-somo',
      bookingId: args.bookingId,
      idempotencyKey: intentKey,
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
    const valid = validProviderReadback(provider, { checkoutId, url: body.checkout_url,
      amountCents: body.amount_due_cents, currency: body.currency || 'EUR', bookingId: args.bookingId,
      paymentId: body.payment_id });
    if (!valid) throw error('provider_readback_mismatch', 409);
    return { scope: 'booking', bookingId: args.bookingId, paymentId: body.payment_id,
      amountCents: Number(body.amount_due_cents), currency: String(body.currency || 'EUR').toUpperCase(),
      checkoutId, url: provider.url, provider };
  }

  async function readBookingCheckout(args) {
    if (!args || !args.bookingId || !args.operationKey) throw error('booking_checkout_recovery_identity_required', 400);
    const key = providerIntentKey(args);
    const row = await deps.withPgClient(async (pg) => (await pg.query(`SELECT p.id::text payment_id,
      COALESCE(NULLIF(to_jsonb(p)->>'stripe_checkout_session_id',''),NULLIF(p.metadata->>'stripe_checkout_session_id',''),
        NULLIF(p.metadata->>'stripe_session_id','')) checkout_id,
      COALESCE(NULLIF(to_jsonb(p)->>'checkout_url',''),NULLIF(p.metadata->>'checkout_url',''),
        NULLIF(p.metadata->>'payment_link_url','')) checkout_url,
      p.amount_due_cents,p.currency,p.metadata
      FROM payments p WHERE p.booking_id=$1 AND p.booking_guest_id IS NULL
        AND (p.metadata->>'provider_idempotency_key'=$2 OR p.metadata->>'idempotency_key'=$2)
      ORDER BY p.created_at DESC NULLS LAST,p.id DESC LIMIT 1`, [args.bookingId, key])).rows[0]);
    if (!row || !row.checkout_id) {
      // Stripe may have accepted the idempotent create before the local checkout
      // id was persisted. Reissue the exact authority command so Stripe returns
      // the same session and the service can complete local persistence.
      return createBookingCheckout(args);
    }
    if (typeof deps.readStripeCheckout !== 'function') throw error('provider_readback_unavailable');
    const provider = await deps.readStripeCheckout(row.checkout_id);
    if (!validProviderReadback(provider, { checkoutId: row.checkout_id, url: row.checkout_url,
      amountCents: row.amount_due_cents, currency: row.currency, bookingId: args.bookingId,
      paymentId: row.payment_id, localMetadata: row.metadata })) throw error('provider_readback_mismatch', 409);
    return { scope: 'booking', bookingId: args.bookingId, paymentId: row.payment_id,
      amountCents: Number(row.amount_due_cents), currency: String(row.currency || '').toUpperCase(),
      checkoutId: provider.id, url: provider.url, provider };
  }
  return { create: createBookingCheckout, read: readBookingCheckout };
}

module.exports = { createBookingCheckoutAuthority };
