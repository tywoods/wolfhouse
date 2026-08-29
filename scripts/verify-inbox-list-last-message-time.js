#!/usr/bin/env node
/**
 * Inbox list timestamp = latest message time (Bug Finder #15 / SUNSET-TODO).
 *
 * Repro (before): conversations.updated_at was projected as last_activity and
 * used for ORDER BY. A non-message write (metadata, needs_human, link-guest)
 * could bump updated_at to "Aug 5" while the newest messages.created_at stayed
 * "Jul 14" — list label + triage order disagreed with the thread.
 *
 * After: last_activity / sort / keyset cursor use
 * COALESCE(latest messages.created_at, conv.updated_at).
 *
 * No DB, no network — SQL shape + pure clock selection only.
 */
'use strict';

const {
  getConversationInboxQuery,
  conversationInboxCursorClause,
  CONVERSATION_INBOX_LAST_ACTIVITY_SQL,
  CONVERSATION_INBOX_CURSOR_FIELDS,
} = require('./lib/staff-conversation-queries');

let failed = 0;
function assert(label, cond) {
  if (cond) {
    console.log('  OK  ' + label);
    return;
  }
  failed += 1;
  console.error('  FAIL  ' + label);
}

/** Same relative/absolute rules as portal fmtTs — month/day for older rows. */
function fmtTsLikePortal(ts, now) {
  if (!ts) return '';
  const d = new Date(ts);
  const ref = now || new Date();
  const diffMs = ref - d;
  if (diffMs < 60000) return 'just now';
  if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago';
  if (diffMs < 86400000) return Math.floor(diffMs / 3600000) + 'h ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** List clock: prefer latest message; fall back when the thread has no rows. */
function resolveListLastActivity(row) {
  return row.last_message_at || row.updated_at || null;
}

function sortByLastActivityDesc(rows) {
  return rows.slice().sort((a, b) => {
    const ta = Date.parse(resolveListLastActivity(a));
    const tb = Date.parse(resolveListLastActivity(b));
    if (tb !== ta) return tb - ta;
    return String(a.conversation_id).localeCompare(String(b.conversation_id));
  });
}

console.log('verify-inbox-list-last-message-time');

{
  const sql = getConversationInboxQuery({});
  const flat = sql.replace(/\s+/g, ' ');
  assert('exports the shared last-activity expression',
    CONVERSATION_INBOX_LAST_ACTIVITY_SQL === 'COALESCE(lm.last_message_at, conv.updated_at)');
  assert('SELECT last_activity uses latest message coalesce',
    /COALESCE\(lm\.last_message_at, conv\.updated_at\)\s+AS last_activity/i.test(sql));
  assert('does not project bare conv.updated_at AS last_activity',
    !/conv\.updated_at\s+AS last_activity/i.test(sql));
  assert('joins messages for latest created_at',
    /LEFT JOIN LATERAL\s*\(\s*SELECT m\.created_at AS last_message_at\s+FROM messages m/i.test(flat));
  assert('ORDER BY uses the same last-activity expression',
    /ORDER BY\s+COALESCE\(lm\.last_message_at, conv\.updated_at\) DESC\s*,\s*conv\.id ASC\s*LIMIT 200/i.test(flat));
  assert('does not ORDER BY bare conv.updated_at as the list sort',
    !/ORDER BY\s+conv\.updated_at DESC\s*,\s*conv\.id ASC/i.test(flat));
  assert('cursor fields stay last_activity + conversation_id',
    CONVERSATION_INBOX_CURSOR_FIELDS.join(',') === 'last_activity,conversation_id');
  const cursor = conversationInboxCursorClause(3);
  assert('keyset cursor compares the coalesce, not bare updated_at',
    cursor.includes('COALESCE(lm.last_message_at, conv.updated_at) < $3::timestamptz')
    && cursor.includes('COALESCE(lm.last_message_at, conv.updated_at) = $3::timestamptz')
    && !/conv\.updated_at\s*</.test(cursor));
}

{
  // Bug Finder #15 fixture: Simulate Guest — list showed Aug 5, thread newest Jul 14.
  const now = new Date('2026-08-14T12:00:00.000Z');
  const simulateGuest = {
    conversation_id: 'sim-guest',
    updated_at: '2026-08-05T15:00:00.000Z',
    last_message_at: '2026-07-14T18:30:00.000Z',
  };
  const beforeLabel = fmtTsLikePortal(simulateGuest.updated_at, now);
  const afterLabel = fmtTsLikePortal(resolveListLastActivity(simulateGuest), now);
  assert('before (updated_at) label is Aug 5 — the wrong list clock', beforeLabel === 'Aug 5');
  assert('after (latest message) label is Jul 14 — matches thread newest', afterLabel === 'Jul 14');
  assert('resolved last_activity equals last_message_at when present',
    resolveListLastActivity(simulateGuest) === simulateGuest.last_message_at);

  const emptyThread = {
    conversation_id: 'empty',
    updated_at: '2026-08-05T15:00:00.000Z',
    last_message_at: null,
  };
  assert('threads with no messages still fall back to updated_at',
    resolveListLastActivity(emptyThread) === emptyThread.updated_at);

  const fresher = {
    conversation_id: 'fresh',
    updated_at: '2026-07-01T00:00:00.000Z',
    last_message_at: '2026-08-13T09:00:00.000Z',
  };
  const staleBump = {
    conversation_id: 'stale-bump',
    updated_at: '2026-08-14T11:00:00.000Z',
    last_message_at: '2026-07-10T09:00:00.000Z',
  };
  const sortedWrong = [staleBump, fresher].slice().sort(
    (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
  );
  const sortedRight = sortByLastActivityDesc([staleBump, fresher]);
  assert('before: updated_at sort puts metadata-bumped stale thread first',
    sortedWrong[0].conversation_id === 'stale-bump');
  assert('after: message-time sort puts the real newest message first',
    sortedRight[0].conversation_id === 'fresh'
    && sortedRight[1].conversation_id === 'stale-bump');
}

if (failed) {
  console.error('\n' + failed + ' assertion(s) failed');
  process.exit(1);
}
console.log('\nAll assertions passed.');
