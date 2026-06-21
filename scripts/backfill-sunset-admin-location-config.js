'use strict';

/**
 * Duplicate sunset-somo admin config rows to sunset-sardinero after migration 023.
 * Sunset staging only — fail-closed guards match backfill-sunset-admin-config.js
 *
 *   ALLOW_SUNSET_ADMIN_LOCATION_BACKFILL=1 \
 *   WOLFHOUSE_DATABASE_URL=postgres://.../sunset_staging \
 *   node scripts/backfill-sunset-admin-location-config.js
 */

const { normalizeSunsetLocationId } = require('./lib/sunset-school-locations');
const { adminConfigTableHasLocationColumn } = require('./lib/tenant-business-config');

const ALLOW_ENV = 'ALLOW_SUNSET_ADMIN_LOCATION_BACKFILL';
const APPROVED_HOST = 'luna-sunset-staging-pg-app.postgres.database.azure.com';
const APPROVED_DB = 'sunset_staging';
const CLIENT_SLUG = 'sunset';
const SOURCE_LOC = 'sunset-somo';
const TARGET_LOC = 'sunset-sardinero';

const BLOCKED_URL_PATTERNS = [
  /wolfhouse/i, /wh-staging/i, /production/i, /(^|[-_.])prod([-.]|$)/i,
  /\.prod\./i, /wolfhouse_staging/i, /staff-staging\.lunafrontdesk/i,
];

function parseDatabaseTarget(connectionString) {
  const url = String(connectionString || '').trim();
  if (!url) throw new Error('WOLFHOUSE_DATABASE_URL is required');
  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (pattern.test(url)) throw new Error(`database URL rejected (${pattern})`);
  }
  const normalized = url.replace(/^postgres(ql)?:\/\//i, 'http://');
  const parsed = new URL(normalized);
  if (parsed.hostname !== APPROVED_HOST) {
    throw new Error(`database host must be ${APPROVED_HOST}`);
  }
  const database = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (database !== APPROVED_DB) throw new Error(`database name must be ${APPROVED_DB}`);
  return { host: parsed.hostname, database };
}

async function countLocationRows(client, table, locationId) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE client_slug = $1 AND location_id = $2`,
    [CLIENT_SLUG, locationId],
  );
  return r.rows[0].n;
}

async function main() {
  if (process.env[ALLOW_ENV] !== '1') throw new Error(`${ALLOW_ENV}=1 is required`);
  const target = parseDatabaseTarget(process.env.WOLFHOUSE_DATABASE_URL);
  const { Client } = require('pg');
  const client = new Client({
    connectionString: process.env.WOLFHOUSE_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    for (const table of ['tenant_price_rules', 'tenant_lesson_capacity_rules', 'tenant_lesson_time_rules']) {
      if (!(await adminConfigTableHasLocationColumn(client, table))) {
        throw new Error(`location_id column missing on ${table} — apply migration 023 first`);
      }
    }

    const before = {
      somo_prices: await countLocationRows(client, 'tenant_price_rules', SOURCE_LOC),
      sardi_prices: await countLocationRows(client, 'tenant_price_rules', TARGET_LOC),
    };

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenant_price_rules (
         tenant_id, client_slug, location_id, item_type, item_code, display_name,
         currency, amount_cents, unit, active, effective_from, effective_to, updated_by
       )
       SELECT tenant_id, client_slug, $2, item_type, item_code, display_name,
              currency, amount_cents, unit, active, effective_from, effective_to, NULL
         FROM tenant_price_rules
        WHERE client_slug = $1 AND location_id = $3 AND active = true
          AND NOT EXISTS (
            SELECT 1 FROM tenant_price_rules t2
             WHERE t2.client_slug = tenant_price_rules.client_slug
               AND t2.location_id = $2
               AND t2.item_type = tenant_price_rules.item_type
               AND t2.item_code = tenant_price_rules.item_code
               AND t2.unit = tenant_price_rules.unit
               AND t2.active = true
          )`,
      [CLIENT_SLUG, TARGET_LOC, SOURCE_LOC],
    );
    await client.query(
      `INSERT INTO tenant_lesson_capacity_rules (
         tenant_id, client_slug, location_id, scope, weekday, service_date, capacity,
         active, effective_from, effective_to, updated_by
       )
       SELECT tenant_id, client_slug, $2, scope, weekday, service_date, capacity,
              active, effective_from, effective_to, NULL
         FROM tenant_lesson_capacity_rules
        WHERE client_slug = $1 AND location_id = $3 AND active = true
          AND NOT EXISTS (
            SELECT 1 FROM tenant_lesson_capacity_rules t2
             WHERE t2.client_slug = tenant_lesson_capacity_rules.client_slug
               AND t2.location_id = $2
               AND t2.scope = tenant_lesson_capacity_rules.scope
               AND COALESCE(t2.weekday, -1) = COALESCE(tenant_lesson_capacity_rules.weekday, -1)
               AND COALESCE(t2.service_date, DATE '1970-01-01') = COALESCE(tenant_lesson_capacity_rules.service_date, DATE '1970-01-01')
               AND t2.active = true
          )`,
      [CLIENT_SLUG, TARGET_LOC, SOURCE_LOC],
    );
    await client.query(
      `INSERT INTO tenant_lesson_time_rules (
         tenant_id, client_slug, location_id, time_local, time_local_end, label, lesson_type,
         weekdays_active, service_date, active, effective_from, effective_to, updated_by
       )
       SELECT tenant_id, client_slug, $2, time_local, time_local_end, label, lesson_type,
              weekdays_active, service_date, active, effective_from, effective_to, NULL
         FROM tenant_lesson_time_rules
        WHERE client_slug = $1 AND location_id = $3 AND active = true
          AND NOT EXISTS (
            SELECT 1 FROM tenant_lesson_time_rules t2
             WHERE t2.client_slug = tenant_lesson_time_rules.client_slug
               AND t2.location_id = $2
               AND t2.time_local = tenant_lesson_time_rules.time_local
               AND t2.lesson_type = tenant_lesson_time_rules.lesson_type
               AND COALESCE(t2.service_date, DATE '1970-01-01') = COALESCE(tenant_lesson_time_rules.service_date, DATE '1970-01-01')
               AND t2.active = true
          )`,
      [CLIENT_SLUG, TARGET_LOC, SOURCE_LOC],
    );
    await client.query('COMMIT');

    const after = {
      somo_prices: await countLocationRows(client, 'tenant_price_rules', SOURCE_LOC),
      sardi_prices: await countLocationRows(client, 'tenant_price_rules', TARGET_LOC),
      somo_cap: await countLocationRows(client, 'tenant_lesson_capacity_rules', SOURCE_LOC),
      sardi_cap: await countLocationRows(client, 'tenant_lesson_capacity_rules', TARGET_LOC),
      somo_times: await countLocationRows(client, 'tenant_lesson_time_rules', SOURCE_LOC),
      sardi_times: await countLocationRows(client, 'tenant_lesson_time_rules', TARGET_LOC),
    };

    console.log(JSON.stringify({
      ok: true,
      target,
      source: normalizeSunsetLocationId(SOURCE_LOC),
      dest: normalizeSunsetLocationId(TARGET_LOC),
      before,
      after,
    }, null, 2));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
