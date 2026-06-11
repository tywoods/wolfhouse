/**
 * Stage 38a — Add-on service confirmation + optional pay-now UX verifier.
 *
 * Usage:
 *   npm run verify:stage38a-addon-service-confirmation-payment-ux
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POLICY = path.join(__dirname, 'lib', 'luna-guest-addon-service-confirmation-policy.js');
const ATTACH = path.join(__dirname, 'lib', 'luna-guest-addon-service-attach.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const REACTIVE = path.join(__dirname, 'lib', 'luna-booking-reactive-services-policy.js');
const HOLD_WRITE = path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-write.js');
const TRUTH = path.join(__dirname, 'lib', 'luna-guest-stripe-payment-truth-apply.js');
const SEND = path.join(__dirname, 'lib', 'luna-guest-confirmation-send-go-no-go.js');
const PAY_SHORT = path.join(__dirname, 'lib', 'luna-payment-short-link.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage38a-addon-service-confirmation-payment-ux';

const FIXTURES = [
  'surf-addons-held-pay-later.json',
  'lesson-added-pay-later.json',
  'dinner-added-pay-later.json',
];

const {
  buildServiceConfirmationSection,
  buildAddonPaymentChoiceReply,
  buildReactiveServiceConfirmationCopy,
  collectAddonServicesFromContext,
  paymentLedgerGapSummary,
  policySummary,
  SERVICE_RULES,
} = require('./lib/luna-guest-addon-service-confirmation-policy');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');
const { buildReactiveServiceComposerReply } = require('./lib/luna-booking-reactive-services-policy');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage38a-addon-service-confirmation-payment-ux.js  (Stage 38a)\n`);

section('A. Files + package');

check('A1', fs.existsSync(POLICY), 'addon service confirmation policy exists');
check('A2', fs.existsSync(ATTACH), 'addon service attach module exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A3', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);
for (const f of FIXTURES) {
  check('A4', fs.existsSync(path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', f)), `fixture ${f}`);
}

const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const reactiveSrc = fs.readFileSync(REACTIVE, 'utf8');
const holdSrc = fs.readFileSync(HOLD_WRITE, 'utf8');
const truthSrc = fs.readFileSync(TRUTH, 'utf8');
const sendSrc = fs.readFileSync(SEND, 'utf8');
const attachSrc = fs.readFileSync(ATTACH, 'utf8');

section('B. Policy structure');

const summary = policySummary();
check('B1', summary.in_scope.includes('wetsuit') && summary.in_scope.includes('meal'), 'in-scope services listed');
check('B2', SERVICE_RULES.wetsuit.confirmation_mode === 'held', 'wetsuit held mode');
check('B3', SERVICE_RULES.surf_lesson.needs_scheduling === true, 'lesson needs scheduling');
check('B4', SERVICE_RULES.yoga.needs_scheduling === true, 'yoga needs scheduling');
check('B5', summary.payment_behavior.settle_at_checkout_allowed === true, 'settle at checkout allowed');
check('B6', summary.payment_behavior.never_claim_paid_without_truth === true, 'never claim paid without truth');

section('C. Copy differentiation');

const gearFields = { service_interest: ['wetsuit', 'surfboard'], check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1 };
const gearCopy = buildServiceConfirmationSection(gearFields, { quote_total_cents: 20000, line_items: [] }, 'en', 'wolfhouse-somo');
check('C1', gearCopy && /hold/i.test(gearCopy) && /wetsuit/i.test(gearCopy) && /board/i.test(gearCopy), 'wetsuit+board on hold copy');
check('C2', gearCopy && !/\bpaid\b/i.test(gearCopy), 'gear copy does not claim paid');

const lessonFields = { service_interest: ['surf_lesson'], check_in: '2026-07-01', check_out: '2026-07-05' };
const lessonCopy = buildAddonPaymentChoiceReply({
  lang: 'en', fields: lessonFields, quote: { quote_total_cents: 21500 }, client_slug: 'wolfhouse-somo', deposit: '€100', total: '€215',
});
check('C3', lessonCopy && /lesson/i.test(lessonCopy) && /closer to the day/i.test(lessonCopy), 'lesson added + group later');
check('C4', lessonCopy && /checkout/i.test(lessonCopy), 'lesson copy allows checkout payment');

const yogaCopy = buildReactiveServiceConfirmationCopy('en', 'yoga', { yoga_request: { status: 'requested' } });
check('C5', yogaCopy && /yoga/i.test(yogaCopy) && /schedul/i.test(yogaCopy), 'yoga scheduling copy');

const dinnerCopy = buildReactiveServiceConfirmationCopy('en', 'meals', { meals_request: { status: 'requested', meal_type: 'dinner' } });
check('C6', dinnerCopy && /dinner/i.test(dinnerCopy) && /checkout/i.test(dinnerCopy), 'dinner booked + checkout');

section('D. Composer wiring');

check('D1', composerSrc.includes('luna-guest-addon-service-confirmation-policy'), 'composer imports policy');
check('D2', composerSrc.includes('buildAddonPaymentChoiceReply'), 'composer uses addon payment choice reply');
check('D3', reactiveSrc.includes('buildReactiveServiceConfirmationCopy'), 'reactive services use Cami confirmation copy');

const composedGear = composeLunaGuestReply({
  payload: {
    result: { detected_language: 'en', message_lane: 'new_booking_inquiry', booking_intake_policy: { add_ons_status: 'collected' } },
    payment_choice: { payment_choice_ready: false },
    quote: { quote_status: 'ready', quote_total_cents: 20000, payment_choice_needed: true, deposit_options: { deposit_required_cents: 10000 } },
    availability: { availability_status: 'available' },
  },
  client_slug: 'wolfhouse-somo',
  prior_guest_context: {
    result: {
      extracted_fields: {
        check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1,
        service_interest: ['wetsuit', 'surfboard'], package_interest: 'accommodation_only',
      },
    },
    quote: { quote_status: 'ready', quote_total_cents: 20000, payment_choice_needed: true },
    payment_choice: { payment_choice_ready: false },
  },
});
check('D4', composedGear.composer_state === 'ask_payment_choice', 'gear path reaches ask_payment_choice');
check('D5', composedGear.reply && /hold/i.test(composedGear.reply) && !/checkout\.stripe\.com/i.test(composedGear.reply), 'gear reply uses hold copy not raw Stripe');

section('E. Service record attach bridge');

check('E1', holdSrc.includes('attachAllGuestAddonServices'), 'hold write attaches guest addon services');
check('E2', attachSrc.includes('buildManualBookingServiceRecordRows'), 'attach reuses manual booking service rows');
check('E3', attachSrc.includes('attach_origin'), 'attach uses idempotent attach_origin metadata');
check('E4', attachSrc.includes('payment_status = \'pending\''), 'pending manual services can get pending payment_status');

section('F. Payment ledger visibility');

const ledger = paymentLedgerGapSummary();
check('F1', ledger.service_rows_supported === true, 'service rows supported');
check('F2', ledger.service_amount_due_on_record === true, 'amount_due on service record');
check('F3', ledger.booking_payment_ledger_per_service_row === false, 'documents per-service payment ledger gap honestly');

section('G. Safety');

check('G1', !composerSrc.includes('stripe.checkout.sessions.create'), 'composer no Stripe create');
check('G2', !truthSrc.includes('luna-guest-addon-service'), 'payment truth unchanged');
check('G3', !sendSrc.includes('luna-guest-addon-service'), 'confirmation send unchanged');
check('G4', !holdSrc.match(/sends_whatsapp:\s*true|graph\.facebook\.com/i), 'hold write no WhatsApp');
check('G5', !holdSrc.includes('n8n.activate'), 'hold write no n8n activation');
check('G6', !attachSrc.includes('amount_paid_cents ='), 'attach does not mark services paid');

section('H. Reactive composer runtime');

const reactiveDinner = buildReactiveServiceComposerReply('en', 'meals', {
  check_in: '2026-07-10', check_out: '2026-07-17', guest_count: 1,
  meals_request: { status: 'requested', meal_type: 'dinner' },
}, { quote_status: 'ready', payment_choice_needed: true });
check('H1', reactiveDinner && /dinner/i.test(reactiveDinner), 'reactive dinner confirmation copy');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Stage 38a verifier: ${failures === 0 ? 'PASS' : 'FAIL'} (${passes} passed, ${failures} failed)`);
if (ledger.gap) console.log(`\nLedger note: ${ledger.gap}`);
process.exit(failures === 0 ? 0 : 1);
