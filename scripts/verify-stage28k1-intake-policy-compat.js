/**
 * Stage 28k.1 — Booking intake policy compatibility verifier.
 *
 * Usage:
 *   npm run verify:stage28k1-intake-policy-compat
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });
const { withPgClient } = require('./lib/pg-connect');

const ROOT = path.join(__dirname, '..');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28k1-intake-policy-compat';
const FIXTURE_FILE = path.join(__dirname, 'fixtures', 'luna-guest-flow-batch.json');
const BATCH_RUNNER = path.join(__dirname, 'run-luna-guest-flow-batch.js');

const PACKAGE_RE = /\b(?:Malibu|Uluwatu|Waimea)\b/i;
const INTERNAL_RE = /\b(?:dry run|quote_status|automation gate|hold writer|staging)\b/i;

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

const policy = require('./lib/luna-booking-intake-policy');
const { runLunaGuestMessageRouterDryRun } = require('./lib/luna-guest-message-router');
const { parseGuestNameAnswer } = require('./lib/luna-guest-message-intake');

console.log('\nverify-stage28k1-intake-policy-compat.js  (Stage 28k.1)\n');

section('A. Contact / profile name handling');

check('A1', policy.hasCollectedGuestName(
  { guest_name: 'Marco' },
  'Marco',
), 'collected guest_name counts as present');

check('A2', policy.hasCollectedGuestName(
  {},
  'Marco',
), 'channel contact_name satisfies name without explicit guest_name');

const withContact = runLunaGuestMessageRouterDryRun({
  message_text: 'July 10 to July 17',
  guest_context: {
    contact_name: 'Marco',
    extracted_fields: {
      guest_count: 2,
      package_interest: 'malibu',
    },
  },
}, { reference_date: '2026-06-08' });
check('A3', withContact.booking_intake_ready === true,
  'contact_name + dates completes intake without asking name');
check('A4', !/grab your name|your name/i.test(withContact.proposed_luna_reply || ''),
  'contact_name skips name question on dates turn');

const completeReq = runLunaGuestMessageRouterDryRun({
  message_text: 'Malibu July 10 to July 17 for 1',
  guest_context: { contact_name: 'Marco' },
}, { reference_date: '2026-06-08' });
check('A5', completeReq.booking_intake_ready === true,
  'direct complete booking with contact_name is not blocked');
check('A6', completeReq.extracted_fields.guest_count === 1,
  'complete request stores guest_count with contact_name');

const noReask = runLunaGuestMessageRouterDryRun({
  message_text: 'July 10 to July 17',
  guest_context: {
    contact_name: 'Marco',
    extracted_fields: { guest_name: 'Marco', guest_count: 2, package_interest: 'malibu' },
  },
}, { reference_date: '2026-06-08' });
check('A7', !/grab your name|your name/i.test(noReask.proposed_luna_reply || ''),
  'no re-ask of name when guest_name already exists');

section('B. Complete request without contact name');

const oneShot = runLunaGuestMessageRouterDryRun({
  message_text: '2 people Malibu package July 10 to July 17',
}, { reference_date: '2026-06-08' });
check('B1', oneShot.booking_intake_ready === true,
  'one-shot package booking proceeds without name before quote');
check('B2', oneShot.extracted_fields.guest_count === 2,
  'one-shot stores guest_count without prior name');

section('C. Addon decline must not overwrite guest name');

check('C1', parseGuestNameAnswer('no add nothing') == null,
  '"no add nothing" is not parsed as a guest name');

section('D. Policy ordering preserved');

const preQuote = policy.determineRequiredBookingFields(
  { extracted_fields: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1 } },
  { quote: { quote_status: 'not_ready' } },
);
check('D1', !preQuote.includes('payment_choice'), 'deposit/full not required before quote');
check('D2', !preQuote.includes('guest_name'), 'name not required before quote');

const postQuote = policy.buildBookingIntakePolicySnapshot(
  {
    extracted_fields: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1, guest_name: 'Ty' },
    package_night_rule: 'short_stay_accommodation',
  },
  { quote: { quote_status: 'ready', short_stay_addons_pending: true } },
);
check('D3', postQuote.add_ons_status === 'pending', 'add-ons still asked after quote');

const shortStayReq = policy.determineRequiredBookingFields(
  {
    extracted_fields: {
      check_in: '2026-07-01',
      check_out: '2026-07-05',
      guest_count: 1,
      package_interest: 'accommodation_only',
    },
    package_night_rule: 'short_stay_accommodation',
  },
  { quote: { quote_status: 'not_ready' } },
);
check('D4', !shortStayReq.includes('stay_type'), 'short-stay stays accommodation-only');

section('E. Fixture harness seeds contact_name');

const fixtureData = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
check('E1', fixtureData.fixture_sets['booking-core'].default_contact_name === 'Marco',
  'booking-core fixture set seeds default_contact_name');

const batchSrc = fs.readFileSync(BATCH_RUNNER, 'utf8');
check('E2', batchSrc.includes('default_contact_name') && batchSrc.includes('applyChannelContactName'),
  'flow batch harness applies seeded contact_name');

section('F. Safety — no production/n8n/live Stripe/confirmation');

const orchSrc = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js'), 'utf8');
const executeSrc = fs.readFileSync(path.join(__dirname, 'lib', 'open-demo-whatsapp-inbound-execute.js'), 'utf8');
check('F1', !executeSrc.includes('runGuestConfirmation'), 'no confirmation send path touched');
check('F2', !orchSrc.includes('calls_n8n: true'), 'no n8n activation');

(async () => {
  const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');

  let ctx = { contact_name: 'Marco' };
  const turns = ['Hi, we are 2 people interested in the Malibu package', 'July 10 to July 17'];
  let last;
  for (const message_text of turns) {
    last = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      message_text,
      guest_phone: '+34600998001',
      guest_context: ctx,
      reference_date: '2026-06-08',
    }, { reference_date: '2026-06-08', pg }));
    ctx = {
      contact_name: 'Marco',
      message_lane: last.result.message_lane,
      extracted_fields: last.result.extracted_fields,
      package_night_rule: last.result.package_night_rule,
      result: last.result,
      quote: last.quote,
      availability: last.availability,
      payment_choice: last.payment_choice,
    };
  }

  check('G1', last.result.extracted_fields.guest_count === 2,
    'booking-core style flow with seeded contact_name keeps guest_count');
  check('G2', last.result.booking_intake_ready === true,
    'booking-core style flow reaches intake ready with contact_name');
  check('G3', !INTERNAL_RE.test(last.proposed_luna_reply || ''), 'no internal/dev language in reply');

  section('H. package.json');
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check('H1', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT} registered`);

  section('Summary');
  console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
