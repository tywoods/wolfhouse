'use strict';

const { isProductionStaffRuntime } = require('./staff-runtime-role');
const { sourceKey, captureSupervisorEvent } = require('./staff-supervisor-events');
const { createPgSupervisorStore } = require('./staff-supervisor-routes');

const ENVIRONMENT = 'france-wolfhouse-staging';
const RUNTIME = 'luna';
const WOLFHOUSE = 'wolfhouse-somo';

function trimStr(value) {
  return value == null ? '' : String(value).trim();
}

function isFranceWolfhouseStaging(clientSlug, env = process.env) {
  const e = env || {};
  if (trimStr(clientSlug).toLowerCase() !== WOLFHOUSE) return false;
  if (trimStr(e.NODE_ENV).toLowerCase() !== 'staging') return false;
  if (trimStr(e.SUPERVISOR_EVENT_SOURCE_ENVIRONMENT).toLowerCase() !== ENVIRONMENT) return false;
  const tenant = trimStr(e.STAFF_API_INGRESS_TENANT_SLUG || e.DEFAULT_CLIENT_SLUG).toLowerCase();
  if (tenant !== WOLFHOUSE) return false;
  if (isProductionStaffRuntime(e, '')) return false;
  const deploymentSignals = [
    e.WOLFHOUSE_DATABASE_URL,
    e.DATABASE_URL,
    e.PUBLIC_PAYMENT_BASE_URL,
    e.STAFF_PUBLIC_BASE_URL,
  ].map((value) => trimStr(value).toLowerCase()).filter(Boolean);
  if (deploymentSignals.some((value) => /(^|[_.:/-])prod(?:uction)?([_.:/-]|$)/.test(value))) return false;
  return true;
}

function uniqueReasons(input) {
  const reasons = Array.isArray(input.blocked_reasons) ? input.blocked_reasons : [];
  return [...new Set(reasons.map(trimStr).filter(Boolean))];
}

function sanitizeProviderCause(value) {
  let cause = trimStr(value);
  if (!cause) return '';
  cause = cause
    .replace(/\b(token|secret|password|authorization|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/\b(?:sk|pk|whsec)_[A-Za-z0-9_-]+\b/g, '[credential]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone]');
  return cause.slice(0, 240);
}

function sanitizeReason(input) {
  const direct = sanitizeProviderCause(input.reason);
  const reasons = uniqueReasons(input);
  const stage = trimStr(input.failure_stage);
  const providerCause = sanitizeProviderCause(input.provider_error);
  const parts = [];
  if (direct) parts.push(direct);
  if (reasons.length) parts.push(reasons.join(','));
  if (stage) parts.push(`stage=${stage}`);
  if (providerCause) parts.push(`cause=${providerCause}`);
  return parts.join('; ').slice(0, 500) || 'luna_failure_unspecified';
}

function buildLunaSupervisorEvent(input) {
  const i = input || {};
  const kind = trimStr(i.kind);
  const rowId = trimStr(i.row_id);
  const revision = trimStr(i.revision);
  if (!kind || !rowId || !revision) throw new Error('luna_supervisor_event_identity_required');
  const sendKind = trimStr(i.send_kind);
  return {
    client_id: i.client_id || null,
    conversation_id: i.conversation_id || null,
    booking_id: i.booking_id || null,
    booking_code: trimStr(i.booking_code) || null,
    kind,
    reason: sanitizeReason(i),
    obligation: kind === 'luna_send_failed' && sendKind === 'confirmation' ? 'confirmation' : 'handoff',
    source_key: sourceKey({
      environment: ENVIRONMENT,
      runtime: RUNTIME,
      kind,
      rowId,
      revision,
    }),
    cause_incident_id: i.cause_incident_id || null,
    metadata: {
      ...(i.metadata && typeof i.metadata === 'object' ? i.metadata : {}),
      source_row_id: rowId,
      source_revision: revision,
      send_kind: sendKind || null,
      blocked_reasons: uniqueReasons(i),
      failure_stage: trimStr(i.failure_stage) || null,
    },
  };
}

async function resolveEventScope(pg, input) {
  if (input.client_id && input.conversation_id) {
    return { client_id: input.client_id, conversation_id: input.conversation_id };
  }
  const phone = trimStr(input.guest_phone || input.to_phone);
  const conversationId = trimStr(input.conversation_id);
  const found = await pg.query(
    `SELECT c.id::text AS client_id, conv.id::text AS conversation_id
       FROM clients c
       JOIN conversations conv ON conv.client_id = c.id
      WHERE c.slug = $1
        AND ($2::text = '' OR conv.id = $2::uuid)
        AND ($3::text = '' OR regexp_replace(COALESCE(conv.phone, ''), '\\D', '', 'g')
          = regexp_replace($3, '\\D', '', 'g'))
      ORDER BY conv.updated_at DESC
      LIMIT 1`,
    [input.client_slug, conversationId, phone],
  );
  return found.rows[0] || null;
}

async function withIsolatedCaptureClient(pg, work) {
  // pg.Pool exposes counters; a borrowed PoolClient also exposes connect(), but
  // reconnecting it throws and releasing it would violate caller ownership.
  const isPool = typeof pg.connect === 'function'
    && typeof pg.totalCount === 'number'
    && typeof pg.idleCount === 'number';
  if (isPool) {
    const client = await pg.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }

  let savepoint = false;
  try {
    await pg.query('SAVEPOINT luna_supervisor_event_capture');
    savepoint = true;
  } catch (_) {
    // A bare Client outside a transaction rejects SAVEPOINT without poisoning later queries.
  }
  try {
    const result = await work(pg);
    if (savepoint) await pg.query('RELEASE SAVEPOINT luna_supervisor_event_capture');
    return result;
  } catch (err) {
    if (savepoint) {
      try {
        await pg.query('ROLLBACK TO SAVEPOINT luna_supervisor_event_capture');
        await pg.query('RELEASE SAVEPOINT luna_supervisor_event_capture');
      } catch (_) {
        // Preserve the original capture failure for the fail-soft result below.
      }
    }
    throw err;
  }
}

async function captureFailedWhatsAppDeliveryStatus(pg, input, opts = {}) {
  const i = input || {};
  const providerMessageId = trimStr(i.provider_message_id);
  const clientSlug = trimStr(i.client_slug);
  const env = opts.env || process.env;
  const callbackPhoneNumberId = trimStr(i.phone_number_id);
  const trustedPhoneNumberId = trimStr(env.WHATSAPP_PHONE_NUMBER_ID);
  // Scope and receiving-channel identity must be established before this callback
  // path reads or writes source evidence. A default tenant slug is not authority.
  if (!isFranceWolfhouseStaging(clientSlug, env)
      || !callbackPhoneNumberId || !trustedPhoneNumberId
      || callbackPhoneNumberId !== trustedPhoneNumberId) {
    return { inserted: false, skipped: 'outside_france_wolfhouse_staging' };
  }
  if (!pg || typeof pg.query !== 'function' || !providerMessageId) {
    return { inserted: false, error: 'failed_delivery_identity_required' };
  }
  const callbackRevision = trimStr(i.callback_revision) || new Date().toISOString();
  const callbackObligation = {
    kind: 'luna_send_failed',
    row_id: `wa:${providerMessageId}`,
    revision: callbackRevision,
    blocked_reasons: ['provider_delivery_failed'],
    failure_stage: 'provider_delivery_callback',
    provider_error: 'whatsapp_failed_status',
  };
  let row;
  try {
    const updated = await pg.query(
      `WITH target AS (
         SELECT id
           FROM guest_message_sends
          WHERE provider_message_id = $1
            AND client_slug = $2
            AND source IS DISTINCT FROM 'meta_failed_status_callback_pending'
          ORDER BY updated_at DESC
          LIMIT 1
       )
       UPDATE guest_message_sends g
          SET status = 'failed',
              blocked_reasons = COALESCE(g.blocked_reasons, '[]'::jsonb)
                || '["provider_delivery_failed"]'::jsonb,
              provider_response = COALESCE(g.provider_response, '{}'::jsonb)
                || jsonb_build_object(
                  'delivery_status', 'failed',
                  'luna_supervisor_event_obligations',
                  CASE
                    WHEN jsonb_typeof(COALESCE(g.provider_response, '{}'::jsonb)
                      -> 'luna_supervisor_event_obligations') = 'array'
                    THEN COALESCE(g.provider_response, '{}'::jsonb)
                      -> 'luna_supervisor_event_obligations'
                    ELSE '[]'::jsonb
                  END || jsonb_build_array($3::jsonb)
                ),
              updated_at = NOW()
         FROM target
        WHERE g.id = target.id
       RETURNING g.id::text AS id, g.client_slug, g.to_phone, g.send_kind,
                 g.updated_at, g.provider_response`,
      [providerMessageId, clientSlug, JSON.stringify(callbackObligation)],
    );
    row = updated.rows[0];
    if (!row) {
      await pg.query(
        `INSERT INTO guest_message_sends (
           client_slug, channel, to_phone, idempotency_key, send_kind, source,
           message_text, status, blocked_reasons, provider_message_id, provider_response
         ) VALUES ($1, 'whatsapp', $2, $3, 'delivery_status_pending',
           'meta_failed_status_callback_pending', '', 'failed',
           '["provider_delivery_failed"]'::jsonb, $4, jsonb_build_object(
             'delivery_status', 'failed',
             'luna_supervisor_event_obligations', jsonb_build_array($5::jsonb)))
         ON CONFLICT (client_slug, idempotency_key) DO UPDATE SET
           provider_response = EXCLUDED.provider_response,
           updated_at = NOW()`,
        [clientSlug, trimStr(i.recipient_phone), `meta-failed-status:${providerMessageId}`,
          providerMessageId, JSON.stringify(callbackObligation)],
      );
      return { inserted: false, pending: true, error: 'failed_delivery_source_not_found' };
    }
  } catch (err) {
    return { inserted: false, error: 'failed_delivery_source_persist_failed' };
  }
  const stored = row.provider_response || {};
  const obligation = (Array.isArray(stored.luna_supervisor_event_obligations)
    ? stored.luna_supervisor_event_obligations : [])
    .find((item) => item && item.row_id === callbackObligation.row_id
      && item.revision === callbackObligation.revision) || callbackObligation;
  const capture = await emitLunaSupervisorEvent(pg, {
    ...obligation,
    client_slug: row.client_slug,
    guest_phone: row.to_phone,
    send_kind: row.send_kind,
    booking_id: stored.booking_id || null,
    booking_code: stored.booking_code || stored.booking_ref || null,
    metadata: { provider_message_id: providerMessageId, source_send_row_id: row.id },
  }, opts);
  if (capture && (capture.inserted === true || (capture.inserted === false && capture.row))) {
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
        [row.id, obligation.row_id],
      );
    } catch (_) { /* retained obligation remains retry-safe */ }
  }
  return capture;
}

async function emitLunaSupervisorEvent(pg, input, opts = {}) {
  const i = input || {};
  if (!isFranceWolfhouseStaging(i.client_slug, opts.env || process.env)) {
    return { inserted: false, skipped: 'outside_france_wolfhouse_staging' };
  }
  if (!pg || typeof pg.query !== 'function') {
    return { inserted: false, error: 'supervisor_event_pg_required' };
  }
  try {
    return await withIsolatedCaptureClient(pg, async (capturePg) => {
      const scope = await resolveEventScope(capturePg, i);
      if (!scope || !scope.client_id || !scope.conversation_id) {
        return { inserted: false, error: 'supervisor_event_conversation_not_found' };
      }
      const event = buildLunaSupervisorEvent({ ...i, ...scope });
      return captureSupervisorEvent(createPgSupervisorStore(capturePg), event);
    });
  } catch (err) {
    return {
      inserted: false,
      error: 'supervisor_event_capture_failed',
      detail: trimStr(err && err.message).slice(0, 200) || 'unknown',
    };
  }
}

module.exports = {
  ENVIRONMENT,
  RUNTIME,
  isFranceWolfhouseStaging,
  buildLunaSupervisorEvent,
  emitLunaSupervisorEvent,
  captureFailedWhatsAppDeliveryStatus,
};
