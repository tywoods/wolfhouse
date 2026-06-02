/**
 * Stage 8.6 — Demo data cleanup for Luna Front Desk staging.
 *
 * Removes all records tagged source='stage8_demo' OR booking_code LIKE 'DEMO-%'
 * OR phone IN demo phone list. Deletes in FK-safe order. Verifies 0 demo rows remain.
 *
 * Safety: refuses production DB URLs.
 *
 * Usage:
 *   WOLFHOUSE_DATABASE_URL="postgres://..." node scripts/fixtures/stage8-demo-cleanup.js
 *
 * @module stage8-demo-cleanup
 */

'use strict';

const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', 'infra', '.env') });

const PROD_PATTERNS = [
  /wolfhouse\.com(?!\.(test|local|staging|dev))/i,
  /prod(?:uction)?[\-._]/i,
  /\.prod\./i,
  /rds\.amazonaws\.com/i,
  /database\.windows\.net/i,
];

const DEMO_PHONES  = ['+34999000001', '+34999000002', '+34999000003'];
const DEMO_BOOKING_PREFIX = 'DEMO-%';

function getConnectionString() {
  return (
    process.env.WOLFHOUSE_DATABASE_URL ||
    `postgres://wolfhouse:${process.env.WOLFHOUSE_DB_PASSWORD || ''}@localhost:5433/wolfhouse`
  );
}

function redactUrl(url) {
  return url.replace(/:([^:@]+)@/, ':***@');
}

function assertNotProduction(url) {
  for (const pat of PROD_PATTERNS) {
    if (pat.test(url)) {
      console.error(`\n✗ SAFETY: Matches production pattern (${pat}). Refusing cleanup.\n  URL: ${redactUrl(url)}\n`);
      process.exit(1);
    }
  }
}

async function main() {
  const connStr = getConnectionString();
  assertNotProduction(connStr);

  console.log('\n── Stage 8.6 Demo Cleanup ────────────────────────────────────────────────');
  console.log(`   Target: ${redactUrl(connStr)}`);
  console.log('   Safety: not production ✓');
  console.log('   Scope:  metadata.source=stage8_demo OR booking_code LIKE DEMO-% OR demo phones');
  console.log('─────────────────────────────────────────────────────────────────────────\n');

  const client = new Client({ connectionString: connStr });
  await client.connect();

  const total = { deleted: 0 };

  try {
    // 1. staff_handoffs  — references conversations + bookings
    const h = await client.query(
      `DELETE FROM staff_handoffs
       WHERE metadata->>'source' = 'stage8_demo'
          OR phone = ANY($1)`,
      [DEMO_PHONES]
    );
    console.log(`  staff_handoffs:  ${h.rowCount} deleted`);
    total.deleted += h.rowCount;

    // 2. booking_beds — linked via booking_id to demo bookings
    const bb = await client.query(
      `DELETE FROM booking_beds
       WHERE booking_id IN (
         SELECT id FROM bookings
         WHERE booking_code LIKE $1
            OR metadata->>'source' = 'stage8_demo'
       )`,
      [DEMO_BOOKING_PREFIX]
    );
    console.log(`  booking_beds:    ${bb.rowCount} deleted`);
    total.deleted += bb.rowCount;

    // 3. payments — linked via booking_id
    const pay = await client.query(
      `DELETE FROM payments
       WHERE booking_id IN (
         SELECT id FROM bookings
         WHERE booking_code LIKE $1
            OR metadata->>'source' = 'stage8_demo'
       )
          OR metadata->>'source' = 'stage8_demo'`,
      [DEMO_BOOKING_PREFIX]
    );
    console.log(`  payments:        ${pay.rowCount} deleted`);
    total.deleted += pay.rowCount;

    // 4. Null out current_hold_booking_id on demo conversations to avoid FK block
    await client.query(
      `UPDATE conversations SET current_hold_booking_id = NULL
       WHERE metadata->>'source' = 'stage8_demo'
          OR phone = ANY($1)`,
      [DEMO_PHONES]
    );

    // 5. messages — cascade from conversations, but delete explicitly for safety
    const m = await client.query(
      `DELETE FROM messages
       WHERE metadata->>'source' = 'stage8_demo'
          OR conversation_id IN (
            SELECT id FROM conversations
            WHERE metadata->>'source' = 'stage8_demo'
               OR phone = ANY($1)
          )`,
      [DEMO_PHONES]
    );
    console.log(`  messages:        ${m.rowCount} deleted`);
    total.deleted += m.rowCount;

    // 6. conversations
    const c = await client.query(
      `DELETE FROM conversations
       WHERE metadata->>'source' = 'stage8_demo'
          OR phone = ANY($1)`,
      [DEMO_PHONES]
    );
    console.log(`  conversations:   ${c.rowCount} deleted`);
    total.deleted += c.rowCount;

    // 7. bookings (last — after all FKs cleared)
    const b = await client.query(
      `DELETE FROM bookings
       WHERE booking_code LIKE $1
          OR metadata->>'source' = 'stage8_demo'`,
      [DEMO_BOOKING_PREFIX]
    );
    console.log(`  bookings:        ${b.rowCount} deleted`);
    total.deleted += b.rowCount;

    // 8. demo beds (if created by seed — booking_beds removed above first)
    const dbd = await client.query(
      `DELETE FROM beds WHERE bed_code LIKE 'DEMO-%'`
    );
    console.log(`  beds (demo):     ${dbd.rowCount} deleted`);
    total.deleted += dbd.rowCount;

    // 9. demo rooms (after beds removed)
    const drd = await client.query(
      `DELETE FROM rooms WHERE room_code LIKE 'DEMO-%'`
    );
    console.log(`  rooms (demo):    ${drd.rowCount} deleted`);
    total.deleted += drd.rowCount;

    // ── Verification ──────────────────────────────────────────────────────────
    console.log('\n── Verification (should all be 0) ───────────────────────────────────────');
    const checks = [
      [`bookings`,      `SELECT COUNT(*) FROM bookings     WHERE booking_code LIKE 'DEMO-%' OR metadata->>'source'='stage8_demo'`],
      [`conversations`, `SELECT COUNT(*) FROM conversations WHERE phone = ANY(ARRAY['+34999000001','+34999000002','+34999000003']) OR metadata->>'source'='stage8_demo'`],
      [`messages`,      `SELECT COUNT(*) FROM messages      WHERE metadata->>'source'='stage8_demo'`],
      [`booking_beds`,  `SELECT COUNT(*) FROM booking_beds  WHERE booking_id IN (SELECT id FROM bookings WHERE booking_code LIKE 'DEMO-%')`],
      [`staff_handoffs`,`SELECT COUNT(*) FROM staff_handoffs WHERE metadata->>'source'='stage8_demo' OR phone=ANY(ARRAY['+34999000001','+34999000002','+34999000003'])`],
      [`payments`,      `SELECT COUNT(*) FROM payments       WHERE metadata->>'source'='stage8_demo'`],
      [`beds (demo)`,   `SELECT COUNT(*) FROM beds            WHERE bed_code LIKE 'DEMO-%'`],
      [`rooms (demo)`,  `SELECT COUNT(*) FROM rooms           WHERE room_code LIKE 'DEMO-%'`],
    ];

    let allZero = true;
    for (const [label, sql] of checks) {
      const row = await client.query(sql);
      const n = parseInt(row.rows[0].count, 10);
      const ok = n === 0;
      if (!ok) allZero = false;
      console.log(`  ${label.padEnd(16)} ${ok ? '✓' : '✗'} ${n} remaining`);
    }

    console.log(`\n── Result ────────────────────────────────────────────────────────────────`);
    console.log(`  Total deleted: ${total.deleted} rows`);
    if (allZero) {
      console.log('  ✓ Cleanup PASS — all demo rows removed.\n');
    } else {
      console.log('  ✗ Cleanup PARTIAL — some demo rows remain. Check FK constraints.\n');
      process.exit(1);
    }
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('\n✗ Cleanup failed:', err.message);
  if (err.detail) console.error('  Detail:', err.detail);
  process.exit(1);
});
