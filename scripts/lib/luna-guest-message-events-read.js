'use strict';

/**
 * Phase 19g.9 — read-only guest_message_events inbox query helpers.
 */

const {
  isMissingGuestMessageEventsTable,
  formatGuestMessageEventRow,
} = require('./luna-guest-message-events-sql');

const DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const INBOX_EVENT_SELECT_COLS = `
  id::text,
  created_at,
  from_phone,
  wa_message_id,
  message_type,
  message_text,
  profile_name,
  draft_called,
  next_action,
  suggested_reply,
  handoff_required,
  send_attempted,
  send_status,
  send_blocked_reasons
`;

const HANDOFF_QUEUE_SELECT_COLS = `
  id::text,
  client_slug,
  created_at,
  from_phone,
  wa_message_id,
  message_text,
  profile_name,
  next_action,
  suggested_reply,
  handoff_required,
  send_attempted,
  send_status,
  send_blocked_reasons,
  normalized
`;

/** Env-only send gates — excluded unless combined with handoff/risky criteria. */
const SAFE_ENV_GATE_REASONS = new Set([
  'luna_auto_send_not_enabled',
  'whatsapp_dry_run_active',
  'auto_send_not_ready',
]);

const PREVIEW_QUEUE_REASON_RE = /handoff|refund|insufficient|availability|unsupported|low_confidence/i;
const MEANINGFUL_SEND_BLOCKED_RE = /handoff|risky|requires_staff|unsupported|refund|low_confidence|send_not_allowed/i;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function parseOptionalBoolean(value) {
  if (value == null || value === '') return { value: null, invalid: false };
  const v = trimStr(value).toLowerCase();
  if (v === 'true' || v === '1') return { value: true, invalid: false };
  if (v === 'false' || v === '0') return { value: false, invalid: false };
  return { value: null, invalid: true };
}

function clampMessageEventsLimit(limit) {
  if (limit == null || limit === '') return DEFAULT_LIMIT;
  const n = parseInt(String(limit), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function normalizePhoneFilter(phone) {
  return trimStr(phone).replace(/^\+/, '');
}

function parseSinceTimestamp(since) {
  const raw = trimStr(since);
  if (!raw) return { value: null, invalid: false };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { value: null, invalid: true };
  return { value: d.toISOString(), invalid: false };
}

/**
 * Parse GET query params into list filters.
 * @returns {{ ok: boolean, error?: string, filters?: object }}
 */
function parseMessageEventsQuery(query) {
  const q = query || {};
  const clientSlug = trimStr(q.client_slug) || DEFAULT_CLIENT_SLUG;

  const handoff = parseOptionalBoolean(q.handoff_required);
  if (handoff.invalid) {
    return { ok: false, error: 'handoff_required must be true or false' };
  }

  const sendAttempted = parseOptionalBoolean(q.send_attempted);
  if (sendAttempted.invalid) {
    return { ok: false, error: 'send_attempted must be true or false' };
  }

  const since = parseSinceTimestamp(q.since);
  if (since.invalid) {
    return { ok: false, error: 'since must be a valid ISO timestamp' };
  }

  const fromPhone = trimStr(q.from_phone) || null;
  const nextAction = trimStr(q.next_action) || null;

  return {
    ok: true,
    filters: {
      client_slug: clientSlug,
      from_phone: fromPhone,
      handoff_required: handoff.value,
      send_attempted: sendAttempted.value,
      next_action: nextAction,
      since: since.value,
      limit: clampMessageEventsLimit(q.limit),
    },
  };
}

function formatInboxMessageEvent(row) {
  const full = formatGuestMessageEventRow(row);
  if (!full) return null;
  return {
    id: full.id,
    created_at: full.created_at,
    from_phone: full.from_phone,
    wa_message_id: full.wa_message_id,
    message_type: full.message_type,
    message_text: full.message_text,
    profile_name: full.profile_name,
    draft_called: full.draft_called,
    next_action: full.next_action,
    suggested_reply: full.suggested_reply,
    handoff_required: full.handoff_required,
    send_attempted: full.send_attempted,
    send_status: full.send_status,
    send_blocked_reasons: Array.isArray(full.send_blocked_reasons) ? full.send_blocked_reasons : [],
  };
}

function buildMessageEventsListQuery(filters) {
  const f = filters || {};
  const params = [f.client_slug];
  const where = ['client_slug = $1'];

  if (f.from_phone) {
    params.push(`%${normalizePhoneFilter(f.from_phone)}%`);
    where.push(`REPLACE(COALESCE(from_phone, ''), '+', '') LIKE $${params.length}`);
  }
  if (f.handoff_required === true || f.handoff_required === false) {
    params.push(f.handoff_required);
    where.push(`handoff_required = $${params.length}`);
  }
  if (f.send_attempted === true || f.send_attempted === false) {
    params.push(f.send_attempted);
    where.push(`send_attempted = $${params.length}`);
  }
  if (f.next_action) {
    params.push(f.next_action);
    where.push(`next_action = $${params.length}`);
  }
  if (f.since) {
    params.push(f.since);
    where.push(`created_at >= $${params.length}::timestamptz`);
  }

  params.push(f.limit || DEFAULT_LIMIT);
  const limitIdx = params.length;

  const sql = `
    SELECT ${INBOX_EVENT_SELECT_COLS}
      FROM guest_message_events
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${limitIdx}`;

  return { sql, params };
}

async function listGuestMessageEvents(pg, filters) {
  const { sql, params } = buildMessageEventsListQuery(filters);
  try {
    const r = await pg.query(sql, params);
    const events = (r.rows || []).map((row) => formatInboxMessageEvent(row)).filter(Boolean);
    return { events, table_missing: false };
  } catch (err) {
    if (isMissingGuestMessageEventsTable(err)) {
      return { events: [], table_missing: true };
    }
    throw err;
  }
}

function parseNormalizedField(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function parseBlockedReasonsField(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String);
  const parsed = parseNormalizedField(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function previewBlockedReasonsQualify(reasons) {
  if (!Array.isArray(reasons) || !reasons.length) return false;
  return reasons.some((r) => PREVIEW_QUEUE_REASON_RE.test(String(r)));
}

function nonEnvSendBlockedReasons(reasons) {
  return (reasons || []).filter((r) => !SAFE_ENV_GATE_REASONS.has(String(r)));
}

function meaningfulSendBlockedQualify(reasons) {
  const nonEnv = nonEnvSendBlockedReasons(reasons);
  return nonEnv.some((r) => MEANINGFUL_SEND_BLOCKED_RE.test(String(r)));
}

/**
 * Whether a guest_message_events row belongs on the Meta-native handoff queue.
 * @param {object} row — DB row with decision + normalized columns
 */
function rowMatchesHandoffQueueCriteria(row) {
  if (!row) return false;

  const norm = parseNormalizedField(row.normalized);
  const preview = norm && norm.booking_write_preview;
  const previewBlocked = preview && preview.blocked_reasons;
  const sendBlocked = parseBlockedReasonsField(row.send_blocked_reasons);

  if (row.handoff_required === true) return true;
  if (row.next_action === 'handoff_to_staff') return true;
  if (row.next_action === 'unsupported') return true;
  if (norm && norm.supported === false) return true;
  if (previewBlockedReasonsQualify(previewBlocked)) return true;
  if (meaningfulSendBlockedQualify(sendBlocked)) return true;

  return false;
}

function deriveHandoffQueueReason(row, norm, preview, sendBlocked) {
  if (row.handoff_required === true) return 'handoff_required';
  if (row.next_action === 'handoff_to_staff') return 'handoff_to_staff';
  if (row.next_action === 'unsupported') return 'unsupported';
  if (norm && norm.supported === false) return 'unsupported_message_type';

  const previewBlocked = preview && preview.blocked_reasons;
  if (Array.isArray(previewBlocked) && previewBlocked.length) {
    const hit = previewBlocked.find((r) => PREVIEW_QUEUE_REASON_RE.test(String(r)));
    if (hit) return String(hit);
  }

  const nonEnv = nonEnvSendBlockedReasons(sendBlocked);
  const sendHit = nonEnv.find((r) => MEANINGFUL_SEND_BLOCKED_RE.test(String(r)));
  if (sendHit) return String(sendHit);

  return row.next_action || 'needs_staff_review';
}

function formatBookingWritePreviewSummary(preview) {
  if (!preview || typeof preview !== 'object') return null;
  const payload = preview.booking_create_payload_preview;
  let payloadSummary = null;
  if (payload && typeof payload === 'object') {
    payloadSummary = {
      check_in: payload.check_in || null,
      check_out: payload.check_out || null,
      guest_count: payload.guest_count != null ? payload.guest_count : null,
      package_code: payload.package_code || null,
      payment_choice: payload.payment_choice || null,
      confirm: payload.confirm === true,
    };
  }
  return {
    eligible: preview.eligible === true,
    action: preview.action || null,
    blocked_reasons: Array.isArray(preview.blocked_reasons) ? preview.blocked_reasons.map(String) : [],
    idempotency_key_preview: preview.idempotency_key_preview || null,
    booking_create_payload_preview: payloadSummary,
  };
}

function formatBookingWriteResultSummary(result) {
  if (!result || typeof result !== 'object') return null;
  const bookingId = result.booking_id ? String(result.booking_id) : null;
  if (!bookingId) return null;
  return {
    booking_id: bookingId,
    booking_code: result.booking_code ? String(result.booking_code) : null,
    payment_id: result.payment_id ? String(result.payment_id) : null,
  };
}

function formatHandoffQueueItem(row) {
  if (!row) return null;
  const norm = parseNormalizedField(row.normalized);
  const preview = norm && norm.booking_write_preview;
  const sendBlocked = parseBlockedReasonsField(row.send_blocked_reasons);

  return {
    id: row.id,
    created_at: row.created_at,
    client_slug: row.client_slug,
    from_phone: row.from_phone,
    profile_name: row.profile_name,
    message_text: row.message_text,
    next_action: row.next_action,
    handoff_required: row.handoff_required === true,
    queue_reason: deriveHandoffQueueReason(row, norm, preview, sendBlocked),
    suggested_reply: row.suggested_reply || null,
    send_attempted: row.send_attempted === true,
    send_status: row.send_status || null,
    send_blocked_reasons: sendBlocked,
    booking_write_preview: formatBookingWritePreviewSummary(preview),
    booking_write_result: formatBookingWriteResultSummary(norm && norm.booking_write_result),
  };
}

/**
 * Parse GET query params for handoff queue list.
 * @returns {{ ok: boolean, error?: string, filters?: object }}
 */
function parseHandoffQueueQuery(query) {
  const q = query || {};
  const clientSlug = trimStr(q.client_slug) || DEFAULT_CLIENT_SLUG;
  const since = parseSinceTimestamp(q.since);
  if (since.invalid) {
    return { ok: false, error: 'since must be a valid ISO timestamp' };
  }
  const fromPhone = trimStr(q.from_phone) || null;
  return {
    ok: true,
    filters: {
      client_slug: clientSlug,
      from_phone: fromPhone,
      since: since.value,
      limit: clampMessageEventsLimit(q.limit),
    },
  };
}

function buildHandoffQueueCandidateQuery(filters) {
  const f = filters || {};
  const params = [f.client_slug];
  const where = ['client_slug = $1'];

  if (f.from_phone) {
    params.push(`%${normalizePhoneFilter(f.from_phone)}%`);
    where.push(`REPLACE(COALESCE(from_phone, ''), '+', '') LIKE $${params.length}`);
  }
  if (f.since) {
    params.push(f.since);
    where.push(`created_at >= $${params.length}::timestamptz`);
  }

  where.push(`(
    handoff_required = true
    OR next_action IN ('handoff_to_staff', 'unsupported')
    OR COALESCE(normalized->>'supported', 'true') = 'false'
    OR (
      jsonb_typeof(normalized->'booking_write_preview'->'blocked_reasons') = 'array'
      AND jsonb_array_length(normalized->'booking_write_preview'->'blocked_reasons') > 0
    )
    OR (
      jsonb_typeof(send_blocked_reasons) = 'array'
      AND jsonb_array_length(send_blocked_reasons) > 0
    )
  )`);

  const fetchLimit = Math.min(MAX_LIMIT * 3, 600);
  params.push(fetchLimit);
  const limitIdx = params.length;

  const sql = `
    SELECT ${HANDOFF_QUEUE_SELECT_COLS}
      FROM guest_message_events
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${limitIdx}`;

  return { sql, params, outputLimit: f.limit || DEFAULT_LIMIT };
}

async function listGuestMessageHandoffQueue(pg, filters) {
  const { sql, params, outputLimit } = buildHandoffQueueCandidateQuery(filters);
  try {
    const r = await pg.query(sql, params);
    const items = (r.rows || [])
      .filter((row) => rowMatchesHandoffQueueCriteria(row))
      .slice(0, outputLimit)
      .map((row) => formatHandoffQueueItem(row))
      .filter(Boolean);
    return { items, table_missing: false };
  } catch (err) {
    if (isMissingGuestMessageEventsTable(err)) {
      return { items: [], table_missing: true };
    }
    throw err;
  }
}

module.exports = {
  DEFAULT_CLIENT_SLUG,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  INBOX_EVENT_SELECT_COLS,
  HANDOFF_QUEUE_SELECT_COLS,
  SAFE_ENV_GATE_REASONS,
  PREVIEW_QUEUE_REASON_RE,
  parseOptionalBoolean,
  clampMessageEventsLimit,
  parseMessageEventsQuery,
  parseHandoffQueueQuery,
  formatInboxMessageEvent,
  buildMessageEventsListQuery,
  listGuestMessageEvents,
  parseNormalizedField,
  rowMatchesHandoffQueueCriteria,
  previewBlockedReasonsQualify,
  meaningfulSendBlockedQualify,
  formatHandoffQueueItem,
  formatBookingWritePreviewSummary,
  formatBookingWriteResultSummary,
  buildHandoffQueueCandidateQuery,
  listGuestMessageHandoffQueue,
};
