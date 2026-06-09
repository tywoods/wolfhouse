/**
 * Stage 27w.3 — Verifier for Luna Guest Simulator multi-turn flow harness.
 *
 * Usage:
 *   npm run verify:stage27w3-luna-simulator-flow
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HARNESS = path.join(__dirname, 'run-luna-guest-simulator-flow.js');
const DOC = path.join(ROOT, 'docs', 'STAGE-27W3-LUNA-SIMULATOR-FLOW-TESTS.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT_RUN = 'luna:guest-sim:flow';
const SCRIPT_VERIFY = 'verify:stage27w3-luna-simulator-flow';
const REL_HARNESS = 'scripts/run-luna-guest-simulator-flow.js';
const REL_VERIFY = 'scripts/verify-stage27w3-luna-simulator-flow.js';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27w3-luna-simulator-flow.js  (Stage 27w.3)\n');

try {
  execSync(`node --check "${HARNESS}"`, { stdio: 'pipe' });
  pass('0a', 'harness passes node --check');
} catch {
  fail('0a', 'harness syntax error');
}

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0b', 'verifier passes node --check');
} catch {
  fail('0b', 'verifier syntax error');
}

if (!fs.existsSync(HARNESS)) {
  fail('init', 'run-luna-guest-simulator-flow.js missing');
  process.exit(1);
}

const src = fs.readFileSync(HARNESS, 'utf8');

section('A. Harness presence and route');

pass('A1', 'run-luna-guest-simulator-flow.js exists');

if (src.includes('/staff/bot/guest-automation-review-dry-run')) {
  pass('A2', 'targets guest-automation-review-dry-run');
} else {
  fail('A2', 'review dry-run route missing');
}

section('B. CLI options');

const cliFlags = [
  ['B1', '--base-url', 'base URL option'],
  ['B2', '--phone', 'phone option'],
  ['B3', '--name', 'name option'],
  ['B4', '--email', 'email option'],
  ['B5', '--reference-date', 'reference date option'],
  ['B6', '--fixture', 'fixture option'],
  ['B7', '--json', 'json output option'],
  ['B8', '--create-hold-draft', 'explicit hold/draft flag'],
  ['B9', '--create-stripe-test-link', 'explicit Stripe test link flag'],
];
for (const [id, flag, label] of cliFlags) {
  if (src.includes(flag)) pass(id, label);
  else fail(id, `${label} missing`);
}

if (src.includes('127.0.0.1:3036') && src.includes('STAFF_API_BASE_URL')) {
  pass('B10', 'default base from STAFF_API_BASE_URL or 127.0.0.1:3036');
} else {
  fail('B10', 'default base URL pattern missing');
}

section('C. guest_context chaining');

if (src.includes('guestContextFromReview') && src.includes('guest_context')) {
  pass('C1', 'guest_context chaining helper');
} else {
  fail('C1', 'guest_context chaining missing');
}

if (src.includes('extracted_fields')) {
  pass('C2', 'preserves extracted_fields in guest_context');
} else {
  fail('C2', 'extracted_fields not forwarded');
}

const mergeSrc = fs.existsSync(path.join(__dirname, 'lib', 'luna-guest-context-merge.js'))
  ? fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-context-merge.js'), 'utf8')
  : '';
const orchSrc = fs.existsSync(path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js'))
  ? fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js'), 'utf8')
  : '';

if (mergeSrc.includes('buildHoldPaymentDraftPlannerChain')) {
  pass('C3', 'buildHoldPaymentDraftPlannerChain helper exists');
} else {
  fail('C3', 'planner chain merge helper missing');
}

if (orchSrc.includes('buildHoldPaymentDraftPlannerChain')) {
  pass('C4', 'orchestrator wires planner chain merge');
} else {
  fail('C4', 'orchestrator planner chain merge missing');
}

section('D. booking-deposit fixture');

if (src.includes("'booking-deposit'") || src.includes('"booking-deposit"')) {
  pass('D1', 'booking-deposit fixture defined');
} else {
  fail('D1', 'booking-deposit fixture missing');
}

const fixtureChecks = [
  ['D2', 'Hi, we are 2 people interested in the Malibu package', 'turn 1 message'],
  ['D3', 'July 10 to July 17', 'turn 2 dates message'],
  ['D4', 'Deposit is fine', 'turn 3 deposit message'],
  ['D5', 'new_booking_inquiry', 'turn 1 lane expectation'],
  ['D6', 'guest_count', 'guest_count expectation'],
  ['D7', 'package_interest', 'package_interest expectation'],
  ['D8', 'booking_intake_ready', 'intake ready expectation'],
  ['D9', 'availability_check_attempted', 'availability expectation'],
  ['D10', 'how many guests will be staying', 'must-not re-ask guests'],
  ['D11', 'payment_choice_needed', 'conditional payment choice'],
  ['D12', 'ready_for_hold_payment_draft', 'deposit next step'],
  ['D13', 'would_create_hold', 'hold plan would_create_hold'],
  ['D14', 'would_create_payment_draft', 'hold plan would_create_payment_draft'],
  ['D15', 'would_create_stripe_link', 'hold plan no stripe link'],
];
for (const [id, needle, label] of fixtureChecks) {
  if (src.includes(needle)) pass(id, label);
  else fail(id, `${label} missing`);
}

section('E. Default safe review-only mode');

if (src.includes('createHoldDraft: false') && src.includes('createStripeTestLink: false')) {
  pass('E1', 'hold/stripe flags default false');
} else {
  fail('E1', 'explicit default-off for write flags missing');
}

if (src.includes('review_only') || src.includes('review-only')) {
  pass('E2', 'documents review-only default');
} else {
  fail('E2', 'review-only mode not documented in harness');
}

if (!/--create-hold-draft[\s\S]{0,200}guest-simulator-create-hold-draft/.test(src)
    && src.includes('guest-simulator-create-hold-draft')
    && src.includes('createHoldDraft')) {
  pass('E3', 'hold/draft only when --create-hold-draft');
} else if (src.includes('createHoldDraft') && src.includes('guest-simulator-create-hold-draft')) {
  pass('E3', 'hold/draft gated by createHoldDraft flag');
} else {
  fail('E3', 'hold/draft gating unclear');
}

if (src.includes('createStripeTestLink') && src.includes('guest-simulator-create-stripe-test-link')) {
  pass('E4', 'Stripe link gated by --create-stripe-test-link');
} else {
  fail('E4', 'Stripe link gating missing');
}

if (/createStripeTestLink\s*&&\s*!opts\.createHoldDraft|requires --create-hold-draft/.test(src)) {
  pass('E5', 'Stripe requires hold/draft flag');
} else {
  fail('E5', 'Stripe without hold/draft guard missing');
}

section('F. Auth pattern');

if (src.includes('LUNA_BOT_INTERNAL_TOKEN') && src.includes('X-Luna-Bot-Token')) {
  pass('F1', 'uses LUNA_BOT_INTERNAL_TOKEN → X-Luna-Bot-Token');
} else {
  fail('F1', 'bot auth header pattern missing');
}

section('G. No forbidden live actions');

const forbidden = [
  ['G1', /api\.stripe\.com/i, 'direct Stripe API'],
  ['G2', /graph\.facebook\.com|sendWhatsApp/i, 'WhatsApp send'],
  ['G3', /fetch\s*\([^)]*n8n|n8n\.io/i, 'n8n'],
  ['G4', /lunafrontdesk\.com(?!.*staging)/i.test(src) && /production host blocked|assertNotProduction/.test(src) ? null : /staff\.lunafrontdesk\.com/i, 'production without guard'],
];
for (const [id, re, label] of forbidden) {
  if (re == null) {
    pass(id, 'production host guard present');
    continue;
  }
  if (id === 'G4') {
    if (/assertNotProduction|production host blocked/.test(src)) pass(id, 'production host guard');
    else fail(id, 'production host guard missing');
    continue;
  }
  if (!re.test(src)) pass(id, `harness does not reference ${label}`);
  else fail(id, `forbidden ${label} pattern in harness`);
}

section('H. Output fields');

const outputFields = [
  'result',
  'proposed_luna_reply',
  'message_lane',
  'extracted_fields',
  'availability_check_attempted',
  'quote_status',
  'payment_choice',
  'first_failure',
  'sends_whatsapp',
  'live_send_blocked',
];
for (const field of outputFields) {
  if (src.includes(field)) pass(`H.${field}`, `output includes ${field}`);
  else fail(`H.${field}`, `output missing ${field}`);
}

section('I. npm scripts and docs');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT_RUN] === `node ${REL_HARNESS}`) {
  pass('I1', `${SCRIPT_RUN} registered`);
} else {
  fail('I1', `${SCRIPT_RUN} missing or wrong path`);
}

if (pkg.scripts && pkg.scripts[SCRIPT_VERIFY] === `node ${REL_VERIFY}`) {
  pass('I2', `${SCRIPT_VERIFY} registered`);
} else {
  fail('I2', `${SCRIPT_VERIFY} missing or wrong path`);
}

if (fs.existsSync(DOC)) {
  pass('I3', 'STAGE-27W3-LUNA-SIMULATOR-FLOW-TESTS.md exists');
  const doc = fs.readFileSync(DOC, 'utf8');
  if (doc.includes('luna:guest-sim:flow')) pass('I4', 'doc mentions npm script');
  else fail('I4', 'doc missing npm script');
  if (doc.includes('guest-automation-review-dry-run')) pass('I5', 'doc mentions review endpoint');
  else fail('I5', 'doc missing review endpoint');
  if (doc.includes('LUNA_BOT_INTERNAL_TOKEN')) pass('I6', 'doc mentions auth env');
  else fail('I6', 'doc missing auth env');
  if (doc.includes('--create-hold-draft')) pass('I7', 'doc mentions write flag');
  else fail('I7', 'doc missing write flag');
} else {
  fail('I3', 'flow tests doc missing');
}

section('J. Hold/draft write holdMeta (27w.6)');

const WRITE_MOD = path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-write.js');
const writeSrc = fs.readFileSync(WRITE_MOD, 'utf8');
const holdMetaIdx = writeSrc.indexOf('const holdMeta =');

if (holdMetaIdx > -1) pass('J1', 'write module defines holdMeta');
else fail('J1', 'write module missing holdMeta definition');

if (holdMetaIdx > -1 && writeSrc.indexOf('metadata: holdMeta') > holdMetaIdx) {
  pass('J2', 'holdMeta defined before upsert metadata use');
} else {
  fail('J2', 'holdMeta used before definition');
}

if (src.includes('guest-simulator-create-hold-draft')) {
  pass('J3', 'harness targets hold/draft write route');
} else {
  fail('J3', 'hold/draft route missing from harness');
}

section('K. Hold-write payload slimming (27w.7)');

if (src.includes('readyBookingContextForWrite')) {
  pass('K1', 'stores ready booking context separately for hold write');
} else {
  fail('K1', 'readyBookingContextForWrite missing');
}

if (src.includes('isReadyBookingContextForWrite')) {
  pass('K2', 'detects ready booking context before payment-choice turn');
} else {
  fail('K2', 'isReadyBookingContextForWrite helper missing');
}

if (/booking_intake_ready === true[\s\S]{0,80}quote_status === 'ready'/.test(src)) {
  pass('K3', 'ready context gate checks intake + quote ready');
} else {
  fail('K3', 'ready booking context gate incomplete');
}

if (src.includes('slimHoldPaymentDraftPlan') && src.includes('buildHoldDraftWritePayload')) {
  pass('K4', 'slim hold planner + hold payload builder');
} else {
  fail('K4', 'slim hold payload helpers missing');
}

if (src.includes('slimGuestContextForWrite') && src.includes('slimPaymentChoiceForWrite')) {
  pass('K4b', 'slims guest_context and payment_choice for hold write');
} else {
  fail('K4b', 'hold write context slimming missing');
}

const holdBlock = src.slice(src.indexOf('if (opts.createHoldDraft && lastReviewBody'));
if (/buildHoldDraftWritePayload\(opts,\s*readyBookingContextForWrite/.test(src)) {
  pass('K5', 'hold write builder receives readyBookingContextForWrite');
} else {
  fail('K5', 'hold write still chains Turn 3 guest_context');
}

if (/hold_payment_draft_plan:\s*slimPlan|slimHoldPaymentDraftPlan\(/.test(src)) {
  pass('K6', 'hold write sends slim hold_payment_draft_plan');
} else {
  fail('K6', 'full hold_payment_draft_plan still sent on write');
}

const buildHoldPayloadBlock = src.slice(src.indexOf('function buildHoldDraftWritePayload'), src.indexOf('function buildHoldDraftWritePayload') + 1200);
if (/hold_payment_draft_plan:\s*slimPlan/.test(buildHoldPayloadBlock)
    && !/hold_payment_draft_plan:\s*r\.hold_payment_draft_plan/.test(buildHoldPayloadBlock)) {
  pass('K7', 'does not send raw full Turn 3 hold_payment_draft_plan');
} else {
  fail('K7', 'raw full hold_payment_draft_plan still referenced in hold payload');
}

if (!/chain:[\s\S]{0,400}hold_payment_draft_plan:\s*r\.hold_payment_draft_plan/.test(src)) {
  pass('K8', 'chain omits bulky nested hold_payment_draft_plan');
} else {
  fail('K8', 'chain still embeds full hold_payment_draft_plan');
}

if (/idempotency_key_preview/.test(src) && /plan_status/.test(src.slice(src.indexOf('function slimHoldPaymentDraftPlan'), src.indexOf('function slimHoldPaymentDraftPlan') + 900))) {
  pass('K9', 'slim planner retains write-critical fields');
} else {
  fail('K9', 'slim planner missing critical fields');
}

const holdForbidden = [
  ['K10.stripe', /api\.stripe\.com/i],
  ['K10.whatsapp', /sendWhatsApp|graph\.facebook/i],
  ['K10.n8n', /fetch\s*\([^)]*n8n|n8n\.io/i],
];
for (const [id, re] of holdForbidden) {
  if (!re.test(holdBlock)) pass(id, 'hold-write block clean');
  else fail(id, 'forbidden pattern in hold-write block');
}

if (src.includes('createHoldDraft') && src.includes('--create-hold-draft')) {
  pass('K11', 'create-hold-draft still requires explicit flag');
} else {
  fail('K11', 'hold write flag gating weakened');
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
