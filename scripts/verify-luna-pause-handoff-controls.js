#!/usr/bin/env node
'use strict';

/**
 * verify-luna-pause-handoff-controls
 *
 * Offline + unit gates for Luna pause / handoff controls.
 * Run: node scripts/verify-luna-pause-handoff-controls.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PAUSE_PY = path.join(ROOT, 'docker/hermes-staging/wolfhouse/pause_gate.py');
const BURST_PY = path.join(ROOT, 'docker/hermes-staging/wolfhouse/whatsapp_burst_coalesce.py');
const PATCH_PY = path.join(ROOT, 'docker/hermes-staging/apply_gateway_patches.py');
const PLUGIN = path.join(ROOT, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py');
const PAUSE_SQL = path.join(ROOT, 'scripts/lib/staff-bot-pause-sql.js');
const HANDOFF = path.join(ROOT, 'scripts/lib/luna-guest-handoff-persist.js');
const STAFF = path.join(ROOT, 'scripts/staff-query-api.js');
const PY_TEST = path.join(ROOT, 'docker/hermes-staging/wolfhouse/test_pause_gate.py');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

async function main() {
  console.log('\nverify-luna-pause-handoff-controls — pause + handoff gates\n');

  console.log('[1] Hermes pause_gate tenant + roles');
  const pauseSrc = read(PAUSE_PY);
  assert('pause_gate prefers LUNA_CLIENT_SLUG', /LUNA_CLIENT_SLUG/.test(pauseSrc));
  assert(
    'pause_gate enables sunset-luna / *-luna roles',
    /endswith\("-luna"\)|_is_luna_runtime/.test(pauseSrc),
  );
  assert('pause_gate calls check-guest-automation-gate', /check-guest-automation-gate/.test(pauseSrc));
  assert('pause_gate has short active TTL (<=2s)', /_ACTIVE_TTL_SEC\s*=\s*[12](\.\d+)?/.test(pauseSrc));
  assert(
    'pause_gate fail-closed on lookup failure',
    /pause_gate_lookup_failed/.test(pauseSrc) && /paused\s*=\s*True/.test(pauseSrc),
  );
  assert('pause_gate send helper force_refresh', /whatsapp_send_blocked[\s\S]{0,200}force_refresh\s*=\s*True/.test(pauseSrc));
  assert(
    'pause_gate webhook preserves Inbox mirror path',
    /Do not short-circuit|Inbox mirroring still runs/.test(pauseSrc),
  );
  assert('pause_gate cache keys include client_slug', /f"\{slug\}\|\{/.test(pauseSrc));

  console.log('\n[2] Burst coalescer pause suppress before agent');
  const burstSrc = read(BURST_PY);
  assert('coalescer checks pause before agent', /_guest_paused_before_agent|guest_paused_for_event/.test(burstSrc));
  assert('coalescer logs paused_suppress', /whatsapp_burst_paused_suppress|paused_suppressions/.test(burstSrc));
  assert('coalescer still mirrors raw inbound', /_mirror_raw_inbound/.test(burstSrc));

  console.log('\n[3] Gateway send-time pause suppress');
  const patchSrc = read(PATCH_PY);
  assert('send path calls whatsapp_send_blocked', /whatsapp_send_blocked/.test(patchSrc));
  assert('send suppress raw response marker', /suppressed_guest_automation_paused/.test(patchSrc));

  console.log('\n[4] Staff bot_pause_states phone + conversation lookup');
  const pauseSql = read(PAUSE_SQL);
  assert('resolveConversationGuestPhone exported', /resolveConversationGuestPhone/.test(pauseSql));
  assert('pauseConversation resolves phone from conversation', /resolvedPhone[\s\S]{0,120}resolveConversationGuestPhone/.test(pauseSql));
  assert(
    'getPauseState phone lookup includes conversation-scoped rows',
    /EXISTS[\s\S]{0,250}conversations conv/.test(pauseSql),
  );
  assert(
    'getPauseState no longer requires conversation_id IS NULL for phone match',
    !/guest_phone = \$2\s*\n\s*AND conversation_id IS NULL/.test(pauseSql),
  );

  console.log('\n[5] Handoff persists needs_human, pause, staff_handoffs');
  const handoffSrc = read(HANDOFF);
  assert('handoff couples pauseConversation', /pauseConversation/.test(handoffSrc));
  assert('handoff inserts staff_handoffs', /INSERT INTO staff_handoffs/.test(handoffSrc));
  assert('handoff returns conversation_paused', /conversation_paused/.test(handoffSrc));
  assert('handoff documents resolve ≠ auto-resume', /does NOT auto-resume/i.test(handoffSrc));

  console.log('\n[6] flag_needs_human tenant binding');
  const pluginSrc = read(PLUGIN);
  const fn = pluginSrc.match(/def flag_needs_human\([\s\S]*?\n(?=def |\n# )/);
  assert('flag_needs_human defined', !!fn);
  const fnBody = fn ? fn[0] : '';
  assert(
    'flag_needs_human does not setdefault wolfhouse-somo',
    !/setdefault\("client_slug",\s*"wolfhouse-somo"\)/.test(fnBody),
  );
  assert('flag_needs_human pops model client_slug', /payload\.pop\("client_slug"/.test(fnBody));
  assert('flag_needs_human pops model conversation_id', /payload\.pop\("conversation_id"/.test(fnBody));
  assert('flag_needs_human requires LUNA_CLIENT_SLUG', /LUNA_CLIENT_SLUG/.test(fnBody));
  assert('flag_needs_human prefers session phone', /_session_guest_phone/.test(fnBody));

  console.log('\n[7] Staff API effective pause routes');
  const staffSrc = read(STAFF);
  assert('effective-pause-state route exists', /\/staff\/bot\/effective-pause-state/.test(staffSrc));
  assert('handleBotEffectivePauseState defined', /handleBotEffectivePauseState/.test(staffSrc));
  assert('checkGuestAutomationPauseState reads needs_human', /conversations_needs_human/.test(staffSrc));
  assert('portal pause switch uses conversation_id', /wireLunaPauseSwitch[\s\S]{0,500}conversation_id:\s*convId/.test(staffSrc));
  assert('portal pause rolls back switch on failure', /sw\.checked = !wantPaused/.test(staffSrc));

  console.log('\n[8] Unit: pauseConversation stores resolved phone');
  const pauseMod = require('./lib/staff-bot-pause-sql');
  const fakePg = {
    async query(sql, params) {
      if (/SELECT conv\.phone/.test(sql)) {
        return { rows: [{ phone: '+34600111222' }] };
      }
      if (/FROM bot_pause_states/.test(sql) && !/INSERT/.test(sql)) {
        return { rows: [] };
      }
      if (/INSERT INTO bot_pause_states/.test(sql)) {
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
            metadata: {},
          }],
        };
      }
      return { rows: [] };
    },
  };
  try {
    const unitResult = await pauseMod.pauseConversation(fakePg, {
      client_slug: 'sunset',
      conversation_id: '11111111-1111-4111-8111-111111111111',
      paused_by: 'staff-test',
      pause_reason: 'unit',
    });
    assert('pauseConversation resolved guest_phone', unitResult.guest_phone === '+34600111222');
    assert(
      'pauseConversation stored phone on row',
      !!(unitResult.row && unitResult.row.guest_phone === '+34600111222'),
    );
  } catch (err) {
    assert('pauseConversation unit ran', false, err.message);
  }

  console.log('\n[9] Python pause_gate unit tests');
  assert('test_pause_gate.py exists', fs.existsSync(PY_TEST));
  try {
    const out = execFileSync('python3', [PY_TEST], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    process.stdout.write(out.split('\n').map((l) => (l ? `       ${l}` : l)).join('\n'));
    if (!out.endsWith('\n')) process.stdout.write('\n');
    assert(
      'python pause_gate tests green',
      /\b0 failed\b/.test(out) && /passed/i.test(out) && !/\bFAIL\s{2}/.test(out),
    );
  } catch (err) {
    const detail = ((err && err.stdout) || (err && err.message) || '').toString().slice(0, 500);
    assert('python pause_gate tests green', false, detail);
  }

  console.log(`\nverify-luna-pause-handoff-controls: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
