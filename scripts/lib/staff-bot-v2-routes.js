/**
 * staff-bot-v2-routes.js — Luna V2 bot route handlers
 *
 * Extracted from staff-query-api.js to keep the monolith navigable.
 * These are the 4 core V2 bot endpoints that Luna/Hermes calls to:
 *
 *   POST /staff/bot/transfers/save
 *   POST /staff/bot/payments/status
 *   POST /staff/bot/booking-create-from-plan
 *   POST /staff/bot/payments/:id/create-stripe-link  (bot variant)
 *
 * Each handler is self-contained except for shared utilities passed in via ctx.
 * ctx shape: { sendJSON, send400, readBody, appendAuditLog, withPgClient,
 *              guestPaymentLinkObservability, handlePostBookingTransfer,
 *              DEFAULT_CLIENT, STAFF_AUTH_REQUIRED, BOT_BOOKING_ENABLED,
 *              STRIPE_LINKS_ENABLED, STRIPE_SECRET_KEY,
 *              stripeCheckoutRedirectUrlsConfigured,
 *              stripeCheckoutSessionSuccessUrl, stripeCheckoutSessionCancelUrl }
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory fake request — used to delegate to existing handler functions
// that normally read from an HTTP req stream.
// Supports both .on('data') style and for-await-of (Symbol.asyncIterator).
// ─────────────────────────────────────────────────────────────────────────────
function makeInMemoryBotReq(bodyObj) {
  const payload = JSON.stringify(bodyObj || {});
  return {
    method:  'POST',
    headers: {},
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(payload, 'utf8'));
      if (event === 'end') cb();
      return this;
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload, 'utf8');
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /staff/bot/transfers/save  (Stage 57b)
//
// Saves an arrival or departure transfer for a booking.
// Accepts booking_id OR booking_code.
// confirm_transfer_write:true required to actually write; otherwise preview-only.
// ─────────────────────────────────────────────────────────────────────────────
async function handleBotTransferSave(req, res, user, authMode, ctx) {
  const {
    sendJSON, send400, readBody, withPgClient,
    handlePostBookingTransfer,
    DEFAULT_CLIENT, STAFF_AUTH_REQUIRED,
  } = ctx;

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (_) {
    return send400(res, 'invalid or missing JSON body');
  }

  const clientSlug   = String(body.client_slug || DEFAULT_CLIENT).trim();
  const bookingIdRaw = String(body.booking_id  || body.bookingId  || '').trim();
  const bookingCode  = String(body.booking_code || body.bookingCode || '').trim();

  if (!bookingIdRaw && !bookingCode) {
    return sendJSON(res, 400, { success: false, error: 'booking_id or booking_code is required' });
  }

  // Resolve booking_code → booking_id if needed
  let bookingId = bookingIdRaw;
  if (!bookingId && bookingCode) {
    try {
      const row = await withPgClient(async (pg) => {
        const r = await pg.query(
          `SELECT b.id::text AS booking_id
             FROM bookings b
             JOIN clients c ON c.id = b.client_id
            WHERE c.slug = $1
              AND UPPER(b.booking_code) = UPPER($2)
            LIMIT 1`,
          [clientSlug, bookingCode]
        );
        return r.rows[0] || null;
      });
      if (!row) {
        return sendJSON(res, 404, { success: false, error: `Booking not found: ${bookingCode}` });
      }
      bookingId = row.booking_id;
    } catch (err) {
      return sendJSON(res, 500, { success: false, error: 'DB lookup failed: ' + err.message });
    }
  }

  const allowedTransferSources = new Set(['staff', 'luna', 'owner', 'import', 'flight_lookup']);
  const requestedSource        = String(body.source || '').trim();
  const transferSource         = allowedTransferSources.has(requestedSource) ? requestedSource : 'luna';

  const transferPayload = {
    ...body,
    booking_id:  bookingId,
    client_slug: clientSlug,
    source:      transferSource,
  };

  if (body.confirm_transfer_write !== true) {
    return sendJSON(res, 200, {
      success:         true,
      preview_only:    true,
      write_performed: false,
      no_payment_write: true,
      no_whatsapp:     true,
      no_n8n:          true,
      auth_mode:       authMode || (STAFF_AUTH_REQUIRED ? 'session' : 'open'),
      booking_id:      bookingId,
      transfer: {
        direction:    transferPayload.direction    || null,
        airport_code: transferPayload.airport_code || transferPayload.airport || null,
        scheduled_at: transferPayload.scheduled_at || transferPayload.transfer_datetime || null,
        flight_number: transferPayload.flight_number || null,
        notes:        transferPayload.notes || null,
      },
      next_action: 'confirm_transfer_write_to_save',
    });
  }

  const jsonRes = {
    status(code) {
      res.statusCode = code;
      return jsonRes;
    },
    json(obj) {
      res.setHeader('Content-Type', 'application/json');
      const writePerformed = obj && obj.success === true && !!obj.transfer;
      res.end(JSON.stringify({
        ...obj,
        write_performed:  obj.write_performed != null ? obj.write_performed : writePerformed,
        source:           'luna_bot_transfer_save',
        auth_mode:        authMode || (STAFF_AUTH_REQUIRED ? 'session' : 'open'),
        no_payment_write: true,
        no_whatsapp:      true,
        no_n8n:           true,
      }));
      return jsonRes;
    },
  };

  try {
    return await handlePostBookingTransfer(
      bookingId,
      makeInMemoryBotReq(transferPayload),
      jsonRes
    );
  } catch (err) {
    return sendJSON(res, 500, {
      success:          false,
      error:            'transfer save failed',
      detail:           err.message,
      no_payment_write: true,
      no_whatsapp:      true,
      no_n8n:           true,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /staff/bot/payments/status  (Stage 57b)
//
// Read-only payment truth lookup. Accepts payment_id, booking_id, or booking_code.
// Case-insensitive booking_code lookup.
// ─────────────────────────────────────────────────────────────────────────────
async function handleBotPaymentStatus(req, res, user, authMode, ctx) {
  const {
    sendJSON, readBody, withPgClient,
    DEFAULT_CLIENT,
  } = ctx;

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (_) {
    return sendJSON(res, 400, { success: false, error: 'invalid or missing JSON body' });
  }

  const clientSlug  = String(body.client_slug || DEFAULT_CLIENT).trim();
  const paymentId   = String(body.payment_id   || body.paymentId   || '').trim();
  const bookingId   = String(body.booking_id   || body.bookingId   || '').trim();
  const bookingCode = String(body.booking_code || body.bookingCode || '').trim().toUpperCase();

  if (!paymentId && !bookingId && !bookingCode) {
    return sendJSON(res, 400, {
      success: false,
      error:   'payment_id, booking_id, or booking_code is required',
    });
  }

  try {
    const rows = await withPgClient(async (pg) => {
      if (paymentId) {
        const r = await pg.query(
          `SELECT p.id::text AS payment_id,
                  p.booking_id::text AS booking_id,
                  p.status::text AS payment_status,
                  p.payment_kind,
                  p.amount_due_cents,
                  p.checkout_url,
                  p.stripe_checkout_session_id,
                  b.booking_code,
                  b.payment_status::text AS booking_payment_status,
                  b.amount_paid_cents,
                  b.balance_due_cents,
                  c.slug AS client_slug
             FROM payments p
             JOIN bookings b ON b.id = p.booking_id
             JOIN clients c ON c.id = p.client_id
            WHERE p.id = $1::uuid
              AND c.slug = $2
            ORDER BY p.created_at DESC`,
          [paymentId, clientSlug]
        );
        return r.rows;
      }
      if (bookingId) {
        const r = await pg.query(
          `SELECT p.id::text AS payment_id,
                  p.booking_id::text AS booking_id,
                  p.status::text AS payment_status,
                  p.payment_kind,
                  p.amount_due_cents,
                  p.checkout_url,
                  p.stripe_checkout_session_id,
                  b.booking_code,
                  b.payment_status::text AS booking_payment_status,
                  b.amount_paid_cents,
                  b.balance_due_cents,
                  c.slug AS client_slug
             FROM payments p
             JOIN bookings b ON b.id = p.booking_id
             JOIN clients c ON c.id = p.client_id
            WHERE p.booking_id = $1::uuid
              AND c.slug = $2
            ORDER BY p.created_at DESC`,
          [bookingId, clientSlug]
        );
        return r.rows;
      }
      // booking_code lookup (case-insensitive)
      const r = await pg.query(
        `SELECT p.id::text AS payment_id,
                p.booking_id::text AS booking_id,
                p.status::text AS payment_status,
                p.payment_kind,
                p.amount_due_cents,
                p.checkout_url,
                p.stripe_checkout_session_id,
                b.booking_code,
                b.payment_status::text AS booking_payment_status,
                b.amount_paid_cents,
                b.balance_due_cents,
                c.slug AS client_slug
           FROM payments p
           JOIN bookings b ON b.id = p.booking_id
           JOIN clients c ON c.id = p.client_id
          WHERE c.slug = $1
            AND UPPER(b.booking_code) = $2
          ORDER BY p.created_at DESC`,
        [clientSlug, bookingCode]
      );
      return r.rows;
    });

    const latestPayment = rows.length ? rows[0] : null;
    const resolvedBookingId = latestPayment ? latestPayment.booking_id : bookingId || null;

    return sendJSON(res, 200, {
      success:          true,
      source:           'luna_bot_payment_status',
      auth_mode:        authMode,
      client_slug:      clientSlug,
      payment_id:       paymentId || null,
      booking_id:       resolvedBookingId,
      payment_records:  rows,
      latest_payment:   latestPayment,
      payment_truth_known: rows.some(r =>
        ['checkout_created', 'paid', 'deposit_paid', 'fully_paid'].includes(r.payment_status)
      ),
      truth_states:     ['checkout_created', 'paid', 'deposit_paid', 'fully_paid'],
      no_payment_write: true,
      no_whatsapp:      true,
      no_n8n:           true,
    });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'DB error: ' + err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /staff/bot/booking-create-from-plan  (Phase 13c — gated write bridge)
//
// Creates a booking from a Luna booking plan. Flattens payment_id and
// booking_code to top level so Hermes tools can use them directly.
// ─────────────────────────────────────────────────────────────────────────────
async function handleBotBookingCreateFromPlan(req, res, user, authMode, ctx) {
  const {
    sendJSON, send400, readBody, appendAuditLog,
    makeInMemoryBotReq: _makeReq,
    DEFAULT_CLIENT, STAFF_AUTH_REQUIRED, BOT_BOOKING_ENABLED,
  } = ctx;

  if (!BOT_BOOKING_ENABLED) {
    return sendJSON(res, 403, {
      success:             false,
      error:               'Bot booking is disabled. Set BOT_BOOKING_ENABLED=true to enable.',
      bot_booking_enabled: false,
    });
  }

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (_) {
    return send400(res, 'invalid or missing JSON body');
  }

  // Delegate to the existing bot booking create handler
  // but capture its response and flatten the key fields to top-level
  const clientSlug = String(body.client_slug || DEFAULT_CLIENT).trim();

  // Build a synthetic result accumulator
  let bridgeResult = {
    success:          false,
    write_performed:  false,
    client_slug:      clientSlug,
    auth_mode:        authMode || (STAFF_AUTH_REQUIRED ? 'session' : 'open'),
    no_whatsapp:      true,
    no_n8n:           true,
    source:           'luna_bot_booking_create_from_plan',
  };

  const captureRes = {
    _status: 200,
    statusCode: 200,
    setHeader() {},
    writeHead(code) { this._status = code; captureRes.statusCode = code; },
    end(data) {
      try {
        const createResponse = JSON.parse(data);
        // Flatten critical fields to top-level
        bridgeResult = {
          ...bridgeResult,
          ...createResponse,
          success:         createResponse.success === true,
          write_performed: createResponse.write_performed === true,
          booking_id:      createResponse.booking_id      || createResponse.bookingId      || null,
          booking_code:    createResponse.booking_code    || createResponse.bookingCode    || null,
          payment_id:      createResponse.payment_id      || (createResponse.payment && createResponse.payment.payment_id) || null,
          payment_status:  createResponse.payment_status  || (createResponse.payment && createResponse.payment.status)    || null,
          created:         createResponse.created         != null ? createResponse.created  : undefined,
          duplicate:       createResponse.duplicate       != null ? createResponse.duplicate : undefined,
        };
      } catch (_) {
        bridgeResult.raw_response = String(data);
      }
    },
  };

  // Delegate to the existing handleBotBookingCreate in staff-query-api.js via ctx
  if (ctx.handleBotBookingCreate) {
    await ctx.handleBotBookingCreate(
      makeInMemoryBotReq(body),
      captureRes,
      user,
      authMode
    );
  } else {
    return sendJSON(res, 503, { success: false, error: 'handleBotBookingCreate not wired in ctx' });
  }

  return sendJSON(res, captureRes._status, bridgeResult);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /staff/bot/payments/:payment_id/create-stripe-link  (Stage 8.5.5)
//
// Bot-authenticated Stripe Checkout Session creation.
// Returns guest_payment_url and payment_short_url (short /pay/ link).
// Idempotent: returns existing session if already created.
// ─────────────────────────────────────────────────────────────────────────────
async function handleBotPaymentCreateStripeLink(paymentId, req, res, user, authMode, ctx) {
  const {
    sendJSON, withPgClient, appendAuditLog,
    guestPaymentLinkObservability,
    BOT_BOOKING_ENABLED, STRIPE_LINKS_ENABLED, STRIPE_SECRET_KEY,
    STAFF_AUTH_REQUIRED,
    stripeCheckoutRedirectUrlsConfigured,
    stripeCheckoutSessionSuccessUrl,
    stripeCheckoutSessionCancelUrl,
  } = ctx;

  if (!BOT_BOOKING_ENABLED) {
    return sendJSON(res, 403, {
      success: false,
      error:   'Bot booking is disabled. Set BOT_BOOKING_ENABLED=true to enable.',
      bot_booking_enabled: false,
    });
  }
  if (!STRIPE_LINKS_ENABLED) {
    return sendJSON(res, 403, {
      success: false,
      error:   'Stripe link creation is disabled. Set STRIPE_LINKS_ENABLED=true to enable.',
      stripe_links_enabled: false,
    });
  }
  if (!STRIPE_SECRET_KEY) {
    return sendJSON(res, 503, { success: false, error: 'STRIPE_SECRET_KEY not configured.', no_db_write: true });
  }
  if (!stripeCheckoutRedirectUrlsConfigured()) {
    return sendJSON(res, 503, {
      success: false,
      error:   'STRIPE_CHECKOUT_SUCCESS_URL and STRIPE_CHECKOUT_CANCEL_URL must be set in env.',
      no_db_write: true,
    });
  }

  let stripe;
  try {
    stripe = require('stripe')(STRIPE_SECRET_KEY);
  } catch (e) {
    return sendJSON(res, 500, { success: false, error: 'Failed to load Stripe SDK: ' + e.message, no_db_write: true });
  }

  let pm;
  try {
    pm = await withPgClient(async (pg) => {
      const r = await pg.query(
        `SELECT p.id              AS payment_id,
                p.client_id,
                p.booking_id,
                p.status          AS payment_status,
                p.payment_kind,
                p.currency,
                p.amount_due_cents,
                p.stripe_checkout_session_id,
                p.checkout_url,
                b.booking_code,
                b.guest_name,
                b.check_in,
                b.check_out,
                b.status          AS booking_status,
                cl.slug           AS client_slug
           FROM payments p
           JOIN bookings b  ON b.id  = p.booking_id
           JOIN clients  cl ON cl.id = p.client_id
          WHERE p.id = $1`, [paymentId]
      );
      return r.rows[0] || null;
    });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'DB fetch failed: ' + err.message });
  }

  if (!pm) {
    return sendJSON(res, 404, { success: false, error: 'Payment record not found.' });
  }

  // Idempotent: already has a Stripe session
  if (pm.payment_status !== 'draft') {
    if (pm.payment_status === 'checkout_created' && pm.checkout_url) {
      const linkObs = guestPaymentLinkObservability(pm, pm.checkout_url, pm.stripe_checkout_session_id);
      return sendJSON(res, 200, {
        success:                    true,
        idempotent:                 true,
        source:                     'luna_whatsapp',
        payment_id:                 pm.payment_id,
        booking_id:                 pm.booking_id,
        booking_code:               pm.booking_code,
        amount_due_cents:           pm.amount_due_cents,
        currency:                   pm.currency,
        stripe_checkout_session_id: pm.stripe_checkout_session_id,
        checkout_url:               pm.checkout_url,
        payment_short_url:          linkObs.payment_short_url,
        guest_payment_url:          linkObs.guest_payment_url,
        uses_short_payment_link:    linkObs.uses_short_payment_link,
        payment_status:             pm.payment_status,
        next_action:                'draft_payment_link_reply',
        sends_whatsapp:             false,
        whatsapp_dry_run:           true,
        no_payment_truth_recorded:  true,
        message: 'Stripe session already created (idempotent response).',
      });
    }
    return sendJSON(res, 409, {
      success: false,
      error:   `Payment status '${pm.payment_status}'; only 'draft' payments can create a Stripe link.`,
    });
  }

  if (!pm.amount_due_cents || pm.amount_due_cents <= 0) {
    return sendJSON(res, 422, { success: false, error: 'amount_due_cents must be > 0.' });
  }
  if ((pm.currency || '').toUpperCase() !== 'EUR') {
    return sendJSON(res, 422, { success: false, error: `Currency '${pm.currency}' not supported (EUR only).` });
  }

  const started     = Date.now();
  const productName = `Booking ${pm.booking_code || paymentId} \u2014 ${pm.guest_name || 'Guest'}`;
  const productDesc = `${pm.payment_kind === 'full_amount' ? 'Full payment' : 'Deposit'} | ` +
    `${pm.check_in || ''} \u2013 ${pm.check_out || ''} | ${pm.client_slug}`;
  const actorId = user ? user.staff_user_id : 'luna-bot-internal';

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode:     'payment',
      currency: 'eur',
      line_items: [{
        price_data: {
          currency:     'eur',
          product_data: { name: productName, description: productDesc },
          unit_amount:  pm.amount_due_cents,
        },
        quantity: 1,
      }],
      metadata: {
        client_slug:  pm.client_slug,
        booking_id:   pm.booking_id,
        booking_code: pm.booking_code  || '',
        payment_id:   paymentId,
        payment_kind: pm.payment_kind  || '',
        source:       'bot_stage855',
      },
      success_url: stripeCheckoutSessionSuccessUrl(),
      cancel_url:  stripeCheckoutSessionCancelUrl(),
    });
  } catch (stripeErr) {
    return sendJSON(res, 500, {
      success:     false,
      error:       'Stripe session creation failed: ' + stripeErr.message,
      no_db_write: true,
    });
  }

  const expiresAt = session.expires_at
    ? new Date(session.expires_at * 1000).toISOString()
    : null;

  try {
    await withPgClient(async (pg) => {
      await pg.query(
        `UPDATE payments
           SET status                      = 'checkout_created'::payment_record_status,
               stripe_checkout_session_id  = $1,
               checkout_url                = $2,
               expires_at                  = $3,
               metadata                    = metadata || $4::jsonb
         WHERE id = $5`,
        [
          session.id, session.url, expiresAt,
          JSON.stringify({
            stripe_session_id:     session.id,
            stripe_livemode:       session.livemode,
            stripe_payment_status: session.payment_status,
            created_by:            actorId,
            source:                'bot_stage855',
          }),
          paymentId,
        ]
      );
    });
  } catch (dbErr) {
    if (appendAuditLog) appendAuditLog({
      ts: new Date().toISOString(), intent: 'api:bot_payment_create_stripe_link',
      category: 'bot_stripe_link_create', success: false,
      error: 'stripe_session_created_but_db_update_failed: ' + dbErr.message,
      payment_id: paymentId, session_id: session.id, elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, 500, {
      success:      false,
      error:        'Stripe session created but DB update failed: ' + dbErr.message,
      session_id:   session.id,
      checkout_url: session.url,
    });
  }

  const elapsed  = Date.now() - started;
  const linkObs  = guestPaymentLinkObservability(pm, session.url, session.id);

  if (appendAuditLog) appendAuditLog({
    ts: new Date().toISOString(), intent: 'api:bot_payment_create_stripe_link',
    category: 'bot_stripe_link_create', success: true,
    payment_id: paymentId, booking_id: pm.booking_id, booking_code: pm.booking_code,
    stripe_session_id: session.id, amount_due_cents: pm.amount_due_cents,
    auth_mode: authMode, elapsed_ms: elapsed,
    stripe_called: true, whatsapp_called: false, n8n_called: false,
  });

  return sendJSON(res, 200, {
    success:                    true,
    source:                     'luna_whatsapp',
    auth_mode:                  authMode || (STAFF_AUTH_REQUIRED ? 'session' : 'open'),
    payment_id:                 paymentId,
    booking_id:                 pm.booking_id,
    booking_code:               pm.booking_code,
    amount_due_cents:           pm.amount_due_cents,
    currency:                   pm.currency,
    stripe_checkout_session_id: session.id,
    checkout_url:               session.url,
    payment_short_url:          linkObs.payment_short_url,
    guest_payment_url:          linkObs.guest_payment_url,
    uses_short_payment_link:    linkObs.uses_short_payment_link,
    payment_status:             'checkout_created',
    next_action:                'draft_payment_link_reply',
    sends_whatsapp:             false,
    whatsapp_dry_run:           true,
    no_payment_truth_recorded:  true,
    no_n8n:                     true,
    message:                    'Stripe Checkout Session created. Bot can share guest_payment_url. Payment truth via webhook.',
    elapsed_ms:                 elapsed,
  });
}

module.exports = {
  makeInMemoryBotReq,
  handleBotTransferSave,
  handleBotPaymentStatus,
  handleBotBookingCreateFromPlan,
  handleBotPaymentCreateStripeLink,
};
