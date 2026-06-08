/**
 * Stage 27v — Verifier for POST /staff/bot/guest-automation-review-dry-run.
 *
 * Usage:
 *   npm run verify:stage27v-guest-automation-review
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27V-GUEST-AUTOMATION-REVIEW.md');
const SCRIPT = 'verify:stage27v-guest-automation-review';
const REL = 'scripts/verify-stage27v-guest-automation-review.js';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27v-guest-automation-review.js  (Stage 27v)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

if (!fs.existsSync(API)) {
  fail('init', 'staff-query-api.js missing');
  process.exit(1);
}

const src = fs.readFileSync(API, 'utf8');

const routeIdx = src.indexOf("'/staff/bot/guest-automation-review-dry-run'");
const routeBlock = routeIdx > -1 ? src.slice(routeIdx, routeIdx + 800) : '';

const handlerStart = src.indexOf('async function handleBotGuestAutomationReviewDryRun(');
const handlerEnd = handlerStart > -1
  ? src.indexOf('\n// Phase 13c — in-memory req', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? src.slice(handlerStart, handlerEnd)
  : '';

const handlerCode = handler.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

section('A. Route and handler');

if (routeIdx > -1) pass('A1', 'POST /staff/bot/guest-automation-review-dry-run registered');
else fail('A1', 'route not registered');

if (routeBlock.includes("method !== 'POST'")) pass('A2', 'POST-only guard');
else fail('A2', 'POST-only guard missing');

if (routeBlock.includes('requireBotAuth')) pass('A3', 'route uses requireBotAuth');
else fail('A3', 'requireBotAuth missing on route');

if (handlerStart > -1) pass('A4', 'handleBotGuestAutomationReviewDryRun defined');
else fail('A4', 'handler missing');

if (routeBlock.includes('handleBotGuestAutomationReviewDryRun')) pass('A5', 'router dispatches handler');
else fail('A5', 'handler not wired in route block');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('A6', 'staff-query-api.js passes node --check');
} catch {
  fail('A6', 'staff-query-api.js syntax error');
}

section('B. Orchestrator integration');

if (/require\(['"]\.\/lib\/luna-guest-automation-orchestrator-dry-run['"]\)/.test(src)) {
  pass('B1', 'imports luna-guest-automation-orchestrator-dry-run');
} else {
  fail('B1', 'orchestrator module not imported');
}

if (handler.includes('runGuestAutomationOrchestratorDryRun(')) {
  pass('B2', 'handler calls runGuestAutomationOrchestratorDryRun');
} else {
  fail('B2', 'runGuestAutomationOrchestratorDryRun not called');
}

if (fs.existsSync(ORCH)) pass('B3', 'orchestrator module file exists');
else fail('B3', 'orchestrator module missing');

section('C. Required field validation');

if (/client_slug/.test(handler) && /channel/.test(handler) && /message_text/.test(handler)) {
  pass('C1', 'validates client_slug, channel, message_text');
} else {
  fail('C1', 'required field validation missing');
}

if (/sendJSON\(res,\s*400/.test(handler) && /required/.test(handler)) {
  pass('C2', '400 for missing required fields');
} else {
  fail('C2', '400 missing fields branch');
}

if (handler.includes('automation_gate_context')) pass('C3', 'forwards automation_gate_context');
else fail('C3', 'automation_gate_context not forwarded');

section('D. Review response shape');

const reviewChecks = [
  ['D1', 'review object', /review:\s*\{/],
  ['D2', 'review.automation_gate', /automation_gate:\s*orchOut\.automation_gate/],
  ['D3', 'review.proposed_next_action', /proposed_next_action:\s*orchOut\.proposed_next_action/],
  ['D4', 'review.proposed_luna_reply', /proposed_luna_reply:\s*orchOut\.proposed_luna_reply/],
  ['D5', 'review.handoff_reasons', /handoff_reasons:\s*collectGuestAutomationReviewHandoffReasons/],
  ['D6', 'dry_run: true', /dry_run:\s*true/],
  ['D7', 'sends_whatsapp: false', /sends_whatsapp:\s*false/],
  ['D8', 'live_send_blocked: true', /live_send_blocked:\s*true/],
];
for (const [id, label, re] of reviewChecks) {
  if (re.test(handler)) pass(id, label);
  else fail(id, `${label} missing in handler`);
}

section('E. Error behavior');

if (/sendJSON\(res,\s*500/.test(handler) && /guest automation review dry-run failed/.test(handler)) {
  pass('E1', '500 uses safe error message');
} else {
  fail('E1', '500 safe error missing');
}

if (!/err\.stack|stackTrace/.test(handler)) pass('E2', 'handler does not return stack traces');
else fail('E2', 'stack trace may leak in handler');

section('F. No live side effects in handler');

if (!/\bINSERT\s+INTO\b/i.test(handlerCode)) pass('F1', 'no INSERT in handler');
else fail('F1', 'INSERT in handler');

if (!/\bUPDATE\s+\w/i.test(handlerCode)) pass('F2', 'no UPDATE in handler');
else fail('F2', 'UPDATE in handler');

const forbiddenCalls = [
  ['F3', 'handleBotBookingCreate', 'booking create'],
  ['F4', 'handlePaymentCreateStripeLink', 'Stripe link create'],
  ['F5', 'handleBotGuestReplySend', 'guest reply send'],
  ['F6', 'runGuestConfirmationSendGoNoGo', 'confirmation send'],
  ['F7', 'runGuestHoldPaymentDraftWriteDryRunApproved', 'hold/payment write'],
  ['F8', 'sendWhatsApp', 'WhatsApp send'],
];
for (const [id, sym, label] of forbiddenCalls) {
  if (!handler.includes(sym)) pass(id, `handler does not call ${label}`);
  else fail(id, `handler calls ${label}`);
}

if (!/api\.stripe\.com|graph\.facebook\.com|fetch\s*\([^)]*n8n/i.test(handler)) {
  pass('F9', 'no Stripe/WhatsApp/n8n fetch in handler');
} else {
  fail('F9', 'forbidden external URL/call in handler');
}

section('G. No public webhook route');

if (!src.includes("'/webhook/guest-automation-review")) {
  pass('G1', 'no public guest-automation-review webhook');
} else {
  fail('G1', 'public webhook route detected');
}

if (routeIdx > -1 && src.indexOf('/staff/bot/guest-automation-review-dry-run') === routeIdx + 1) {
  pass('G2', 'review route is staff/bot scoped');
} else if (src.includes('/staff/bot/guest-automation-review-dry-run')) {
  pass('G2', 'review route under /staff/bot/');
} else {
  fail('G2', 'review route path missing');
}

const publicInboundPatterns = [
  ['/meta/whatsapp/webhook', 'Meta WhatsApp webhook'],
  ['/n8n/', 'n8n public path for review'],
];
for (let i = 0; i < publicInboundPatterns.length; i++) {
  const [pat, label] = publicInboundPatterns[i];
  if (!src.includes(`guest-automation-review`) || !src.includes(pat)) {
    pass(`G3.${i}`, `review not combined with ${label}`);
  }
}

section('H. Docs and npm script');

if (fs.existsSync(DOC)) pass('H1', 'STAGE-27V-GUEST-AUTOMATION-REVIEW.md exists');
else fail('H1', 'endpoint doc missing');

if (fs.existsSync(DOC)) {
  const doc = fs.readFileSync(DOC, 'utf8');
  if (doc.includes('/staff/bot/guest-automation-review-dry-run')) pass('H2', 'doc mentions endpoint path');
  else fail('H2', 'doc missing endpoint path');
  if (/staff-only|Staff-only|not public|not live send/i.test(doc)) pass('H3', 'doc states staff-only / not live');
  else fail('H3', 'doc missing safety notes');
  if (doc.includes('27u')) pass('H4', 'doc references 27u orchestrator');
  else fail('H4', 'doc missing 27u reference');
}

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${REL}`) pass('H5', `${SCRIPT} registered`);
else fail('H5', `${SCRIPT} missing in package.json`);

const BANNED_INTERNAL_COPY_RE = /\b(?:confirmed quote|payment choice|payment_choice|quote_status|guest_context|intake_state|readiness_state|automation gate|next_safe_step|dry run)\b/i;
const PARTIAL_BOOKING_MSG = 'Hi, we are 2 people interested in the Malibu package';

(async () => {
  section('I. Review reply — partial intake before payment choice');

  const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
  const orchOut = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo',
    channel: 'staff_review',
    message_text: PARTIAL_BOOKING_MSG,
    dry_run: true,
    reference_date: '2026-06-08',
    automation_gate_context: { public_guest_automation_enabled: false },
  }, {});

  const review = {
    automation_gate: orchOut.automation_gate,
    proposed_next_action: orchOut.proposed_next_action,
    proposed_luna_reply: orchOut.proposed_luna_reply,
    result: orchOut.result,
    quote: orchOut.quote,
    payment_choice: orchOut.payment_choice,
  };

  if (review.result && review.result.booking_intake_ready === false) pass('I1', 'booking_intake_ready false');
  else fail('I1', 'expected booking_intake_ready false');

  if (review.quote && review.quote.quote_status === 'not_ready') pass('I2', 'quote_status not_ready');
  else fail('I2', 'expected quote_status not_ready');

  if (review.payment_choice && review.payment_choice.payment_choice_capture_attempted === false) {
    pass('I3', 'payment_choice_capture_attempted false');
  } else fail('I3', 'payment choice capture should not run');

  if (review.proposed_luna_reply === review.result.proposed_luna_reply) {
    pass('I4', 'review.proposed_luna_reply prefers router reply');
  } else fail('I4', 'review reply must not use payment_choice during intake collection');

  if (/dates|guests|package|stay|details/i.test(review.proposed_luna_reply || '')) {
    pass('I5', 'review reply asks for missing stay details');
  } else fail('I5', `review reply: ${review.proposed_luna_reply}`);

  if (!BANNED_INTERNAL_COPY_RE.test(review.proposed_luna_reply || '')) {
    pass('I6', 'review reply avoids banned internal copy');
  } else fail('I6', `internal copy in review reply: ${review.proposed_luna_reply}`);

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
