/**
 * Stage 27x-lite — Static verifier for inbound Luna review-only wiring design lock.
 *
 * Docs-only checks — no runtime, no DB, no API calls.
 *
 * Usage:
 *   npm run verify:stage27x-lite-inbound-review-design
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'STAGE-27X-LITE-INBOUND-REVIEW-WIRING-DESIGN.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27x-lite-inbound-review-design';
const REL = 'scripts/verify-stage27x-lite-inbound-review-design.js';

/** 27x-lite must not ship inbound runtime — 27x.1+ implements later */
const FORBIDDEN_27X_RUNTIME = [
  'scripts/lib/luna-guest-inbound-review-dry-run.js',
  'scripts/lib/luna-guest-inbound-orchestrator.js',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function docIncludes(text, needle, id, label) {
  if (text.includes(needle)) pass(id, label);
  else fail(id, `${label} — missing: ${String(needle).slice(0, 72)}`);
}

function docMatches(text, pattern, id, label) {
  if (pattern.test(text)) pass(id, label);
  else fail(id, `${label} — pattern not found`);
}

console.log('\nverify-stage27x-lite-inbound-review-design.js  (Stage 27x-lite design lock)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'design verifier passes node --check');
} catch {
  fail('0', 'design verifier syntax error');
}

section('A. Doc exists');

if (fs.existsSync(DOC)) pass('A1', 'STAGE-27X-LITE-INBOUND-REVIEW-WIRING-DESIGN.md exists');
else fail('A1', 'design doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

section('B. Doc title and status');

docMatches(doc, /Stage 27x-lite|Inbound Luna Review-Only Wiring/i, 'B1', 'Stage 27x-lite title');
docMatches(doc, /DESIGN LOCK|docs only/i, 'B2', 'design lock / docs-only status');
docMatches(doc, /No runtime code/i, 'B3', 'no runtime code stated');
docMatches(doc, /no public guest automation|Not wired yet|not connected/i, 'B4', 'no public guest automation wired yet');

section('C. Inbound source');

docMatches(doc, /Staff API.*brain|Staff API.*Brain/i, 'C1', 'Staff API is brain');
docMatches(doc, /n8n.*pipe|n8n.*Pipe/i, 'C2', 'n8n is pipe');
docIncludes(doc, 'client_slug', 'C3', 'inbound: client_slug resolution');
docIncludes(doc, 'guest_phone', 'C4', 'inbound: guest_phone');
docIncludes(doc, 'conversation_id', 'C5', 'inbound: conversation_id');
docIncludes(doc, 'idempotency_key', 'C6', 'inbound: idempotency_key');
docIncludes(doc, 'inbound_message_id', 'C7', 'inbound: message_id');
docMatches(doc, /reference_date|received_at/i, 'C8', 'timestamp/reference date handling');
docMatches(doc, /payload|POST \/staff\/bot\/guest-inbound-review/i, 'C9', 'inbound payload shape');

section('D. Review-only behavior');

docIncludes(doc, 'proposed_luna_reply', 'D1', 'proposed_luna_reply');
docIncludes(doc, 'proposed_next_action', 'D2', 'proposed_next_action');
docIncludes(doc, 'automation_gate', 'D3', 'automation_gate');
docMatches(doc, /availability|quote|payment_choice|hold_payment_draft_plan/i, 'D4', 'chain state steps');
docMatches(doc, /no live send|No live WhatsApp|sends_whatsapp: false/i, 'D5', 'no live send');
docMatches(doc, /no.*hold.*write|no_write_performed|explicit staff/i, 'D6', 'no write unless staff action');
docMatches(doc, /no Stripe link unless|Stripe TEST link create.*❌|unless explicit staff/i, 'D7', 'no Stripe unless staff action');

section('E. Staff Portal visibility');

docMatches(doc, /Inbox|conversation detail/i, 'E1', 'Inbox conversation detail');
docMatches(doc, /Luna review panel|review panel/i, 'E2', 'Luna review panel');
docIncludes(doc, 'handoff_reasons', 'E3', 'handoff reasons visible');
docMatches(doc, /Copy reply|copy draft/i, 'E4', 'staff can copy reply manually');
docMatches(doc, /Send.*disabled|Approve.*Send.*Disabled|review-only/i, 'E5', 'approve/send disabled');

section('F. Gate rules');

docIncludes(doc, 'public_guest_automation_enabled', 'F1', 'public_guest_automation_enabled gate');
docIncludes(doc, 'WHATSAPP_DRY_RUN', 'F2', 'WHATSAPP_DRY_RUN gate');
docMatches(doc, /bot pause|bot_paused/i, 'F3', 'bot pause blocks automation');
docMatches(doc, /human takeover|human_takeover/i, 'F4', 'human takeover blocks automation');
docMatches(doc, /owner.*staff|is_owner_or_staff/i, 'F5', 'owner/staff routing excluded');
docMatches(doc, /unsupported.*channel|Unknown.*client_slug/i, 'F6', 'unsupported client/channel handoff');
docMatches(doc, /idempotent|duplicate inbound/i, 'F7', 'duplicate inbound idempotency');

section('G. State persistence');

docMatches(doc, /persist|storage|Store now/i, 'G1', 'state persistence section');
docMatches(doc, /guest_context|slim/i, 'G2', 'guest_context persistence');
docMatches(doc, /conversation event|audit/i, 'G3', 'conversation event/audit trail');
docMatches(doc, /proposed.*draft|proposed_luna_reply.*stored/i, 'G4', 'proposed draft reply storage');
docMatches(doc, /no raw giant|slim|avoid giant/i, 'G5', 'avoid giant nested blobs');

section('H. Non-booking lanes');

const LANES = [
  ['add_service_request', 'lane: add_service_request'],
  ['transfer_request', 'lane: transfer_request'],
  ['payment_balance', 'lane: payment/balance'],
  ['check_in', 'lane: check-in/logistics/FAQ'],
  ['cancel_change', 'lane: cancel/change'],
  ['general_question', 'lane: general question'],
  ['staff_handoff_required', 'lane: staff handoff'],
];
for (let i = 0; i < LANES.length; i++) {
  docMatches(doc, new RegExp(LANES[i][0], 'i'), `H${i + 1}`, LANES[i][1]);
}
docMatches(doc, /classify and draft|classify \+ draft|No mutations/i, 'H8', 'classify/draft only for lanes');

section('I. Safety limits');

docMatches(doc, /no public auto-send|No public auto-send/i, 'I1', 'no public auto-send');
docMatches(doc, /No Meta|no Meta|no n8n activation/i, 'I2', 'no Meta/n8n activation changes');
docMatches(doc, /No live WhatsApp|no live WhatsApp/i, 'I3', 'no live WhatsApp sends');
docMatches(doc, /No production|staging only|staging DB/i, 'I4', 'no production DB');
docMatches(doc, /No Stripe live|sk_test_|no Stripe live/i, 'I5', 'no Stripe live mode');
docMatches(doc, /No confirmation send|confirmation send.*❌/i, 'I6', 'no confirmation send');
docMatches(doc, /payment truth.*webhook|27p webhook|not guest text/i, 'I7', 'no payment truth from guest text');
docMatches(doc, /must never invent|cannot invent|never invent/i, 'I8', 'Luna cannot invent availability/prices');

section('J. Next implementation sequence');

docIncludes(doc, '27x.1', 'J1', 'future stage 27x.1 inbound endpoint');
docIncludes(doc, '27x.2', 'J2', 'future stage 27x.2 n8n pipe');
docIncludes(doc, '27x.3', 'J3', 'future stage 27x.3 Staff Portal inbox');
docIncludes(doc, '27x.4', 'J4', 'future stage 27x.4 allowlisted proof');
docIncludes(doc, '27x.5', 'J5', 'future stage 27x.5 limited staging automation GO');

section('K. Proven chain reference');

docIncludes(doc, '27u', 'K1', 'references 27u orchestrator');
docIncludes(doc, '27v', 'K2', 'references 27v review');
docIncludes(doc, '27w', 'K3', 'references 27w simulator');

section('L. No runtime files for 27x-lite');

const apiSrc = fs.existsSync(path.join(ROOT, 'scripts', 'staff-query-api.js'))
  ? fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8')
  : '';
if (!apiSrc.includes("'/staff/bot/guest-inbound-review-dry-run'")
    && !apiSrc.includes('guest-inbound-review-dry-run')) {
  pass('L1', 'guest-inbound-review route not present yet (design only)');
} else {
  fail('L1', '27x-lite must not ship inbound review route yet');
}

for (let i = 0; i < FORBIDDEN_27X_RUNTIME.length; i++) {
  const p = path.join(ROOT, FORBIDDEN_27X_RUNTIME[i]);
  if (!fs.existsSync(p)) pass(`L${i + 2}`, `27x-lite runtime not present: ${FORBIDDEN_27X_RUNTIME[i]}`);
  else fail(`L${i + 2}`, `27x-lite must not ship runtime yet: ${FORBIDDEN_27X_RUNTIME[i]}`);
}

section('M. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${REL}`) {
  pass('M1', `${SCRIPT} registered`);
} else {
  fail('M1', `${SCRIPT} missing or wrong path`);
}

if (fs.existsSync(path.join(ROOT, REL))) pass('M2', 'design verifier file exists');
else fail('M2', 'design verifier file missing');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
