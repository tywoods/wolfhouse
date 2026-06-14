'use strict';

/**
 * Phase 22a — Inbound Meta booking write preview (plan-only, no write).
 *
 * Maps a guest-reply draft + inbound context to a write-ready preview for
 * POST /staff/bot/booking-create-from-plan without invoking it.
 */

const { buildBotBookingCreatePayload, BRIDGE_ROUTE } = require('./luna-guest-booking-write-bridge');
const { evaluateLunaBookingWriteEligibility } = require('./luna-guest-booking-write-eligibility');
const { isBookingCreateReady } = require('./luna-guest-automation-planner');

const PREVIEW_SAFETY_FLAGS = Object.freeze({
  preview_only:         true,
  no_write_performed:   true,
  creates_booking:      false,
  creates_payment:      false,
  creates_stripe_link:  false,
  sends_whatsapp:       false,
  calls_graph_api:      false,
  calls_n8n:            false,
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * Stable idempotency key preview for inbound wa_message_id (write not performed).
 */
function buildInboundBookingWriteIdempotencyPreview(clientSlug, waMessageId) {
  const slug = trimStr(clientSlug) || 'wolfhouse-somo';
  const waId = trimStr(waMessageId);
  return `luna-booking:${slug}:${waId}:v1`;
}

function resolvePreviewInput(draft, input) {
  const ex = (draft && draft.extraction) || {};
  const src = input || {};
  const preview = (draft.dry_run_plan && draft.dry_run_plan.booking_preview)
    ? draft.dry_run_plan.booking_preview.fields || {}
    : {};

  const paymentChoice = trimStr(src.payment_choice).toLowerCase()
    || trimStr(ex.payment_choice).toLowerCase()
    || trimStr(preview.payment_choice).toLowerCase();

  return {
    client_slug:   trimStr(src.client_slug) || trimStr(draft.client_slug) || 'wolfhouse-somo',
    guest_name:    trimStr(src.guest_name) || trimStr(ex.guest_name) || null,
    from:          trimStr(src.from) || trimStr(ex.phone),
    guest_phone:   trimStr(src.guest_phone) || trimStr(src.phone) || trimStr(src.from) || trimStr(ex.phone),
    phone:         trimStr(src.phone) || trimStr(src.from) || trimStr(ex.phone),
    check_in:      trimStr(src.check_in) || trimStr(ex.check_in),
    check_out:     trimStr(src.check_out) || trimStr(ex.check_out),
    guest_count:   src.guest_count != null ? src.guest_count : ex.guests,
    package_code:  trimStr(src.package_code) || trimStr(ex.package_code),
    payment_choice: paymentChoice,
    language:      trimStr(src.language) || trimStr(ex.language) || trimStr(draft.language) || 'en',
    wa_message_id: trimStr(src.wa_message_id),
    confirm:       false,
    idempotency_key: buildInboundBookingWriteIdempotencyPreview(
      trimStr(src.client_slug) || trimStr(draft.client_slug),
      trimStr(src.wa_message_id),
    ),
    source:        'meta_whatsapp_inbound_preview',
  };
}

function collectHandoffBlockedReasons(draft) {
  const ex = (draft && draft.extraction) || {};
  const reasons = [];
  if (ex.handoff_required) {
    reasons.push(ex.handoff_reason ? `handoff:${ex.handoff_reason}` : 'handoff_required');
  }
  if (draft.next_action === 'handoff_to_staff') reasons.push('handoff_to_staff');
  if (draft.next_action === 'unsupported') reasons.push('unsupported_message');
  if (ex.handoff_reason === 'low_confidence') reasons.push('low_confidence');
  return [...new Set(reasons)];
}

function collectMissingFieldReasons(draft) {
  const ex = (draft && draft.extraction) || {};
  const missing = Array.isArray(ex.missing_fields) ? ex.missing_fields.filter(Boolean) : [];
  if (missing.length) return missing.map((f) => `missing_field:${f}`);
  const previewMissing = draft.dry_run_plan
    && draft.dry_run_plan.booking_preview
    && Array.isArray(draft.dry_run_plan.booking_preview.missing_fields)
    ? draft.dry_run_plan.booking_preview.missing_fields.filter(Boolean)
    : [];
  return previewMissing.map((f) => `missing_field:${f}`);
}

function buildBedSelectionNote(dryRunPlan) {
  const avail = dryRunPlan && dryRunPlan.availability ? dryRunPlan.availability : null;
  if (!avail) return 'write_route_will_recheck_availability_and_bed_locks';
  const codes = Array.isArray(avail.selected_bed_codes) ? avail.selected_bed_codes.filter(Boolean) : [];
  if (codes.length) {
    return `dry_run_selected_beds:${codes.join(',')}; write_route_may_reselect_on_server`;
  }
  return 'write_route_will_recheck_availability_and_bed_locks';
}

/**
 * Build booking write preview from inbound draft (no HTTP / DB writes).
 *
 * @param {object} draft - output from buildLunaGuestReplyDraft
 * @param {object} input - draft input (from, wa_message_id, guest_name, etc.)
 * @param {object} [env]
 * @returns {object}
 */
function buildInboundBookingWritePreview(draft, input, env) {
  const base = Object.assign({}, PREVIEW_SAFETY_FLAGS, {
    eligible: false,
    action: null,
    would_call: null,
    confirm_required: true,
    idempotency_key_preview: null,
    booking_create_payload_preview: null,
    blocked_reasons: [],
    server_requotes_on_write: true,
    amounts_not_final: true,
  });

  if (!draft || typeof draft !== 'object') {
    base.blocked_reasons = ['draft_missing'];
    return base;
  }

  const previewInput = resolvePreviewInput(draft, input);
  base.idempotency_key_preview = previewInput.idempotency_key || null;

  const handoffReasons = collectHandoffBlockedReasons(draft);
  if (handoffReasons.length) {
    base.blocked_reasons = handoffReasons;
    return base;
  }

  const dry = draft.dry_run_plan;
  if (!dry) {
    base.blocked_reasons = collectMissingFieldReasons(draft);
    if (!base.blocked_reasons.length) base.blocked_reasons = ['dry_run_not_available'];
    return base;
  }

  const eligibility = evaluateLunaBookingWriteEligibility(dry, previewInput, env || process.env);
  const structuralBlocked = [...(eligibility.blocked_reasons || [])];

  if (!isBookingCreateReady(draft, previewInput)) {
    const missing = collectMissingFieldReasons(draft);
    base.blocked_reasons = [...new Set([...structuralBlocked, ...missing, 'booking_plan_not_write_ready'])];
    return base;
  }

  if (structuralBlocked.length) {
    base.blocked_reasons = structuralBlocked;
    return base;
  }

  const payload = buildBotBookingCreatePayload(dry, previewInput);
  payload.confirm = false;
  payload.source = 'meta_whatsapp_inbound_preview';
  delete payload.notes;

  base.eligible = true;
  base.action = 'create_booking_and_payment_draft';
  base.would_call = BRIDGE_ROUTE;
  base.booking_create_payload_preview = payload;
  base.blocked_reasons = [];
  base.bed_selection_note = buildBedSelectionNote(dry);
  base.pending_write_approvals = eligibility.required_approvals || [];

  return base;
}

module.exports = {
  buildInboundBookingWritePreview,
  buildInboundBookingWriteIdempotencyPreview,
  PREVIEW_SAFETY_FLAGS,
  BRIDGE_ROUTE,
};
