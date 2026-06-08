/**
 * Stage 27c — Verifier for POST /staff/bot/guest-intake-dry-run.
 *
 * Usage:
 *   npm run verify:stage27c-guest-intake-endpoint
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27C-GUEST-INTAKE-ENDPOINT.md');
const SCRIPT = 'verify:stage27c-guest-intake-endpoint';
const REL = 'scripts/verify-stage27c-guest-intake-endpoint.js';

const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27c-guest-intake-endpoint.js  (Stage 27c)\n');

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

const routeIdx = src.indexOf("'/staff/bot/guest-intake-dry-run'");
const routeBlock = routeIdx > -1 ? src.slice(routeIdx, routeIdx + 700) : '';

const handlerStart = src.indexOf('async function handleBotGuestIntakeDryRun(');
const handlerEnd = handlerStart > -1
  ? src.indexOf('\n// Phase 13c — in-memory req', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? src.slice(handlerStart, handlerEnd)
  : '';

const handlerCode = handler.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

section('A. Route and handler');

if (routeIdx > -1) pass('A1', 'POST /staff/bot/guest-intake-dry-run registered');
else fail('A1', 'route not registered');

if (routeBlock.includes("method !== 'POST'")) pass('A2', 'POST-only guard');
else fail('A2', 'POST-only guard missing');

if (routeBlock.includes('requireBotAuth')) pass('A3', 'route uses requireBotAuth');
else fail('A3', 'requireBotAuth missing on route');

if (handlerStart > -1) pass('A4', 'handleBotGuestIntakeDryRun defined');
else fail('A4', 'handler missing');

if (routeBlock.includes('handleBotGuestIntakeDryRun')) pass('A5', 'router dispatches handler');
else fail('A5', 'handler not wired in route block');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('A6', 'staff-query-api.js passes node --check');
} catch {
  fail('A6', 'staff-query-api.js syntax error');
}

section('B. Router integration');

if (/require\(['"]\.\/lib\/luna-guest-message-router['"]\)/.test(src)) {
  pass('B1', 'imports luna-guest-message-router');
} else {
  fail('B1', 'luna-guest-message-router not imported');
}

if (handler.includes('runLunaGuestMessageRouterDryRun(')) pass('B2', 'handler calls runLunaGuestMessageRouterDryRun');
else fail('B2', 'runLunaGuestMessageRouterDryRun not called');

if (fs.existsSync(ROUTER)) pass('B3', 'router module file exists');
else fail('B3', 'router module missing');

section('C. Request validation');

if (/message_text is required/.test(handler)) pass('C1', '400 error message for missing message_text');
else fail('C1', 'missing message_text error string');

if (/String\(body\.message_text\)\.trim\(\)/.test(handler) && /if \(!messageText\)/.test(handler)) {
  pass('C2', 'message_text trimmed before validation');
} else {
  fail('C2', 'message_text trim validation missing');
}

if (handler.includes('language_hint') && handler.includes('guest_context')) {
  pass('C3', 'passes language_hint and guest_context to router input');
} else {
  fail('C3', 'optional body fields not forwarded');
}

section('D. Success response shape');

const shapeChecks = [
  ['D1', 'success: true branch', /success:\s*true[\s\S]{0,400}dry_run:\s*true/],
  ['D2', 'result payload', /result[\s,]/],
  ['D3', 'dry_run: true', /dry_run:\s*true/],
  ['D4', 'sends_whatsapp: false', /sends_whatsapp:\s*false/],
  ['D5', 'live_send_blocked: true', /live_send_blocked:\s*true/],
];
for (const [id, label, re] of shapeChecks) {
  if (re.test(handler)) pass(id, label);
  else fail(id, `${label} missing in handler`);
}

section('E. Error behavior');

if (/sendJSON\(res,\s*400/.test(handler) && /message_text is required/.test(handler)) {
  pass('E1', '400 for missing message_text');
} else {
  fail('E1', '400 missing message_text branch');
}

if (/sendJSON\(res,\s*500/.test(handler) && /guest intake dry-run failed/.test(handler)) {
  pass('E2', '500 uses safe error message');
} else {
  fail('E2', '500 safe error missing');
}

if (!/err\.stack|stackTrace/.test(handler)) pass('E3', 'handler does not return stack traces');
else fail('E3', 'stack trace may leak in handler');

section('F. No live side effects in handler');

if (!handler.includes('withPgClient')) pass('F1', 'handler does not use withPgClient (no DB)');
else fail('F1', 'handler uses withPgClient');

if (!/\bINSERT\s+INTO\b/i.test(handlerCode)) pass('F2', 'no INSERT in handler');
else fail('F2', 'INSERT in handler');

if (!/\bUPDATE\s+\w/i.test(handlerCode)) pass('F3', 'no UPDATE in handler');
else fail('F3', 'UPDATE in handler');

const forbiddenCalls = [
  ['F4', 'handleBotBookingCreate', 'booking create'],
  ['F5', 'handlePaymentCreateStripeLink', 'Stripe link create'],
  ['F6', 'handleBotGuestReplySend', 'guest reply send'],
  ['F7', 'sendWhatsApp', 'WhatsApp send'],
  ['F8', 'processMetaWhatsApp', 'Meta WhatsApp process'],
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

section('G. Router runtime shape (handler contract)');

const sample = runLunaGuestMessageRouterDryRun(
  { message_text: 'Hi, we are 2 people looking to stay June 15 to June 22, Malibu package' },
  { reference_date: '2026-06-08' },
);

if (sample.success && sample.dry_run === true) pass('G1', 'router returns success + dry_run');
else fail('G1', 'router sample failed');

if (sample.sends_whatsapp === false && sample.live_send_blocked === true) {
  pass('G2', 'router safety flags present');
} else {
  fail('G2', 'router safety flags missing');
}

const wrapped = {
  success: true,
  dry_run: true,
  sends_whatsapp: false,
  live_send_blocked: true,
  result: sample,
};
if (wrapped.result.message_lane && wrapped.result.proposed_luna_reply) {
  pass('G3', 'wrapped result includes lane + proposed_luna_reply');
} else {
  fail('G3', 'wrapped result incomplete');
}

const empty = runLunaGuestMessageRouterDryRun({ message_text: '' });
if (empty.success === false) pass('G4', 'router rejects empty message_text');
else fail('G4', 'router should fail on empty message_text');

section('H. Docs and npm script');

if (fs.existsSync(DOC)) pass('H1', 'STAGE-27C-GUEST-INTAKE-ENDPOINT.md exists');
else fail('H1', 'endpoint doc missing');

if (fs.existsSync(DOC)) {
  const doc = fs.readFileSync(DOC, 'utf8');
  if (doc.includes('/staff/bot/guest-intake-dry-run')) pass('H2', 'doc mentions endpoint path');
  else fail('H2', 'doc missing endpoint path');
  if (/dry_run.*true|sends_whatsapp.*false/i.test(doc)) pass('H3', 'doc mentions safety flags');
  else fail('H3', 'doc missing safety notes');
}

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${REL}`) pass('H4', `${SCRIPT} registered`);
else fail('H4', `${SCRIPT} missing in package.json`);

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
