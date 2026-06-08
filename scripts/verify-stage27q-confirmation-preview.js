/**
 * Stage 27q — Confirmation preview dry-run verifier.
 *
 * Usage:
 *   npm run verify:stage27q-confirmation-preview
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PREVIEW_MOD = path.join(__dirname, 'lib', 'luna-guest-confirmation-preview-dry-run.js');
const BASE_MOD = path.join(__dirname, 'lib', 'luna-booking-confirmation-preview.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27Q-CONFIRMATION-PREVIEW.md');
const SCRIPT = 'verify:stage27q-confirmation-preview';

const {
  runGuestConfirmationPreviewDryRun,
  paymentTruthReady,
  sanitizePreviewMessage,
  ensureLunaIdentity,
  appendDepositBalanceArrivalOptions,
  messageHasBedLeak,
  REUSED_PREVIEW_PATH,
  PREVIEW_SAFETY,
  UNPAID_BOOKING_PAYMENT_STATUSES,
} = require('./lib/luna-guest-confirmation-preview-dry-run');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const GATE_CODE = '2684#';
const ADDRESS = 'C. Mies de La Ran, 41, 39140 Somo, Cantabria';

function buildDepositDraft(overrides) {
  return {
    booking_code: 'WH-G27-PREVIEW',
    guest_name: 'Alex',
    payment_status: 'deposit_paid',
    amount_paid_cents: 20000,
    balance_due_cents: 80000,
    room_number: 'MB-01',
    address: ADDRESS,
    gate_code: GATE_CODE,
    ...overrides,
  };
}

function buildFullPaidDraft(overrides) {
  return {
    booking_code: 'WH-G27-FULL',
    guest_name: 'Sam',
    payment_status: 'paid',
    amount_paid_cents: 100000,
    balance_due_cents: 0,
    room_number: 'MB-02',
    address: ADDRESS,
    gate_code: GATE_CODE,
    ...overrides,
  };
}

console.log('\nverify-stage27q-confirmation-preview.js  (Stage 27q)\n');

try {
  execSync(`node --check "${PREVIEW_MOD}"`, { stdio: 'pipe' });
  pass('0a', 'confirmation preview module passes node --check');
} catch {
  fail('0a', 'module syntax error');
}

const previewSrc = fs.readFileSync(PREVIEW_MOD, 'utf8');
const baseSrc = fs.readFileSync(BASE_MOD, 'utf8');

section('A. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('A1', `${SCRIPT} registered`);
else fail('A1', `missing npm script ${SCRIPT}`);

section('B. Reused preview path');

if (previewSrc.includes('getLunaBookingConfirmationPreview')) pass('B1', 'calls existing preview helper');
else fail('B1', 'must reuse getLunaBookingConfirmationPreview');

if (previewSrc.includes('luna-booking-confirmation-preview')) pass('B2', 'imports luna-booking-confirmation-preview');
else fail('B2', 'must import preview module');

if (REUSED_PREVIEW_PATH.includes('14b')) pass('B3', 'REUSED_PREVIEW_PATH names Phase 14b');
else fail('B3', 'REUSED_PREVIEW_PATH should name 14b');

if (baseSrc.includes('getLunaBookingConfirmationPreview')) pass('B4', 'base preview helper exists');
else fail('B4', 'base helper missing');

section('C. Payment truth gate');

if (paymentTruthReady('deposit_paid', null)) pass('C1', 'deposit_paid is payment truth');
else fail('C1', 'deposit_paid should pass');

if (paymentTruthReady('paid', null)) pass('C2', 'paid is payment truth');
else fail('C2', 'paid should pass');

if (!paymentTruthReady('waiting_payment', null)) pass('C3', 'waiting_payment blocked');
else fail('C3', 'waiting_payment must block');

if (!paymentTruthReady('checkout_created', null)) pass('C4', 'checkout_created blocked');
else fail('C4', 'checkout_created must block');

section('D. Blocked unpaid states');

(async () => {
  const unpaid = await runGuestConfirmationPreviewDryRun(
    {
      booking_code: 'WH-G27-UNPAID',
      payment_status: 'waiting_payment',
      confirmation_draft: buildDepositDraft({ payment_status: 'waiting_payment' }),
    },
    { use_fixture_pg: true },
  );

  if (!unpaid.confirmation_preview_ready && unpaid.block_reasons.includes('payment_truth_not_recorded')) {
    pass('D1', 'waiting_payment cannot preview as confirmed');
  } else {
    fail('D1', 'unpaid must not preview ready');
  }

  const checkout = await runGuestConfirmationPreviewDryRun(
    {
      booking_code: 'WH-G27-CHK',
      payment_status: 'waiting_payment',
      confirmation_draft: buildDepositDraft({ payment_record_status: 'checkout_created' }),
    },
    { use_fixture_pg: true },
  );

  if (!checkout.confirmation_preview_ready) pass('D2', 'checkout_created payment record blocked');
  else fail('D2', 'checkout_created must block');

  section('E. Deposit-paid preview');

  const deposit = await runGuestConfirmationPreviewDryRun(
    {
      booking_code: 'WH-G27-PREVIEW',
      language_hint: 'en',
      confirmation_draft: buildDepositDraft(),
    },
    { use_fixture_pg: true },
  );

  if (deposit.confirmation_preview_ready === true) pass('E1', 'deposit preview ready');
  else fail('E1', `deposit not ready: ${(deposit.block_reasons || []).join(',')}`);

  const msg = deposit.proposed_confirmation_message || '';
  if (msg.includes(GATE_CODE)) pass('E2', 'message includes gate code 2684#');
  else fail('E2', 'gate code 2684# missing');

  if (/MB-01|Room:/i.test(msg)) pass('E3', 'message includes room label/number');
  else fail('E3', 'room label/number missing');

  if (!messageHasBedLeak(msg)) pass('E4', 'message excludes bed number');
  else fail('E4', 'bed number leak');

  if (/cash|bank transfer|Stripe/i.test(msg)) {
    pass('E5', 'deposit message mentions balance/on-arrival payment options');
  } else {
    fail('E5', 'deposit must mention cash/bank/Stripe on arrival');
  }

  if (!/\bhold expires?\b/i.test(msg)) pass('E6', 'no hold expiry copy');
  else fail('E6', 'hold expiry must not appear');

  if (/luna|wolfhouse/i.test(msg)) pass('E7', 'identifies as Luna/Wolfhouse');
  else fail('E7', 'Luna/Wolfhouse identity missing');

  section('F. Full-paid preview');

  const full = await runGuestConfirmationPreviewDryRun(
    {
      booking_code: 'WH-G27-FULL',
      payment_status: 'paid',
      confirmation_draft: buildFullPaidDraft(),
    },
    { use_fixture_pg: true },
  );

  if (full.confirmation_preview_ready === true) pass('F1', 'full paid preview ready');
  else fail('F1', `full paid not ready: ${(full.block_reasons || []).join(',')}`);

  const fullMsg = full.proposed_confirmation_message || '';
  if (!/remaining balance|balance due|settle the remaining/i.test(fullMsg)) {
    pass('F2', 'full paid does not ask for balance');
  } else {
    fail('F2', 'full paid must not ask for balance');
  }

  section('G. Output shape and safety');

  const keys = [
    'confirmation_preview_attempted',
    'confirmation_preview_ready',
    'booking_code',
    'payment_status',
    'balance_due_cents',
    'proposed_confirmation_message',
    'confirmation_send_allowed',
    'sends_whatsapp',
    'live_send_blocked',
    'next_safe_step',
  ];

  for (const key of keys) {
    if (key in deposit) pass(`G.${key}`, `output has ${key}`);
    else fail(`G.${key}`, `missing ${key}`);
  }

  if (deposit.confirmation_send_allowed === false
      && deposit.sends_whatsapp === false
      && deposit.live_send_blocked === true) {
    pass('G.safety', 'safety flags correct on success');
  } else {
    fail('G.safety', 'safety flags must block send');
  }

  if (deposit.next_safe_step === 'ready_for_confirmation_send_go_no_go') {
    pass('G.next', 'ready_for_confirmation_send_go_no_go after ready preview');
  } else {
    fail('G.next', `unexpected next_safe_step ${deposit.next_safe_step}`);
  }

  if (unpaid.next_safe_step === 'staff_review_confirmation') {
    pass('G.next_blocked', 'staff_review_confirmation when blocked');
  } else {
    fail('G.next_blocked', 'blocked should staff_review_confirmation');
  }

  section('H. Handoff — missing room');

  const noRoom = await runGuestConfirmationPreviewDryRun(
    {
      booking_code: 'WH-G27-NOROOM',
      confirmation_draft: buildDepositDraft({ room_number: '' }),
    },
    { use_fixture_pg: true },
  );

  if (!noRoom.confirmation_preview_ready && noRoom.block_reasons.includes('missing_room_number_or_label')) {
    pass('H1', 'missing room triggers handoff');
  } else {
    fail('H1', 'must handoff when room missing');
  }

  section('I. Source hygiene');

  const forbidden = [
    ['I.whatsapp', /graph\.facebook\.com|sendWhatsApp|whatsapp\.send/i],
    ['I.n8n', /fetch\s*\([^)]*n8n|activateWorkflow/i],
    ['I.send', /sendLunaBookingConfirmation|confirmation_sent_at\s*=|updates_confirmation_sent_at:\s*true/i],
    ['I.stripe', /stripe\.checkout|STRIPE_SECRET|checkout\.sessions/i],
  ];
  for (const [id, re] of forbidden) {
    if (!re.test(previewSrc)) pass(id, 'module source clean');
    else fail(id, 'forbidden pattern in module');
  }

  if (!/status\s*=\s*'confirmed'/i.test(previewSrc)) {
    pass('I.no_confirm_write', 'does not mark booking confirmed');
  } else {
    fail('I.no_confirm_write', 'must not write booking confirmed');
  }

  section('J. Unit helpers');

  const lunaMsg = ensureLunaIdentity('Your booking is ready.');
  if (/Luna from Wolfhouse/i.test(lunaMsg)) pass('J1', 'ensureLunaIdentity prepends Luna');
  else fail('J1', 'Luna identity helper');

  const arrivalMsg = appendDepositBalanceArrivalOptions('Hello', 50000, 'en');
  if (/cash|bank transfer|Stripe/i.test(arrivalMsg)) pass('J2', 'arrival options helper');
  else fail('J2', 'arrival options helper');

  const sanitized = sanitizePreviewMessage('Hi there', 'deposit_paid', 80000, 'en');
  if (/cash|bank transfer|Stripe/i.test(sanitized)) pass('J3', 'sanitize adds arrival options for deposit');
  else fail('J3', 'sanitize deposit balance');

  section('K. PREVIEW_SAFETY constants');

  for (const [k, v] of Object.entries(PREVIEW_SAFETY)) {
    if (deposit[k] === v) pass(`K.${k}`, `${k}=${v}`);
    else fail(`K.${k}`, `expected ${k}=${v} on success`);
  }

  section('L. Doc files');

  if (fs.existsSync(DOC)) pass('L1', 'STAGE-27Q doc exists');
  else fail('L1', 'missing STAGE-27Q doc');

  const docText = fs.readFileSync(DOC, 'utf8');
  if (docText.includes('runGuestConfirmationPreviewDryRun')) pass('L2', 'doc names function');
  else fail('L2', 'doc must name function');

  if (docText.includes('confirmation_draft') && docText.includes('27p')) {
    pass('L3', 'doc references 27p confirmation_draft source');
  } else {
    fail('L3', 'doc must reference 27p draft source');
  }

  if (docText.includes('go/no-go') || docText.includes('go-no-go')) {
    pass('L4', 'doc references send go/no-go next step');
  } else {
    fail('L4', 'doc should reference send go/no-go');
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FAIL — verifier error:', e.message, e.stack);
  process.exit(1);
});
