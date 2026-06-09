/**
 * Stage 27w — Luna Guest Simulator verifier (Staff Portal + API).
 *
 * Usage:
 *   npm run verify:stage27w-luna-guest-simulator
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const MERGE = path.join(__dirname, 'lib', 'luna-guest-context-merge.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27W-LUNA-GUEST-SIMULATOR.md');
const SCRIPT = 'verify:stage27w-luna-guest-simulator';
const REL = 'scripts/verify-stage27w-luna-guest-simulator.js';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27w-luna-guest-simulator.js  (Stage 27w)\n');

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

const holdRouteIdx = src.indexOf("if (pathname === '/staff/bot/guest-simulator-create-hold-draft')");
const stripeRouteIdx = src.indexOf("if (pathname === '/staff/bot/guest-simulator-create-stripe-test-link')");
const holdRouteBlock = holdRouteIdx > -1 ? src.slice(holdRouteIdx, holdRouteIdx + 900) : '';
const stripeRouteBlock = stripeRouteIdx > -1 ? src.slice(stripeRouteIdx, stripeRouteIdx + 900) : '';

const holdHandlerStart = src.indexOf('async function handleBotGuestSimulatorCreateHoldDraft(');
const holdHandlerEnd = holdHandlerStart > -1
  ? src.indexOf('\n// Route: POST /staff/bot/guest-simulator-create-stripe-test-link', holdHandlerStart)
  : -1;
const holdHandler = holdHandlerStart > -1 && holdHandlerEnd > holdHandlerStart
  ? src.slice(holdHandlerStart, holdHandlerEnd)
  : '';

const stripeHandlerStart = src.indexOf('async function handleBotGuestSimulatorCreateStripeTestLink(');
const stripeHandlerEnd = stripeHandlerStart > -1
  ? src.indexOf('\n// Phase 13c — in-memory req', stripeHandlerStart)
  : -1;
const stripeHandler = stripeHandlerStart > -1 && stripeHandlerEnd > stripeHandlerStart
  ? src.slice(stripeHandlerStart, stripeHandlerEnd)
  : '';

const holdHandlerCode = holdHandler.replace(/\/\/[^\n]*/g, '');
const stripeHandlerCode = stripeHandler.replace(/\/\/[^\n]*/g, '');

section('A. Staff Portal UI');

if (src.includes('Luna Guest Simulator')) pass('A1', 'UI contains Luna Guest Simulator');
else fail('A1', 'Luna Guest Simulator title missing');

if (src.includes('tab-luna-guest-simulator')) pass('A2', 'simulator tab panel exists');
else fail('A2', 'tab panel missing');

if (src.includes('lgs-btn-review') && src.includes('guest-automation-review-dry-run')) {
  pass('A3', 'UI calls guest-automation-review-dry-run');
} else {
  fail('A3', 'review endpoint call missing in UI');
}

if (src.includes('lgs-btn-hold') && src.includes('Create Test Hold + Draft Payment')) {
  pass('A4', 'Create Test Hold + Draft Payment button');
} else {
  fail('A4', 'hold button missing');
}

if (src.includes('lgs-btn-stripe') && src.includes('Create Stripe TEST Link')) {
  pass('A5', 'Create Stripe TEST Link button');
} else {
  fail('A5', 'Stripe button missing');
}

if (src.includes('stripe_checkout_url') && src.includes('lgs-stripe-url')) {
  pass('A6', 'UI displays stripe_checkout_url');
} else {
  fail('A6', 'stripe URL display missing');
}

if (src.includes('lgs-btn-use-context') && src.includes('Use review result as guest_context')
    && /lgsTextareaContextFromReview/.test(src) && /extracted_fields:\s*r\.result/.test(src)) {
  pass('A7', 'multi-turn guest_context helper preserves extracted_fields');
} else {
  fail('A7', 'guest_context merge fields missing in simulator');
}

if (/No WhatsApp sent/i.test(src) && /Stripe TEST/i.test(src)) {
  pass('A8', 'safety labels in UI');
} else {
  fail('A8', 'safety labels missing');
}

if (src.includes('hold_payment_draft_plan.plan_status') && src.includes('ready_for_hold_payment_draft')) {
  pass('A9', 'hold button gated on plan + payment choice');
} else {
  fail('A9', 'hold enable gates missing');
}

section('B. Hold/draft API route');

if (holdRouteIdx > -1) pass('B1', 'hold/draft route registered');
else fail('B1', 'hold route missing');

if (holdRouteBlock.includes('requireBotAuth')) pass('B2', 'hold route uses requireBotAuth');
else fail('B2', 'hold requireBotAuth missing');

if (holdHandler.includes('runGuestHoldPaymentDraftWriteDryRunApproved(')) {
  pass('B3', 'hold handler calls 27n write helper');
} else {
  fail('B3', '27n helper not called');
}

if (holdHandler.includes('confirm_write: true') && holdHandler.includes('confirm_simulator_write')) {
  pass('B4', 'confirm_write + confirm_simulator_write gates');
} else {
  fail('B4', 'confirm gates missing on hold handler');
}

if (holdHandler.includes('guestSimulatorProductionBlocked')) pass('B5', 'non-production gate');
else fail('B5', 'production block missing');

if (holdHandler.includes('buildGuestSimulatorWriteChain')) {
  pass('B6', 'hold handler normalizes write chain via buildGuestSimulatorWriteChain');
} else {
  fail('B6', 'buildGuestSimulatorWriteChain missing in hold handler');
}

if (holdHandler.includes('planner: planner || undefined')) {
  pass('B7', 'hold handler forwards ready planner to 27n write');
} else {
  fail('B7', 'ready planner forward missing');
}

if (holdHandler.includes('ready_for_hold_payment_draft')) {
  pass('B8', 'hold handler gates payment_choice next_safe_step');
} else {
  fail('B8', 'payment_choice write gate missing');
}

if (/lgsBuildHoldDraftWritePayload/.test(src) && /lgsReadyBookingContextForWrite/.test(src)) {
  pass('B9', 'UI hold payload uses ready booking context builder');
} else {
  fail('B9', 'UI hold payload missing ready booking context builder');
}

section('C. Stripe TEST API route');

if (stripeRouteIdx > -1) pass('C1', 'Stripe route registered');
else fail('C1', 'Stripe route missing');

if (stripeRouteBlock.includes('requireBotAuth')) pass('C2', 'Stripe route uses requireBotAuth');
else fail('C2', 'Stripe requireBotAuth missing');

if (stripeHandler.includes('runGuestStripeTestLinkCreateApproved(')) {
  pass('C3', 'Stripe handler calls 27o helper');
} else {
  fail('C3', '27o helper not called');
}

if (stripeHandler.includes('confirm_stripe_test_link: true') && stripeHandler.includes('confirm_simulator_stripe')) {
  pass('C4', 'confirm_stripe_test_link + confirm_simulator_stripe');
} else {
  fail('C4', 'Stripe confirm gates missing');
}

section('D. Safety — handlers');

const forbidden = [
  ['D1', 'handleBotGuestReplySend', holdHandler + stripeHandler],
  ['D2', 'runGuestConfirmationSendGoNoGo', holdHandler + stripeHandler],
  ['D3', 'sendWhatsApp', holdHandler + stripeHandler],
  ['D4', 'processMetaWhatsApp', holdHandler + stripeHandler],
];
for (const [id, sym, hay] of forbidden) {
  if (!hay.includes(sym)) pass(id, `handlers do not call ${sym}`);
  else fail(id, `forbidden ${sym} in handlers`);
}

if (!/api\.stripe\.com|graph\.facebook|n8n/i.test(holdHandler + stripeHandler)) {
  pass('D5', 'no direct Stripe/Meta/n8n fetch in handlers');
} else {
  fail('D5', 'forbidden fetch in handlers');
}

if (holdHandler.includes('sends_whatsapp: false') || holdHandler.includes('...writeOut')) {
  pass('D6', 'hold response preserves write safety flags');
} else {
  fail('D6', 'hold safety flags');
}

section('E. No public webhook');

if (!src.includes("'/webhook/guest-simulator")) pass('E1', 'no public guest-simulator webhook');
else fail('E1', 'public webhook detected');

if (!src.includes("'/guest-simulator-create-hold-draft'") || src.includes("'/staff/bot/guest-simulator-create-hold-draft'")) {
  pass('E2', 'routes under /staff/bot/ only');
} else {
  fail('E2', 'non-staff route path');
}

section('F. Docs and npm script');

if (fs.existsSync(DOC)) pass('F1', 'STAGE-27W doc exists');
else fail('F1', 'doc missing');

if (fs.existsSync(DOC)) {
  const doc = fs.readFileSync(DOC, 'utf8');
  if (doc.includes('npm run staff:api')) pass('F2', 'doc local usage');
  if (/No WhatsApp|no WhatsApp/i.test(doc)) pass('F3', 'doc no WhatsApp');
  if (/Stripe TEST/i.test(doc)) pass('F4', 'doc Stripe TEST only');
}

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('F5', 'staff-query-api.js passes node --check');
} catch {
  fail('F5', 'staff-query-api.js syntax error');
}

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${REL}`) pass('F6', `${SCRIPT} registered`);
else fail('F6', `${SCRIPT} missing`);

section('G. Simulator write chain normalization (27w.5)');

const {
  buildGuestSimulatorWriteChain,
} = require('./lib/luna-guest-context-merge');
const {
  runGuestHoldPaymentDraftPlannerDryRun,
} = require('./lib/luna-guest-hold-payment-draft-planner');

const priorBookingCtx = {
  message_lane: 'new_booking_inquiry',
  booking_intake_ready: true,
  readiness_state: 'ready_for_availability_check',
  result: {
    message_lane: 'new_booking_inquiry',
    booking_intake_ready: true,
    readiness_state: 'ready_for_availability_check',
    extracted_fields: {
      check_in: '2026-07-10',
      check_out: '2026-07-17',
      guest_count: 2,
      package_interest: 'malibu',
    },
    detected_language: 'en',
  },
  availability: {
    availability_check_attempted: true,
    availability_status: 'available',
  },
  quote: {
    quote_status: 'ready',
    payment_choice_needed: true,
    quote_total_cents: 59800,
    deposit_options: { deposit_required_cents: 20000 },
  },
};

const readyPlan = {
  plan_status: 'ready',
  would_create_hold: true,
  would_create_payment_draft: true,
  would_create_stripe_link: false,
  payment_kind: 'deposit',
  payment_amount_cents: 20000,
};

const writeBody = {
  guest_context: priorBookingCtx,
  hold_payment_draft_plan: readyPlan,
  chain: {
    result: {
      message_lane: 'general_question',
      booking_intake_ready: false,
      readiness_state: 'staff_handoff_required',
      extracted_fields: {},
    },
    availability: { availability_status: 'not_ready' },
    quote: { quote_status: 'not_ready' },
    payment_choice: {
      payment_choice_detected: true,
      payment_choice: 'deposit',
      payment_choice_ready: true,
      next_safe_step: 'ready_for_hold_payment_draft',
    },
  },
};

const normalized = buildGuestSimulatorWriteChain(writeBody);

if (normalized.chain.result && normalized.chain.result.message_lane === 'new_booking_inquiry') {
  pass('G1', 'write chain preserves prior new_booking_inquiry lane');
} else {
  fail('G1', `lane=${normalized.chain.result && normalized.chain.result.message_lane}`);
}

if (normalized.chain.availability && normalized.chain.availability.availability_status === 'available') {
  pass('G2', 'write chain preserves prior availability');
} else {
  fail('G2', 'availability not preserved');
}

if (normalized.chain.quote && normalized.chain.quote.quote_status === 'ready') {
  pass('G3', 'write chain preserves prior quote');
} else {
  fail('G3', 'quote not preserved');
}

if (normalized.planner && normalized.planner.plan_status === 'ready') {
  pass('G4', 'write body forwards ready hold_payment_draft_plan');
} else {
  fail('G4', 'ready planner not resolved');
}

const replanned = runGuestHoldPaymentDraftPlannerDryRun(normalized.chain, {});
if (replanned.plan_status === 'ready'
  && replanned.would_create_hold === true
  && replanned.would_create_payment_draft === true
  && replanned.would_create_stripe_link === false) {
  pass('G5', 'normalized chain passes planner gate (not planner_not_ready_for_write)');
} else {
  fail('G5', `replanned plan_status=${replanned.plan_status}`);
}

if (fs.existsSync(MERGE) && fs.readFileSync(MERGE, 'utf8').includes('buildGuestSimulatorWriteChain')) {
  pass('G6', 'buildGuestSimulatorWriteChain exported from context-merge');
} else {
  fail('G6', 'buildGuestSimulatorWriteChain missing');
}

section('I. Browser hold-write payload (27w.8)');

const lgsHoldUiBlock = src.slice(src.indexOf('function lgsCreateHoldDraft'), src.indexOf('function lgsCreateStripeLink'));
const lgsHoldPayloadBlock = src.slice(src.indexOf('function lgsBuildHoldDraftWritePayload'), src.indexOf('function lgsCreateHoldDraft'));

if (src.includes('lgsReadyBookingContextForWrite')) {
  pass('I1', 'UI stores lgsReadyBookingContextForWrite');
} else {
  fail('I1', 'lgsReadyBookingContextForWrite missing');
}

if (/lgsIsReadyBookingContextForWrite/.test(src)
    && /booking_intake_ready === true/.test(src)
    && /quote_status === 'ready'/.test(src)) {
  pass('I2', 'UI detects ready booking context before payment-choice turn');
} else {
  fail('I2', 'ready booking context gate missing in UI');
}

if (/lgsBuildHoldDraftWritePayload\(lgsReadyBookingContextForWrite/.test(lgsHoldUiBlock)) {
  pass('I3', 'Create Hold/Draft uses ready booking context, not textarea Turn 3 context');
} else {
  fail('I3', 'hold button still uses raw guest_context from textarea');
}

if (/lgsSlimHoldPaymentDraftPlan/.test(src) && /hold_payment_draft_plan:\s*lgsSlimHoldPaymentDraftPlan/.test(src)) {
  pass('I4', 'UI sends slim hold_payment_draft_plan');
} else {
  fail('I4', 'UI still sends full hold_payment_draft_plan');
}

if (!/hold_payment_draft_plan:\s*r\.hold_payment_draft_plan/.test(lgsHoldUiBlock)
    && !/guest_context:\s*guestCtx/.test(lgsHoldUiBlock)) {
  pass('I5', 'UI hold payload omits bulky raw review blobs');
} else {
  fail('I5', 'UI still sends bulky full review payload on hold write');
}

if (!/chain:[\s\S]{0,500}hold_payment_draft_plan:/.test(lgsHoldUiBlock)) {
  pass('I6', 'UI chain omits nested hold_payment_draft_plan');
} else {
  fail('I6', 'UI chain still embeds full hold plan');
}

if (lgsHoldUiBlock.includes("lgsPostJson('/staff/bot/guest-simulator-create-hold-draft'")
    && lgsHoldPayloadBlock.includes('confirm_simulator_write: true')) {
  pass('I7', 'hold button still calls create-hold-draft with confirm_simulator_write');
} else {
  fail('I7', 'hold route or confirm gate missing in UI');
}

const uiHoldForbidden = [
  ['I8.stripe', /api\.stripe\.com/i],
  ['I8.whatsapp', /sendWhatsApp|graph\.facebook/i],
  ['I8.n8n', /fetch\s*\([^)]*n8n|n8n\.io/i],
];
for (const [id, re] of uiHoldForbidden) {
  if (!re.test(lgsHoldUiBlock)) pass(id, 'UI hold block clean');
  else fail(id, 'forbidden pattern in UI hold block');
}

section('H. Write module holdMeta (27w.6)');

const WRITE_MOD = path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-write.js');
const writeSrc = fs.readFileSync(WRITE_MOD, 'utf8');
const holdMetaDef = writeSrc.indexOf('const holdMeta =');
const upsertUse = writeSrc.indexOf('metadata: holdMeta');

if (holdMetaDef > -1 && upsertUse > holdMetaDef) {
  pass('H1', 'holdMeta defined before upsert metadata reference');
} else {
  fail('H1', 'holdMeta must be defined before use in write module');
}

if (/idempotency_key/.test(writeSrc.slice(holdMetaDef, holdMetaDef + 500))) {
  pass('H2', 'holdMeta carries idempotency_key');
} else {
  fail('H2', 'holdMeta missing idempotency_key');
}

if (!/holdMeta is not defined/.test(writeSrc) && holdMetaDef > -1) {
  pass('H3', 'write module has no bare undefined holdMeta');
} else {
  fail('H3', 'holdMeta reference still broken');
}

if (!/api\.stripe\.com|sendWhatsApp|graph\.facebook|n8n/i.test(
  writeSrc.slice(holdMetaDef, holdMetaDef > -1 ? holdMetaDef + 700 : 0),
)) {
  pass('H4', 'holdMeta block excludes Stripe/WhatsApp/n8n');
} else {
  fail('H4', 'holdMeta must not include outbound send/link data');
}

section('J. Auto-chain guest_context (27w.9)');

const lgsRunReviewBlock = src.slice(src.indexOf('function lgsRunReview'), src.indexOf('function lgsTextareaContextFromReview'));

if (/lgsApplyReviewToGuestContext\(review\)/.test(lgsRunReviewBlock)) {
  pass('J1', 'successful review auto-updates guest_context textarea');
} else {
  fail('J1', 'lgsRunReview does not auto-chain guest_context');
}

if (src.includes('lgs-btn-use-context') && src.includes('function lgsUseReviewAsContext')) {
  pass('J2', 'manual Use review result as guest_context button retained');
} else {
  fail('J2', 'manual context button missing');
}

if (/lgsIsPaymentChoiceReviewTurn/.test(src)
    && /!lgsIsPaymentChoiceReviewTurn\(review\)/.test(lgsRunReviewBlock)) {
  pass('J3', 'readyBookingContextForWrite preserved on payment-choice turn');
} else {
  fail('J3', 'payment-choice turn may overwrite ready booking context');
}

if (src.includes('lgsTextareaContextFromReview') && src.includes('function lgsApplyReviewToGuestContext')) {
  pass('J4', 'shared helper builds textarea context from review');
} else {
  fail('J4', 'shared textarea context helper missing');
}

if (/lgsBuildHoldDraftWritePayload\(lgsReadyBookingContextForWrite/.test(lgsHoldUiBlock)) {
  pass('J5', 'hold write still uses slim lgsReadyBookingContextForWrite');
} else {
  fail('J5', 'hold write no longer uses ready booking context');
}

const lgsAutoChainBlock = src.slice(src.indexOf('function lgsApplyReviewToGuestContext'), src.indexOf('function lgsCreateHoldDraft'));
const autoChainForbidden = [
  ['J6.stripe', /api\.stripe\.com/i],
  ['J6.whatsapp', /sendWhatsApp|graph\.facebook/i],
  ['J6.n8n', /fetch\s*\([^)]*n8n|n8n\.io/i],
];
for (const [id, re] of autoChainForbidden) {
  if (!re.test(lgsAutoChainBlock)) pass(id, 'auto-chain block clean');
  else fail(id, 'forbidden pattern in auto-chain block');
}

if (!/PUBLIC_GUEST_AUTOMATION|public_guest_automation_enabled:\s*true/.test(lgsRunReviewBlock)) {
  pass('J7', 'review auto-chain does not enable public automation');
} else {
  fail('J7', 'public automation flag changed in review path');
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
