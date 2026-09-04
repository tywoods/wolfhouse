'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { setConversationSpam } = require('./lib/staff-conversation-spam');
const { resumeConversation } = require('./lib/staff-bot-pause-sql');
const { listInboxSavedViewDeclarations } = require('./lib/staff-inbox-saved-views');

async function main() {
  const calls = [];
  const pg = {
    async query(sql) {
      calls.push(String(sql).trim());
      if (/^UPDATE conversations/.test(String(sql).trim())) {
        return { rows: [{ conversation_id: '11111111-1111-1111-1111-111111111111', is_spam: false, phone: null }] };
      }
      return { rows: [] };
    },
  };
  let pauseCalls = 0;
  let resumeInput = null;
  const result = await setConversationSpam(pg, {
    conversation_id: '11111111-1111-1111-1111-111111111111',
    client_slug: 'sunset',
    is_spam: false,
    actor: 'staff@test.invalid',
  }, async () => { pauseCalls++; }, async (_pg, input) => {
    resumeInput = input;
    return { row: { paused: false } };
  });

  assert.strictEqual(pauseCalls, 0, 'Spam off must not call pause');
  assert.deepStrictEqual(resumeInput, {
    client_slug: 'sunset',
    conversation_id: '11111111-1111-1111-1111-111111111111',
    guest_phone: null,
    resumed_by: 'staff@test.invalid',
    conversation_only: true,
  });
  assert.strictEqual(result.luna_paused, false);
  assert.deepStrictEqual(calls.slice(-1), ['COMMIT']);

  const resumeQueries = [];
  const globalPauseId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const conversationPauseId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const resumePg = {
    async query(sql, params) {
      resumeQueries.push({ sql: String(sql), params });
      if (/^\s*SELECT/.test(String(sql))) {
        return { rows: [{ id: conversationPauseId, paused: true }] };
      }
      if (/^\s*UPDATE/.test(String(sql))) {
        assert.strictEqual(params[0], conversationPauseId,
          `conversation-only resume must not clear global pause ${globalPauseId}`);
        return { rows: [{ id: conversationPauseId, paused: false }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const resumed = await resumeConversation(resumePg, {
    client_slug: 'sunset',
    conversation_id: '11111111-1111-1111-1111-111111111111',
    conversation_only: true,
    resumed_by: 'staff@test.invalid',
  });
  assert.strictEqual(resumed.row.paused, false);
  assert.strictEqual(resumeQueries.length, 2);
  assert.deepStrictEqual(resumeQueries[0].params, [
    'sunset', '11111111-1111-1111-1111-111111111111',
  ]);

  const rail = listInboxSavedViewDeclarations().filter((view) => view.rail !== false);
  const ids = rail.map((view) => view.id);
  assert.strictEqual(ids.indexOf('upcoming'), ids.indexOf('checked_in') + 1);
  assert.strictEqual(ids.indexOf('spam'), ids.indexOf('lesson_today') + 1);
  assert.strictEqual(rail.find((view) => view.id === 'spam').multiSelect, false);

  const ui = fs.readFileSync(path.join(__dirname, 'browser/inbox-thread.js'), 'utf8');
  assert.match(ui, /conv\.luna_paused = !!data\.luna_paused/);
  assert.match(ui, /updateLunaPauseUiInPlace\(targetEl, !!data\.luna_paused\)/);

  console.log('PASS SUNSET-SPAM-ORDER-LUNA-001');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
