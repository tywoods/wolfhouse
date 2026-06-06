'use strict';

/**
 * Phase 19d/19e — Luna guest reply send route (gated; WhatsApp provider when gates pass).
 */

const { getPauseState } = require('./staff-bot-pause-sql');
const { sendLunaWhatsAppMessage } = require('./luna-whatsapp-provider');
const {
  findGuestMessageSendByKey,
  claimGuestMessageSendPending,
  recordGuestMessageSendBlocked,
  finalizeGuestMessageSendSent,
  finalizeGuestMessageSendBlocked,
} = require('./luna-guest-message-send-sql');

const DEFAULT_CLIENT = 'wolfhouse-somo';

const ALLOWED_SEND_KINDS = new Set(['ask_missing_field', 'show_quote', 'checkin_day', 'confirmation', 'staff_reply']);

const SEND_ROUTE_SAFETY_FLAGS = Object.freeze({
  send_performed:               false,
  sends_whatsapp:               false,
  would_send_whatsapp:          false,
  no_write_performed:           true,
  creates_booking:              false,
  creates_payment:              false,
  creates_stripe_link:          false,
  calls_n8n:                    false,
  updates_confirmation_sent_at: false,
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function isTruthyEnv(env, key) {
  return String((env || {})[key] || '').trim().toLowerCase() === 'true';
}

function collectEnvGateReasons(env, sendKind) {
  const reasons = [];
  // Staff Inbox explicit send bypasses Luna auto-send gate; provider/env gates still apply.
  if (sendKind !== 'staff_reply' && !isTruthyEnv(env, 'LUNA_AUTO_SEND_ENABLED')) {
    reasons.push('luna_auto_send_not_enabled');
  }
  return reasons;
}

function resolveSafeNextStep(blockedReasons) {
  const blocked = blockedReasons || [];
  if (blocked.includes('requires_staff')
    || blocked.includes('send_not_allowed_later')
    || blocked.some((r) => String(r).startsWith('risky_') || r === 'handoff_required')) {
    return 'handoff_to_staff';
  }
  return 'keep_draft_or_handoff';
}

/**
 * Gate + validation evaluation (sync). Provider invoked separately when provider_pending.
 *
 * @param {object} body
 * @param {object} [env]
 * @returns {{ ok: boolean, status: number, result: object, provider_pending?: boolean }}
 */
function evaluateGuestReplySendRoute(body, env = process.env) {
  const src = body || {};
  const se = src.send_eligibility || {};
  const blocked = [];

  const clientSlug = trimStr(src.client_slug) || DEFAULT_CLIENT;
  const idempotencyKey = trimStr(src.idempotency_key);
  const suggestedReply = trimStr(src.suggested_reply);
  const sendKind = trimStr(src.send_kind);
  const to = trimStr(src.to);

  if (!idempotencyKey) {
    return {
      ok: false,
      status: 400,
      result: {
        success: false,
        error: 'idempotency_key_required',
        blocked_reasons: ['idempotency_key_required'],
        safe_next_step: 'keep_draft_or_handoff',
        ...SEND_ROUTE_SAFETY_FLAGS,
      },
    };
  }

  if (!suggestedReply) {
    return {
      ok: false,
      status: 400,
      result: {
        success: false,
        error: 'suggested_reply_required',
        blocked_reasons: ['suggested_reply_required'],
        safe_next_step: 'keep_draft_or_handoff',
        ...SEND_ROUTE_SAFETY_FLAGS,
      },
    };
  }

  if (!sendKind || !ALLOWED_SEND_KINDS.has(sendKind)) {
    return {
      ok: false,
      status: 400,
      result: {
        success: false,
        error: 'unsupported_send_kind',
        blocked_reasons: ['unsupported_send_kind'],
        safe_next_step: 'keep_draft_or_handoff',
        send_kind: sendKind || null,
        ...SEND_ROUTE_SAFETY_FLAGS,
      },
    };
  }

  if (!to) blocked.push('to_required');

  if (se.requires_staff === true) blocked.push('requires_staff');
  if (se.send_allowed_later === false) blocked.push('send_not_allowed_later');

  if (Object.prototype.hasOwnProperty.call(se, 'auto_send_ready') && se.auto_send_ready === false) {
    blocked.push('auto_send_not_ready');
  }

  const draft = src.draft || {};
  if (draft.creates_booking) blocked.push('draft_creates_booking');
  if (draft.creates_payment) blocked.push('draft_creates_payment');
  if (draft.creates_stripe_link) blocked.push('draft_creates_stripe_link');
  if (draft.sends_whatsapp) blocked.push('draft_marks_send');

  blocked.push(...collectEnvGateReasons(env, sendKind));

  const uniqueBlocked = [...new Set(blocked)];
  const envGatesClear = collectEnvGateReasons(env, sendKind).length === 0;
  const eligibilityClear = !uniqueBlocked.includes('requires_staff')
    && !uniqueBlocked.includes('send_not_allowed_later')
    && !uniqueBlocked.includes('auto_send_not_ready')
    && !uniqueBlocked.includes('to_required')
    && !uniqueBlocked.some((r) => r.startsWith('draft_'));

  const autoSendReady = envGatesClear && eligibilityClear;

  if (!autoSendReady) {
    return {
      ok: true,
      status: 200,
      result: {
        success: false,
        client_slug: clientSlug,
        idempotency_key: idempotencyKey,
        send_kind: sendKind,
        to,
        auto_send_ready: false,
        blocked_reasons: uniqueBlocked,
        safe_next_step: resolveSafeNextStep(uniqueBlocked),
        ...SEND_ROUTE_SAFETY_FLAGS,
      },
    };
  }

  return {
    ok: true,
    status: 200,
    provider_pending: true,
    result: {
      success: false,
      client_slug: clientSlug,
      idempotency_key: idempotencyKey,
      send_kind: sendKind,
      to,
      auto_send_ready: true,
      blocked_reasons: [],
      safe_next_step: 'keep_draft_or_handoff',
      ...SEND_ROUTE_SAFETY_FLAGS,
      would_send_whatsapp: true,
    },
  };
}

function mergeProviderResult(baseResult, providerResult) {
  if (providerResult.success === true) {
    return {
      ...baseResult,
      success: true,
      send_performed: true,
      sends_whatsapp: true,
      would_send_whatsapp: true,
      no_write_performed: true,
      creates_booking: false,
      creates_payment: false,
      creates_stripe_link: false,
      calls_n8n: false,
      updates_confirmation_sent_at: false,
      blocked_reasons: [],
      safe_next_step: null,
      whatsapp_message_id: providerResult.whatsapp_message_id || null,
      provider: providerResult.provider || 'whatsapp',
    };
  }

  const blockedReason = providerResult.blocked_reason || 'whatsapp_send_failed';
  return {
    ...baseResult,
    success: false,
    send_performed: false,
    sends_whatsapp: false,
    would_send_whatsapp: baseResult.would_send_whatsapp === true || providerResult.would_send_whatsapp === true,
    blocked_reasons: [...new Set([...(baseResult.blocked_reasons || []), blockedReason])],
    safe_next_step: resolveSafeNextStep([blockedReason]),
    provider: providerResult.provider || null,
    provider_error: providerResult.provider_error || null,
  };
}

function buildSendAuditFields(row, extra = {}) {
  if (!row) return { ...extra };
  return {
    guest_message_send_id: row.id,
    guest_message_send_status: row.status,
    guest_message_send_recorded: true,
    ...extra,
  };
}

function buildIdempotentReplayResult(baseResult, row, { duplicate = true } = {}) {
  const blockedReasons = Array.isArray(row.blocked_reasons) ? row.blocked_reasons : [];
  const wasSent = row.status === 'sent';
  return {
    ...baseResult,
    success: wasSent,
    send_performed: false,
    sends_whatsapp: false,
    would_send_whatsapp: false,
    duplicate: duplicate === true,
    idempotent_replay: true,
    blocked_reasons: wasSent ? [] : blockedReasons,
    safe_next_step: wasSent ? null : resolveSafeNextStep(blockedReasons),
    whatsapp_message_id: row.provider_message_id || null,
    no_write_performed: false,
    creates_booking: false,
    creates_payment: false,
    creates_stripe_link: false,
    calls_n8n: false,
    updates_confirmation_sent_at: false,
    ...buildSendAuditFields(row),
  };
}

function buildBlockedRouteResult(baseResult, row) {
  return {
    ...baseResult,
    no_write_performed: false,
    ...buildSendAuditFields(row),
  };
}

async function maybeReplayGuestMessageSend(pg, baseResult, clientSlug, idempotencyKey) {
  if (!pg || typeof pg.query !== 'function' || !idempotencyKey) return null;
  const existing = await findGuestMessageSendByKey(pg, clientSlug, idempotencyKey);
  if (existing.table_missing || !existing.row) return null;
  if (existing.row.status === 'sent'
    || existing.row.status === 'pending'
    || existing.row.status === 'blocked'
    || existing.row.status === 'failed') {
    return buildIdempotentReplayResult(baseResult, existing.row);
  }
  return null;
}

async function persistRouteBlockedSend(pg, body, result) {
  if (!pg || typeof pg.query !== 'function') return result;
  const blockedReasons = result.blocked_reasons || [];
  if (!blockedReasons.length) return result;
  const recorded = await recordGuestMessageSendBlocked(pg, {
    client_slug: result.client_slug,
    to_phone: result.to,
    idempotency_key: result.idempotency_key,
    send_kind: result.send_kind,
    source: trimStr(body.source) || null,
    message_text: trimStr(body.suggested_reply),
    blocked_reasons: blockedReasons,
  });
  if (!recorded.row) return result;
  return buildBlockedRouteResult(result, recorded.row);
}

async function persistProviderOutcome(pg, rowId, providerResult, blockedReasons) {
  if (!pg || !rowId) return null;
  if (providerResult.success === true) {
    const out = await finalizeGuestMessageSendSent(
      pg,
      rowId,
      providerResult.whatsapp_message_id,
      providerResult,
    );
    return out.row;
  }
  const out = await finalizeGuestMessageSendBlocked(
    pg,
    rowId,
    blockedReasons,
    providerResult,
  );
  return out.row;
}

/**
 * @param {object} body
 * @param {{ pg?: object, env?: object, sendMessage?: Function, fetch?: Function }} [context]
 */
async function evaluateGuestReplySendRouteWithPause(body, context = {}) {
  const env = context.env || process.env;
  const evaluated = evaluateGuestReplySendRoute(body, env);
  if (evaluated.status === 400) return evaluated;

  const src = body || {};
  const to = trimStr(src.to);
  const clientSlug = trimStr(src.client_slug) || DEFAULT_CLIENT;
  const idempotencyKey = trimStr(src.idempotency_key);
  const pg = context.pg;

  if (pg && idempotencyKey) {
    const replay = await maybeReplayGuestMessageSend(pg, evaluated.result, clientSlug, idempotencyKey);
    if (replay) {
      return { ok: true, status: 200, result: replay };
    }
  }

  if (pg && to && typeof pg.query === 'function') {
    try {
      const pauseState = await getPauseState(pg, { client_slug: clientSlug, guest_phone: to });
      if (pauseState.row && pauseState.row.paused === true) {
        const blocked = [...new Set([
          ...(evaluated.result.blocked_reasons || []),
          'gate_bot_paused',
        ])];
        return {
          ok: true,
          status: 200,
          result: await persistRouteBlockedSend(pg, body, {
            ...evaluated.result,
            success: false,
            auto_send_ready: false,
            blocked_reasons: blocked,
            safe_next_step: resolveSafeNextStep(blocked),
            ...SEND_ROUTE_SAFETY_FLAGS,
          }),
        };
      }
    } catch (_) {
      // Pause table may be absent in local/dev — do not block send evaluation on read failure.
    }
  }

  if (!evaluated.provider_pending) {
    if (pg && idempotencyKey) {
      const blockedResult = await persistRouteBlockedSend(pg, body, evaluated.result);
      return { ok: true, status: 200, result: blockedResult };
    }
    return evaluated;
  }

  let pendingRow = null;
  if (pg && idempotencyKey) {
    const claim = await claimGuestMessageSendPending(pg, {
      client_slug: evaluated.result.client_slug,
      to_phone: evaluated.result.to,
      idempotency_key: evaluated.result.idempotency_key,
      send_kind: evaluated.result.send_kind,
      source: trimStr(src.source) || null,
      message_text: trimStr(src.suggested_reply),
    });
    if (claim.row && !claim.claimed) {
      return {
        ok: true,
        status: 200,
        result: buildIdempotentReplayResult(evaluated.result, claim.row),
      };
    }
    pendingRow = claim.row;
  }

  const providerResult = await sendLunaWhatsAppMessage({
    to: evaluated.result.to,
    message: trimStr(src.suggested_reply),
    client_slug: evaluated.result.client_slug,
    idempotency_key: evaluated.result.idempotency_key,
  }, env, context);

  const merged = mergeProviderResult(evaluated.result, providerResult);
  if (pg && pendingRow && pendingRow.id) {
    const auditRow = await persistProviderOutcome(
      pg,
      pendingRow.id,
      providerResult,
      merged.blocked_reasons,
    );
    if (auditRow) {
      merged.no_write_performed = false;
      Object.assign(merged, buildSendAuditFields(auditRow));
    }
  }

  return {
    ok: true,
    status: 200,
    result: merged,
  };
}

module.exports = {
  evaluateGuestReplySendRoute,
  evaluateGuestReplySendRouteWithPause,
  mergeProviderResult,
  buildIdempotentReplayResult,
  ALLOWED_SEND_KINDS,
  SEND_ROUTE_SAFETY_FLAGS,
  collectEnvGateReasons,
  resolveSafeNextStep,
};
