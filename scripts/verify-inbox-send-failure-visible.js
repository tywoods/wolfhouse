#!/usr/bin/env node
'use strict';

/**
 * Writer → getConversationDetailQuery() result → Staff-visible reason.
 * Newest send-failure reason + THAT handoff's booking; hold booking stays
 * on the booking card; unrelated urgent handoff is kept.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { markConversationNeedsHuman } = require('../scripts/lib/luna-guest-handoff-persist');
const { getConversationDetailQuery } = require('../scripts/lib/staff-conversation-queries');

const CONV_ID = '11111111-1111-4111-8111-111111111111';
const REASON = 'whatsapp_send_failed:WH-20270310-13389959';
const BOOKING = 'WH-20270310-13389959';
const HOLD_BOOKING = 'WH-HOLD-OTHER';
const HUMAN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOLD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function loadReasonText() {
  const src = fs.readFileSync(path.join(__dirname, 'browser/inbox-luna-mode.js'), 'utf8');
  const start = src.indexOf('function inboxNeedsHumanReasonCode');
  const end = src.indexOf('function inboxNeedsHumanRaiseHtml');
  assert.ok(start >= 0 && end > start, 'inbox reason renderer present');
  const sandbox = {
    t: (_k, fb) => fb || '',
    conversationHasOpenHandoff: () => true,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${src.slice(start, end)}\nthis.inboxNeedsHumanReasonText = inboxNeedsHumanReasonText;`,
    sandbox,
  );
  return sandbox.inboxNeedsHumanReasonText;
}

function aliasesFromDetailSql(sql) {
  const head = String(sql).split(/FROM conversations/i)[0];
  const names = [];
  for (const line of head.split('\n')) {
    const as = line.match(/\bAS\s+([a-z_][a-z0-9_]*)/i);
    if (as) {
      names.push(as[1]);
      continue;
    }
    const bare = line.match(/\b(?:[a-z_][a-z0-9_]*\.)([a-z_][a-z0-9_]*)\s*,?\s*$/i);
    if (bare) names.push(bare[1]);
  }
  return names;
}

function sortQueue(rows) {
  const rank = { urgent: 0, high: 1, normal: 2 };
  return rows.slice().sort((a, b) => {
    const pa = rank[a.priority] != null ? rank[a.priority] : 3;
    const pb = rank[b.priority] != null ? rank[b.priority] : 3;
    if (pa !== pb) return pa - pb;
    return String(b.updated_at).localeCompare(String(a.updated_at));
  });
}

function sortDisplay(rows) {
  return rows.slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

function executeDetailSql(db, sql) {
  assert.equal(sql, getConversationDetailQuery(), 'must run production detail SQL');
  const aliases = aliasesFromDetailSql(sql);
  const hold = db.bookings.find((b) => b.id === db.conversation.current_hold_booking_id) || null;
  const queue = sortQueue(db.staff_handoffs)[0] || null;
  const shown = sortDisplay(db.staff_handoffs)[0] || null;
  const shownMeta = (shown && shown.metadata) || {};
  const row = {
    conversation_id: db.conversation.conversation_id,
    needs_human: db.conversation.needs_human,
    booking_id: hold ? hold.id : null,
    booking_code: hold ? hold.booking_code : null,
    handoff_id: queue ? queue.id : null,
    handoff_reason: shown ? shown.reason_code : null,
    handoff_priority: queue ? queue.priority : null,
    handoff_status: queue ? queue.status : null,
    handoff_summary: shown ? shown.summary : null,
    handoff_booking_code: shownMeta.booking_code || null,
  };
  const out = {};
  for (const name of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, name)) out[name] = row[name];
  }
  return { rows: [out] };
}

function makeDbPg() {
  const db = {
    conversation: {
      conversation_id: CONV_ID,
      needs_human: true,
      phone: '+491****1111',
      display_name: 'Kathi',
      current_hold_booking_id: HOLD_ID,
      metadata: { needs_human_reason: 'human_requested' },
    },
    bookings: [{ id: HOLD_ID, booking_code: HOLD_BOOKING }],
    staff_handoffs: [{
      id: HUMAN_ID,
      conversation_id: CONV_ID,
      reason_code: 'human_requested',
      priority: 'urgent',
      status: 'open',
      summary: 'Guest asked for a human',
      opened_at: '2026-10-01T10:00:00.000Z',
      updated_at: '2026-10-01T10:00:00.000Z',
      metadata: {},
    }],
    pause: null,
  };

  return {
    db,
    query: async (sql, params) => {
      const s = String(sql);
      const p = params || [];
      if (s === getConversationDetailQuery() || s === getConversationDetailQuery({ includeEmailSubject: false })) {
        return executeDetailSql(db, getConversationDetailQuery());
      }
      if (/UPDATE conversations/i.test(s)) {
        db.conversation.needs_human = true;
        db.conversation.metadata = {
          ...db.conversation.metadata,
          needs_human_reason: p[2],
          luna_handoff_reason: p[2],
          handoff_booking_code: p[4] || null,
        };
        return { rows: [{ ...db.conversation, metadata: { ...db.conversation.metadata } }] };
      }
      if (/SELECT[\s\S]*FROM conversations/i.test(s) && !/UPDATE/i.test(s) && !/staff_handoffs/i.test(s) && !/bot_pause/i.test(s) && !/current_hold/i.test(s)) {
        return { rows: [{ ...db.conversation, metadata: { ...db.conversation.metadata } }] };
      }
      if (/UPDATE staff_handoffs/i.test(s)) {
        const row = db.staff_handoffs.find((h) => h.id === p[1]);
        if (!row) return { rows: [] };
        row.reason_code = p[2];
        row.summary = p[3];
        row.updated_at = new Date().toISOString();
        row.metadata = { ...(row.metadata || {}), booking_code: p[6] || null };
        return { rows: [{ id: row.id, reason_code: row.reason_code, status: row.status }] };
      }
      if (/INSERT INTO staff_handoffs/i.test(s)) {
        const row = {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          conversation_id: CONV_ID,
          reason_code: p[3],
          priority: 'normal',
          status: 'open',
          summary: p[4],
          opened_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          metadata: { booking_code: p[7] || null },
        };
        db.staff_handoffs.push(row);
        return { rows: [{ id: row.id, reason_code: row.reason_code, status: row.status }] };
      }
      if (/FROM staff_handoffs/i.test(s) && /SELECT/i.test(s)) {
        const ordered = db.staff_handoffs.slice().sort((a, b) => {
          if (p[2] && a.reason_code === p[2] && b.reason_code !== p[2]) return -1;
          if (p[2] && b.reason_code === p[2] && a.reason_code !== p[2]) return 1;
          return String(b.opened_at).localeCompare(String(a.opened_at));
        });
        return { rows: ordered.map((h) => ({ id: h.id, reason_code: h.reason_code, status: h.status })) };
      }
      if (/UPDATE bot_pause_states/i.test(s) || /INSERT INTO bot_pause_states/i.test(s)) {
        db.pause = { id: 'pause-1', conversation_id: CONV_ID, paused: true, paused_by: 'luna_flag_needs_human' };
        return { rows: [db.pause] };
      }
      if (/bot_pause_states/i.test(s)) {
        return { rows: db.pause ? [db.pause] : [] };
      }
      return { rows: [] };
    },
  };
}

async function main() {
  const reasonText = loadReasonText();
  const pg = makeDbPg();
  await markConversationNeedsHuman(pg, {
    conversation_id: CONV_ID,
    client_slug: 'wolfhouse-somo',
    reason: REASON,
    booking_code: BOOKING,
  }, { skip_notify: true });

  const human = pg.db.staff_handoffs.find((h) => h.id === HUMAN_ID);
  assert.ok(human, 'unrelated human_requested handoff is kept');
  assert.equal(human.reason_code, 'human_requested');
  assert.equal(human.priority, 'urgent');

  const detailSql = getConversationDetailQuery();
  const detail = await pg.query(detailSql, ['wolfhouse-somo', CONV_ID]);
  const row = detail.rows[0];
  assert.ok(row, 'detail query returned a row');
  assert.equal(row.booking_code, HOLD_BOOKING, 'booking card identity stays the hold booking');
  assert.equal(row.handoff_priority, 'urgent', 'queue priority stays on the unrelated handoff');
  assert.match(String(row.handoff_reason || ''), /whatsapp_send_failed/);
  assert.equal(row.handoff_booking_code, BOOKING, 'shown booking is bound to the selected handoff');

  const shown = reasonText(row);
  assert.match(shown, /whatsapp send failed|whatsapp_send_failed/i);
  assert.match(shown, /WH-20270310-13389959/);
  assert.doesNotMatch(shown, /WH-HOLD-OTHER/);

  console.log('ok detail query shows send-failure booking, not hold booking');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
