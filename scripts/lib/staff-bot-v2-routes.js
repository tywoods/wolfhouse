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
const {
  computePackagePricePreview,
  buildGuestPaymentShortLinkPath,
  guestPaymentStatusFromRow,
  isMissingBookingGuestsTable,
  normalizeBookingGuestsInput,
  mapBotBookingCreateErrorToBlockedReason,
} = require('./booking-guests');
const { buildPaymentShortLink } = require('./luna-payment-short-link');

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

  const guestsNormPreview = normalizeBookingGuestsInput(body);
  const usesPerGuestModelPreview = guestsNormPreview.uses_per_guest_model === true;

  // Build a synthetic result accumulator
  let bridgeResult = {
    success:          false,
    write_performed:  false,
    client_slug:      clientSlug,
    auth_mode:        authMode || (STAFF_AUTH_REQUIRED ? 'session' : 'open'),
    no_whatsapp:      true,
    no_n8n:           true,
    source:           'luna_bot_booking_create_from_plan',
    uses_per_guest_model: usesPerGuestModelPreview,
    blocked_reasons:  [],
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

  if (!bridgeResult.success && (!Array.isArray(bridgeResult.blocked_reasons) || bridgeResult.blocked_reasons.length === 0)) {
    const blocked = mapBotBookingCreateErrorToBlockedReason(bridgeResult.error || bridgeResult.message);
    bridgeResult.blocked_reasons = [blocked];
  }
  if (bridgeResult.success !== true && bridgeResult.staff_review_needed !== false) {
    bridgeResult.staff_review_needed = true;
  }
  if (Array.isArray(bridgeResult.blocked_reasons) && bridgeResult.blocked_reasons.length > 0) {
    bridgeResult.staff_review_needed = true;
  }
  bridgeResult.uses_per_guest_model = bridgeResult.uses_per_guest_model === true
    || usesPerGuestModelPreview === true;

  if (
    bridgeResult.success
    && bridgeResult.write_performed
    && bridgeResult.uses_per_guest_model
    && Array.isArray(bridgeResult.booking_guests)
    && bridgeResult.booking_guests.length
    && ctx.handleBotGuestPaymentCreateLink
    && ctx.STRIPE_LINKS_ENABLED
    && ctx.STRIPE_SECRET_KEY
  ) {
    const paymentTarget = String(body.payment_choice || '').toLowerCase().includes('full')
      ? 'full_share'
      : 'deposit';
    const guestLinks = [];
    for (const guestRow of bridgeResult.booking_guests) {
      const guestId = guestRow && (guestRow.booking_guest_id || guestRow.id);
      if (!guestId) continue;
      const linkCapture = {
        _status: 200,
        statusCode: 200,
        setHeader() {},
        writeHead(code) { this._status = code; linkCapture.statusCode = code; },
        end(data) {
          try {
            linkCapture._body = JSON.parse(data);
          } catch (_) {
            linkCapture._body = { success: false, error: String(data) };
          }
        },
      };
      try {
        await ctx.handleBotGuestPaymentCreateLink(
          guestId,
          makeInMemoryBotReq({
            client_slug: clientSlug,
            payment_target: paymentTarget,
          }),
          linkCapture,
          user,
          authMode,
        );
        const linkBody = linkCapture._body || {};
        if (linkBody.success) {
          guestLinks.push({
            guest_number: linkBody.guest_number || guestRow.guest_number,
            guest_name: linkBody.guest_name || guestRow.guest_name,
            booking_guest_id: linkBody.booking_guest_id || guestId,
            payment_id: linkBody.payment_id || null,
            secure_payment_url: linkBody.guest_payment_url || linkBody.payment_short_url || linkBody.checkout_url || null,
          });
        }
      } catch (_) { /* non-fatal — guest can retry create_guest_payment_link */ }
    }
    if (guestLinks.length) {
      bridgeResult.guest_payment_links = guestLinks;
      bridgeResult.per_guest_payment_links_created = guestLinks.length;
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
         WHERE id = $5
           AND client_id = $6`,
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
          pm.client_id,
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

  // Ledger balance_due already reflects unpaid accommodation + post-booking add-ons.
  // Do not require deposit_paid here — staff generate-payment-link does not either.

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
  let balanceLinkClientId;
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
      return { payment_id: ins.rows[0].payment_id, client_id: clientId };
    });
    newPaymentId = insResult.payment_id;
    balanceLinkClientId = insResult.client_id;
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
          WHERE id = $5::uuid
            AND client_id = $6`,
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
          balanceLinkClientId,
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /staff/bot/package-price-preview  (Slice A5 — read-only for Luna)
// ─────────────────────────────────────────────────────────────────────────────
async function handleBotPackagePricePreview(req, res, user, authMode, ctx) {
  const { sendJSON, send400, readBody, DEFAULT_CLIENT } = ctx;

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (_) {
    return send400(res, 'invalid or missing JSON body');
  }

  const clientSlug = String(body.client_slug || DEFAULT_CLIENT).trim();
  const checkIn = String(body.check_in || '').trim();
  const checkOut = String(body.check_out || '').trim();
  const guestCount = parseInt(body.guest_count, 10) || 0;
  const roomType = String(body.room_type || 'shared').trim();

  if (!checkIn || !checkOut) return send400(res, 'check_in and check_out are required');
  if (guestCount < 1) return send400(res, 'guest_count must be at least 1');

  const preview = computePackagePricePreview({
    client_slug: clientSlug,
    check_in: checkIn,
    check_out: checkOut,
    guest_count: guestCount,
    room_type: roomType,
  });

  return sendJSON(res, 200, {
    success: preview.success,
    source: 'luna_bot_package_price_preview',
    auth_mode: authMode,
    client_slug: clientSlug,
    check_in: checkIn,
    check_out: checkOut,
    guest_count: guestCount,
    nights: preview.nights,
    season_code: preview.season_code,
    packages: preview.packages,
    no_db_write: true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /staff/bot/booking-guests/:guest_id/create-payment-link  (Slice A3)
// Body: { client_slug, payment_target: 'deposit' | 'full_share' }
// ─────────────────────────────────────────────────────────────────────────────
async function handleBotGuestPaymentCreateLink(guestId, req, res, user, authMode, ctx) {
  const {
    sendJSON, send400, readBody, withPgClient, appendAuditLog,
    guestPaymentLinkObservability,
    BOT_BOOKING_ENABLED, STRIPE_LINKS_ENABLED, STRIPE_SECRET_KEY,
    DEFAULT_CLIENT,
    stripeCheckoutRedirectUrlsConfigured,
    stripeCheckoutSessionSuccessUrl,
    stripeCheckoutSessionCancelUrl,
    STAFF_ACTIONS_ENABLED,
  } = ctx;

  if (!BOT_BOOKING_ENABLED && !STAFF_ACTIONS_ENABLED) {
    return sendJSON(res, 403, { success: false, error: 'Bot booking is disabled.', bot_booking_enabled: false });
  }
  if (!STRIPE_LINKS_ENABLED) {
    return sendJSON(res, 403, { success: false, error: 'Stripe links disabled.', stripe_links_enabled: false });
  }
  if (!STRIPE_SECRET_KEY) {
    return sendJSON(res, 503, { success: false, error: 'STRIPE_SECRET_KEY not configured.', no_db_write: true });
  }
  if (!stripeCheckoutRedirectUrlsConfigured()) {
    return sendJSON(res, 503, { success: false, error: 'Stripe redirect URLs not configured.', no_db_write: true });
  }

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (_) {
    return send400(res, 'invalid or missing JSON body');
  }

  const clientSlug = String(body.client_slug || DEFAULT_CLIENT).trim();
  const paymentTarget = String(body.payment_target || 'deposit').trim().toLowerCase();
  const actorId = user ? user.staff_user_id : 'luna-bot-internal';

  let stripe;
  try {
    stripe = require('stripe')(STRIPE_SECRET_KEY);
  } catch (e) {
    return sendJSON(res, 500, { success: false, error: 'Stripe SDK load failed: ' + e.message });
  }

  let guestRow;
  try {
    guestRow = await withPgClient(async (pg) => {
      const r = await pg.query(
        `SELECT bg.id::text AS booking_guest_id,
                bg.guest_number,
                bg.guest_name,
                bg.deposit_amount_cents,
                bg.amount_paid_cents,
                bg.payment_status,
                bg.payment_id::text AS payment_id,
                bg.metadata AS guest_metadata,
                b.id::text AS booking_id,
                b.booking_code,
                b.check_in::text AS check_in,
                b.check_out::text AS check_out,
                b.status::text AS booking_status,
                b.metadata AS booking_metadata,
                c.slug AS client_slug
           FROM booking_guests bg
           JOIN bookings b ON b.id = bg.booking_id
           JOIN clients c ON c.id = bg.client_id
          WHERE bg.id = $1::uuid
            AND c.slug = $2`,
        [guestId, clientSlug],
      );
      return r.rows[0] || null;
    });
  } catch (err) {
    if (isMissingBookingGuestsTable(err)) {
      return sendJSON(res, 503, { success: false, error: 'booking_guests table not migrated' });
    }
    return sendJSON(res, 500, { success: false, error: 'DB fetch failed: ' + err.message });
  }

  if (!guestRow) {
    return sendJSON(res, 404, { success: false, error: 'booking guest not found' });
  }
  if (String(guestRow.booking_status || '').toLowerCase() === 'cancelled') {
    return sendJSON(res, 400, { success: false, error: 'booking_not_active' });
  }

  let guestMeta = guestRow.guest_metadata;
  if (typeof guestMeta === 'string') {
    try { guestMeta = JSON.parse(guestMeta); } catch (_) { guestMeta = {}; }
  }
  guestMeta = guestMeta || {};
  const subtotalCents = Number(guestMeta.subtotal_cents || 0);
  const depositCents = Number(guestRow.deposit_amount_cents || 0);
  const amountDueCents = paymentTarget === 'full_share'
    ? (subtotalCents > 0 ? subtotalCents : depositCents)
    : depositCents;

  if (!amountDueCents || amountDueCents <= 0) {
    return sendJSON(res, 422, { success: false, error: 'amount_due_cents must be > 0 for this guest' });
  }

  const paymentKind = paymentTarget === 'full_share' ? 'full_amount' : 'deposit_only';
  const shortUrl = buildPaymentShortLink({
    booking_code: guestRow.booking_code,
    guest_number: guestRow.guest_number,
    client_slug: clientSlug,
    env: process.env,
  });

  try {
    const result = await withPgClient(async (pg) => {
      let paymentId = guestRow.payment_id;
      let checkoutUrl = null;
      let sessionId = null;
      let idempotent = false;

      if (paymentId) {
        const existing = await pg.query(
          `SELECT id::text AS payment_id, status::text AS payment_status,
                  checkout_url, stripe_checkout_session_id, amount_due_cents
             FROM payments WHERE id = $1::uuid`,
          [paymentId],
        );
        const ex = existing.rows[0];
        if (ex && ex.payment_status === 'checkout_created' && ex.checkout_url) {
          idempotent = true;
          checkoutUrl = ex.checkout_url;
          sessionId = ex.stripe_checkout_session_id;
          paymentId = ex.payment_id;
        } else if (ex && ex.payment_status === 'paid') {
          return { already_paid: true, payment_id: paymentId };
        }
      }

      if (!checkoutUrl) {
        const ins = await pg.query(
          `INSERT INTO payments (
             client_id, booking_id, booking_guest_id, status, payment_kind,
             currency, amount_due_cents, metadata
           )
           SELECT bg.client_id, bg.booking_id, bg.id,
                  'draft'::payment_record_status, $2::payment_kind,
                  'EUR', $3,
                  $4::jsonb
             FROM booking_guests bg
            WHERE bg.id = $1::uuid
           RETURNING id::text AS payment_id`,
          [
            guestId,
            paymentKind,
            amountDueCents,
            JSON.stringify({
              source: 'bot_guest_payment_link_slice_a',
              payment_target: paymentTarget,
              booking_guest_id: guestId,
              guest_number: guestRow.guest_number,
              guest_name: guestRow.guest_name,
              created_by: actorId,
            }),
          ],
        );
        paymentId = ins.rows[0].payment_id;

        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          currency: 'eur',
          line_items: [{
            price_data: {
              currency: 'eur',
              product_data: {
                name: `Booking ${guestRow.booking_code} — ${guestRow.guest_name}`,
                description: `${paymentTarget === 'full_share' ? 'Full share' : 'Deposit'} | Guest ${guestRow.guest_number}`,
              },
              unit_amount: amountDueCents,
            },
            quantity: 1,
          }],
          metadata: {
            client_slug: clientSlug,
            booking_id: guestRow.booking_id,
            booking_code: guestRow.booking_code,
            payment_id: paymentId,
            booking_guest_id: guestId,
            guest_number: String(guestRow.guest_number),
            payment_kind: paymentKind,
            source: 'bot_guest_payment_slice_a',
          },
          success_url: stripeCheckoutSessionSuccessUrl(),
          cancel_url: stripeCheckoutSessionCancelUrl(),
        });

        checkoutUrl = session.url;
        sessionId = session.id;

        await pg.query(
          `UPDATE payments
             SET status = 'checkout_created'::payment_record_status,
                 stripe_checkout_session_id = $1,
                 checkout_url = $2,
                 metadata = metadata || $3::jsonb
           WHERE id = $4::uuid`,
          [
            session.id,
            session.url,
            JSON.stringify({ stripe_session_id: session.id, source: 'bot_guest_payment_slice_a' }),
            paymentId,
          ],
        );

        await pg.query(
          `UPDATE booking_guests
             SET payment_id = $1::uuid,
                 payment_status = 'checkout_created',
                 updated_at = NOW()
           WHERE id = $2::uuid`,
          [paymentId, guestId],
        );
      }

      return {
        payment_id: paymentId,
        checkout_url: checkoutUrl,
        stripe_checkout_session_id: sessionId,
        idempotent,
        amount_due_cents: amountDueCents,
        payment_target: paymentTarget,
      };
    });

    if (result.already_paid) {
      return sendJSON(res, 200, {
        success: true,
        idempotent: true,
        already_paid: true,
        booking_guest_id: guestId,
        payment_id: result.payment_id,
        payment_status: 'paid',
      });
    }

    const linkObs = guestPaymentLinkObservability(
      { booking_code: guestRow.booking_code, client_slug: clientSlug },
      result.checkout_url,
      result.stripe_checkout_session_id,
    );
    const guestShortUrl = shortUrl || linkObs.payment_short_url;

    if (appendAuditLog) {
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:bot_guest_payment_link',
        category: 'bot_guest_payment_link_create',
        success: true,
        booking_guest_id: guestId,
        payment_id: result.payment_id,
        auth_mode: authMode,
      });
    }

    return sendJSON(res, 200, {
      success: true,
      idempotent: result.idempotent === true,
      source: 'luna_bot_guest_payment_link',
      booking_guest_id: guestId,
      guest_number: guestRow.guest_number,
      guest_name: guestRow.guest_name,
      booking_id: guestRow.booking_id,
      booking_code: guestRow.booking_code,
      payment_id: result.payment_id,
      payment_target: paymentTarget,
      amount_due_cents: result.amount_due_cents,
      checkout_url: result.checkout_url,
      guest_payment_url: guestShortUrl || result.checkout_url,
      payment_short_url: guestShortUrl,
      payment_short_path: `${guestRow.booking_code}/g${guestRow.guest_number}`,
      uses_short_payment_link: !!guestShortUrl,
      payment_status: 'checkout_created',
      no_payment_truth_recorded: true,
    });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /staff/bot/booking-guests/payment-status  (Slice A — per-guest status)
// ─────────────────────────────────────────────────────────────────────────────
async function handleBotGuestPaymentStatus(req, res, user, authMode, ctx) {
  const { sendJSON, send400, readBody, withPgClient, DEFAULT_CLIENT } = ctx;

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (_) {
    return send400(res, 'invalid or missing JSON body');
  }

  const clientSlug = String(body.client_slug || DEFAULT_CLIENT).trim();
  const guestId = String(body.booking_guest_id || body.guest_id || '').trim();
  const bookingCode = String(body.booking_code || '').trim().toUpperCase();
  const guestNumber = parseInt(body.guest_number, 10);

  if (!guestId && !(bookingCode && Number.isInteger(guestNumber) && guestNumber > 0)) {
    return send400(res, 'booking_guest_id or (booking_code + guest_number) is required');
  }

  try {
    const row = await withPgClient(async (pg) => {
      const q = guestId
        ? `SELECT bg.id::text AS booking_guest_id, bg.guest_number, bg.guest_name,
                  bg.deposit_amount_cents, bg.amount_paid_cents, bg.payment_status,
                  bg.payment_id::text AS payment_id, bg.assigned_bed_code, bg.assigned_room_code,
                  b.booking_code, b.id::text AS booking_id
             FROM booking_guests bg
             JOIN bookings b ON b.id = bg.booking_id
             JOIN clients c ON c.id = bg.client_id
            WHERE bg.id = $1::uuid AND c.slug = $2`
        : `SELECT bg.id::text AS booking_guest_id, bg.guest_number, bg.guest_name,
                  bg.deposit_amount_cents, bg.amount_paid_cents, bg.payment_status,
                  bg.payment_id::text AS payment_id, bg.assigned_bed_code, bg.assigned_room_code,
                  b.booking_code, b.id::text AS booking_id
             FROM booking_guests bg
             JOIN bookings b ON b.id = bg.booking_id
             JOIN clients c ON c.id = bg.client_id
            WHERE c.slug = $1 AND UPPER(b.booking_code) = $2 AND bg.guest_number = $3`;
      const params = guestId ? [guestId, clientSlug] : [clientSlug, bookingCode, guestNumber];
      const r = await pg.query(q, params);
      return r.rows[0] || null;
    });

    if (!row) {
      return sendJSON(res, 404, { success: false, error: 'booking guest not found' });
    }

    return sendJSON(res, 200, {
      success: true,
      source: 'luna_bot_guest_payment_status',
      auth_mode: authMode,
      client_slug: clientSlug,
      booking_guest_id: row.booking_guest_id,
      guest_number: row.guest_number,
      guest_name: row.guest_name,
      booking_id: row.booking_id,
      booking_code: row.booking_code,
      deposit_amount_cents: Number(row.deposit_amount_cents || 0),
      amount_paid_cents: Number(row.amount_paid_cents || 0),
      payment_status: guestPaymentStatusFromRow(row),
      payment_id: row.payment_id,
      assigned_bed_code: row.assigned_bed_code,
      assigned_room_code: row.assigned_room_code,
      no_payment_write: true,
    });
  } catch (err) {
    if (isMissingBookingGuestsTable(err)) {
      return sendJSON(res, 503, { success: false, error: 'booking_guests table not migrated' });
    }
    return sendJSON(res, 500, { success: false, error: err.message });
  }
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
  handleBotPackagePricePreview,
  handleBotGuestPaymentCreateLink,
  handleBotGuestPaymentStatus,
};
