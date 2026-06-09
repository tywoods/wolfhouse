/**
 * Stage 27x.1 — Verifier for POST /staff/bot/guest-inbound-review-dry-run.
 *
 * Usage:
 *   npm run verify:stage27x1-guest-inbound-review
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const LIB = path.join(__dirname, 'lib', 'luna-guest-inbound-review-dry-run.js');
const HARNESS = path.join(__dirname, 'run-guest-inbound-review-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27X1-GUEST-INBOUND-REVIEW.md');
const SCRIPT = 'verify:stage27x1-guest-inbound-review';
const REL = 'scripts/verify-stage27x1-guest-inbound-review.js';
const ROUTE = '/staff/bot/guest-inbound-review-dry-run';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27x1-guest-inbound-review.js  (Stage 27x.1)\n');

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
const libSrc = fs.existsSync(LIB) ? fs.readFileSync(LIB, 'utf8') : '';
const harnessSrc = fs.existsSync(HARNESS) ? fs.readFileSync(HARNESS, 'utf8') : '';

const routeIdx = src.indexOf(`'${ROUTE}'`);
const routeBlock = routeIdx > -1 ? src.slice(routeIdx, routeIdx + 900) : '';

const handlerStart = src.indexOf('async function handleBotGuestInboundReviewDryRun(');
const handlerEnd = handlerStart > -1
  ? src.indexOf('\nfunction parseGuestSimulatorChain(', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? src.slice(handlerStart, handlerEnd)
  : '';

const handlerCode = handler.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const libCode = libSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

section('A. Route and handler');

if (routeIdx > -1) pass('A1', `POST ${ROUTE} registered`);
else fail('A1', 'route not registered');

if (routeBlock.includes("method !== 'POST'")) pass('A2', 'POST-only guard');
else fail('A2', 'POST-only guard missing');

if (routeBlock.includes('requireBotAuth')) pass('A3', 'route uses requireBotAuth');
else fail('A3', 'requireBotAuth missing on route');

if (handlerStart > -1) pass('A4', 'handleBotGuestInboundReviewDryRun defined');
else fail('A4', 'handler missing');

if (routeBlock.includes('handleBotGuestInboundReviewDryRun')) pass('A5', 'router dispatches handler');
else fail('A5', 'handler not wired in route block');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('A6', 'staff-query-api.js passes node --check');
} catch {
  fail('A6', 'staff-query-api.js syntax error');
}

if (fs.existsSync(LIB)) {
  try {
    execSync(`node --check "${LIB}"`, { stdio: 'pipe' });
    pass('A7', 'luna-guest-inbound-review-dry-run.js passes node --check');
  } catch {
    fail('A7', 'lib module syntax error');
  }
} else {
  fail('A7', 'lib module missing');
}

section('B. Orchestrator integration');

if (/require\(['"]\.\/lib\/luna-guest-inbound-review-dry-run['"]\)/.test(src)) {
  pass('B1', 'imports luna-guest-inbound-review-dry-run');
} else {
  fail('B1', 'inbound review module not imported');
}

if (handler.includes('runGuestInboundReviewDryRun(')) {
  pass('B2', 'handler calls runGuestInboundReviewDryRun');
} else {
  fail('B2', 'runGuestInboundReviewDryRun not called in handler');
}

if (libSrc.includes('runGuestAutomationOrchestratorDryRun(')) {
  pass('B3', 'lib calls runGuestAutomationOrchestratorDryRun');
} else {
  fail('B3', 'orchestrator not called from lib');
}

section('C. Required field validation');

if (/guest_phone/.test(libSrc) && /client_slug/.test(libSrc) && /message_text/.test(libSrc)) {
  pass('C1', 'validates client_slug, channel, guest_phone, message_text');
} else {
  fail('C1', 'required field validation missing in lib');
}

if (/validateInboundReviewBody/.test(libSrc) && /missing/.test(libSrc)) {
  pass('C2', 'validation returns missing fields');
} else {
  fail('C2', 'validation helper incomplete');
}

if (libSrc.includes('buildInboundReviewIdempotencyKey')) {
  pass('C3', 'idempotency_key builder present');
} else {
  fail('C3', 'idempotency_key builder missing');
}

section('D. Review response shape');

const responseChecks = [
  ['D1', 'review object', /review,/],
  ['D2', 'proposed_luna_reply', /proposed_luna_reply/],
  ['D3', 'slim_guest_context_for_next_turn', /slim_guest_context_for_next_turn/],
  ['D4', 'dry_run: true', /dry_run:\s*true/],
  ['D5', 'sends_whatsapp: false', /sends_whatsapp:\s*false/],
  ['D6', 'live_send_blocked: true', /live_send_blocked:\s*true/],
  ['D7', 'no_write_performed: true', /no_write_performed:\s*true/],
];
for (const [id, label, re] of responseChecks) {
  if (re.test(libSrc)) pass(id, label);
  else fail(id, `${label} missing in lib`);
}

if (handler.includes('sends_whatsapp:') || libSrc.includes('sends_whatsapp:')) {
  pass('D8', 'safety flags in response path');
} else {
  fail('D8', 'safety flags missing');
}

section('E. No live side effects');

const forbiddenInHandler = [
  ['E1', 'runGuestHoldPaymentDraftWriteDryRunApproved', 'hold/payment write'],
  ['E2', 'runGuestStripeTestLinkCreateApproved', 'Stripe link create'],
  ['E3', 'handleBotGuestReplySend', 'guest reply send'],
  ['E4', 'sendWhatsApp', 'WhatsApp send'],
];
for (const [id, sym, label] of forbiddenInHandler) {
  if (!handler.includes(sym) && !libCode.includes(sym)) pass(id, `does not call ${label}`);
  else fail(id, `calls ${label}`);
}

if (!/api\.stripe\.com|graph\.facebook\.com|fetch\s*\([^)]*n8n/i.test(handler + libCode)) {
  pass('E5', 'no Stripe/WhatsApp/n8n fetch in handler/lib');
} else {
  fail('E5', 'forbidden external URL/call detected');
}

if (!libCode.includes('runGuestHoldPaymentDraftWriteDryRunApproved')
  && !libCode.includes('runGuestStripeTestLinkCreateApproved')) {
  pass('E6', 'lib avoids hold/Stripe write helpers');
} else {
  fail('E6', 'lib calls forbidden write helpers');
}

section('F. No public webhook route');

if (!src.includes("'/webhook/guest-inbound-review")) {
  pass('F1', 'no public guest-inbound-review webhook');
} else {
  fail('F1', 'public webhook route detected');
}

if (src.includes('/staff/bot/guest-inbound-review-dry-run')) {
  pass('F2', 'inbound review route under /staff/bot/');
} else {
  fail('F2', 'staff/bot route missing');
}

section('G. CLI harness');

if (fs.existsSync(HARNESS)) pass('G1', 'run-guest-inbound-review-dry-run.js exists');
else fail('G1', 'CLI harness missing');

if (harnessSrc.includes(ROUTE)) pass('G2', 'harness targets inbound review route');
else fail('G2', 'harness route mismatch');

if (harnessSrc.includes('booking-turn-1') && harnessSrc.includes('booking-turn-2') && harnessSrc.includes('payment-turn')) {
  pass('G3', 'harness fixtures defined');
} else {
  fail('G3', 'harness fixtures missing');
}

if (!harnessSrc.includes('guest-simulator-create-hold-draft')
  && !harnessSrc.includes('guest-simulator-create-stripe-test-link')) {
  pass('G4', 'harness is review-only (no hold/Stripe routes)');
} else {
  fail('G4', 'harness includes write routes');
}

if (harnessSrc.includes('slim_guest_context_for_next_turn') || harnessSrc.includes('guest_context')) {
  pass('G5', 'harness supports multi-turn guest_context chaining');
} else {
  fail('G5', 'harness missing context chaining');
}

try {
  execSync(`node --check "${HARNESS}"`, { stdio: 'pipe' });
  pass('G6', 'harness passes node --check');
} catch {
  fail('G6', 'harness syntax error');
}

section('H. Docs and npm script');

if (fs.existsSync(DOC)) pass('H1', 'STAGE-27X1-GUEST-INBOUND-REVIEW.md exists');
else fail('H1', 'endpoint doc missing');

if (fs.existsSync(DOC)) {
  const doc = fs.readFileSync(DOC, 'utf8');
  if (doc.includes(ROUTE)) pass('H2', 'doc mentions endpoint path');
  else fail('H2', 'doc missing endpoint path');
  if (/staff-only|staff\/bot|not public|no live send|review-only/i.test(doc)) pass('H3', 'doc states safety limits');
  else fail('H3', 'doc missing safety notes');
  if (doc.includes('27u') || doc.includes('orchestrator')) pass('H4', 'doc references orchestrator');
  else fail('H4', 'doc missing orchestrator reference');
  if (/persistence|deferred|conversations\.metadata/i.test(doc)) pass('H5', 'doc documents persistence choice');
  else fail('H5', 'doc missing persistence notes');
}

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${REL}`) pass('H6', `${SCRIPT} registered`);
else fail('H6', `${SCRIPT} npm script missing`);

if (pkg.scripts && pkg.scripts['luna:guest-inbound:review']) {
  pass('H7', 'luna:guest-inbound:review harness script registered');
} else {
  fail('H7', 'luna:guest-inbound:review npm script missing');
}

section('Summary');

console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
