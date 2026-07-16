'use strict';

/**
 * Optional generic PostgreSQL lock-semantics probe (WB-1 companion).
 *
 * Skips unless WB1_PG_INTEGRATION=1. Uses two independent pool clients and a
 * temporary probe table (created + dropped in the same run). Does not require
 * credentials for the normal no-key gate.
 *
 * This is a miniature lock-order probe only. It does NOT exercise:
 *   - production payments/bookings schema
 *   - applyStripeBookingPaymentTruthWrites
 *   - production ROLLBACK continuity
 *   - full production transaction affinity
 *
 * When DB is available it only shows that PostgreSQL FOR UPDATE can serialize
 * two clients on a shared booking key and support same-row mutate+idempotent
 * interleaving on a simplified probe table.
 *
 * Run:
 *   WB1_PG_INTEGRATION=1 node scripts/verify-waterbottle-locked-payment-pg.js
 */

const { Pool } = require('pg');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function connectionString() {
  return (
    process.env.WOLFHOUSE_DATABASE_URL
    || process.env.DATABASE_URL
    || null
  );
}

async function main() {
  console.log('\nverify:waterbottle-locked-payment-pg (generic PostgreSQL lock-semantics probe)\n');

  if (process.env.WB1_PG_INTEGRATION !== '1') {
    assert('skipped (set WB1_PG_INTEGRATION=1 to enable generic PG lock probe)', true);
    console.log(`\n── verify:waterbottle-locked-payment-pg SKIPPED (pass=${pass}) ──\n`);
    process.exit(0);
  }

  const cs = connectionString();
  if (!cs) {
    assert('WB1_PG_INTEGRATION=1 but no WOLFHOUSE_DATABASE_URL/DATABASE_URL', false);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: cs, max: 4 });
  const clientA = await pool.connect();
  const clientB = await pool.connect();
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const table = `wb1_probe_${suffix}`;

  try {
    await clientA.query(`
      CREATE TABLE ${table} (
        payment_id text PRIMARY KEY,
        booking_id text NOT NULL,
        status text NOT NULL,
        amount_due_cents int NOT NULL,
        amount_paid_cents int NOT NULL DEFAULT 0
      )
    `);
    await clientA.query(
      `INSERT INTO ${table} (payment_id, booking_id, status, amount_due_cents)
       VALUES ('pay-same', 'bk-1', 'checkout_created', 10000),
              ('pay-a', 'bk-2', 'checkout_created', 10000),
              ('pay-b', 'bk-2', 'checkout_created', 40000)`,
    );

    async function applySamePayment(client) {
      await client.query('BEGIN');
      try {
        await client.query(
          `SELECT 1 FROM ${table} WHERE booking_id = $1 FOR UPDATE`,
          ['bk-1'],
        );
        const locked = await client.query(
          `SELECT * FROM ${table} WHERE payment_id = $1 FOR UPDATE`,
          ['pay-same'],
        );
        const row = locked.rows[0];
        if (!row) throw new Error('missing');
        if (row.status === 'paid') {
          await client.query('COMMIT');
          return { already_paid: true };
        }
        await client.query(
          `UPDATE ${table}
              SET status = 'paid', amount_paid_cents = amount_due_cents
            WHERE payment_id = $1`,
          ['pay-same'],
        );
        await client.query('COMMIT');
        return { already_paid: false };
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
      }
    }

    const [r1, r2] = await Promise.all([
      applySamePayment(clientA),
      applySamePayment(clientB),
    ]);
    const mutating = [r1, r2].filter((r) => r && !r.already_paid);
    const idem = [r1, r2].filter((r) => r && r.already_paid);
    assert('PG lock probe same-row: one mutate', mutating.length === 1);
    assert('PG lock probe same-row: one idempotent', idem.length === 1);
    const paid = await clientA.query(`SELECT status, amount_paid_cents FROM ${table} WHERE payment_id = 'pay-same'`);
    assert('PG lock probe same-row: ledger paid once',
      paid.rows[0].status === 'paid' && Number(paid.rows[0].amount_paid_cents) === 10000);

    const order = [];
    async function applyDistinct(client, paymentId, amount, delayMs) {
      await client.query('BEGIN');
      try {
        await client.query(
          `SELECT 1 FROM ${table} WHERE booking_id = $1 FOR UPDATE`,
          ['bk-2'],
        );
        order.push(`lock:${paymentId}`);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const prior = await client.query(
          `SELECT COALESCE(SUM(amount_paid_cents),0)::int AS total
             FROM ${table}
            WHERE booking_id = $1 AND status = 'paid' AND payment_id <> $2`,
          ['bk-2', paymentId],
        );
        order.push(`derive:${paymentId}:${prior.rows[0].total}`);
        await client.query(
          `UPDATE ${table}
              SET status = 'paid', amount_paid_cents = $2
            WHERE payment_id = $1`,
          [paymentId, amount],
        );
        await client.query('COMMIT');
        return Number(prior.rows[0].total);
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
      }
    }

    const [priorA, priorB] = await Promise.all([
      applyDistinct(clientA, 'pay-a', 10000, 40),
      applyDistinct(clientB, 'pay-b', 40000, 0),
    ]);
    const priors = [priorA, priorB].sort((a, b) => a - b);
    assert('PG lock probe distinct: one starts at 0', priors[0] === 0);
    assert('PG lock probe distinct: later sees first', priors[1] === 10000);
    const sum = await clientA.query(
      `SELECT COALESCE(SUM(amount_paid_cents),0)::int AS total FROM ${table} WHERE booking_id = 'bk-2'`,
    );
    assert('PG lock probe distinct: booking total 50000', Number(sum.rows[0].total) === 50000);
    assert('PG lock probe lock order recorded', order.length === 4);
  } finally {
    try {
      await clientA.query(`DROP TABLE IF EXISTS ${table}`);
    } catch (_) { /* ignore */ }
    clientA.release();
    clientB.release();
    await pool.end();
  }

  console.log(`\n── verify:waterbottle-locked-payment-pg ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
