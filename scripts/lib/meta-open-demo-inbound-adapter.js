'use strict';

/**
 * Stage 28c.3 — Meta WhatsApp webhook → open-demo inbound adapter.
 */

const { buildMetaWhatsAppWebhookPostResponse } = require('./luna-meta-whatsapp-webhook');
const {
  buildDecisionPatch,
  updateGuestMessageEventDecisions,
} = require('./luna-guest-message-events-sql');
const {
  isProductionEnvironment,
  isOpenDemoWhatsAppEnabled,
  isOpenDemoBookingWritesEnabled,
  evaluateOpenDemoWhatsAppGate,
  evaluateOpenDemoHoldDraftWriteReady,
  validateOpenDemoInboundBody,
} = require('./open-demo-whatsapp-gate');
const { executeOpenDemoWhatsAppInbound } = require('./open-demo-whatsapp-inbound-execute');

const META_OPEN_DEMO_SOURCE = 'meta_whatsapp_webhook_open_demo';

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function metaFromToGuestPhone(from) {
  const digits = String(from || '').replace(/\D/g, '');
  if (!digits) return null;
  return `+${digits}`;
}

/**
 * Map normalized Meta webhook fields to n8n-shaped open-demo body.
 */
function buildOpenDemoRequestBodyFromMeta(normalized) {
  const n = normalized || {};
  const guestPhone = metaFromToGuestPhone(n.from);
  let receivedAt = null;
  if (n.timestamp != null && String(n.timestamp).trim()) {
    const ts = Number(n.timestamp);
    if (Number.isFinite(ts) && ts > 0) {
      receivedAt = new Date(ts * 1000).toISOString();
    }
  }

  return {
    source: META_OPEN_DEMO_SOURCE,
    client_slug: trimStr(n.client_slug) || 'wolfhouse-somo',
    channel: 'whatsapp',
    phone_number_id: n.phone_number_id != null ? trimStr(n.phone_number_id) : null,
    guest_phone: guestPhone,
    contact_name: n.profile_name != null ? trimStr(n.profile_name) : null,
    message_text: n.message_text != null ? trimStr(n.message_text) : null,
    wamid: n.wa_message_id,
    inbound_message_id: n.wa_message_id,
    received_at: receivedAt || new Date().toISOString(),
  };
}

/**
 * Whether Meta inbound should use open-demo review/write path (not legacy draft preview).
 */
function shouldRouteMetaInboundToOpenDemo(env, normalized) {
  if (!normalized || normalized.supported !== true || !trimStr(normalized.message_text)) {
    return false;
  }
  if (isProductionEnvironment(env)) return false;
  if (!isOpenDemoWhatsAppEnabled(env)) return false;

  const body = buildOpenDemoRequestBodyFromMeta(normalized);
  const gate = evaluateOpenDemoWhatsAppGate(body, env);
  return gate.ok === true;
}

/**
 * Auto-confirm write flags when staging booking-write gate is on and review is ready.
 */
function buildMetaOpenDemoWriteConfirmFlags(env, review) {
  if (!isOpenDemoBookingWritesEnabled(env)) {
    return {
      create_demo_hold_draft_confirmed: false,
      assign_demo_bed_confirmed: false,
    };
  }
  const ready = evaluateOpenDemoHoldDraftWriteReady(review || {});
  if (!ready.ok) {
    return {
      create_demo_hold_draft_confirmed: false,
      assign_demo_bed_confirmed: false,
    };
  }
  return {
    create_demo_hold_draft_confirmed: true,
    assign_demo_bed_confirmed: true,
  };
}

function buildDraftFromOpenDemoReview(review) {
  const r = review || {};
  return {
    suggested_reply: r.proposed_luna_reply != null ? String(r.proposed_luna_reply) : null,
    next_action: r.proposed_next_action || null,
    send_eligibility: {
      requires_staff: false,
      send_allowed_later: true,
      auto_send_ready: false,
      allowed_send_kind: 'staff_reply',
      sends_whatsapp: false,
      live_send_blocked: true,
      blocked_reasons: ['whatsapp_dry_run_active', 'live_send_env_not_enabled'],
    },
    extraction: null,
    open_demo_review: true,
  };
}

function buildOpenDemoResultSummary(outcome) {
  const review = outcome.reviewOutcome && outcome.reviewOutcome.body
    ? outcome.reviewOutcome.body.review || {}
    : {};
  const bw = outcome.bookingWrite || {};
  const ba = outcome.bedAssignment || {};
  const result = review.result || {};
  const pc = review.payment_choice || {};

  return {
    route: META_OPEN_DEMO_SOURCE,
    calls_n8n: false,
    review_ok: outcome.reviewOutcome && outcome.reviewOutcome.ok === true,
    proposed_next_action: review.proposed_next_action || null,
    package_code: result.package_code || null,
    guest_count: result.guest_count != null ? result.guest_count : null,
    check_in: result.check_in || null,
    check_out: result.check_out || null,
    payment_choice_ready: pc.payment_choice_ready === true,
    payment_choice_needed: pc.payment_choice_needed === true,
    write_status: bw.write_status || null,
    assignment_write_status: ba.assignment_write_status || null,
    booking_code: bw.booking_code || null,
    booking_id: bw.booking_id || null,
    payment_draft_id: bw.payment_draft_id || null,
    assigned_bed_label: ba.assigned_bed_label || ba.bed_code || null,
    assigned_room_label: ba.assigned_room_label || ba.room_code || null,
    calendar_visible_expected: ba.calendar_visible_expected === true,
    stripe_link_created: false,
    payment_link_sent: false,
    confirmation_sent: false,
    effective_flags: outcome.effectiveFlags || {},
  };
}

/**
 * Process Meta guest inbound via internal open-demo path (no n8n, no live reply).
 */
async function processMetaOpenDemoGuestInbound(input) {
  const pg = input.pg;
  const env = input.env || process.env;
  const normalized = input.normalized;
  const signatureMeta = input.signatureMeta || {};
  const eventRow = input.event_row;

  const openDemoBody = buildOpenDemoRequestBodyFromMeta(normalized);
  const validation = validateOpenDemoInboundBody(openDemoBody);
  if (!validation.ok) {
    const response = buildMetaWhatsAppWebhookPostResponse(normalized, signatureMeta, {
      draft_called: false,
      send_attempted: false,
      event_persisted: !!eventRow,
    });
    return {
      response: {
        ...response,
        success: false,
        error: `${validation.missing.join(', ')} required for open demo meta route`,
        open_demo_route: true,
      },
      event_row: eventRow,
      replay: false,
    };
  }

  const outcome = await executeOpenDemoWhatsAppInbound(pg, openDemoBody, env, {
    hostHeader: '',
    actorId: 'meta-whatsapp-open-demo',
    resolveWriteFlagsAfterReview: (review) => buildMetaOpenDemoWriteConfirmFlags(env, review),
  });

  const review = outcome.reviewOutcome && outcome.reviewOutcome.body
    ? outcome.reviewOutcome.body.review || {}
    : {};
  const draft = buildDraftFromOpenDemoReview(review);
  const openDemoResult = buildOpenDemoResultSummary(outcome);
  const writeCreated = outcome.bookingWrite
    && (outcome.bookingWrite.write_status === 'created'
      || outcome.bookingWrite.write_status === 'reused_existing');

  const decisionPatch = buildDecisionPatch({
    draft,
    draft_called: true,
    send_attempted: false,
    send_status: null,
  });

  const normalizedForStorage = {
    ...normalized,
    open_demo_route: true,
    guest_flow_skipped: false,
    send_eligibility: draft.send_eligibility,
    open_demo_result: openDemoResult,
    booking_write_preview: {
      preview_only: !writeCreated,
      no_write_performed: !writeCreated,
      eligible: openDemoResult.payment_choice_ready === true,
      action: writeCreated ? 'create_booking_and_payment_draft' : null,
      write_status: openDemoResult.write_status,
      payment_choice_ready: openDemoResult.payment_choice_ready,
      blocked_reasons: writeCreated ? [] : undefined,
    },
  };

  let updatedRow = eventRow;
  if (pg && eventRow) {
    await pg.query(
      `UPDATE guest_message_events
          SET normalized = $3::jsonb
        WHERE client_slug = $1
          AND wa_message_id = $2`,
      [normalized.client_slug, normalized.wa_message_id, JSON.stringify(normalizedForStorage)],
    ).catch(() => {});
    const updated = await updateGuestMessageEventDecisions(
      pg,
      normalized.client_slug,
      normalized.wa_message_id,
      decisionPatch,
    );
    updatedRow = updated.row || eventRow;
  }

  const response = buildMetaWhatsAppWebhookPostResponse(normalized, signatureMeta, {
    draft,
    draft_called: true,
    send_attempted: false,
    send_result: null,
    idempotency_key: null,
    booking_write_preview: normalizedForStorage.booking_write_preview,
    event_persisted: !!updatedRow,
  });

  return {
    response: {
      ...response,
      open_demo_route: true,
      open_demo_result: openDemoResult,
      creates_booking: writeCreated,
      creates_payment: writeCreated,
      no_write_performed: !writeCreated,
      preview_only: !writeCreated,
      duplicate: false,
      idempotent_replay: false,
      guest_message_event_id: updatedRow ? updatedRow.id : null,
    },
    event_row: updatedRow,
    replay: false,
  };
}

module.exports = {
  META_OPEN_DEMO_SOURCE,
  metaFromToGuestPhone,
  buildOpenDemoRequestBodyFromMeta,
  shouldRouteMetaInboundToOpenDemo,
  buildMetaOpenDemoWriteConfirmFlags,
  processMetaOpenDemoGuestInbound,
  buildOpenDemoResultSummary,
};
