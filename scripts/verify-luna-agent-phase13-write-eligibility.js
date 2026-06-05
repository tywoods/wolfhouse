/**
 * Phase 13b — Verifier for Luna booking write eligibility evaluator.
 *
 * Usage:
 *   npm run verify:luna-agent-phase13-write-eligibility
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LIB  = path.join(__dirname, 'lib', 'luna-guest-booking-write-eligibility.js');
const PKG  = path.join(ROOT, 'package.json');

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

function readOrEmpty(filePath) {
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }
  catch { return ''; }
}

function makeEligiblePlan(overrides) {
  return Object.assign({
    dry_run:             true,
    preview_only:        true,
    no_write_performed:  true,
    creates_booking:     false,
    creates_payment:     false,
    creates_stripe_link: false,
    sends_whatsapp:      false,
    calls_n8n:           false,
    client_slug:         'wolfhouse-somo',
    phone:               '+34000000000',
    guest_phone:         '+34000000000',
    gate: {
      can_continue_guest_automation: true,
      bot_paused:                    false,
      live_send_blocked:             false,
    },
    booking_preview: {
      has_missing_fields: false,
      missing_fields:     [],
      quote: {
        success:                 true,
        total_cents:             100000,
        deposit_required_cents:  30000,
        payment_link_amount_cents: 30000,
      },
    },
    availability: {
      skipped:            false,
      has_enough_beds:    true,
      selected_bed_codes: ['BED-A1', 'BED-A2'],
      check_in:           '2026-09-01',
      check_out:          '2026-09-08',
      guest_count:        2,
    },
    planned_actions: ['show_quote', 'show_availability_options', 'would_create_booking_after_approval'],
    next_action:     'show_quote',
  }, overrides || {});
}

function makeEligibleInput(overrides) {
  return Object.assign({
    guest_name:       'Eligibility Guest',
    payment_choice:   'deposit',
    confirm:          true,
    idempotency_key:  'phase13b-test-key-001',
    package_code:     'malibu',
    check_in:         '2026-09-01',
    check_out:        '2026-09-08',
    guest_count:      2,
  }, overrides || {});
}

const enabledEnv = { BOT_BOOKING_ENABLED: 'true' };

console.log('\nverify-luna-agent-phase13-write-eligibility.js  (Phase 13b)\n');

// ─────────────────────────────────────────────────────────────────────────────
section('A. Module presence and syntax');

if (!fs.existsSync(LIB)) {
  fail('A1', 'luna-guest-booking-write-eligibility.js missing');
  process.exit(1);
}
pass('A1', 'eligibility module exists');

try {
  execSync(`node --check "${LIB}"`, { stdio: 'pipe' });
  pass('A2', 'eligibility module passes node --check');
} catch {
  fail('A2', 'eligibility module syntax error');
}

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('A3', 'verifier passes node --check');
} catch {
  fail('A3', 'verifier syntax error');
}

const libSrc = readOrEmpty(LIB);
let lib;
try {
  lib = require('./lib/luna-guest-booking-write-eligibility');
  pass('A4', 'eligibility module loads');
} catch (e) {
  fail('A4', 'module load failed: ' + e.message);
  process.exit(1);
}

if (typeof lib.evaluateLunaBookingWriteEligibility === 'function') {
  pass('A5', 'exports evaluateLunaBookingWriteEligibility');
} else {
  fail('A5', 'evaluateLunaBookingWriteEligibility not exported');
}

const pkg = JSON.parse(readOrEmpty(PKG) || '{}');
if (pkg.scripts && pkg.scripts['verify:luna-agent-phase13-write-eligibility']) {
  pass('A6', 'npm script verify:luna-agent-phase13-write-eligibility registered');
} else {
  fail('A6', 'npm script missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Static safety scan');

const stripped = libSrc
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

if (!/\bINSERT\s+INTO\b/i.test(stripped)) pass('B1', 'no INSERT SQL');
else fail('B1', 'INSERT SQL found');

if (!/\bUPDATE\s+\w/i.test(stripped)) pass('B2', 'no UPDATE SQL');
else fail('B2', 'UPDATE SQL found');

if (!/\bDELETE\s+FROM\b/i.test(stripped)) pass('B3', 'no DELETE SQL');
else fail('B3', 'DELETE SQL found');

const livePatterns = [
  ['B4', 'handleBotBookingCreate', 'booking create handler'],
  ['B5', 'create-stripe-link', 'Stripe link route'],
  ['B6', 'handleStripeWebhook', 'webhook handler'],
  ['B7', 'graph.facebook.com', 'WhatsApp Graph API'],
  ['B8', 'api.stripe.com', 'Stripe API'],
  ['B9', 'require(\'n8n', 'n8n require'],
  ['B10', 'generate-payment-link', 'payment-link route'],
];

for (const [id, needle, label] of livePatterns) {
  if (!libSrc.includes(needle)) pass(id, 'no ' + label);
  else fail(id, label + ' reference in evaluator');
}

if (!/require\s*\(\s*['"]\.\/staff-query-api['"]/.test(libSrc)) {
  pass('B11', 'does not import staff-query-api');
} else {
  fail('B11', 'imports staff-query-api');
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Runtime eligibility — write_ready true');

const eligible = lib.evaluateLunaBookingWriteEligibility(
  makeEligiblePlan(),
  makeEligibleInput(),
  enabledEnv
);

if (eligible.write_ready === true) pass('C1', 'eligible plan returns write_ready: true');
else fail('C1', 'write_ready not true: ' + JSON.stringify(eligible.blocked_reasons));

if (eligible.would_call.length === 1 && eligible.would_call[0] === 'POST /staff/bot/bookings/create') {
  pass('C2', 'would_call lists only POST /staff/bot/bookings/create');
} else {
  fail('C2', 'would_call wrong: ' + JSON.stringify(eligible.would_call));
}

if (eligible.safe_next_step === 'booking_create_gated') pass('C3', 'safe_next_step booking_create_gated');
else fail('C3', 'safe_next_step: ' + eligible.safe_next_step);

if (eligible.creates_booking === false && eligible.creates_payment === false
    && eligible.creates_stripe_link === false && eligible.sends_whatsapp === false
    && eligible.calls_n8n === false) {
  pass('C4', 'evaluator output safety flags remain false');
} else {
  fail('C4', 'evaluator falsely claims side effects');
}

if (eligible.blocked_reasons.length === 0 && eligible.required_approvals.length === 0) {
  pass('C5', 'no blocked_reasons or missing approvals when ready');
} else {
  fail('C5', 'unexpected blocks: ' + JSON.stringify(eligible));
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Runtime eligibility — blocked cases');

const noPayment = lib.evaluateLunaBookingWriteEligibility(
  makeEligiblePlan({
    booking_preview: {
      has_missing_fields: true,
      missing_fields: ['payment_choice'],
      quote: { success: true, total_cents: 100000 },
    },
    planned_actions: ['show_quote', 'ask_deposit_or_full_payment'],
  }),
  makeEligibleInput({ payment_choice: '' }),
  enabledEnv
);
if (noPayment.write_ready === false && noPayment.blocked_reasons.includes('payment_choice_missing')) {
  pass('D1', 'missing payment choice blocks write');
} else {
  fail('D1', 'payment choice block missing');
}
if (noPayment.safe_next_step === 'ask_deposit_or_full_payment') {
  pass('D2', 'safe_next_step ask_deposit_or_full_payment');
} else {
  fail('D2', 'safe_next_step: ' + noPayment.safe_next_step);
}

const noBeds = lib.evaluateLunaBookingWriteEligibility(
  makeEligiblePlan({
    availability: {
      skipped: false,
      has_enough_beds: false,
      selected_bed_codes: [],
      blockers: ['not_enough_available_beds'],
      check_in: '2026-09-01',
      check_out: '2026-09-08',
      guest_count: 2,
    },
    planned_actions: ['show_quote', 'handoff_to_staff'],
    next_action: 'handoff_to_staff',
  }),
  makeEligibleInput(),
  enabledEnv
);
if (noBeds.write_ready === false && noBeds.blocked_reasons.includes('availability_insufficient_beds')) {
  pass('D3', 'insufficient availability blocks write');
} else {
  fail('D3', 'availability block missing');
}
if (noBeds.safe_next_step === 'handoff_to_staff') pass('D4', 'handoff for availability failure');
else fail('D4', 'safe_next_step: ' + noBeds.safe_next_step);

const emptyBeds = lib.evaluateLunaBookingWriteEligibility(
  makeEligiblePlan({
    availability: {
      skipped: false,
      has_enough_beds: true,
      selected_bed_codes: [],
      check_in: '2026-09-01',
      check_out: '2026-09-08',
      guest_count: 2,
    },
  }),
  makeEligibleInput(),
  enabledEnv
);
if (emptyBeds.blocked_reasons.includes('availability_selected_beds_missing')) {
  pass('D5', 'empty selected_bed_codes blocks write');
} else {
  fail('D5', 'selected_beds block missing');
}

const paused = lib.evaluateLunaBookingWriteEligibility(
  makeEligiblePlan({
    gate: {
      can_continue_guest_automation: false,
      bot_paused: true,
      live_send_blocked: true,
    },
  }),
  makeEligibleInput(),
  enabledEnv
);
if (paused.blocked_reasons.includes('gate_automation_blocked')
    && paused.blocked_reasons.includes('gate_bot_paused')) {
  pass('D6', 'paused gate blocks write');
} else {
  fail('D6', 'gate pause blocks missing: ' + JSON.stringify(paused.blocked_reasons));
}

const noFlag = lib.evaluateLunaBookingWriteEligibility(
  makeEligiblePlan(),
  makeEligibleInput(),
  { BOT_BOOKING_ENABLED: 'false' }
);
if (noFlag.write_ready === false && noFlag.required_approvals.includes('BOT_BOOKING_ENABLED')) {
  pass('D7', 'missing BOT_BOOKING_ENABLED blocks write');
} else {
  fail('D7', 'BOT_BOOKING_ENABLED approval missing');
}

const noConfirm = lib.evaluateLunaBookingWriteEligibility(
  makeEligiblePlan(),
  makeEligibleInput({ confirm: false }),
  enabledEnv
);
if (noConfirm.required_approvals.includes('confirm_true')) pass('D8', 'missing confirm blocks write');
else fail('D8', 'confirm_true approval missing');

const noIdem = lib.evaluateLunaBookingWriteEligibility(
  makeEligiblePlan(),
  makeEligibleInput({ idempotency_key: '' }),
  enabledEnv
);
if (noIdem.required_approvals.includes('idempotency_key')) pass('D9', 'missing idempotency_key blocks write');
else fail('D9', 'idempotency_key approval missing');

const unsafe = lib.evaluateLunaBookingWriteEligibility(
  makeEligiblePlan({ dry_run: false, creates_booking: true }),
  makeEligibleInput(),
  enabledEnv
);
if (unsafe.blocked_reasons.some((r) => r.startsWith('dry_run_unsafe'))) {
  pass('D10', 'unsafe dry-run flags block write');
} else {
  fail('D10', 'dry_run_unsafe reasons missing');
}

const noStripe = lib.evaluateLunaBookingWriteEligibility(
  makeEligiblePlan(),
  makeEligibleInput(),
  enabledEnv
);
if (!noStripe.would_call.some((r) => /stripe|payment-link|webhook/i.test(r))) {
  pass('D11', 'eligible would_call excludes Stripe/link/webhook');
} else {
  fail('D11', 'Stripe/link in would_call');
}

// ─────────────────────────────────────────────────────────────────────────────
section('E. Integration with dry-run orchestrator shape');

(async () => {
  try {
    const dryRun = require('./lib/luna-guest-booking-dry-run');
    const sparse = await dryRun.runLunaGuestBookingDryRun({ client_slug: 'wolfhouse-somo' }, {});
    const sparseElig = lib.evaluateLunaBookingWriteEligibility(sparse, {}, enabledEnv);
    if (sparseElig.write_ready === false) {
      pass('E1', 'sparse dry-run plan is not write_ready');
    } else {
      fail('E1', 'sparse dry-run unexpectedly write_ready');
    }

    const complete = await dryRun.runLunaGuestBookingDryRun({
      client_slug:    'wolfhouse-somo',
      guest_name:     'Dry Run Guest',
      check_in:       '2026-09-01',
      check_out:      '2026-09-08',
      guest_count:    2,
      package_code:   'malibu',
      room_type:      'shared',
      phone:          '+34000000000',
      payment_choice: 'deposit',
    }, {});

    const withoutPg = lib.evaluateLunaBookingWriteEligibility(
      complete,
      makeEligibleInput({ confirm: true, idempotency_key: 'e2-key' }),
      enabledEnv
    );
    if (withoutPg.blocked_reasons.includes('availability_not_checked')
        || withoutPg.blocked_reasons.includes('availability_selected_beds_missing')) {
      pass('E2', 'dry-run without pg blocks on availability (expected)');
    } else {
      fail('E2', 'expected availability block without pg: ' + JSON.stringify(withoutPg.blocked_reasons));
    }
  } catch (e) {
    fail('E0', 'orchestrator integration threw: ' + e.message);
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
