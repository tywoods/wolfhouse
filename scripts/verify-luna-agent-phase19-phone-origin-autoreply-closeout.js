/**
 * Phase 19g.13 — Closeout verifier for phone-origin Luna auto-reply proof.
 *
 * Static doc + anchor checks; runs a limited downstream set only.
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-phone-origin-autoreply-closeout
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'PHASE-19g-LUNA-PHONE-ORIGIN-AUTOREPLY-PROOF.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase19-phone-origin-autoreply-closeout';

const DOWNSTREAM = [
  'verify:luna-agent-phase19-guest-reply-send-route',
  'verify:luna-agent-phase19-meta-whatsapp-webhook',
  'verify:luna-agent-phase19-message-events-read',
  'verify:luna-agent-phase19-test-reset-phone',
];

const ANCHORS = {
  proof_revision: 'wh-staging-staff-api--stage19g12-retry-proof',
  restored_revision: 'wh-staging-staff-api--stage19g12-retry-safe',
  inbound_wamid: 'wamid.HBgMNDkxNzI2NDIyMzA3FQIAEhgWM0VCMEIzQzcwNjRBRjJFOUU2MjdGOQA=',
  outbound_provider_id: 'wamid.HBgMNDkxNzI2NDIyMzA3FQIAERgSRTk2QzdBMTZEQUM0QTNGREMwAA==',
  luna_reply: 'Quali date di check-in e check-out avete in mente?',
  case_b_wamid: 'wamid.HBgMNDkxNzI2NDIyMzA3FQIAEhgWM0VCMDUyODUwMzMxQzA2QkIzQzk3OQA=',
};

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function docIncludes(text, needle, id, label) {
  if (text.includes(needle)) pass(id, label);
  else fail(id, `${label} — missing: ${needle.slice(0, 60)}`);
}

console.log('\nverify-luna-agent-phase19-phone-origin-autoreply-closeout.js  (Phase 19g.13)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'closeout verifier passes node --check');
} catch {
  fail('0', 'closeout verifier syntax error');
}

section('A. Proof doc exists');

if (fs.existsSync(DOC)) pass('A1', 'PHASE-19g-LUNA-PHONE-ORIGIN-AUTOREPLY-PROOF.md exists');
else fail('A1', 'proof doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

section('B. Phone-origin proof anchors');

docIncludes(doc, 'phone-origin', 'B1', 'documents phone-origin proof');
docIncludes(doc, '19g.12-retry', 'B2', 'references 19g.12-retry slice');
docIncludes(doc, ANCHORS.inbound_wamid, 'B3', 'includes Case A inbound wa_message_id');
docIncludes(doc, ANCHORS.outbound_provider_id, 'B4', 'includes outbound provider_message_id');
docIncludes(doc, ANCHORS.luna_reply, 'B5', 'includes Luna reply text');
docIncludes(doc, ANCHORS.proof_revision, 'B6', 'includes proof revision name');
docIncludes(doc, ANCHORS.restored_revision, 'B7', 'includes restored revision name');
docIncludes(doc, 'send_status', 'B8', 'documents send_status');
docIncludes(doc, 'sent', 'B9', 'documents Case A sent status');

section('C. Proof env gates documented');

for (const [id, env] of [
  ['C1', 'LUNA_AUTO_SEND_ENABLED'],
  ['C2', 'WHATSAPP_DRY_RUN'],
  ['C3', 'WHATSAPP_LIVE_SENDS_ENABLED'],
  ['C4', 'LUNA_GUEST_LIVE_SEND_OWNER_APPROVED'],
  ['C5', 'WHATSAPP_CLOUD_ACCESS_TOKEN'],
  ['C6', 'WHATSAPP_PHONE_NUMBER_ID'],
]) {
  docIncludes(doc, env, id, `documents ${env}`);
}

if (/WHATSAPP_DRY_RUN.*false|WHATSAPP_DRY_RUN` \| `false/.test(doc) || doc.includes('WHATSAPP_DRY_RUN` | `false')) {
  pass('C7', 'documents WHATSAPP_DRY_RUN=false for proof');
} else if (doc.includes('WHATSAPP_DRY_RUN') && doc.includes('| `false`')) {
  pass('C7', 'documents WHATSAPP_DRY_RUN=false for proof');
} else {
  fail('C7', 'WHATSAPP_DRY_RUN=false for proof not documented');
}

section('D. Safe restored env documented');

if (doc.includes('WHATSAPP_DRY_RUN') && /unset|true/.test(doc)) {
  pass('D1', 'documents safe WHATSAPP_DRY_RUN restore');
} else fail('D1', 'safe WHATSAPP_DRY_RUN restore missing');

docIncludes(doc, 'LUNA_AUTO_SEND_ENABLED', 'D2', 'mentions LUNA_AUTO_SEND_ENABLED in restore section');
if (/LUNA_AUTO_SEND_ENABLED.*unset|unset.*LUNA_AUTO_SEND_ENABLED/.test(doc)) {
  pass('D3', 'documents LUNA_AUTO_SEND_ENABLED unset after proof');
} else fail('D3', 'LUNA_AUTO_SEND_ENABLED unset not documented');

section('E. Replay, risky no-send, reset, safety');

docIncludes(doc, 'idempotent_replay', 'E1', 'documents idempotent_replay');
docIncludes(doc, 'duplicate', 'E2', 'documents duplicate replay');
if (/no second|Second.*none|1 \(unchanged\)/i.test(doc)) {
  pass('E3', 'documents no second send on replay');
} else fail('E3', 'replay no-second-send not documented');

docIncludes(doc, 'handoff_to_staff', 'E4', 'documents Case B handoff_to_staff');
docIncludes(doc, 'handoff_required', 'E5', 'documents Case B handoff_required');
if (/send_attempted.*false|false.*send_attempted/i.test(doc) && doc.includes('Case B')) {
  pass('E6', 'documents Case B send_attempted false');
} else fail('E6', 'Case B send_attempted false missing');

docIncludes(doc, 'reset-luna-phone', 'E7', 'documents reset tool route');
docIncludes(doc, 'Reset test phone', 'E8', 'documents reset UI label');
docIncludes(doc, 'bookings', 'E9', 'documents bookings safety');
docIncludes(doc, 'payments', 'E10', 'documents payments safety');
docIncludes(doc, 'Stripe', 'E11', 'documents no Stripe');
docIncludes(doc, 'n8n', 'E12', 'documents no n8n changes');

section('F. Durable proof tables');

docIncludes(doc, 'guest_message_events', 'F1', 'references guest_message_events');
docIncludes(doc, 'guest_message_sends', 'F2', 'references guest_message_sends');
docIncludes(doc, 'Message Events', 'F3', 'references Message Events panel');

section('G. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
const rel = 'scripts/verify-luna-agent-phase19-phone-origin-autoreply-closeout.js';
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${rel}`) {
  pass('G1', `${SCRIPT} registered`);
} else fail('G1', `${SCRIPT} missing or wrong path`);

if (fs.existsSync(path.join(ROOT, rel))) pass('G2', 'closeout script file exists');
else fail('G2', 'closeout script file missing');

section('H. Downstream verifiers (limited)');

for (const script of DOWNSTREAM) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
    pass('H.' + script, `${script} still passes`);
  } catch (e) {
    fail('H.' + script, `${script} failed`);
    const out = (e.stdout || '') + (e.stderr || '');
    console.error(out.split('\n').slice(-8).join('\n'));
  }
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
