/**
 * Stage 27a — Static verifier for guest intake design lock doc.
 *
 * Docs-only checks — no runtime, no DB, no API calls.
 *
 * Usage:
 *   npm run verify:stage27a-guest-intake-design
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'STAGE-27A-GUEST-INTAKE-DESIGN.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27a-guest-intake-design';
const REL = 'scripts/verify-stage27a-guest-intake-design.js';

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

console.log('\nverify-stage27a-guest-intake-design.js  (Stage 27a design lock)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'design verifier passes node --check');
} catch {
  fail('0', 'design verifier syntax error');
}

section('A. Doc exists');

if (fs.existsSync(DOC)) pass('A1', 'STAGE-27A-GUEST-INTAKE-DESIGN.md exists');
else fail('A1', 'design doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

section('B. Doc title and status');

docMatches(doc, /Stage 27a.*Guest Intake|Guest Intake Design Lock/i, 'B1', 'Stage 27a guest intake title');
docMatches(doc, /DESIGN LOCK|docs only/i, 'B2', 'design lock / docs-only status');

section('C. Guest intake states');

const STATES = [
  'inquiry_received',
  'collecting_required_details',
  'ready_for_availability_check',
  'availability_checked',
  'quote_ready',
  'payment_choice_needed',
  'hold_payment_draft_ready',
  'payment_pending',
  'confirmed_after_payment_truth',
  'staff_handoff_required',
];
for (let i = 0; i < STATES.length; i++) {
  docIncludes(doc, STATES[i], `C${i + 1}`, `intake state: ${STATES[i]}`);
}

section('D. Required fields before gates');

docMatches(doc, /Before quote|before quote|§3\.1/i, 'D1', 'required fields before quote section');
docMatches(doc, /Before hold|before hold|§3\.2/i, 'D2', 'required fields before hold section');
docMatches(doc, /payment draft|payment draft\/link|Before payment draft|§3\.3/i, 'D3', 'required fields before payment draft/link');
docMatches(doc, /Before confirmation|before confirmation|§3\.4/i, 'D4', 'required fields before confirmation');

section('E. Safe handoff cases');

const HANDOFFS = [
  ['paid_cancellation_or_reschedule', 'paid cancellation/reschedule'],
  ['date_change_different_nights', 'date change different nights'],
  ['unclear_availability', 'unclear availability'],
  ['uncertain_package_or_pricing', 'uncertain package/pricing'],
  ['transfer_exception', 'transfer exception'],
  ['bilbao_no_package_request', 'Bilbao no-package request'],
  ['bad_weather_lesson_refund', 'bad weather/no-waves lesson refund'],
  ['low_confidence_language_or_intent', 'low-confidence language/intent'],
  ['outside_policy_question', 'outside policy question'],
  ['payment_state_mismatch', 'payment state mismatch'],
];
for (let i = 0; i < HANDOFFS.length; i++) {
  docIncludes(doc, HANDOFFS[i][0], `E${i + 1}`, `handoff case: ${HANDOFFS[i][1]}`);
}

section('F. Dry-run guest reply path');

docMatches(doc, /Dry-run guest reply|dry-run guest reply/i, 'F1', 'dry-run guest reply path section');
docMatches(doc, /structured interpretation|structured state/i, 'F2', 'structured interpretation');
docMatches(doc, /proposed Luna reply|reply_draft/i, 'F3', 'proposed Luna reply');
docMatches(doc, /no live send|No live send/i, 'F4', 'no live send');
docMatches(doc, /no WhatsApp outbound|No WhatsApp outbound/i, 'F5', 'no WhatsApp outbound');
docMatches(doc, /no Meta|No Meta|n8n activation/i, 'F6', 'no Meta/n8n activation');
docMatches(doc, /no payment link sent|payment link sent to guest|payment_link_sent: false/i, 'F7', 'no payment link sent to guest');

section('G. Shared engine rule');

docMatches(doc, /Shared engine|shared engine rule/i, 'G1', 'shared engine rule section');
docMatches(doc, /Staff API booking.*pricing.*payment|booking \/ pricing \/ payment engine/i, 'G2', 'Staff API booking/pricing/payment engine');
docMatches(doc, /no duplicated|must NOT duplicate|does not own business truth/i, 'G3', 'no duplicated prices in guest AI prompt');

section('H. Language and tone');

docMatches(doc, /English baseline|baseline.*English/i, 'H1', 'English baseline');
docMatches(doc, /Italian|Spanish|German|French/i, 'H2', 'IT/ES/DE/FR supported');
docMatches(doc, /guest language when confident|Match guest language/i, 'H3', 'reply in guest language when confident');
docMatches(doc, /Cami|Wolfhouse tone|warm/i, 'H4', 'warm Cami/Wolfhouse tone');
docMatches(doc, /Luna from Wolfhouse/i, 'H5', 'identity Luna from Wolfhouse');

section('I. Transfer and service capture');

docMatches(doc, /Transfer.*service capture|transfer interest/i, 'I1', 'transfer/service capture section');
docMatches(doc, /airport|flight number|direction/i, 'I2', 'transfer airport/flight/direction capture');
docMatches(doc, /wetsuit|board|lesson|yoga/i, 'I3', 'service interest capture');
docMatches(doc, /do not become confirmed paid|not become confirmed paid|until proper quote/i, 'I4', 'services not confirmed paid until quote/payment flow');

section('J. Payment-link rules');

docMatches(doc, /deposit or full|deposit.*full amount/i, 'J1', 'ask deposit or full amount');
docMatches(doc, /€200|20000/, 'J2', 'weekly package deposit €200');
docMatches(doc, /€100|10000/, 'J3', 'custom/shorter stay deposit €100');
docMatches(doc, /cash.*bank transfer|bank transfer.*cash|Stripe on arrival/i, 'J4', 'remaining balance cash/bank/Stripe on arrival');
docMatches(doc, /confirmation only after payment truth|Only after.*payment truth/i, 'J5', 'confirmation only after payment truth');
docMatches(doc, /explicit go\/no-go|explicitly approved/i, 'J6', 'live link send requires explicit go/no-go');

section('K. No-live-send gates');

docMatches(doc, /No-live-send gates|no-live-send gates/i, 'K1', 'no-live-send gates section');
docMatches(doc, /Live WhatsApp sends.*Disabled|live WhatsApp.*disabled/i, 'K2', 'live WhatsApp sends disabled');
docMatches(doc, /Production Meta|production Meta/i, 'K3', 'production Meta disabled');
docMatches(doc, /guest automation.*Disabled|Guest automation.*disabled/i, 'K4', 'guest automation disabled');
docMatches(doc, /Payment link sending.*Disabled|payment link sending.*disabled/i, 'K5', 'payment link sending disabled unless approved');

section('L. Staging proof plan');

docMatches(doc, /Staging proof plan|staging proof plan/i, 'L1', 'staging proof plan section');
docMatches(doc, /docs-only proof|docs only proof/i, 'L2', 'docs-only proof now');
docMatches(doc, /dry-run fixture harness|fixture harness/i, 'L3', 'later dry-run fixture harness');
docMatches(doc, /inbound message.*structured state.*proposed reply|guest-intake-dry-run/i, 'L4', 'later endpoint inbound → state → reply');
docMatches(doc, /controlled booking.*quote.*payment draft|booking \/ quote \/ payment draft/i, 'L5', 'later controlled booking/quote/payment draft tests');

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
