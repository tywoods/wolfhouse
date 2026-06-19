'use strict';

/**
 * Sunset Portal Slice 1 — delete demo rows tagged sunset_demo_slice1 (dry-run by default).
 *
 *   node scripts/fixtures/sunset-portal-slice1-cleanup.js
 *   ALLOW_SUNSET_DEMO_SEED=1 node scripts/fixtures/sunset-portal-slice1-cleanup.js --execute
 */

const {
  DEMO_TAG,
  parseCliArgs,
  getDatabaseUrl,
  assertExecuteGates,
  buildCleanupPlan,
  printCleanupPlan,
} = require('./sunset-portal-slice1-guards');

const CLEANUP_STEPS = [
  {
    table: 'staff_handoffs',
    sql: `DELETE FROM staff_handoffs WHERE metadata->>'source' = $1`,
    countSql: `SELECT COUNT(*)::int AS c FROM staff_handoffs WHERE metadata->>'source' = $1`,
  },
  {
    table: 'messages',
    sql: `DELETE FROM messages WHERE metadata->>'source' = $1`,
    countSql: `SELECT COUNT(*)::int AS c FROM messages WHERE metadata->>'source' = $1`,
  },
  {
    table: 'conversations',
    sql: `UPDATE conversations SET current_hold_booking_id = NULL
          WHERE metadata->>'source' = $1`,
    countSql: `SELECT COUNT(*)::int AS c FROM conversations WHERE metadata->>'source' = $1`,
    updateOnly: true,
  },
  {
    table: 'booking_service_records',
    sql: `DELETE FROM booking_service_records
          WHERE client_slug = 'sunset' AND metadata->>'source' = $1`,
    countSql: `SELECT COUNT(*)::int AS c FROM booking_service_records
               WHERE client_slug = 'sunset' AND metadata->>'source' = $1`,
  },
  {
    table: 'conversations',
    sql: `DELETE FROM conversations WHERE metadata->>'source' = $1`,
    countSql: `SELECT COUNT(*)::int AS c FROM conversations WHERE metadata->>'source' = $1`,
  },
  {
    table: 'payments',
    sql: `DELETE FROM payments WHERE metadata->>'source' = $1`,
    countSql: `SELECT COUNT(*)::int AS c FROM payments WHERE metadata->>'source' = $1`,
  },
  {
    table: 'bookings',
    sql: `DELETE FROM bookings b
          USING clients c
          WHERE b.client_id = c.id
            AND c.slug = 'sunset'
            AND b.metadata->>'source' = $1`,
    countSql: `SELECT COUNT(*)::int AS c FROM bookings b
               INNER JOIN clients c ON c.id = b.client_id
               WHERE c.slug = 'sunset' AND b.metadata->>'source' = $1`,
  },
];

async function countTaggedRows(pg) {
  const counts = {};
  for (const step of CLEANUP_STEPS) {
    const key = step.updateOnly ? `${step.table}_to_update` : step.table;
    if (counts[key] != null) {
      const res = await pg.query(step.countSql, [DEMO_TAG]);
      counts[key] = (counts[key] || 0) + (res.rows[0] ? res.rows[0].c : 0);
      continue;
    }
    const res = await pg.query(step.countSql, [DEMO_TAG]);
    counts[step.table] = res.rows[0] ? res.rows[0].c : 0;
  }
  return counts;
}

async function executeCleanup(opts) {
  const { withPgClient } = require('../lib/pg-connect');
  const deleted = {};

  await withPgClient(async (pg) => {
    const before = await countTaggedRows(pg);
    console.log('\nTagged rows before cleanup:');
    console.log(`  ${JSON.stringify(before)}`);

    for (const step of CLEANUP_STEPS) {
      const res = await pg.query(step.sql, [DEMO_TAG]);
      const key = step.updateOnly ? `${step.table}_updated` : step.table;
      deleted[key] = res.rowCount || 0;
    }

    const after = await countTaggedRows(pg);
    const leak = await pg.query(
      `SELECT COUNT(*)::int AS c FROM booking_service_records
       WHERE client_slug = 'wolfhouse-somo' AND metadata->>'source' = $1`,
      [DEMO_TAG],
    );
    if (leak.rows[0] && leak.rows[0].c > 0) {
      throw new Error(`wolfhouse leakage detected after cleanup: ${leak.rows[0].c} rows`);
    }

    console.log('\nEXECUTE delete/update counts:');
    console.log(`  ${JSON.stringify(deleted)}`);
    console.log('Tagged rows after cleanup:');
    console.log(`  ${JSON.stringify(after)}`);

    const remaining = Object.values(after).reduce((sum, n) => sum + Number(n || 0), 0);
    if (remaining > 0) {
      throw new Error(`cleanup incomplete — ${remaining} tagged rows remain`);
    }
  });

  return deleted;
}

async function main() {
  const opts = parseCliArgs();
  if (opts.help) {
    console.log('Usage: node scripts/fixtures/sunset-portal-slice1-cleanup.js [--execute]');
    process.exit(0);
  }

  const plan = buildCleanupPlan();
  const gate = assertExecuteGates(opts, getDatabaseUrl());
  const mode = gate.mode === 'execute' ? 'EXECUTE (localhost/test DB only)' : 'DRY-RUN';

  printCleanupPlan(plan, mode);

  if (!opts.execute) {
    console.log('\nNo deletes performed (dry-run). Pass --execute with ALLOW_SUNSET_DEMO_SEED=1 to delete.');
    process.exit(0);
  }

  await executeCleanup(opts);
  console.log('\nsunset-portal-slice1-cleanup — execute complete');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nFAIL — ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  main,
  CLEANUP_STEPS,
  countTaggedRows,
  executeCleanup,
};
