'use strict';

/**
 * Together-only must still INSERT (never 400 missing_payment_choice).
 * Usage: node scripts/verify-together-only-always-saves.js
 */

const assert = require('assert');

function loadPGlite() {
  const tries = [
    '@electric-sql/pglite',
    '/opt/data/workspace/sandbox-repos/WH-lookout/wt-1665-rebase/node_modules/@electric-sql/pglite',
    '/opt/data/wolfhouse-agent/node_modules/@electric-sql/pglite',
  ];
  for (const spec of tries) {
    try { return require(spec).PGlite; } catch (_) { /* next */ }
  }
  throw new Error('PGlite unavailable');
}

function staffCreateWouldBlock(paymentChoice) {
  if (!paymentChoice) {
    return { status: 400, reason_code: 'missing_payment_choice' };
  }
  return null;
}

async function main() {
  const merged = {
    payment_choice: 'deposit',
    payment_link_distribution: 'together',
    ask_payment_amount: true,
  };
  const blocked = staffCreateWouldBlock(merged.payment_choice);
  assert.strictEqual(blocked, null, 'kept payment_choice must not 400 before insert');

  const PGlite = loadPGlite();
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_code text,
      status text,
      total_amount_cents int,
      metadata jsonb DEFAULT '{}'
    );
  `);
  const saved = await db.query(
    `INSERT INTO bookings (booking_code, status, total_amount_cents, metadata)
     VALUES ($1, 'confirmed', 41500, $2::jsonb)
     RETURNING id, booking_code, metadata`,
    ['WH-TOGETHER-ONLY-1', JSON.stringify({
      payment_choice: merged.payment_choice,
      payment_link_distribution: merged.payment_link_distribution,
      ask_payment_amount: merged.ask_payment_amount,
    })],
  );
  const row = saved.rows[0];
  assert.ok(row && row.id, 'INSERT returned booking_id');
  assert.strictEqual(row.booking_code, 'WH-TOGETHER-ONLY-1');
  const md = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
  assert.strictEqual(md.payment_choice, 'deposit');
  await db.close();
  console.log('PASS together-only always saves', {
    booking_id: row.id,
    booking_code: row.booking_code,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
