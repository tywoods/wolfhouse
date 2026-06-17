'use strict';

/**
 * Phase 14b / 20f — Luna booking confirmation preview (read-only).
 *
 * Loads persisted confirmation_draft from bookings.metadata and builds a
 * Cami/Wolfhouse playbook message preview. No writes, no WhatsApp, no n8n,
 * no Stripe API calls, no balance checkout link creation.
 */

const fs   = require('fs');
const path = require('path');

const {
  buildConfirmationPreviewFromPlaybook,
  buildPlaybookMetadata,
} = require('./luna-client-messaging-playbook');

const DEFAULT_CLIENT = 'wolfhouse-somo';

const PAID_STATUSES = new Set(['deposit_paid', 'paid']);

/** Bed-code / bed-number leak patterns — must never appear in message_preview. */
const BED_CODE_RE = /(?:DEMO-R\d+-B\d+|\bB[1-9]\b)/i;
const BED_NUMBER_RE = /\bbed\s*(?:number|#|no\.?)?\s*:?\s*\d/i;

const FULLY_PAID_PHRASES_RE = /\b(?:fully paid|all paid|nothing (?:more )?to pay|paid in full|completamente pagato|tutto pagato)\b/i;

const CASH_BANK_RE = /\b(?:cash|bank transfer|bank|transfer|bonifico|contanti|transferencia|virement|überweisung)\b/i;

const INACTIVE_PAYMENT_STATUSES = new Set([
  'cancelled', 'canceled', 'expired', 'failed', 'paid', 'succeeded',
]);

const BOOKING_BY_CODE_SQL = `
SELECT b.id AS booking_id,
       b.booking_code,
       b.payment_status::text AS payment_status,
       b.confirmation_sent_at,
       b.primary_room_code,
       b.amount_paid_cents,
       b.total_amount_cents,
       b.language,
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
       b.amount_paid_cents,
       b.total_amount_cents,
       b.language,
       b.metadata
  FROM bookings b
 INNER JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1 AND b.id = $2::uuid
 LIMIT 1`;

const ROOM_CODES_SQL = `
SELECT DISTINCT COALESCE(
         NULLIF(TRIM(bb.room_code), ''),
         NULLIF(regexp_replace(bb.bed_code, '-B[0-9]+$', ''), '')
       ) AS room_code
  FROM booking_beds bb
 INNER JOIN bookings b ON b.id = bb.booking_id
 INNER JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1 AND b.id = $2::uuid
   AND COALESCE(NULLIF(TRIM(bb.room_code), ''), NULLIF(TRIM(bb.bed_code), '')) IS NOT NULL
 ORDER BY 1`;

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

const PREVIEW_SAFETY_FLAGS = {
  preview_only:                 true,
  no_write_performed:           true,
  sends_whatsapp:               false,
  calls_n8n:                    false,
  calls_graph_api:              false,
  creates_stripe_link:          false,
  updates_confirmation_sent_at: false,
  send_ready:                   false,
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

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
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
  for (const rc of extraRoomCodes || []) {
    if (rc) codes.add(String(rc).trim());
  }
  if (primaryRoomCode) {
    codes.add(String(primaryRoomCode).trim());
  }
  if (!codes.size) {
    const fromDraft = draft && draft.room_number ? String(draft.room_number).trim() : '';
    if (fromDraft) codes.add(fromDraft);
  }
  return [...codes].filter(Boolean);
}

function extractLanguage(metadata, draft, columnLanguage) {
  if (draft && draft.language) return trimStr(draft.language);
  if (metadata.language) return trimStr(metadata.language);
  if (metadata.guest_language) return trimStr(metadata.guest_language);
  if (columnLanguage) return trimStr(columnLanguage);
  return 'en';
}

function extractPaymentPreferenceTexts(metadata, draft) {
  const texts = [];

  for (const msg of metadata.payment_preference_history || []) {
    if (typeof msg === 'string') texts.push(msg);
    else if (msg && msg.text) texts.push(String(msg.text));
    else if (msg && msg.message_text) texts.push(String(msg.message_text));
    else if (msg && msg.method) texts.push(String(msg.method));
  }

  for (const msg of metadata.conversation_history || []) {
    if (typeof msg === 'string') texts.push(msg);
    else if (msg && msg.text) texts.push(String(msg.text));
    else if (msg && msg.message_text) texts.push(String(msg.message_text));
  }

  if (draft && draft.payment_preference) texts.push(String(draft.payment_preference));
  return texts;
}

function guestAskedCashOrBankTransfer(metadata, draft) {
  const texts = extractPaymentPreferenceTexts(metadata, draft);
  return texts.some((t) => CASH_BANK_RE.test(t));
}

function resolveBalanceDueCents(draft, row) {
  if (draft && draft.balance_due_cents != null) return Number(draft.balance_due_cents);
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

function resolveBalancePaymentLinkStatus(balanceDueCents, cashBankSuppressed, existingLink) {
  if (!(balanceDueCents > 0)) return 'no_balance_due';
  if (cashBankSuppressed) return 'suppressed_cash_or_bank';
  if (existingLink) return 'included_existing_link';
  return 'missing_existing_link';
}

function buildFallbackMessagePreview(draft, roomNumbers, resolvedAddress, gateCode) {
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

function buildPlaybookMessagePreview({
  clientSlug,
  language,
  draft,
  roomNumbers,
  resolvedAddress,
  gateCode,
  balanceDueCents,
  amountPaidCents,
  paymentStatus,
  balancePaymentLink,
  includeBalanceLink,
}) {
  const playbookResult = buildConfirmationPreviewFromPlaybook(clientSlug, language, {
    guest_name:           draft.guest_name || '',
    booking_code:         draft.booking_code || '',
    amount_paid_cents:    amountPaidCents,
    balance_due_cents:    balanceDueCents,
    address:              resolvedAddress || '',
    gate_code:            gateCode || '',
    room_number:          roomNumbers.join(', '),
    balance_payment_link: balancePaymentLink,
    include_balance_link: includeBalanceLink,
    payment_status:       paymentStatus,
    package_code:         draft.package_code || draft.package_interest || null,
    package_interest:     draft.package_interest || draft.package_code || null,
    includes_surf_lessons: draft.includes_surf_lessons,
    service_interest:     draft.service_interest,
    add_ons:              draft.add_ons,
    draft,
  });

  if (playbookResult.ok) {
    return {
      message:            playbookResult.message,
      template_source:    playbookResult.template_source,
      messaging_playbook: playbookResult.messaging_playbook,
    };
  }

  return {
    message: buildFallbackMessagePreview(
      { ...draft, balance_due_cents: balanceDueCents, amount_paid_cents: amountPaidCents },
      roomNumbers,
      resolvedAddress,
      gateCode,
    ),
    template_source:    'built_in_fallback',
    messaging_playbook: buildPlaybookMetadata(clientSlug),
  };
}

function messagePreviewHasBedLeak(messagePreview) {
  if (!messagePreview) return false;
  return BED_CODE_RE.test(messagePreview) || BED_NUMBER_RE.test(messagePreview);
}

function messagePreviewSaysFullyPaid(messagePreview, paymentStatus) {
  if (paymentStatus !== 'deposit_paid') return false;
  return FULLY_PAID_PHRASES_RE.test(String(messagePreview || ''));
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
  const language          = extractLanguage(metadata, confirmationDraft, row.language);

  const base = {
    ...PREVIEW_SAFETY_FLAGS,
    booking_id:           row.booking_id,
    booking_code:         row.booking_code,
    payment_status:       paymentStatus || null,
    confirmation_sent_at: row.confirmation_sent_at || null,
    required_approvals:   SEND_REQUIRED_APPROVALS,
    template_source:      null,
    messaging_playbook:   buildPlaybookMetadata(clientSlug),
    balance_payment_link_status: null,
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

  let paymentRows = [];
  try {
    const payRes = await pg.query(PAYMENTS_BY_BOOKING_SQL, [row.booking_id]);
    paymentRows = payRes.rows || [];
  } catch (_) {
    // payments table read optional
  }

  const roomNumbers       = resolveRoomNumbers(confirmationDraft, row.primary_room_code, extraRoomCodes);
  const balanceDueCents   = resolveBalanceDueCents(confirmationDraft, row);
  const amountPaidCents   = confirmationDraft.amount_paid_cents != null
    ? Number(confirmationDraft.amount_paid_cents)
    : Number(row.amount_paid_cents || 0);
  const cashBankSuppressed = guestAskedCashOrBankTransfer(metadata, confirmationDraft);
  const existingBalanceLink = pickExistingBalancePaymentLink(paymentRows);
  const balanceLinkStatus   = resolveBalancePaymentLinkStatus(
    balanceDueCents,
    cashBankSuppressed,
    existingBalanceLink,
  );
  const includeBalanceLink  = balanceLinkStatus === 'included_existing_link';

  const previewBuilt = buildPlaybookMessagePreview({
    clientSlug,
    language,
    draft: confirmationDraft,
    roomNumbers,
    resolvedAddress: addressResolved.address,
    gateCode,
    balanceDueCents,
    amountPaidCents,
    paymentStatus,
    balancePaymentLink: existingBalanceLink,
    includeBalanceLink,
  });

  const messagePreview = previewBuilt.message;

  if (messagePreviewHasBedLeak(messagePreview)) {
    return {
      success: false,
      ...base,
      confirmation_draft: confirmationDraft,
      message_preview:    messagePreview,
      address_source:     addressResolved.source,
      template_source:    previewBuilt.template_source,
      messaging_playbook: previewBuilt.messaging_playbook,
      balance_payment_link_status: balanceLinkStatus,
      blocked_reasons:    ['message_preview_bed_leak'],
    };
  }

  if (messagePreviewSaysFullyPaid(messagePreview, paymentStatus)) {
    return {
      success: false,
      ...base,
      confirmation_draft: confirmationDraft,
      message_preview:    messagePreview,
      address_source:     addressResolved.source,
      template_source:    previewBuilt.template_source,
      messaging_playbook: previewBuilt.messaging_playbook,
      balance_payment_link_status: balanceLinkStatus,
      blocked_reasons:    ['message_preview_fully_paid_wording'],
    };
  }

  return {
    success: true,
    ...base,
    primary_room_code: row.primary_room_code || null,
    room_numbers: roomNumbers,
    confirmation_draft: confirmationDraft,
    message_preview:    messagePreview,
    address_source:     addressResolved.source,
    template_source:    previewBuilt.template_source,
    messaging_playbook: previewBuilt.messaging_playbook,
    balance_payment_link_status: balanceLinkStatus,
    blocked_reasons:    [],
  };
}

module.exports = {
  getLunaBookingConfirmationPreview,
  loadClientConfirmationConfig,
  resolveConfirmationAddress,
  resolveGateCode,
  resolveRoomNumbers,
  pickExistingBalancePaymentLink,
  guestAskedCashOrBankTransfer,
  resolveBalancePaymentLinkStatus,
  BOOKING_BY_CODE_SQL,
  BOOKING_BY_ID_SQL,
  ROOM_CODES_SQL,
  PAYMENTS_BY_BOOKING_SQL,
  PREVIEW_SAFETY_FLAGS,
  SEND_REQUIRED_APPROVALS,
};
