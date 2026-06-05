'use strict';

/**
 * Phase 19c.2 — Load booking context for check-in day preview (read-only SELECT).
 *
 * Merges structured booking/payment reads with optional preview_context overrides.
 * No writes, Stripe link creation, WhatsApp, or n8n.
 */

const {
  loadClientConfirmationConfig,
  ROOM_CODES_SQL,
} = require('./luna-booking-confirmation-preview');

const DEFAULT_CLIENT = 'wolfhouse-somo';

const BOOKING_BY_CODE_SQL = `
SELECT b.id::text                AS booking_id,
       b.booking_code,
       b.guest_name,
       b.phone,
       b.check_in::text          AS check_in,
       b.check_out::text         AS check_out,
       b.status::text            AS booking_status,
       b.payment_status::text    AS payment_status,
       b.amount_paid_cents,
       b.total_amount_cents,
       b.deposit_required_cents,
       b.deposit_paid_cents,
       b.primary_room_code,
       b.metadata
  FROM bookings b
 INNER JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1
   AND b.booking_code = $2
 LIMIT 1`;

const BOOKING_BY_ID_SQL = `
SELECT b.id::text                AS booking_id,
       b.booking_code,
       b.guest_name,
       b.phone,
       b.check_in::text          AS check_in,
       b.check_out::text         AS check_out,
       b.status::text            AS booking_status,
       b.payment_status::text    AS payment_status,
       b.amount_paid_cents,
       b.total_amount_cents,
       b.deposit_required_cents,
       b.deposit_paid_cents,
       b.primary_room_code,
       b.metadata
  FROM bookings b
 INNER JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1
   AND b.id = $2::uuid
 LIMIT 1`;

const PAYMENTS_BY_BOOKING_SQL = `
SELECT p.status::text            AS payment_status,
       p.payment_kind::text      AS payment_kind,
       p.amount_due_cents,
       p.amount_paid_cents,
       p.checkout_url,
       p.metadata
  FROM payments p
 WHERE p.booking_id = $1::uuid
   AND p.checkout_url IS NOT NULL
 ORDER BY p.created_at DESC`;

const INACTIVE_PAYMENT_STATUSES = new Set([
  'cancelled', 'canceled', 'expired', 'failed', 'paid', 'succeeded',
]);

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function hasPreviewContext(body) {
  return !!(body && body.preview_context && typeof body.preview_context === 'object');
}

function hasBookingIdentifier(body) {
  const src = body || {};
  const preview = src.preview_context || {};
  return !!(
    trimStr(src.booking_id || preview.booking_id)
    || trimStr(src.booking_code || preview.booking_code)
  );
}

function resolveBookingIdentifiers(body) {
  const src = body || {};
  const preview = src.preview_context || {};
  return {
    booking_id: trimStr(src.booking_id || preview.booking_id) || null,
    booking_code: trimStr(src.booking_code || preview.booking_code) || null,
  };
}

function extractLanguage(metadata, draft) {
  if (draft && draft.language) return trimStr(draft.language);
  if (metadata.language) return trimStr(metadata.language);
  if (metadata.guest_language) return trimStr(metadata.guest_language);
  return null;
}

function extractConversationHints(metadata) {
  const texts = [];
  const draft = metadata.confirmation_draft || {};

  for (const msg of metadata.payment_preference_history || []) {
    if (typeof msg === 'string') texts.push(msg);
    else if (msg && msg.text) texts.push(String(msg.text));
    else if (msg && msg.message_text) texts.push(String(msg.message_text));
  }

  for (const msg of metadata.conversation_history || []) {
    if (typeof msg === 'string') texts.push(msg);
    else if (msg && msg.text) texts.push(String(msg.text));
  }

  if (draft.payment_preference) texts.push(String(draft.payment_preference));
  return texts;
}

function resolveBalanceDueCents(row, metadata) {
  const draft = metadata.confirmation_draft || {};
  if (draft.balance_due_cents != null) return Number(draft.balance_due_cents);
  if (row.total_amount_cents != null && row.amount_paid_cents != null) {
    const due = Number(row.total_amount_cents) - Number(row.amount_paid_cents);
    return due > 0 ? due : 0;
  }
  return 0;
}

function pickExistingBalancePaymentLink(paymentRows) {
  for (const pr of paymentRows || []) {
    const kind = String(pr.payment_kind || '').toLowerCase();
    if (kind === 'deposit' || kind === 'deposit_only' || kind === 'addon_service') continue;
    const url = trimStr(pr.checkout_url);
    if (!url) continue;
    const st = String(pr.payment_status || '').toLowerCase();
    if (INACTIVE_PAYMENT_STATUSES.has(st)) continue;
    if (Number(pr.amount_paid_cents || 0) > 0) continue;
    return url;
  }
  return null;
}

function resolveRoomNumber(draft, primaryRoomCode, extraRoomCodes) {
  const fromDraft = draft && draft.room_number ? trimStr(draft.room_number) : '';
  if (fromDraft) return fromDraft;
  if (primaryRoomCode) return trimStr(primaryRoomCode);
  for (const rc of extraRoomCodes || []) {
    if (rc) return trimStr(rc);
  }
  return null;
}

function resolveAddress(draft, clientConfig) {
  const fromDraft = draft && draft.address ? trimStr(draft.address) : '';
  if (fromDraft) return fromDraft;
  return clientConfig && clientConfig.address ? trimStr(clientConfig.address) : null;
}

function resolveGateCode(draft, clientConfig) {
  const fromDraft = draft && draft.gate_code ? trimStr(draft.gate_code) : '';
  if (fromDraft) return fromDraft;
  return clientConfig && clientConfig.gate_code ? trimStr(clientConfig.gate_code) : null;
}

/**
 * @param {object} body — request body
 * @returns {object} planLunaCheckinDayMessage input (preview_context-only path)
 */
function buildCheckinDayPreviewInputFromBody(body) {
  const src = body || {};
  const preview = src.preview_context || {};
  const history = preview.conversation_history || preview.conversation_messages || [];

  return {
    client_slug:            trimStr(src.client_slug || preview.client_slug || DEFAULT_CLIENT),
    booking_id:             trimStr(src.booking_id || preview.booking_id) || null,
    booking_code:           trimStr(src.booking_code || preview.booking_code) || null,
    booking_status:         preview.booking_status || 'confirmed',
    check_in:               preview.check_in,
    guest_name:             preview.guest_name,
    phone:                  preview.phone,
    language:               preview.language || 'en',
    payment_status:         preview.payment_status,
    amount_paid_cents:      preview.amount_paid_cents,
    balance_due_cents:      preview.balance_due_cents,
    balance_payment_link:   preview.balance_payment_link,
    address:                preview.address,
    gate_code:              preview.gate_code,
    room_number:            preview.room_number,
    room_assigned:          preview.room_assigned ?? (preview.room_number ? true : undefined),
    checkin_day_sent_at:    preview.checkin_day_sent_at,
    conversation_messages:  history,
    payment_preference_history: preview.payment_preference_history || history,
  };
}

/**
 * Merge DB booking context with request body; explicit preview_context wins per field.
 *
 * @param {object|null} dbContext — from loadLunaCheckinDayPreviewBookingContext
 * @param {object} body
 */
function mergeCheckinDayPreviewInput(dbContext, body) {
  const src = body || {};
  const preview = src.preview_context || {};
  const db = dbContext || {};
  const dbHistory = db.conversation_messages || [];
  const previewHistory = preview.conversation_history || preview.conversation_messages;

  const pick = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(preview, key) ? preview[key] : fallback
  );

  const history = previewHistory != null ? previewHistory : dbHistory;
  const roomNumber = pick('room_number', db.room_number);
  const roomAssigned = Object.prototype.hasOwnProperty.call(preview, 'room_assigned')
    ? preview.room_assigned
    : (roomNumber ? true : db.room_assigned);

  return {
    client_slug:            trimStr(src.client_slug || preview.client_slug || db.client_slug || DEFAULT_CLIENT),
    booking_id:             db.booking_id || trimStr(src.booking_id || preview.booking_id) || null,
    booking_code:           db.booking_code || trimStr(src.booking_code || preview.booking_code) || null,
    booking_status:         pick('booking_status', db.booking_status || 'confirmed'),
    check_in:               pick('check_in', db.check_in),
    guest_name:             pick('guest_name', db.guest_name),
    phone:                  pick('phone', db.phone),
    language:               pick('language', db.language || 'en'),
    payment_status:         pick('payment_status', db.payment_status),
    amount_paid_cents:      pick('amount_paid_cents', db.amount_paid_cents),
    balance_due_cents:      pick('balance_due_cents', db.balance_due_cents),
    balance_payment_link:   pick('balance_payment_link', db.balance_payment_link),
    address:                pick('address', db.address),
    gate_code:              pick('gate_code', db.gate_code),
    room_number:            roomNumber,
    room_assigned:          roomAssigned,
    checkin_day_sent_at:    pick('checkin_day_sent_at', db.checkin_day_sent_at),
    conversation_messages:  history,
    payment_preference_history: preview.payment_preference_history || db.payment_preference_history || history,
  };
}

/**
 * @param {object} input — client_slug + booking_id or booking_code
 * @param {{ pg: object, loadClientConfirmationConfig?: Function }} context
 */
async function loadLunaCheckinDayPreviewBookingContext(input, context) {
  const clientSlug = trimStr((input && input.client_slug) || DEFAULT_CLIENT);
  const { booking_id: bookingId, booking_code: bookingCode } = resolveBookingIdentifiers(input || {});
  const pg = context && context.pg;
  const loadConfig = (context && context.loadClientConfirmationConfig) || loadClientConfirmationConfig;

  if (!pg || typeof pg.query !== 'function') {
    return { ok: false, error: 'pg client required', status: 500 };
  }
  if (!bookingId && !bookingCode) {
    return { ok: false, error: 'missing_booking_context', status: 400 };
  }

  const sql = bookingId ? BOOKING_BY_ID_SQL : BOOKING_BY_CODE_SQL;
  const params = bookingId ? [clientSlug, bookingId] : [clientSlug, bookingCode];
  const { rows } = await pg.query(sql, params);

  if (!rows.length) {
    return { ok: false, error: 'booking_not_found', status: 404 };
  }

  const row = rows[0];
  const metadata = parseMetadata(row.metadata);
  const draft = metadata.confirmation_draft || {};
  const clientConfig = loadConfig(clientSlug);

  let extraRoomCodes = [];
  try {
    const roomRes = await pg.query(ROOM_CODES_SQL, [clientSlug, row.booking_id]);
    extraRoomCodes = (roomRes.rows || []).map((r) => r.room_code);
  } catch (_) {
    // booking_beds may be absent
  }

  let paymentRows = [];
  try {
    const payRes = await pg.query(PAYMENTS_BY_BOOKING_SQL, [row.booking_id]);
    paymentRows = payRes.rows || [];
  } catch (_) {
    // payments table read optional
  }

  const balanceDueCents = resolveBalanceDueCents(row, metadata);
  const roomNumber = resolveRoomNumber(draft, row.primary_room_code, extraRoomCodes);
  const conversationMessages = extractConversationHints(metadata);

  return {
    ok: true,
    booking_id: row.booking_id,
    booking_code: row.booking_code,
    fields: {
      client_slug: clientSlug,
      booking_id: row.booking_id,
      booking_code: row.booking_code,
      booking_status: trimStr(row.booking_status).toLowerCase() || 'confirmed',
      check_in: row.check_in,
      guest_name: row.guest_name,
      phone: row.phone || null,
      language: extractLanguage(metadata, draft) || 'en',
      payment_status: row.payment_status,
      amount_paid_cents: row.amount_paid_cents,
      balance_due_cents: balanceDueCents,
      balance_payment_link: pickExistingBalancePaymentLink(paymentRows),
      address: resolveAddress(draft, clientConfig),
      gate_code: resolveGateCode(draft, clientConfig),
      room_number: roomNumber,
      room_assigned: !!roomNumber,
      checkin_day_sent_at: metadata.checkin_day_sent_at || null,
      conversation_messages: conversationMessages,
      payment_preference_history: conversationMessages,
    },
  };
}

/**
 * Resolve final planner input from request body (preview-only or booking + optional override).
 *
 * @param {object} body
 * @param {object|null} pg — when booking identifier present
 */
async function resolveCheckinDayPreviewRequest(body, pg) {
  const hasPreview = hasPreviewContext(body);
  const hasBookingRef = hasBookingIdentifier(body);

  if (!hasBookingRef && !hasPreview) {
    return { ok: false, error: 'missing_booking_context', status: 400 };
  }

  if (!hasBookingRef) {
    return {
      ok: true,
      input: buildCheckinDayPreviewInputFromBody(body),
      booking_context_loaded: false,
      booking_id: null,
      booking_code: null,
    };
  }

  const loaded = await loadLunaCheckinDayPreviewBookingContext(body, { pg });
  if (!loaded.ok) {
    return loaded;
  }

  return {
    ok: true,
    input: mergeCheckinDayPreviewInput(loaded.fields, body),
    booking_context_loaded: true,
    booking_id: loaded.booking_id,
    booking_code: loaded.booking_code,
  };
}

module.exports = {
  resolveCheckinDayPreviewRequest,
  loadLunaCheckinDayPreviewBookingContext,
  mergeCheckinDayPreviewInput,
  buildCheckinDayPreviewInputFromBody,
  pickExistingBalancePaymentLink,
  BOOKING_BY_CODE_SQL,
  BOOKING_BY_ID_SQL,
  PAYMENTS_BY_BOOKING_SQL,
};
