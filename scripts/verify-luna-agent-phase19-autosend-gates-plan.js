/**
 * Phase 19a — Fast static verifier for the Luna production auto-send gate plan.
 *
 * Confirms PHASE-19.1 plan doc documents: first production auto-send scope,
 * what Luna sends first, what stays blocked, required gates, Phase 19b/19c/19d
 * order, n8n role, and protective verifiers — without implementing any send.
 *
 * Non-recursive: does NOT execute downstream closeout trees.
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-autosend-gates-plan
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC  = path.join(ROOT, 'docs', 'PHASE-19.1-LUNA-PRODUCTION-AUTO-SEND-GATES-PLAN.md');
const PKG  = path.join(ROOT, 'package.json');
const WF   = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant - Message Intake Shadow.json');

const PRIOR_CLOSEOUTS = [
  ['verify:luna-agent-phase18-closeout', 'scripts/verify-luna-agent-phase18-closeout.js'],
  ['verify:luna-agent-phase17-closeout', 'scripts/verify-luna-agent-phase17-closeout.js'],
  ['verify:luna-agent-phase15-closeout', 'scripts/verify-luna-agent-phase15-closeout.js'],
  ['verify:luna-agent-phase14-closeout', 'scripts/verify-luna-agent-phase14-closeout.js'],
  ['verify:luna-agent-phase13-closeout', 'scripts/verify-luna-agent-phase13-closeout.js'],
  ['verify:luna-agent-phase12-closeout', 'scripts/verify-luna-agent-phase12-closeout.js'],
  ['verify:staff-ask-luna-phase11-closeout', 'scripts/verify-staff-ask-luna-phase11-closeout.js'],
];

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }
function key(label)    { return label.replace(/[^a-z0-9]/gi, '_').slice(0, 32); }

console.log('\nverify-luna-agent-phase19-autosend-gates-plan.js  (Phase 19a — static, non-recursive)\n');

const startedMs = Date.now();

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'plan verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Plan document + sections');

if (!fs.existsSync(DOC)) {
  fail('A1', 'PHASE-19.1 plan doc missing');
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(1);
}
pass('A1', 'plan doc exists');

const doc = fs.readFileSync(DOC, 'utf8');

const sections = [
  ['A2',  'Go/No-Go framing',                /## 0\. Go\/No-Go framing/],
  ['A3',  'First production auto-send scope', /## 1\. First production auto-send scope/],
  ['A4',  'What Luna should auto-send first', /## 2\. What Luna should auto-send first/],
  ['A5',  'What remains blocked',             /## 3\. What remains blocked/],
  ['A6',  'Gates required',                   /## 4\. Gates required before any real-client send/],
  ['A7',  'Phase 19b implement first',        /## 5\. Phase 19b/],
  ['A8',  'Phase 19c implement later',        /## 6\. Phase 19c/],
  ['A9',  'Phase 19d what to prove',          /## 7\. Phase 19d/],
  ['A10', 'n8n role',                         /## 8\. n8n role/],
  ['A11', 'Verifiers that must protect',      /## 9\. Verifiers that must protect/],
  ['A12', 'Safety proof',                     /## 10\. Safety proof/],
  ['A13', 'Stop conditions',                  /## 11\. Stop conditions/],
  ['A14', 'Phase map',                        /## 12\. Phase map/],
];
for (const [id, label, re] of sections) {
  if (re.test(doc)) pass(id, label);
  else fail(id, label + ' missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. First production auto-send scope');

const scope = [
  ['real client numbers allowed', /real client numbers? allowed/i],
  ['safe kinds ask_missing_field + show_quote', /ask_missing_field.*show_quote|show_quote.*ask_missing_field/is],
  ['no refund/cancel/date-change', /(cancellation|refund|date-change).*NOT handled|NOT handled.*(staff-required)/is],
  ['no complaint handling', /complaint handling.*NOT handled/i],
  ['no unsupported/low-confidence auto-send', /unsupported \/ low-confidence reply.*NOT auto-sent/i],
  ['no automatic booking write yet', /NOT included.*Phase 13 write gates/i],
  ['no automatic Stripe link yet', /NOT included.*payment\/link gates/i],
  ['no automatic confirmation send yet', /confirmation send.*NOT included yet/i],
];
for (const [label, re] of scope) {
  if (re.test(doc)) pass('B.' + key(label), 'scope: ' + label);
  else fail('B.' + key(label), 'missing scope: ' + label);
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Safe first auto-send replies');

const safe = [
  ['ask_missing_field dates',   /\bdates\b/i],
  ['ask_missing_field guests',  /\bguests\b/i],
  ['ask_missing_field package', /\bpackage\b/i],
  ['payment choice deposit/full', /payment choice.*deposit ?\/ ?full|deposit \/ full/i],
  ['quote generated',           /quote generated/i],
  ['availability checked',      /availability checked/i],
  ['no write performed',        /no write performed/i],
  ['no payment link created',   /no payment link created/i],
  ['send_allowed_later true',   /send_allowed_later.*true/i],
  ['handoff ack staff-required for now', /handoff acknowledgement.*staff-required/is],
];
for (const [label, re] of safe) {
  if (re.test(doc)) pass('C.' + key(label), 'safe: ' + label);
  else fail('C.' + key(label), 'missing safe: ' + label);
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Blocked / staff-required actions');

const blocked = [
  ['refund', /\brefund\b/i],
  ['cancellation', /\bcancellation\b/i],
  ['paid date change', /paid date change/i],
  ['complaint / angry guest', /complaint \/ angry guest/i],
  ['human request', /human request/i],
  ['low confidence', /low confidence/i],
  ['unsupported message', /unsupported message/i],
  ['not enough beds', /not enough beds|availability failure/i],
  ['ambiguous package/pricing', /ambiguous package ?\/ ?pricing/i],
  ['booking-create/write bridge', /booking-create ?\/ ?write bridge/i],
  ['payment-link/Stripe link', /payment-link ?\/ ?Stripe link/i],
  ['Stripe webhook/payment truth', /Stripe webhook ?\/ ?payment truth/i],
  ['confirmation send', /confirmation send/i],
  ['non-guest operational/admin', /non-guest operational ?\/ ?admin/i],
  ['requires_staff true', /requires_staff: ?true/i],
];
for (const [label, re] of blocked) {
  if (re.test(doc)) pass('D.' + key(label), 'blocked: ' + label);
  else fail('D.' + key(label), 'missing blocked: ' + label);
}

// ─────────────────────────────────────────────────────────────────────────────
section('E. Required production send gates');

const gates = [
  ['LUNA_AUTO_SEND_ENABLED', /LUNA_AUTO_SEND_ENABLED=true/],
  ['WHATSAPP_DRY_RUN=false', /WHATSAPP_DRY_RUN=false/],
  ['bot pause not paused', /bot pause.*not paused/i],
  ['auto_send_ready true', /auto_send_ready: ?true/i],
  ['send_allowed_later true', /send_allowed_later: ?true/i],
  ['requires_staff false', /requires_staff: ?false/i],
  ['allowed_send_kind safe list', /allowed_send_kind.*ask_missing_field.*show_quote/is],
  ['idempotency / dup guard', /idempotency key.*duplicate-send guard/i],
  ['audit log', /audit log/i],
  ['kill switch', /kill switch/i],
  ['rate / spam guard', /rate ?\/ ?spam guard|max reply rate/i],
  ['confidence threshold', /confidence threshold/i],
  ['structured send reason', /structured send reason|machine-readable reason/i],
  ['fallback to handoff', /fallback to handoff/i],
];
for (const [label, re] of gates) {
  if (re.test(doc)) pass('E.' + key(label), 'gate: ' + label);
  else fail('E.' + key(label), 'missing gate: ' + label);
}

if (/All gates must pass simultaneously/i.test(doc)) {
  pass('E.simul', 'plan requires all gates pass simultaneously');
} else {
  fail('E.simul', 'simultaneous-gate rule missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('F. Phase 19b compute-only scope');

const b19 = [
  ['default-deny', /default-deny/i],
  ['no WhatsApp call yet', /No actual WhatsApp call yet/i],
  ['computes auto_send_ready', /auto_send_ready/],
  ['computes blocked_gates', /blocked_gates/],
  ['computes allowed_send_kind', /allowed_send_kind/],
  ['computes send_reason', /send_reason/],
  ['computes idempotency_key_required', /idempotency_key_required/],
  ['gates off => auto_send_ready false', /env gates \*\*off\*\*.*auto_send_ready.*stays \*\*false\*\*/is],
  ['mocked on => safe ready', /test env gates \*\*mocked on\*\*.*auto_send_ready: ?true/is],
  ['risky blocked even with gates on', /risky cases remain \*\*blocked even with gates on\*\*/i],
];
for (const [label, re] of b19) {
  if (re.test(doc)) pass('F.' + key(label), '19b: ' + label);
  else fail('F.' + key(label), 'missing 19b: ' + label);
}

// ─────────────────────────────────────────────────────────────────────────────
section('G. Phase 19c send route + 19d proof + n8n role');

const c19 = [
  ['guest-reply-send route', /POST \/staff\/bot\/guest-reply-send/],
  ['refuses unless all gates pass', /refuses unless all gates pass/i],
  ['no booking/payment/Stripe', /does \*\*not\*\* create booking ?\/ ?payment ?\/ ?Stripe/i],
  ['sends only suggested_reply', /sends \*\*only\*\* the `suggested_reply`/i],
  ['audit event', /audit event/i],
  ['idempotency replay', /idempotency replay/i],
  ['pause check before send', /bot pause immediately before send/i],
];
for (const [label, re] of c19) {
  if (re.test(doc)) pass('G.c.' + key(label), '19c: ' + label);
  else fail('G.c.' + key(label), 'missing 19c: ' + label);
}

const d19 = [
  ['staging real test contact', /real test conversation\/contact/i],
  ['safe ask_missing_field send', /safe `ask_missing_field` send/i],
  ['safe show_quote send', /safe `show_quote` send/i],
  ['refund blocked', /refund \*\*blocked\*\*/i],
  ['idempotency no duplicate', /Idempotency replay does \*\*not\*\* send a duplicate/i],
  ['audit log written', /Audit log written/i],
  ['pause gate blocks send', /Pause gate \*\*blocks\*\* send/i],
];
for (const [label, re] of d19) {
  if (re.test(doc)) pass('G.d.' + key(label), '19d: ' + label);
  else fail('G.d.' + key(label), 'missing 19d: ' + label);
}

const n8n = [
  ['n8n remains message pipe', /n8n remains the \*\*message pipe\*\*/i],
  ['n8n calls draft route', /calls the Staff API \*\*draft route\*\*/i],
  ['n8n calls send route only if ready', /\*\*send route only if Staff API says ready\*\*/i],
  ['Staff API owns final send', /Staff API owns the final send decision/i],
  ['Staff API brain and send gate', /Staff API remains the brain and the send gate/i],
];
for (const [label, re] of n8n) {
  if (re.test(doc)) pass('G.n8n.' + key(label), 'n8n: ' + label);
  else fail('G.n8n.' + key(label), 'missing n8n: ' + label);
}

// ─────────────────────────────────────────────────────────────────────────────
section('H. Protective verifier requirements (no send in 19a)');

const protections = [
  ['no send implementation in 19a', /no send implementation in 19a/i],
  ['no graph.facebook.com call', /no `graph\.facebook\.com` call/i],
  ['no n8n activation', /no n8n activation/i],
  ['no booking/payment/Stripe/webhook', /no booking ?\/ ?payment ?\/ ?Stripe ?\/ ?webhook/i],
  ['production send gate required', /production send gate required/i],
  ['bot pause required', /bot pause required/i],
  ['idempotency required', /idempotency required/i],
  ['risky replies blocked', /risky replies blocked/i],
  ['only safe kinds initial', /safe `ask_missing_field` \/ `show_quote` are the only initial auto-send kinds/i],
];
for (const [label, re] of protections) {
  if (re.test(doc)) pass('H.' + key(label), 'guard: ' + label);
  else fail('H.' + key(label), 'missing guard: ' + label);
}

// ─────────────────────────────────────────────────────────────────────────────
section('I. Safety / NO_GO + prior artifact anchors');

if (/NO_GO/.test(doc)) pass('I1', 'plan documents live WhatsApp NO_GO');
else fail('I1', 'NO_GO missing');

if (/Stage 7\.8/.test(doc)) pass('I2', 'plan anchors Stage 7.8 owner gate');
else fail('I2', 'Stage 7.8 missing');

if (fs.existsSync(WF)) {
  const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
  if (wf.active === false) pass('I3', 'n8n shadow workflow still active:false');
  else fail('I3', 'shadow workflow active is not false');
} else {
  fail('I3', 'shadow workflow JSON missing');
}

// 19a is plan-only: no live send code shipped in this slice's doc/verifier.
const selfSrc = fs.readFileSync(__filename, 'utf8');
if (!/graph\.facebook\.com\/.*\/messages|sendWhatsApp\s*\(/.test(selfSrc.replace(/\/\*[\s\S]*?\*\//g, ''))) {
  pass('I4', 'verifier ships no live WhatsApp send call');
} else {
  fail('I4', 'verifier appears to contain a send call');
}

// ─────────────────────────────────────────────────────────────────────────────
section('J. npm script + prior closeouts exist (not executed)');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts
  && pkg.scripts['verify:luna-agent-phase19-autosend-gates-plan']
    === 'node scripts/verify-luna-agent-phase19-autosend-gates-plan.js') {
  pass('J1', 'verify:luna-agent-phase19-autosend-gates-plan registered');
} else {
  fail('J1', 'npm script missing or wrong path');
}

for (const [scriptName, relPath] of PRIOR_CLOSEOUTS) {
  const full = path.join(ROOT, relPath);
  if (pkg.scripts && pkg.scripts[scriptName]) pass('J.prior.' + scriptName, `${scriptName} registered`);
  else fail('J.prior.' + scriptName, `${scriptName} missing`);
  if (fs.existsSync(full)) pass('J.prior.file.' + scriptName, `${relPath} exists`);
  else fail('J.prior.file.' + scriptName, `${relPath} missing`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('K. Plan verifier is non-recursive (no downstream exec)');

if (!/execSync\s*\(\s*[`'"]npm run verify:/.test(selfSrc)) {
  pass('K1', 'plan verifier does not exec downstream npm scripts');
} else {
  fail('K1', 'plan verifier still execSync npm run downstream');
}

const elapsed = Math.round((Date.now() - startedMs) / 1000);
console.log(`\n--- ${passes} passed, ${failures} failed (${elapsed}s, non-recursive) ---\n`);
process.exit(failures > 0 ? 1 : 0);
