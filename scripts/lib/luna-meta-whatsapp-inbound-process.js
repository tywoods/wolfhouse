'use strict';

/**
 * Phase 19g.8 — Meta WhatsApp inbound webhook processing with DB persistence.
 */

const { buildLunaGuestReplyDraft } = require('./luna-guest-reply-draft');
const { evaluateGuestReplySendRouteWithPause } = require('./luna-guest-reply-send-route');
const {
  normalizeMetaWhatsAppWebhook,
  buildDraftInputFromNormalized,
  resolveMetaWebhookSendKind,
  shouldAttemptMetaWebhookSend,
  buildMetaWebhookSendBody,
  buildMetaWhatsAppWebhookPostResponse,
} = require('./luna-meta-whatsapp-webhook');
const {
  buildInboundEventSeed,
  buildDecisionPatch,
  findGuestMessageEventByWaMessageId,
  insertGuestMessageEventInbound,
  updateGuestMessageEventDecisions,
  isGuestMessageEventProcessed,
} = require('./luna-guest-message-events-sql');
const { buildInboundBookingWritePreview } = require('./luna-inbound-booking-write-preview');
const { lookupStaffPhoneAccess } = require('./staff-phone-access');
const {
  isOwnerLunaStoredEvent,
  buildOwnerResponseFromStoredEvent,
  processOwnerWhatsAppCommandCenterInbound,
  processOwnerWhatsAppCommandCenterWithoutPersistence,
} = require('./luna-owner-whatsapp-inbound');
const {
  shouldRouteMetaInboundToOpenDemo,
  processMetaOpenDemoGuestInbound,
} = require('./meta-open-demo-inbound-adapter');
const {
  shouldBlockMetaGuestInboundAfterOpenDemo,
  buildMetaGuestPhoneGateBlockedExtras,
  shouldRouteActiveStaffPhoneToOwnerCommandCenter,
} = require('./luna-open-phone-testing-gate');

function buildDraftFromStoredEvent(row) {
  if (!row) return null;
  return {
    suggested_reply: row.suggested_reply,
    next_action: row.next_action,
    send_eligibility: row.normalized && row.normalized.send_eligibility
      ? row.normalized.send_eligibility
      : null,
    messaging_playbook: row.normalized && row.normalized.messaging_playbook
      ? row.normalized.messaging_playbook
      : null,
    dry_run_plan: row.normalized && row.normalized.dry_run_plan
      ? row.normalized.dry_run_plan
      : null,
    extraction: row.handoff_required ? { handoff_required: true } : null,
  };
}

function buildSendResultFromStoredEvent(row) {
  if (!row || row.send_attempted !== true) return null;
  const blockedReasons = Array.isArray(row.send_blocked_reasons) ? row.send_blocked_reasons : [];
  const sendPerformed = row.send_status === 'sent';
  return {
    send_performed: sendPerformed,
    sends_whatsapp: sendPerformed,
    no_write_performed: row.send_status === 'blocked' ? false : !sendPerformed,
    blocked_reasons: blockedReasons,
    guest_message_send_status: row.send_status,
    duplicate: true,
  };
}

function buildResponseFromStoredEvent(row, signatureMeta, replayMeta = {}) {
  const normalized = row.normalized || {};
  const draft = buildDraftFromStoredEvent(row);
  const sendResult = buildSendResultFromStoredEvent(row);
  const storedPreview = normalized.booking_write_preview || null;
  const response = buildMetaWhatsAppWebhookPostResponse(normalized, signatureMeta, {
    draft: draftCalledDraft(draft, row),
    draft_called: row.draft_called === true,
    send_attempted: row.send_attempted === true,
    send_result: sendResult,
    idempotency_key: row.send_idempotency_key,
    booking_write_preview: storedPreview,
    event_persisted: true,
  });
  return {
    ...response,
    duplicate: replayMeta.duplicate === true,
    idempotent_replay: replayMeta.idempotent_replay === true,
    guest_message_event_id: row.id,
  };
}

function draftCalledDraft(draft, row) {
  if (row.draft_called !== true) return null;
  return draft;
}

function buildGuestPhoneGateBlockedMetaResponse(normalized, signatureMeta, eventRow, gate) {
  const response = buildMetaWhatsAppWebhookPostResponse(normalized, signatureMeta, {
    draft_called: false,
    send_attempted: false,
    event_persisted: !!eventRow,
  });
  return {
    response: {
      ...response,
      duplicate: false,
      idempotent_replay: false,
      guest_message_event_id: eventRow ? eventRow.id : null,
      ...buildMetaGuestPhoneGateBlockedExtras(gate),
    },
    event_row: eventRow,
    replay: false,
  };
}

function enrichDraftForStorage(draft, bookingWritePreview) {
  if (!draft || typeof draft !== 'object') {
    return bookingWritePreview ? { booking_write_preview: bookingWritePreview } : null;
  }
  return {
    send_eligibility: draft.send_eligibility || null,
    messaging_playbook: draft.messaging_playbook || null,
    dry_run_plan: draft.dry_run_plan || null,
    booking_write_preview: bookingWritePreview || null,
  };
}

async function runDraftAndSendGate(pg, env, normalized) {
  let draftResult = null;
  let draftCalled = false;
  let sendAttempted = false;
  let sendResult = null;
  let idempotencyKey = null;

  let bookingWritePreview = null;

  if (normalized.supported && normalized.message_text) {
    const draftInput = buildDraftInputFromNormalized(normalized);
    draftResult = await buildLunaGuestReplyDraft(draftInput, { pg, env });
    draftCalled = true;
    bookingWritePreview = buildInboundBookingWritePreview(draftResult, draftInput, env);

    if (shouldAttemptMetaWebhookSend(draftResult, normalized)) {
      const sendKind = resolveMetaWebhookSendKind(draftResult.next_action);
      const sendBody = buildMetaWebhookSendBody(normalized, draftResult, sendKind);
      idempotencyKey = sendBody.idempotency_key;
      sendAttempted = true;
      const evaluated = await evaluateGuestReplySendRouteWithPause(sendBody, {
        pg,
        env,
      });
      sendResult = evaluated.result;
    }
  }

  return {
    draftResult,
    draftCalled,
    sendAttempted,
    sendResult,
    idempotencyKey,
    bookingWritePreview,
  };
}

async function processWithoutPersistence(pg, env, normalized, body, signatureMeta) {
  const staffPhoneAccess = pg
    ? await lookupStaffPhoneAccess(pg, {
      client_slug: normalized.client_slug,
      phone: normalized.from,
      channel: 'whatsapp',
    })
    : { found: false, active: false };

  if (shouldRouteActiveStaffPhoneToOwnerCommandCenter(env, normalized, staffPhoneAccess)) {
    return processOwnerWhatsAppCommandCenterWithoutPersistence({
      pg,
      env,
      normalized,
      signatureMeta,
      staff_access: staffPhoneAccess,
    });
  }

  const phoneGateBlock = shouldBlockMetaGuestInboundAfterOpenDemo(env, normalized);
  if (phoneGateBlock.block) {
    return buildGuestPhoneGateBlockedMetaResponse(
      normalized,
      signatureMeta,
      null,
      phoneGateBlock.gate,
    );
  }

  if (shouldRouteMetaInboundToOpenDemo(env, normalized)) {
    return processMetaOpenDemoGuestInbound({
      pg,
      env,
      normalized,
      signatureMeta,
      event_row: null,
    });
  }

  const ran = await runDraftAndSendGate(pg, env, normalized);
  const response = buildMetaWhatsAppWebhookPostResponse(normalized, signatureMeta, {
    draft: ran.draftResult,
    draft_called: ran.draftCalled,
    send_attempted: ran.sendAttempted,
    send_result: ran.sendResult,
    idempotency_key: ran.idempotencyKey,
    booking_write_preview: ran.bookingWritePreview,
    event_persisted: false,
  });
  return {
    response: {
      ...response,
      duplicate: false,
      idempotent_replay: false,
      guest_message_event_id: null,
    },
    event_row: null,
    replay: false,
  };
}

/**
 * Process Meta inbound webhook POST with guest_message_events persistence.
 *
 * @param {{ pg: object, env?: object, body: object, signatureMeta?: object }} input
 */
async function processMetaWhatsAppWebhookInbound(input) {
  const pg = input.pg;
  const env = input.env || process.env;
  const body = input.body || {};
  const signatureMeta = input.signatureMeta || {};

  const normalized = input.normalized || normalizeMetaWhatsAppWebhook(body);

  if (!normalized.wa_message_id || !normalized.client_slug) {
    const response = buildMetaWhatsAppWebhookPostResponse(normalized, signatureMeta, {
      draft_called: false,
      send_attempted: false,
    });
    return { response, event_row: null, replay: false };
  }

  const existing = await findGuestMessageEventByWaMessageId(
    pg,
    normalized.client_slug,
    normalized.wa_message_id,
  );

  if (existing.table_missing) {
    return processWithoutPersistence(pg, env, normalized, body, signatureMeta);
  }

  if (existing.row && isGuestMessageEventProcessed(existing.row)) {
    const buildReplay = isOwnerLunaStoredEvent(existing.row)
      ? buildOwnerResponseFromStoredEvent
      : buildResponseFromStoredEvent;
    return {
      response: buildReplay(existing.row, signatureMeta, {
        duplicate: true,
        idempotent_replay: true,
      }),
      event_row: existing.row,
      replay: true,
    };
  }

  const seed = buildInboundEventSeed(normalized, body);
  const inserted = await insertGuestMessageEventInbound(pg, seed);

  if (inserted.table_missing) {
    return processWithoutPersistence(pg, env, normalized, body, signatureMeta);
  }

  const eventRow = inserted.row;

  if (inserted.row && isGuestMessageEventProcessed(inserted.row)) {
    const buildReplay = isOwnerLunaStoredEvent(inserted.row)
      ? buildOwnerResponseFromStoredEvent
      : buildResponseFromStoredEvent;
    return {
      response: buildReplay(inserted.row, signatureMeta, {
        duplicate: true,
        idempotent_replay: true,
      }),
      event_row: inserted.row,
      replay: true,
    };
  }

  const staffPhoneAccess = pg
    ? await lookupStaffPhoneAccess(pg, {
      client_slug: normalized.client_slug,
      phone: normalized.from,
      channel: 'whatsapp',
    })
    : { found: false, active: false };

  if (shouldRouteActiveStaffPhoneToOwnerCommandCenter(env, normalized, staffPhoneAccess)) {
    return processOwnerWhatsAppCommandCenterInbound({
      pg,
      env,
      normalized,
      signatureMeta,
      staff_access: staffPhoneAccess,
      event_row: eventRow,
    });
  }

  const phoneGateBlock = shouldBlockMetaGuestInboundAfterOpenDemo(env, normalized);
  if (phoneGateBlock.block) {
    return buildGuestPhoneGateBlockedMetaResponse(
      normalized,
      signatureMeta,
      eventRow,
      phoneGateBlock.gate,
    );
  }

  if (shouldRouteMetaInboundToOpenDemo(env, normalized)) {
    return processMetaOpenDemoGuestInbound({
      pg,
      env,
      normalized,
      signatureMeta,
      event_row: eventRow,
    });
  }

  let draftResult = null;
  let draftCalled = false;
  let sendAttempted = false;
  let sendResult = null;
  let idempotencyKey = null;

  const ran = await runDraftAndSendGate(pg, env, normalized);
  draftResult = ran.draftResult;
  draftCalled = ran.draftCalled;
  sendAttempted = ran.sendAttempted;
  sendResult = ran.sendResult;
  idempotencyKey = ran.idempotencyKey;

  const decisionPatch = buildDecisionPatch({
    draft: draftResult,
    draft_called: draftCalled,
    send_attempted: sendAttempted,
    send_idempotency_key: idempotencyKey,
    send_result: sendResult,
  });

  const bookingWritePreview = ran.bookingWritePreview;

  const normalizedForStorage = {
    ...normalized,
    ...enrichDraftForStorage(draftResult, bookingWritePreview),
  };

  let updatedRow = eventRow;
  if (pg && eventRow) {
    await pg.query(
      `UPDATE guest_message_events
          SET normalized = $3::jsonb
        WHERE client_slug = $1
          AND wa_message_id = $2`,
      [
        normalized.client_slug,
        normalized.wa_message_id,
        JSON.stringify(normalizedForStorage),
      ],
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
    draft: draftResult,
    draft_called: draftCalled,
    send_attempted: sendAttempted,
    send_result: sendResult,
    idempotency_key: idempotencyKey,
    booking_write_preview: bookingWritePreview,
    event_persisted: !!updatedRow,
  });

  return {
    response: {
      ...response,
      duplicate: false,
      idempotent_replay: false,
      guest_message_event_id: updatedRow ? updatedRow.id : null,
    },
    event_row: updatedRow,
    replay: false,
  };
}

module.exports = {
  processMetaWhatsAppWebhookInbound,
  buildResponseFromStoredEvent,
  buildSendResultFromStoredEvent,
};
