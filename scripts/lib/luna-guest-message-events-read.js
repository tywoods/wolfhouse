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

module.exports = {
  DEFAULT_CLIENT_SLUG,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  INBOX_EVENT_SELECT_COLS,
  parseOptionalBoolean,
  clampMessageEventsLimit,
  parseMessageEventsQuery,
  formatInboxMessageEvent,
  buildMessageEventsListQuery,
  listGuestMessageEvents,
};
