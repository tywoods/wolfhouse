#!/usr/bin/env node
'use strict';

/**
 * verify-sunset-luna-live-test-001
 *
 * Aggregate gate for Ty's Hernan live-test defects:
 *   1. Draft mode inbound → editable Inbox draft, zero provider send
 *   2. 15-person booking uses Staff API remaining-seat capacity
 *   3. Unclear / large party ask one question; no auto Needs human
 *   4. needs_human is review state, not an inbound mute
 *
 * Offline only. Run: node scripts/verify-sunset-luna-live-test-001.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAGING = path.join(ROOT, 'docker/hermes-staging');

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

function runPython(rel) {
  const abs = path.join(ROOT, rel);
  const out = execFileSync('python3', [abs], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  process.stdout.write(out.split('\n').map((l) => (l ? `       ${l}` : l)).join('\n'));
  if (!out.endsWith('\n')) process.stdout.write('\n');
  return out;
}

console.log('\nverify-sunset-luna-live-test-001\n');

console.log('[1] Draft mode persist / zero send');
try {
  const out = runPython('docker/hermes-staging/wolfhouse/test_draft_mode_inbox_persist.py');
  assert('draft persist python green', /\b0 failed\b/.test(out) && !/\bFAIL\s{2}/.test(out));
} catch (err) {
  assert('draft persist python green', false, String((err && err.stdout) || err.message).slice(0, 500));
}

const mirrorJs = fs.readFileSync(path.join(ROOT, 'scripts/lib/luna-hermes-whatsapp-thread-mirror.js'), 'utf8');
assert('Staff API stages luna_outbound_approvals in Draft', /stageHermesWhatsAppOutboundDraft/.test(mirrorJs) && /SQL_UPSERT_HERMES_DRAFT/.test(mirrorJs));
assert('Draft outbound does not insert a sent bubble', /do not insert a sent bubble/.test(mirrorJs) || /draft_staged/.test(mirrorJs));
const patches = fs.readFileSync(path.join(STAGING, 'apply_gateway_patches.py'), 'utf8');
assert('Hermes send path stages draft before provider', patches.indexOf('mirror_whatsapp_outbound_as_draft') < patches.indexOf('_orig_whatsapp_cloud_send'));
assert('Hermes Draft send returns suppressed_draft_mode (no wamid)', /suppressed_draft_mode/.test(patches));
const draftBlockStart = patches.indexOf('if _wh_disp.get("stage_as_draft")');
const draftBlockEnd = patches.indexOf('if _wh_disp.get("send_blocked")', draftBlockStart);
const draftBlock = draftBlockStart >= 0 && draftBlockEnd > draftBlockStart
  ? patches.slice(draftBlockStart, draftBlockEnd)
  : '';
assert(
  'Draft staging failure is fail-closed (no swallow-then-success)',
  /_wh_draft_result/.test(draftBlock)
    && /_wh_draft_staged/.test(draftBlock)
    && /"draft_staged": False/.test(draftBlock)
    && /blocked_reason/.test(draftBlock)
    && /if _wh_draft_staged:/.test(draftBlock)
    && /draft_stage_exception/.test(draftBlock)
    && !/mirror_whatsapp_outbound_as_draft\([\s\S]{0,180}?except Exception:\s*pass\s*try:[\s\S]{0,220}?draft_staged": True/.test(draftBlock),
);
assert(
  'Draft helper requires Staff API draft_staged, not enqueue',
  /staff_api_thread_draft_staged/.test(fs.readFileSync(path.join(STAGING, 'wolfhouse_whatsapp_mirror.py'), 'utf8'))
    && /_post_mirror_sync\(payload\)/.test(fs.readFileSync(path.join(STAGING, 'wolfhouse_whatsapp_mirror.py'), 'utf8')),
);

console.log('\n[2] 15-person remaining-seat capacity');
try {
  const out = runPython('docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_party_capacity.py');
  assert('party capacity python green', /\b0 failed\b/.test(out) && !/\bFAIL\s{2}/.test(out));
} catch (err) {
  assert('party capacity python green', false, String((err && err.stdout) || err.message).slice(0, 500));
}

console.log('\n[3] Unclear / large party no auto-escalation');
try {
  const out = runPython('docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_clarify_before_escalate.py');
  assert('clarify-first python green', /\b0 failed\b/.test(out) && !/\bFAIL\s{2}/.test(out));
} catch (err) {
  assert('clarify-first python green', false, String((err && err.stdout) || err.message).slice(0, 500));
}

console.log('\n[4] needs_human does not mute Luna');
try {
  const out = runPython('docker/hermes-staging/wolfhouse/test_needs_human_not_mute.py');
  assert('needs_human-not-mute python green', /\b0 failed\b/.test(out) && !/\bFAIL\s{2}/.test(out));
} catch (err) {
  assert('needs_human-not-mute python green', false, String((err && err.stdout) || err.message).slice(0, 500));
}
try {
  const out = runPython('docker/hermes-staging/wolfhouse/test_pause_gate.py');
  assert('pause_gate python green', /\b0 failed\b/.test(out) && !/\bFAIL\s{2}/.test(out));
} catch (err) {
  assert('pause_gate python green', false, String((err && err.stdout) || err.message).slice(0, 500));
}

console.log(`\nverify-sunset-luna-live-test-001: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
