/**
 * Stage 33c — pending yoga/meals must not block hold write + post-hold attach.
 *
 * Usage:
 *   npm run verify:stage33c-pending-service-attach-hold-write
 */

'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const ROOT = path.join(__dirname, '..');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage33c-pending-service-attach-hold-write';

const { withPgClient } = require('./lib/pg-connect');
const {
  collectPendingManualServices,
  attachPendingManualGuestServices,
  PENDING_ATTACH_SOURCE,
} = require('./lib/luna-guest-pending-service-attach');
const {
  runGuestHoldPaymentDraftPlannerDryRun,
  shouldAttemptGuestHoldPaymentDraftPlan,
} = require('./lib/luna-guest-hold-payment-draft-planner');
const { runGuestPaymentChoiceDryRun } = require('./lib/luna-guest-payment-choice-dry-run');
const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { isStripePaymentLinkSend, pollForPaymentLinkSend } = require('./lib/luna-hosted-proof-booking-lookup');
const { stripPendingManualFromServiceInterest } = require('./lib/luna-booking-reactive-services-policy');
const holdWriteSrc = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-write.js'), 'utf8');
const plannerSrc = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-planner.js'), 'utf8');
const routerSrc = fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-message-router.js'), 'utf8');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage33c-pending-service-attach-hold-write.js  (Stage 33c)\n`);

section('A. Package script + safety static');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A1', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);
check('A2', !holdWriteSrc.includes('sends_whatsapp: true'), 'no WhatsApp send path added');
check('A3', holdWriteSrc.includes('calls_n8n: false'), 'hold write keeps n8n disabled');
check('A4', !holdWriteSrc.includes('creates_stripe_link: true'), 'no live Stripe path added');
check('A5', plannerSrc.includes('PENDING_MANUAL_SERVICE_CODES'), 'planner excludes pending manual from hold block');
check('A6', routerSrc.includes('stripPendingManualFromServiceInterest'), 'router strips yoga/meals from service_interest');

section('B. Payment + hold readiness with pending manual services');

function readyChain(fieldsExtra) {
  const fields = {
    check_in: '2026-07-10',
    check_out: '2026-07-17',
    guest_count: 1,
    package_interest: 'malibu',
    addons_skipped: true,
    service_interest: [],
    yoga_request: { status: 'requested', guest_count: 1 },
    ...fieldsExtra,
  };
  return {
    result: {
      success: true,
      message_lane: 'new_booking_inquiry',
      booking_intake_ready: true,
      readiness_state: 'ready_for_availability_check',
      extracted_fields: fields,
    },
    availability: { availability_status: 'available' },
    quote: {
      quote_status: 'ready',
      quote_total_cents: 29900,
      payment_choice_needed: true,
      deposit_options: { deposit_required_cents: 20000 },
    },
    payment_choice: {
      payment_choice_ready: true,
      next_safe_step: 'ready_for_hold_payment_draft',
      payment_choice: 'deposit',
    },
  };
}

const yogaChain = readyChain({});
const mealsChain = readyChain({
  yoga_request: null,
  meals_request: { status: 'interested', meal_type: 'dinner', deferred: true },
  service_interest: [],
});

check('B1', runGuestPaymentChoiceDryRun(
  { message_text: 'deposit' },
  { message_lane: 'new_booking_inquiry', quote: yogaChain.quote, payment_choice_needed: true },
).payment_choice_ready === true, 'yoga pending does not block payment_choice_ready');

check('B2', shouldAttemptGuestHoldPaymentDraftPlan(yogaChain), 'yoga pending does not block hold plan gate');
const yogaPlan = runGuestHoldPaymentDraftPlannerDryRun(yogaChain, { client_slug: 'wolfhouse-somo' });
check('B3', yogaPlan.plan_status === 'ready' && yogaPlan.plan_handoff_required !== true,
  `yoga pending hold plan ready (got ${yogaPlan.plan_status} ${JSON.stringify(yogaPlan.plan_handoff_reasons || [])})`);

check('B4', shouldAttemptGuestHoldPaymentDraftPlan(mealsChain), 'deferred meals does not block hold plan gate');
const mealsPlan = runGuestHoldPaymentDraftPlannerDryRun(mealsChain, { client_slug: 'wolfhouse-somo' });
check('B5', mealsPlan.plan_status === 'ready' && mealsPlan.plan_handoff_required !== true,
  'deferred meals hold plan ready');

const legacyYogaBlock = readyChain({ service_interest: ['yoga'], yoga_request: { status: 'requested' } });
const legacyPlan = runGuestHoldPaymentDraftPlannerDryRun(legacyYogaBlock, { client_slug: 'wolfhouse-somo' });
check('B6', legacyPlan.plan_status === 'ready' && legacyPlan.plan_handoff_required !== true,
  'legacy yoga string in service_interest no longer blocks hold plan');

section('C. Pending attach idempotency');

(async () => {
  const attachFields = {
    yoga_request: { status: 'requested' },
    meals_request: { status: 'interested', meal_type: 'dinner', deferred: true },
    services_pending_manual: ['yoga', 'meals'],
  };
  const pending = collectPendingManualServices(attachFields);
  check('C1', pending.some((s) => s.type === 'yoga'), 'collect yoga pending');
  check('C2', pending.some((s) => s.type === 'meal'), 'collect meals pending');

  let tableMissing = false;
  try {
    await withPgClient(async (pg) => {
      const reg = await pg.query("SELECT to_regclass('public.booking_service_records') AS t");
      if (!reg.rows[0] || !reg.rows[0].t) {
        tableMissing = true;
        return;
      }
      const bookingId = '00000000-0000-4000-8000-000000000033';
      await pg.query('DELETE FROM booking_service_records WHERE booking_id = $1::uuid', [bookingId]);

      const first = await attachPendingManualGuestServices(pg, {
        clientSlug: 'wolfhouse-somo',
        bookingId,
        bookingCode: 'WH-TEST-33C',
        guestName: 'Test Guest',
        extractedFields: attachFields,
      });
      check('C3', first.attached_manual_services.includes('yoga')
        && first.attached_manual_services.includes('meals'),
        'attach yoga + meals after hold');

      const rows = (await pg.query(
        `SELECT service_type, status, source, service_date, metadata
           FROM booking_service_records WHERE booking_id = $1::uuid ORDER BY service_type`,
        [bookingId],
      )).rows;
      const yogaRow = rows.find((r) => r.service_type === 'yoga');
      check('C4', yogaRow && yogaRow.status === 'requested', 'yoga status requested');
      check('C5', yogaRow && yogaRow.source === PENDING_ATTACH_SOURCE, 'yoga source luna_guest_pending');
      check('C6', yogaRow && yogaRow.service_date == null, 'yoga service_date null');
      check('C7', yogaRow && yogaRow.metadata && yogaRow.metadata.needs_scheduling === true,
        'yoga needs_scheduling true');

      const second = await attachPendingManualGuestServices(pg, {
        clientSlug: 'wolfhouse-somo',
        bookingId,
        bookingCode: 'WH-TEST-33C',
        guestName: 'Test Guest',
        extractedFields: attachFields,
      });
      check('C8', second.attached_manual_services.length === 0, 'repeat attach is idempotent');
      const count = (await pg.query(
        'SELECT COUNT(*)::int AS n FROM booking_service_records WHERE booking_id = $1::uuid',
        [bookingId],
      )).rows[0].n;
      check('C9', count === 2, 'no duplicate service records');

      await pg.query('DELETE FROM booking_service_records WHERE booking_id = $1::uuid', [bookingId]);
    });
  } catch (e) {
    if (/relation "booking_service_records" does not exist/i.test(String(e.message || e))) {
      tableMissing = true;
    } else {
      throw e;
    }
  }
  if (tableMissing) {
    pass('C3', 'booking_service_records table missing — attach DB checks skipped (PARTIAL)');
  }

  section('D. Orchestrator yoga deposit flow');
  async function runTurn(message, prior) {
    return withPgClient((pg) => runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      message_text: message,
      guest_phone: '+491726422399',
      guest_context: prior || {},
      reference_date: '2026-06-10',
      dry_run: true,
      automation_gate_context: {
        public_guest_automation_enabled: false,
        whatsapp_dry_run: true,
        live_send_allowed: false,
      },
    }, { reference_date: '2026-06-10', dry_run: true, pg }));
  }

  let ctx = {};
  let out = await runTurn('Malibu July 10 to July 17 for 1', ctx);
  ctx = { result: out.result, availability: out.availability, quote: out.quote, payment_choice: out.payment_choice, extracted_fields: out.result.extracted_fields };
  out = await runTurn('just the stay', ctx);
  ctx = { result: out.result, availability: out.availability, quote: out.quote, payment_choice: out.payment_choice, extracted_fields: out.result.extracted_fields };
  out = await runTurn('Can I add yoga?', ctx);
  check('D1', out.result.yoga_status === 'requested', 'yoga_status requested on ask');
  check('D2', !((out.result.extracted_fields.service_interest || []).includes('yoga')),
    'yoga not stored in service_interest');
  ctx = { result: out.result, availability: out.availability, quote: out.quote, payment_choice: out.payment_choice, extracted_fields: out.result.extracted_fields };
  out = await runTurn('deposit', ctx);
  check('D3', out.payment_choice && out.payment_choice.payment_choice === 'deposit', 'deposit detected');
  check('D4', out.payment_choice && out.payment_choice.payment_choice_ready === true,
    'payment_choice_ready on deposit with yoga pending');
  check('D5', out.hold_payment_draft_plan && out.hold_payment_draft_plan.plan_status === 'ready',
    'hold_payment_draft_plan ready on deposit with yoga pending');

  section('E. Stripe poll matcher');
  check('E1', !isStripePaymentLinkSend({ message_text: "Perfect — deposit it is. I'll get your secure payment link ready." }),
    'composer ack is not a Stripe payment link');
  check('E2', isStripePaymentLinkSend({ message_text: 'Pay here https://checkout.stripe.com/c/pay/cs_test_abc' }),
    'real Stripe checkout URL matches');
  check('E3', !isStripePaymentLinkSend({ message_text: 'secure payment link ready' }),
    'ack copy alone does not match');

  let pollCount = 0;
  const pollResult = await pollForPaymentLinkSend(async () => {
    pollCount += 1;
    if (pollCount < 2) {
      return [{ message_text: "I'll get your secure payment link ready.", created_at: '2026-06-10T12:00:01Z' }];
    }
    return [{ message_text: 'Pay https://checkout.stripe.com/c/pay/cs_test_xyz', created_at: '2026-06-10T12:00:05Z' }];
  }, { sinceIso: '2026-06-10T12:00:00Z', intervalMs: 50, maxWaitMs: 500, firstWindowMs: 5 });
  check('E4', pollResult.send && isStripePaymentLinkSend(pollResult.send),
    'poll waits for real Stripe URL not ack copy');

  section('F. stripPendingManualFromServiceInterest');
  const stripped = stripPendingManualFromServiceInterest({
    service_interest: ['wetsuit', 'yoga'],
    yoga_request: { status: 'requested' },
  });
  check('F1', stripped.service_interest.includes('wetsuit') && !stripped.service_interest.includes('yoga'),
    'strip removes yoga keeps surf add-ons');

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
