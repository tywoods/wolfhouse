/**
 * Stage 28j.5 — payment choice → hold + draft + Stripe TEST link bridge (live staging).
 *
 * Usage:
 *   npm run verify:stage28j5-payment-choice-to-hold-stripe-link
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ADAPTER = path.join(__dirname, 'lib', 'meta-open-demo-inbound-adapter.js');
const EXECUTE = path.join(__dirname, 'lib', 'open-demo-whatsapp-inbound-execute.js');
const GATE = path.join(__dirname, 'lib', 'open-demo-whatsapp-gate.js');
const HOLD_WRITE = path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-write.js');
const STRIPE = path.join(__dirname, 'lib', 'luna-guest-stripe-test-link-create.js');
const PAYMENT_CHOICE = path.join(__dirname, 'lib', 'luna-guest-payment-choice-dry-run.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const SHORT_STAY = path.join(__dirname, 'lib', 'wolfhouse-short-stay-pricing.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28j5-payment-choice-to-hold-stripe-link';

const FORBIDDEN_DEFERRED_REPLY_RE =
  /I am not confirming the booking, creating a hold, or sending a payment link yet/i;

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage28j5-payment-choice-to-hold-stripe-link.js  (Stage 28j.5)\n');

for (const f of [ADAPTER, EXECUTE, GATE, HOLD_WRITE, STRIPE, PAYMENT_CHOICE]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('0', `${path.basename(f)} syntax error`);
  }
}

const adapterSrc = fs.readFileSync(ADAPTER, 'utf8');
const executeSrc = fs.readFileSync(EXECUTE, 'utf8');
const gateSrc = fs.readFileSync(GATE, 'utf8');
const holdSrc = fs.readFileSync(HOLD_WRITE, 'utf8');
const stripeSrc = fs.readFileSync(STRIPE, 'utf8');
const paymentSrc = fs.readFileSync(PAYMENT_CHOICE, 'utf8');
const orchSrc = fs.readFileSync(ORCH, 'utf8');
const shortStaySrc = fs.existsSync(SHORT_STAY) ? fs.readFileSync(SHORT_STAY, 'utf8') : '';
const pkg = fs.existsSync(PKG_FILE) ? JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')) : {};

section('A. Meta adapter write bridge');

if (adapterSrc.includes('buildMetaOpenDemoWriteConfirmFlags')
  && adapterSrc.includes('evaluateOpenDemoHoldDraftWriteReady')
  && adapterSrc.includes('isOpenDemoBookingWritesEnabled')) {
  pass('A1', 'write flags gated on payment_choice_ready + booking writes env');
} else {
  fail('A1', 'write confirm flag gating missing');
}

if (adapterSrc.includes('evaluateOpenDemoStripeTestLinkGate')
  && adapterSrc.includes('create_stripe_test_link_confirmed')) {
  pass('A2', 'stripe test link flag env-gated in adapter');
} else {
  fail('A2', 'stripe test link auto-confirm missing');
}

if (adapterSrc.includes('send_payment_link_whatsapp_confirmed')
  && adapterSrc.includes('evaluateOpenDemoWhatsAppLiveReplyGate')) {
  pass('A3', 'payment-link WhatsApp send gated on live reply gate');
} else {
  fail('A3', 'payment-link WhatsApp auto-confirm missing');
}

if (adapterSrc.includes('isProductionEnvironment')) {
  pass('A4', 'production guard in adapter routing');
} else {
  fail('A4', 'production block missing');
}

if (!adapterSrc.includes('confirmation_send') && !adapterSrc.includes('runGuestConfirmation')) {
  pass('A5', 'no confirmation send in adapter');
} else {
  fail('A5', 'confirmation send referenced in adapter');
}

section('B. Execute path — defer dry-run reply, run writes first');

if (executeSrc.includes('shouldDeferOpenDemoPaymentChoiceReviewReply')
  && executeSrc.includes('composeLunaGuestReply')) {
  pass('B1', 'payment-choice write bridge defers dry-run review reply');
} else {
  fail('B1', 'defer + post-write reply bridge missing');
}

if (executeSrc.includes('runGuestHoldPaymentDraftWriteDryRunApproved')
  && executeSrc.includes('runOpenDemoBookingBedAssignApproved')
  && executeSrc.includes('runGuestStripeTestLinkCreateApproved')) {
  pass('B2', 'execute reuses hold/draft, bed assign, Stripe TEST link helpers');
} else {
  fail('B2', 'existing write helpers not wired');
}

if (executeSrc.includes('evaluateOpenDemoBookingWriteGate')
  && executeSrc.includes('evaluateOpenDemoStripeTestLinkGate')) {
  pass('B3', 'writes require staging/live-safe gates');
} else {
  fail('B3', 'staging write gates missing in execute');
}

if (executeSrc.indexOf('deferPaymentChoiceReviewReply') < executeSrc.indexOf('createHoldDraftConfirmed')
  || executeSrc.includes('deferPaymentChoiceReviewReply && sendLiveReplyConfirmed')) {
  pass('B4', 'live reply after writes when payment bridge defers review copy');
} else {
  fail('B4', 'post-write live reply ordering may be wrong');
}

if (!executeSrc.includes('runGuestStripePaymentTruthApplyApproved')
  && !executeSrc.includes('runGuestConfirmation')) {
  pass('B5', 'no payment truth or confirmation from inbound execute');
} else {
  fail('B5', 'payment truth or confirmation must not run from execute');
}

if (holdSrc.includes('lookupExistingHoldPaymentDraft')
  && executeSrc.includes('runGuestHoldPaymentDraftWriteDryRunApproved')) {
  pass('B6', 'idempotent hold/draft reuse path available');
} else {
  fail('B6', 'duplicate booking guard missing');
}

section('C. Stripe TEST safety');

if (gateSrc.includes('isStripeLiveSecretKey') || gateSrc.includes('sk_live_')) {
  pass('C1', 'live Stripe key guard');
} else {
  fail('C1', 'sk_live_ guard missing');
}

if (gateSrc.includes('isStripeTestSecretKey') || gateSrc.includes('sk_test_')) {
  pass('C2', 'test mode guard');
} else {
  fail('C2', 'sk_test_ guard missing');
}

if (gateSrc.includes('OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED')
  && gateSrc.includes('evaluateOpenDemoStripeTestLinkGate')) {
  pass('C3', 'Stripe TEST link gate env-gated');
} else {
  fail('C3', 'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED gate missing');
}

if (!stripeSrc.includes('sk_live_') || /forbidden|blocked|live.*block/i.test(stripeSrc)) {
  pass('C4', 'Stripe link helper blocks or avoids live mode');
} else {
  fail('C4', 'live Stripe risk in stripe link helper');
}

section('D. Short-stay package_none context preserved');

if (orchSrc.includes('short_stay_accommodation')
  && shortStaySrc.includes('package_none')) {
  pass('D1', 'short-stay accommodation + package_none pricing path preserved');
} else {
  fail('D1', 'short-stay accommodation context missing');
}

if (paymentSrc.includes('deposit_ready')
  && paymentSrc.includes('if (needsPackage) return intro + L.ask_package')) {
  pass('D2', 'package prompt only when needsPackage (not on ready short-stay deposit path)');
} else {
  fail('D2', 'payment choice package prompt guard missing');
}

section('E. Live reply builder runtime');

const gate = require('./lib/open-demo-whatsapp-gate');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');
const adapter = require('./lib/meta-open-demo-inbound-adapter');

const readyReview = {
  result: {
    detected_language: 'en',
    message_lane: 'new_booking_inquiry',
    package_code: 'package_none',
    check_in: '2026-07-01',
    check_out: '2026-07-05',
    guest_count: 1,
    extracted_fields: {
      check_in: '2026-07-01',
      check_out: '2026-07-05',
      guest_count: 1,
      package_interest: 'accommodation_only',
    },
  },
  payment_choice: {
    payment_choice_ready: true,
    payment_choice: 'deposit',
    next_safe_step: 'ready_for_hold_payment_draft',
    proposed_luna_reply: 'Thanks — I noted you would like to pay the deposit. I am not confirming the booking, creating a hold, or sending a payment link yet.',
  },
  hold_payment_draft_plan: { plan_status: 'ready', payment_kind: 'deposit', payment_amount_cents: 10000 },
  quote: { quote_status: 'ready', deposit_options: { deposit_required_cents: 10000 }, quote_total_cents: 18000 },
};

const bridgeReply = composeLunaGuestReply({
  payload: readyReview,
  mode: 'live_staging',
  live_outcomes: {
    bookingWrite: { write_status: 'created', booking_code: 'WH-G27-TEST', payment_draft_id: 'pay-1' },
    paymentLinkSend: { payment_link_sent: false },
  },
}).reply;

if (bridgeReply && !FORBIDDEN_DEFERRED_REPLY_RE.test(bridgeReply)) {
  pass('E1', 'post-write reply excludes dry-run hold-defer language');
} else {
  fail('E1', `post-write reply still contains forbidden copy: ${bridgeReply}`);
}

if (bridgeReply && /held|hold/i.test(bridgeReply) && /staff will send|payment link/i.test(bridgeReply)) {
  pass('E2', 'hold + staff-will-send fallback copy when link not sent');
} else {
  fail('E2', `unexpected hold fallback copy: ${bridgeReply}`);
}

const linkSentReply = composeLunaGuestReply({
  payload: readyReview,
  mode: 'live_staging',
  live_outcomes: {
    bookingWrite: { write_status: 'created' },
    paymentLinkSend: { payment_link_sent: true },
  },
}).reply;
if (linkSentReply && /payment link I just sent|secure payment link/i.test(linkSentReply)) {
  pass('E3', 'payment link sent copy references payment link message');
} else {
  fail('E3', `payment link sent copy unexpected: ${linkSentReply}`);
}

const stagingEnv = {
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'false',
};
const body = { client_slug: 'wolfhouse-somo', guest_phone: '+491726422307', phone_number_id: '1152900101233109' };
const flagsOff = adapter.buildMetaOpenDemoWriteConfirmFlags(stagingEnv, readyReview, body);
if (flagsOff.create_demo_hold_draft_confirmed === true
  && flagsOff.assign_demo_bed_confirmed === true
  && flagsOff.create_stripe_test_link_confirmed === false) {
  pass('E4', 'hold/draft flags on when ready; stripe off when gate disabled');
} else {
  fail('E4', `unexpected flags with stripe gate off: ${JSON.stringify(flagsOff)}`);
}

const stripeEnv = {
  ...stagingEnv,
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true',
  STRIPE_LINKS_ENABLED: 'true',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STAFF_ACTIONS_ENABLED: 'true',
};
const flagsOn = adapter.buildMetaOpenDemoWriteConfirmFlags(stripeEnv, readyReview, body);
if (flagsOn.create_stripe_test_link_confirmed === true
  && flagsOn.send_payment_link_whatsapp_confirmed === false) {
  pass('E5', 'stripe on with live reply — composer owns inline URL (no separate payment-link send)');
} else {
  fail('E5', `stripe flags unexpected when live-reply gate on: ${JSON.stringify(flagsOn)}`);
}

if (gate.shouldDeferOpenDemoPaymentChoiceReviewReply(body, stagingEnv, readyReview, {
  send_live_reply_confirmed: true,
  create_demo_hold_draft_confirmed: true,
})) {
  pass('E6', 'defer dry-run review reply when write bridge ready');
} else {
  fail('E6', 'shouldDeferOpenDemoPaymentChoiceReviewReply returned false');
}

section('F. package.json script');

if (pkg.scripts && pkg.scripts[SCRIPT]) {
  pass('F1', 'npm script registered');
} else {
  fail('F1', `missing npm script ${SCRIPT}`);
}

section('Summary');

console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
