'use strict';

/**
 * Phase 19d/19e — Luna guest reply send route (gated; WhatsApp provider when gates pass).
 */

const { randomUUID } = require('node:crypto');
const { getPauseState } = require('./staff-bot-pause-sql');
const { sendLunaWhatsAppMessage } = require('./luna-whatsapp-provider');
const {
  findGuestMessageSendByKey,
  claimGuestMessageSendPending,
  formatGuestMessageSendRow,
  SELECT_GUEST_MESSAGE_SEND_COLS,
  isMissingGuestMessageSendsTable,
} = require('./luna-guest-message-send-sql');
const {
  emitLunaSupervisorEvent,
  isFranceWolfhouseStaging,
} = require('./luna-supervisor-event-emitter');

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

function collectEnvGateReasons(env, sendKind, clientSlug) {
  const reasons = [];
  const slug = trimStr(clientSlug).toLowerCase();
  const wolfhouseConfirmation = sendKind === 'confirmation'
    && (slug === 'wolfhouse-somo' || slug === 'wolfhouse')
    && isTruthyEnv(env, 'LUNA_CONFIRMATION_AUTO_SEND_ENABLED');
  // Confirmation-only never opens quotes, check-in, or other Staff automation.
  if (wolfhouseConfirmation) return reasons;
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

  // Provider-path defense: email-channel phone namespaces must never enter
  // WhatsApp evaluation, guest_message_sends audit, or provider send.
  // (Staff Inbox route also loads authoritative conversation channel first.)
  if (to && /^(emailv1|email):/i.test(to)) {
    return {
      ok: false,
      status: 400,
      result: {
        success: false,
        error: 'email_channel_send_not_supported',
        blocked_reasons: ['email_channel_send_not_supported'],
        safe_next_step: 'keep_draft_or_handoff',
        send_kind: sendKind,
        to,
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

  blocked.push(...collectEnvGateReasons(env, sendKind, clientSlug));

  const uniqueBlocked = [...new Set(blocked)];
  const envGatesClear = collectEnvGateReasons(env, sendKind, clientSlug).length === 0;
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

function isRetryableConfirmationNonDelivery(row, sendKind) {
  if (trimStr(sendKind) !== 'confirmation') return false;
  if (!row) return false;
  if (trimStr(row.provider_message_id)) return false;
  return row.status === 'blocked' || row.status === 'failed';
}

async function reclaimConfirmationNonDelivery(pg, clientSlug, idempotencyKey) {
  try {
    const updated = await pg.query(
      `UPDATE guest_message_sends
          SET status = 'pending',
              updated_at = NOW()
        WHERE client_slug = $1
          AND idempotency_key = $2
          AND status IN ('blocked', 'failed')
          AND NULLIF(provider_message_id, '') IS NULL
        RETURNING ${SELECT_GUEST_MESSAGE_SEND_COLS}`,
      [clientSlug, idempotencyKey],
    );
    return formatGuestMessageSendRow(updated.rows[0] || null);
  } catch (err) {
    if (isMissingGuestMessageSendsTable(err)) return null;
    throw err;
  }
}

function retainedSendFailureObligations(row) {
  const stored = row && row.provider_response && typeof row.provider_response === 'object'
    ? row.provider_response : {};
  return Array.isArray(stored.luna_supervisor_event_obligations)
    ? stored.luna_supervisor_event_obligations.filter((item) => item && item.row_id && item.revision)
    : [];
}

async function drainSendFailureObligations(pg, body, result, row, context = {}, obligations = null) {
  const pending = obligations || retainedSendFailureObligations(row);
  const captures = [];
  for (const obligation of pending) {
    captures.push(await emitSendFailureSupervisorEvent(
      pg, body, result, row, context, obligation,
    ));
  }
  return {
    inserted: captures.some((capture) => capture && capture.inserted === true),
    captures,
  };
}

async function maybeReplayGuestMessageSend(
  pg, baseResult, clientSlug, idempotencyKey, sendKind, body = {}, context = {},
) {
  if (!pg || typeof pg.query !== 'function' || !idempotencyKey) return null;
  const existing = await findGuestMessageSendByKey(pg, clientSlug, idempotencyKey);
  if (existing.table_missing || !existing.row) return null;
  if (isRetryableConfirmationNonDelivery(existing.row, sendKind)) return null;
  if (existing.row.status === 'sent'
    || existing.row.status === 'pending'
    || existing.row.status === 'blocked'
    || existing.row.status === 'failed') {
    const replay = buildIdempotentReplayResult(baseResult, existing.row);
    const obligations = retainedSendFailureObligations(existing.row);
    if (obligations.length) {
      replay.supervisor_event_capture = await drainSendFailureObligations(
        pg, body, replay, existing.row, context, obligations,
      );
    }
    return replay;
  }
  return null;
}

async function recordGateAuditWithoutStealingInFlight(pg, input) {
  const payload = input || {};
  const blockedReasons = [...new Set((payload.blocked_reasons || []).filter(Boolean).map(String))];
  const params = [
    payload.client_slug,
    payload.channel || 'whatsapp',
    payload.to_phone,
    payload.idempotency_key,
    payload.send_kind,
    payload.source || null,
    payload.message_text,
    JSON.stringify(blockedReasons),
    payload.provider_response ? JSON.stringify(payload.provider_response) : null,
  ];
  try {
    const written = await pg.query(
      `INSERT INTO guest_message_sends (
         client_slug, channel, to_phone, idempotency_key, send_kind, source,
         message_text, status, blocked_reasons, provider_response
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'blocked', $8::jsonb, $9::jsonb)
       ON CONFLICT (client_slug, idempotency_key) DO UPDATE SET
         status = EXCLUDED.status,
         blocked_reasons = EXCLUDED.blocked_reasons,
         message_text = EXCLUDED.message_text,
         provider_response = COALESCE(guest_message_sends.provider_response, '{}'::jsonb)
           || COALESCE(EXCLUDED.provider_response, '{}'::jsonb),
         updated_at = NOW()
       WHERE guest_message_sends.status NOT IN ('pending', 'sent')
         AND NULLIF(BTRIM(guest_message_sends.provider_message_id), '') IS NULL
       RETURNING ${SELECT_GUEST_MESSAGE_SEND_COLS}`,
      params,
    );
    if (written.rows[0]) {
      return { row: formatGuestMessageSendRow(written.rows[0]), persisted_blocked_occurrence: true };
    }
    const existing = await findGuestMessageSendByKey(
      pg,
      payload.client_slug,
      payload.idempotency_key,
    );
    return { row: existing.row || null };
  } catch (err) {
    if (isMissingGuestMessageSendsTable(err)) return { row: null, table_missing: true };
    throw err;
  }
}

async function emitSendFailureSupervisorEvent(pg, body, result, auditRow, context = {}, obligation = null) {
  if (!auditRow || !auditRow.id || (!auditRow.updated_at && !obligation)) {
    return { inserted: false, error: 'supervisor_event_source_row_required' };
  }
  const capture = await emitLunaSupervisorEvent(pg, {
    ...(obligation || {}),
    kind: 'luna_send_failed',
    client_slug: result.client_slug,
    row_id: (obligation && obligation.row_id) || auditRow.id,
    revision: (obligation && obligation.revision)
      || (auditRow.updated_at instanceof Date ? auditRow.updated_at.toISOString() : auditRow.updated_at),
    guest_phone: result.to,
    send_kind: result.send_kind,
    blocked_reasons: (obligation && obligation.blocked_reasons) || result.blocked_reasons,
    provider_error: (obligation && obligation.provider_error) || result.provider_error,
    failure_stage: (obligation && obligation.failure_stage)
      || (result.provider_error ? 'provider' : 'send_route'),
    booking_id: (obligation && obligation.booking_id) || body.booking_id,
    booking_code: (obligation && obligation.booking_code) || body.booking_code || body.booking_ref,
    cause_incident_id: (obligation && obligation.cause_incident_id)
      || context.incident_id || null,
    metadata: { source_send_row_id: auditRow.id },
  }, { env: context.env || process.env });
  if (obligation && capture
      && (capture.inserted === true || (capture.inserted === false && capture.row))) {
    try {
      await pg.query(
        `UPDATE guest_message_sends
            SET provider_response = jsonb_set(
              COALESCE(provider_response, '{}'::jsonb),
              '{luna_supervisor_event_obligations}',
              COALESCE((SELECT jsonb_agg(item)
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(
                  COALESCE(provider_response, '{}'::jsonb)
                  -> 'luna_supervisor_event_obligations') = 'array'
                  THEN COALESCE(provider_response, '{}'::jsonb)
                    -> 'luna_supervisor_event_obligations' ELSE '[]'::jsonb END) item
               WHERE item->>'row_id' IS DISTINCT FROM $2), '[]'::jsonb), true)
          WHERE id = $1::uuid`,
        [auditRow.id, obligation.row_id],
      );
    } catch (_) { /* retained obligation remains retry-safe */ }
  }
  return capture;
}

async function persistRouteBlockedSend(pg, body, result, context = {}) {
  if (!pg || typeof pg.query !== 'function') return result;
  const blockedReasons = result.blocked_reasons || [];
  if (!blockedReasons.length) return result;
  const recorded = await recordGateAuditWithoutStealingInFlight(pg, {
    client_slug: result.client_slug,
    to_phone: result.to,
    idempotency_key: result.idempotency_key,
    send_kind: result.send_kind,
    source: trimStr(body.source) || null,
    message_text: trimStr(body.suggested_reply),
    blocked_reasons: blockedReasons,
  });
  if (!recorded.row) return result;
  const blockedResult = buildBlockedRouteResult(result, recorded.row);
  const retained = retainedSendFailureObligations(recorded.row);
  const retainedCapture = retained.length
    ? await drainSendFailureObligations(pg, body, blockedResult, recorded.row, context, retained)
    : null;
  const currentCapture = recorded.persisted_blocked_occurrence === true
    ? await emitSendFailureSupervisorEvent(pg, body, blockedResult, recorded.row, context)
    : { inserted: false, skipped: 'competing_in_flight_or_sent_occurrence' };
  blockedResult.supervisor_event_capture = retainedCapture
    ? { inserted: retainedCapture.inserted || currentCapture.inserted === true,
      captures: [...retainedCapture.captures, currentCapture] }
    : currentCapture;
  return blockedResult;
}

async function persistProviderOutcome(
  pg, rowId, providerResult, blockedReasons, body = {}, priorRow = null, context = {},
) {
  if (!pg || !rowId) return null;
  const retainedBeforeWrite = retainedSendFailureObligations(priorRow);
  const captureEnabled = isFranceWolfhouseStaging(
    trimStr(body.client_slug) || DEFAULT_CLIENT,
    context.env || process.env,
  );
  const bookingIdentity = {
    booking_id: trimStr(body.booking_id) || null,
    booking_code: trimStr(body.booking_code || body.booking_ref) || null,
  };
  if (providerResult.success === true) {
    const updated = await pg.query(
      `UPDATE guest_message_sends
          SET status = 'sent',
              blocked_reasons = '[]'::jsonb,
              provider_message_id = $2,
              provider_response = COALESCE(provider_response, '{}'::jsonb)
                || COALESCE($3::jsonb, '{}'::jsonb)
                || jsonb_strip_nulls(jsonb_build_object(
                  'booking_id', $4::text, 'booking_code', $5::text)),
              sent_at = NOW(),
              updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING ${SELECT_GUEST_MESSAGE_SEND_COLS}`,
      [rowId, trimStr(providerResult.whatsapp_message_id), JSON.stringify(providerResult || {}),
        bookingIdentity.booking_id, bookingIdentity.booking_code],
    );
    const row = formatGuestMessageSendRow(updated.rows[0] || null);
    return { row, obligation: null,
      obligations: retainedSendFailureObligations(row).length
        ? retainedSendFailureObligations(row) : retainedBeforeWrite };
  }
  const obligation = captureEnabled ? {
    kind: 'luna_send_failed',
    row_id: randomUUID(),
    revision: new Date().toISOString(),
    blocked_reasons: [...new Set((blockedReasons || []).map(String))],
    provider_error: providerResult.provider_error || null,
    failure_stage: providerResult.provider_error ? 'provider' : 'send_route',
    ...bookingIdentity,
    cause_incident_id: context.incident_id || null,
  } : null;
  const updated = await pg.query(
    `UPDATE guest_message_sends
        SET status = 'blocked',
            blocked_reasons = $2::jsonb,
            provider_response = COALESCE(provider_response, '{}'::jsonb)
              || COALESCE($3::jsonb, '{}'::jsonb)
              || jsonb_strip_nulls(jsonb_build_object(
                'booking_id', $4::text,
                'booking_code', $5::text,
                'luna_supervisor_event_obligations',
                CASE WHEN $6::jsonb IS NULL THEN
                  CASE
                    WHEN jsonb_typeof(COALESCE(provider_response, '{}'::jsonb)
                      -> 'luna_supervisor_event_obligations') = 'array'
                    THEN COALESCE(provider_response, '{}'::jsonb)
                      -> 'luna_supervisor_event_obligations'
                    ELSE '[]'::jsonb
                  END
                ELSE
                  CASE
                    WHEN jsonb_typeof(COALESCE(provider_response, '{}'::jsonb)
                      -> 'luna_supervisor_event_obligations') = 'array'
                    THEN COALESCE(provider_response, '{}'::jsonb)
                      -> 'luna_supervisor_event_obligations'
                    ELSE '[]'::jsonb
                  END || jsonb_build_array($6::jsonb)
                END
              )),
            updated_at = NOW()
      WHERE id = $1::uuid
      RETURNING ${SELECT_GUEST_MESSAGE_SEND_COLS}`,
    [rowId, JSON.stringify([...new Set((blockedReasons || []).map(String))]), JSON.stringify(providerResult || {}),
      bookingIdentity.booking_id, bookingIdentity.booking_code,
      obligation ? JSON.stringify(obligation) : null],
  );
  const row = formatGuestMessageSendRow(updated.rows[0] || null);
  const stored = row && row.provider_response && typeof row.provider_response === 'object'
    ? row.provider_response : {};
  const obligations = Array.isArray(stored.luna_supervisor_event_obligations)
    ? stored.luna_supervisor_event_obligations : [obligation];
  return { row, obligation, obligations };
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
    const replay = await maybeReplayGuestMessageSend(
      pg,
      evaluated.result,
      clientSlug,
      idempotencyKey,
      trimStr(src.send_kind),
      body,
      context,
    );
    if (replay) {
      return { ok: true, status: 200, result: replay };
    }
  }

  if (pg && to && typeof pg.query === 'function') {
    try {
      const pauseState = await getPauseState(pg, { client_slug: clientSlug, guest_phone: to });
      if (pauseState.row && pauseState.row.paused === true) {
        const trusted = context.supervisor;
        const pausedBy = String(pauseState.row.paused_by || '').toLowerCase();
        const staffOwned = pausedBy.includes('staff');
        const meta = pauseState.row.metadata && typeof pauseState.row.metadata === 'object'
          ? pauseState.row.metadata
          : {};
        const tid = meta.needs_human_transition_id || meta.luna_handoff_transition_id;
        const permit = trusted && trusted.pause_permit_transition_id;
        const lunaPermit = !staffOwned && permit && tid && String(tid) === String(permit);
        if (!lunaPermit) {
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
            }, context),
          };
        }
      }
    } catch (_) {
      // Pause table may be absent in local/dev — do not block send evaluation on read failure.
    }
  }

  if (!evaluated.provider_pending) {
    if (pg && idempotencyKey) {
      const blockedResult = await persistRouteBlockedSend(pg, body, evaluated.result, context);
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
      if (isRetryableConfirmationNonDelivery(claim.row, evaluated.result.send_kind)) {
        const reclaimed = await reclaimConfirmationNonDelivery(
          pg,
          evaluated.result.client_slug,
          evaluated.result.idempotency_key,
        );
        if (!reclaimed) {
          const again = await findGuestMessageSendByKey(
            pg,
            evaluated.result.client_slug,
            evaluated.result.idempotency_key,
          );
          if (again.row) {
            return {
              ok: true,
              status: 200,
              result: buildIdempotentReplayResult(evaluated.result, again.row),
            };
          }
        }
        pendingRow = reclaimed;
      } else {
        return {
          ok: true,
          status: 200,
          result: buildIdempotentReplayResult(evaluated.result, claim.row),
        };
      }
    } else {
      pendingRow = claim.row;
    }
  }

  const providerResult = await sendLunaWhatsAppMessage({
    to: evaluated.result.to,
    message: trimStr(src.suggested_reply),
    client_slug: evaluated.result.client_slug,
    idempotency_key: evaluated.result.idempotency_key,
  }, env, context);

  const merged = mergeProviderResult(evaluated.result, providerResult);
  if (pg && pendingRow && pendingRow.id) {
    const persisted = await persistProviderOutcome(
      pg,
      pendingRow.id,
      providerResult,
      merged.blocked_reasons,
      body,
      pendingRow,
      context,
    );
    const auditRow = persisted && persisted.row;
    if (auditRow) {
      merged.no_write_performed = false;
      Object.assign(merged, buildSendAuditFields(auditRow));
      const obligations = persisted.obligations || [];
      if (obligations.length) {
        merged.supervisor_event_capture = await drainSendFailureObligations(
          pg, body, merged, auditRow, context, obligations,
        );
      }
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
