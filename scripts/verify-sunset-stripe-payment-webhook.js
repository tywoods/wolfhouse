'use strict';

/**
 * verify:sunset-stripe-payment-webhook
 *
 * Offline checks + unit tests for Sunset Stripe checkout.session payment sync.
 *
 * Run:
 *   node scripts/verify-sunset-stripe-payment-webhook.js
 *   npm run verify:sunset-stripe-payment-webhook
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAFF_API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const TOTALS_PATH = path.join(ROOT, 'scripts', 'lib', 'luna-booking-payment-totals.js');
const DRAWER_PATH = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-drawer.js');
const STRIPE_LINKS_PATH = path.join(ROOT, 'scripts', 'lib', 'sunset-stripe-payment-links.js');
const TRUTH_PATH = path.join(ROOT, 'scripts', 'lib', 'stripe-webhook-payment-truth.js');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

console.log('\nverify:sunset-stripe-payment-webhook — Sunset Stripe payment sync checks\n');

// ── 1. Webhook route + lookup contract ───────────────────────────────────────

console.log('[1] staff-query-api.js — Stripe webhook route');

let apiSrc = '';
if (fs.existsSync(STAFF_API_PATH)) {
  apiSrc = fs.readFileSync(STAFF_API_PATH, 'utf8');
  assert('POST /staff/stripe/webhook route', apiSrc.includes("pathname === '/staff/stripe/webhook'"));
  assert('handleStripeWebhook handler', apiSrc.includes('async function handleStripeWebhook('));
  assert('checkout.session.completed supported', apiSrc.includes('STRIPE_BOOKING_PAYMENT_EVENT_TYPES'));
  assert('async_payment_succeeded supported', fs.readFileSync(TRUTH_PATH, 'utf8').includes("'checkout.session.async_payment_succeeded'"));
  assert('lookupPaymentForStripeSession helper wired', apiSrc.includes('lookupPaymentForStripeSession(pg, session)'));
  assert('validateStripeBookingPaymentEvent wired', apiSrc.includes('validateStripeBookingPaymentEvent(pm, session, eventType)'));
  assert('amountDueCents passed to derive', apiSrc.includes('amountDueCents: pm.amount_due_cents'));
  assert('idempotent already-paid branch', apiSrc.includes("pm.payment_status === 'paid'"));
  assert('client_id predicate on payment UPDATE',
    apiSrc.includes('AND client_id = $5')
    || fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'stripe-hold-promote-policy.js'), 'utf8').includes('AND client_id = $5'));
  assert('persists stripe_checkout_session_id on pay',
    apiSrc.includes('stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, $6)')
    || fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'stripe-hold-promote-policy.js'), 'utf8')
      .includes('stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, $6)'));
  assert('Sunset paid metadata patch wired', apiSrc.includes('bookingMetadataPatchForStripePayment'));
  assert('webhook uses shared hold-promote apply', apiSrc.includes('applyStripeBookingPaymentTruthWrites'));
} else {
  assert('staff-query-api.js exists', false);
}

// ── 2. Sunset stripe link stores session id + PI metadata ───────────────────

console.log('\n[2] sunset-stripe-payment-links.js — session id persistence');

if (fs.existsSync(STRIPE_LINKS_PATH)) {
  const stripeSrc = fs.readFileSync(STRIPE_LINKS_PATH, 'utf8');
  assert('Sunset client slug gate', stripeSrc.includes("clientSlug !== SUNSET_CLIENT_SLUG"));
  assert('stores stripe_checkout_session_id', stripeSrc.includes('stripe_checkout_session_id = $1'));
  assert('metadata payment_id on Stripe session', stripeSrc.includes('payment_id: paymentId'));
  assert('payment_intent_data metadata mirror', stripeSrc.includes('payment_intent_data[metadata]'));
  assert('blocks live Stripe keys', stripeSrc.includes('sk_live_'));
} else {
  assert('sunset-stripe-payment-links.js exists', false);
}

// ── 3. stripe-webhook-payment-truth.js — lookup + validation ─────────────────

console.log('\n[3] stripe-webhook-payment-truth.js — lookup + validation');

const {
  STRIPE_BOOKING_PAYMENT_EVENT_TYPES,
  validateStripeBookingPaymentEvent,
  bookingMetadataPatchForStripePayment,
  lookupPaymentForStripeSession,
} = require('./lib/stripe-webhook-payment-truth');

assert('supports completed + async success events',
  STRIPE_BOOKING_PAYMENT_EVENT_TYPES.includes('checkout.session.completed')
  && STRIPE_BOOKING_PAYMENT_EVENT_TYPES.includes('checkout.session.async_payment_succeeded'));

const basePm = {
  payment_id: 'pay-1',
  payment_status: 'checkout_created',
  payment_kind: 'full_amount',
  currency: 'EUR',
  amount_due_cents: 4500,
  stripe_checkout_session_id: 'cs_test_abc',
  client_slug: 'sunset',
  booking_id: 'bk-1',
};
const baseSession = {
  id: 'cs_test_abc',
  payment_status: 'paid',
  status: 'complete',
  currency: 'eur',
  amount_total: 4500,
  metadata: { payment_id: 'pay-1', client_slug: 'sunset' },
};

assert('valid Sunset session passes validation', validateStripeBookingPaymentEvent(basePm, baseSession, 'checkout.session.completed').length === 0);
assert('wrong tenant rejected', validateStripeBookingPaymentEvent(
  basePm,
  { ...baseSession, metadata: { payment_id: 'pay-1', client_slug: 'wolfhouse-somo' } },
  'checkout.session.completed',
).includes('stripe_metadata_client_slug_mismatch'));
assert('wrong currency rejected', validateStripeBookingPaymentEvent(
  { ...basePm, currency: 'USD' },
  baseSession,
  'checkout.session.completed',
).includes('payment_currency_not_eur'));
assert('wrong amount rejected', validateStripeBookingPaymentEvent(
  basePm,
  { ...baseSession, amount_total: 100 },
  'checkout.session.completed',
).includes('stripe_amount_mismatch'));
assert('unpaid session rejected', validateStripeBookingPaymentEvent(
  basePm,
  { ...baseSession, payment_status: 'unpaid' },
  'checkout.session.completed',
).includes('stripe_session_not_paid'));
assert('already-paid pm skips validation errors', validateStripeBookingPaymentEvent(
  { ...basePm, payment_status: 'paid' },
  { ...baseSession, payment_status: 'unpaid' },
  'checkout.session.completed',
).length === 0);

const sunsetPaidPatch = bookingMetadataPatchForStripePayment({ client_slug: 'sunset' }, 'paid');
assert('Sunset stripe paid sets link method', sunsetPaidPatch && sunsetPaidPatch.sunset_payment_method === 'link');
assert('Wolfhouse patch has no sunset method', !bookingMetadataPatchForStripePayment({ client_slug: 'wolfhouse-somo' }, 'paid')?.sunset_payment_method);

// ── 4. deriveBookingPaymentState — full_amount link satisfaction ──────────────

console.log('\n[4] luna-booking-payment-totals.js — derive paid state');

const { deriveBookingPaymentState } = require('./lib/luna-booking-payment-totals');

const zeroTotalPaid = deriveBookingPaymentState({
  bkTotal: 0,
  prevCompletedPaidCents: 0,
  stripePaidCents: 4500,
  paymentKind: 'full_amount',
  amountDueCents: 4500,
});
assert('zero booking total + full_amount stripe → paid status', zeroTotalPaid.newBkPayStatus === 'paid');
assert('zero booking total records paid cents', zeroTotalPaid.newBkPaid === 4500);
assert('zero booking total balance stays zero', zeroTotalPaid.newBkBalance === 0);

const staleTotalPaid = deriveBookingPaymentState({
  bkTotal: 9400,
  prevCompletedPaidCents: 0,
  stripePaidCents: 4500,
  paymentKind: 'full_amount',
  amountDueCents: 4500,
});
assert('full link paid marks booking paid even when bk_total higher', staleTotalPaid.newBkPayStatus === 'paid');
assert('full link paid clears balance', staleTotalPaid.newBkBalance === 0);

const partialDeposit = deriveBookingPaymentState({
  bkTotal: 10000,
  prevCompletedPaidCents: 0,
  stripePaidCents: 3000,
  paymentKind: 'deposit_only',
  amountDueCents: 3000,
});
assert('deposit_only partial → deposit_paid', partialDeposit.newBkPayStatus === 'deposit_paid');

const wrongAmount = deriveBookingPaymentState({
  bkTotal: 10000,
  prevCompletedPaidCents: 0,
  stripePaidCents: 3000,
  paymentKind: 'full_amount',
  amountDueCents: 4500,
});
assert('full_amount underpay stays waiting_payment', wrongAmount.newBkPayStatus === 'waiting_payment');

const secondPass = deriveBookingPaymentState({
  bkTotal: 4500,
  prevCompletedPaidCents: 4500,
  stripePaidCents: 4500,
  paymentKind: 'full_amount',
  amountDueCents: 4500,
});
assert('duplicate derive input capped at booking total', secondPass.newBkPaid === 4500);

// ── 5. Drawer payment summary reflects ledger paid rows ──────────────────────

console.log('\n[5] sunset-schedule-booking-drawer.js — drawer payment truth');

const {
  buildPaymentSummary,
  deriveDrawerPaymentUiStatus,
  formatSunsetDrawerDailyItemLabel,
} = require('./lib/sunset-schedule-booking-drawer');

assert('drawer sums completed payments query', fs.readFileSync(DRAWER_PATH, 'utf8').includes("status = 'paid'::payment_record_status"));

const waitingButPaid = buildPaymentSummary([], {
  payment_status: 'waiting_payment',
  amount_paid_cents: 4500,
  metadata: {},
}, [], 'config', 4500);
assert('waiting_payment + ledger paid shows paid UI', waitingButPaid.payment_status === 'paid');
assert('paid cents reflected in summary', waitingButPaid.paid_cents === 4500);
assert('remaining zero when paid in full', waitingButPaid.balance_due_cents === 0);

const unrelated = deriveDrawerPaymentUiStatus({ payment_status: 'waiting_payment' }, 5000, 0);
assert('unrelated unpaid booking stays unpaid', unrelated === 'unpaid');

// ── 6. Compact daily schedule item labels ────────────────────────────────────

console.log('\n[6] sunset-schedule-booking-drawer.js — compact daily labels');

const courseSr = {
  service_type: 'surf_lesson',
  metadata: JSON.stringify({ component: 'course', course_label: 'Curso Medio Día' }),
  course_label: 'Curso Medio Día',
};
const courseLabel = formatSunsetDrawerDailyItemLabel('surf_lesson', 3, courseSr);
assert('course row compact label', courseLabel === 'Curso Medio Día · 3', courseLabel);
assert('course row omits Group Course prefix', !courseLabel.includes('Group Course'));
assert('course row omits surfers', !/surfer/i.test(courseLabel));
assert('board row compact label', formatSunsetDrawerDailyItemLabel('surfboard', 3, { metadata: '{}' }) === 'Surfboard · 3');
assert('wetsuit row compact label', formatSunsetDrawerDailyItemLabel('wetsuit', 3, { metadata: '{}' }) === 'Wetsuit · 3');
assert('qty 1 bare number', formatSunsetDrawerDailyItemLabel('surfboard', 1, { metadata: '{}' }).endsWith(' · 1'));
assert('missing course name falls back safely', formatSunsetDrawerDailyItemLabel('surf_lesson', 2, {
  metadata: JSON.stringify({ component: 'course' }),
}).includes(' · 2'));

const summary = buildPaymentSummary([], { payment_status: 'unpaid', metadata: {} }, [{
  service_record_id: 'sr-1',
  service_type: 'surf_lesson',
  service_date: '2026-07-15',
  quantity: 3,
  amount_due_cents: 4500,
  metadata: JSON.stringify({ component: 'course', course_label: 'Curso Medio Día' }),
  course_label: 'Curso Medio Día',
}], 'config', 0);
const li = summary.line_items[0];
assert('payment summary uses compact label', li && li.label === 'Curso Medio Día · 3', li && li.label);
assert('compact label has no ISO date suffix', li && !/\d{4}-\d{2}-\d{2}/.test(li.label));

// ── 7. lookupPaymentForStripeSession — session id precedence ─────────────────

console.log('\n[7] stripe-webhook-payment-truth.js — payment lookup');

(async () => {
  const rows = [{ payment_id: 'pay-1', stripe_checkout_session_id: 'cs_test_abc', client_slug: 'sunset' }];
  const mockPg = {
    query: async (sql, params) => {
      if (sql.includes('WHERE p.stripe_checkout_session_id')) {
        return { rows: params[0] === 'cs_test_abc' ? rows : [] };
      }
      if (sql.includes('WHERE p.id = $1')) {
        return { rows: params[0] === 'pay-stale' ? [{ payment_id: 'pay-stale', client_slug: 'sunset' }] : [] };
      }
      return { rows: [] };
    },
  };
  const bySession = await lookupPaymentForStripeSession(mockPg, { id: 'cs_test_abc', metadata: { payment_id: 'pay-stale' } });
  assert('lookup prefers stripe_checkout_session_id over stale metadata payment_id', bySession && bySession.payment_id === 'pay-1');
  const byMeta = await lookupPaymentForStripeSession(mockPg, { id: 'cs_unknown', metadata: { payment_id: 'pay-stale' } });
  assert('lookup falls back to metadata payment_id', byMeta && byMeta.payment_id === 'pay-stale');

  console.log(`\nResult: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
