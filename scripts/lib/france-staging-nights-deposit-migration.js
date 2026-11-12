'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MIGRATION = '134_wolfhouse_nights_deposit.sql';

// Narrow settings-only application. Do not replay unrelated migrations or
// bootstrap the canonical ledger on a host with an incomplete migration history.
async function applyAndVerify(pg, sql) {
  const identity = (await pg.query('SELECT current_database() AS database')).rows[0];
  if (!identity || identity.database !== 'wolfhouse_staging') throw new Error('migration134_staging_database_required');
  await pg.query(sql);
  const rows = (await pg.query(`SELECT r.item_code, r.amount_cents, i.metadata->>'nights_threshold' AS nights_threshold
    FROM wh_pricing_rules r JOIN wh_pricing_items i ON i.client_slug = r.client_slug
      AND i.item_type = 'deposit' AND i.item_code = 'standard_package' AND i.active = true
    WHERE r.client_slug = 'wolfhouse-somo' AND r.item_type = 'deposit' AND r.active = true
      AND r.season_code IS NULL AND r.item_code IN ('standard_package', 'custom_or_short_stay')
    ORDER BY r.item_code`)).rows;
  if (rows.length !== 2 || new Set(rows.map(r => r.item_code)).size !== 2
      || rows.some(r => !Number.isSafeInteger(Number(r.nights_threshold)) || Number(r.nights_threshold) < 1
        || !Number.isSafeInteger(Number(r.amount_cents)) || Number(r.amount_cents) < 0)) {
    throw new Error('migration134_readback_failed');
  }
  return rows;
}

function buildMigrationProgram(repo) {
  const sql = fs.readFileSync(path.join(repo, 'database/migrations', MIGRATION), 'utf8');
  const sha256 = crypto.createHash('sha256').update(sql).digest('hex');
  // Run via stdin in the existing staging Staff container. It supplies pg and
  // its existing env; no DSN/secret crosses the command line or enters receipts.
  return `'use strict';
const { Client } = require('pg');
const applyAndVerify = ${applyAndVerify.toString()};
(async () => {
  const connectionString = process.env.WOLFHOUSE_DATABASE_URL;
  if (!connectionString || new URL(connectionString).pathname !== '/wolfhouse_staging') throw new Error('migration134_staging_dsn_required');
  const pg = new Client({ connectionString, connectionTimeoutMillis: 10000 });
  try {
    await pg.connect();
    const settings = await applyAndVerify(pg, ${JSON.stringify(sql)});
    console.log('MIGRATION134_PASS', JSON.stringify({ migration: ${JSON.stringify(MIGRATION)}, sha256: ${JSON.stringify(sha256)}, settings }));
  } finally { await pg.end(); }
})().catch(err => { console.error('MIGRATION134_FAIL', err.code || 'apply_or_readback_failed'); process.exitCode = 1; });
`;
}
module.exports = { MIGRATION, applyAndVerify, buildMigrationProgram };
