/**
 * Stage 27p — Stripe payment truth verifier.
 *
 * Usage:
 *   npm run verify:stage27p-stripe-payment-truth
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const TRUTH_MOD = path.join(__dirname, 'lib', 'luna-guest-stripe-payment-truth-apply.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27P-STRIPE-PAYMENT-TRUTH.md');
const SCRIPT = 'verify:stage27p-stripe-payment-truth';

const {
  runGuestStripePaymentTruthApplyApproved,
  shouldAllowGuestStripePaymentTruthApply,
  isGuestStripePaymentTruthEnvironment,
  confirmPaymentTruthApproved,
  validatePaymentForTruth,
  ELIGIBLE_PAYMENT_STATUSES,
  REUSED_WEBHOOK_PATH,
  TRUTH_SAFETY,
} = require('./lib/luna-guest-stripe-payment-truth-apply');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const FORBIDDEN_NOTICE_RE = /\b(?:booking is confirmed|confirmed your booking|payment link is ready|sent you (?:a )?link|link sent to guest)\b/i;

const stagingEnv = { NODE_ENV: 'development', STRIPE_WEBHOOK_SKIP_VERIFY: 'true' };
const prodEnv = { NODE_ENV: 'production' };

const MOCK_PAYMENT_ID = '00000000-0000-4000-8000-000000000099';
const MOCK_SESSION_ID = 'cs_test_stage27p_mock';
const MOCK_AMOUNT = 20000;

function buildMockSession(overrides) {
  return {
    id: MOCK_SESSION_ID,
    livemode: false,
    currency: 'eur',
    amount_total: MOCK_AMOUNT,
    payment_intent: 'pi_test_mock',
    metadata: { payment_id: MOCK_PAYMENT_ID, booking_id: 'bk-mock', source: 'luna_guest_stage27o' },
    ...overrides,
  };
}

function buildMockEvent(session) {
  return {
    id: 'evt_test_stage27p',
    type: 'checkout.session.completed',
    livemode: false,
    data: { object: session || buildMockSession() },
  };
}

function buildMockPaymentRow(overrides) {
  return {
    payment_id: MOCK_PAYMENT_ID,
    booking_id: '00000000-0000-4000-8000-000000000001',
    booking_code: 'WH-G27-MOCK',
    payment_status: 'checkout_created',
    payment_kind: 'deposit_only',
    currency: 'EUR',
    amount_due_cents: MOCK_AMOUNT,
    pm_amount_paid: 0,
    stripe_checkout_session_id: MOCK_SESSION_ID,
    bk_total: 100000,
    bk_amount_paid: 0,
    bk_balance: 100000,
    bk_deposit: MOCK_AMOUNT,
    booking_status: 'hold',
    hold_expires_at: new Date(Date.now() + 3600000).toISOString(),
    guest_name: 'Test Guest',
    primary_room_code: 'MB-01',
    client_slug: 'wolfhouse-somo',
    ...overrides,
  };
}

console.log('\nverify-stage27p-stripe-payment-truth.js  (Stage 27p)\n');

try {
  execSync(`node --check "${TRUTH_MOD}"`, { stdio: 'pipe' });
  pass('0a', 'payment truth module passes node --check');
} catch {
  fail('0a', 'module syntax error');
}

const apiSrc = fs.readFileSync(API, 'utf8');
const truthSrc = fs.readFileSync(TRUTH_MOD, 'utf8');
const webhookStart = apiSrc.indexOf('async function handleStripeWebhook(');
const webhookEnd = webhookStart > -1 ? apiSrc.indexOf('\n// Route: POST /staff/payments/', webhookStart) : -1;
const webhookBlock = webhookStart > -1
  ? apiSrc.slice(webhookStart, webhookEnd > 0 ? webhookEnd : webhookStart + 15000)
  : '';

section('A. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('A1', `${SCRIPT} registered`);
else fail('A1', `missing npm script ${SCRIPT}`);

section('B. Reused webhook path reference');

if (truthSrc.includes('handleStripeWebhook')) pass('B1', 'documents reused webhook path');
else fail('B1', 'must reference handleStripeWebhook');

if (truthSrc.includes("paid'::payment_record_status")) pass('B2', 'marks payment paid via existing enum');
else fail('B2', 'must use paid payment_record_status');

if (webhookBlock.includes('checkout.session.completed') && webhookBlock.includes("paid'::payment_record_status")) {
  pass('B3', 'Staff API webhook anchor exists with checkout.session.completed + paid update');
} else {
  fail('B3', 'handleStripeWebhook anchor missing expected patterns');
}

if (REUSED_WEBHOOK_PATH.includes('8.4.11')) pass('B4', 'REUSED_WEBHOOK_PATH names Stage 8.4.11');
else fail('B4', 'REUSED_WEBHOOK_PATH should name 8.4.11');

section('C. Hard gates');

if (!confirmPaymentTruthApproved({})) pass('C1', 'confirm_payment_truth false by default');
else fail('C1', 'confirm should default false');

const noConfirm = shouldAllowGuestStripePaymentTruthApply(
  { payment_draft_id: MOCK_PAYMENT_ID, stripe_session: buildMockSession() },
  { env: stagingEnv },
);
if (!noConfirm.allowed && noConfirm.reasons.includes('confirm_payment_truth_required')) {
  pass('C2', 'confirm_payment_truth required');
} else {
  fail('C2', 'missing confirm_payment_truth gate');
}

const withConfirm = shouldAllowGuestStripePaymentTruthApply(
  { payment_draft_id: MOCK_PAYMENT_ID, stripe_session: buildMockSession() },
  { env: stagingEnv, confirm_payment_truth: true },
);
if (withConfirm.allowed) pass('C3', 'staging + confirm + session passes gates');
else fail('C3', `gates failed: ${withConfirm.reasons.join(',')}`);

if (!isGuestStripePaymentTruthEnvironment(prodEnv)) pass('C4', 'production blocked');
else fail('C4', 'production must be blocked');

const liveSession = shouldAllowGuestStripePaymentTruthApply(
  { payment_draft_id: MOCK_PAYMENT_ID, stripe_session: buildMockSession({ livemode: true }) },
  { env: stagingEnv, confirm_payment_truth: true },
);
if (!liveSession.allowed && liveSession.reasons.includes('stripe_test_mode_required')) {
  pass('C5', 'livemode session blocked');
} else {
  fail('C5', 'livemode must be blocked');
}

section('D. Payment/session matching validation');

const pm = buildMockPaymentRow();
const session = buildMockSession();
if (validatePaymentForTruth(pm, session, {}).length === 0) {
  pass('D1', 'valid checkout_created + matching session passes');
} else {
  fail('D1', 'valid row should pass validation');
}

const amountMismatch = validatePaymentForTruth(pm, buildMockSession({ amount_total: 19999 }), {});
if (amountMismatch.includes('stripe_amount_mismatch')) {
  pass('D2', 'amount mismatch blocked');
} else {
  fail('D2', 'must block amount mismatch');
}

const sessionMismatch = validatePaymentForTruth(pm, buildMockSession({ id: 'cs_test_other' }), {});
if (sessionMismatch.includes('stripe_session_id_mismatch')) {
  pass('D3', 'session id mismatch blocked');
} else {
  fail('D3', 'must block session id mismatch');
}

const wrongStatus = validatePaymentForTruth(buildMockPaymentRow({ payment_status: 'draft' }), session, {});
if (wrongStatus.some((r) => r.includes('not_eligible'))) {
  pass('D4', 'draft status not eligible');
} else {
  fail('D4', 'draft must not be eligible');
}

if (ELIGIBLE_PAYMENT_STATUSES.includes('checkout_created')) {
  pass('D5', 'checkout_created is eligible');
} else {
  fail('D5', 'checkout_created should be eligible');
}

section('E. Blocked without confirm');

(async () => {
  const blocked = await runGuestStripePaymentTruthApplyApproved(
    { payment_draft_id: MOCK_PAYMENT_ID, stripe_session: buildMockSession() },
    { env: stagingEnv },
  );

  if (blocked.payment_truth_attempted === false && blocked.payment_truth_recorded === false) {
    pass('E1', 'no truth attempt without confirm');
  } else {
    fail('E1', 'must not attempt without confirm');
  }

  if (blocked.next_safe_step === 'awaiting_payment_truth') {
    pass('E2', 'blocked stays awaiting_payment_truth');
  } else {
    fail('E2', 'blocked next_safe_step should be awaiting_payment_truth');
  }

  section('F. Production blocked');

  const prodBlocked = await runGuestStripePaymentTruthApplyApproved(
    { payment_draft_id: MOCK_PAYMENT_ID, stripe_event: buildMockEvent() },
    { env: prodEnv, confirm_payment_truth: true },
  );

  if (prodBlocked.payment_truth_attempted === false) pass('F1', 'production blocks truth apply');
  else fail('F1', 'production must block');

  section('G. Output shape');

  const keys = [
    'payment_truth_attempted',
    'payment_truth_recorded',
    'payment_status',
    'booking_id',
    'booking_code',
    'amount_paid_cents',
    'balance_due_cents',
    'stripe_checkout_session_id',
    'idempotent_replay',
    'next_safe_step',
    'sends_whatsapp',
    'live_send_blocked',
    'confirmation_sent',
  ];
  for (const key of keys) {
    if (key in blocked) pass(`G.${key}`, `output has ${key}`);
    else fail(`G.${key}`, `missing ${key}`);
  }

  if (blocked.confirmation_sent === false && blocked.sends_whatsapp === false) {
    pass('G.no_send', 'no confirmation or WhatsApp send flags');
  } else {
    fail('G.no_send', 'must block confirmation and WhatsApp');
  }

  section('H. Idempotent replay (mock pg)');

  const idempotentPg = {
    queries: [],
    async query(sql, params) {
      this.queries.push(sql);
      if (/FROM payments p/.test(sql)) {
        return { rows: [buildMockPaymentRow({ payment_status: 'paid', pm_amount_paid: MOCK_AMOUNT })] };
      }
      throw new Error('unexpected query in idempotent mock');
    },
  };

  const replay = await runGuestStripePaymentTruthApplyApproved(
    { payment_draft_id: MOCK_PAYMENT_ID, stripe_event: buildMockEvent() },
    { env: stagingEnv, confirm_payment_truth: true, pg: idempotentPg },
  );

  if (replay.idempotent_replay === true && replay.payment_truth_recorded === true) {
    pass('H1', 'idempotent replay when already paid');
  } else {
    fail('H1', 'expected idempotent replay');
  }

  if (replay.next_safe_step === 'ready_for_confirmation_dry_run') {
    pass('H2', 'ready_for_confirmation_dry_run after idempotent replay');
  } else {
    fail('H2', `unexpected next_safe_step ${replay.next_safe_step}`);
  }

  if (idempotentPg.queries.every((q) => !/UPDATE payments/.test(q))) {
    pass('H3', 'idempotent replay skips payment UPDATE');
  } else {
    fail('H3', 'must not double-count on replay');
  }

  section('I. Apply truth (mock pg transaction)');

  let applyState = buildMockPaymentRow();
  const applyPg = {
    async query(sql, params) {
      if (/FROM payments p/.test(sql)) {
        return { rows: [{ ...applyState }] };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (/UPDATE payments/.test(sql)) {
        applyState = {
          ...applyState,
          payment_status: 'paid',
          pm_amount_paid: params[0],
        };
        return { rowCount: 1 };
      }
      if (/UPDATE bookings/.test(sql)) {
        return { rowCount: 1 };
      }
      throw new Error(`unexpected apply query: ${sql.slice(0, 60)}`);
    },
  };

  const applied = await runGuestStripePaymentTruthApplyApproved(
    { payment_draft_id: MOCK_PAYMENT_ID, stripe_event: buildMockEvent() },
    { env: stagingEnv, confirm_payment_truth: true, pg: applyPg },
  );

  if (applied.payment_truth_recorded === true && applied.idempotent_replay === false) {
    pass('I1', 'payment truth recorded on first apply');
  } else {
    fail('I1', 'expected truth recorded');
  }

  if (applied.payment_status === 'paid' && applied.amount_paid_cents === MOCK_AMOUNT) {
    pass('I2', 'payment marked paid with correct amount');
  } else {
    fail('I2', 'payment status/amount incorrect');
  }

  if (applied.next_safe_step === 'ready_for_confirmation_dry_run') {
    pass('I3', 'ready_for_confirmation_dry_run after truth apply');
  } else {
    fail('I3', `unexpected next_safe_step ${applied.next_safe_step}`);
  }

  section('J. Source hygiene');

  const forbidden = [
    ['J.whatsapp', /graph\.facebook\.com|sendWhatsApp|whatsapp\.send/i],
    ['J.n8n', /fetch\s*\([^)]*n8n|activateWorkflow/i],
    ['J.confirm_send', /sendConfirmation|confirmation_sent:\s*true|sends_whatsapp:\s*true/i],
    ['J.live_send', /live_send:\s*true/i],
  ];
  for (const [id, re] of forbidden) {
    if (!re.test(truthSrc)) pass(id, 'module source clean');
    else fail(id, 'forbidden pattern in module');
  }

  if (!/status\s*=\s*'confirmed'/i.test(truthSrc)) {
    pass('J.no_booking_confirm', 'does not set booking status confirmed');
  } else {
    fail('J.no_booking_confirm', 'must not confirm booking status');
  }

  if (!/INSERT INTO payments/i.test(truthSrc)) {
    pass('J.no_second_payment', 'does not create second payment record');
  } else {
    fail('J.no_second_payment', 'must not insert new payment');
  }

  section('K. Staff notice safety');

  for (const r of [blocked, prodBlocked, replay, applied]) {
    const notice = r.staff_notice || '';
    if (!FORBIDDEN_NOTICE_RE.test(notice)) {
      pass(`K.${r.idempotent_replay ? 'replay' : r.payment_truth_recorded ? 'applied' : 'blocked'}`, 'staff_notice safe');
    } else {
      fail('K.notice', `forbidden notice: ${notice.slice(0, 80)}`);
    }
  }

  section('L. TRUTH_SAFETY constants');

  for (const [k, v] of Object.entries(TRUTH_SAFETY)) {
    if (blocked[k] === v) pass(`L.${k}`, `${k}=${v}`);
    else fail(`L.${k}`, `expected ${k}=${v}`);
  }

  section('M. Doc files');

  if (fs.existsSync(DOC)) pass('M1', 'STAGE-27P doc exists');
  else fail('M1', 'missing STAGE-27P doc');

  const docText = fs.readFileSync(DOC, 'utf8');
  if (docText.includes('runGuestStripePaymentTruthApplyApproved')) pass('M2', 'doc names function');
  else fail('M2', 'doc must name function');

  if (docText.includes('handleStripeWebhook') && docText.includes('idempotent')) {
    pass('M3', 'doc covers reused path and idempotency');
  } else {
    fail('M3', 'doc missing reused path or idempotency');
  }

  if (docText.includes('ready_for_confirmation_dry_run')) pass('M4', 'doc references next slice');
  else fail('M4', 'doc should reference confirmation dry-run next slice');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FAIL — verifier error:', e.message);
  process.exit(1);
});
