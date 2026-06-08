/**
 * Stage 27l — Static verifier for hold + payment draft design lock doc.
 *
 * Docs-only checks — no runtime, no DB, no API calls.
 *
 * Usage:
 *   npm run verify:stage27l-hold-payment-draft-design
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'STAGE-27L-HOLD-PAYMENT-DRAFT-DESIGN.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27l-hold-payment-draft-design';
const REL = 'scripts/verify-stage27l-hold-payment-draft-design.js';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function docIncludes(text, needle, id, label) {
  if (text.includes(needle)) pass(id, label);
  else fail(id, `${label} — missing: ${String(needle).slice(0, 72)}`);
}

function docMatches(text, pattern, id, label) {
  if (pattern.test(text)) pass(id, label);
  else fail(id, `${label} — pattern not found`);
}

console.log('\nverify-stage27l-hold-payment-draft-design.js  (Stage 27l design lock)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'design verifier passes node --check');
} catch {
  fail('0', 'design verifier syntax error');
}

section('A. Doc exists');

if (fs.existsSync(DOC)) pass('A1', 'STAGE-27L-HOLD-PAYMENT-DRAFT-DESIGN.md exists');
else fail('A1', 'design doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

section('B. Doc title and status');

docMatches(doc, /Stage 27l.*Hold.*Payment Draft|Hold \+ Payment Draft Design Lock/i, 'B1', 'Stage 27l hold/payment draft title');
docMatches(doc, /DESIGN LOCK|docs only/i, 'B2', 'design lock / docs-only status');
docMatches(doc, /No runtime code/i, 'B3', 'no runtime code stated');

section('C. Entry gate');

docIncludes(doc, 'payment_choice_ready', 'C1', 'gate: payment_choice_ready');
docIncludes(doc, 'ready_for_hold_payment_draft', 'C2', 'gate: ready_for_hold_payment_draft');
docIncludes(doc, 'quote_status', 'C3', 'gate: quote_status');
docIncludes(doc, 'availability_status', 'C4', 'gate: availability_status');
docIncludes(doc, 'available', 'C5', 'gate: availability available');
docMatches(doc, /intake.*booking fields still valid|Intake \/ booking fields still valid/i, 'C6', 'gate: intake fields still valid');

section('D. State-changing objects');

docMatches(doc, /State-changing objects|booking\/hold record/i, 'D1', 'state-changing objects section');
docIncludes(doc, 'quote/invoice snapshot', 'D2', 'object: quote/invoice snapshot');
docIncludes(doc, 'draft payment record', 'D3', 'object: draft payment record');
docMatches(doc, /service.*transfer line items|structured extracted fields/i, 'D4', 'optional service/transfer line items from structured fields');

section('E. Hold rules');

docMatches(doc, /Hold rules|§4/i, 'E1', 'hold rules section');
docMatches(doc, /6 hours|6 hour/i, 'E2', 'hold expiry 6 hours');
docMatches(doc, /not proactively mention.*hold expiry|must \*\*not proactively mention\*\* hold expiry/i, 'E3', 'Luna must not proactively mention hold expiry');
docMatches(doc, /re-check availability|re-check availability before/i, 'E4', 're-check availability after expiry');
docMatches(doc, /no booking confirmation|No booking confirmation|not confirmation/i, 'E5', 'no confirmation until payment truth');

section('F. Payment draft rules');

docMatches(doc, /Payment draft rules|§5/i, 'F1', 'payment draft rules section');
docMatches(doc, /deposit or full|deposit.*full_payment/i, 'F2', 'deposit or full based on payment_choice');
docMatches(doc, /€200|20000/, 'F3', 'weekly package deposit €200');
docMatches(doc, /€100|10000/, 'F4', 'custom/shorter stay deposit €100');
docMatches(doc, /quote total|quote_total_cents/i, 'F5', 'full payment uses quote total');
docMatches(doc, /cash.*bank transfer|bank transfer.*cash|Stripe on arrival/i, 'F6', 'remaining balance cash/bank/Stripe on arrival');
docMatches(doc, /not payment truth|is \*\*not payment truth\*\*/i, 'F7', 'payment draft is not payment truth');

section('G. Stripe link rules');

docMatches(doc, /Stripe link rules|§6/i, 'G1', 'Stripe link rules section');
docMatches(doc, /later slice|Stage \*\*27o\*\*/i, 'G2', 'link creation is later slice');
docMatches(doc, /explicit go\/no-go|explicit GO/i, 'G3', 'link send requires explicit go/no-go');
docMatches(doc, /No live guest WhatsApp|no live guest WhatsApp/i, 'G4', 'no live guest WhatsApp send by default');
docMatches(doc, /not claim payment is received|webhook.*payment truth|payment truth/i, 'G5', 'no payment received claim until webhook truth');

section('H. Safety / handoff cases');

docMatches(doc, /Safety.*handoff|handoff cases/i, 'H1', 'safety/handoff section');
const HANDOFFS = [
  ['availability_changed_before_hold', 'availability changed before hold'],
  ['quote_changed_before_draft', 'quote changed before draft'],
  ['payment_state_mismatch', 'payment state mismatch'],
  ['paid_cancellation_or_reschedule', 'paid cancellation/reschedule'],
  ['guest_refund_request', 'guest refund request'],
  ['transfer_exception', 'transfer exception'],
  ['unclear_service_line_items', 'unclear service line items'],
  ['write_failure', 'write failure'],
];
for (let i = 0; i < HANDOFFS.length; i++) {
  docIncludes(doc, HANDOFFS[i][0], `H${i + 2}`, `handoff: ${HANDOFFS[i][1]}`);
}

section('I. Idempotency');

docMatches(doc, /Idempotency|§8/i, 'I1', 'idempotency section');
docMatches(doc, /duplicate holds|not.*create duplicate/i, 'I2', 'no duplicate holds/drafts');
docMatches(doc, /idempotency key|Idempotency key/i, 'I3', 'idempotency key');
docMatches(doc, /reuse.*active|active non-expired hold/i, 'I4', 'reuse existing active draft/hold');
docMatches(doc, /audit.*log|Audit.*log events/i, 'I5', 'audit/log events required');

section('J. Staff Portal visibility');

docMatches(doc, /Staff Portal visibility|§9/i, 'J1', 'Staff Portal visibility section');
docMatches(doc, /Payments tab|payments tab/i, 'J2', 'booking drawer Payments tab');
docMatches(doc, /visible to staff|staff-only/i, 'J3', 'hold/payment draft visible to staff');
docMatches(doc, /review before.*live send|Staff can review/i, 'J4', 'staff review before live send');

section('K. Future implementation plan');

docIncludes(doc, '27m', 'K1', 'future stage 27m');
docIncludes(doc, '27n', 'K2', 'future stage 27n');
docIncludes(doc, '27o', 'K3', 'future stage 27o');
docIncludes(doc, '27p', 'K4', 'future stage 27p');
docMatches(doc, /27m.*dry-run|dry-run hold.*payment-draft planner/i, 'K5', '27m dry-run planner no writes');
docMatches(doc, /27n.*staging write|gated.*staging write/i, 'K6', '27n gated staging write');
docMatches(doc, /27o.*Stripe|Stripe.*test/i, 'K7', '27o Stripe test link');
docMatches(doc, /27p.*webhook|payment truth confirmation/i, 'K8', '27p webhook payment truth');

section('L. Safety phrases / non-negotiables');

docMatches(doc, /No booking writes|no booking writes/i, 'L1', 'no booking writes');
docMatches(doc, /No holds|no holds/i, 'L2', 'no holds');
docMatches(doc, /No payment drafts|no payment drafts/i, 'L3', 'no payment drafts');
docMatches(doc, /No Stripe|no Stripe/i, 'L4', 'no Stripe');
docMatches(doc, /No payment links|no payment links/i, 'L5', 'no payment links');
docMatches(doc, /No WhatsApp|no WhatsApp/i, 'L6', 'no WhatsApp');
docMatches(doc, /No Meta|no Meta/i, 'L7', 'no Meta/n8n');
docMatches(doc, /live_send_blocked|sends_whatsapp: false/i, 'L8', 'dry-run safety flags referenced');
docMatches(doc, /shared engine|Shared engine/i, 'L9', 'shared engine rule');
docMatches(doc, /calculateWolfhouseQuote|runBookingPreviewDryRun/i, 'L10', 'pricing engine reference');

section('M. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${REL}`) {
  pass('M1', `${SCRIPT} registered`);
} else {
  fail('M1', `${SCRIPT} missing or wrong path`);
}

if (fs.existsSync(path.join(ROOT, REL))) pass('M2', 'design verifier file exists');
else fail('M2', 'design verifier file missing');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
