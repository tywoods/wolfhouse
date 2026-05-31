'use strict';
/**
 * Stage 5.3f — Confirmation-needed query proof runner (READ-ONLY).
 *
 * Runs getConfirmationNeededQuery() against wolfhouse-somo and prints
 * fixture phone rows for Stage 5.3f (34600000156).
 *
 * Usage:
 *   node scripts/verify-stage53f-confirmation-needed-proof.js
 *   EXPECT_FIXTURE_ROWS=0 node scripts/verify-stage53f-confirmation-needed-proof.js
 *   EXPECT_FIXTURE_ROWS=1 node scripts/verify-stage53f-confirmation-needed-proof.js
 *
 * Safe to run at any time — does NOT mutate the database.
 */

const { Client } = require('pg');
const { getConfirmationNeededQuery, CLIENT_SLUG } = require('./lib/staff-payment-queries');

const PG_URL =
  process.env.WOLFHOUSE_DATABASE_URL ||
  'postgres://wolfhouse:oGFMhl9w59Ym4Gf@localhost:5433/wolfhouse';

const FIXTURE_PHONES = ['34600000156', '+34600000156'];
const FIXTURE_BOOKING_CODE = 'WH-53-CONFIRM-001';

function isFixture(row) {
  return (
    FIXTURE_PHONES.includes(String(row.phone || '')) ||
    row.booking_code === FIXTURE_BOOKING_CODE
  );
}

async function main() {
  console.log('Stage 5.3f — Confirmation-needed query proof (READ-ONLY)');
  console.log(`Client: ${CLIENT_SLUG}`);
  console.log(`Query: getConfirmationNeededQuery()`);
  console.log(`Fixture phone: ${FIXTURE_PHONES.join(' / ')}`);
  console.log(`Fixture booking_code: ${FIXTURE_BOOKING_CODE}`);

  const c = new Client({ connectionString: PG_URL });
  await c.connect();
  const { rows } = await c.query(getConfirmationNeededQuery(), [CLIENT_SLUG]);
  await c.end();

  const fixtureRows = rows.filter(isFixture);

  console.log(`\n── F — Paid, needs confirmation ──`);
  console.log(`   Total rows: ${rows.length}`);
  console.log(`   Fixture rows: ${fixtureRows.length}`);

  if (fixtureRows.length > 0) {
    for (const r of fixtureRows) {
      console.log(
        `   [FIXTURE] booking_code=${r.booking_code} phone=${r.phone}` +
          ` payment_status=${r.payment_status}` +
          ` send_confirmation=${r.send_confirmation}` +
          ` confirmation_sent_at=${r.confirmation_sent_at ?? 'NULL'}`
      );
    }
  } else {
    console.log('   (no fixture-phone rows)');
  }

  const expectRaw = process.env.EXPECT_FIXTURE_ROWS;
  if (expectRaw !== undefined && expectRaw !== '') {
    const expected = Number(expectRaw);
    if (Number.isNaN(expected)) {
      console.error(`\nFAIL: EXPECT_FIXTURE_ROWS must be a number, got "${expectRaw}"`);
      process.exit(1);
    }
    if (fixtureRows.length !== expected) {
      console.error(
        `\nFAIL: expected ${expected} fixture row(s), got ${fixtureRows.length}`
      );
      process.exit(1);
    }
    if (expected === 1) {
      const r = fixtureRows[0];
      const checks = [
        [r.booking_code === FIXTURE_BOOKING_CODE, `booking_code=${r.booking_code}`],
        [FIXTURE_PHONES.includes(String(r.phone || '')), `phone=${r.phone}`],
        [r.payment_status === 'deposit_paid' || r.payment_status === 'paid', `payment_status=${r.payment_status}`],
        [r.send_confirmation === true, `send_confirmation=${r.send_confirmation}`],
        [r.confirmation_sent_at == null, `confirmation_sent_at=${r.confirmation_sent_at}`],
      ];
      for (const [ok, label] of checks) {
        if (!ok) {
          console.error(`\nFAIL: fixture row field check failed: ${label}`);
          process.exit(1);
        }
      }
    }
    console.log(`\nOK: fixture row count matches EXPECT_FIXTURE_ROWS=${expected}`);
  }

  console.log('\n── Stage 5.3f proof summary ──');
  console.log(`   Query F fixture rows: ${fixtureRows.length} (expect 1 after seed, 0 after cleanup)`);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
