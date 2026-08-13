#!/usr/bin/env node
'use strict';

/**
 * verify-luna-handoff-lifecycle
 *
 * Part A: explicit-human acknowledgement must be sent BEFORE pause persistence.
 * Part B: staff manual Needs Human add/remove uses canonical handoff persistence
 *         and never auto-resumes on remove.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');

const ROOT = path.join(__dirname, '..');
const EXPLICIT = path.join(ROOT, 'docker/hermes-staging/wolfhouse/explicit_human_handoff.py');
const COALESCE = path.join(ROOT, 'docker/hermes-staging/wolfhouse/whatsapp_burst_coalesce.py');
const PERSIST = path.join(ROOT, 'scripts/lib/luna-guest-handoff-persist.js');
const API = path.join(ROOT, 'scripts/staff-query-api.js');

let pass = 0;
let fail = 0;
function assert(label, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

console.log('\nverify-luna-handoff-lifecycle\n');

const explicitSrc = fs.readFileSync(EXPLICIT, 'utf8');
const coalesceSrc = fs.readFileSync(COALESCE, 'utf8');
const persistSrc = fs.readFileSync(PERSIST, 'utf8');
const apiSrc = fs.readFileSync(API, 'utf8');

console.log('[1] Source contracts — ack before pause');
assert(
  'explicit_human_handoff documents ack-before-persist lifecycle',
  /ack.?before|send.*acknowledg|before.*persist|persist.*after.*send/i.test(explicitSrc)
    || /await adapter\.send[\s\S]{0,400}execute_explicit_human_handoff/.test(explicitSrc),
  'expected send acknowledgement before execute_explicit_human_handoff',
);
assert(
  'legacy pause-then-send order is gone',
  !/tool_result = execute_explicit_human_handoff[\s\S]{0,250}await adapter\.send/.test(explicitSrc),
  'still persists handoff before adapter.send',
);
assert(
  'coalescer still short-circuits explicit human before agent',
  /maybe_short_circuit_explicit_human/.test(coalesceSrc),
);

console.log('\n[2] Staff manual Needs Human uses canonical persistence');
assert(
  'persist module exports clear/resolve for staff remove',
  /clearStaffNeedsHuman|resolveStaffNeedsHuman|clearConversationNeedsHuman/.test(persistSrc),
  'missing clearStaffNeedsHuman-style export',
);
assert(
  'handleConversationNeedsHuman calls markConversationNeedsHuman on add',
  /handleConversationNeedsHuman[\s\S]{0,2500}markConversationNeedsHuman/.test(apiSrc),
  'portal toggle still only UPDATEs conversations.needs_human',
);
assert(
  'handleConversationNeedsHuman resolves handoffs on remove',
  /handleConversationNeedsHuman[\s\S]{0,3500}(clearStaffNeedsHuman|resolveStaffNeedsHuman|clearConversationNeedsHuman)/.test(apiSrc),
  'portal remove does not resolve open staff_handoffs',
);
assert(
  'staff remove must not auto-resume',
  !/handleConversationNeedsHuman[\s\S]{0,4000}resumeConversation\(/.test(apiSrc)
    || /Resolving needs_human does NOT auto-resume|must NOT.*resume|does not auto-resume/i.test(persistSrc),
);
assert(
  'manual reason is staff_manual_handoff',
  /staff_manual_handoff/.test(persistSrc) || /staff_manual_handoff/.test(apiSrc),
);
// wireNeedsHumanToggle lives in scripts/browser/inbox-thread.js, injected into /staff/ui —
// read template + injected modules, and scope to the function body.
const portalSrc = readStaffPortalUiSource();
const needsHumanToggleStart = portalSrc.indexOf('function wireNeedsHumanToggle(');
const needsHumanToggleEnd = portalSrc.indexOf('\nfunction ', needsHumanToggleStart + 1);
const needsHumanToggleSrc = needsHumanToggleStart === -1
  ? ''
  : portalSrc.slice(needsHumanToggleStart, needsHumanToggleEnd === -1 ? undefined : needsHumanToggleEnd);
assert(
  'UI toggle wires credentials and full state refresh',
  /credentials:\s*['"]same-origin['"]/.test(needsHumanToggleSrc)
    || /conversation_paused/.test(needsHumanToggleSrc),
);

console.log('\n[3] Python lifecycle + fail-closed unit behaviour');
const py = `
import asyncio, json, os, sys, types
from pathlib import Path
from unittest import mock

ROOT = Path(${JSON.stringify(ROOT)})
sys.path.insert(0, str(ROOT / "docker/hermes-staging"))
sys.path.insert(0, str(ROOT / "docker/hermes-staging/wolfhouse"))
os.environ["LUNA_CLIENT_SLUG"] = "wolfhouse-somo"
os.environ["LUNA_BOT_INTERNAL_TOKEN"] = "tok"
os.environ["WOLFHOUSE_STAFF_API_BASE_URL"] = "https://example.test"

import explicit_human_handoff as mod
import wolfhouse.pause_gate as wpg

# Pause gate must report active (not paused) for the first ack path.
wpg._CACHE.clear()
wpg.guest_paused_for_event = lambda event: False
wpg.guest_automation_paused = lambda *a, **k: False
wpg.whatsapp_send_blocked = lambda *a, **k: False

order = []
send_calls = []

class FakeSendResult:
    def __init__(self, suppressed=False):
        self.success = True
        self.message_id = None if suppressed else "wamid.ack.1"
        self.raw_response = {"suppressed_guest_automation_paused": True} if suppressed else {"ok": True}

class FakeAdapter:
    async def send(self, chat_id, content, **kwargs):
        order.append("send")
        send_calls.append({"chat_id": chat_id, "content": content})
        return FakeSendResult(suppressed=False)

class FakeDispatch:
    adapter = FakeAdapter()

def fake_persist(**kwargs):
    order.append("persist")
    return {
        "success": True,
        "needs_human": True,
        "conversation_paused": True,
        "reason": "human_requested",
        "handoff_reason": "human_requested",
    }

event = types.SimpleNamespace(
    text="I want to speak to a human",
    chat_id="34990002201",
    message_id="wamid.lifecycle.1",
)

async def run():
    with mock.patch.object(mod, "execute_explicit_human_handoff", side_effect=fake_persist):
        out = await mod.maybe_short_circuit_explicit_human(event, FakeDispatch())
    return out, list(order), list(send_calls)

out, ord_, sends = asyncio.run(run())
print(json.dumps({
  "order": ord_,
  "ack_before_persist": len(ord_) >= 2 and ord_.index("send") < ord_.index("persist"),
  "ack_sent": bool(out.get("ack_sent")),
  "one_send": len(sends) == 1,
  "no_question": "?" not in (sends[0]["content"] if sends else "?"),
  "short_circuited": bool(out.get("short_circuited")),
}))

# Send failure still persists
order.clear(); send_calls.clear()
class BoomAdapter:
    async def send(self, *a, **k):
        order.append("send_fail")
        raise RuntimeError("wa_send_failed")
class BoomDispatch:
    adapter = BoomAdapter()
async def run_fail_send():
    with mock.patch.object(mod, "execute_explicit_human_handoff", side_effect=fake_persist):
        return await mod.maybe_short_circuit_explicit_human(
            types.SimpleNamespace(text="I want to speak to a human", chat_id="34990002202", message_id="wamid.lifecycle.2"),
            BoomDispatch(),
        )
out2 = asyncio.run(run_fail_send())
print(json.dumps({
  "send_fail_still_persists": "persist" in order,
  "ack_sent_false": out2.get("ack_sent") is False,
  "short_circuited_on_send_fail": out2.get("short_circuited") is True,
}))

# Persist failure after ack → local fail-closed
order.clear(); send_calls.clear()
def fail_persist(**kwargs):
    order.append("persist")
    return {"success": False, "needs_human": False, "conversation_paused": False, "error": "boom"}
async def run_fail_persist():
    with mock.patch.object(mod, "execute_explicit_human_handoff", side_effect=fail_persist):
        return await mod.maybe_short_circuit_explicit_human(
            types.SimpleNamespace(text="I want to speak to a human", chat_id="34990002203", message_id="wamid.lifecycle.3"),
            FakeDispatch(),
        )
out3 = asyncio.run(run_fail_persist())
blocked = mod.is_local_automation_blocked("34990002203") or mod.is_local_automation_blocked("+34990002203")
print(json.dumps({
  "persist_fail_after_ack": "send" in order and "persist" in order and order.index("send") < order.index("persist"),
  "local_fail_closed": blocked is True,
  "still_short_circuited": out3.get("short_circuited") is True,
}))
`;

try {
  const out = execFileSync('python3', ['-c', py], { cwd: ROOT, encoding: 'utf8' });
  for (const line of out.trim().split('\n')) {
    const j = JSON.parse(line);
    if ('ack_before_persist' in j) {
      assert('runtime: ack before persist', j.ack_before_persist === true, line);
      assert('runtime: ack sent once', j.one_send === true && j.ack_sent === true, line);
      assert('runtime: ack has no question', j.no_question === true, line);
      assert('runtime: short-circuited', j.short_circuited === true, line);
    } else if ('send_fail_still_persists' in j) {
      assert('runtime: send fail still persists', j.send_fail_still_persists === true, line);
      assert('runtime: send fail short-circuits', j.short_circuited_on_send_fail === true, line);
    } else if ('persist_fail_after_ack' in j) {
      assert('runtime: persist fail after ack order', j.persist_fail_after_ack === true, line);
      assert('runtime: local fail-closed after persist fail', j.local_fail_closed === true, line);
      assert('runtime: persist fail still short-circuits', j.still_short_circuited === true, line);
    }
  }
} catch (e) {
  assert('runtime lifecycle python', false, String(e.stdout || e.stderr || e.message).slice(0, 500));
}

console.log('\n[4] Persist-module staff clear unit');
try {
  const persist = require(PERSIST);
  assert('markConversationNeedsHuman exported', typeof persist.markConversationNeedsHuman === 'function');
  assert(
    'clearStaffNeedsHuman exported',
    typeof persist.clearStaffNeedsHuman === 'function'
      || typeof persist.resolveStaffNeedsHuman === 'function'
      || typeof persist.clearConversationNeedsHuman === 'function',
  );
} catch (e) {
  assert('persist module load', false, e.message);
}

console.log(`\nverify-luna-handoff-lifecycle: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
