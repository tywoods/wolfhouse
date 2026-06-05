'use strict';

/**
 * Phase 14b — Luna booking confirmation preview (read-only).
 *
 * Loads persisted confirmation_draft from bookings.metadata and builds a
 * WhatsApp-style message preview. No writes, no WhatsApp, no n8n, no Stripe.
 */

const fs   = require('fs');
const path = require('path');

const DEFAULT_CLIENT = 'wolfhouse-somo';

const PAID_STATUSES = new Set(['deposit_paid', 'paid']);

/** Bed-code / bed-number leak patterns — must never appear in message_preview. */
const BED_CODE_RE = /(?:DEMO-R\d+-B\d+|\bB[1-9]\b)/i;
const BED_NUMBER_RE = /\bbed\s*(?:number|#|no\.?)?\s*:?\s*\d/i;

const BOOKING_BY_CODE_SQL = `
SELECT b.id AS booking_id,
       b.booking_code,
       b.payment_status::text AS payment_status,
       b.confirmation_sent_at,
       b.primary_room_code,
       b.metadata
  FROM bookings b
 INNER JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1 AND b.booking_code = $2
 LIMIT 1`;

const BOOKING_BY_ID_SQL = `
SELECT b.id AS booking_id,
       b.booking_code,
       b.payment_status::text AS payment_status,
       b.confirmation_sent_at,
       b.primary_room_code,
       b.metadata
  FROM bookings b
 INNER JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1 AND b.id = $2::uuid
 LIMIT 1`;

const ROOM_CODES_SQL = `
SELECT DISTINCT bb.room_code
  FROM booking_beds bb
 INNER JOIN bookings b ON b.id = bb.booking_id
 INNER JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1 AND b.id = $2::uuid
   AND bb.room_code IS NOT NULL
 ORDER BY bb.room_code`;

const PREVIEW_SAFETY_FLAGS = {
  preview_only:               true,
  no_write_performed:         true,
  sends_whatsapp:             false,
  calls_n8n:                  false,
  updates_confirmation_sent_at: false,
  send_ready:                 false,
};

const SEND_REQUIRED_APPROVALS = [
  'WHATSAPP_LIVE_SENDS_ENABLED',
  'confirm_send_true',
  'owner_approval_stage_7_8',
];

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function loadClientConfirmationConfig(clientSlug) {
  try {
    const cfgPath = path.join(__dirname, '..', '..', 'config', 'clients', `${clientSlug}.baseline.json`);
    const cfg     = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return {
      include_address: cfg.confirmation?.include_address === true,
      address:         cfg.confirmation?.address || cfg.property?.address || null,
      gate_code:       cfg.confirmation?.gate_code || cfg.property?.gate_code || null,
    };
  } catch (_) {
    return { include_address: false, address: null, gate_code: null };
  }
}

function resolveConfirmationAddress(draft, clientConfig) {
  const fromDraft = draft && draft.address ? String(draft.address).trim() : '';
  if (fromDraft) {
    return { address: fromDraft, source: 'confirmation_draft' };
  }
  const fromConfig = clientConfig && clientConfig.address
    ? String(clientConfig.address).trim()
    : '';
  if (fromConfig) {
    return { address: fromConfig, source: 'client_config' };
  }
  return { address: null, source: null };
}

function resolveGateCode(draft, clientConfig) {
  const fromDraft = draft && draft.gate_code ? String(draft.gate_code).trim() : '';
  if (fromDraft) return fromDraft;
  return clientConfig && clientConfig.gate_code
    ? String(clientConfig.gate_code).trim()
    : null;
}

function resolveRoomNumbers(draft, primaryRoomCode, extraRoomCodes) {
  const codes = new Set();
  const fromDraft = draft && draft.room_number ? String(draft.room_number).trim() : '';
  if (fromDraft) {
    codes.add(fromDraft);
  } else if (primaryRoomCode) {
    codes.add(String(primaryRoomCode).trim());
  }
  for (const rc of extraRoomCodes || []) {
    if (rc) codes.add(String(rc).trim());
  }
  return [...codes].filter(Boolean);
}

function buildMessagePreview(draft, roomNumbers, resolvedAddress, gateCode) {
  const lines = [];
  if (draft.guest_name) lines.push(`Hi ${draft.guest_name},`);
  lines.push('Your Wolfhouse booking is confirmed.');
  if (draft.booking_code) lines.push(`Booking: ${draft.booking_code}`);
  if (draft.amount_paid_cents != null || draft.balance_due_cents != null) {
    const parts = [];
    if (draft.amount_paid_cents != null) {
      parts.push(`Paid: €${(draft.amount_paid_cents / 100).toFixed(0)}`);
    }
    if (draft.balance_due_cents != null && draft.balance_due_cents > 0) {
      parts.push(`Balance due: €${(draft.balance_due_cents / 100).toFixed(0)}`);
    }
    if (parts.length) lines.push(parts.join(' · '));
  }
  if (resolvedAddress) lines.push(`Address: ${resolvedAddress}`);
  if (gateCode) lines.push(`Gate code: ${gateCode}`);
  if (roomNumbers.length) lines.push(`Room: ${roomNumbers.join(', ')}`);
  return lines.join('\n');
}

function messagePreviewHasBedLeak(messagePreview) {
  if (!messagePreview) return false;
  return BED_CODE_RE.test(messagePreview) || BED_NUMBER_RE.test(messagePreview);
}

/**
 * @param {object} input — booking_id or booking_code, client_slug
 * @param {{ pg: object, loadClientConfirmationConfig?: Function }} context
 */
async function getLunaBookingConfirmationPreview(input, context) {
  const clientSlug  = String((input && input.client_slug) || DEFAULT_CLIENT).trim();
  const bookingId   = input && input.booking_id   ? String(input.booking_id).trim()   : null;
  const bookingCode = input && input.booking_code ? String(input.booking_code).trim() : null;
  const pg          = context && context.pg;
  const loadConfig  = (context && context.loadClientConfirmationConfig) || loadClientConfirmationConfig;

  if (!pg || typeof pg.query !== 'function') {
    return { success: false, error: 'pg client required', ...PREVIEW_SAFETY_FLAGS };
  }
  if (!bookingId && !bookingCode) {
    return {
      success: false,
      error: 'booking_id or booking_code required',
      ...PREVIEW_SAFETY_FLAGS,
      blocked_reasons: ['missing_booking_identifier'],
    };
  }

  const sql    = bookingId ? BOOKING_BY_ID_SQL : BOOKING_BY_CODE_SQL;
  const params = bookingId ? [clientSlug, bookingId] : [clientSlug, bookingCode];
  const { rows } = await pg.query(sql, params);

  if (rows.length === 0) {
    return {
      success: false,
      error: 'booking_not_found',
      ...PREVIEW_SAFETY_FLAGS,
      blocked_reasons: ['booking_not_found'],
      required_approvals: SEND_REQUIRED_APPROVALS,
    };
  }

  const row               = rows[0];
  const metadata          = parseMetadata(row.metadata);
  const confirmationDraft = metadata.confirmation_draft || null;
  const paymentStatus     = String(row.payment_status || '').trim();
  const clientConfig      = loadConfig(clientSlug);

  const base = {
    ...PREVIEW_SAFETY_FLAGS,
    booking_id:           row.booking_id,
    booking_code:         row.booking_code,
    payment_status:       paymentStatus || null,
    confirmation_sent_at: row.confirmation_sent_at || null,
    required_approvals:   SEND_REQUIRED_APPROVALS,
  };

  if (!PAID_STATUSES.has(paymentStatus)) {
    return {
      success: false,
      ...base,
      confirmation_draft: confirmationDraft,
      message_preview:    null,
      blocked_reasons:    ['payment_not_paid'],
    };
  }

  if (!confirmationDraft || typeof confirmationDraft !== 'object') {
    return {
      success: false,
      ...base,
      confirmation_draft: null,
      message_preview:    null,
      blocked_reasons:    ['confirmation_draft_missing'],
    };
  }

  const addressResolved = resolveConfirmationAddress(confirmationDraft, clientConfig);
  const gateCode        = resolveGateCode(confirmationDraft, clientConfig);

  if (clientConfig.include_address && !addressResolved.address) {
    return {
      success: false,
      ...base,
      confirmation_draft: confirmationDraft,
      message_preview:    null,
      address_source:     null,
      blocked_reasons:    ['confirmation_address_missing'],
    };
  }

  let extraRoomCodes = [];
  try {
    const roomRes = await pg.query(ROOM_CODES_SQL, [clientSlug, row.booking_id]);
    extraRoomCodes = (roomRes.rows || []).map((r) => r.room_code);
  } catch (_) {
    // booking_beds may be absent; draft.room_number / primary_room_code still apply
  }

  const roomNumbers    = resolveRoomNumbers(confirmationDraft, row.primary_room_code, extraRoomCodes);
  const messagePreview = buildMessagePreview(
    confirmationDraft,
    roomNumbers,
    addressResolved.address,
    gateCode,
  );

  if (messagePreviewHasBedLeak(messagePreview)) {
    return {
      success: false,
      ...base,
      confirmation_draft: confirmationDraft,
      message_preview:    messagePreview,
      address_source:     addressResolved.source,
      blocked_reasons:    ['message_preview_bed_leak'],
    };
  }

  return {
    success: true,
    ...base,
    confirmation_draft: confirmationDraft,
    message_preview:    messagePreview,
    address_source:     addressResolved.source,
    blocked_reasons:    [],
  };
}

module.exports = {
  getLunaBookingConfirmationPreview,
  loadClientConfirmationConfig,
  resolveConfirmationAddress,
  resolveGateCode,
  BOOKING_BY_CODE_SQL,
  BOOKING_BY_ID_SQL,
  ROOM_CODES_SQL,
  PREVIEW_SAFETY_FLAGS,
  SEND_REQUIRED_APPROVALS,
};
