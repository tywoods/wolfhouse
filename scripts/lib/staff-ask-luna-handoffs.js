/**
 * Phase 11j — Staff Ask Luna open / urgent handoff queries (read-only).
 *
 * Structured sources: staff_handoffs, conversations.needs_human (no chat logs).
 *
 * @module staff-ask-luna-handoffs
 */

'use strict';

const {
  getOpenHandoffsQuery,
  getHighPriorityHandoffsQuery,
  getNeedsHumanWithoutOpenHandoffQuery,
} = require('./staff-handoff-queries');

const OPEN_KEY = 'handoffs.open';
const URGENT_KEY = 'handoffs.urgent';
const HANDOFF_REGISTRY_KEYS = new Set([OPEN_KEY, URGENT_KEY]);

const ACTIVE_HANDOFF_STATUSES = "('open', 'assigned', 'waiting_guest')";

function normalizeHandoffsQuestionText(question) {
  let q = String(question || '').toLowerCase().trim();
  q = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  q = q.replace(/[''`´]/g, ' ');
  q = q.replace(/[?!.,;:()[\]{}""]/g, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  return q;
}

function matchesHandoffsOpenTopic(q) {
  if (/\b(handoff|needs?\s+(?:a\s+)?human|needs?\s+staff|staff\s+reply|waiting\s+on\s+staff|needs?\s+help|stuck|human\s+takeover|escalat)\b/.test(q)) {
    return true;
  }
  if (/\bwhich\s+guests?\s+need\s+(?:a\s+)?human\b/.test(q)) return true;
  if (/\bwhich\s+conversations?\s+(?:are\s+)?waiting\b/.test(q)) return true;
  if (/\bwho\s+needs\s+(?:a\s+)?(?:human|staff)\b/.test(q)) return true;
  if (/\bshow\s+open\s+handoffs?\b/.test(q)) return true;
  if (/\bany\s+conversations?\s+stuck\b/.test(q)) return true;
  return false;
}

function matchesHandoffsUrgentTopic(q) {
  if (/\bany\s+urgent\s+handoffs?\b/.test(q)) return true;
  if (/\burgent\s+handoffs?\b/.test(q)) return true;
  if (/\bhigh\s+priority\s+handoffs?\b/.test(q)) return true;
  if (q === URGENT_KEY) return true;
  return /\burgent\b/.test(q) && /\b(handoff|help|human|staff|conversation)\b/.test(q);
}

/**
 * @returns {{ intentKey: string, extraParams: object } | null}
 */
function resolveAskLunaHandoffsIntentKey(question, registryByKey) {
  const raw = String(question || '').trim();
  const rawLower = raw.toLowerCase();

  if (registryByKey && registryByKey.has(rawLower) && HANDOFF_REGISTRY_KEYS.has(rawLower)) {
    return { intentKey: rawLower, extraParams: {} };
  }

  const q = normalizeHandoffsQuestionText(question);

  if (matchesHandoffsUrgentTopic(q)) {
    return { intentKey: URGENT_KEY, extraParams: {} };
  }

  if (matchesHandoffsOpenTopic(q)) {
    return { intentKey: OPEN_KEY, extraParams: {} };
  }

  return null;
}

/**
 * Normalize staff_handoffs or needs_human conversation rows for formatting.
 * @param {object} row
 * @param {'handoff'|'needs_human'} source
 */
function normalizeHandoffRow(row, source) {
  const guestName = row.guest_name || row.display_name || null;
  const lastActivity = row.last_activity_at
    || row.updated_at
    || row.opened_at
    || null;

  return {
    source,
    handoff_id: row.handoff_id || null,
    guest_name: guestName,
    booking_code: row.booking_code || null,
    conversation_id: row.conversation_id || null,
    phone: row.phone || null,
    reason_code: row.reason_code || null,
    summary: row.summary || null,
    conversation_stage: row.conversation_stage || null,
    pending_action: row.pending_action || null,
    priority: row.priority || null,
    status: row.status || (source === 'needs_human' ? 'needs_human' : null),
    last_activity_at: lastActivity,
    check_in: row.check_in || null,
    check_out: row.check_out || null,
  };
}

/**
 * Fetch rows for Ask Luna handoff intents (read-only).
 * @param {import('pg').PoolClient} pg
 * @param {string} clientSlug
 * @param {string} intentKey
 * @returns {Promise<object[]>}
 */
async function fetchAskLunaHandoffRows(pg, clientSlug, intentKey) {
  if (intentKey === URGENT_KEY) {
    const result = await pg.query(getHighPriorityHandoffsQuery(), [clientSlug]);
    return result.rows.map((r) => normalizeHandoffRow(r, 'handoff'));
  }

  const [openRes, needsHumanRes] = await Promise.all([
    pg.query(getOpenHandoffsQuery(), [clientSlug]),
    pg.query(getNeedsHumanWithoutOpenHandoffQuery(), [clientSlug]),
  ]);

  const seenConversations = new Set();
  const merged = [];

  for (const row of openRes.rows) {
    const norm = normalizeHandoffRow(row, 'handoff');
    if (norm.conversation_id) seenConversations.add(norm.conversation_id);
    merged.push(norm);
  }

  for (const row of needsHumanRes.rows) {
    const norm = normalizeHandoffRow(row, 'needs_human');
    if (norm.conversation_id && seenConversations.has(norm.conversation_id)) continue;
    merged.push(norm);
  }

  return merged;
}

function humanizeToken(value) {
  if (!value) return '';
  return String(value).trim().replace(/_/g, ' ');
}

function formatHandoffReason(row) {
  const summary = row.summary ? String(row.summary).trim() : '';
  if (summary) return summary;
  if (row.reason_code) return humanizeToken(row.reason_code);
  if (row.pending_action && row.pending_action !== 'none') return humanizeToken(row.pending_action);
  if (row.conversation_stage) return humanizeToken(row.conversation_stage);
  return 'needs staff reply';
}

function formatShortDate(iso) {
  if (!iso) return '';
  const s = String(iso).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function formatActivityLabel(ts, refDate = new Date()) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;

  const ref = new Date(refDate);
  const todayStr = ref.toISOString().slice(0, 10);
  const actStr = d.toISOString().slice(0, 10);
  const yesterday = new Date(ref);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });

  if (actStr === todayStr) return `today ${time}`;
  if (actStr === yesterdayStr) return `yesterday ${time}`;
  return `${actStr} ${time}`;
}

function guestLabel(row) {
  if (row.guest_name) return String(row.guest_name).trim();
  if (row.phone) return String(row.phone).trim();
  if (row.conversation_id) return `conversation ${String(row.conversation_id).slice(0, 8)}`;
  return 'Guest';
}

function formatHandoffLine(row, index, refDate = new Date()) {
  const parts = [];
  parts.push(`${index}. ${guestLabel(row)}`);

  if (row.booking_code) {
    parts.push(`booking ${row.booking_code}`);
  } else {
    parts.push('no linked booking');
  }

  parts.push(formatHandoffReason(row));

  if (row.priority && (row.priority === 'urgent' || row.priority === 'high')) {
    parts.push(`priority ${row.priority}`);
  }

  const activity = formatActivityLabel(row.last_activity_at, refDate);
  if (activity) parts.push(`last activity ${activity}`);

  const checkIn = formatShortDate(row.check_in);
  const checkOut = formatShortDate(row.check_out);
  if (checkIn && checkOut) {
    parts.push(`stay ${checkIn}–${checkOut}`);
  }

  return parts.join(' — ');
}

/**
 * @param {string} intentKey
 * @param {object[]} rows
 * @param {{ refDate?: Date }} [ctx]
 */
function formatAskLunaHandoffsAnswer(intentKey, rows, ctx = {}) {
  const refDate = ctx.refDate || new Date();
  const isUrgent = intentKey === URGENT_KEY;
  const n = rows.length;

  if (n === 0) {
    return isUrgent
      ? 'No urgent handoffs are currently open.'
      : 'No conversations are currently waiting for staff.';
  }

  const lines = [];
  if (isUrgent) {
    lines.push(
      n === 1
        ? 'There is 1 urgent handoff.'
        : `There are ${n} urgent handoffs.`,
      '',
    );
  } else {
    lines.push(
      n === 1
        ? 'There is 1 conversation waiting for staff.'
        : `There are ${n} conversations waiting for staff.`,
      '',
    );
  }

  rows.forEach((row, i) => {
    lines.push(formatHandoffLine(row, i + 1, refDate));
  });

  lines.push('');
  lines.push(
    isUrgent
      ? `Total: ${n} urgent handoff${n !== 1 ? 's' : ''}.`
      : `Total: ${n} open handoff${n !== 1 ? 's' : ''}.`,
  );

  return lines.join('\n').trim();
}

/** Verifier: SQL uses structured handoff tables only. */
function getAskLunaHandoffsQuerySourceCheck() {
  return {
    usesStaffHandoffs: getOpenHandoffsQuery().includes('staff_handoffs'),
    usesHighPriority: getHighPriorityHandoffsQuery().includes("priority IN ('high', 'urgent')"),
    excludesResolved: getOpenHandoffsQuery().includes(ACTIVE_HANDOFF_STATUSES),
    usesNeedsHumanFlag: getNeedsHumanWithoutOpenHandoffQuery().includes('conv.needs_human = TRUE'),
    noMessagesTable: !getOpenHandoffsQuery().match(/FROM\s+messages/i),
  };
}

/** Verifier smoke: inline resolver for API routing tests. */
function getAskLunaHandoffsRoutingSmokeBlock() {
  const consts = `
const OPEN_KEY = ${JSON.stringify(OPEN_KEY)};
const URGENT_KEY = ${JSON.stringify(URGENT_KEY)};
const HANDOFF_REGISTRY_KEYS = new Set([OPEN_KEY, URGENT_KEY]);
`;
  const fns = [
    normalizeHandoffsQuestionText,
    matchesHandoffsOpenTopic,
    matchesHandoffsUrgentTopic,
    resolveAskLunaHandoffsIntentKey,
  ].map((fn) => fn.toString()).join('\n');
  return `${consts}\n${fns}`;
}

module.exports = {
  OPEN_KEY,
  URGENT_KEY,
  HANDOFF_REGISTRY_KEYS,
  ACTIVE_HANDOFF_STATUSES,
  resolveAskLunaHandoffsIntentKey,
  fetchAskLunaHandoffRows,
  formatAskLunaHandoffsAnswer,
  normalizeHandoffRow,
  formatHandoffReason,
  getAskLunaHandoffsQuerySourceCheck,
  getAskLunaHandoffsRoutingSmokeBlock,
};
