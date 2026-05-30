'use strict';
/**
 * Stage 5.3d — Payment proof runner (READ-ONLY).
 *
 * Runs the payment_balances helper and all six staff payment queries against
 * wolfhouse-somo and prints fixture phone rows. Use before/after the 5.3d
 * runtime gate to prove the fixture booking and payments row appear/disappear.
 *
 * Usage:
 *   node scripts/verify-stage53d-payment-proof.js
 *
 * Safe to run at any time — does NOT mutate the database.
 */

const { Client } = require('pg');
const { getPaymentBalancesQuery, CLIENT_SLUG } = require('./lib/payment-balances-query');
const {
  getDepositPaidQuery,
  getFullyPaidQuery,
  getBalanceDueQuery,
  getNoPaymentRecordQuery,
  getWaitingPaymentQuery,
  getConfirmationNeededQuery,
} = require('./lib/staff-payment-queries');

const PG_URL =
  process.env.WOLFHOUSE_DATABASE_URL ||
  'postgres://wolfhouse:oGFMhl9w59Ym4Gf@localhost:5433/wolfhouse';

const FIXTURE_PHONES = ['34600000155', '+34600000155'];

function isFixture(row) {
  return FIXTURE_PHONES.includes(String(row.phone || ''));
}

function printSection(label, rows) {
  const fixture = rows.filter(isFixture);
  console.log(`\n── ${label} ──`);
  console.log(`   Rows: ${rows.length}`);
  if (fixture.length > 0) {
    for (const r of fixture) {
      console.log(
        `   [FIXTURE] booking_code=${r.booking_code} phone=${r.phone}` +
          ` status=${r.booking_payment_status || r.payment_status || r.booking_status || '?'}` +
          ` amount_paid=${r.amount_paid_cents ?? '?'}` +
          ` balance_due=${r.balance_due_cents ?? r.computed_balance_due_cents ?? '?'}` +
          ` send_confirmation=${r.send_confirmation ?? '?'}`
      );
    }
  } else {
    console.log(`   (no fixture-phone rows)`);
  }
  return fixture.length;
}

async function main() {
  console.log('Stage 5.3d — Payment proof runner (READ-ONLY)');
  console.log(`Client: ${CLIENT_SLUG}`);

  const c = new Client({ connectionString: PG_URL });
  await c.connect();

  const [balances, depositPaid, fullyPaid, balanceDue, noPayment, waiting, confirmNeeded] =
    await Promise.all([
      c.query(getPaymentBalancesQuery(), [CLIENT_SLUG]),
      c.query(getDepositPaidQuery(), [CLIENT_SLUG]),
      c.query(getFullyPaidQuery(), [CLIENT_SLUG]),
      c.query(getBalanceDueQuery(), [CLIENT_SLUG]),
      c.query(getNoPaymentRecordQuery(), [CLIENT_SLUG]),
      c.query(getWaitingPaymentQuery(), [CLIENT_SLUG]),
      c.query(getConfirmationNeededQuery(), [CLIENT_SLUG]),
    ]);

  await c.end();

  const fBalances = printSection('Payment balances (payment_pending + confirmed)', balances.rows);
  const fDeposit = printSection('A — Deposit paid (owes balance)', depositPaid.rows);
  const fFull = printSection('B — Fully paid', fullyPaid.rows);
  const fBalance = printSection('C — Balance due', balanceDue.rows);
  const fNoPayment = printSection('D — payment_pending, no payments row', noPayment.rows);
  const fWaiting = printSection('E — Waiting payment (link sent, not confirmed)', waiting.rows);
  const fConfirm = printSection('F — Paid, needs confirmation', confirmNeeded.rows);

  console.log('\n── Stage 5.3d proof summary ──');
  console.log(`   Balance view fixture rows:    ${fBalances} (expect 1 after seed/gate, 0 after cleanup)`);
  console.log(`   Query A fixture rows:          ${fDeposit} (expect 0 — fixture stays at waiting_payment)`);
  console.log(`   Query B fixture rows:          ${fFull}   (expect 0 — fixture not fully paid)`);
  console.log(`   Query C fixture rows:          ${fBalance} (expect 0 — no amount_paid yet)`);
  console.log(`   Query D fixture rows:          ${fNoPayment} (expect 0 — seed includes payments row)`);
  console.log(`   Query E fixture rows:          ${fWaiting} (expect 1 after seed, 0 after cleanup)`);
  console.log(`   Query F fixture rows:          ${fConfirm} (expect 1 after webhook replay, 0 after cleanup)`);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
