'use strict';

/**
 * Phase 19d — Luna guest reply send route (default-deny; no WhatsApp send in this slice).
 *
 * Validates send requests, re-checks eligibility and env gates, optionally checks bot pause.
 * Does not call WhatsApp, Stripe, n8n, or perform DB writes.
 */

const { getPauseState } = require('./staff-bot-pause-sql');

const DEFAULT_CLIENT = 'wolfhouse-somo';

const ALLOWED_SEND_KINDS = new Set(['ask_missing_field', 'show_quote', 'checkin_day']);

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

function isWhatsappDryRun(env) {
  return String((env || {}).WHATSAPP_DRY_RUN ?? 'true').trim().toLowerCase() !== 'false';
}

function collectEnvGateReasons(env) {
  const reasons = [];
  if (!isTruthyEnv(env, 'LUNA_AUTO_SEND_ENABLED')) reasons.push('luna_auto_send_not_enabled');
  if (isWhatsappDryRun(env)) reasons.push('whatsapp_dry_run_active');
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
 * @param {object} body
 * @param {object} [env]
 * @returns {{ ok: boolean, status: number, result: object }}
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

  blocked.push(...collectEnvGateReasons(env));

  const uniqueBlocked = [...new Set(blocked)];
  const envGatesClear = collectEnvGateReasons(env).length === 0;
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

  // Gates pass — WhatsApp send not implemented in Phase 19d.
  return {
    ok: true,
    status: 200,
    result: {
      success: false,
      client_slug: clientSlug,
      idempotency_key: idempotencyKey,
      send_kind: sendKind,
      to,
      auto_send_ready: true,
      blocked_reasons: ['guest_reply_whatsapp_send_not_implemented'],
      safe_next_step: 'keep_draft_or_handoff',
      ...SEND_ROUTE_SAFETY_FLAGS,
    },
  };
}

/**
 * @param {object} body
 * @param {{ pg?: object, env?: object }} [context]
 */
async function evaluateGuestReplySendRouteWithPause(body, context = {}) {
  const env = context.env || process.env;
  const evaluated = evaluateGuestReplySendRoute(body, env);
  if (evaluated.status === 400) return evaluated;

  const src = body || {};
  const to = trimStr(src.to);
  const clientSlug = trimStr(src.client_slug) || DEFAULT_CLIENT;
  const pg = context.pg;

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
          result: {
            ...evaluated.result,
            success: false,
            auto_send_ready: false,
            blocked_reasons: blocked,
            safe_next_step: resolveSafeNextStep(blocked),
            ...SEND_ROUTE_SAFETY_FLAGS,
          },
        };
      }
    } catch (_) {
      // Pause table may be absent in local/dev — do not block send evaluation on read failure.
    }
  }

  return evaluated;
}

module.exports = {
  evaluateGuestReplySendRoute,
  evaluateGuestReplySendRouteWithPause,
  ALLOWED_SEND_KINDS,
  SEND_ROUTE_SAFETY_FLAGS,
  collectEnvGateReasons,
  resolveSafeNextStep,
};
