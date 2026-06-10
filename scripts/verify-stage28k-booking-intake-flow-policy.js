/**
 * Stage 28k — Booking intake flow policy verifier.
 *
 * Usage:
 *   npm run verify:stage28k-booking-intake-flow-policy
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });
const { withPgClient } = require('./lib/pg-connect');

const ROOT = path.join(__dirname, '..');
const POLICY = path.join(__dirname, 'lib', 'luna-booking-intake-policy.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28k-booking-intake-flow-policy';

const PACKAGE_RE = /\b(?:Malibu|Uluwatu|Waimea)\b/i;
const INTERNAL_RE = /\b(?:dry run|quote_status|automation gate|hold writer|staging)\b/i;

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

const policy = require('./lib/luna-booking-intake-policy');

console.log('\nverify-stage28k-booking-intake-flow-policy.js  (Stage 28k)\n');

for (const f of [POLICY, COMPOSER, ROUTER, ORCH, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('0', `${path.basename(f)} syntax error`);
  }
}

section('A. Policy module exports');

check('A1', typeof policy.determineNextBookingQuestion === 'function', 'determineNextBookingQuestion');
check('A2', typeof policy.inferRoomPreferenceNeed === 'function', 'inferRoomPreferenceNeed');
check('A3', typeof policy.determineRequiredBookingFields === 'function', 'determineRequiredBookingFields');
check('A4', typeof policy.normalizeOutOfOrderBookingInfo === 'function', 'normalizeOutOfOrderBookingInfo');
check('A5', typeof policy.buildBookingIntakePolicySnapshot === 'function', 'buildBookingIntakePolicySnapshot');

section('B. Intake order + out-of-order');

check('B1', policy.determineNextBookingQuestion(
  { extracted_fields: { check_in: '2026-07-01', check_out: '2026-07-05' } },
  {},
).field === 'guest_name', 'dates before name when WhatsApp name missing');

const ooo = policy.normalizeOutOfOrderBookingInfo(
  "Hi, I'm Marco, July 10-17, 2 people, Malibu, we land in Santander at 3pm",
  { extracted_fields: {} },
  { reference_date: '2026-06-10' },
);
check('B2', ooo.extracted_fields_patch.guest_name === 'Marco', 'name out of order stored');
check('B3', ooo.extracted_fields_patch.check_in === '2026-07-10'
  && ooo.extracted_fields_patch.check_out === '2026-07-17', 'dates out of order stored');
check('B4', ooo.extracted_fields_patch.guest_count === 2, '"2 people" out of order');
check('B5', ooo.extracted_fields_patch.package_interest === 'malibu', 'package out of order');
check('B6', ooo.transfer_info && ooo.transfer_info.airport_code === 'SDR', 'transfer out of order');

check('B7', policy.extractGuestCountFromText('just me') === 1, '"just me" = 1');
check('B8', policy.extractGuestCountFromText('me and my friend') === 2, '"me and my friend" = 2');
check('B9', policy.isGenericWhatsAppName('Guest') && !policy.isGenericWhatsAppName('Ty'),
  'generic WhatsApp names filtered');

section('C. Room preference rules');

const soloMale = policy.inferRoomPreferenceNeed(
  { extracted_fields: { guest_count: 1, guest_name: 'Marco' } },
  {},
);
check('C1', soloMale.needed === false && soloMale.rule_applied === 'solo_male_default_mixed',
  'solo likely male: no room preference question');

const soloFemale = policy.inferRoomPreferenceNeed(
  { extracted_fields: { guest_count: 1, guest_name: 'Sarah' } },
  { availability: { girls_room_available: true } },
);
check('C2', soloFemale.needed === true && soloFemale.question_type === 'girls_or_mixed',
  'solo likely female: girls/mixed question');

const couplePrivate = policy.inferRoomPreferenceNeed(
  { extracted_fields: { guest_count: 2, guest_name: 'Marco' } },
  { availability: { private_room_available: true } },
);
check('C3', couplePrivate.needed === true
  && couplePrivate.question_type === 'private_or_shared'
  && couplePrivate.private_extra_eur_per_night === 10,
  'two guests + private available: €10/night option');

const coupleNoPrivate = policy.inferRoomPreferenceNeed(
  { extracted_fields: { guest_count: 2, guest_name: 'Marco' } },
  { availability: { private_room_available: false } },
);
check('C4', coupleNoPrivate.needed === false,
  'two male guests: no private tease when unavailable');

section('D. Transfer + add-ons + payment ordering');

const pkgTransfer = policy.resolveTransferInfoStatus(
  { extracted_fields: { package_interest: 'malibu', transfer_info: { airport_code: 'SDR', deferred: true } } },
  {},
);
check('D1', pkgTransfer === 'deferred', 'package transfer can be deferred without blocking');

const accTransfer = policy.resolveTransferInfoStatus(
  { extracted_fields: { package_interest: 'accommodation_only' } },
  {},
);
check('D2', accTransfer === 'not_applicable', 'accommodation-only: transfer not required');

check('D3', policy.guestDeclinedAddons('I have my own stuff') === true,
  '"I have my own stuff" = no add-ons');

const preQuote = policy.determineRequiredBookingFields(
  { extracted_fields: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1, guest_name: 'Ty' } },
  { quote: { quote_status: 'not_ready' } },
);
check('D4', !preQuote.includes('payment_choice'), 'deposit/full not required before quote');

const postQuoteAddons = policy.buildBookingIntakePolicySnapshot(
  {
    extracted_fields: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1, guest_name: 'Ty' },
    package_night_rule: 'short_stay_accommodation',
  },
  { quote: { quote_status: 'ready', short_stay_addons_pending: true } },
);
check('D5', postQuoteAddons.add_ons_status === 'pending', 'add-ons pending after quote');

section('E. Wiring + integration smoke');

const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const orchSrc = fs.readFileSync(ORCH, 'utf8');
const executeSrc = fs.readFileSync(path.join(__dirname, 'lib', 'open-demo-whatsapp-inbound-execute.js'), 'utf8');

check('E1', routerSrc.includes('luna-booking-intake-policy'), 'router wires policy');
check('E2', orchSrc.includes('buildBookingIntakePolicySnapshot'), 'orchestrator attaches policy observability');
check('E3', composerSrc.includes('luna-booking-intake-policy'), 'composer uses policy');
check('E4', !executeSrc.includes('runGuestConfirmation'), 'no confirmation send path touched');
check('E5', !orchSrc.includes('calls_n8n: true'), 'no n8n activation');

(async () => {
  const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');

  let ctx = {};
  const turns = ['hi', 'book a stay', 'July 1-5', 'Ty', 'just me'];
  let last;
  for (const message_text of turns) {
    last = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      message_text,
      guest_phone: '+491726422307',
      guest_context: ctx,
      reference_date: '2026-06-10',
    }, { reference_date: '2026-06-10', pg }));
    ctx = {
      message_lane: last.result.message_lane,
      extracted_fields: last.result.extracted_fields,
      package_night_rule: last.result.package_night_rule,
      result: last.result,
      quote: last.quote,
      availability: last.availability,
      payment_choice: last.payment_choice,
    };
  }

  check('E6', last.result.booking_intake_policy
    && last.result.booking_intake_policy.booking_flow_stage,
    'orchestrator exposes booking_flow_stage');
  check('E7', !PACKAGE_RE.test(last.proposed_luna_reply || ''),
    'under-7 quote does not mention package names');
  check('E8', last.result.conversation_brain.final_reply_source === 'luna_reply_composer',
    'composer owns final copy');
  check('E9', !INTERNAL_RE.test(last.proposed_luna_reply || ''), 'no internal terms in reply');

  const side = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo',
    message_text: 'what are the packages?',
    guest_context: ctx,
    reference_date: '2026-06-10',
  }, { reference_date: '2026-06-10', pg }));
  check('E10', side.result.extracted_fields.check_in === '2026-07-01',
    'side question preserves dates');

  section('F. package.json');
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check('F1', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT} registered`);

  section('Summary');
  console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
