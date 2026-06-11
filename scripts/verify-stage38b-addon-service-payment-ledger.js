/**
 * Stage 38b — Add-on service payment ledger verifier.
 *
 * Usage:
 *   npm run verify:stage38b-addon-service-payment-ledger
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LEDGER = path.join(__dirname, 'lib', 'luna-guest-addon-service-payment-ledger.js');
const ATTACH = path.join(__dirname, 'lib', 'luna-guest-addon-service-attach.js');
const HOLD_WRITE = path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-write.js');
const POLICY = path.join(__dirname, 'lib', 'luna-guest-addon-service-confirmation-policy.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const PAY_SHORT = path.join(__dirname, 'lib', 'luna-payment-short-link.js');
const TRUTH = path.join(__dirname, 'lib', 'luna-guest-stripe-payment-truth-apply.js');
const SEND = path.join(__dirname, 'lib', 'luna-guest-confirmation-send-go-no-go.js');
const ROUTER = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage38b-addon-service-payment-ledger';
const PROOF_SCRIPT = 'proof:stage38b-addon-service-ledger-write';

const {
  PAYMENT_ORIGIN,
  buildServicePaymentIdempotencyKey,
  buildDryRunLedgerPlan,
  buildServiceChargesDueFromContext,
  formatServiceChargeDueLine,
  formatAddonServicePaymentLedgerLabel,
  isGuestAddonServicePaymentRow,
  paymentLedgerSummary,
} = require('./lib/luna-guest-addon-service-payment-ledger');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage38b-addon-service-payment-ledger.js  (Stage 38b)\n`);

section('A. Files + package');

check('A1', fs.existsSync(LEDGER), 'service payment ledger helper exists');
check('A2', fs.existsSync(path.join(__dirname, 'run-stage38b-addon-service-ledger-write-proof.js')), 'write proof script exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A3', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);
check('A4', pkg.scripts && pkg.scripts[PROOF_SCRIPT], `npm script ${PROOF_SCRIPT}`);

const attachSrc = fs.readFileSync(ATTACH, 'utf8');
const holdSrc = fs.readFileSync(HOLD_WRITE, 'utf8');
const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const payShortSrc = fs.readFileSync(PAY_SHORT, 'utf8');
const truthSrc = fs.readFileSync(TRUTH, 'utf8');
const sendSrc = fs.readFileSync(SEND, 'utf8');

section('B. Ledger helper design');

const summary = paymentLedgerSummary();
check('B1', summary.payment_kind === 'addon_service', 'uses addon_service payment_kind');
check('B2', summary.separate_from_deposit === true, 'ledger rows separate from booking deposit');
check('B3', summary.creates_stripe_session === false, 'no Stripe session by default');
check('B4', summary.optional_pay_now === false, 'optional pay-now disabled until safe routing');
check('B5', PAYMENT_ORIGIN === 'luna_guest_service_addon', 'payment_origin luna_guest_service_addon');

const idem = buildServicePaymentIdempotencyKey('booking-uuid', 'svc-uuid');
check('B6', idem.includes('booking-uuid') && idem.includes('svc-uuid'), 'idempotency key uses booking + service record');

section('C. Dry-run ledger plan');

const plan = buildDryRunLedgerPlan([
  { id: 'sr1', service_type: 'wetsuit', amount_due_cents: 2000, metadata: {} },
  { id: 'sr2', service_type: 'surfboard', amount_due_cents: 3000, metadata: {} },
]);
check('C1', plan.service_payment_rows_planned === 2, 'dry-run plans rows for priced services');
check('C2', plan.service_payment_total_due_cents === 5000, 'dry-run totals service due cents');
check('C3', plan.optional_pay_now === false, 'dry-run optional_pay_now false');
check('C4', plan.service_charges_due_lines.some((l) => /Wetsuit rental.*due at checkout/i.test(l)), 'staff line wetsuit due at checkout');

section('D. Staff balance visibility');

const staffSummary = buildServiceChargesDueFromContext({
  booking: { balance_due_cents: 18000 },
  serviceRecords: [
    { service_type: 'wetsuit', amount_due_cents: 2000, payment_status: 'pending', metadata: {} },
  ],
  paymentRows: [
    {
      payment_kind: 'addon_service',
      payment_status: 'draft',
      amount_due_cents: 2000,
      amount_paid_cents: 0,
      metadata: {
        payment_origin: PAYMENT_ORIGIN,
        service_type: 'wetsuit',
        service_record_id: 'sr1',
      },
    },
    {
      payment_kind: 'deposit_only',
      payment_status: 'draft',
      amount_due_cents: 10000,
      amount_paid_cents: 0,
      metadata: {},
    },
  ],
});
check('D1', staffSummary.service_charges_due_cents === 2000, 'service_charges_due_cents computed');
check('D2', staffSummary.service_charges_due_lines.length === 1, 'service_charges_due_lines populated');
check('D3', staffSummary.service_charges_due_lines[0].includes('Wetsuit rental'), 'staff line human label');
check('D4', !staffSummary.service_charges_due_lines[0].includes('metadata'), 'staff copy hides raw metadata');
check('D5', staffSummary.total_due_at_checkout_cents === 18000, 'total due uses booking balance when present');
check('D6', staffSummary.optional_pay_now === false, 'optional_pay_now false in staff summary');

const depositOnly = buildServiceChargesDueFromContext({
  booking: {},
  serviceRecords: [],
  paymentRows: [{ payment_kind: 'deposit_only', payment_status: 'draft', amount_due_cents: 10000, metadata: {} }],
});
check('D7', depositOnly.service_charges_due_cents === 0, 'deposit row not counted as service charge');

section('E. Payment ledger labels');

const draftLabel = formatAddonServicePaymentLedgerLabel({
  payment_kind: 'addon_service',
  payment_status: 'draft',
  amount_due_cents: 3500,
  metadata: { payment_origin: PAYMENT_ORIGIN, service_type: 'surf_lesson' },
});
check('E1', /Surf lesson.*due at checkout/i.test(draftLabel), 'ledger label surf lesson due at checkout');
check('E2', !draftLabel.includes('checkout.stripe.com'), 'ledger label no raw Stripe URL');

section('F. Wiring');

check('F1', attachSrc.includes('syncGuestAddonServicePaymentLedger'), 'attach syncs payment ledger after service attach');
check('F2', holdSrc.includes('attachAllGuestAddonServices'), 'hold write still attaches guest services');
check('F3', routerSrc.includes('buildServiceChargesDueFromContext'), 'booking context exposes service charges due');
check('F4', routerSrc.includes('service_charges_due_lines'), 'booking context includes due lines array');
check('F5', routerSrc.includes('formatAddonServicePaymentLedgerLabel'), 'payments tab uses addon service labels');

section('G. Deposit short link unchanged');

check('G1', payShortSrc.includes('findLatestActiveCheckoutPayment'), 'short link resolver unchanged');
check('G2', !ledgerSrcIncludesStripeCreate(LEDGER), 'ledger helper does not create Stripe sessions');

function ledgerSrcIncludesStripeCreate(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  return /checkout\.sessions\.create|createStripe/i.test(src);
}

check('G3', !routerSrc.match(/handleGuestPaymentShortLinkRedirect[\s\S]{0,800}addon_service[\s\S]{0,400}create/i), 'redirect route does not create addon Stripe');

section('H. Copy + observability');

let observability;
try {
  const { buildAddonServiceObservability, paymentLedgerGapSummary } = require('./lib/luna-guest-addon-service-confirmation-policy');
  observability = buildAddonServiceObservability(
    { service_interest: ['wetsuit', 'surfboard'] },
    { quote_total_cents: 26000 },
    'wolfhouse-somo',
  );
  const gap = paymentLedgerGapSummary();
  check('H4', gap.booking_payment_ledger_per_service_row === true, 'policy ledger gap closed');
} catch (e) {
  fail('H4', `policy observability load failed: ${e.message}`);
}
check('H1', observability && observability.service_charges_due_plan === true, 'composer observability service_charges_due_plan');
check('H2', observability && observability.optional_pay_now === false, 'composer observability optional_pay_now false');
check('H3', !composerSrc.includes('checkout.stripe.com'), 'composer does not embed raw Stripe for addons');

section('I. Safety');

check('I1', !truthSrc.includes('luna-guest-addon-service-payment-ledger'), 'payment truth module unchanged');
check('I2', !sendSrc.includes('luna-guest-addon-service-payment-ledger'), 'confirmation send unchanged');
check('I3', !holdSrc.match(/sends_whatsapp:\s*true|graph\.facebook\.com/i), 'hold write no WhatsApp');
check('I4', !holdSrc.includes('n8n.activate'), 'hold write no n8n activation');
check('I5', !ledgerSrcIncludesStripeCreate(LEDGER), 'ledger no live Stripe');
check('I6', fs.readFileSync(LEDGER, 'utf8').includes('amount_paid_cents: 0') || fs.readFileSync(LEDGER, 'utf8').includes(', 0,'), 'ledger inserts unpaid rows only');

section('J. Idempotency static');

check('J1', fs.readFileSync(LEDGER, 'utf8').includes('findExistingServicePayment'), 'lookup existing payment before insert');
check('J2', fs.readFileSync(LEDGER, 'utf8').includes('service_record_id'), 'metadata stores service_record_id');
check('J3', isGuestAddonServicePaymentRow({
  payment_kind: 'addon_service',
  metadata: { payment_origin: PAYMENT_ORIGIN },
}), 'guest addon payment row detector');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Stage 38b verifier: ${failures === 0 ? 'PASS' : 'FAIL'} (${passes} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
