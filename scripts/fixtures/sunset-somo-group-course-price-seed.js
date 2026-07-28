'use strict';

/**
 * Git-owned Sunset Somo Admin group-course price seed.
 * Dry-run by default. Inserts missing rows only; never updates/deletes Admin data.
 *
 * Staging activation (post-merge only):
 *   ALLOW_SUNSET_ADMIN_PRICE_SEED=1 \
 *   SUNSET_ADMIN_PRICE_SEED_STAGING_DB_ALLOW=1 \
 *   WOLFHOUSE_DATABASE_URL='postgres://...@luna-sunset-staging-pg-app.postgres.database.azure.com/sunset_staging' \
 *   node scripts/fixtures/sunset-somo-group-course-price-seed.js --execute
 */

const EXPECTED_HOST = 'luna-sunset-staging-pg-app.postgres.database.azure.com';
const EXPECTED_DB = 'sunset_staging';
const TENANT_ID = 'sunset';
const CLIENT_SLUG = 'sunset';
const LOCATION_ID = 'sunset-somo';
const PRICES = Object.freeze([
  Object.freeze({ item_code: 'group_course__4_days', display_name: 'Group course — 4 days', amount_cents: 800 }),
  Object.freeze({ item_code: 'group_course__5_days', display_name: 'Group course — 5 days', amount_cents: 1000 }),
  Object.freeze({ item_code: 'group_course__6_days', display_name: 'Group course — 6 days', amount_cents: 1200 }),
  Object.freeze({ item_code: 'group_course__7_days', display_name: 'Group course — 7 days', amount_cents: 2000 }),
]);

function databaseUrl() {
  return String(process.env.WOLFHOUSE_DATABASE_URL || process.env.DATABASE_URL || '').trim();
}

function assertExecuteTarget(url) {
  if (process.env.ALLOW_SUNSET_ADMIN_PRICE_SEED !== '1') throw new Error('ALLOW_SUNSET_ADMIN_PRICE_SEED=1 is required');
  if (process.env.SUNSET_ADMIN_PRICE_SEED_STAGING_DB_ALLOW !== '1') throw new Error('SUNSET_ADMIN_PRICE_SEED_STAGING_DB_ALLOW=1 is required');
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') throw new Error('NODE_ENV=production is forbidden');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('A parseable WOLFHOUSE_DATABASE_URL/DATABASE_URL is required'); }
  const db = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (parsed.hostname !== EXPECTED_HOST || db !== EXPECTED_DB) {
    throw new Error(`fail-closed: only ${EXPECTED_HOST}/${EXPECTED_DB} is allowed`);
  }
}

async function seedWithClient(pg) {
  await pg.query('BEGIN');
  try {
    const inserted = [];
    for (const row of PRICES) {
      const result = await pg.query(
        `INSERT INTO tenant_price_rules
           (tenant_id, client_slug, location_id, item_type, item_code, display_name,
            currency, amount_cents, unit, active, effective_from, effective_to)
         SELECT $1, $2, $3, 'package', $4, $5, 'EUR', $6, 'day', true, NULL, NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM tenant_price_rules
            WHERE tenant_id = $1 AND client_slug = $2 AND location_id = $3
              AND item_type = 'package' AND item_code = $4 AND unit = 'day'
              AND active = true AND effective_from IS NULL
         )
         RETURNING item_code`,
        [TENANT_ID, CLIENT_SLUG, LOCATION_ID, row.item_code, row.display_name, row.amount_cents],
      );
      if (result.rows.length) inserted.push(row.item_code);
    }
    const readback = await pg.query(
      `SELECT tenant_id, client_slug, location_id, item_type, item_code, currency,
              amount_cents, unit, active, effective_from, effective_to
         FROM tenant_price_rules
        WHERE tenant_id = $1 AND client_slug = $2 AND location_id = $3
          AND item_type = 'package' AND item_code = ANY($4::text[])
          AND unit = 'day' AND active = true AND effective_from IS NULL
        ORDER BY item_code`,
      [TENANT_ID, CLIENT_SLUG, LOCATION_ID, PRICES.map((row) => row.item_code)],
    );
    const actual = new Map(readback.rows.map((row) => [row.item_code, Number(row.amount_cents)]));
    const conflicts = PRICES.filter((row) => actual.get(row.item_code) !== row.amount_cents);
    if (conflicts.length) {
      throw new Error(`readback mismatch; existing Admin values preserved: ${conflicts.map((r) => `${r.item_code} expected=${r.amount_cents} actual=${actual.has(r.item_code) ? actual.get(r.item_code) : 'missing'}`).join(', ')}`);
    }
    await pg.query('COMMIT');
    return { inserted, skipped: PRICES.map((r) => r.item_code).filter((key) => !inserted.includes(key)), rows: readback.rows };
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  const execute = process.argv.slice(2).includes('--execute');
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'dry-run', tenant_id: TENANT_ID, client_slug: CLIENT_SLUG, location_id: LOCATION_ID, overwrite: false, prices: PRICES }, null, 2));
  if (!execute) return;
  const url = databaseUrl();
  assertExecuteTarget(url);
  const { withPgClient } = require('../lib/pg-connect');
  const result = await withPgClient(seedWithClient);
  console.log(JSON.stringify({ ok: true, readback: result }, null, 2));
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });
module.exports = { PRICES, TENANT_ID, CLIENT_SLUG, LOCATION_ID, EXPECTED_HOST, EXPECTED_DB, assertExecuteTarget, seedWithClient };
