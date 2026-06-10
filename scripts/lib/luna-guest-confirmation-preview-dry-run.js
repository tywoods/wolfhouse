'use strict';

/**
 * Stage 27q — Guest confirmation preview dry-run after payment truth (27p).
 *
 * Reuses getLunaBookingConfirmationPreview (Phase 14b) from
 * luna-booking-confirmation-preview.js — read-only, no send.
 *
 * No WhatsApp · no Meta/n8n · no booking confirmation write · no Stripe.
 */

const { withPgClient } = require('./pg-connect');
const {
  getLunaBookingConfirmationPreview,
  loadClientConfirmationConfig,
  resolveGateCode,
  resolveConfirmationAddress,
  PREVIEW_SAFETY_FLAGS,
} = require('./luna-booking-confirmation-preview');
const { polishConfirmationGuestCopy } = require('./luna-guest-confirmation-copy-style');

const REUSED_PREVIEW_PATH = 'getLunaBookingConfirmationPreview (Phase 14b)';

const PAID_STATUSES = new Set(['deposit_paid', 'paid']);

const UNPAID_BOOKING_PAYMENT_STATUSES = new Set([
  'not_requested',
  'waiting_payment',
  'payment_link_sent',
  'failed',
  'expired',
  'refunded',
]);

const UNPAID_PAYMENT_RECORD_HINTS = new Set([
  'draft',
  'checkout_created',
  'pending',
  'cancelled',
  'failed',
  'expired',
]);

const BED_CODE_RE = /(?:DEMO-R\d+-B\d+|\bB[1-9]\b)/i;
const BED_NUMBER_RE = /\bbed\s*(?:number|#|no\.?)?\s*:?\s*\d/i;
const HOLD_EXPIRY_RE = /\b(?:hold expires?|hold expiry|expiry time|scade tra|6[- ]?hour hold|only held for)\b/i;
const LUNA_IDENTITY_RE = /\b(?:luna|wolfhouse)\b/i;
const ARRIVAL_PAYMENT_RE = /\b(?:cash|bank transfer|bonifico|contanti|stripe|on arrival|check-in|check in|all'arrivo)\b/i;
const BALANCE_ASK_RE = /\b(?:balance due|remaining balance|saldo|pay the balance|settle the remaining)\b/i;

const PREVIEW_SAFETY = Object.freeze({
  confirmation_send_allowed: false,
  sends_whatsapp: false,
  live_send_blocked: true,
  preview_only: true,
  no_write_performed: true,
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function paymentTruthReady(paymentStatus, confirmationDraft) {
  if (PAID_STATUSES.has(paymentStatus)) return true;
  if (confirmationDraft && PAID_STATUSES.has(String(confirmationDraft.payment_status || '').trim())) {
    return true;
  }
  return false;
}

function mergeConfirmationDraft(inputDraft, input) {
  const base = (inputDraft && typeof inputDraft === 'object') ? { ...inputDraft } : {};
  const guestName = trimStr(input.guest_name);
  if (guestName && !base.guest_name) base.guest_name = guestName;
  if (input.language_hint && !base.language) base.language = trimStr(input.language_hint);
  return Object.keys(base).length ? base : null;
}

function buildBlockedResponse(reasons, extra) {
  return {
    success: false,
    ...PREVIEW_SAFETY,
    confirmation_preview_attempted: false,
    confirmation_preview_ready: false,
    booking_id: null,
    booking_code: null,
    payment_status: null,
    balance_due_cents: null,
    room_label: null,
    room_number: null,
    proposed_confirmation_message: null,
    next_safe_step: 'staff_review_confirmation',
    block_reasons: reasons,
    reused_preview_path: REUSED_PREVIEW_PATH,
    handoff_notice: 'Confirmation preview not ready — staff review required. Nothing sent to guest.',
    ...extra,
  };
}

function buildHandoffResponse(reasons, partial) {
  const safePartial = { ...(partial || {}) };
  delete safePartial.confirmation_preview_ready;
  delete safePartial.success;
  return {
    ...safePartial,
    success: false,
    ...PREVIEW_SAFETY,
    confirmation_preview_attempted: true,
    confirmation_preview_ready: false,
    next_safe_step: 'staff_review_confirmation',
    block_reasons: reasons,
    reused_preview_path: REUSED_PREVIEW_PATH,
    handoff_notice: 'Confirmation preview incomplete — staff review required. Nothing sent to guest.',
  };
}

function ensureLunaIdentity(message) {
  const text = trimStr(message);
  if (!text) return text;
  if (LUNA_IDENTITY_RE.test(text.slice(0, 120))) return text;
  return `Luna from Wolfhouse here ☀️\n\n${text}`;
}

function appendDepositBalanceArrivalOptions(message, balanceDueCents, language) {
  if (!(balanceDueCents > 0)) return message;
  if (ARRIVAL_PAYMENT_RE.test(message)) return message;

  const lang = String(language || 'en').slice(0, 2).toLowerCase();
  const amount = `€${(balanceDueCents / 100).toFixed(0)}`;
  if (lang === 'it') {
    return `${message}\n\nIl saldo restante di ${amount} può essere saldato all'arrivo/check-in in contanti, bonifico o Stripe.`;
  }
  return `${message}\n\nYour remaining balance of ${amount} can be settled on arrival/check-in by cash, bank transfer, or Stripe.`;
}

function stripBalanceCopyForFullPaid(message) {
  return String(message || '')
    .replace(/\.\s*Balance due:\s*\.?/gi, '.')
    .replace(/\.\s*Saldo:\s*\.?/gi, '.')
    .replace(/\bBalance due:\s*\.?\s*/gi, '')
    .replace(/\bSaldo:\s*\.?\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\.\s*\./g, '.')
    .trim();
}

function sanitizePreviewMessage(message, paymentStatus, balanceDueCents, language) {
  let text = ensureLunaIdentity(trimStr(message));
  if (HOLD_EXPIRY_RE.test(text)) {
    text = text.replace(HOLD_EXPIRY_RE, '').replace(/\s{2,}/g, ' ').trim();
  }
  if (paymentStatus === 'paid' || balanceDueCents === 0) {
    text = stripBalanceCopyForFullPaid(text);
  } else if (paymentStatus === 'deposit_paid' && balanceDueCents > 0) {
    text = appendDepositBalanceArrivalOptions(text, balanceDueCents, language);
  }
  return polishConfirmationGuestCopy(text.trim());
}

function messageHasBedLeak(message) {
  if (!message) return false;
  return BED_CODE_RE.test(message) || BED_NUMBER_RE.test(message);
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

function resolveRoomLabel(roomNumbers, draft) {
  const nums = roomNumbers && roomNumbers.length ? roomNumbers : [];
  if (nums.length) return { room_number: nums[0], room_label: nums.join(', ') };
  const fromDraft = draft && draft.room_number ? trimStr(draft.room_number) : '';
  if (fromDraft) return { room_number: fromDraft, room_label: fromDraft };
  return { room_number: null, room_label: null };
}

function buildFixturePg(input, mergedDraft) {
  const bookingId = trimStr(input.booking_id) || '00000000-0000-4000-8000-000000000027';
  const bookingCode = trimStr(input.booking_code)
    || (mergedDraft && mergedDraft.booking_code)
    || 'WH-G27-FIXTURE';
  const paymentStatus = trimStr(input.payment_status)
    || (mergedDraft && mergedDraft.payment_status)
    || 'deposit_paid';

  const hasRoomField = mergedDraft
    && Object.prototype.hasOwnProperty.call(mergedDraft, 'room_number');
  const row = {
    booking_id: bookingId,
    booking_code: bookingCode,
    payment_status: paymentStatus,
    confirmation_sent_at: null,
    primary_room_code: hasRoomField ? (trimStr(mergedDraft.room_number) || null) : 'MB-01',
    amount_paid_cents: mergedDraft && mergedDraft.amount_paid_cents != null
      ? Number(mergedDraft.amount_paid_cents)
      : 20000,
    total_amount_cents: mergedDraft && mergedDraft.balance_due_cents != null
      ? Number(mergedDraft.amount_paid_cents || 20000) + Number(mergedDraft.balance_due_cents)
      : 100000,
    metadata: {
      confirmation_draft: mergedDraft,
      language: trimStr(input.language_hint) || 'en',
    },
  };

  return {
    async query(sql, params) {
      if (/FROM bookings b/.test(sql) && /booking_code = \$2/.test(sql)) {
        if (params[1] === bookingCode) return { rows: [row] };
        return { rows: [] };
      }
      if (/FROM bookings b/.test(sql) && /b\.id = \$2/.test(sql)) {
        if (params[1] === bookingId) return { rows: [row] };
        return { rows: [] };
      }
      if (/FROM booking_beds bb/.test(sql)) {
        return { rows: [] };
      }
      if (/FROM payments p/.test(sql)) {
        return { rows: [] };
      }
      throw new Error(`fixture pg unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

function mapPreviewSuccess(preview, mergedDraft, language) {
  const draft = preview.confirmation_draft || mergedDraft || {};
  const balanceDueCents = draft.balance_due_cents != null
    ? Number(draft.balance_due_cents)
    : (preview.payment_status === 'paid' ? 0 : null);
  const paymentStatus = String(preview.payment_status || draft.payment_status || '').trim();

  const clientConfig = loadClientConfirmationConfig(
    (preview.messaging_playbook && preview.messaging_playbook.client_slug) || 'wolfhouse-somo',
  );
  const gateCode = resolveGateCode(draft, clientConfig);
  const addressResolved = resolveConfirmationAddress(draft, clientConfig);
  const roomNumbers = resolveRoomNumbers(
    draft,
    preview.primary_room_code || null,
    preview.room_numbers || [],
  );
  const roomFields = resolveRoomLabel(roomNumbers, draft);

  const proposed = sanitizePreviewMessage(
    preview.message_preview,
    paymentStatus,
    balanceDueCents != null ? balanceDueCents : 0,
    language,
  );

  return {
    success: true,
    ...PREVIEW_SAFETY,
    confirmation_preview_attempted: true,
    confirmation_preview_ready: true,
    booking_id: preview.booking_id,
    booking_code: preview.booking_code,
    payment_status: paymentStatus,
    balance_due_cents: balanceDueCents,
    room_number: roomFields.room_number,
    room_label: roomFields.room_label,
    gate_code: gateCode,
    address: addressResolved.address,
    proposed_confirmation_message: proposed,
    message_preview: proposed,
    confirmation_draft: draft,
    template_source: preview.template_source,
    next_safe_step: 'ready_for_confirmation_send_go_no_go',
    block_reasons: [],
    reused_preview_path: REUSED_PREVIEW_PATH,
    staff_notice: 'Confirmation preview dry-run only — not sent to guest. Await explicit send go/no-go.',
  };
}

/**
 * Stage 27q — dry-run confirmation preview for guest booking after payment truth.
 *
 * @param {{ booking_id?: string, booking_code?: string, language_hint?: string, guest_name?: string, confirmation_draft?: object, payment_status?: string, client_slug?: string }} input
 * @param {{ pg?: object, env?: object, use_fixture_pg?: boolean }} context
 */
async function runGuestConfirmationPreviewDryRun(input, context) {
  const ctx = context || {};
  const src = input || {};
  const bookingId = trimStr(src.booking_id);
  const bookingCode = trimStr(src.booking_code);
  const mergedDraft = mergeConfirmationDraft(src.confirmation_draft, src);

  if (!bookingId && !bookingCode && !(mergedDraft && mergedDraft.booking_code)) {
    return buildBlockedResponse(['booking_id_or_booking_code_required']);
  }

  const previewInput = {
    client_slug: trimStr(src.client_slug) || 'wolfhouse-somo',
    booking_id: bookingId || undefined,
    booking_code: bookingCode || (mergedDraft && mergedDraft.booking_code) || undefined,
  };

  const earlyPaymentStatus = trimStr(src.payment_status)
    || (mergedDraft && mergedDraft.payment_status)
    || '';

  if (earlyPaymentStatus && UNPAID_BOOKING_PAYMENT_STATUSES.has(earlyPaymentStatus)) {
    return buildBlockedResponse(['payment_truth_not_recorded'], {
      payment_status: earlyPaymentStatus,
      booking_code: previewInput.booking_code || null,
    });
  }

  if (mergedDraft && UNPAID_PAYMENT_RECORD_HINTS.has(String(mergedDraft.payment_record_status || '').trim())) {
    return buildBlockedResponse(['unpaid_payment_record_status'], {
      payment_status: earlyPaymentStatus || null,
    });
  }

  if (earlyPaymentStatus && !paymentTruthReady(earlyPaymentStatus, mergedDraft)) {
    return buildBlockedResponse(['payment_truth_not_recorded'], {
      payment_status: earlyPaymentStatus,
    });
  }

  const run = async (pg) => {
    const preview = await getLunaBookingConfirmationPreview(previewInput, {
      pg,
      loadClientConfirmationConfig,
    });

    if (!preview.success) {
      const reasons = preview.blocked_reasons || [preview.error || 'preview_not_ready'];
      if (reasons.includes('payment_not_paid')) {
        return buildBlockedResponse(['payment_truth_not_recorded'], {
          booking_id: preview.booking_id || null,
          booking_code: preview.booking_code || null,
          payment_status: preview.payment_status || null,
          confirmation_preview_attempted: true,
        });
      }
      return buildHandoffResponse(reasons, {
        booking_id: preview.booking_id || null,
        booking_code: preview.booking_code || null,
        payment_status: preview.payment_status || null,
        confirmation_draft: preview.confirmation_draft || mergedDraft,
        message_preview: preview.message_preview || null,
      });
    }

    const language = trimStr(src.language_hint)
      || (mergedDraft && mergedDraft.language)
      || 'en';
    const mapped = mapPreviewSuccess(preview, mergedDraft, language);

    const clientConfig = loadClientConfirmationConfig(previewInput.client_slug);
    if (!mapped.room_label) {
      return buildHandoffResponse(['missing_room_number_or_label'], mapped);
    }
    if (!mapped.gate_code) {
      return buildHandoffResponse(['missing_gate_code'], mapped);
    }
    if (clientConfig.include_address && !mapped.address) {
      return buildHandoffResponse(['missing_address'], mapped);
    }
    if (messageHasBedLeak(mapped.proposed_confirmation_message)) {
      return buildHandoffResponse(['message_preview_bed_leak'], mapped);
    }
    if (HOLD_EXPIRY_RE.test(mapped.proposed_confirmation_message)) {
      return buildHandoffResponse(['hold_expiry_mention_blocked'], mapped);
    }

    if (mapped.payment_status === 'paid' && BALANCE_ASK_RE.test(mapped.proposed_confirmation_message)) {
      return buildHandoffResponse(['full_paid_should_not_ask_balance'], mapped);
    }

    return mapped;
  };

  if (ctx.pg && typeof ctx.pg.query === 'function') {
    return run(ctx.pg);
  }

  if (mergedDraft && (ctx.use_fixture_pg === true || src.confirmation_draft)) {
    return run(buildFixturePg(src, mergedDraft));
  }

  try {
    return await withPgClient(run);
  } catch (err) {
    return buildBlockedResponse(['database_unavailable', err.message || 'pg_error']);
  }
}

module.exports = {
  runGuestConfirmationPreviewDryRun,
  paymentTruthReady,
  mergeConfirmationDraft,
  sanitizePreviewMessage,
  ensureLunaIdentity,
  appendDepositBalanceArrivalOptions,
  messageHasBedLeak,
  buildFixturePg,
  REUSED_PREVIEW_PATH,
  PREVIEW_SAFETY,
  PAID_STATUSES,
  UNPAID_BOOKING_PAYMENT_STATUSES,
};
