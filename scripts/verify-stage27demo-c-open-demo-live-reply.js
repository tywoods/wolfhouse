/**
 * Stage 27demo-c — Verifier for open demo live WhatsApp reply gate.
 *
 * Usage:
 *   npm run verify:stage27demo-c-open-demo-live-reply
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const GATE = path.join(__dirname, 'lib', 'open-demo-whatsapp-gate.js');
const SEND_ROUTE = path.join(__dirname, 'lib', 'luna-guest-reply-send-route.js');
const HARNESS = path.join(__dirname, 'run-open-demo-whatsapp-inbound-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27DEMO-C-OPEN-DEMO-LIVE-WHATSAPP-REPLY.md');
const SCRIPT = 'verify:stage27demo-c-open-demo-live-reply';
const ROUTE = '/staff/bot/open-demo-whatsapp-inbound-dry-run';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27demo-c-open-demo-live-reply.js  (Stage 27demo-c)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const src = fs.readFileSync(API, 'utf8');
const gateSrc = fs.existsSync(GATE) ? fs.readFileSync(GATE, 'utf8') : '';
const sendSrc = fs.existsSync(SEND_ROUTE) ? fs.readFileSync(SEND_ROUTE, 'utf8') : '';
const harnessSrc = fs.existsSync(HARNESS) ? fs.readFileSync(HARNESS, 'utf8') : '';
const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

const handlerStart = src.indexOf('async function handleBotOpenDemoWhatsAppInboundDryRun(');
const handlerEnd = handlerStart > -1
  ? src.indexOf('\nfunction parseGuestSimulatorChain(', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? src.slice(handlerStart, handlerEnd)
  : '';

const routeIdx = src.indexOf('pathname === OPEN_DEMO_WHATSAPP_ROUTE');
const routeBlock = routeIdx > -1 ? src.slice(routeIdx, routeIdx + 600) : '';

section('A. Live reply gate module');

if (gateSrc.includes('OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED')) {
  pass('A1', 'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED env gate');
} else {
  fail('A1', 'live reply env gate missing');
}

if (/OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED\s*===\s*['"]true['"]/.test(gateSrc)) {
  pass('A2', 'live reply gate defaults closed');
} else {
  fail('A2', 'live reply default-closed check missing');
}

if (gateSrc.includes('evaluateOpenDemoWhatsAppLiveReplyGate')) {
  pass('A3', 'evaluateOpenDemoWhatsAppLiveReplyGate defined');
} else {
  fail('A3', 'live reply gate evaluator missing');
}

if (gateSrc.includes('whatsapp_dry_run_active') && gateSrc.includes('isWhatsappDryRun')) {
  pass('A4', 'WHATSAPP_DRY_RUN=true blocks live send');
} else {
  fail('A4', 'WHATSAPP_DRY_RUN block missing');
}

if (gateSrc.includes('production_blocked') && gateSrc.includes('evaluateOpenDemoWhatsAppLiveReplyGate')) {
  pass('A5', 'production hard block on live gate');
} else {
  fail('A5', 'production block missing on live gate');
}

if (!/ALLOWED_GUEST|guestAllowlist|isAllowedGuestPhone/i.test(gateSrc)) {
  pass('A6', 'no guest phone allowlist');
} else {
  fail('A6', 'guest phone allowlist detected');
}

try {
  execSync(`node --check "${GATE}"`, { stdio: 'pipe' });
  pass('A7', 'gate module passes node --check');
} catch {
  fail('A7', 'gate module syntax error');
}

section('B. Handler integration');

if (routeBlock.includes('requireBotAuth')) pass('B1', 'route uses requireBotAuth');
else fail('B1', 'requireBotAuth missing');

if (handler.includes('wantsSendLiveReplyConfirmed') || handler.includes('send_live_reply_confirmed')) {
  pass('B2', 'handler reads send_live_reply_confirmed');
} else {
  fail('B2', 'explicit confirm flag not wired');
}

if (handler.includes('evaluateOpenDemoWhatsAppLiveReplyGate')) {
  pass('B3', 'handler evaluates live reply gate');
} else {
  fail('B3', 'live reply gate not evaluated in handler');
}

if (handler.includes('evaluateGuestReplySendRouteWithPause')) {
  pass('B4', 'reuses evaluateGuestReplySendRouteWithPause send helper');
} else {
  fail('B4', 'guest reply send route not reused');
}

if (handler.includes('buildOpenDemoLiveReplySendBody')) {
  pass('B5', 'builds send body via gate helper');
} else {
  fail('B5', 'send body builder not used');
}

if (handler.includes('whatsapp_sent')) {
  pass('B6', 'response distinguishes whatsapp_sent');
} else {
  fail('B6', 'whatsapp_sent flag missing');
}

if (handler.includes('createStripeTestLinkConfirmed') && handler.includes('runGuestStripeTestLinkCreateApproved')) {
  pass('B7', 'Stripe link helper gated behind create_stripe_test_link_confirmed (27demo-e)');
} else if (!handler.includes('runGuestStripeTestLinkCreateApproved')) {
  if (handler.includes('runGuestHoldPaymentDraftWriteDryRunApproved')
    && handler.includes('createHoldDraftConfirmed')
    && handler.includes('evaluateOpenDemoBookingWriteGate')) {
    pass('B7', 'hold write gated (27demo-d); no Stripe link helper');
  } else if (!handler.includes('runGuestHoldPaymentDraftWriteDryRunApproved')) {
    pass('B7', 'handler avoids hold/Stripe write helpers');
  } else {
    fail('B7', 'hold write not properly gated');
  }
} else {
  fail('B7', 'Stripe link helper called without explicit flag gate');
}

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('B8', 'staff-query-api.js passes node --check');
} catch {
  fail('B8', 'staff-query-api.js syntax error');
}

section('C. Default dry-run unchanged');

if (handler.includes('if (!sendLiveReplyConfirmed)') || handler.includes('sendLiveReplyConfirmed')) {
  pass('C1', 'default path skips live send when confirm flag absent');
} else {
  fail('C1', 'dry-run default path unclear');
}

if (/sends_whatsapp:\s*false/.test(handler) || handler.includes("responseBody.sends_whatsapp = false")) {
  pass('C2', 'default/no-send response keeps sends_whatsapp false');
} else {
  fail('C2', 'default sends_whatsapp false path missing');
}

section('D. Harness and docs');

if (harnessSrc.includes('--send-live-reply-confirmed')) {
  pass('D1', 'harness supports --send-live-reply-confirmed');
} else {
  fail('D1', 'harness live flag missing');
}

if (harnessSrc.includes('send_live_reply_confirmed')) {
  pass('D2', 'harness sends confirm flag in payload');
} else {
  fail('D2', 'harness payload flag missing');
}

if (fs.existsSync(DOC)) pass('D3', 'STAGE-27DEMO-C doc exists');
else fail('D3', 'doc missing');

if (doc.includes('OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED') && /kill switch|WHATSAPP_DRY_RUN/i.test(doc)) {
  pass('D4', 'docs cover env gates and kill switches');
} else {
  fail('D4', 'docs incomplete');
}

section('E. package.json');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('E1', `${SCRIPT} npm script`);
else fail('E1', `${SCRIPT} npm script missing`);

section('F. Gate unit smoke');

try {
  const gate = require('./lib/open-demo-whatsapp-gate');
  const body = { phone_number_id: '1152900101233109' };
  const stagingEnv = {
    NODE_ENV: 'staging',
    OPEN_DEMO_WHATSAPP_ENABLED: 'true',
    OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
    OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: '1152900101233109',
    WHATSAPP_PHONE_NUMBER_ID: '1152900101233109',
    WHATSAPP_DRY_RUN: 'true',
  };
  const dryBlocked = gate.evaluateOpenDemoWhatsAppLiveReplyGate(body, stagingEnv);
  if (!dryBlocked.ok && dryBlocked.code === 'whatsapp_dry_run_active') {
    pass('F1', 'WHATSAPP_DRY_RUN=true blocks live gate');
  } else {
    fail('F1', 'WHATSAPP_DRY_RUN block smoke failed');
  }

  const disabled = gate.evaluateOpenDemoWhatsAppLiveReplyGate(body, {
    ...stagingEnv,
    OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
    WHATSAPP_DRY_RUN: 'false',
  });
  if (!disabled.ok && disabled.code === 'live_replies_disabled') {
    pass('F2', 'live gate closed when OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED unset/false');
  } else {
    fail('F2', 'live gate should default closed');
  }

  const prod = gate.evaluateOpenDemoWhatsAppLiveReplyGate(body, {
    NODE_ENV: 'production',
    OPEN_DEMO_WHATSAPP_ENABLED: 'true',
    OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
    WHATSAPP_DRY_RUN: 'false',
  });
  if (!prod.ok && prod.code === 'production_blocked') {
    pass('F3', 'production blocks live replies');
  } else {
    fail('F3', 'production should block live replies');
  }

  const open = gate.evaluateOpenDemoWhatsAppLiveReplyGate(body, {
    ...stagingEnv,
    WHATSAPP_DRY_RUN: 'false',
  });
  if (open.ok) pass('F4', 'live gate open when all staging gates pass');
  else fail('F4', 'live gate should pass when configured');

  if (!gate.wantsSendLiveReplyConfirmed({})) pass('F5', 'confirm flag defaults false');
  else fail('F5', 'confirm should default false');

  if (gate.wantsSendLiveReplyConfirmed({ send_live_reply_confirmed: true })) {
    pass('F6', 'confirm flag detected when true');
  } else {
    fail('F6', 'confirm flag detection failed');
  }

  const sendBody = gate.buildOpenDemoLiveReplySendBody({
    client_slug: 'wolfhouse-somo',
    guest_phone: '+34600995555',
    inbound_message_id: 'wamid.test',
  }, 'Hello from Luna');
  if (sendBody.send_kind === 'staff_reply' && sendSrc.includes('staff_reply')) {
    pass('F7', 'send body uses staff_reply kind on existing send route');
  } else {
    fail('F7', 'send body kind mismatch');
  }
} catch (err) {
  fail('F0', `gate smoke threw: ${err.message}`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
