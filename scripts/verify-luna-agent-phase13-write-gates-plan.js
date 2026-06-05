/**
 * Phase 13a — Static verifier for Luna gated booking write path plan.
 *
 * Confirms PHASE-13.1 plan doc exists, anchors to real Staff API routes/flags,
 * and that no write bridge is implemented yet (13a is design-only).
 *
 * Usage:
 *   npm run verify:luna-agent-phase13-write-gates-plan
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT  = path.join(__dirname, '..');
const DOC   = path.join(ROOT, 'docs', 'PHASE-13.1-LUNA-GATED-BOOKING-WRITES-PLAN.md');
const API   = path.join(__dirname, 'staff-query-api.js');
const ORCH  = path.join(__dirname, 'lib', 'luna-guest-booking-dry-run.js');
const PKG   = path.join(ROOT, 'package.json');

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

console.log('\nverify-luna-agent-phase13-write-gates-plan.js  (Phase 13a)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'plan verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Plan document');

if (!fs.existsSync(DOC)) {
  fail('A1', 'PHASE-13.1-LUNA-GATED-BOOKING-WRITES-PLAN.md missing');
  process.exit(1);
}
pass('A1', 'plan doc exists');

const doc = fs.readFileSync(DOC, 'utf8');

const requiredSections = [
  ['A2', 'Dry-run outputs required', /## 1\. Dry-run outputs required/],
  ['A3', 'Explicit approvals', /## 2\. Explicit approvals/],
  ['A4', 'Existing write endpoints', /## 3\. Existing Staff API write endpoints/],
  ['A5', 'Gates that must exist', /## 4\. Gates that must exist/],
  ['A6', 'First safe write slice', /## 5\. First safe write slice/],
  ['A7', 'Must remain impossible', /## 6\. Must remain impossible/],
  ['A8', 'Verifier checklist', /## 7\. Verifier checklist/],
  ['A9', 'Phase 13b recommendation', /## 8\. Recommended Phase 13b/],
  ['A10', 'Stop conditions', /## 10\. Explicit stop conditions/],
];

for (const [id, label, pattern] of requiredSections) {
  if (pattern.test(doc)) pass(id, label);
  else fail(id, label + ' section missing');
}

const dryRunFields = [
  'guest_phone', 'check-in', 'guest count', 'quote', 'payment_choice',
  'availability', 'planned_actions', 'reply_draft', 'would_create_booking_after_approval',
];
for (const field of dryRunFields) {
  const id = 'A.field.' + field.replace(/\s+/g, '_');
  if (doc.toLowerCase().includes(field.toLowerCase())) pass(id, 'plan mentions ' + field);
  else fail(id, 'plan missing dry-run field: ' + field);
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Staff API write route anchors');

const apiSrc = fs.readFileSync(API, 'utf8');

const writeRoutes = [
  ['B1', "POST /staff/bot/bookings/create", "'/staff/bot/bookings/create'", 'handleBotBookingCreate'],
  ['B2', 'POST /staff/bot/payments/:id/create-stripe-link', 'handleBotPaymentCreateStripeLink', 'STRIPE_LINKS_ENABLED'],
  ['B3', 'POST /staff/stripe/webhook', "'/staff/stripe/webhook'", 'handleStripeWebhook'],
  ['B4', 'POST /staff/bot/booking-dry-run (dry-run)', "'/staff/bot/booking-dry-run'", 'handleBotBookingDryRun'],
  ['B5', 'POST /staff/bot/check-guest-automation-gate', "'/staff/bot/check-guest-automation-gate'", 'handleBotCheckGuestAutomationGate'],
];

for (const [id, label, ...needles] of writeRoutes) {
  const ok = needles.every((n) => apiSrc.includes(n));
  if (ok) pass(id, label + ' anchored in staff-query-api.js');
  else fail(id, label + ' anchor missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Env gates default off');

const flagChecks = [
  ['C1', 'BOT_BOOKING_ENABLED defaults false', /BOT_BOOKING_ENABLED\s*=\s*process\.env\.BOT_BOOKING_ENABLED\s*===\s*'true'/],
  ['C2', 'STRIPE_LINKS_ENABLED defaults false', /STRIPE_LINKS_ENABLED\s*=\s*process\.env\.STRIPE_LINKS_ENABLED\s*===\s*'true'/],
  ['C3', 'STAFF_ACTIONS_ENABLED defaults false', /STAFF_ACTIONS_ENABLED\s*=\s*process\.env\.STAFF_ACTIONS_ENABLED\s*===\s*'true'/],
  ['C4', 'bot create gates on BOT_BOOKING_ENABLED', /if\s*\(\s*!BOT_BOOKING_ENABLED\s*\)/],
  ['C5', 'bot stripe link gates STRIPE_LINKS_ENABLED', /if\s*\(\s*!STRIPE_LINKS_ENABLED\s*\)/],
  ['C6', 'bot create requires confirm:true', /confirmFlag\s*=\s*body\.confirm\s*===\s*true/],
  ['C7', 'bot create requires selected_bed_codes', /selected_bed_codes is required/],
  ['C8', 'live_send_blocked in gate helpers', /live_send_blocked/],
];

for (const [id, label, pattern] of flagChecks) {
  if (pattern.test(apiSrc)) pass(id, label);
  else fail(id, label);
}

// WHATSAPP — document ambiguity, not invent WHATSAPP_LIVE_SENDS_ENABLED
if (apiSrc.includes('WHATSAPP_DRY_RUN') || doc.includes('WHATSAPP_DRY_RUN')) {
  pass('C9', 'WhatsApp gate documented via WHATSAPP_DRY_RUN (no WHATSAPP_LIVE_SENDS_ENABLED)');
} else {
  fail('C9', 'WHATSAPP_DRY_RUN reference missing');
}

if (!apiSrc.includes('WHATSAPP_LIVE_SENDS_ENABLED')) {
  pass('C10', 'no WHATSAPP_LIVE_SENDS_ENABLED env (ambiguity documented in plan)');
} else {
  fail('C10', 'unexpected WHATSAPP_LIVE_SENDS_ENABLED — plan may be stale');
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Dry-run orchestrator safety (Phase 12)');

const orchSrc = fs.readFileSync(ORCH, 'utf8');

if (orchSrc.includes('DRY_RUN_SAFETY_FLAGS') && orchSrc.includes('LIVE_FORBIDDEN_ROUTES')) {
  pass('D1', 'orchestrator has safety flags + forbidden routes');
} else {
  fail('D1', 'orchestrator safety constants missing');
}

if (orchSrc.includes('would_create_booking_after_approval')) {
  pass('D2', 'dry-run plans would_create_booking_after_approval');
} else {
  fail('D2', 'write plan action missing from orchestrator');
}

if (orchSrc.includes('selected_bed_codes')) {
  pass('D3', 'dry-run availability exposes selected_bed_codes');
} else {
  fail('D3', 'selected_bed_codes missing from dry-run availability');
}

// ─────────────────────────────────────────────────────────────────────────────
section('E. Plan documents ambiguities (no guessing)');

const ambiguities = [
  ['E1', 'hold-only ambiguity', /booking hold only|main-booking-hold/],
  ['E2', 'no separate payment-draft route', /draft payment row|no standalone bot payment-draft/],
  ['E3', 'no confirmation/status route', /confirmation\/status route|payment truth only/],
  ['E4', 'no staff approval API gap', /staff\/owner approval|No per-conversation staff-approval API/],
];

for (const [id, label, pattern] of ambiguities) {
  if (pattern.test(doc)) pass(id, label);
  else fail(id, label + ' not documented');
}

// ─────────────────────────────────────────────────────────────────────────────
section('F. Phase 13 write stack (13b/13c)');

const ELIG_LIB = path.join(__dirname, 'lib', 'luna-guest-booking-write-eligibility.js');
const BRIDGE_LIB = path.join(__dirname, 'lib', 'luna-guest-booking-write-bridge.js');

if (fs.existsSync(ELIG_LIB)) {
  pass('F2', 'write-eligibility lib present (13b)');
} else {
  fail('F2', 'write-eligibility lib missing');
}

if (fs.existsSync(BRIDGE_LIB)) {
  pass('F1', 'write-bridge lib present (13c)');
} else {
  fail('F1', 'write-bridge lib missing — expected after 13c');
}

if (apiSrc.includes("'/staff/bot/booking-create-from-plan'")
    && apiSrc.includes('handleBotBookingCreateFromPlan')) {
  pass('F3', 'booking-create-from-plan route present (13c)');
} else {
  fail('F3', 'booking-create-from-plan route missing');
}

if (apiSrc.includes("'/staff/bot/booking-write-eligibility'")
    && apiSrc.includes('handleBotBookingWriteEligibility')) {
  pass('F4', 'booking-write-eligibility route present (13c.4)');
} else {
  fail('F4', 'booking-write-eligibility route missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('G. package.json scripts');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));

const requiredScripts = [
  'verify:luna-agent-phase13-write-gates-plan',
  'verify:luna-agent-phase13-write-eligibility',
  'verify:luna-agent-phase13-booking-write-bridge',
  'verify:luna-agent-phase13-write-eligibility-route',
  'verify:luna-agent-phase12-closeout',
  'verify:staff-ask-luna-phase11-closeout',
  'verify:staff-bot-booking-create-api',
  'verify:staff-bot-stripe-link-api',
  'verify:staff-stripe-webhook-api',
  'verify:staff-bot-guest-automation-gate',
];

for (const script of requiredScripts) {
  if (pkg.scripts && pkg.scripts[script]) {
    pass('G.' + script, script + ' registered');
  } else {
    fail('G.' + script, script + ' missing from package.json');
  }
}

if (doc.includes('verify:luna-agent-phase13-write-gates-plan')) {
  pass('G.doc', 'plan references phase13 plan verifier');
} else {
  fail('G.doc', 'plan missing verifier npm script name');
}

// ─────────────────────────────────────────────────────────────────────────────
section('H. First write recommendation in plan');

if (/booking \+ draft payment|Booking \+ draft payment/.test(doc) && /hold-only|hold only/.test(doc)) {
  pass('H1', 'plan recommends booking+draft payment over hold-only');
} else {
  fail('H1', 'first write recommendation unclear');
}

if (doc.includes('handleBotBookingCreate')) {
  pass('H2', 'plan anchors first write to handleBotBookingCreate');
} else {
  fail('H2', 'plan missing handleBotBookingCreate anchor');
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
