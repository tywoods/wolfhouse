/**
 * Stage 27t — Static verifier for guest automation gate design lock doc.
 *
 * Docs-only checks — no runtime, no DB, no API calls.
 *
 * Usage:
 *   npm run verify:stage27t-guest-automation-gate-design
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'STAGE-27T-GUEST-AUTOMATION-GATE-DESIGN.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27t-guest-automation-gate-design';
const REL = 'scripts/verify-stage27t-guest-automation-gate-design.js';

/** 27t must not ship orchestrator runtime — 27u+ implements later */
const FORBIDDEN_27T_RUNTIME = [
  'scripts/lib/luna-guest-automation-orchestrator.js',
  'scripts/lib/luna-guest-automation-gate.js',
];

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

console.log('\nverify-stage27t-guest-automation-gate-design.js  (Stage 27t design lock)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'design verifier passes node --check');
} catch {
  fail('0', 'design verifier syntax error');
}

section('A. Doc exists');

if (fs.existsSync(DOC)) pass('A1', 'STAGE-27T-GUEST-AUTOMATION-GATE-DESIGN.md exists');
else fail('A1', 'design doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

section('B. Doc title and status');

docMatches(doc, /Stage 27t.*Guest Automation Gate|Guest Automation Gate Design Lock/i, 'B1', 'Stage 27t title');
docMatches(doc, /DESIGN LOCK|docs only/i, 'B2', 'design lock / docs-only status');
docMatches(doc, /No runtime code/i, 'B3', 'no runtime code stated');

section('C. Proven chain 27q / 27r / 27s / 27s.1');

docIncludes(doc, '27q', 'C1', 'mentions 27q');
docIncludes(doc, '27r', 'C2', 'mentions 27r');
docIncludes(doc, '27s', 'C3', 'mentions 27s');
docMatches(doc, /27s\.1|27s\.1/i, 'C4', 'mentions 27s.1');
docMatches(doc, /WHATSAPP_DRY_RUN.*restored|restored to `true`|dry-run restored/i, 'C5', 'WHATSAPP_DRY_RUN restored');
docMatches(doc, /no public guest automation|Not wired yet|not wired yet/i, 'C6', 'no public guest automation yet');

section('D. Entry gates');

docIncludes(doc, 'client_slug', 'D1', 'gate: client_slug');
docIncludes(doc, 'channel', 'D2', 'gate: channel');
docMatches(doc, /staff.*owner.*phone|guest vs staff/i, 'D3', 'gate: guest vs staff/owner phone routing');
docMatches(doc, /pause.*resume|bot_pause/i, 'D4', 'gate: pause/resume state');
docMatches(doc, /human takeover|needs_human|staff takeover/i, 'D5', 'gate: human takeover state');
docIncludes(doc, 'WHATSAPP_DRY_RUN', 'D6', 'gate: WHATSAPP_DRY_RUN');
docMatches(doc, /LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST|allowlisted live-send/i, 'D7', 'gate: allowlisted live-send rules');

section('E. Guest automation states');

const STATES = [
  ['intake_only', 'state: intake_only'],
  ['collect_required_details', 'state: collect_required_details'],
  ['ready_for_availability', 'state: ready_for_availability'],
  ['ready_for_quote', 'state: ready_for_quote'],
  ['ready_for_payment_choice', 'state: ready_for_payment_choice'],
  ['ready_for_hold_payment_draft', 'state: ready_for_hold_payment_draft'],
  ['ready_for_stripe_link_go_no_go', 'state: ready_for_stripe_link_go_no_go'],
  ['ready_for_confirmation_preview', 'state: ready_for_confirmation_preview'],
  ['ready_for_confirmation_send_go_no_go', 'state: ready_for_confirmation_send_go_no_go'],
  ['staff_handoff_required', 'state: staff_handoff_required'],
];
for (let i = 0; i < STATES.length; i++) {
  docIncludes(doc, STATES[i][0], `E${i + 1}`, STATES[i][1]);
}

section('F. Required fields');

docIncludes(doc, 'check_in', 'F1', 'field: check_in');
docIncludes(doc, 'check_out', 'F2', 'field: check_out');
docIncludes(doc, 'guest_count', 'F3', 'field: guest_count');
docMatches(doc, /package.*accommodation-only|no-package/i, 'F4', 'field: package or accommodation-only');
docMatches(doc, /guest_name|guest_email|guest_phone/i, 'F5', 'field: guest identity before payment');
docMatches(doc, /payment_choice|deposit.*full/i, 'F6', 'field: payment choice deposit or full');
docMatches(doc, /not invent|Never invent|must never invent/i, 'F7', 'transfer/service must not invent prices');
docMatches(doc, /checkout_created|waiting_payment|unpaid/i, 'F8', 'unpaid states blocked from confirmed preview');

section('G. Handoff cases');

const HANDOFFS = [
  ['ambiguous_dates_or_guests', 'ambiguous dates/guests'],
  ['unavailable_or_conflicting_beds', 'unavailable/conflicting beds'],
  ['paid_cancellation_or_reschedule', 'paid cancellation/reschedule'],
  ['refund_or_cash_refund_request', 'refund/cash refund'],
  ['angry_guest_or_escalation', 'angry guest'],
  ['staff_room_assignment_conflict', 'staff room assignment conflict'],
  ['bilbao_under_four_no_override', 'Bilbao under 4 without override'],
  ['unsupported_airport_or_flight_mismatch', 'unsupported airport/flight mismatch'],
  ['uncertain_package_or_pricing', 'uncertain package/pricing'],
  ['payment_claim_not_found', 'payment claim not found'],
  ['repeated_failed_clarification', 'repeated failed clarification'],
  ['low_language_confidence', 'low language confidence'],
];
for (let i = 0; i < HANDOFFS.length; i++) {
  docIncludes(doc, HANDOFFS[i][0], `G${i + 1}`, `handoff: ${HANDOFFS[i][1]}`);
}

section('H. Source-of-truth rules');

docMatches(doc, /Staff API.*brain|Staff API.*Brain/i, 'H1', 'Staff API is brain');
docMatches(doc, /n8n.*pipe|n8n.*Pipe/i, 'H2', 'n8n is pipe');
docMatches(doc, /Stripe webhook.*payment truth|payment truth/i, 'H3', 'Stripe webhook is payment truth');
docMatches(doc, /shared.*engine|shared booking/i, 'H4', 'shared booking/pricing/payment engine');
docMatches(doc, /must never invent|never invent/i, 'H5', 'Luna cannot invent availability/prices/state');

section('I. Send policy');

docMatches(doc, /no public live guest sends|Public live guest sends.*Not wired/i, 'I1', 'no public live guest sends yet');
docMatches(doc, /draft replies|Draft replies/i, 'I2', 'draft replies allowed');
docMatches(doc, /allowlisted proof|explicit allowlisted/i, 'I3', 'live sends only in allowlisted proof slices');
docMatches(doc, /27r.*27s|confirmation send.*27r|gated by \*\*27r\*\*/i, 'I4', 'confirmation send gated by 27r/27s');

section('J. Next stage sequence');

docIncludes(doc, '27u', 'J1', 'future stage 27u orchestrator dry-run');
docIncludes(doc, '27v', 'J2', 'future stage 27v Staff Portal review');
docIncludes(doc, '27w', 'J3', 'future stage 27w allowlisted guest live-send proof');
docIncludes(doc, '27x', 'J4', 'future stage 27x limited staging automation');
docMatches(doc, /production.*explicit go|Production.*explicit go/i, 'J5', 'production later with explicit go/no-go');

section('K. Safety phrases / non-negotiables');

docMatches(doc, /No deploy|no deploy/i, 'K1', 'no deploy');
docMatches(doc, /No DB writes|no DB writes/i, 'K2', 'no DB writes');
docMatches(doc, /No Stripe|no Stripe/i, 'K3', 'no Stripe');
docMatches(doc, /No WhatsApp|no WhatsApp/i, 'K4', 'no WhatsApp');
docMatches(doc, /No Meta|no Meta|no n8n/i, 'K5', 'no Meta/n8n');
docMatches(doc, /live_send_blocked|sends_whatsapp: false/i, 'K6', 'dry-run safety flags referenced');

section('L. No runtime files for 27t');

for (let i = 0; i < FORBIDDEN_27T_RUNTIME.length; i++) {
  const p = path.join(ROOT, FORBIDDEN_27T_RUNTIME[i]);
  if (!fs.existsSync(p)) pass(`L${i + 1}`, `27t runtime not present: ${FORBIDDEN_27T_RUNTIME[i]}`);
  else fail(`L${i + 1}`, `27t must not ship runtime yet: ${FORBIDDEN_27T_RUNTIME[i]}`);
}

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
