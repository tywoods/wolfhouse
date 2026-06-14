'use strict';

/**
 * Phase 25c — Owner/operator WhatsApp → Command Center (Staff Ask Luna) routing.
 *
 * Read-only answers; no guest booking draft, preview, payment, or handoff side effects.
 */

const { lookupStaffPhoneAccess } = require('./staff-phone-access');
const { executeStaffAskLunaQuestion } = require('./staff-ask-luna-execute');
const { planAndExecuteOwnerSqlQuestion } = require('./owner-sql-plan-execute');
const { evaluateGuestReplySendRouteWithPause } = require('./luna-guest-reply-send-route');
const {
  buildMetaWhatsAppWebhookPostResponse,
  buildMetaInboundIdempotencyKey,
} = require('./luna-meta-whatsapp-webhook');
const {
  buildDecisionPatch,
  updateGuestMessageEventDecisions,
} = require('./luna-guest-message-events-sql');

const OWNER_SEND_KIND = 'staff_reply';
const OWNER_NEXT_ACTION = 'owner_command_center_reply';

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function buildOwnerRouteFlags(staffAccess) {
  return {
    staff_phone_access: true,
    staff_role: staffAccess.role,
    owner_luna_route: true,
    guest_flow_skipped: true,
  };
}

function enrichNormalizedForOwnerRoute(normalized, staffAccess, extras = {}) {
  return {
    ...normalized,
    ...buildOwnerRouteFlags(staffAccess),
    ...extras,
  };
}

function buildOwnerDraftFromAskLuna(askResult) {
  const answer = trimStr(askResult && askResult.answer);
  return {
    suggested_reply: answer,
    next_action: OWNER_NEXT_ACTION,
    send_eligibility: {
      requires_staff: false,
      send_allowed_later: true,
      auto_send_ready: true,
      allowed_send_kind: OWNER_SEND_KIND,
    },
    extraction: null,
    command_center: {
      intent: askResult ? askResult.intent : null,
      category: askResult ? askResult.category : null,
      row_count: askResult ? askResult.row_count : 0,
      read_only: true,
      owner_sql: askResult ? askResult.owner_sql === true : false,
      planner_source: askResult ? askResult.planner_source || null : null,
      answer_format_source: askResult ? askResult.answer_format_source || null : null,
    },
  };
}

function buildOwnerSendBody(normalized, draft) {
  const idempotencyKey = buildMetaInboundIdempotencyKey(
    normalized.client_slug,
    normalized.wa_message_id,
    OWNER_SEND_KIND,
  );
  return {
    client_slug: normalized.client_slug,
    to: normalized.from,
    suggested_reply: draft.suggested_reply,
    send_kind: OWNER_SEND_KIND,
    send_eligibility: draft.send_eligibility,
    idempotency_key: idempotencyKey,
    source: 'owner_whatsapp_command_center',
    draft,
  };
}

function buildOwnerWebhookResponse(normalized, signatureMeta, options = {}) {
  const draft = options.draft || null;
  const staffAccess = options.staff_access || {};
  const askResult = options.ask_result || null;
  const base = buildMetaWhatsAppWebhookPostResponse(normalized, signatureMeta, {
    draft,
    draft_called: options.draft_called === true,
    send_attempted: options.send_attempted === true,
    send_result: options.send_result || null,
    idempotency_key: options.idempotency_key || null,
    booking_write_preview: null,
    event_persisted: options.event_persisted === true,
  });

  return {
    ...base,
    ...buildOwnerRouteFlags(staffAccess),
    guest_flow_skipped: true,
    command_center: askResult ? {
      intent: askResult.intent,
      category: askResult.category || null,
      answer: askResult.answer,
      row_count: askResult.row_count,
      read_only: true,
      no_write_performed: true,
    } : null,
    duplicate: options.duplicate === true,
    idempotent_replay: options.idempotent_replay === true,
    guest_message_event_id: options.guest_message_event_id || null,
  };
}

function buildOwnerResponseFromStoredEvent(row, signatureMeta, replayMeta = {}) {
  const normalized = enrichNormalizedForOwnerRoute(
    row.normalized || {},
    {
      role: (row.normalized && row.normalized.staff_role) || 'owner',
    },
  );
  const draft = row.draft_called ? {
    suggested_reply: row.suggested_reply,
    next_action: row.next_action,
    send_eligibility: normalized.send_eligibility || null,
    command_center: normalized.command_center || null,
  } : null;

  let sendResult = null;
  if (row.send_attempted === true) {
    const blockedReasons = Array.isArray(row.send_blocked_reasons) ? row.send_blocked_reasons : [];
    const sendPerformed = row.send_status === 'sent';
    sendResult = {
      send_performed: sendPerformed,
      sends_whatsapp: sendPerformed,
      no_write_performed: row.send_status === 'blocked' ? false : !sendPerformed,
      blocked_reasons: blockedReasons,
      guest_message_send_status: row.send_status,
      duplicate: replayMeta.duplicate === true,
    };
  }

  const askResult = normalized.command_center ? {
    intent: normalized.command_center_intent || normalized.command_center.intent,
    category: normalized.command_center.category,
    answer: row.suggested_reply,
    row_count: normalized.command_center.row_count,
  } : null;

  return buildOwnerWebhookResponse(normalized, signatureMeta, {
    draft,
    draft_called: row.draft_called === true,
    send_attempted: row.send_attempted === true,
    send_result: sendResult,
    idempotency_key: row.send_idempotency_key,
    staff_access: { role: normalized.staff_role },
    ask_result: askResult,
    event_persisted: true,
    duplicate: replayMeta.duplicate === true,
    idempotent_replay: replayMeta.idempotent_replay === true,
    guest_message_event_id: row.id,
  });
}

function isOwnerLunaStoredEvent(row) {
  const norm = row && row.normalized;
  return !!(norm && norm.owner_luna_route === true);
}

function buildAskLunaFromOwnerPlanExecute(peResult) {
  const templateId = peResult.plan && peResult.plan.template_id;
  const intent = templateId ? `owner_sql.${templateId}` : 'owner_sql.custom';
  return {
    success: true,
    intent,
    category: 'owner_bi',
    answer: trimStr(peResult.answer),
    row_count: peResult.row_count ?? peResult.execution?.row_count ?? 0,
    read_only: true,
    no_write_performed: true,
    answer_format_source: peResult.answer_format_source || 'deterministic',
    planner_source: peResult.planner_source || null,
    owner_sql: true,
  };
}

async function tryOwnerSqlPlanExecuteRoute(pg, env, normalized, question, aiCaller) {
  const peResult = await planAndExecuteOwnerSqlQuestion(pg, {
    client_slug: normalized.client_slug,
    question,
    role: 'owner',
    maxRows: 50,
    timeoutMs: 3000,
    env,
    aiCaller,
  });

  if (peResult.success === true && trimStr(peResult.answer)) {
    return { used: true, askResult: buildAskLunaFromOwnerPlanExecute(peResult), peResult };
  }

  return { used: false, peResult };
}

async function runOwnerCommandCenterCore(pg, env, normalized, staffAccess, opts = {}) {
  const question = trimStr(normalized.message_text);
  let askResult;
  if (!normalized.supported || !question) {
    askResult = {
      success: true,
      intent: 'unsupported_message_type',
      answer: 'Command Center accepts text questions only. Try: "Who hasn\'t settled up yet?"',
      row_count: 0,
      read_only: true,
      no_write_performed: true,
    };
  } else {
    const planRoute = await tryOwnerSqlPlanExecuteRoute(pg, env, normalized, question, opts.aiCaller);
    if (planRoute.used) {
      askResult = planRoute.askResult;
    } else {
      askResult = await executeStaffAskLunaQuestion({
        client_slug: normalized.client_slug,
        question,
        source: 'owner_whatsapp',
        staff_access: `staff_phone_access:${staffAccess.role}`,
      }, { pg, env });
      if (!askResult.success) {
        askResult = {
          success: true,
          intent: 'query_error',
          answer: 'Command Center could not run that query right now. Please try again shortly.',
          row_count: 0,
          read_only: true,
          no_write_performed: true,
        };
      }
    }
  }

  const draft = buildOwnerDraftFromAskLuna(askResult);
  let sendAttempted = false;
  let sendResult = null;
  let idempotencyKey = null;

  if (trimStr(draft.suggested_reply) && trimStr(normalized.from)) {
    const sendBody = buildOwnerSendBody(normalized, draft);
    idempotencyKey = sendBody.idempotency_key;
    sendAttempted = true;
    const evaluated = await evaluateGuestReplySendRouteWithPause(sendBody, { pg, env });
    sendResult = evaluated.result;
  }

  return {
    askResult,
    draft,
    draftCalled: true,
    sendAttempted,
    sendResult,
    idempotencyKey,
  };
}

/**
 * Process allowlisted owner/operator inbound with guest_message_events persistence.
 */
async function processOwnerWhatsAppCommandCenterInbound(input) {
  const pg = input.pg;
  const env = input.env || process.env;
  const normalized = input.normalized;
  const signatureMeta = input.signatureMeta || {};
  const staffAccess = input.staff_access;
  const eventRow = input.event_row;

  const ran = await runOwnerCommandCenterCore(pg, env, normalized, staffAccess);

  const normalizedForStorage = enrichNormalizedForOwnerRoute(normalized, staffAccess, {
    command_center_intent: ran.askResult.intent,
    command_center: ran.draft.command_center,
    send_eligibility: ran.draft.send_eligibility,
  });

  const decisionPatch = buildDecisionPatch({
    draft: ran.draft,
    draft_called: ran.draftCalled,
    send_attempted: ran.sendAttempted,
    send_idempotency_key: ran.idempotencyKey,
    send_result: ran.sendResult,
    handoff_required: false,
  });

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

  const responseNormalized = enrichNormalizedForOwnerRoute(normalized, staffAccess, {
    command_center_intent: ran.askResult.intent,
  });

  const response = buildOwnerWebhookResponse(responseNormalized, signatureMeta, {
    draft: ran.draft,
    draft_called: ran.draftCalled,
    send_attempted: ran.sendAttempted,
    send_result: ran.sendResult,
    idempotency_key: ran.idempotencyKey,
    staff_access: staffAccess,
    ask_result: ran.askResult,
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

async function processOwnerWhatsAppCommandCenterWithoutPersistence(input) {
  const pg = input.pg;
  const env = input.env || process.env;
  const normalized = input.normalized;
  const signatureMeta = input.signatureMeta || {};
  const staffAccess = input.staff_access;

  const ran = await runOwnerCommandCenterCore(pg, env, normalized, staffAccess);
  const responseNormalized = enrichNormalizedForOwnerRoute(normalized, staffAccess, {
    command_center_intent: ran.askResult.intent,
  });

  const response = buildOwnerWebhookResponse(responseNormalized, signatureMeta, {
    draft: ran.draft,
    draft_called: ran.draftCalled,
    send_attempted: ran.sendAttempted,
    send_result: ran.sendResult,
    idempotency_key: ran.idempotencyKey,
    staff_access: staffAccess,
    ask_result: ran.askResult,
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

module.exports = {
  lookupStaffPhoneAccess,
  buildOwnerRouteFlags,
  isOwnerLunaStoredEvent,
  buildOwnerResponseFromStoredEvent,
  processOwnerWhatsAppCommandCenterInbound,
  processOwnerWhatsAppCommandCenterWithoutPersistence,
  tryOwnerSqlPlanExecuteRoute,
  buildAskLunaFromOwnerPlanExecute,
  runOwnerCommandCenterCore,
  OWNER_SEND_KIND,
  OWNER_NEXT_ACTION,
};
