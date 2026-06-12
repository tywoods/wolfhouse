/**
 * Phase 19e — Verifier for Luna WhatsApp provider + gated send route integration.
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-whatsapp-provider
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROVIDER = path.join(__dirname, 'lib', 'luna-whatsapp-provider.js');
const SEND_ROUTE = path.join(__dirname, 'lib', 'luna-guest-reply-send-route.js');
const API = path.join(__dirname, 'staff-query-api.js');
const PKG = path.join(ROOT, 'package.json');

const GATES_ON_ENV = {
  LUNA_AUTO_SEND_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'false',
};

const BASE_BODY = {
  client_slug: 'wolfhouse-somo',
  idempotency_key: 'phase19e-wa-test-001',
  send_kind: 'ask_missing_field',
  to: '+15555550180',
  suggested_reply: 'Which dates are you looking for?',
  source: 'guest_reply_draft',
  draft: {},
  send_eligibility: {
    send_allowed_later: true,
    requires_staff: false,
    auto_send_ready: true,
  },
};

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

const {
  sendLunaWhatsAppMessage,
  sendLunaWhatsAppTypingIndicator,
  shouldSendLunaWhatsAppTypingIndicator,
  resolveWhatsappProviderConfig,
} = require('./lib/luna-whatsapp-provider');
const {
  evaluateGuestReplySendRoute,
  evaluateGuestReplySendRouteWithPause,
} = require('./lib/luna-guest-reply-send-route');

console.log('\nverify-luna-agent-phase19-whatsapp-provider.js  (Phase 19e)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const providerSrc = readOrEmpty(PROVIDER);
const sendRouteSrc = readOrEmpty(SEND_ROUTE);
const apiSrc = readOrEmpty(API);
const combinedSrc = providerSrc + sendRouteSrc;

function readyBody(sendKind) {
  return { ...BASE_BODY, send_kind: sendKind, send_eligibility: { ...BASE_BODY.send_eligibility, allowed_send_kind: sendKind } };
}

const mockSendMessage = async () => ({
  success: true,
  whatsapp_message_id: 'mock-wamid-phase19e',
});

section('A. Provider helper');

if (fs.existsSync(PROVIDER)) pass('A1', 'luna-whatsapp-provider.js exists');
else fail('A1', 'provider helper missing');

if (/function\s+sendLunaWhatsAppMessage\s*\(/.test(providerSrc)) pass('A2', 'sendLunaWhatsAppMessage exported');
else fail('A2', 'sendLunaWhatsAppMessage missing');

if (/function\s+sendLunaWhatsAppTypingIndicator\s*\(/.test(providerSrc)) pass('A2b', 'sendLunaWhatsAppTypingIndicator exported');
else fail('A2b', 'sendLunaWhatsAppTypingIndicator missing');

if (/typing_indicator:\s*\{\s*type:\s*'text'\s*\}/.test(providerSrc)) pass('A2c', 'typing indicator uses Meta text payload');
else fail('A2c', 'typing indicator payload missing');

const executeSrc = readOrEmpty(path.join(__dirname, 'lib', 'open-demo-whatsapp-inbound-execute.js'));
if (executeSrc.includes('sendLunaWhatsAppTypingIndicator')) pass('A2d', 'open-demo inbound sends typing indicator before review');
else fail('A2d', 'open-demo inbound typing hook missing');

if (sendRouteSrc.includes("require('./luna-whatsapp-provider')")) pass('A3', 'send route imports provider');
else fail('A3', 'send route provider import missing');

if (apiSrc.includes('evaluateGuestReplySendRouteWithPause')) pass('A4', 'staff API uses gated send evaluator');
else fail('A4', 'staff API send evaluator missing');

section('B. Provider unit behavior');

(async () => {
  const dry = await sendLunaWhatsAppMessage(
    { to: '+15555550180', message: 'Hi', idempotency_key: 'x' },
    { WHATSAPP_DRY_RUN: 'true' },
  );
  if (dry.success === false && dry.blocked_reason === 'whatsapp_dry_run_active' && dry.send_performed === false) {
    pass('B.dry', 'WHATSAPP_DRY_RUN blocks provider call');
  } else fail('B.dry', 'dry-run block failed');

  const missing = await sendLunaWhatsAppMessage(
    { to: '+15555550180', message: 'Hi', idempotency_key: 'x' },
    { WHATSAPP_DRY_RUN: 'false' },
  );
  if (missing.success === false && missing.blocked_reason === 'whatsapp_provider_config_missing') {
    pass('B.config', 'missing provider config blocks safely');
  } else fail('B.config', 'config missing block failed');

  const mocked = await sendLunaWhatsAppMessage(
    { to: '+15555550180', message: 'Hi', idempotency_key: 'x' },
    { WHATSAPP_DRY_RUN: 'false' },
    { sendMessage: mockSendMessage },
  );
  if (mocked.success === true && mocked.send_performed === true && mocked.whatsapp_message_id) {
    pass('B.mock', 'mock provider simulates success without external call');
  } else fail('B.mock', 'mock provider success failed');

  const typingDry = await sendLunaWhatsAppTypingIndicator(
    { message_id: 'wamid.test123' },
    { WHATSAPP_DRY_RUN: 'true' },
  );
  if (typingDry.typing_indicator_sent !== true && typingDry.blocked_reason === 'whatsapp_dry_run_active') {
    pass('B.typing_dry', 'WHATSAPP_DRY_RUN blocks typing indicator');
  } else fail('B.typing_dry', 'typing dry-run block failed');

  const typingPhase = shouldSendLunaWhatsAppTypingIndicator('wamid.PHASE3E4.001', { WHATSAPP_DRY_RUN: 'false' });
  if (typingPhase === false) pass('B.typing_phase', 'phase test wamid skips typing indicator');
  else fail('B.typing_phase', 'phase test wamid should skip typing');

  const mockTyping = async () => ({ success: true });
  const typingMock = await sendLunaWhatsAppTypingIndicator(
    { message_id: 'wamid.live-test-001' },
    {
      WHATSAPP_DRY_RUN: 'false',
      WHATSAPP_CLOUD_ACCESS_TOKEN: 'test-token',
      WHATSAPP_PHONE_NUMBER_ID: '123456',
    },
    { sendTypingIndicator: mockTyping },
  );
  if (typingMock.typing_indicator_sent === true && typingMock.success === true) {
    pass('B.typing_mock', 'mock typing indicator succeeds without external call');
  } else fail('B.typing_mock', 'mock typing indicator failed');

  section('C. Send route gates-off (provider not reached)');

  const gatesOff = evaluateGuestReplySendRoute(BASE_BODY, { WHATSAPP_DRY_RUN: 'true', LUNA_AUTO_SEND_ENABLED: '' });
  if (gatesOff.result.blocked_reasons.includes('luna_auto_send_not_enabled')
    && !gatesOff.result.blocked_reasons.includes('whatsapp_dry_run_active')
    && gatesOff.result.would_send_whatsapp === false
    && gatesOff.result.send_performed === false
    && gatesOff.provider_pending !== true) {
    pass('C.off', 'gates-off blocks before provider');
  } else fail('C.off', 'gates-off block failed');

  section('D. Mocked gates on + mock provider send');

  async function assertMockSend(label, sendKind) {
    const out = await evaluateGuestReplySendRouteWithPause(readyBody(sendKind), {
      env: GATES_ON_ENV,
      sendMessage: mockSendMessage,
    });
    const r = out.result;
    if (r.success === true && r.send_performed === true && r.sends_whatsapp === true
      && r.whatsapp_message_id && r.no_write_performed === true) {
      pass('D.' + label, `${sendKind} mock send succeeds behind gates`);
    } else {
      fail('D.' + label, `${sendKind} mock send failed: ${JSON.stringify(r)}`);
    }
  }

  await assertMockSend('ask', 'ask_missing_field');
  await assertMockSend('quote', 'show_quote');
  await assertMockSend('checkin', 'checkin_day');

  const missingCfg = await evaluateGuestReplySendRouteWithPause(readyBody('ask_missing_field'), {
    env: GATES_ON_ENV,
  });
  if (missingCfg.result.success === false
    && missingCfg.result.send_performed === false
    && missingCfg.result.blocked_reasons.includes('whatsapp_provider_config_missing')) {
    pass('D.no_config', 'mocked gates on + missing config blocks at provider');
  } else {
    fail('D.no_config', 'missing config at provider failed');
  }

  section('E. Risky / validation still block before provider');

  const risky = await evaluateGuestReplySendRouteWithPause({
    ...BASE_BODY,
    send_eligibility: { send_allowed_later: false, requires_staff: true, auto_send_ready: false },
  }, { env: GATES_ON_ENV, sendMessage: mockSendMessage });
  if (risky.result.blocked_reasons.includes('requires_staff')
    && risky.result.send_performed === false
    && risky.result.success === false) {
    pass('E.risky', 'requires_staff blocks before provider even with gates on');
  } else fail('E.risky', 'requires_staff gate failed');

  const badKind = evaluateGuestReplySendRoute({ ...BASE_BODY, send_kind: 'send_confirmation' }, GATES_ON_ENV);
  if (badKind.status === 400 && badKind.result.error === 'unsupported_send_kind') pass('E.kind', 'unsupported send_kind blocks');
  else fail('E.kind', 'unsupported send_kind failed');

  const noIdem = evaluateGuestReplySendRoute({ ...BASE_BODY, idempotency_key: '' }, GATES_ON_ENV);
  if (noIdem.status === 400 && noIdem.result.error === 'idempotency_key_required') pass('E.idem', 'missing idempotency blocks');
  else fail('E.idem', 'idempotency validation failed');

  const dryRoute = await evaluateGuestReplySendRouteWithPause(readyBody('ask_missing_field'), {
    env: { WHATSAPP_DRY_RUN: 'true', LUNA_AUTO_SEND_ENABLED: 'true' },
  });
  if (dryRoute.result.blocked_reasons.includes('whatsapp_dry_run_active')
    && !dryRoute.result.blocked_reasons.includes('luna_auto_send_not_enabled')
    && dryRoute.result.would_send_whatsapp === true
    && dryRoute.result.send_performed === false
    && dryRoute.result.sends_whatsapp === false) {
    pass('E.dry_route', 'WHATSAPP_DRY_RUN true blocks at provider after route pass');
  } else fail('E.dry_route', 'provider dry-run gate failed: ' + JSON.stringify(dryRoute.result));

  section('F. Safety — no Stripe/booking/n8n/SQL/live fetch in verifier');

  if (!/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i.test(combinedSrc)) pass('F.sql', 'no SQL writes in provider/send-route');
  else fail('F.sql', 'SQL writes detected');

  for (const [id, re, label] of [
    ['F.stripe', /createStripe\s*\(|api\.stripe\.com|new\s+Stripe\s*\(/i, 'Stripe'],
    ['F.n8n', /activateN8n|triggerN8n|fetchN8n\s*\(/i, 'n8n'],
    ['F.booking', /booking-create-from-plan|create-payment-link/i, 'booking/payment routes'],
  ]) {
    if (!re.test(combinedSrc)) pass(id, `no ${label}`);
    else fail(id, `${label} detected`);
  }

  if (!sendRouteSrc.includes('guest_reply_whatsapp_send_not_implemented')) {
    pass('F.no_stub', 'not-implemented stub removed from send path');
  } else fail('F.no_stub', 'not-implemented stub still present');

  if (resolveWhatsappProviderConfig({}).access_token === '') pass('F.no_env_mut', 'no env mutation in config resolver');
  else fail('F.no_env_mut', 'unexpected env mutation');

  section('G. Downstream verifiers');

  for (const script of [
    'verify:luna-agent-phase19-guest-reply-send-route',
    'verify:luna-agent-phase19-checkin-day-preview',
    'verify:luna-agent-phase18-draft-builder',
  ]) {
    try {
      execSync(`npm run ${script}`, { stdio: 'pipe', cwd: ROOT, timeout: 120000 });
      pass('G.' + script, `${script} still passes`);
    } catch {
      fail('G.' + script, `${script} failed`);
    }
  }

  section('H. npm script');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (pkg.scripts && pkg.scripts['verify:luna-agent-phase19-whatsapp-provider']) pass('H1', 'npm script registered');
  else fail('H1', 'npm script missing');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error('VERIFIER_ERROR:', err.message);
  process.exit(1);
});
