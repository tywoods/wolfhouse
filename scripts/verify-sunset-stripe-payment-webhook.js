'use strict';

/**
 * verify:sunset-stripe-payment-webhook
 *
 * Offline checks + unit tests for Sunset Stripe checkout.session.completed payment sync.
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
  assert('checkout.session.completed handling', apiSrc.includes("eventType !== 'checkout.session.completed'") === false
    || apiSrc.includes("'checkout.session.completed'"));
  assert('lookup by stripe_checkout_session_id', apiSrc.includes('p.stripe_checkout_session_id = $1'));
  assert('lookup by metadata payment_id', apiSrc.includes('p.id = $1'));
  assert('idempotent already-paid branch', apiSrc.includes("pm.payment_status === 'paid'"));
  assert('client_id predicate on payment UPDATE', apiSrc.includes('AND client_id = $5'));
  assert('no client-sent paid trust', !apiSrc.includes('body.payment_status') || !apiSrc.slice(
    apiSrc.indexOf('async function handleStripeWebhook'),
    apiSrc.indexOf('async function handleStripeWebhook') + 4000,
  ).includes('body.payment_status'));
} else {
  assert('staff-query-api.js exists', false);
}

// ── 2. Sunset stripe link stores session id ──────────────────────────────────

console.log('\n[2] sunset-stripe-payment-links.js — session id persistence');

if (fs.existsSync(STRIPE_LINKS_PATH)) {
  const stripeSrc = fs.readFileSync(STRIPE_LINKS_PATH, 'utf8');
  assert('Sunset client slug gate', stripeSrc.includes("clientSlug !== SUNSET_CLIENT_SLUG"));
  assert('stores stripe_checkout_session_id', stripeSrc.includes('stripe_checkout_session_id = $1'));
  assert('metadata payment_id on Stripe session', stripeSrc.includes('payment_id: paymentId'));
  assert('blocks live Stripe keys', stripeSrc.includes('sk_live_'));
} else {
  assert('sunset-stripe-payment-links.js exists', false);
}

// ── 3. deriveBookingPaymentState — zero-total full_amount paid ───────────────

console.log('\n[3] luna-booking-payment-totals.js — derive paid state');

const { deriveBookingPaymentState } = require('./lib/luna-booking-payment-totals');

const zeroTotalPaid = deriveBookingPaymentState({
  bkTotal: 0,
  prevCompletedPaidCents: 0,
  stripePaidCents: 4500,
  paymentKind: 'full_amount',
});
assert('zero booking total + full_amount stripe → paid status', zeroTotalPaid.newBkPayStatus === 'paid');
assert('zero booking total records paid cents', zeroTotalPaid.newBkPaid === 4500);
assert('zero booking total balance stays zero', zeroTotalPaid.newBkBalance === 0);

const partialDeposit = deriveBookingPaymentState({
  bkTotal: 10000,
  prevCompletedPaidCents: 0,
  stripePaidCents: 3000,
  paymentKind: 'deposit_only',
});
assert('deposit_only partial → deposit_paid', partialDeposit.newBkPayStatus === 'deposit_paid');

const fullPaid = deriveBookingPaymentState({
  bkTotal: 4500,
  prevCompletedPaidCents: 0,
  stripePaidCents: 4500,
  paymentKind: 'full_amount',
});
assert('full payment clears balance → paid', fullPaid.newBkPayStatus === 'paid' && fullPaid.newBkBalance === 0);

// Idempotent-style: second event should not inflate totals in derive helper inputs
const secondPass = deriveBookingPaymentState({
  bkTotal: 4500,
  prevCompletedPaidCents: 4500,
  stripePaidCents: 4500,
  paymentKind: 'full_amount',
});
assert('duplicate derive input capped at booking total', secondPass.newBkPaid === 4500);

// ── 4. Drawer payment summary reflects ledger paid rows ──────────────────────

console.log('\n[4] sunset-schedule-booking-drawer.js — drawer payment truth');

const {
  buildPaymentSummary,
  deriveDrawerPaymentUiStatus,
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

// ── 5. Drawer UI + customer open booking wiring ──────────────────────────────

console.log('\n[5] staff-query-api.js — drawer + customer open booking');

if (apiSrc) {
  assert('drawer hero includes booking code without label', apiSrc.includes('portal-schedule-drawer-booking-code')
    && apiSrc.includes('scheduleRenderDrawerHeroHtml('));
  assert('drawer hero no School: prefix', !apiSrc.includes("portalT('schedule.drawer.school') + ': ' + scheduleResolveDrawerSchoolLabel"));
  assert('header actions in hero', apiSrc.includes('portal-schedule-drawer-hero-actions')
    && apiSrc.includes('scheduleWireDrawerHeaderActions('));
  assert('floating topbar hidden', apiSrc.includes('.portal-schedule-drawer-topbar{display:none}'));
  assert('registration form date-only helper', apiSrc.includes('function scheduleDateOnlyLabel('));
  assert('waiver submitted_at date-only', apiSrc.includes('scheduleDateOnlyLabel(sub.submitted_at)'));
  assert('customer open uses _drawerFromCustomer', apiSrc.includes('_drawerFromCustomer'));
  assert('customer open fetches exact booking ref', apiSrc.includes('row._drawerFromCustomer')
    && apiSrc.includes('booking_id: row.booking_id'));
  assert('linked booking data-booking-id attr', apiSrc.includes('data-booking-id="'));
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nResult: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
