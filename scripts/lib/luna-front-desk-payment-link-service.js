'use strict';

/**
 * Luna Front Desk — canonical payment-link application service (Slice 10).
 *
 * Shared create / read / cancel lifecycle for Staff and Luna payment links.
 * Zero trust in browser/model-supplied amounts; booking + payment rows are authoritative.
 *
 * See docs/LUNA-FRONT-DESK-DOMAIN-CONTRACT.md §15.
 */

const crypto = require('crypto');
const { SUNSET_CLIENT_SLUG } = require('./sunset-stripe-payment-links');
const {
  paymentLinkIntendedAmountCents,
  paymentLedgerIsStaleUnpaidLinkRow,
  parseMetadata: parseLedgerMetadata,
} = require('./payment-ledger-stale-links');

const WOLFHOUSE_CLIENT_SLUG = 'wolfhouse-somo';

const PAYMENT_LINK_CHANNELS = Object.freeze({
  STAFF_PORTAL: 'staff_portal',
  LUNA_WHATSAPP: 'luna_whatsapp',
  STAFF_SCHEDULE: 'staff_schedule',
  LUNA_SUNSET: 'luna_sunset',
  LUNA_EMAIL: 'luna_email',
});

const PAYMENT_LINK_OPERATIONS = Object.freeze({
  CREATE: 'create_payment_link',
  GET_STATUS: 'get_payment_status',
  CANCEL: 'cancel_or_invalidate_payment_link',
});

/** Canonical lifecycle states exposed to routes/adapters. */
const PAYMENT_LINK_LIFECYCLE = Object.freeze({
  NO_PAYMENT_DUE: 'no_payment_due',
  DRAFT: 'draft',
  CHECKOUT_CREATED: 'checkout_created',
  PAID: 'paid',
  CANCELLED: 'cancelled',
  INVALIDATED: 'invalidated',
  BOOKING_CANCELLED: 'booking_cancelled',
  NOT_FOUND: 'not_found',
});

const CLIENT_SUPPLIED_AMOUNT_FIELDS = Object.freeze([
  'amount_due_cents',
  'amount_paid_cents',
  'total_cents',
  'total_amount_cents',
  'balance_due_cents',
  'currency',
  'unit_amount_cents',
]);

const CANCELLABLE_LINK_STATUSES = new Set(['checkout_created', 'draft', 'pending']);
const CANCELLED_LINK_STATUSES = new Set(['cancelled', 'canceled', 'expired']);
const PAID_LINK_STATUSES = new Set(['paid', 'succeeded', 'partially_paid']);

function fail(status, reasonCode, error, extra = {}) {
  return {
    ok: false,
    status,
    body: {
      success: false,
      reason_code: reasonCode,
      error: error || reasonCode,
      ...extra,
    },
  };
}

function parsePaymentMetadata(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try { return JSON.parse(String(raw)); } catch (_) { return {}; }
}

function bookingStatusIsCancelled(status) {
  const s = String(status || '').toLowerCase();
  return s === 'cancelled' || s === 'canceled' || s === 'expired';
}

function paymentStatusIsPaid(status, amountPaidCents) {
  const st = String(status || '').toLowerCase();
  if (PAID_LINK_STATUSES.has(st)) return true;
  return Number(amountPaidCents || 0) > 0;
}

function paymentRowHasCheckoutUrl(row) {
  if (!row) return false;
  if (row.checkout_url) return true;
  const md = parsePaymentMetadata(row.metadata);
  return !!(md.payment_link_url || md.checkout_url);
}

function assertTrustedTenant(command) {
  const slug = String(command.trustedClientSlug || '').trim();
  if (!slug) return fail(403, 'tenant_mismatch', 'unsupported_client');
  if (command.clientSlug && String(command.clientSlug).trim() !== slug) {
    return fail(403, 'tenant_mismatch', 'client_slug override rejected');
  }
  if (slug === SUNSET_CLIENT_SLUG && command.locationId) {
    const { normalizeSunsetLocationId } = require('./sunset-school-locations');
    if (!normalizeSunsetLocationId(command.locationId)) {
      return fail(400, 'unknown_location', 'unknown location_id');
    }
  }
  if (slug !== WOLFHOUSE_CLIENT_SLUG && slug !== SUNSET_CLIENT_SLUG) {
    return fail(403, 'tenant_mismatch', 'unsupported_client', { client_slug: slug });
  }
  return { ok: true, clientSlug: slug };
}

function rejectClientSuppliedAmounts(transportBody) {
  const body = transportBody && typeof transportBody === 'object' ? transportBody : {};
  for (const key of CLIENT_SUPPLIED_AMOUNT_FIELDS) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
      return { ok: false, field: key };
    }
  }
  return { ok: true };
}

function assertStripeRuntime(clientSlug, stripeConfig) {
  const cfg = stripeConfig || {};
  if (!cfg.staffActionsEnabled) {
    return fail(403, 'staff_actions_disabled', 'Staff write actions are disabled.');
  }
  if (!cfg.stripeLinksEnabled) {
    return fail(403, 'stripe_links_disabled', 'Stripe link creation is disabled.');
  }
  if (!cfg.secretKey) {
    return fail(503, 'stripe_not_configured', 'STRIPE_SECRET_KEY not configured.', { no_db_write: true });
  }
  const key = String(cfg.secretKey);
  if (clientSlug === SUNSET_CLIENT_SLUG && key.startsWith('sk_live_')) {
    return fail(403, 'live_stripe_blocked', 'Live Stripe keys are blocked for Sunset staging payment links.');
  }
  if (clientSlug === WOLFHOUSE_CLIENT_SLUG && key.startsWith('sk_live_') && cfg.blockLiveKeys !== false) {
    return fail(403, 'live_stripe_blocked', 'Live Stripe keys blocked for Wolfhouse staging payment links.');
  }
  if (!cfg.successUrl || !cfg.cancelUrl) {
    return fail(503, 'stripe_redirect_urls_missing', 'Stripe checkout redirect URLs must be configured.', { no_db_write: true });
  }
  if (cfg.expectedMode === 'test' && key.startsWith('sk_live_')) {
    return fail(403, 'stripe_mode_cross', 'Test mode required; live key rejected.');
  }
  if (cfg.expectedMode === 'live' && key.startsWith('sk_test_')) {
    return fail(403, 'stripe_mode_cross', 'Live mode required; test key rejected.');
  }
  return { ok: true };
}

/**
 * Resolve whether a checkout URL is actionable for guests/staff UI.
 * Never returns stale metadata URLs when payment rows are neutralized or booking cancelled.
 */
function resolveActionableCheckoutUrl(opts = {}) {
  const booking = opts.bookingRow || {};
  const payment = opts.paymentRow || null;
  const meta = parsePaymentMetadata(booking.metadata);

  if (bookingStatusIsCancelled(booking.status)) {
    return {
      actionable: false,
      lifecycle: PAYMENT_LINK_LIFECYCLE.BOOKING_CANCELLED,
      checkout_url: null,
      payment_link_url: null,
      payment_id: null,
      reason_code: 'booking_cancelled',
    };
  }

  if (meta.payment_link_invalidated === true || meta.sunset_stripe_link_stale === true) {
    if (!payment || !paymentRowHasCheckoutUrl(payment) || CANCELLED_LINK_STATUSES.has(String(payment.payment_status || '').toLowerCase())) {
      return {
        actionable: false,
        lifecycle: PAYMENT_LINK_LIFECYCLE.INVALIDATED,
        checkout_url: null,
        payment_link_url: null,
        payment_id: payment ? payment.payment_id : null,
        reason_code: 'link_invalidated',
      };
    }
  }

  if (!payment) {
    return {
      actionable: false,
      lifecycle: PAYMENT_LINK_LIFECYCLE.NOT_FOUND,
      checkout_url: null,
      payment_link_url: null,
      payment_id: null,
      reason_code: 'no_active_payment',
    };
  }

  const st = String(payment.payment_status || '').toLowerCase();
  if (CANCELLED_LINK_STATUSES.has(st)) {
    return {
      actionable: false,
      lifecycle: PAYMENT_LINK_LIFECYCLE.CANCELLED,
      checkout_url: null,
      payment_link_url: null,
      payment_id: payment.payment_id,
      reason_code: 'payment_cancelled',
    };
  }

  if (paymentStatusIsPaid(st, payment.amount_paid_cents)) {
    return {
      actionable: false,
      lifecycle: PAYMENT_LINK_LIFECYCLE.PAID,
      checkout_url: null,
      payment_link_url: null,
      payment_id: payment.payment_id,
      reason_code: 'already_paid',
    };
  }

  const url = payment.checkout_url || null;
  if (!url || !CANCELLABLE_LINK_STATUSES.has(st)) {
    return {
      actionable: false,
      lifecycle: PAYMENT_LINK_LIFECYCLE.INVALIDATED,
      checkout_url: null,
      payment_link_url: null,
      payment_id: payment.payment_id,
      reason_code: 'no_checkout_url',
    };
  }

  return {
    actionable: true,
    lifecycle: st === 'draft' ? PAYMENT_LINK_LIFECYCLE.DRAFT : PAYMENT_LINK_LIFECYCLE.CHECKOUT_CREATED,
    checkout_url: url,
    payment_link_url: url,
    payment_id: payment.payment_id,
    payment_status: st,
    amount_due_cents: Number(payment.amount_due_cents || 0),
    currency: String(payment.currency || 'EUR').toUpperCase(),
  };
}

function buildBookingMetadataInvalidationPatch(clientSlug) {
  const patch = {
    last_payment_link_url: null,
    payment_link_invalidated: true,
    payment_link_invalidated_at: new Date().toISOString(),
  };
  if (clientSlug === SUNSET_CLIENT_SLUG) {
    patch.sunset_stripe_link_stale = true;
  }
  return patch;
}

function buildPaymentLinkCommand(opts = {}) {
  const operation = String(opts.operation || '').trim();
  if (!Object.values(PAYMENT_LINK_OPERATIONS).includes(operation)) {
    return fail(400, 'invalid_operation', 'invalid payment link operation');
  }

  const tenant = assertTrustedTenant({
    trustedClientSlug: opts.trustedClientSlug,
    clientSlug: (opts.transportBody && opts.transportBody.client_slug) || opts.trustedClientSlug,
    locationId: opts.locationId || (opts.transportBody && (opts.transportBody.location_id || opts.transportBody.location)),
  });
  if (!tenant.ok) return tenant;

  const amountReject = rejectClientSuppliedAmounts(opts.transportBody);
  if (!amountReject.ok) {
    return fail(422, 'client_amount_rejected', `Client-supplied amount field rejected: ${amountReject.field}`, { field: amountReject.field });
  }

  const transportBody = opts.transportBody || {};
  return {
    ok: true,
    command: {
      operation,
      channel: opts.channel || PAYMENT_LINK_CHANNELS.STAFF_PORTAL,
      trustedClientSlug: tenant.clientSlug,
      clientSlug: tenant.clientSlug,
      locationId: opts.locationId || transportBody.location_id || transportBody.location || null,
      bookingId: String(opts.bookingId || transportBody.booking_id || '').trim() || null,
      bookingCode: String(opts.bookingCode || transportBody.booking_code || '').trim() || null,
      paymentId: String(opts.paymentId || transportBody.payment_id || '').trim() || null,
      idempotencyKey: String(opts.idempotencyKey || transportBody.idempotency_key || '').trim() || null,
      reason: transportBody.reason != null ? String(transportBody.reason).trim().slice(0, 500) : null,
      target: opts.target || transportBody.target || null,
      actor: opts.actor || {},
      transportBody,
      authoritativeBalanceDueCents: opts.authoritativeBalanceDueCents != null
        ? Number(opts.authoritativeBalanceDueCents)
        : null,
      paymentChoice: String(opts.paymentChoice || '').trim() || null,
    },
  };
}

async function loadBookingRow(pg, clientSlug, bookingId, bookingCode) {
  if (!bookingId && !bookingCode) return null;
  const res = await pg.query(
    `SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.status::text AS status,
            b.payment_status::text AS booking_payment_status,
            b.check_in::text AS check_in, b.check_out::text AS check_out,
            b.total_amount_cents, b.amount_paid_cents, b.balance_due_cents,
            b.deposit_required_cents, b.metadata, c.id AS client_id, c.slug AS client_slug
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND ${bookingId ? 'b.id = $2::uuid' : 'b.booking_code = $2'}
      LIMIT 1`,
    [clientSlug, bookingId || bookingCode],
  );
  return res.rows[0] || null;
}

async function loadPaymentRowsForBooking(pg, clientSlug, bookingCode) {
  const res = await pg.query(
    `SELECT p.id::text AS payment_id, p.status::text AS payment_status, p.payment_kind::text AS payment_kind,
            p.currency, p.amount_due_cents, p.amount_paid_cents, p.checkout_url,
            p.stripe_checkout_session_id, p.metadata, p.created_at, p.booking_guest_id::text AS booking_guest_id
       FROM payments p
       INNER JOIN bookings b ON b.id = p.booking_id
       INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.booking_code = $2
      ORDER BY p.created_at DESC`,
    [clientSlug, bookingCode],
  );
  return res.rows;
}

async function loadPaymentById(pg, paymentId, clientSlug) {
  const res = await pg.query(
    `SELECT p.id::text AS payment_id, p.client_id, p.booking_id::text AS booking_id,
            p.status::text AS payment_status, p.payment_kind::text AS payment_kind,
            p.currency, p.amount_due_cents, p.amount_paid_cents,
            p.stripe_checkout_session_id, p.checkout_url, p.metadata,
            b.booking_code, b.guest_name, b.check_in::text AS check_in, b.check_out::text AS check_out,
            b.status::text AS booking_status, b.metadata AS booking_metadata,
            cl.slug AS client_slug
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN clients cl ON cl.id = p.client_id
      WHERE p.id = $1::uuid AND cl.slug = $2
      LIMIT 1`,
    [paymentId, clientSlug],
  );
  return res.rows[0] || null;
}

function pickLatestActionablePaymentRow(paymentRows, bookingRow, ledgerCtx) {
  for (const pr of paymentRows || []) {
    const st = String(pr.payment_status || '').toLowerCase();
    if (CANCELLED_LINK_STATUSES.has(st)) continue;
    if (paymentStatusIsPaid(st, pr.amount_paid_cents)) continue;
    if (ledgerCtx && paymentLedgerIsStaleUnpaidLinkRow(pr, (row) => {
      if (CANCELLED_LINK_STATUSES.has(String(row.payment_status || '').toLowerCase())) return false;
      if (Number(row.amount_paid_cents || 0) > 0) return false;
      return !!(row.checkout_url || paymentRowHasCheckoutUrl(row));
    }, ledgerCtx)) {
      continue;
    }
    if (pr.checkout_url && CANCELLABLE_LINK_STATUSES.has(st)) return pr;
  }
  return null;
}

function computeAuthoritativeBalanceDueCents(bookingRow, command) {
  if (command.authoritativeBalanceDueCents != null) {
    return Number(command.authoritativeBalanceDueCents);
  }
  if (bookingRow.balance_due_cents != null) {
    return Math.max(0, Number(bookingRow.balance_due_cents));
  }
  const total = Number(bookingRow.total_amount_cents || 0);
  const paid = Number(bookingRow.amount_paid_cents || 0);
  return Math.max(0, total - paid);
}

async function getPaymentStatus(pg, command, execOpts = {}) {
  const tenant = assertTrustedTenant(command);
  if (!tenant.ok) return tenant;

  if (command.clientSlug === SUNSET_CLIENT_SLUG) {
    const { loadBookingWithServices } = require('./sunset-stripe-payment-links');
    const loaded = await loadBookingWithServices(pg, command.clientSlug, command.bookingId, command.bookingCode);
    if (!loaded) return fail(404, 'booking_not_found', 'booking not found');
    const paymentRows = await loadPaymentRowsForBooking(pg, command.clientSlug, loaded.booking.booking_code);
    const paymentRow = pickLatestActionablePaymentRow(paymentRows, loaded.booking, null)
      || (paymentRows.find((p) => p.checkout_url) || null);
    const resolved = resolveActionableCheckoutUrl({
      bookingRow: loaded.booking,
      paymentRow: resolvedActionablePaymentOnly(paymentRow, loaded.booking),
    });
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        booking_id: loaded.booking.booking_id,
        booking_code: loaded.booking.booking_code,
        payment_id: resolved.payment_id,
        payment_status: resolved.payment_status || (paymentRow && paymentRow.payment_status) || null,
        amount_due_cents: resolved.amount_due_cents != null
          ? resolved.amount_due_cents
          : (paymentRow ? Number(paymentRow.amount_due_cents) : null),
        checkout_url: resolved.checkout_url,
        payment_link_url: resolved.payment_link_url,
        actionable: resolved.actionable,
        lifecycle: resolved.lifecycle,
        currency: 'EUR',
      },
    };
  }

  const booking = await loadBookingRow(pg, command.clientSlug, command.bookingId, command.bookingCode);
  if (!booking) return fail(404, 'booking_not_found', 'booking not found');
  const paymentRows = await loadPaymentRowsForBooking(pg, command.clientSlug, booking.booking_code);
  const ledgerCtx = execOpts.ledgerContext || {
    balance_due_cents: computeAuthoritativeBalanceDueCents(booking, command),
    deposit_required_cents: booking.deposit_required_cents != null ? Number(booking.deposit_required_cents) : null,
  };
  const paymentRow = pickLatestActionablePaymentRow(paymentRows, booking, ledgerCtx);
  const resolved = resolveActionableCheckoutUrl({ bookingRow: booking, paymentRow });
  const paid = paymentStatusIsPaid(booking.booking_payment_status, booking.amount_paid_cents);
  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      booking_id: booking.booking_id,
      booking_code: booking.booking_code,
      payment_id: resolved.payment_id,
      payment_status: resolved.payment_status || booking.booking_payment_status,
      paid,
      unpaid: !paid,
      amount_due_cents: resolved.amount_due_cents,
      checkout_url: resolved.checkout_url,
      payment_link_url: resolved.payment_link_url,
      actionable: resolved.actionable,
      lifecycle: resolved.lifecycle,
      currency: 'EUR',
    },
  };
}

function resolvedActionablePaymentOnly(paymentRow, bookingRow) {
  if (!paymentRow) return null;
  const probe = resolveActionableCheckoutUrl({ bookingRow, paymentRow });
  return probe.actionable ? paymentRow : null;
}

async function cancelOrInvalidatePaymentLink(pg, command, execOpts = {}) {
  const tenant = assertTrustedTenant(command);
  if (!tenant.ok) return tenant;
  if (!command.paymentId) {
    return fail(400, 'payment_id_required', 'payment_id is required');
  }
  if (!command.idempotencyKey) {
    return fail(400, 'idempotency_key_required', 'idempotency_key is required');
  }

  await pg.query('BEGIN');
  try {
    const row = await loadPaymentById(pg, command.paymentId, command.clientSlug);
    if (!row) {
      await pg.query('ROLLBACK');
      return fail(404, 'payment_not_found', 'payment not found');
    }
    if (command.bookingId && row.booking_id !== command.bookingId) {
      await pg.query('ROLLBACK');
      return fail(400, 'payment_booking_mismatch', 'payment does not belong to this booking');
    }
    if (command.bookingCode && row.booking_code !== command.bookingCode) {
      await pg.query('ROLLBACK');
      return fail(400, 'payment_booking_mismatch', 'payment does not belong to this booking');
    }

    const st = String(row.payment_status || '').toLowerCase();
    if (CANCELLED_LINK_STATUSES.has(st)) {
      await invalidateBookingPaymentMetadata(pg, row.booking_id, command.clientSlug);
      await pg.query('COMMIT');
      return {
        ok: true,
        status: 200,
        body: {
          success: true,
          idempotent: true,
          cancelled: true,
          invalidated: true,
          payment_id: row.payment_id,
          lifecycle: PAYMENT_LINK_LIFECYCLE.CANCELLED,
        },
      };
    }

    if (paymentStatusIsPaid(st, row.amount_paid_cents)) {
      await pg.query('ROLLBACK');
      return fail(400, 'payment_already_paid', 'Cannot cancel a paid payment row.');
    }
    if (!CANCELLABLE_LINK_STATUSES.has(st) || !paymentRowHasCheckoutUrl(row)) {
      await pg.query('ROLLBACK');
      return fail(400, 'payment_not_cancellable', 'Only unpaid checkout/payment-link rows can be cancelled.');
    }

    const cancelMeta = {
      cancel_idempotency_key: command.idempotencyKey,
      cancelled_at: new Date().toISOString(),
      cancelled_by: command.actor && (command.actor.email || command.actor.staff_user_id) || 'payment_link_service',
      cancel_reason: command.reason || 'Cancelled via payment-link service',
      checkout_url_cleared: true,
      payment_link_invalidated: true,
    };

    await pg.query(
      `UPDATE payments
          SET status = 'cancelled'::payment_record_status,
              checkout_url = NULL,
              metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $1::uuid`,
      [command.paymentId, JSON.stringify(cancelMeta)],
    );
    await invalidateBookingPaymentMetadata(pg, row.booking_id, command.clientSlug);
    await pg.query('COMMIT');
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        idempotent: false,
        cancelled: true,
        invalidated: true,
        payment_id: command.paymentId,
        lifecycle: PAYMENT_LINK_LIFECYCLE.CANCELLED,
        no_stripe: true,
      },
    };
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
}

async function invalidateBookingPaymentMetadata(pg, bookingId, clientSlug) {
  const patch = buildBookingMetadataInvalidationPatch(clientSlug);
  await pg.query(
    `UPDATE bookings b
        SET metadata = COALESCE(b.metadata, '{}'::jsonb) || $3::jsonb
       FROM clients c
      WHERE b.id = $1::uuid AND c.id = b.client_id AND c.slug = $2`,
    [bookingId, clientSlug, JSON.stringify(patch)],
  );
}

async function createPaymentLink(pg, command, execOpts = {}) {
  const tenant = assertTrustedTenant(command);
  if (!tenant.ok) return tenant;

  if (command.clientSlug === SUNSET_CLIENT_SLUG) {
    const { createSunsetScheduleStripeLink } = require('./sunset-stripe-payment-links');
    return createSunsetScheduleStripeLink(pg, {
      clientSlug: command.clientSlug,
      bookingId: command.bookingId,
      bookingCode: command.bookingCode,
      locationId: command.locationId,
      idempotencyKey: command.idempotencyKey,
      actor: command.actor,
      staffActionsEnabled: execOpts.staffActionsEnabled,
      stripeLinksEnabled: execOpts.stripeLinksEnabled,
      stripeSecretKey: execOpts.secretKey,
      stripeSuccessUrl: execOpts.successUrl,
      stripeCancelUrl: execOpts.cancelUrl,
      publicPaymentBaseUrl: execOpts.publicPaymentBaseUrl,
      env: execOpts.env,
      authoritativeBalanceDueCents: command.authoritativeBalanceDueCents,
      paymentChoice: command.paymentChoice,
    });
  }

  if (command.target === 'draft_payment' || command.paymentId) {
    return createDraftPaymentStripeLink(pg, command, execOpts);
  }

  return createBookingBalancePaymentLink(pg, command, execOpts);
}

async function createDraftPaymentStripeLink(pg, command, execOpts) {
  const stripeCheck = assertStripeRuntime(command.clientSlug, execOpts);
  if (!stripeCheck.ok) return stripeCheck;

  const paymentId = command.paymentId;
  if (!paymentId) return fail(400, 'payment_id_required', 'payment_id is required');

  const pm = await loadPaymentById(pg, paymentId, command.clientSlug);
  if (!pm) return fail(404, 'payment_not_found', 'Payment record not found.');

  if (bookingStatusIsCancelled(pm.booking_status)) {
    return fail(400, 'booking_not_active', 'Cannot create a payment link on a cancelled booking.');
  }

  const st = String(pm.payment_status || '').toLowerCase();
  if (st !== 'draft') {
    if (st === 'checkout_created' && pm.checkout_url) {
      return {
        ok: true,
        status: 200,
        body: {
          success: true,
          idempotent: true,
          payment_id: pm.payment_id,
          booking_id: pm.booking_id,
          booking_code: pm.booking_code,
          amount_due_cents: Number(pm.amount_due_cents),
          currency: pm.currency,
          checkout_url: pm.checkout_url,
          payment_link_url: pm.checkout_url,
          payment_status: pm.payment_status,
          lifecycle: PAYMENT_LINK_LIFECYCLE.CHECKOUT_CREATED,
        },
      };
    }
    return fail(409, 'payment_not_draft', `Payment is in status '${pm.payment_status}'; only draft payments can create a Stripe link.`);
  }

  const amountDue = Number(pm.amount_due_cents || 0);
  if (amountDue <= 0) return fail(422, 'invalid_amount', 'amount_due_cents must be > 0.');
  if (String(pm.currency || '').toUpperCase() !== 'EUR') {
    return fail(422, 'unsupported_currency', `Currency '${pm.currency}' not supported (EUR only).`);
  }

  const createSession = execOpts.createStripeCheckoutSession;
  if (typeof createSession !== 'function') {
    return fail(500, 'stripe_adapter_missing', 'createStripeCheckoutSession adapter required');
  }

  const sourceTag = command.channel === PAYMENT_LINK_CHANNELS.LUNA_WHATSAPP ? 'bot_stage855' : 'staff_portal_stage849';
  const productName = `Booking ${pm.booking_code || paymentId} — ${pm.guest_name || 'Guest'}`;
  const productDesc = `${pm.payment_kind === 'full_amount' ? 'Full payment' : 'Deposit'} | ${pm.check_in || ''} – ${pm.check_out || ''} | ${command.clientSlug}`;

  let session;
  try {
    session = await createSession({
      amountDueCents: amountDue,
      currency: 'eur',
      productName,
      productDesc,
      metadata: {
        client_slug: command.clientSlug,
        booking_id: pm.booking_id,
        booking_code: pm.booking_code || '',
        payment_id: paymentId,
        payment_kind: pm.payment_kind || '',
        source: sourceTag,
      },
    });
  } catch (stripeErr) {
    return fail(500, 'stripe_session_failed', stripeErr.message || 'Stripe session creation failed', { no_db_write: true });
  }

  const expiresAt = session.expires_at
    ? new Date(session.expires_at * 1000).toISOString()
    : null;

  await pg.query('BEGIN');
  try {
    const upd = await pg.query(
      `UPDATE payments
          SET status = 'checkout_created'::payment_record_status,
              stripe_checkout_session_id = $1,
              checkout_url = $2,
              expires_at = $3,
              metadata = metadata || $4::jsonb
        WHERE id = $5::uuid AND client_id = $6
        RETURNING id::text AS payment_id, status::text AS payment_status, checkout_url, amount_due_cents, currency`,
      [
        session.id,
        session.url,
        expiresAt,
        JSON.stringify({
          stripe_session_id: session.id,
          stripe_livemode: session.livemode,
          stripe_payment_status: session.payment_status,
          created_by: command.actor && command.actor.staff_user_id,
          source: sourceTag,
          payment_link_url: session.url,
        }),
        paymentId,
        pm.client_id,
      ],
    );
    if (!upd.rows[0]) {
      await pg.query('ROLLBACK');
      return fail(409, 'payment_update_failed', 'Payment row no longer draft — concurrent update.');
    }
    await pg.query('COMMIT');
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        idempotent: false,
        payment_id: paymentId,
        booking_id: pm.booking_id,
        booking_code: pm.booking_code,
        amount_due_cents: amountDue,
        currency: 'EUR',
        stripe_checkout_session_id: session.id,
        checkout_url: session.url,
        payment_link_url: session.url,
        payment_status: 'checkout_created',
        lifecycle: PAYMENT_LINK_LIFECYCLE.CHECKOUT_CREATED,
        no_payment_truth_recorded: true,
      },
    };
  } catch (dbErr) {
    await pg.query('ROLLBACK');
    return fail(500, 'payment_update_failed', dbErr.message, {
      stripe_session_id: session.id,
      checkout_url: session.url,
      partial_stripe_session: true,
    });
  }
}

async function createBookingBalancePaymentLink(pg, command, execOpts = {}) {
  const stripeCheck = assertStripeRuntime(command.clientSlug, execOpts);
  if (!stripeCheck.ok) return stripeCheck;

  if (!command.idempotencyKey) {
    return fail(400, 'idempotency_key_required', 'idempotency_key is required');
  }
  if (!command.bookingId && !command.bookingCode) {
    return fail(400, 'booking_required', 'booking_id or booking_code is required');
  }

  const booking = await loadBookingRow(pg, command.clientSlug, command.bookingId, command.bookingCode);
  if (!booking) return fail(404, 'booking_not_found', 'booking not found');
  if (bookingStatusIsCancelled(booking.status)) {
    return fail(400, 'booking_not_active', 'Cannot create a payment link on a cancelled or expired booking.');
  }

  const paymentRows = await loadPaymentRowsForBooking(pg, command.clientSlug, booking.booking_code);
  const amountDueCents = computeAuthoritativeBalanceDueCents(booking, command);

  if (execOpts.needsRefund === true) {
    return fail(409, 'refund_review_needed', 'Refund / credit review needed before creating a payment link.');
  }
  if (amountDueCents <= 0) {
    return {
      ok: false,
      status: 422,
      body: {
        success: false,
        created: false,
        error: 'no_payment_due',
        booking_code: booking.booking_code,
        amount_due_cents: 0,
        lifecycle: PAYMENT_LINK_LIFECYCLE.NO_PAYMENT_DUE,
      },
    };
  }

  const existingByKey = paymentRows.find((pr) => {
    const md = parsePaymentMetadata(pr.metadata);
    return md.idempotency_key === command.idempotencyKey && pr.checkout_url;
  });
  if (existingByKey) {
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        created: false,
        idempotent: true,
        booking_code: booking.booking_code,
        amount_due_cents: Number(existingByKey.amount_due_cents || amountDueCents),
        payment_status: 'payment_link_created',
        payment_link_url: existingByKey.checkout_url,
        checkout_url: existingByKey.checkout_url,
        lifecycle: PAYMENT_LINK_LIFECYCLE.CHECKOUT_CREATED,
      },
    };
  }

  const ledgerCtx = {
    balance_due_cents: amountDueCents,
    deposit_required_cents: booking.deposit_required_cents != null ? Number(booking.deposit_required_cents) : null,
  };
  const activeLink = pickLatestActionablePaymentRow(paymentRows, booking, ledgerCtx);
  if (activeLink && activeLink.checkout_url && Number(activeLink.amount_due_cents) === amountDueCents) {
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        created: false,
        idempotent: true,
        booking_code: booking.booking_code,
        amount_due_cents: amountDueCents,
        payment_id: activeLink.payment_id,
        payment_link_url: activeLink.checkout_url,
        checkout_url: activeLink.checkout_url,
        lifecycle: PAYMENT_LINK_LIFECYCLE.CHECKOUT_CREATED,
      },
    };
  }

  const createSession = execOpts.createStripeCheckoutSession;
  if (typeof createSession !== 'function') {
    return fail(500, 'stripe_adapter_missing', 'createStripeCheckoutSession adapter required');
  }

  const pmMeta = {
    source: 'staff_payment_link',
    method: 'payment_link',
    idempotency_key: command.idempotencyKey,
    booking_code: booking.booking_code,
    amount_due_cents: amountDueCents,
    reason: command.reason,
    created_by: command.actor && command.actor.staff_user_id,
    staff_portal: true,
    phase: 'slice10',
  };

  let draftPaymentId;
  await pg.query('BEGIN');
  try {
    const idem = await pg.query(
      `SELECT p.id::text AS payment_id, p.checkout_url, p.status::text AS payment_status, p.amount_due_cents
         FROM payments p
        WHERE p.booking_id = $1::uuid AND p.client_id = $2
          AND p.metadata->>'idempotency_key' = $3
        LIMIT 1`,
      [booking.booking_id, booking.client_id, command.idempotencyKey],
    );
    if (idem.rows[0] && idem.rows[0].checkout_url) {
      await pg.query('COMMIT');
      const row = idem.rows[0];
      return {
        ok: true,
        status: 200,
        body: {
          success: true,
          created: false,
          idempotent: true,
          booking_code: booking.booking_code,
          amount_due_cents: Number(row.amount_due_cents || amountDueCents),
          payment_link_url: row.checkout_url,
          checkout_url: row.checkout_url,
          lifecycle: PAYMENT_LINK_LIFECYCLE.CHECKOUT_CREATED,
        },
      };
    }

    const ins = await pg.query(
      `INSERT INTO payments (
         client_id, booking_id, status, payment_kind, currency, amount_due_cents, amount_paid_cents, metadata
       ) VALUES (
         $1, $2::uuid, 'draft'::payment_record_status, 'full_amount'::payment_kind, 'EUR', $3, 0, $4::jsonb
       ) RETURNING id::text AS payment_id`,
      [booking.client_id, booking.booking_id, amountDueCents, JSON.stringify(pmMeta)],
    );
    draftPaymentId = ins.rows[0].payment_id;
    await pg.query('COMMIT');
  } catch (err) {
    await pg.query('ROLLBACK');
    return fail(500, 'payment_draft_insert_failed', err.message);
  }

  const productName = `Booking ${booking.booking_code || draftPaymentId} — ${booking.guest_name || 'Guest'}`;
  const productDesc = `Outstanding balance | ${booking.check_in || ''} – ${booking.check_out || ''} | ${command.clientSlug}`;

  let session;
  try {
    session = await createSession({
      amountDueCents,
      currency: 'eur',
      productName,
      productDesc,
      metadata: {
        client_slug: command.clientSlug,
        booking_id: booking.booking_id,
        booking_code: booking.booking_code || '',
        payment_id: draftPaymentId,
        payment_kind: 'full_amount',
        source: 'staff_payment_link',
        idempotency_key: command.idempotencyKey,
      },
    });
  } catch (stripeErr) {
    await pg.query('DELETE FROM payments WHERE id = $1::uuid AND status = \'draft\'::payment_record_status', [draftPaymentId]);
    return fail(500, 'stripe_session_failed', stripeErr.message || 'Stripe session creation failed', { no_db_write: true });
  }

  const expiresAt = session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null;
  await pg.query('BEGIN');
  try {
    await pg.query(
      `UPDATE payments
          SET status = 'checkout_created'::payment_record_status,
              stripe_checkout_session_id = $1,
              checkout_url = $2,
              expires_at = $3,
              metadata = metadata || $4::jsonb
        WHERE id = $5::uuid AND client_id = $6`,
      [
        session.id,
        session.url,
        expiresAt,
        JSON.stringify({
          stripe_session_id: session.id,
          stripe_livemode: session.livemode,
          payment_link_url: session.url,
          source: 'staff_payment_link',
        }),
        draftPaymentId,
        booking.client_id,
      ],
    );
    await pg.query('COMMIT');
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        created: true,
        booking_code: booking.booking_code,
        payment_id: draftPaymentId,
        amount_due_cents: amountDueCents,
        payment_status: 'payment_link_created',
        payment_link_url: session.url,
        checkout_url: session.url,
        lifecycle: PAYMENT_LINK_LIFECYCLE.CHECKOUT_CREATED,
      },
    };
  } catch (dbErr) {
    await pg.query('ROLLBACK');
    await pg.query('DELETE FROM payments WHERE id = $1::uuid AND status = \'draft\'::payment_record_status', [draftPaymentId]);
    return fail(500, 'payment_update_failed', dbErr.message);
  }
}

module.exports = {
  WOLFHOUSE_CLIENT_SLUG,
  PAYMENT_LINK_CHANNELS,
  PAYMENT_LINK_OPERATIONS,
  PAYMENT_LINK_LIFECYCLE,
  buildPaymentLinkCommand,
  createPaymentLink,
  getPaymentStatus,
  cancelOrInvalidatePaymentLink,
  resolveActionableCheckoutUrl,
  buildBookingMetadataInvalidationPatch,
  rejectClientSuppliedAmounts,
  assertStripeRuntime,
  parsePaymentMetadata,
  bookingStatusIsCancelled,
};
