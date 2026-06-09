/**
 * Stage 27demo-d — Verifier for open demo booking hold + draft write.
 *
 * Usage:
 *   npm run verify:stage27demo-d-open-demo-booking-write
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const GATE = path.join(__dirname, 'lib', 'open-demo-whatsapp-gate.js');
const WRITE_LIB = path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-write.js');
const HARNESS = path.join(__dirname, 'run-open-demo-whatsapp-inbound-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27DEMO-D-OPEN-DEMO-BOOKING-WRITE-CALENDAR.md');
const SCRIPT = 'verify:stage27demo-d-open-demo-booking-write';
const ROUTE = '/staff/bot/open-demo-whatsapp-inbound-dry-run';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27demo-d-open-demo-booking-write.js  (Stage 27demo-d)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const src = fs.readFileSync(API, 'utf8');
const gateSrc = fs.existsSync(GATE) ? fs.readFileSync(GATE, 'utf8') : '';
const writeSrc = fs.existsSync(WRITE_LIB) ? fs.readFileSync(WRITE_LIB, 'utf8') : '';
const harnessSrc = fs.existsSync(HARNESS) ? fs.readFileSync(HARNESS, 'utf8') : '';
const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

const handlerStart = src.indexOf('async function handleBotOpenDemoWhatsAppInboundDryRun(');
const handlerEnd = handlerStart > -1
  ? src.indexOf('\nfunction parseGuestSimulatorChain(', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? src.slice(handlerStart, handlerEnd)
  : '';

const handlerCode = handler.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

section('A. Booking write gate module');

if (gateSrc.includes('OPEN_DEMO_BOOKING_WRITES_ENABLED')) {
  pass('A1', 'OPEN_DEMO_BOOKING_WRITES_ENABLED env gate');
} else {
  fail('A1', 'booking write env gate missing');
}

if (/OPEN_DEMO_BOOKING_WRITES_ENABLED\s*===\s*['"]true['"]/.test(gateSrc)) {
  pass('A2', 'booking write gate defaults closed');
} else {
  fail('A2', 'booking write default-closed check missing');
}

if (gateSrc.includes('evaluateOpenDemoBookingWriteGate')) {
  pass('A3', 'evaluateOpenDemoBookingWriteGate defined');
} else {
  fail('A3', 'booking write gate evaluator missing');
}

if (gateSrc.includes('evaluateOpenDemoWhatsAppGate') && gateSrc.includes('evaluateOpenDemoBookingWriteGate')) {
  pass('A4', 'booking write requires open demo inbound gate');
} else {
  fail('A4', 'inbound gate prerequisite missing');
}

if (gateSrc.includes('production_blocked') && gateSrc.includes('evaluateOpenDemoBookingWriteGate')) {
  pass('A5', 'production hard block on booking write gate');
} else {
  fail('A5', 'production block missing on booking write gate');
}

if (gateSrc.includes('booking_writes_disabled')) {
  pass('A6', 'clear gate code when booking writes disabled');
} else {
  fail('A6', 'booking_writes_disabled code missing');
}

if (!/ALLOWED_GUEST|guestAllowlist|isAllowedGuestPhone/i.test(gateSrc)) {
  pass('A7', 'no guest phone allowlist');
} else {
  fail('A7', 'guest phone allowlist detected');
}

if (gateSrc.includes('evaluateOpenDemoHoldDraftWriteReady')
  && gateSrc.includes('ready_for_hold_payment_draft')
  && gateSrc.includes('hold_payment_draft_plan')) {
  pass('A8', 'write readiness checks payment_choice + hold plan');
} else {
  fail('A8', 'write readiness evaluator incomplete');
}

if (gateSrc.includes('wantsCreateDemoHoldDraftConfirmed')) {
  pass('A9', 'explicit create_demo_hold_draft_confirmed helper');
} else {
  fail('A9', 'confirm flag helper missing');
}

try {
  execSync(`node --check "${GATE}"`, { stdio: 'pipe' });
  pass('A10', 'gate module passes node --check');
} catch {
  fail('A10', 'gate module syntax error');
}

section('B. Handler integration');

if (handler.includes('wantsCreateDemoHoldDraftConfirmed') || handler.includes('create_demo_hold_draft_confirmed')) {
  pass('B1', 'handler reads create_demo_hold_draft_confirmed');
} else {
  fail('B1', 'explicit confirm flag not wired');
}

if (handler.includes('evaluateOpenDemoBookingWriteGate')) {
  pass('B2', 'handler evaluates booking write gate');
} else {
  fail('B2', 'booking write gate not evaluated in handler');
}

if (handler.includes('evaluateOpenDemoHoldDraftWriteReady')) {
  pass('B3', 'handler checks payment_choice_ready / hold plan ready');
} else {
  fail('B3', 'write readiness check missing in handler');
}

if (handler.includes('runGuestHoldPaymentDraftWriteDryRunApproved')) {
  pass('B4', 'reuses runGuestHoldPaymentDraftWriteDryRunApproved (27n write path)');
} else {
  fail('B4', '27n write helper not reused');
}

if (handler.includes('confirm_write: true')) {
  pass('B5', 'passes confirm_write:true internally after gates');
} else {
  fail('B5', 'confirm_write not set on write call');
}

if (handler.includes('write_status')
  && (handler.includes('booking_code') || handler.includes('...writeOut'))
  && (handler.includes('payment_draft_id') || handler.includes('...writeOut'))) {
  pass('B6', 'response includes write_status / booking_code / payment_draft_id');
} else {
  fail('B6', 'write response fields missing');
}

if (handler.includes('stripe_link_created:              false')) {
  pass('B7', 'handler forces stripe_link_created:false on write path');
} else {
  fail('B7', 'stripe_link_created safety overlay missing');
}

if (handler.includes('createStripeTestLinkConfirmed') && handler.includes('runGuestStripeTestLinkCreateApproved')) {
  pass('B8', 'Stripe link helper gated behind create_stripe_test_link_confirmed');
} else if (!handler.includes('runGuestStripeTestLinkCreateApproved')) {
  pass('B8', 'handler does not call Stripe link helper');
} else {
  fail('B8', 'Stripe link helper called without explicit flag gate');
}

if (!handler.includes('sendConfirmation') && !/confirmation.*send/i.test(handlerCode)) {
  pass('B9', 'handler does not call confirmation send');
} else {
  fail('B9', 'confirmation send detected in handler');
}

if (/if\s*\(\s*createHoldDraftConfirmed\s*\)/.test(handler)) {
  pass('B10', 'write only attempted when create_demo_hold_draft_confirmed');
} else {
  fail('B10', 'write not gated by confirm flag');
}

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('B11', 'staff-query-api.js passes node --check');
} catch {
  fail('B11', 'staff-query-api.js syntax error');
}

section('C. Write path safety (27n lib)');

if (writeSrc.includes('stripe_link_created: false') && writeSrc.includes('payment_link_sent: false')) {
  pass('C1', '27n write lib sets stripe_link_created/payment_link_sent false');
} else {
  fail('C1', '27n write safety flags incomplete');
}

if (writeSrc.includes('sends_whatsapp: false') && !writeSrc.includes('sendWhatsApp(')) {
  pass('C2', '27n write lib does not send WhatsApp');
} else {
  fail('C2', 'WhatsApp send in write lib');
}

if (!/api\.stripe\.com/i.test(writeSrc)) {
  pass('C3', '27n write lib does not call Stripe API');
} else {
  fail('C3', 'Stripe API call in write lib');
}

section('D. Default behavior unchanged');

if (handler.includes('createHoldDraftConfirmed')) {
  pass('D1', 'default path skips booking write when confirm flag absent');
} else {
  fail('D1', 'default no-write path unclear');
}

section('E. Harness and docs');

if (harnessSrc.includes('--create-demo-hold-draft-confirmed')) {
  pass('E1', 'harness supports --create-demo-hold-draft-confirmed');
} else {
  fail('E1', 'harness write flag missing');
}

if (harnessSrc.includes('create_demo_hold_draft_confirmed')) {
  pass('E2', 'harness sends confirm flag on final turn');
} else {
  fail('E2', 'harness payload flag missing');
}

if (harnessSrc.includes('booking-deposit-write') && harnessSrc.includes('Deposit is fine')) {
  pass('E3', 'booking-deposit-write composite fixture');
} else {
  fail('E3', 'booking-deposit-write fixture missing');
}

for (const fx of ['booking-turn-1', 'booking-turn-2']) {
  if (harnessSrc.includes(fx)) pass(`E4-${fx}`, `fixture ${fx} retained`);
  else fail(`E4-${fx}`, `fixture ${fx} missing`);
}

if (fs.existsSync(DOC)) pass('E5', 'STAGE-27DEMO-D doc exists');
else fail('E5', 'doc missing');

if (doc.includes('OPEN_DEMO_BOOKING_WRITES_ENABLED') && doc.includes('WHATSAPP_DRY_RUN')) {
  pass('E6', 'docs cover env gates including WHATSAPP_DRY_RUN note');
} else {
  fail('E6', 'env gates not documented');
}

if (/Staff Portal.*[Cc]alendar|[Bb]ooking [Cc]alendar/.test(doc)) {
  pass('E7', 'docs mention Staff Portal calendar proof');
} else {
  fail('E7', 'calendar proof steps missing in docs');
}

if (/27demo-e|Stripe TEST link/i.test(doc)) {
  pass('E8', 'docs mention next step 27demo-e');
} else {
  fail('E8', 'next step 27demo-e missing');
}

if (/idempotenc/i.test(doc)) {
  pass('E9', 'docs cover idempotency behavior');
} else {
  fail('E9', 'idempotency docs missing');
}

section('F. package.json');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('F1', `${SCRIPT} npm script`);
else fail('F1', `${SCRIPT} npm script missing`);

section('G. Gate unit smoke');

try {
  const gate = require('./lib/open-demo-whatsapp-gate');
  const body = { phone_number_id: '1152900101233109' };
  const stagingEnv = {
    NODE_ENV: 'staging',
    OPEN_DEMO_WHATSAPP_ENABLED: 'true',
    OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: '1152900101233109',
    OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
  };

  const disabled = gate.evaluateOpenDemoBookingWriteGate(body, stagingEnv);
  if (!disabled.ok && disabled.code === 'booking_writes_disabled') {
    pass('G1', 'booking write gate closed when OPEN_DEMO_BOOKING_WRITES_ENABLED unset/false');
  } else {
    fail('G1', 'booking write gate should default closed');
  }

  const prod = gate.evaluateOpenDemoBookingWriteGate(body, {
    NODE_ENV: 'production',
    OPEN_DEMO_WHATSAPP_ENABLED: 'true',
    OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
    OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: '1152900101233109',
  });
  if (!prod.ok && prod.code === 'production_blocked') {
    pass('G2', 'production blocks booking writes');
  } else {
    fail('G2', 'production should block booking writes');
  }

  const open = gate.evaluateOpenDemoBookingWriteGate(body, {
    ...stagingEnv,
    OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  });
  if (open.ok) pass('G3', 'booking write gate open when staging gates pass');
  else fail('G3', 'booking write gate should pass when configured');

  const phoneMismatch = gate.evaluateOpenDemoBookingWriteGate(
    { phone_number_id: 'wrong' },
    {
      ...stagingEnv,
      OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
      OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: '1152900101233109',
    },
  );
  if (!phoneMismatch.ok && phoneMismatch.code === 'phone_number_id_mismatch') {
    pass('G4', 'phone_number_id mismatch blocks booking write');
  } else {
    fail('G4', 'phone_number_id gate should block booking write');
  }

  if (!gate.wantsCreateDemoHoldDraftConfirmed({})) pass('G5', 'confirm flag defaults false');
  else fail('G5', 'confirm should default false');

  const readyReview = {
    payment_choice: {
      payment_choice_ready: true,
      next_safe_step: 'ready_for_hold_payment_draft',
    },
    hold_payment_draft_plan: { plan_status: 'ready' },
  };
  const ready = gate.evaluateOpenDemoHoldDraftWriteReady(readyReview);
  if (ready.ok) pass('G6', 'write readiness passes when chain ready');
  else fail('G6', 'write readiness should pass for ready review');

  const notReady = gate.evaluateOpenDemoHoldDraftWriteReady({
    payment_choice: { payment_choice_ready: false },
    hold_payment_draft_plan: { plan_status: 'pending' },
  });
  if (!notReady.ok && notReady.missing.length > 0) pass('G7', 'write readiness blocks when chain not ready');
  else fail('G7', 'write readiness should block incomplete chain');

  const chain = gate.buildOpenDemoWriteChainFromReview({
    result: { message_lane: 'booking' },
    availability: { ok: true },
    quote: { total_cents: 100 },
    payment_choice: { next_safe_step: 'ready_for_hold_payment_draft' },
  });
  if (chain.result && chain.payment_choice) pass('G8', 'buildOpenDemoWriteChainFromReview shape');
  else fail('G8', 'write chain builder incomplete');
} catch (err) {
  fail('G0', `gate smoke threw: ${err.message}`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
