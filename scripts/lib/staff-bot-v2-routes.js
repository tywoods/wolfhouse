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

const { normalizeAirportCode } = require('./client-transfer-config');

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

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * Expand direction:"both" into arrival + departure payloads. Luna/Hermes may send
 * one combined direction when the guest gave both shuttle times.
 *
 * @param {object} body
 * @returns {object[]}
 */
function expandTransferDirectionPayloads(body) {
  const src = body || {};
  const dir = trimStr(src.direction).toLowerCase() || 'arrival';
  if (dir !== 'both') return [{ ...src, direction: dir }];
  const arrival = { ...src, direction: 'arrival' };
  const departure = { ...src, direction: 'departure' };
  if (src.arrival_datetime) {
    arrival.scheduled_at = src.arrival_datetime;
  }
  if (src.departure_datetime) {
    departure.scheduled_at = src.departure_datetime;
  }
  return [arrival, departure];
}

/**
 * Collect pending_transfers from a booking-create body (list or single dict).
 *
 * @param {object} body
 * @returns {object[]}
 */
function collectPendingTransferEntries(body) {
  let raw = body && body.pending_transfers;
  if (!raw && body && body.pending_transfer) raw = [body.pending_transfer];
  if (!Array.isArray(raw) || !raw.length) return [];
  const entries = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const expanded = expandTransferDirectionPayloads(entry);
    for (const item of expanded) {
      entries.push(item);
    }
  }
  return entries;
}

function resolveBotTransferAirportCode(clientSlug, entry) {
  const raw = trimStr(
    entry.airport_code
    || entry.airport
    || entry.airport_or_city
    || entry.arrival_airport_or_city,
  );
  return normalizeAirportCode(clientSlug, raw) || trimStr(entry.airport_code).toUpperCase() || null;
}

function resolveBotTransferScheduledAt(entry, direction) {
  const dir = trimStr(direction).toLowerCase();
  if (dir === 'arrival') {
    return trimStr(
      entry.scheduled_at
      || entry.transfer_datetime
      || entry.arrival_datetime,
    ) || null;
  }
  if (dir === 'departure') {
    return trimStr(
      entry.scheduled_at
      || entry.transfer_datetime
      || entry.departure_datetime,
    ) || null;
  }
  return trimStr(entry.scheduled_at || entry.transfer_datetime) || null;
}

/**
 * Build one Staff API transfer write payload for handlePostBookingTransfer.
 */
function buildBotTransferWritePayload(entry, bookingId, bookingCode, clientSlug, transferSource) {
  const direction = trimStr(entry.direction).toLowerCase() || 'arrival';
  const airportCode = resolveBotTransferAirportCode(clientSlug, entry);
  const scheduledAt = resolveBotTransferScheduledAt(entry, direction);
  const payload = {
    client_slug: clientSlug,
    booking_id: bookingId,
    booking_code: bookingCode || undefined,
    source: transferSource,
    direction,
    confirm_transfer_write: true,
  };
  if (airportCode) payload.airport_code = airportCode;
  if (scheduledAt) payload.scheduled_at = scheduledAt;
  if (entry.flight_number) payload.flight_number = entry.flight_number;
  if (entry.notes) payload.notes = entry.notes;
  if (entry.guest_count != null) payload.guest_count = entry.guest_count;
  if (entry.luggage_or_surfboards) payload.notes = trimStr(payload.notes
    ? `${payload.notes}; ${entry.luggage_or_surfboards}`
    : entry.luggage_or_surfboards);
  return payload;
}

/**
 * Execute one delegated transfer write (no HTTP response side effects).
 */
async function execDelegatedTransferWrite(bookingId, transferPayload, handlePostBookingTransfer) {
  let statusCode = 500;
  let result = null;
  const jsonRes = {
    status(code) {
      statusCode = code;
      return jsonRes;
    },
    json(obj) {
      result = obj;
      return jsonRes;
    },
  };
  await handlePostBookingTransfer(
    bookingId,
    makeInMemoryBotReq(transferPayload),
    jsonRes,
  );
  const transfer = result && result.transfer;
  const writePerformed = result && (
    result.write_performed === true
    || (result.success === true && transfer && transfer.id)
  );
  return {
    statusCode,
    success: result && result.success === true,
    write_performed: writePerformed,
    direction: transferPayload.direction,
    transfer,
    error: result && result.error,
  };
}

/**
 * Persist pending transfer rows after booking create (best-effort).
 */
async function savePendingTransfersForBooking(body, bookingId, bookingCode, ctx) {
  const {
    handlePostBookingTransfer,
    DEFAULT_CLIENT,
  } = ctx;
  const clientSlug = trimStr(body.client_slug || DEFAULT_CLIENT);
  const entries = collectPendingTransferEntries(body);
  if (!entries.length || !bookingId) return { results: [], saved: [] };

  const allowedTransferSources = new Set(['staff', 'luna', 'owner', 'import', 'flight_lookup']);
  const requestedSource = trimStr(body.source);
  const transferSource = allowedTransferSources.has(requestedSource) ? requestedSource : 'luna';

  const results = [];
  for (const entry of entries) {
    const transferPayload = buildBotTransferWritePayload(
      entry,
      bookingId,
      bookingCode,
      clientSlug,
      transferSource,
    );
    try {
      const out = await execDelegatedTransferWrite(
        bookingId,
        transferPayload,
        handlePostBookingTransfer,
      );
      results.push({
        direction: transferPayload.direction,
        write_performed: out.write_performed,
        success: out.success,
        error: out.error || null,
      });
    } catch (err) {
      results.push({
        direction: transferPayload.direction,
        write_performed: false,
        success: false,
        error: err.message || String(err),
      });
    }
  }
  const saved = results.filter((r) => r.write_performed);
  return { results, saved };
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

  const directionPayloads = expandTransferDirectionPayloads(body);

  if (body.confirm_transfer_write !== true) {
    const previewDir = directionPayloads[0] || body;
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
        direction:    previewDir.direction    || null,
        airport_code: resolveBotTransferAirportCode(clientSlug, previewDir) || previewDir.airport || null,
        scheduled_at: resolveBotTransferScheduledAt(previewDir, previewDir.direction) || null,
        flight_number: previewDir.flight_number || null,
        notes:        previewDir.notes || null,
      },
      directions: directionPayloads.map((d) => d.direction),
      next_action: 'confirm_transfer_write_to_save',
    });
  }

  try {
    const transferResults = [];
    let lastTransfer = null;
    let allOk = true;
    let lastStatus = 200;

    for (const dirPayload of directionPayloads) {
      const transferPayload = buildBotTransferWritePayload(
        dirPayload,
        bookingId,
        bookingCode,
        clientSlug,
        transferSource,
      );
      const out = await execDelegatedTransferWrite(
        bookingId,
        transferPayload,
        handlePostBookingTransfer,
      );
      transferResults.push({
        direction: transferPayload.direction,
        write_performed: out.write_performed,
        success: out.success,
        error: out.error || null,
      });
      if (out.transfer) lastTransfer = out.transfer;
      if (!out.success) allOk = false;
      if (out.statusCode >= 400) lastStatus = out.statusCode;
    }

    const writePerformed = transferResults.some((r) => r.write_performed);
    return sendJSON(res, lastStatus >= 400 && !writePerformed ? lastStatus : 200, {
      success: allOk || writePerformed,
      write_performed: writePerformed,
      booking_id: bookingId,
      booking_code: bookingCode || null,
      direction: directionPayloads.length === 1 ? directionPayloads[0].direction : 'both',
      transfer: lastTransfer,
      transfer_save_results: transferResults,
      transfers_saved: transferResults.filter((r) => r.write_performed),
      source: 'luna_bot_transfer_save',
      auth_mode: authMode || (STAFF_AUTH_REQUIRED ? 'session' : 'open'),
      no_payment_write: true,
      no_whatsapp: true,
      no_n8n: true,
    });
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
          write_performed: createResponse.write_performed === true
            || createResponse.created === true
            || (createResponse.success === true && createResponse.booking_id && !createResponse.duplicate),
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

  if (
    bridgeResult.success
    && bridgeResult.booking_id
    && collectPendingTransferEntries(body).length
    && ctx.handlePostBookingTransfer
  ) {
    const pkg = String(body.package_code || '').trim().toLowerCase();
    const skipTransfers = !pkg || pkg === 'package_none' || pkg === 'no_package' || pkg === 'accommodation_only';
    if (!skipTransfers) {
      const { results, saved } = await savePendingTransfersForBooking(
        body,
        bridgeResult.booking_id,
        bridgeResult.booking_code,
        ctx,
      );
      bridgeResult.transfer_save_results = results;
      bridgeResult.transfers_saved = saved;
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /staff/bot/payments/create-balance-link
//
// Mint (or reuse) a Stripe link for the REMAINING invoice balance on an
// existing booking. Mirrors staff POST /staff/bookings/generate-payment-link
// and scripts/lib/luna-guest-balance-payment-link-create.js — bot auth path.
// ─────────────────────────────────────────────────────────────────────────────
async function handleBotCreateBalancePaymentLink(req, res, user, authMode, ctx) {
  const {
    sendJSON, readBody, withPgClient, appendAuditLog,
    guestPaymentLinkObservability,
    BOT_BOOKING_ENABLED, STRIPE_LINKS_ENABLED, STRIPE_SECRET_KEY,
    STAFF_AUTH_REQUIRED, DEFAULT_CLIENT,
    stripeCheckoutRedirectUrlsConfigured,
    stripeCheckoutSessionSuccessUrl,
    stripeCheckoutSessionCancelUrl,
    EDIT_PREVIEW_BOOKING_BY_ID_SQL,
    EDIT_PREVIEW_BOOKING_BY_CODE_SQL,
    BOOKING_PAYMENTS_LEDGER_SQL,
    loadBookingServiceRecords,
    listBookingTransfersForBooking,
    bookingLedgerBalanceFromRows,
    ledgerActivePaymentLinkRow,
    bookingStatusIsCancelled,
    UUID_VALIDATE_RE,
    SQL_INJECT_RE,
  } = ctx;

  const started = Date.now();

  if (!BOT_BOOKING_ENABLED) {
    return sendJSON(res, 403, {
      success: false,
      error: 'Bot booking is disabled. Set BOT_BOOKING_ENABLED=true to enable.',
      bot_booking_enabled: false,
    });
  }
  if (!STRIPE_LINKS_ENABLED) {
    return sendJSON(res, 403, {
      success: false,
      error: 'Stripe link creation is disabled. Set STRIPE_LINKS_ENABLED=true to enable.',
      stripe_links_enabled: false,
    });
  }
  if (!STRIPE_SECRET_KEY) {
    return sendJSON(res, 503, { success: false, error: 'STRIPE_SECRET_KEY not configured.', no_db_write: true });
  }
  if (!stripeCheckoutRedirectUrlsConfigured()) {
    return sendJSON(res, 503, {
      success: false,
      error: 'STRIPE_CHECKOUT_SUCCESS_URL and STRIPE_CHECKOUT_CANCEL_URL must be set in env.',
      no_db_write: true,
    });
  }

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (_) {
    return sendJSON(res, 400, { success: false, error: 'invalid or missing JSON body' });
  }

  const clientSlug  = String(body.client_slug || body.client || DEFAULT_CLIENT).trim();
  const bookingId   = String(body.booking_id || body.bookingId || '').trim();
  const bookingCode = String(body.booking_code || body.bookingCode || '').trim();

  if (SQL_INJECT_RE && SQL_INJECT_RE.test(clientSlug)) {
    return sendJSON(res, 400, { success: false, error: 'invalid client slug' });
  }
  if (!bookingId && !bookingCode) {
    return sendJSON(res, 400, { success: false, error: 'booking_id or booking_code is required' });
  }
  if (bookingId && UUID_VALIDATE_RE && !UUID_VALIDATE_RE.test(bookingId)) {
    return sendJSON(res, 400, { success: false, error: 'booking_id must be a valid UUID' });
  }

  let bookingRow;
  let svcRows = [];
  let paymentRows = [];
  let transferRows = [];
  try {
    const loaded = await withPgClient(async (pg) => {
      const bookingRes = await pg.query(
        bookingId ? EDIT_PREVIEW_BOOKING_BY_ID_SQL : EDIT_PREVIEW_BOOKING_BY_CODE_SQL,
        [clientSlug, bookingId || bookingCode],
      );
      const bk = bookingRes.rows[0] || null;
      if (!bk) return { booking: null, svc: [], payments: [], transfers: [] };
      const svc = await loadBookingServiceRecords(pg, clientSlug, bk.booking_code);
      const pm = await pg.query(BOOKING_PAYMENTS_LEDGER_SQL, [clientSlug, bk.booking_code]);
      const transfers = await listBookingTransfersForBooking(pg, {
        client_slug: clientSlug,
        booking_id: bk.booking_id,
      });
      return { booking: bk, svc: svc.rows, payments: pm.rows, transfers };
    });
    bookingRow = loaded.booking;
    svcRows = loaded.svc;
    paymentRows = loaded.payments;
    transferRows = loaded.transfers || [];
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'booking lookup failed', detail: err.message });
  }

  if (!bookingRow) {
    return sendJSON(res, 404, { success: false, error: 'booking_not_found' });
  }

  if (bookingStatusIsCancelled(bookingRow.status)) {
    return sendJSON(res, 400, {
      success: false,
      error: 'booking_not_active',
      message: 'Cannot create a payment link on a cancelled or expired booking.',
    });
  }

  const ledger = bookingLedgerBalanceFromRows(bookingRow, svcRows, paymentRows, transferRows);
  const amountDueCents = ledger.balance_due_cents;

  if (ledger.needs_refund) {
    return sendJSON(res, 409, {
      success: false,
      error: 'refund_review_needed',
      staff_review_needed: true,
      message: 'Refund / credit review needed before creating a payment link.',
    });
  }

  if (amountDueCents == null || amountDueCents <= 0) {
    return sendJSON(res, 200, {
      success: false,
      error: 'no_balance_due',
      reason: 'no_balance_due',
      booking_id: bookingRow.booking_id,
      booking_code: bookingRow.booking_code,
      amount_due_cents: 0,
      balance_due_cents: 0,
      message: 'No outstanding balance due.',
      staff_review_needed: false,
    });
  }

  const paySt = String(bookingRow.payment_status || '').toLowerCase();
  const eligiblePay = ['deposit_paid', 'balance_due', 'confirmed', 'hold'].includes(paySt)
    || Number(bookingRow.amount_paid_cents || 0) > 0;
  if (!eligiblePay) {
    return sendJSON(res, 409, {
      success: false,
      error: 'booking_not_eligible',
      reason: 'deposit_not_paid',
      booking_id: bookingRow.booking_id,
      booking_code: bookingRow.booking_code,
      staff_review_needed: true,
    });
  }

  const idempotencyKey = `luna-bot-balance:${bookingRow.booking_id}:${amountDueCents}`;
  const actorId = user ? user.staff_user_id : 'luna-bot-internal';

  const finishWithLink = (payload) => {
    const checkoutUrl = payload.checkout_url;
    const linkObs = guestPaymentLinkObservability(
      { booking_code: bookingRow.booking_code, client_slug: clientSlug },
      checkoutUrl,
      payload.stripe_checkout_session_id || null,
    );
    return sendJSON(res, 200, {
      success: true,
      source: 'luna_bot_balance_payment_link',
      auth_mode: authMode || (STAFF_AUTH_REQUIRED ? 'session' : 'open'),
      idempotent: !!payload.idempotent,
      created: payload.created !== false,
      booking_id: bookingRow.booking_id,
      booking_code: bookingRow.booking_code,
      client_slug: clientSlug,
      payment_id: payload.payment_id || null,
      amount_due_cents: amountDueCents,
      balance_due_cents: amountDueCents,
      currency: 'EUR',
      checkout_url: checkoutUrl,
      payment_short_url: linkObs.payment_short_url,
      guest_payment_url: linkObs.guest_payment_url,
      uses_short_payment_link: linkObs.uses_short_payment_link,
      secure_payment_url: linkObs.guest_payment_url || checkoutUrl,
      payment_status: 'checkout_created',
      next_action: 'send_secure_payment_link',
      sends_whatsapp: false,
      no_payment_truth_recorded: true,
      no_n8n: true,
      staff_review_needed: false,
      message: payload.message || 'Balance payment link ready for guest.',
      elapsed_ms: Date.now() - started,
    });
  };

  const existingByKey = paymentRows.find((pr) => {
    let parsed = pr.metadata;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch (_) { parsed = {}; }
    }
    return parsed && parsed.idempotency_key === idempotencyKey && pr.checkout_url;
  });
  if (existingByKey) {
    return finishWithLink({
      idempotent: true,
      created: false,
      payment_id: existingByKey.payment_id,
      checkout_url: existingByKey.checkout_url,
      message: 'Payment link already created (idempotent).',
    });
  }

  const activeLink = ledgerActivePaymentLinkRow(paymentRows, ledger);
  if (activeLink && activeLink.checkout_url) {
    return finishWithLink({
      idempotent: true,
      created: false,
      payment_id: activeLink.payment_id,
      checkout_url: activeLink.checkout_url,
      message: 'Payment link already exists for this balance.',
    });
  }

  let stripe;
  try {
    stripe = require('stripe')(STRIPE_SECRET_KEY);
  } catch (e) {
    return sendJSON(res, 500, { success: false, error: 'Failed to load Stripe SDK: ' + e.message, no_db_write: true });
  }

  const pmMeta = {
    source: 'luna_bot_balance_payment_link',
    method: 'payment_link',
    idempotency_key: idempotencyKey,
    booking_code: bookingRow.booking_code,
    amount_due_cents: amountDueCents,
    payment_origin: 'luna_bot_balance_payment_link',
    created_by: actorId,
  };

  let newPaymentId;
  try {
    const insResult = await withPgClient(async (pg) => {
      const clientRes = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
      const clientId = clientRes.rows[0] && clientRes.rows[0].id;
      if (!clientId) throw new Error('client not found');
      const ins = await pg.query(
        `INSERT INTO payments (
           client_id, booking_id, status, payment_kind, currency,
           amount_due_cents, amount_paid_cents, metadata
         ) VALUES (
           $1, $2::uuid, 'draft'::payment_record_status, 'full_amount'::payment_kind, 'EUR',
           $3, 0, $4::jsonb
         )
         RETURNING id::text AS payment_id`,
        [clientId, bookingRow.booking_id, amountDueCents, JSON.stringify(pmMeta)],
      );
      return ins.rows[0].payment_id;
    });
    newPaymentId = insResult;
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'payment draft insert failed', detail: err.message });
  }

  const productName = `Booking ${bookingRow.booking_code || newPaymentId} \u2014 ${bookingRow.guest_name || 'Guest'}`;
  const productDesc = `Outstanding balance | ${bookingRow.check_in || ''} \u2013 ${bookingRow.check_out || ''} | ${clientSlug}`;

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'eur',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: productName, description: productDesc },
          unit_amount: amountDueCents,
        },
        quantity: 1,
      }],
      metadata: {
        client_slug: clientSlug,
        booking_id: bookingRow.booking_id,
        booking_code: bookingRow.booking_code || '',
        payment_id: newPaymentId,
        payment_kind: 'full_amount',
        source: 'luna_bot_balance_payment_link',
        idempotency_key: idempotencyKey,
      },
      success_url: stripeCheckoutSessionSuccessUrl(),
      cancel_url: stripeCheckoutSessionCancelUrl(),
    });
  } catch (stripeErr) {
    return sendJSON(res, 500, {
      success: false,
      error: 'Stripe session creation failed: ' + stripeErr.message,
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
            SET status                     = 'checkout_created'::payment_record_status,
                stripe_checkout_session_id = $1,
                checkout_url               = $2,
                expires_at                 = $3,
                metadata                   = metadata || $4::jsonb
          WHERE id = $5::uuid`,
        [
          session.id,
          session.url,
          expiresAt,
          JSON.stringify({
            stripe_session_id: session.id,
            stripe_livemode: session.livemode,
            payment_link_url: session.url,
            created_by: actorId,
            source: 'luna_bot_balance_payment_link',
          }),
          newPaymentId,
        ],
      );
    });
  } catch (dbErr) {
    if (appendAuditLog) {
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:bot_balance_payment_link',
        category: 'bot_balance_payment_link_create',
        success: false,
        error: 'stripe_session_created_but_db_update_failed: ' + dbErr.message,
        payment_id: newPaymentId,
        session_id: session.id,
        elapsed_ms: Date.now() - started,
      });
    }
    return sendJSON(res, 500, {
      success: false,
      error: 'Stripe session created but DB update failed: ' + dbErr.message,
      checkout_url: session.url,
      staff_review_needed: true,
    });
  }

  if (appendAuditLog) {
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:bot_balance_payment_link',
      category: 'bot_balance_payment_link_create',
      success: true,
      payment_id: newPaymentId,
      booking_id: bookingRow.booking_id,
      booking_code: bookingRow.booking_code,
      stripe_session_id: session.id,
      amount_due_cents: amountDueCents,
      auth_mode: authMode,
      elapsed_ms: Date.now() - started,
      stripe_called: true,
      whatsapp_called: false,
      n8n_called: false,
    });
  }

  return finishWithLink({
    idempotent: false,
    created: true,
    payment_id: newPaymentId,
    checkout_url: session.url,
    stripe_checkout_session_id: session.id,
    message: 'Balance payment link created.',
  });
}

module.exports = {
  makeInMemoryBotReq,
  expandTransferDirectionPayloads,
  collectPendingTransferEntries,
  buildBotTransferWritePayload,
  savePendingTransfersForBooking,
  execDelegatedTransferWrite,
  handleBotTransferSave,
  handleBotPaymentStatus,
  handleBotBookingCreateFromPlan,
  handleBotPaymentCreateStripeLink,
  handleBotCreateBalancePaymentLink,
};
