/**
 * Phase 19d — Verifier for Luna guest reply send route (default-deny + readiness simulation).
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-guest-reply-send-route
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const API    = path.join(__dirname, 'staff-query-api.js');
const HELPER = path.join(__dirname, 'lib', 'luna-guest-reply-send-route.js');
const PKG    = path.join(ROOT, 'package.json');

const SAFETY = {
  send_performed: false,
  sends_whatsapp: false,
  would_send_whatsapp: false,
  no_write_performed: true,
  creates_booking: false,
  creates_payment: false,
  creates_stripe_link: false,
  calls_n8n: false,
};

const BASE_BODY = {
  client_slug: 'wolfhouse-somo',
  idempotency_key: 'guest-reply-send-test-001',
  send_kind: 'ask_missing_field',
  to: '+15555550180',
  suggested_reply: 'Which dates are you looking for?',
  source: 'guest_reply_draft',
  draft: {},
  send_eligibility: {
    send_allowed_later: true,
    requires_staff: false,
    auto_send_ready: false,
  },
};

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

function readOrEmpty(filePath) {
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }
  catch { return ''; }
}

const {
  evaluateGuestReplySendRoute,
  evaluateGuestReplySendRouteWithPause,
  SEND_ROUTE_SAFETY_FLAGS,
} = require('./lib/luna-guest-reply-send-route');

console.log('\nverify-luna-agent-phase19-guest-reply-send-route.js  (Phase 19d.2)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const helperSrc = readOrEmpty(HELPER);
const apiSrc    = readOrEmpty(API);
const routeIdx  = apiSrc.indexOf("'/staff/bot/guest-reply-send'");
const routeBlock = routeIdx > -1 ? apiSrc.slice(routeIdx, routeIdx + 700) : '';
const handlerStart = apiSrc.indexOf('async function handleBotGuestReplySend(');
const handlerEnd = handlerStart > -1
  ? apiSrc.indexOf('\n// Route: POST /staff/bot/guest-reply-draft', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';
const combinedSrc = helperSrc + handler;

section('A. Route + handler');

if (routeIdx > -1) pass('A1', 'POST /staff/bot/guest-reply-send registered');
else fail('A1', 'route not registered');

if (routeBlock.includes("method !== 'POST'")) pass('A2', 'POST-only guard');
else fail('A2', 'POST-only guard missing');

if (routeBlock.includes('requireBotAuth')) pass('A3', 'route uses requireBotAuth');
else fail('A3', 'requireBotAuth missing');

if (handler.includes('evaluateGuestReplySendRouteWithPause')) pass('A4', 'handler calls send route evaluator');
else fail('A4', 'send route evaluator missing');

if (handler.includes('appendAuditLog')) pass('A5', 'handler uses file audit log pattern');
else fail('A5', 'appendAuditLog missing');

if (handler.includes('send_performed:') && /send_performed:\s*false/.test(handler)) pass('A6', 'audit log pins send_performed false');
else fail('A6', 'send_performed audit pin missing');

section('B. Validation blocks');

function assertBlockedSafety(result) {
  return result.send_performed === false
    && result.sends_whatsapp === false
    && result.no_write_performed === true
    && result.creates_booking === false
    && result.creates_payment === false
    && result.creates_stripe_link === false
    && result.calls_n8n === false;
}

function assertReadyNotImplemented(result) {
  return result.success === false
    && result.auto_send_ready === true
    && result.would_send_whatsapp === true
    && result.send_performed === false
    && result.sends_whatsapp === false
    && Array.isArray(result.blocked_reasons)
    && result.blocked_reasons.includes('guest_reply_whatsapp_send_not_implemented')
    && !result.blocked_reasons.includes('luna_auto_send_not_enabled')
    && !result.blocked_reasons.includes('whatsapp_dry_run_active')
    && assertBlockedSafety(result);
}

const missingKey = evaluateGuestReplySendRoute({ ...BASE_BODY, idempotency_key: '' });
if (missingKey.status === 400 && missingKey.result.error === 'idempotency_key_required'
  && assertBlockedSafety(missingKey.result) && missingKey.result.would_send_whatsapp === false) {
  pass('B.idem', 'missing idempotency_key blocks');
} else {
  fail('B.idem', 'idempotency_key validation failed');
}

const missingReply = evaluateGuestReplySendRoute({ ...BASE_BODY, suggested_reply: '' });
if (missingReply.status === 400 && missingReply.result.error === 'suggested_reply_required'
  && assertBlockedSafety(missingReply.result)) {
  pass('B.reply', 'missing suggested_reply blocks');
} else {
  fail('B.reply', 'suggested_reply validation failed');
}

const badKind = evaluateGuestReplySendRoute({ ...BASE_BODY, send_kind: 'send_confirmation' });
if (badKind.status === 400 && badKind.result.error === 'unsupported_send_kind'
  && assertBlockedSafety(badKind.result)) {
  pass('B.kind', 'unsupported send_kind blocks');
} else {
  fail('B.kind', 'unsupported send_kind validation failed');
}

const staffBlock = evaluateGuestReplySendRoute({
  ...BASE_BODY,
  send_eligibility: { send_allowed_later: false, requires_staff: true, auto_send_ready: false },
});
if (staffBlock.result.success === false
  && staffBlock.result.blocked_reasons.includes('requires_staff')
  && assertBlockedSafety(staffBlock.result)) {
  pass('B.staff', 'requires_staff true blocks');
} else {
  fail('B.staff', 'requires_staff block failed');
}

section('C. Env gates off (default deny)');

const gatesOffEnv = {
  WHATSAPP_DRY_RUN: 'true',
  LUNA_AUTO_SEND_ENABLED: '',
};

function gatesOffCase(label, sendKind) {
  const out = evaluateGuestReplySendRoute({ ...BASE_BODY, send_kind: sendKind }, gatesOffEnv);
  const blocked = out.result.blocked_reasons || [];
  const ok = out.result.success === false
    && out.result.send_performed === false
    && blocked.includes('luna_auto_send_not_enabled')
    && blocked.includes('whatsapp_dry_run_active')
    && out.result.safe_next_step === 'keep_draft_or_handoff'
    && assertBlockedSafety(out.result);
  if (ok) pass('C.' + label, `${sendKind} blocked safely while gates off`);
  else fail('C.' + label, `${sendKind} gates-off case failed: ${JSON.stringify(out.result)}`);
}

gatesOffCase('ask', 'ask_missing_field');
gatesOffCase('quote', 'show_quote');
gatesOffCase('checkin', 'checkin_day');

section('C2. Mocked gates on — readiness simulation (no provider)');

const gatesOnEnv = {
  LUNA_AUTO_SEND_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'false',
};

function readyBody(sendKind) {
  return {
    ...BASE_BODY,
    send_kind: sendKind,
    send_eligibility: {
      send_allowed_later: true,
      requires_staff: false,
      auto_send_ready: true,
      allowed_send_kind: sendKind,
    },
  };
}

function readyNotImplementedCase(label, sendKind) {
  const out = evaluateGuestReplySendRoute(readyBody(sendKind), gatesOnEnv);
  if (assertReadyNotImplemented(out.result)) {
    pass('C2.' + label, `${sendKind} ready but blocked at provider-not-implemented`);
  } else {
    fail('C2.' + label, `${sendKind} readiness case failed: ${JSON.stringify(out.result)}`);
  }
}

readyNotImplementedCase('ask', 'ask_missing_field');
readyNotImplementedCase('quote', 'show_quote');
readyNotImplementedCase('checkin', 'checkin_day');

const riskyMocked = evaluateGuestReplySendRoute({
  ...BASE_BODY,
  send_eligibility: { send_allowed_later: false, requires_staff: true, auto_send_ready: false },
}, gatesOnEnv);
if (riskyMocked.result.success === false
  && riskyMocked.result.blocked_reasons.includes('requires_staff')
  && !riskyMocked.result.blocked_reasons.includes('guest_reply_whatsapp_send_not_implemented')
  && assertBlockedSafety(riskyMocked.result)) {
  pass('C2.risky', 'requires_staff still blocks with mocked gates on');
} else {
  fail('C2.risky', 'risky case with mocked gates failed');
}

const badKindMocked = evaluateGuestReplySendRoute(
  { ...readyBody('ask_missing_field'), send_kind: 'send_confirmation' },
  gatesOnEnv,
);
if (badKindMocked.status === 400 && badKindMocked.result.error === 'unsupported_send_kind') {
  pass('C2.bad_kind', 'unsupported send_kind still blocks with mocked gates on');
} else {
  fail('C2.bad_kind', 'unsupported send_kind with mocked gates failed');
}

const missingKeyMocked = evaluateGuestReplySendRoute(
  { ...readyBody('ask_missing_field'), idempotency_key: '' },
  gatesOnEnv,
);
if (missingKeyMocked.status === 400 && missingKeyMocked.result.error === 'idempotency_key_required') {
  pass('C2.no_idem', 'missing idempotency_key still blocks with mocked gates on');
} else {
  fail('C2.no_idem', 'missing idempotency with mocked gates failed');
}

if (helperSrc.includes('guest_reply_whatsapp_send_not_implemented')) {
  pass('C2.impl_flag', 'helper exposes provider-not-implemented block reason');
} else {
  fail('C2.impl_flag', 'provider-not-implemented reason missing from helper');
}

section('D. Safety — no send / write / external calls');

for (const [flag, val] of Object.entries(SAFETY)) {
  if (SEND_ROUTE_SAFETY_FLAGS[flag] === val) pass('D.flag.' + flag, `${flag}=${val}`);
  else fail('D.flag.' + flag, `expected ${flag}=${val}`);
}

if (!/\bINSERT\b/i.test(combinedSrc)) pass('D.sql.insert', 'no INSERT SQL');
else fail('D.sql.insert', 'INSERT SQL found');

if (!/\bUPDATE\b/i.test(combinedSrc)) pass('D.sql.update', 'no UPDATE SQL');
else fail('D.sql.update', 'UPDATE SQL found');

if (!/\bDELETE\b/i.test(combinedSrc)) pass('D.sql.delete', 'no DELETE SQL');
else fail('D.sql.delete', 'DELETE SQL found');

for (const [id, re, label] of [
  ['D.wa', /graph\.facebook\.com|api\.whatsapp/i, 'WhatsApp API'],
  ['D.stripe', /createStripe\s*\(|api\.stripe\.com|new\s+Stripe\s*\(/i, 'Stripe API'],
  ['D.n8n', /activateN8n|triggerN8n|fetchN8n\s*\(/i, 'n8n activation'],
  ['D.booking', /booking-create-from-plan|create-payment-link|stripe.*webhook/i, 'booking/payment/webhook writes'],
]) {
  if (!re.test(combinedSrc)) pass(id, `no ${label}`);
  else fail(id, `${label} detected`);
}

section('E. npm script');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:luna-agent-phase19-guest-reply-send-route']) {
  pass('E1', 'npm script registered');
} else {
  fail('E1', 'npm script missing');
}

section('F. Downstream verifiers still pass');

for (const script of [
  'verify:luna-agent-phase19-checkin-day-preview',
  'verify:luna-agent-phase18-draft-builder',
]) {
  try {
    execSync(`npm run ${script}`, { stdio: 'pipe', cwd: ROOT, timeout: 120000 });
    pass('F.' + script, `${script} still passes`);
  } catch (e) {
    fail('F.' + script, `${script} failed after send route add`);
  }
}

section('G. Pause gate (mock pg)');

(async () => {
  const mockPg = {
    query: async () => ({
      rows: [{
        id: 'pause-1',
        client_slug: 'wolfhouse-somo',
        guest_phone: '+15555550180',
        paused: true,
        pause_reason: 'test',
      }],
    }),
  };
  const paused = await evaluateGuestReplySendRouteWithPause(readyBody('ask_missing_field'), {
    pg: mockPg,
    env: gatesOnEnv,
  });
  if (paused.result.blocked_reasons.includes('gate_bot_paused')
    && paused.result.send_performed === false) {
    pass('G.pause', 'bot pause blocks send');
  } else {
    fail('G.pause', 'bot pause gate failed');
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error('VERIFIER_ERROR:', err.message);
  process.exit(1);
});
