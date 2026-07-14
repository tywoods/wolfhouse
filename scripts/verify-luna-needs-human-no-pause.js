'use strict';

/**
 * verify:luna-needs-human-no-pause
 *
 * TDD gate — flagging Needs Human sets conversations.needs_human (Inbox)
 * but must NOT write bot_pause_states / conversation_paused. Luna stays active.
 * Staff manual Pause remains a separate control.
 *
 * Run:
 *   node scripts/verify-luna-needs-human-no-pause.js
 */

const fs = require('fs');
const path = require('path');
const {
  resolveAndMarkConversationNeedsHuman,
} = require('./lib/luna-guest-handoff-persist');

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

const ROOT = path.resolve(__dirname, '..');
const CONV_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makePg() {
  const calls = { updates: [], inserts: [], pauseInserts: [] };
  return {
    calls,
    query: async (sql, params) => {
      const s = String(sql);
      if (/SELECT[\s\S]*needs_human[\s\S]*FROM conversations/i.test(s)
        && /JOIN clients/i.test(s)
        && !/UPDATE/i.test(s)) {
        return {
          rows: [{
            id: CONV_ID,
            conversation_id: CONV_ID,
            needs_human: false,
            phone: '+34600111222',
            display_name: 'Test Guest',
            metadata: {},
          }],
        };
      }
      if (/UPDATE conversations[\s\S]*needs_human\s*=\s*TRUE/i.test(s)) {
        calls.updates.push({ sql: s, params });
        return {
          rows: [{ conversation_id: CONV_ID, needs_human: true }],
        };
      }
      if (/FROM staff_handoffs/i.test(s) && /SELECT/i.test(s)) {
        return { rows: [] };
      }
      if (/INSERT INTO staff_handoffs/i.test(s)) {
        calls.inserts.push({ table: 'staff_handoffs', params });
        return { rows: [{ id: 'handoff-1', reason_code: params[3], status: 'open' }] };
      }
      if (/INSERT INTO bot_pause_states/i.test(s) || /pauseConversation/i.test(s)) {
        calls.pauseInserts.push({ params });
        return { rows: [{ id: 'pause-1' }] };
      }
      if (/FROM bot_pause_states/i.test(s)) {
        return { rows: [] };
      }
      if (/notification|notify/i.test(s)) return { rows: [] };
      return { rows: [] };
    },
  };
}

async function main() {
  console.log('\nverify:luna-needs-human-no-pause — Needs Human does not pause Luna\n');

  console.log('[A] Source: handoff persist must not auto-pause');
  const persistSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/luna-guest-handoff-persist.js'), 'utf8');
  const resolveFn = persistSrc.slice(
    persistSrc.indexOf('async function resolveAndMarkConversationNeedsHuman'),
    persistSrc.indexOf('async function clearStaffNeedsHuman'),
  );
  assert('resolveAndMark does NOT call pauseConversation',
    !/pauseConversation\s*\(/.test(resolveFn),
    'still couples pause on needs_human');
  assert('resolveAndMark documents Needs Human without pausing Luna',
    /must NOT pause Luna|Inbox \/ handoff flag only|does not pause/i.test(resolveFn));

  console.log('\n[B] Source: automation gate must not treat needs_human as pause');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const gateFn = apiSrc.slice(
    apiSrc.indexOf('async function checkGuestAutomationPauseState'),
    apiSrc.indexOf('async function handleBotPauseStateGet') > 0
      ? apiSrc.indexOf('async function handleBotPauseStateGet')
      : apiSrc.indexOf('async function checkGuestAutomationPauseState') + 4000,
  );
  // Prefer: no early-return bot_paused from conversations_needs_human
  assert('gate does not set bot_paused from needs_human alone',
    !/source:\s*'conversations_needs_human'/.test(gateFn)
    && !/source:\s*"conversations_needs_human"/.test(gateFn),
    'still returns conversations_needs_human as effective pause');

  console.log('\n[C] Unit: flagging needs_human persists flag, no bot_pause_states write');
  // Intercept require of staff-bot-pause-sql if still coupled
  const pg = makePg();
  const result = await resolveAndMarkConversationNeedsHuman(pg, {
    conversation_id: CONV_ID,
    client_slug: 'sunset',
    phone: '+34600111222',
    reason: 'human_requested',
    skip_notify: true,
  });
  assert('mark ok', result && result.ok === true, JSON.stringify(result));
  assert('needs_human true', result.needs_human === true, JSON.stringify(result));
  assert('conversation_paused false', result.conversation_paused === false, JSON.stringify(result));
  assert('pause_state null / not paused',
    !result.pause_state || result.pause_state.paused !== true,
    JSON.stringify(result.pause_state));
  assert('conversations UPDATE wrote needs_human',
    pg.calls.updates.length >= 1, JSON.stringify(pg.calls.updates));
  assert('no bot_pause_states INSERT',
    pg.calls.pauseInserts.length === 0, JSON.stringify(pg.calls.pauseInserts));
  assert('staff_handoff surfaced for inbox',
    result.staff_handoff && (result.staff_handoff.id || result.staff_handoff.error),
    JSON.stringify(result.staff_handoff));

  console.log(`\nTotals: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
