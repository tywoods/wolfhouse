/**
 * Stage 27demo-b — Verifier for open demo WhatsApp inbound dry-run.
 *
 * Usage:
 *   npm run verify:stage27demo-b-open-demo-inbound
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const GATE = path.join(__dirname, 'lib', 'open-demo-whatsapp-gate.js');
const HARNESS = path.join(__dirname, 'run-open-demo-whatsapp-inbound-dry-run.js');
const REVIEW_LIB = path.join(__dirname, 'lib', 'luna-guest-inbound-review-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27DEMO-B-OPEN-DEMO-WHATSAPP-INBOUND.md');
const SCRIPT = 'verify:stage27demo-b-open-demo-inbound';
const ROUTE = '/staff/bot/open-demo-whatsapp-inbound-dry-run';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27demo-b-open-demo-inbound.js  (Stage 27demo-b)\n');

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
const gateSrc = fs.existsSync(GATE) ? fs.readFileSync(GATE, 'utf8') : '';
const harnessSrc = fs.existsSync(HARNESS) ? fs.readFileSync(HARNESS, 'utf8') : '';
const reviewLibSrc = fs.existsSync(REVIEW_LIB) ? fs.readFileSync(REVIEW_LIB, 'utf8') : '';
const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

const routeIdx = src.indexOf(`pathname === OPEN_DEMO_WHATSAPP_ROUTE`);
const routeBlock = routeIdx > -1 ? src.slice(routeIdx, routeIdx + 600) : '';

const handlerStart = src.indexOf('async function handleBotOpenDemoWhatsAppInboundDryRun(');
const handlerEnd = handlerStart > -1
  ? src.indexOf('\nfunction parseGuestSimulatorChain(', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? src.slice(handlerStart, handlerEnd)
  : '';

const handlerCode = handler.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

section('A. Gate module');

if (fs.existsSync(GATE)) pass('A1', 'open-demo-whatsapp-gate.js exists');
else fail('A1', 'gate module missing');

if (gateSrc.includes('OPEN_DEMO_WHATSAPP_ENABLED')) pass('A2', 'OPEN_DEMO_WHATSAPP_ENABLED env gate');
else fail('A2', 'OPEN_DEMO_WHATSAPP_ENABLED missing');

if (/OPEN_DEMO_WHATSAPP_ENABLED\s*===\s*['"]true['"]/.test(gateSrc)) {
  pass('A3', 'demo gate defaults closed (explicit true required)');
} else {
  fail('A3', 'demo gate default-closed check missing');
}

if (gateSrc.includes('isProductionEnvironment') && gateSrc.includes('production_blocked')) {
  pass('A4', 'production rejection in gate');
} else {
  fail('A4', 'production rejection missing');
}

if (gateSrc.includes('OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID')) {
  pass('A5', 'OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID gate');
} else {
  fail('A5', 'phone_number_id gate missing');
}

if (!/ALLOWED_GUEST|guest_phone.*whitelist|guestAllowlist|isAllowedGuestPhone/i.test(gateSrc)) {
  pass('A6', 'no guest phone allowlist in gate');
} else {
  fail('A6', 'guest phone allowlist detected in gate');
}

try {
  execSync(`node --check "${GATE}"`, { stdio: 'pipe' });
  pass('A7', 'gate module passes node --check');
} catch {
  fail('A7', 'gate module syntax error');
}

section('B. Route and handler');

if (src.includes('OPEN_DEMO_WHATSAPP_ROUTE') || src.includes(`'${ROUTE}'`)) {
  pass('B1', `POST ${ROUTE} registered`);
} else {
  fail('B1', 'route not registered');
}

if (routeBlock.includes("method !== 'POST'")) pass('B2', 'POST-only guard');
else fail('B2', 'POST-only guard missing');

if (routeBlock.includes('requireBotAuth')) pass('B3', 'route uses requireBotAuth');
else fail('B3', 'requireBotAuth missing on route');

if (handlerStart > -1) pass('B4', 'handleBotOpenDemoWhatsAppInboundDryRun defined');
else fail('B4', 'handler missing');

if (routeBlock.includes('handleBotOpenDemoWhatsAppInboundDryRun')) pass('B5', 'router dispatches handler');
else fail('B5', 'handler not wired in route block');

if (handler.includes('evaluateOpenDemoWhatsAppGate')) pass('B6', 'handler evaluates demo gate');
else fail('B6', 'demo gate not evaluated in handler');

if (handler.includes('validateOpenDemoInboundBody')) pass('B7', 'handler validates n8n payload');
else fail('B7', 'payload validation missing');

if (handler.includes('runGuestInboundReviewDryRun(')) pass('B8', 'handler calls runGuestInboundReviewDryRun');
else fail('B8', 'inbound review path not called');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('B9', 'staff-query-api.js passes node --check');
} catch {
  fail('B9', 'staff-query-api.js syntax error');
}

section('C. Response safety flags');

const safetyChecks = [
  ['C1', 'sends_whatsapp: false', /sends_whatsapp:\s*false/],
  ['C2', 'live_send_blocked: true', /live_send_blocked:\s*true/],
  ['C3', 'open_demo: true', /open_demo:\s*true/],
  ['C4', 'demo_gate_blocked on reject', /demo_gate_blocked:\s*true/],
];
for (const [id, label, re] of safetyChecks) {
  if (re.test(handler) || re.test(gateSrc)) pass(id, label);
  else fail(id, `${label} missing`);
}

if (/no_write_performed:\s*true/.test(reviewLibSrc)) {
  pass('C5', '27x.1 lib sets no_write_performed: true');
} else {
  fail('C5', 'no_write_performed missing in review lib');
}

section('D. No live side effects');

const forbiddenInHandler = [
  ['D2', 'runGuestStripeTestLinkCreateApproved', 'Stripe link create'],
  ['D3', 'handleBotGuestReplySend', 'guest reply send'],
  ['D4', 'sendWhatsApp', 'WhatsApp send helper'],
];
for (const [id, sym, label] of forbiddenInHandler) {
  if (!handler.includes(sym)) pass(id, `handler does not call ${label}`);
  else fail(id, `handler calls ${label}`);
}

if (handler.includes('runGuestHoldPaymentDraftWriteDryRunApproved')) {
  if (/if\s*\(\s*createHoldDraftConfirmed\s*\)/.test(handler)
    && handler.includes('evaluateOpenDemoBookingWriteGate')) {
    pass('D1', 'hold/payment write gated by create_demo_hold_draft_confirmed + booking write gate');
  } else {
    fail('D1', 'hold/payment write not properly gated');
  }
} else {
  pass('D1', 'handler does not call hold/payment write');
}

if (!/api\.stripe\.com|graph\.facebook\.com/i.test(handlerCode)) {
  pass('D5', 'no Stripe/WhatsApp Graph fetch in handler');
} else {
  fail('D5', 'forbidden external URL in handler');
}

section('E. Harness');

if (fs.existsSync(HARNESS)) pass('E1', 'run-open-demo-whatsapp-inbound-dry-run.js exists');
else fail('E1', 'harness missing');

if (harnessSrc.includes('phone_number_id') && harnessSrc.includes('wamid')) {
  pass('E2', 'harness sends n8n-shaped payload');
} else {
  fail('E2', 'harness payload shape incomplete');
}

for (const fx of ['booking-turn-1', 'booking-turn-2', 'package-question', 'transfer-question']) {
  if (harnessSrc.includes(fx)) pass(`E3-${fx}`, `fixture ${fx}`);
  else fail(`E3-${fx}`, `fixture ${fx} missing`);
}

if (harnessSrc.includes('OPEN_DEMO_WHATSAPP_ROUTE') || harnessSrc.includes('open-demo-whatsapp-inbound-dry-run')) {
  pass('E4', 'harness targets open demo route');
} else {
  fail('E4', 'harness route target missing');
}

try {
  execSync(`node --check "${HARNESS}"`, { stdio: 'pipe' });
  pass('E5', 'harness passes node --check');
} catch {
  fail('E5', 'harness syntax error');
}

section('F. Docs');

if (fs.existsSync(DOC)) pass('F1', 'STAGE-27DEMO-B doc exists');
else fail('F1', 'doc missing');

if (/n8n.*pipe|pipe only/i.test(doc) && /Staff API.*brain|brain/i.test(doc)) {
  pass('F2', 'docs state n8n pipe / Staff API brain');
} else {
  fail('F2', 'architecture docs incomplete');
}

if (doc.includes('OPEN_DEMO_WHATSAPP_ENABLED')) pass('F3', 'docs cover env gates');
else fail('F3', 'env gates not documented');

if (doc.includes('phone_number_id') && doc.includes('wamid')) pass('F4', 'docs cover n8n payload');
else fail('F4', 'n8n payload not documented');

if (/27demo-c|live reply/i.test(doc)) pass('F5', 'docs mention next step 27demo-c');
else fail('F5', 'next step 27demo-c missing');

section('G. package.json');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('G1', `${SCRIPT} npm script`);
else fail('G1', `${SCRIPT} npm script missing`);

section('H. Gate unit smoke');

try {
  const gate = require('./lib/open-demo-whatsapp-gate');
  const disabled = gate.evaluateOpenDemoWhatsAppGate({}, {});
  if (!disabled.ok && disabled.code === 'demo_disabled') {
    pass('H1', 'gate closed when OPEN_DEMO_WHATSAPP_ENABLED unset');
  } else {
    fail('H1', 'gate should block when disabled');
  }
  const prod = gate.evaluateOpenDemoWhatsAppGate(
    { phone_number_id: 'x' },
    { NODE_ENV: 'production', OPEN_DEMO_WHATSAPP_ENABLED: 'true' },
  );
  if (!prod.ok && prod.code === 'production_blocked') {
    pass('H2', 'production blocked even when enabled');
  } else {
    fail('H2', 'production should always block');
  }
  const phoneMismatch = gate.evaluateOpenDemoWhatsAppGate(
    { phone_number_id: 'wrong' },
    { OPEN_DEMO_WHATSAPP_ENABLED: 'true', OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: 'demo-staging' },
  );
  if (!phoneMismatch.ok && phoneMismatch.code === 'phone_number_id_mismatch') {
    pass('H3', 'phone_number_id mismatch blocked');
  } else {
    fail('H3', 'phone_number_id gate should block mismatch');
  }
  const ok = gate.evaluateOpenDemoWhatsAppGate(
    { phone_number_id: 'demo-staging' },
    { OPEN_DEMO_WHATSAPP_ENABLED: 'true', OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: 'demo-staging' },
  );
  if (ok.ok) pass('H4', 'gate open when enabled + phone match');
  else fail('H4', 'gate should pass when configured correctly');
} catch (err) {
  fail('H0', `gate smoke test threw: ${err.message}`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
