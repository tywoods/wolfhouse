#!/usr/bin/env node
'use strict';

/**
 * Writer → production Inbox view → Staff-visible reason.
 * An older urgent human_requested must stay; the newest send-failure
 * reason + booking must be what Staff see.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { markConversationNeedsHuman } = require('../scripts/lib/luna-guest-handoff-persist');
const { projectInboxHandoffView } = require('../scripts/lib/staff-conversation-queries');

const CONV_ID = '11111111-1111-4111-8111-111111111111';
const REASON = 'whatsapp_send_failed:WH-20270310-13389959';
const BOOKING = 'WH-20270310-13389959';
const HUMAN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

function makeDbPg() {
  const db = {
    conversation: {
      conversation_id: CONV_ID,
      needs_human: true,
      phone: '+491111111',
      display_name: 'Kathi',
      metadata: { needs_human_reason: 'human_requested' },
    },
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
      if (/SELECT[\s\S]*FROM conversations/i.test(s) && !/UPDATE/i.test(s) && !/staff_handoffs/i.test(s) && !/bot_pause/i.test(s)) {
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

  const view = projectInboxHandoffView(pg.db.staff_handoffs);
  assert.equal(view.handoff_priority, 'urgent', 'queue priority stays on the unrelated handoff');
  const shown = reasonText({
    needs_human: true,
    handoff_reason: view.handoff_reason,
    booking_code: view.booking_code,
    handoff_status: 'open',
  });
  assert.match(String(view.handoff_reason || ''), /whatsapp_send_failed/);
  assert.match(shown, /whatsapp send failed|whatsapp_send_failed/i);
  assert.match(shown, /WH-20270310-13389959/);
  assert.match(String(view.booking_code || ''), /WH-20270310-13389959/);

  console.log('ok inbox shows latest send-failure and keeps unrelated urgent handoff');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
