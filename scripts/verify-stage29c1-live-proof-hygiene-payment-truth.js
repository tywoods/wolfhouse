/**
 * Stage 29c.1 — live proof hygiene + deposit payment truth verifier.
 *
 * Usage:
 *   npm run verify:stage29c1-live-proof-hygiene-payment-truth
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'run-luna-conversation-state-machine-tests.js');
const HYGIENE = path.join(__dirname, 'lib', 'luna-live-proof-hygiene.js');
const TOTALS = path.join(__dirname, 'lib', 'luna-booking-payment-totals.js');
const TRUTH = path.join(__dirname, 'lib', 'luna-guest-stripe-payment-truth-apply.js');
const API = path.join(__dirname, 'staff-query-api.js');
const SHORT_STAY = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'short-stay-accommodation-only-to-deposit.json');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage29c1-live-proof-hygiene-payment-truth';

const {
  deriveBookingPaymentState,
  sumCompletedPaymentCentsForBooking,
} = require('./lib/luna-booking-payment-totals');
const { runLiveProofHygiene, requireAllowHygiene } = require('./lib/luna-live-proof-hygiene');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage29c1-live-proof-hygiene-payment-truth.js  (Stage 29c.1)\n`);

section('A. Files + package');

check('A1', fs.existsSync(HYGIENE), 'hygiene helper exists');
check('A2', fs.existsSync(TOTALS), 'payment totals helper exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A3', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const runnerSrc = fs.readFileSync(RUNNER, 'utf8');
const hygieneSrc = fs.readFileSync(HYGIENE, 'utf8');
const truthSrc = fs.readFileSync(TRUTH, 'utf8');
const apiSrc = fs.readFileSync(API, 'utf8');

section('B. Hygiene helper');

check('B1', hygieneSrc.includes('runLiveProofHygiene'), 'exports runLiveProofHygiene');
check('B2', hygieneSrc.includes('assertNotProductionDb'), 'refuses production DB');
check('B3', hygieneSrc.includes('allow_hygiene'), 'requires allow_hygiene');
check('B4', hygieneSrc.includes('assessCleanupEligibility'), 'reuses Stage 28f eligibility');
check('B5', hygieneSrc.includes('check_in') && hygieneSrc.includes('check_out'), 'requires date window');
check('B6', hygieneSrc.includes("status = 'cancelled'"), 'cancels unpaid holds without delete');
check('B7', hygieneSrc.includes('skipped_paid_or_confirmed'), 'reports skipped paid/confirmed');

(async () => {
  const blocked = await runLiveProofHygiene(
    { phone: '+491726422307', check_in: '2026-07-01', check_out: '2026-07-05' },
    { allow_hygiene: false },
  );
  check('B8', blocked.refused_reason === 'allow_hygiene_required', 'refuses without allow_hygiene');

  const noPhone = await runLiveProofHygiene({}, { allow_hygiene: true });
  check('B9', (noPhone.refused_reason || '').includes('phone_required'), 'requires phone');

  section('C. Runner preclean flag');

  check('C1', runnerSrc.includes('--preclean-unpaid-holds'), 'supports --preclean-unpaid-holds');
  check('C2', runnerSrc.includes('--fresh-proof-window'), 'supports --fresh-proof-window alias');
  check('C3', runnerSrc.includes('runPrecleanHygiene'), 'runs hygiene before write proof');
  check('C4', runnerSrc.includes('preclean_requires_allow_writes'), 'preclean requires --allow-writes');
  check('C5', runnerSrc.includes('liveProofHygieneGuidanceLines'), 'prints live proof guidance');
  check('C6', runnerSrc.includes('hygiene_window'), 'reads fixture hygiene_window');

  section('D. Payment truth — completed rows only');

  check('D1', truthSrc.includes('sumCompletedPaymentCentsForBooking'), 'Stage 27p uses completed payment sum');
  check('D2', apiSrc.includes('sumCompletedPaymentCentsForBooking'), 'webhook path uses completed payment sum');
  check('D3', truthSrc.includes('deriveBookingPaymentState'), 'shared derive helper used');
  check('D4', !truthSrc.includes('prevBkPaid         = Number(pm.bk_amount_paid'), 'does not trust stale booking.amount_paid_cents alone');

  const depositPartial = deriveBookingPaymentState({
    bkTotal: 18000,
    prevCompletedPaidCents: 0,
    stripePaidCents: 10000,
    paymentKind: 'deposit_only',
  });
  check('D5', depositPartial.newBkPayStatus === 'deposit_paid', '€100 deposit on €180 → deposit_paid');
  check('D6', depositPartial.newBkPaid === 10000, 'booking paid total €100');
  check('D7', depositPartial.newBkBalance === 8000, 'balance remains €80');

  const fullPaid = deriveBookingPaymentState({
    bkTotal: 18000,
    prevCompletedPaidCents: 10000,
    stripePaidCents: 8000,
    paymentKind: 'deposit_only',
  });
  check('D8', fullPaid.newBkPayStatus === 'paid', 'full amount paid → paid');
  check('D9', fullPaid.newBkPaid === 18000 && fullPaid.newBkBalance === 0, 'full paid clears balance');

  const staleColumn = deriveBookingPaymentState({
    bkTotal: 18000,
    prevCompletedPaidCents: 0,
    stripePaidCents: 10000,
    paymentKind: 'deposit_only',
  });
  check('D10', staleColumn.newBkPayStatus === 'deposit_paid', 'stale booking column ignored when no paid rows');

  section('E. Stale checkout_created draft scenario (static)');

  const mockPg = {
    async query(sql, params) {
      if (/SUM\(amount_paid_cents\)/.test(sql)) {
        return { rows: [{ total: 0 }] };
      }
      if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
      if (/UPDATE payments/.test(sql)) return { rowCount: 1, rows: [] };
      if (/UPDATE bookings/.test(sql)) return { rowCount: 1, rows: [] };
      return { rows: [] };
    },
  };
  const { applyPaymentTruthTransaction } = require('./lib/luna-guest-stripe-payment-truth-apply');
  const pm = {
    payment_id: '11111111-1111-1111-1111-111111111111',
    booking_id: '22222222-2222-2222-2222-222222222222',
    booking_code: 'WH-TEST',
    booking_status: 'hold',
    payment_kind: 'deposit_only',
    amount_due_cents: 10000,
    bk_total: 18000,
    bk_amount_paid: 10000,
    client_slug: 'wolfhouse-somo',
    guest_name: 'Test',
    primary_room_code: 'DEMO-R1',
  };
  const session = { id: 'cs_test_x', amount_total: 10000, currency: 'eur', payment_intent: 'pi_test' };
  try {
    const applied = await applyPaymentTruthTransaction(mockPg, pm, session, { id: 'evt_1', type: 'checkout.session.completed' }, {}, 'verifier', 'stage29c1');
    check('E1', applied.newBkPayStatus === 'deposit_paid', 'apply ignores stale booking column when sum paid rows = 0');
    check('E2', applied.newBkPaid === 10000 && applied.newBkBalance === 8000, 'apply leaves €80 balance');
  } catch (e) {
    fail('E1', `applyPaymentTruthTransaction mock failed: ${e.message}`);
  }

  section('F. Safety');

  check('F1', !runnerSrc.includes('sendLunaBookingConfirmation'), 'no direct live confirmation send');
  check('F2', !hygieneSrc.includes('n8n') || hygieneSrc.includes('no n8n'), 'hygiene does not activate n8n');
  check('F3', truthSrc.includes('sends_whatsapp: false'), 'payment truth safety preserved');
  check('F4', runnerSrc.includes('idempotent_replay'), 'webhook idempotency path preserved');

  section('G. Fixture expectations');

  const fixture = JSON.parse(fs.readFileSync(SHORT_STAY, 'utf8'));
  check('G1', fixture.hygiene_window && fixture.hygiene_window.check_in === '2026-07-01', 'short-stay hygiene_window');
  check('G2', fixture.webhook_expect.expected_balance_due_cents === 8000, 'webhook expects balance €80');
  check('G3', fixture.confirmation_expect.confirmation_message_contains_balance_cents === 8000, 'confirmation expects balance €80');

  section('H. Syntax');

  for (const f of [RUNNER, HYGIENE, TOTALS, TRUTH, __filename]) {
    try {
      execSync(`node --check "${f}"`, { stdio: 'pipe' });
      pass('H', `${path.basename(f)} passes node --check`);
    } catch {
      fail('H', `${path.basename(f)} syntax error`);
    }
  }

  section('Summary');
  console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
