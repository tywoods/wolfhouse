'use strict';

/**
 * verify:luna-needs-human-no-pause
 *
 * TDD gate — Sunset-only: flagging Needs Human sets conversations.needs_human
 * (Inbox) but must NOT write bot_pause_states / pause Luna.
 * Wolfhouse (and any non-sunset client) MUST keep the prior coupling:
 * needs_human=true → pauseConversation / effective conversation pause.
 *
 * Run:
 *   node scripts/verify-luna-needs-human-no-pause.js
 */

const fs = require('fs');
const path = require('path');
const {
  markConversationNeedsHuman,
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
        && !/UPDATE/i.test(s)
        && !/bot_pause_states/i.test(s)) {
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
        calls.updates.push({ sql: s, params: params ? [...params] : [] });
        return {
          rows: [{ conversation_id: CONV_ID, needs_human: true }],
        };
      }
      if (/FROM staff_handoffs/i.test(s) && /SELECT/i.test(s)) {
        return { rows: [] };
      }
      if (/INSERT INTO staff_handoffs/i.test(s)) {
        calls.inserts.push({ table: 'staff_handoffs', params: params ? [...params] : [] });
        return { rows: [{ id: 'handoff-1', reason_code: params[3], status: 'open' }] };
      }
      if (/INSERT INTO bot_pause_states/i.test(s)) {
        calls.pauseInserts.push({ params: params ? [...params] : [] });
        return {
          rows: [{
            id: 'pause-1',
            client_slug: params[0],
            guest_phone: params[1],
            conversation_id: params[2],
            paused: true,
            pause_reason: params[5],
            paused_by: params[6],
            paused_at: new Date().toISOString(),
          }],
        };
      }
      if (/FROM bot_pause_states/i.test(s)) {
        return { rows: [] };
      }
      if (/SELECT conv\.phone/i.test(s)) {
        return { rows: [{ phone: '+34600111222' }] };
      }
      if (/notification|notify/i.test(s)) return { rows: [] };
      return { rows: [] };
    },
  };
}

async function main() {
  console.log('\nverify:luna-needs-human-no-pause — Sunset no-pause; Wolfhouse keeps pause\n');

  const persistSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/luna-guest-handoff-persist.js'), 'utf8');
  const markFn = persistSrc.slice(
    persistSrc.indexOf('async function markConversationNeedsHuman'),
    persistSrc.indexOf('async function clearStaffNeedsHuman'),
  );
  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const gateFn = apiSrc.slice(
    apiSrc.indexOf('async function checkGuestAutomationPauseState'),
    apiSrc.indexOf('async function handleBotPauseStateGet') > 0
      ? apiSrc.indexOf('async function handleBotPauseStateGet')
      : apiSrc.indexOf('async function checkGuestAutomationPauseState') + 5000,
  );

  console.log('[A] Source: pause coupling is Sunset-gated');
  assert('markConversationNeedsHuman still references pauseConversation',
    /pauseConversation\s*\(/.test(markFn),
    'Wolfhouse pause coupling missing — pauseConversation never called');
  assert('mark pause path is gated on client_slug === sunset (no-pause for Sunset only)',
    /clientSlug\s*===\s*['"]sunset['"]|!==\s*['"]sunset['"]/.test(markFn)
    && /pauseConversation\s*\(/.test(markFn),
    'needs Sunset client gate around pause');
  assert('gate restores conversations_needs_human for non-sunset',
    /conversations_needs_human/.test(gateFn)
    && /clientSlug\s*===\s*['"]sunset['"]|!==\s*['"]sunset['"]/.test(gateFn),
    'gate must keep conversations_needs_human behind a Sunset skip');

  console.log('\n[B] GREEN: sunset + needs_human → no pause');
  const pgSunset = makePg();
  const sunset = await markConversationNeedsHuman(pgSunset, {
    conversation_id: CONV_ID,
    client_slug: 'sunset',
    reason: 'human_requested',
  }, { skip_notify: true });
  assert('sunset mark ok', sunset && sunset.ok === true, JSON.stringify(sunset));
  assert('sunset needs_human true', sunset.needs_human === true, JSON.stringify(sunset));
  assert('sunset conversation_paused false', sunset.conversation_paused === false, JSON.stringify(sunset));
  assert('sunset pause_state null / not paused',
    !sunset.pause_state || sunset.pause_state.paused !== true,
    JSON.stringify(sunset.pause_state));
  assert('sunset conversations UPDATE wrote needs_human',
    pgSunset.calls.updates.length >= 1, JSON.stringify(pgSunset.calls.updates));
  assert('sunset no bot_pause_states INSERT',
    pgSunset.calls.pauseInserts.length === 0, JSON.stringify(pgSunset.calls.pauseInserts));
  assert('sunset staff_handoff for inbox',
    sunset.staff_handoff && (sunset.staff_handoff.id || sunset.staff_handoff.error),
    JSON.stringify(sunset.staff_handoff));

  console.log('\n[C] GREEN: wolfhouse-somo + needs_human → pause (prior behavior)');
  const pgWh = makePg();
  const wolf = await markConversationNeedsHuman(pgWh, {
    conversation_id: CONV_ID,
    client_slug: 'wolfhouse-somo',
    reason: 'human_requested',
  }, { skip_notify: true });
  assert('wolfhouse mark ok', wolf && wolf.ok === true, JSON.stringify(wolf));
  assert('wolfhouse needs_human true', wolf.needs_human === true, JSON.stringify(wolf));
  assert('wolfhouse conversation_paused true',
    wolf.conversation_paused === true, JSON.stringify(wolf));
  assert('wolfhouse pause_state.paused true',
    wolf.pause_state && wolf.pause_state.paused === true,
    JSON.stringify(wolf.pause_state));
  assert('wolfhouse conversations UPDATE wrote needs_human',
    pgWh.calls.updates.length >= 1, JSON.stringify(pgWh.calls.updates));
  assert('wolfhouse wrote bot_pause_states',
    pgWh.calls.pauseInserts.length >= 1, JSON.stringify(pgWh.calls.pauseInserts));
  assert('wolfhouse staff_handoff for inbox',
    wolf.staff_handoff && (wolf.staff_handoff.id || wolf.staff_handoff.error),
    JSON.stringify(wolf.staff_handoff));

  console.log(`\nTotals: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
