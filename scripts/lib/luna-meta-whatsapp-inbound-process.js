'use strict';

/**
 * Phase 19g.8 — Meta WhatsApp inbound webhook processing with DB persistence.
 * FORTRESS 15H — authority before PG via processMetaWhatsAppWebhookPostEntry;
 * frozen replay compare/reject/fill; structured downstream error identity.
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
  claimGuestMessageEventInboundByWaMessageId,
  mergeNormalizedPreservingStoredIdentity,
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
const {
  applyMetaWhatsAppIngressAuthority,
  shouldBlockMetaWhatsAppIngressDownstream,
  resolveReplayNormalizedIdentity,
  attachEffectiveNormalizedToError,
} = require('./meta-whatsapp-ingress-authority');

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

/**
 * Global replay conflict/ambiguity envelope.
 * Returns non-sensitive metadata only — never attaches a foreign event_row or
 * cross-tenant stored content (suggested_reply, raw_payload, etc.).
 */
function buildReplayIdentityConflictResponse(normalized, signatureMeta, conflict) {
  const reason = (conflict && conflict.reason) || 'replay_identity_conflict';
  const response = buildMetaWhatsAppWebhookPostResponse(normalized, signatureMeta, {
    draft_called: false,
    send_attempted: false,
    event_persisted: true,
  });
  const meta = {
    reason,
  };
  if (conflict && conflict.stored_client_slug) {
    meta.stored_client_slug = String(conflict.stored_client_slug);
  }
  if (conflict && conflict.authoritative_client_slug) {
    meta.authoritative_client_slug = String(conflict.authoritative_client_slug);
  }
  if (conflict && conflict.stored_location_id) {
    meta.stored_location_id = String(conflict.stored_location_id);
  }
  if (conflict && conflict.authoritative_location_id) {
    meta.authoritative_location_id = String(conflict.authoritative_location_id);
  }
  if (conflict && conflict.candidate_count != null) {
    meta.candidate_count = Number(conflict.candidate_count) || 0;
  }
  return {
    ...response,
    success: false,
    duplicate: true,
    idempotent_replay: false,
    replay_identity_rejected: true,
    guest_message_event_id: null,
    blocked_reasons: [reason],
    replay_identity: meta,
    draft_called: false,
    send_attempted: false,
    no_write_performed: true,
  };
}

/**
 * Stored identity for REPLAY_IDENTITY_COMPARE_REJECT_FILL.
 * Prefer nonempty normalized fields; fall back to row.client_slug.
 */
function storedNormalizedIdentityFromRow(row) {
  const stored = (row && row.normalized && typeof row.normalized === 'object')
    ? { ...row.normalized }
    : {};
  if (!String(stored.client_slug || '').trim() && row && row.client_slug) {
    stored.client_slug = row.client_slug;
  }
  return stored;
}

function buildResponseFromStoredEvent(row, signatureMeta, replayMeta = {}) {
  const authoritative = replayMeta.authoritative_normalized || null;
  let normalized = storedNormalizedIdentityFromRow(row);
  if (authoritative) {
    const identity = resolveReplayNormalizedIdentity(normalized, authoritative);
    if (!identity.ok) {
      return buildReplayIdentityConflictResponse(authoritative, signatureMeta, identity);
    }
    normalized = identity.response_normalized;
  }

  const draft = buildDraftFromStoredEvent(row);
  const sendResult = buildSendResultFromStoredEvent(row);
  const storedPreview = (row.normalized && row.normalized.booking_write_preview) || null;
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
    replay_history_rewritten: false,
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

/**
 * FORTRESS 15H — fail closed before draft/send/DB when ingress authority blocks.
 */
function buildIngressAuthorityBlockedMetaResponse(normalized, signatureMeta) {
  const ia = (normalized && normalized.ingress_authority) || {};
  const reason = ia.reason || 'ingress_authority_blocked';
  const response = buildMetaWhatsAppWebhookPostResponse(normalized, signatureMeta, {
    draft_called: false,
    send_attempted: false,
    event_persisted: false,
  });
  return {
    response: {
      ...response,
      duplicate: false,
      idempotent_replay: false,
      guest_message_event_id: null,
      ingress_authority_blocked: true,
      blocked_reasons: [reason],
      draft_called: false,
      send_attempted: false,
      event_persisted: false,
      no_write_performed: true,
    },
    event_row: null,
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

function buildProcessedReplay(row, signatureMeta, authoritativeNormalized) {
  const buildReplay = isOwnerLunaStoredEvent(row)
    ? buildOwnerResponseFromStoredEvent
    : buildResponseFromStoredEvent;
  return {
    response: buildReplay(row, signatureMeta, {
      duplicate: true,
      idempotent_replay: true,
      authoritative_normalized: authoritativeNormalized,
    }),
    event_row: row,
    replay: true,
  };
}

async function processWithoutPersistence(pg, env, normalized, body, signatureMeta) {
  if (shouldBlockMetaWhatsAppIngressDownstream(normalized)) {
    return buildIngressAuthorityBlockedMetaResponse(normalized, signatureMeta);
  }

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
 * FORTRESS 15H — Meta POST entry after JSON parse / signature check.
 * Normalize + apply ingress authority **before** any pool/client acquisition.
 * Blocked identities return the authority-blocked envelope with acquired_pg=false
 * and never invoke withPgClient / processInbound (hence zero persistence/draft/
 * send/owner/demo work). Returns effective post-authority normalized for HTTP
 * audit. Downstream failures throw a structured error carrying effective_normalized.
 *
 * @param {{
 *   body?: object,
 *   env?: object,
 *   signatureMeta?: object,
 *   normalized?: object,
 *   normalizeOptions?: object,
 *   client_slug?: string,
 *   registry?: object,
 *   withPgClient: Function,
 *   processInbound?: Function,
 *   normalize?: Function,
 * }} input
 */
async function processMetaWhatsAppWebhookPostEntry(input) {
  const env = input.env || process.env;
  const body = input.body || {};
  const signatureMeta = input.signatureMeta || {};
  const withPgClientFn = input.withPgClient;
  const processInbound = input.processInbound || processMetaWhatsAppWebhookInbound;
  const normalizeFn = input.normalize || normalizeMetaWhatsAppWebhook;
  const normalizeOptions = Object.assign(
    { env, client_slug: input.client_slug },
    input.normalizeOptions || {},
  );
  const registry = input.registry
    || normalizeOptions.registry
    || null;

  let normalized = input.normalized != null
    ? input.normalized
    : normalizeFn(body, normalizeOptions);

  // Shared choke point: apply authority after normalize (idempotent if already applied).
  normalized = applyMetaWhatsAppIngressAuthority(normalized, { env, registry });

  if (shouldBlockMetaWhatsAppIngressDownstream(normalized)) {
    const blocked = buildIngressAuthorityBlockedMetaResponse(normalized, signatureMeta);
    return {
      normalized,
      acquired_pg: false,
      response: blocked.response,
      event_row: blocked.event_row,
      replay: blocked.replay,
    };
  }

  if (typeof withPgClientFn !== 'function') {
    throw attachEffectiveNormalizedToError(
      new Error('withPgClient_required_when_ingress_authority_allows_downstream'),
      normalized,
    );
  }

  try {
    const processed = await withPgClientFn((pg) => processInbound({
      pg,
      env,
      body,
      normalized,
      signatureMeta,
      client_slug: input.client_slug,
      executeOpenDemo: input.executeOpenDemo,
    }));

    return {
      normalized,
      acquired_pg: true,
      response: processed.response,
      event_row: processed.event_row,
      replay: processed.replay,
    };
  } catch (err) {
    throw attachEffectiveNormalizedToError(err, normalized);
  }
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

  const normalized = input.normalized || normalizeMetaWhatsAppWebhook(body, {
    env,
    client_slug: input.client_slug,
  });

  // FORTRESS 15H — authority block before any DB lookup/insert or draft/send.
  if (shouldBlockMetaWhatsAppIngressDownstream(normalized)) {
    return buildIngressAuthorityBlockedMetaResponse(normalized, signatureMeta);
  }

  if (!normalized.wa_message_id || !normalized.client_slug) {
    const response = buildMetaWhatsAppWebhookPostResponse(normalized, signatureMeta, {
      draft_called: false,
      send_attempted: false,
    });
    return { response, event_row: null, replay: false };
  }

  // FORTRESS 15H — concurrency-safe claim by WhatsApp message identity across
  // tenant slugs (advisory lock). Do not trust requested tenant; do not rely on
  // check-then-insert outside the lock; no global UNIQUE(wa_message_id) required.
  let claim;
  try {
    claim = await claimGuestMessageEventInboundByWaMessageId(
      pg,
      buildInboundEventSeed(normalized, body),
    );
  } catch (err) {
    throw attachEffectiveNormalizedToError(err, normalized);
  }

  if (claim.table_missing) {
    return processWithoutPersistence(pg, env, normalized, body, signatureMeta);
  }

  const rows = Array.isArray(claim.rows) ? claim.rows : [];
  const insertedNew = claim.inserted === true;

  if (rows.length > 1) {
    return {
      response: buildReplayIdentityConflictResponse(normalized, signatureMeta, {
        reason: 'replay_ambiguous_wa_message_id',
        candidate_count: rows.length,
      }),
      event_row: null,
      replay: false,
    };
  }

  let eventRow = null;

  if (rows.length === 1) {
    const existingRow = rows[0];
    const identity = resolveReplayNormalizedIdentity(
      storedNormalizedIdentityFromRow(existingRow),
      normalized,
    );
    if (!identity.ok) {
      return {
        response: buildReplayIdentityConflictResponse(normalized, signatureMeta, {
          ...identity,
          candidate_count: 1,
        }),
        // Never return cross-tenant row content on conflict/ambiguity.
        event_row: null,
        replay: false,
      };
    }

    if (!insertedNew && isGuestMessageEventProcessed(existingRow)) {
      return buildProcessedReplay(existingRow, signatureMeta, normalized);
    }

    // Historical unprocessed (or freshly inserted) — continue without duplicating.
    eventRow = existingRow;
  } else {
    // Claim found nothing and could not insert (should be rare); treat as no persist.
    return processWithoutPersistence(pg, env, normalized, body, signatureMeta);
  }

  // Updates must target the stored row tenant (never invent a second event).
  const storageClientSlug = (eventRow && eventRow.client_slug) || normalized.client_slug;

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
      preserve_stored_normalized: !insertedNew,
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
      executeOpenDemo: input.executeOpenDemo,
      preserve_stored_normalized: !insertedNew,
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

  const draftEnrichment = enrichDraftForStorage(draftResult, bookingWritePreview) || {};
  let normalizedForStorage;
  if (insertedNew) {
    normalizedForStorage = {
      ...normalized,
      ...draftEnrichment,
    };
  } else {
    // Historical candidate — preserve stored identity/history; authority fills
    // response/runtime only.
    normalizedForStorage = mergeNormalizedPreservingStoredIdentity(
      eventRow && eventRow.normalized,
      draftEnrichment,
    );
  }

  let updatedRow = eventRow;
  if (pg && eventRow) {
    await pg.query(
      `UPDATE guest_message_events
          SET normalized = $3::jsonb
        WHERE client_slug = $1
          AND wa_message_id = $2`,
      [
        storageClientSlug,
        normalized.wa_message_id,
        JSON.stringify(normalizedForStorage),
      ],
    ).catch(() => {});
    const updated = await updateGuestMessageEventDecisions(
      pg,
      storageClientSlug,
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
      duplicate: insertedNew ? false : !!eventRow,
      idempotent_replay: false,
      guest_message_event_id: updatedRow ? updatedRow.id : null,
      replay_history_rewritten: false,
    },
    event_row: updatedRow,
    replay: false,
  };
}

module.exports = {
  processMetaWhatsAppWebhookInbound,
  processMetaWhatsAppWebhookPostEntry,
  buildIngressAuthorityBlockedMetaResponse,
  buildResponseFromStoredEvent,
  buildSendResultFromStoredEvent,
  resolveReplayNormalizedIdentity,
};
