'use strict';

/**
 * Luna Supervisor — Lookout lane (detector files only).
 *
 * Staff-side catch-up scanners:
 *   1. silence — newest guest inbound is ≥ 2 minutes old with no later outbound
 *   2. confirmation_owed_hint — booking_confirmation_owed still open 60 s after save
 *      HINT ONLY. Never an owed-only resend. Never calls send-reply.
 *   3. undelivered — durable Staff send failures (guest_message_sends blocked/failed,
 *      plus WhatsApp status `failed` when that table exists)
 *
 * Posts into Deckhand's supervisor_events inbox through an injected
 * `eventInbox.capture(event)` (`ON CONFLICT (source_key) DO NOTHING`).
 * Capture payload is the store shape (booking_code, metadata, cause_incident_id).
 * This module does not own that table, does not POST the webhook, does not
 * set needs-human, does not send to guests, and does not touch bookings.
 *
 * PLAN.md section 14 is authoritative. France Wolfhouse staging only.
 */

const SILENCE_THRESHOLD_MS = 2 * 60 * 1000;
const OWED_HINT_THRESHOLD_MS = 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;

const SOURCE_SILENCE = 'silence';
const SOURCE_OWED_HINT = 'confirmation_owed_hint';
const SOURCE_SEND_FAILED = 'send_failed';
const SOURCE_WA_STATUS = 'wa_status';

const KIND_SILENCE = 'silence';
const KIND_OWED_HINT = 'confirmation_owed_hint';
const KIND_SEND_FAILED_GUEST_MESSAGE_SENDS = 'send_failed_guest_message_sends';
const KIND_SEND_FAILED_INBOX_REPLY = 'send_failed_inbox_reply';
const KIND_SEND_FAILED_WA_STATUS = 'send_failed_wa_status';
const KIND_CAPTURE_GAP = 'capture_gap';

const CANONICAL_PIN = Object.freeze({
  environment: 'staging',
  runtime: 'wolfhouse',
  client_slug: 'wolfhouse-somo',
});

const OWED_HINT_REASON =
  'booking_confirmation_owed still open 60s after save; wake-up hint only — '
  + 'supervisor must read the thread and WA status before acting; '
  + 'no automatic resend is ever based only on the owed row';

const CURSOR_TS_SQL = `to_char(%s AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const SILENCE_SQL = `
SELECT
  conv.id::text AS conversation_id,
  conv.client_id::text AS client_id,
  c.slug AS client_slug,
  guest.id::text AS guest_message_id,
  ${CURSOR_TS_SQL.replace('%s', 'guest.created_at')} AS cursor_ts,
  guest.created_at AS guest_created_at
FROM conversations conv
INNER JOIN clients c ON c.id = conv.client_id
INNER JOIN LATERAL (
  SELECT m.id, m.created_at
    FROM messages m
   WHERE m.conversation_id = conv.id
     AND m.client_id = conv.client_id
     AND m.direction = 'inbound'
     AND (conv.cleared_at IS NULL OR m.created_at > conv.cleared_at)
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT 1
) guest ON TRUE
WHERE c.slug = $1
  AND guest.created_at <= $2::timestamptz
  AND NOT EXISTS (
    SELECT 1
      FROM messages outb
     WHERE outb.conversation_id = conv.id
       AND outb.client_id = conv.client_id
       AND outb.direction = 'outbound'
       AND outb.created_at > guest.created_at
       AND (conv.cleared_at IS NULL OR outb.created_at > conv.cleared_at)
  )
  AND (
    $3::text IS NULL
    OR (guest.created_at, guest.id) > ($3::timestamptz, $4::uuid)
  )
ORDER BY guest.created_at ASC, guest.id ASC
LIMIT $5
`;

const OWED_HINT_SQL = `
SELECT
  owed.booking_id::text AS booking_id,
  owed.client_id::text AS client_id,
  c.slug AS client_slug,
  b.booking_code,
  b.conversation_id::text AS conversation_id,
  ${CURSOR_TS_SQL.replace('%s', 'owed.owed_at')} AS cursor_ts,
  owed.owed_at,
  owed.provider_message_id
FROM booking_confirmation_owed owed
INNER JOIN clients c ON c.id = owed.client_id
INNER JOIN bookings b ON b.id = owed.booking_id
WHERE c.slug = $1
  AND owed.cleared_at IS NULL
  AND owed.owed_at <= $2::timestamptz
  AND (
    $3::text IS NULL
    OR (owed.owed_at, owed.booking_id) > ($3::timestamptz, $4::uuid)
  )
ORDER BY owed.owed_at ASC, owed.booking_id ASC
LIMIT $5
`;

const SEND_FAILED_SQL = `
SELECT
  g.id::text AS send_id,
  c.id::text AS client_id,
  g.client_slug,
  conv.conversation_id,
  conv.conversation_matches,
  bk.booking_id,
  bk.booking_code,
  bk.booking_matches,
  g.status,
  g.blocked_reasons,
  g.idempotency_key,
  g.send_kind,
  g.source,
  g.to_phone,
  g.provider_message_id,
  ${CURSOR_TS_SQL.replace('%s', 'g.updated_at')} AS cursor_ts,
  g.updated_at,
  g.created_at
FROM guest_message_sends g
INNER JOIN clients c ON lower(c.slug) = lower(g.client_slug)
LEFT JOIN LATERAL (
  SELECT
    MIN(conv.id::text) AS conversation_id,
    COUNT(*)::int AS conversation_matches
  FROM conversations conv
  WHERE conv.client_id = c.id
    AND conv.phone = g.to_phone
) conv ON TRUE
LEFT JOIN LATERAL (
  SELECT
    MIN(b.id::text) AS booking_id,
    MIN(b.booking_code) AS booking_code,
    COUNT(*)::int AS booking_matches
  FROM bookings b
  WHERE conv.conversation_matches = 1
    AND b.conversation_id::text = conv.conversation_id
) bk ON TRUE
WHERE g.client_slug = $1
  AND g.status IN ('blocked', 'failed')
  AND (
    $2::text IS NULL
    OR (g.updated_at, g.id) > ($2::timestamptz, $3::uuid)
  )
ORDER BY g.updated_at ASC, g.id ASC
LIMIT $4
`;

const WA_FAILED_SQL = `
SELECT
  w.id::text AS status_id,
  w.provider_message_id,
  w.status,
  ${CURSOR_TS_SQL.replace('%s', 'w.received_at')} AS cursor_ts,
  w.received_at,
  w.conversation_id::text AS conversation_id,
  w.client_id::text AS client_id,
  c.slug AS client_slug,
  g.id::text AS send_id,
  g.idempotency_key,
  g.source,
  g.send_kind,
  bk.booking_id,
  bk.booking_code
FROM whatsapp_status_events w
INNER JOIN clients c ON c.id = w.client_id
LEFT JOIN guest_message_sends g
  ON g.provider_message_id = w.provider_message_id
 AND lower(g.client_slug) = lower(c.slug)
LEFT JOIN LATERAL (
  SELECT
    MIN(b.id::text) AS booking_id,
    MIN(b.booking_code) AS booking_code
  FROM bookings b
  WHERE w.conversation_id IS NOT NULL
    AND b.conversation_id = w.conversation_id
) bk ON TRUE
WHERE c.slug = $1
  AND lower(w.status) = 'failed'
  AND (
    $2::text IS NULL
    OR (w.received_at, w.id) > ($2::timestamptz, $3::uuid)
  )
ORDER BY w.received_at ASC, w.id ASC
LIMIT $4
`;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function asDate(v) {
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function losslessTs(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

function iso(v) {
  const d = asDate(v);
  return d ? d.toISOString() : '';
}

function isUndefinedTableError(err) {
  if (!err) return false;
  if (err.code === '42P01') return true;
  const msg = String(err.message || '');
  return /does not exist|undefined[_ ]table/i.test(msg);
}

function normalizeBatchSize(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.floor(x), 500);
}

function pinOrRefuse(pin) {
  const environment = trimStr(pin && pin.environment).toLowerCase();
  const runtime = trimStr(pin && pin.runtime).toLowerCase();
  const clientSlug = trimStr(pin && pin.client_slug).toLowerCase();
  const deployment = trimStr(pin && (pin.luna_deployment || pin.deployment)).toLowerCase();
  if (environment === 'prod' || environment === 'production') {
    return { ok: false, reason: 'prod_refused' };
  }
  if (
    runtime === 'sunset'
    || clientSlug === 'sunset'
    || deployment === 'sunset-staging'
    || deployment === 'sunset'
  ) {
    return { ok: false, reason: 'sunset_refused' };
  }
  if (
    environment !== CANONICAL_PIN.environment
    || runtime !== CANONICAL_PIN.runtime
    || clientSlug !== CANONICAL_PIN.client_slug
  ) {
    return { ok: false, reason: 'runtime_not_france_wolfhouse_staging' };
  }
  return {
    ok: true,
    environment: CANONICAL_PIN.environment,
    runtime: CANONICAL_PIN.runtime,
    client_slug: CANONICAL_PIN.client_slug,
  };
}

function buildSourceKey(pin, kind, rowId, revision) {
  return [
    pin.environment,
    pin.runtime,
    kind,
    trimStr(rowId),
    trimStr(revision) || '1',
  ].join(':');
}

function inboxSourceKind(source) {
  const s = trimStr(source).toLowerCase();
  if (s === 'staff_inbox_reply' || s === 'staff_inbox' || s === 'inbox') {
    return KIND_SEND_FAILED_INBOX_REPLY;
  }
  return KIND_SEND_FAILED_GUEST_MESSAGE_SENDS;
}

function trustedCauseIncidentId(row) {
  const explicit = trimStr(row && row.cause_incident_id);
  if (explicit) return explicit;
  const key = trimStr(row && row.idempotency_key);
  const m = /^supervisor:([^:]+):/.exec(key);
  if (m) return m[1];
  return '';
}

function isSupervisorDescendant(row) {
  if (trustedCauseIncidentId(row)) return true;
  const src = trimStr(row && row.source).toLowerCase();
  if (src.startsWith('supervisor')) return true;
  if (src.includes('supervisor_fallback') || src.includes('supervisor-fallback')) return true;
  return false;
}

function normalizeBlockedReasons(value) {
  let reasons = value;
  if (reasons == null) return [];
  if (typeof reasons === 'string') {
    try { reasons = JSON.parse(reasons); } catch { reasons = [reasons]; }
  }
  if (!Array.isArray(reasons)) return [String(reasons)];
  return [...new Set(reasons.filter(Boolean).map((x) => String(x)))].sort();
}

function occurrenceRevision(row, tsField) {
  const ts = losslessTs(row && (row.cursor_ts || (tsField && row[tsField]) || row.updated_at || row.received_at));
  return ts;
}

function sendFailureRevision(row) {
  return occurrenceRevision(row, 'updated_at');
}

function unresolvedBindingReason(row, opts) {
  const needBooking = !!(opts && opts.booking);
  if (!trimStr(row && row.client_id)) return 'unresolved_client_id';
  const matches = Number(row && row.conversation_matches);
  if (Number.isFinite(matches) && matches > 1) return 'unresolved_conversation_ambiguous';
  if (!trimStr(row && row.conversation_id)) return 'unresolved_conversation_id';
  if (needBooking) {
    const bMatches = Number(row && row.booking_matches);
    if (Number.isFinite(bMatches) && bMatches > 1) return 'unresolved_booking_ambiguous';
    if (!trimStr(row && row.booking_id) && !trimStr(row && (row.booking_code || row.booking_ref))) {
      return 'unresolved_booking';
    }
  }
  return '';
}

function isSilenceDue(guestCreatedAt, now) {
  const created = asDate(guestCreatedAt);
  const n = asDate(now);
  if (!created || !n) return false;
  return (n.getTime() - created.getTime()) >= SILENCE_THRESHOLD_MS;
}

function isOwedHintDue(owedAt, now) {
  const created = asDate(owedAt);
  const n = asDate(now);
  if (!created || !n) return false;
  return (n.getTime() - created.getTime()) >= OWED_HINT_THRESHOLD_MS;
}

function cursorOf(row, id) {
  const ts = losslessTs(row && (row.cursor_ts || row.guest_created_at || row.owed_at || row.updated_at || row.received_at));
  return { ts, id: trimStr(id), created_at: ts };
}

function toSupervisorInboxEvent(event) {
  const payload = (event && event.payload && typeof event.payload === 'object') ? event.payload : {};
  const metadataIn = (event && event.metadata && typeof event.metadata === 'object') ? event.metadata : {};
  return {
    source_key: event.source_key,
    kind: event.kind,
    obligation: event.obligation,
    reason: event.reason,
    client_id: event.client_id || null,
    conversation_id: event.conversation_id || null,
    booking_id: event.booking_id || null,
    booking_code: event.booking_code || event.booking_ref || null,
    cause_incident_id: event.cause_incident_id || null,
    metadata: {
      ...payload,
      ...metadataIn,
      client_slug: event.client_slug || null,
      hint_only: event.hint_only === true,
      automatic_resend: false,
      wake_supervisor: event.wake_supervisor === true,
    },
  };
}

function isDurableCaptureAck(captured) {
  if (!captured || typeof captured !== 'object') return false;
  if (captured.error) return false;
  if (captured.ok === false) return false;
  if (captured.inserted === true || captured.duplicate === true) return true;
  if (captured.ok === true && (captured.inserted === false || captured.row)) return true;
  if (captured.id && captured.inserted !== false && captured.ok !== false && !captured.error) return true;
  return false;
}

function silenceEventFromRow(row, pin) {
  const missing = unresolvedBindingReason(row, { booking: false });
  if (missing) {
    return captureGapEvent(pin, SOURCE_SILENCE, `${missing}:${trimStr(row && row.guest_message_id)}`);
  }
  return {
    source_key: buildSourceKey(pin, KIND_SILENCE, row.guest_message_id, '1'),
    kind: KIND_SILENCE,
    obligation: 'silence',
    reason: 'guest newest inbound is over 2 minutes old with no outbound reply after it',
    client_id: row.client_id || null,
    client_slug: row.client_slug || pin.client_slug,
    conversation_id: row.conversation_id || null,
    booking_id: null,
    booking_code: null,
    cause_kind: 'guest_message',
    cause_id: row.guest_message_id,
    cause_incident_id: null,
    wake_supervisor: true,
    hint_only: false,
    automatic_resend: false,
    payload: {
      guest_message_id: row.guest_message_id,
      guest_created_at: losslessTs(row.cursor_ts || row.guest_created_at),
      trigger_threshold_ms: SILENCE_THRESHOLD_MS,
      honest_limit: 'silence_only_cannot_see_failure_after_outbound',
    },
  };
}

function owedHintEventFromRow(row, pin) {
  const missing = unresolvedBindingReason(row, { booking: true });
  if (missing) {
    return captureGapEvent(pin, SOURCE_OWED_HINT, `${missing}:${trimStr(row && row.booking_id)}`);
  }
  return {
    source_key: buildSourceKey(pin, KIND_OWED_HINT, row.booking_id, 'open'),
    kind: KIND_OWED_HINT,
    obligation: 'confirmation',
    reason: OWED_HINT_REASON,
    client_id: row.client_id || null,
    client_slug: row.client_slug || pin.client_slug,
    conversation_id: row.conversation_id || null,
    booking_id: row.booking_id,
    booking_code: row.booking_code || null,
    cause_kind: 'owed_row',
    cause_id: row.booking_id,
    cause_incident_id: null,
    wake_supervisor: true,
    hint_only: true,
    automatic_resend: false,
    payload: {
      booking_id: row.booking_id,
      booking_code: row.booking_code || null,
      owed_at: losslessTs(row.cursor_ts || row.owed_at),
      provider_message_id: row.provider_message_id || null,
      hint_only: true,
      automatic_resend: false,
      open_row_does_not_prove_nothing_was_sent: true,
    },
  };
}

function sendFailedEventFromRow(row, pin) {
  const revision = sendFailureRevision(row);
  if (!revision) {
    return captureGapEvent(pin, SOURCE_SEND_FAILED, `missing_occurrence_identity:${trimStr(row && row.send_id)}`);
  }
  const needBooking = trimStr(row && row.send_kind) === 'confirmation';
  const missing = unresolvedBindingReason(row, { booking: needBooking });
  if (missing) {
    return captureGapEvent(pin, SOURCE_SEND_FAILED, `${missing}:${trimStr(row && row.send_id)}`);
  }
  const descendant = isSupervisorDescendant(row);
  const incidentId = trustedCauseIncidentId(row) || null;
  const kind = inboxSourceKind(row.source);
  return {
    source_key: buildSourceKey(pin, kind, row.send_id, revision),
    kind,
    obligation: trimStr(row.send_kind) === 'confirmation' ? 'confirmation' : 'handoff',
    reason: `durable send failure ${trimStr(row.status)}: ${normalizeBlockedReasons(row.blocked_reasons).join(',') || 'unspecified'}`,
    client_id: row.client_id || null,
    client_slug: row.client_slug || pin.client_slug,
    conversation_id: row.conversation_id || null,
    booking_id: row.booking_id || null,
    booking_code: row.booking_code || row.booking_ref || null,
    cause_kind: 'send_record',
    cause_id: row.send_id,
    cause_incident_id: incidentId,
    wake_supervisor: !incidentId && !descendant,
    hint_only: false,
    automatic_resend: false,
    payload: {
      send_id: row.send_id,
      status: row.status,
      blocked_reasons: normalizeBlockedReasons(row.blocked_reasons),
      send_kind: row.send_kind || null,
      source: row.source || null,
      idempotency_key: row.idempotency_key || null,
      provider_message_id: row.provider_message_id || null,
      supervisor_descendant: !!(incidentId || descendant),
      occurrence_ts: revision,
    },
  };
}

function waFailedEventFromRow(row, pin) {
  const revision = occurrenceRevision(row, 'received_at') || 'failed';
  const incidentId = trustedCauseIncidentId(row) || null;
  const descendant = isSupervisorDescendant(row);
  const missing = unresolvedBindingReason(row, { booking: false });
  if (missing) {
    return captureGapEvent(pin, SOURCE_WA_STATUS, `${missing}:${trimStr(row && row.status_id)}`);
  }
  return {
    source_key: buildSourceKey(pin, KIND_SEND_FAILED_WA_STATUS, row.status_id, revision),
    kind: KIND_SEND_FAILED_WA_STATUS,
    obligation: 'confirmation',
    reason: `whatsapp status webhook reported failed for ${trimStr(row.provider_message_id) || 'unknown-id'}`,
    client_id: row.client_id || null,
    client_slug: row.client_slug || pin.client_slug,
    conversation_id: row.conversation_id || null,
    booking_id: row.booking_id || null,
    booking_code: row.booking_code || null,
    cause_kind: 'wa_status',
    cause_id: row.status_id,
    cause_incident_id: incidentId,
    wake_supervisor: !incidentId && !descendant,
    hint_only: false,
    automatic_resend: false,
    payload: {
      status_id: row.status_id,
      provider_message_id: row.provider_message_id || null,
      status: row.status,
      received_at: losslessTs(row.cursor_ts || row.received_at),
      no_correlation_never_permission_to_resend: true,
      supervisor_descendant: !!(incidentId || descendant),
    },
  };
}

function captureGapEvent(pin, sourceName, reason) {
  return {
    source_key: buildSourceKey(pin, KIND_CAPTURE_GAP, sourceName, reason),
    kind: KIND_CAPTURE_GAP,
    obligation: 'handoff',
    reason: `capture-gap for ${sourceName}: ${reason}`,
    client_id: null,
    client_slug: pin.client_slug,
    conversation_id: null,
    booking_id: null,
    booking_code: null,
    cause_kind: 'detector',
    cause_id: sourceName,
    cause_incident_id: null,
    wake_supervisor: false,
    hint_only: false,
    automatic_resend: false,
    payload: {
      source_name: sourceName,
      gap_reason: reason,
      escalation: 'capture_gap',
      claimed_coverage: false,
    },
  };
}

function cursorFromSilence(row) {
  return cursorOf(row, row.guest_message_id);
}

function cursorFromOwed(row) {
  return cursorOf(row, row.booking_id);
}

function cursorFromSend(row) {
  return cursorOf(row, row.send_id);
}

function cursorFromWa(row) {
  return cursorOf(row, row.status_id);
}

async function captureAndAdvance(ctx, sourceName, event, nextCursor) {
  const inboxEvent = toSupervisorInboxEvent(event);
  const captured = await ctx.eventInbox.capture(inboxEvent);
  if (!isDurableCaptureAck(captured)) {
    return { ok: false, captured, event, inboxEvent, cursorAdvanced: false };
  }
  await ctx.checkpoints.set(sourceName, nextCursor);
  return {
    ok: true,
    captured,
    event,
    inboxEvent,
    cursorAdvanced: true,
    duplicate: captured.duplicate === true || captured.inserted === false,
  };
}

async function postCaptureGap(ctx, pin, sourceName, reason) {
  const event = captureGapEvent(pin, sourceName, reason);
  const inboxEvent = toSupervisorInboxEvent(event);
  const captured = await ctx.eventInbox.capture(inboxEvent);
  const acked = isDurableCaptureAck(captured);
  return {
    ok: acked,
    source: sourceName,
    gap: true,
    reason,
    claimed_coverage: false,
    captured,
    event,
    inboxEvent,
  };
}

function assertNoSendHookCalled(ctx) {
  if (ctx && ctx.sendReply && ctx.sendReply.calls && ctx.sendReply.calls.length) {
    throw new Error('lookout detector must never call sendReply');
  }
}

async function loadRowsFromPg(pg, sql, params) {
  const r = await pg.query(sql, params);
  return (r && r.rows) || [];
}

function cursorTsParam(cursor) {
  if (!cursor) return null;
  const ts = losslessTs(cursor.ts || cursor.created_at);
  return ts || null;
}

function cursorIdParam(cursor) {
  return cursor && cursor.id ? cursor.id : '00000000-0000-4000-8000-000000000000';
}

async function loadSilenceRows(ctx, pin, cursor, now, batchSize) {
  if (ctx.sources && typeof ctx.sources.silence === 'function') {
    return ctx.sources.silence({ cursor, now, batchSize, pin });
  }
  const dueAt = asDate(now);
  const params = [
    pin.client_slug,
    new Date(dueAt.getTime() - SILENCE_THRESHOLD_MS).toISOString(),
    cursorTsParam(cursor),
    cursorIdParam(cursor),
    batchSize,
  ];
  return loadRowsFromPg(ctx.pg, SILENCE_SQL, params);
}

async function loadOwedRows(ctx, pin, cursor, now, batchSize) {
  if (ctx.sources && typeof ctx.sources.owedHint === 'function') {
    return ctx.sources.owedHint({ cursor, now, batchSize, pin });
  }
  const dueAt = new Date(asDate(now).getTime() - OWED_HINT_THRESHOLD_MS);
  const params = [
    pin.client_slug,
    dueAt.toISOString(),
    cursorTsParam(cursor),
    cursorIdParam(cursor),
    batchSize,
  ];
  return loadRowsFromPg(ctx.pg, OWED_HINT_SQL, params);
}

async function loadSendFailedRows(ctx, pin, cursor, batchSize) {
  if (ctx.sources && typeof ctx.sources.sendFailed === 'function') {
    return ctx.sources.sendFailed({ cursor, batchSize, pin });
  }
  const params = [
    pin.client_slug,
    cursorTsParam(cursor),
    cursorIdParam(cursor),
    batchSize,
  ];
  return loadRowsFromPg(ctx.pg, SEND_FAILED_SQL, params);
}

async function loadWaFailedRows(ctx, pin, cursor, batchSize) {
  if (ctx.sources && typeof ctx.sources.waFailed === 'function') {
    return ctx.sources.waFailed({ cursor, batchSize, pin });
  }
  if (!ctx.pg || typeof ctx.pg.query !== 'function') {
    const err = new Error('relation "whatsapp_status_events" does not exist');
    err.code = '42P01';
    throw err;
  }
  const params = [
    pin.client_slug,
    cursorTsParam(cursor),
    cursorIdParam(cursor),
    batchSize,
  ];
  return loadRowsFromPg(ctx.pg, WA_FAILED_SQL, params);
}

async function scanOneSource(ctx, pin, spec) {
  const cursor = await ctx.checkpoints.get(spec.sourceName);
  let rows;
  try {
    rows = await spec.load(cursor);
  } catch (err) {
    if (isUndefinedTableError(err)) {
      if (spec.optional) {
        return {
          ok: true,
          source: spec.sourceName,
          unavailable: true,
          reason: 'table_missing',
          claimed_coverage: false,
          results: [],
        };
      }
      return postCaptureGap(ctx, pin, spec.sourceName, 'table_missing');
    }
    throw err;
  }
  const list = Array.isArray(rows) ? rows : [];
  const results = [];
  let lastCursor = cursor || null;
  for (const row of list) {
    if (spec.isDue && !spec.isDue(row)) {
      break;
    }
    const event = spec.eventFromRow(row, pin);
    const nextCursor = spec.cursorFromRow(row);
    const step = await captureAndAdvance(ctx, spec.sourceName, event, nextCursor);
    results.push(step);
    if (!step.ok) {
      return {
        ok: false,
        source: spec.sourceName,
        results,
        cursor: lastCursor,
        claimed_coverage: false,
      };
    }
    lastCursor = nextCursor;
  }
  return {
    ok: true,
    source: spec.sourceName,
    results,
    cursor: lastCursor,
    truncated: list.length >= spec.batchSize,
    claimed_coverage: false,
  };
}

/**
 * Run Lookout catch-up detectors once.
 *
 * @param {object} ctx
 * @param {object} ctx.pin  CANONICAL_PIN only
 * @param {object} ctx.eventInbox  { capture(event) → durable ack }
 * @param {object} ctx.checkpoints { get(name), set(name, cursor) } — advance only after ack
 */
async function runLookoutDetectorScan(ctx) {
  const input = ctx || {};
  const pin = pinOrRefuse(input.pin);
  if (!pin.ok) return pin;
  if (!input.eventInbox || typeof input.eventInbox.capture !== 'function') {
    return { ok: false, reason: 'event_inbox_required' };
  }
  if (!input.checkpoints || typeof input.checkpoints.get !== 'function' || typeof input.checkpoints.set !== 'function') {
    return { ok: false, reason: 'checkpoint_store_required' };
  }

  const now = asDate(input.now) || new Date();
  const batchSize = normalizeBatchSize(input.batchSize);

  const silence = await scanOneSource(input, pin, {
    sourceName: SOURCE_SILENCE,
    batchSize,
    load: (cursor) => loadSilenceRows(input, pin, cursor, now, batchSize),
    isDue: (row) => isSilenceDue(row.guest_created_at || row.cursor_ts, now),
    eventFromRow: silenceEventFromRow,
    cursorFromRow: cursorFromSilence,
  });

  const owed = await scanOneSource(input, pin, {
    sourceName: SOURCE_OWED_HINT,
    batchSize,
    load: (cursor) => loadOwedRows(input, pin, cursor, now, batchSize),
    isDue: (row) => isOwedHintDue(row.owed_at || row.cursor_ts, now),
    eventFromRow: owedHintEventFromRow,
    cursorFromRow: cursorFromOwed,
  });

  const sendFailed = await scanOneSource(input, pin, {
    sourceName: SOURCE_SEND_FAILED,
    batchSize,
    load: (cursor) => loadSendFailedRows(input, pin, cursor, batchSize),
    eventFromRow: sendFailedEventFromRow,
    cursorFromRow: cursorFromSend,
  });

  const waFailed = await scanOneSource(input, pin, {
    sourceName: SOURCE_WA_STATUS,
    batchSize,
    optional: true,
    load: (cursor) => loadWaFailedRows(input, pin, cursor, batchSize),
    eventFromRow: waFailedEventFromRow,
    cursorFromRow: cursorFromWa,
  });

  assertNoSendHookCalled(input);

  function eventsFrom(sourceResult) {
    if (sourceResult && sourceResult.event) return [sourceResult.event];
    return (sourceResult && sourceResult.results || [])
      .map((step) => step && step.event)
      .filter(Boolean);
  }
  const events = []
    .concat(eventsFrom(silence), eventsFrom(owed), eventsFrom(sendFailed), eventsFrom(waFailed));

  return {
    ok: silence.ok !== false && owed.ok !== false && sendFailed.ok !== false && waFailed.ok !== false,
    pin,
    now: now.toISOString(),
    batchSize,
    sources: {
      silence,
      confirmation_owed_hint: owed,
      send_failed: sendFailed,
      wa_status: waFailed,
    },
    events,
    webhook_posts: 0,
    automatic_resends: 0,
  };
}

function sqlIsSelectOnly(sql) {
  const body = String(sql).replace(/--[^\n]*/g, ' ');
  return /^\s*SELECT\b/i.test(body)
    && !/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i.test(body);
}

module.exports = {
  SILENCE_THRESHOLD_MS,
  OWED_HINT_THRESHOLD_MS,
  DEFAULT_BATCH_SIZE,
  CANONICAL_PIN,
  SOURCE_SILENCE,
  SOURCE_OWED_HINT,
  SOURCE_SEND_FAILED,
  SOURCE_WA_STATUS,
  KIND_SILENCE,
  KIND_OWED_HINT,
  KIND_SEND_FAILED_GUEST_MESSAGE_SENDS,
  KIND_SEND_FAILED_INBOX_REPLY,
  KIND_SEND_FAILED_WA_STATUS,
  KIND_CAPTURE_GAP,
  OWED_HINT_REASON,
  SILENCE_SQL,
  OWED_HINT_SQL,
  SEND_FAILED_SQL,
  WA_FAILED_SQL,
  pinOrRefuse,
  buildSourceKey,
  isSilenceDue,
  isOwedHintDue,
  isUndefinedTableError,
  sendFailureRevision,
  occurrenceRevision,
  trustedCauseIncidentId,
  toSupervisorInboxEvent,
  isDurableCaptureAck,
  silenceEventFromRow,
  owedHintEventFromRow,
  sendFailedEventFromRow,
  waFailedEventFromRow,
  captureGapEvent,
  sqlIsSelectOnly,
  runLookoutDetectorScan,
};
