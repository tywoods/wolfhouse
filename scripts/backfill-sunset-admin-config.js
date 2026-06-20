'use strict';

/**
 * Backfill Sunset Admin business config tables from baseline JSON (staging only).
 *
 *   ALLOW_SUNSET_ADMIN_CONFIG_BACKFILL=1 \
 *   WOLFHOUSE_DATABASE_URL=postgres://... \
 *   node scripts/backfill-sunset-admin-config.js
 *
 * Fail-closed: only luna-sunset-staging-pg-app / sunset_staging.
 * Never logs password or connection string.
 */

const {
  SUNSET_ADMIN_CLIENT,
  DEFAULT_DAILY_CAP,
  resolveTenantBusinessConfig,
  resolveTenantBusinessConfigAsync,
  isSunsetAdminDbReadEnabled,
} = require('./lib/tenant-business-config');

const ALLOW_ENV = 'ALLOW_SUNSET_ADMIN_CONFIG_BACKFILL';
const APPROVED_HOST = 'luna-sunset-staging-pg-app.postgres.database.azure.com';
const APPROVED_DB = 'sunset_staging';
const TENANT_ID = 'sunset';
const CLIENT_SLUG = 'sunset';
const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

const BLOCKED_URL_PATTERNS = [
  /wolfhouse/i,
  /wh-staging/i,
  /production/i,
  /(^|[-_.])prod([-.]|$)/i,
  /\.prod\./i,
  /wolfhouse_staging/i,
  /staff-staging\.lunafrontdesk/i,
];

function parseDatabaseTarget(connectionString) {
  const url = String(connectionString || '').trim();
  if (!url) throw new Error('WOLFHOUSE_DATABASE_URL is required');

  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (pattern.test(url)) {
      throw new Error(`database URL rejected by fail-closed guard (${pattern})`);
    }
  }

  let host;
  let database;
  try {
    const normalized = url.replace(/^postgres(ql)?:\/\//i, 'http://');
    const parsed = new URL(normalized);
    host = parsed.hostname;
    database = parsed.pathname.replace(/^\//, '').split('?')[0];
  } catch {
    throw new Error('could not parse database URL');
  }

  if (host !== APPROVED_HOST) {
    throw new Error(`database host must be ${APPROVED_HOST} (got ${host})`);
  }
  if (database !== APPROVED_DB) {
    throw new Error(`database name must be ${APPROVED_DB} (got ${database})`);
  }

  return { host, database };
}

function mapBaselineUnitToDb(unitKey) {
  const key = String(unitKey || '').trim();
  if (/surfer|person|single_lesson/i.test(key)) return 'person';
  if (/^(1|2|5|7)_days?$/.test(key) || key === '1_day') return 'day';
  if (/hour|half_day|lesson/i.test(key)) return 'session';
  return 'item';
}

function buildDbItemCode(offeringKey, baselineUnit) {
  return `${offeringKey}__${baselineUnit}`;
}

function parseSlotTimes(slotTime) {
  const text = String(slotTime || '').trim();
  if (!text) return { timeLocal: null, timeLocalEnd: null };
  const parts = text.split('-').map((p) => p.trim());
  if (parts.length === 2) {
    return { timeLocal: parts[0], timeLocalEnd: parts[1] };
  }
  return { timeLocal: text, timeLocalEnd: null };
}

function buildBackfillPayload() {
  const config = resolveTenantBusinessConfig(CLIENT_SLUG);
  if (!config.ok) {
    throw new Error(`resolver failed for ${CLIENT_SLUG}: ${config.reason || 'unknown'}`);
  }

  const prices = config.prices.map((p) => ({
    tenant_id: TENANT_ID,
    client_slug: CLIENT_SLUG,
    item_type: p.category === 'package' ? 'package' : p.category,
    item_code: buildDbItemCode(p.offering_key, p.unit),
    catalog_offering_key: p.offering_key,
    display_name: `${p.label} (${p.unit})`,
    currency: p.currency || 'EUR',
    amount_cents: Math.round(Number(p.amount) * 100),
    unit: mapBaselineUnitToDb(p.unit),
    baseline_unit: p.unit,
  }));

  const capacity = {
    tenant_id: TENANT_ID,
    client_slug: CLIENT_SLUG,
    scope: 'default',
    capacity: config.lesson_capacity.default_daily_cap || DEFAULT_DAILY_CAP,
  };

  const lessonTimes = config.lesson_times.map((slot, idx) => {
    const { timeLocal, timeLocalEnd } = parseSlotTimes(slot.slot_time);
    if (!timeLocal) {
      throw new Error(`lesson slot ${idx + 1} missing slot_time`);
    }
    return {
      tenant_id: TENANT_ID,
      client_slug: CLIENT_SLUG,
      time_local: timeLocal,
      time_local_end: timeLocalEnd,
      label: slot.offering_label || slot.session_type || 'Surf lesson',
      lesson_type: slot.session_type || `lesson_slot_${idx + 1}`,
      weekdays_active: slot.date ? [] : ALL_WEEKDAYS,
      service_date: slot.date || null,
      source_slot_id: slot.slot_id || null,
    };
  });

  return {
    config,
    prices,
    capacity,
    lessonTimes,
  };
}

async function tableExists(client, tableName) {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName],
  );
  return r.rows[0].exists === true;
}

async function countRows(client, tableName) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS n FROM ${tableName} WHERE client_slug = $1`,
    [CLIENT_SLUG],
  );
  return r.rows[0].n;
}

async function runBackfill(client, payload) {
  await client.query('BEGIN');
  try {
    await client.query(
      `DELETE FROM tenant_price_rules WHERE client_slug = $1 AND tenant_id = $2`,
      [CLIENT_SLUG, TENANT_ID],
    );
    await client.query(
      `DELETE FROM tenant_lesson_capacity_rules WHERE client_slug = $1 AND tenant_id = $2`,
      [CLIENT_SLUG, TENANT_ID],
    );
    await client.query(
      `DELETE FROM tenant_lesson_time_rules WHERE client_slug = $1 AND tenant_id = $2`,
      [CLIENT_SLUG, TENANT_ID],
    );

    for (const row of payload.prices) {
      await client.query(
        `INSERT INTO tenant_price_rules (
           tenant_id, client_slug, item_type, item_code, display_name, currency,
           amount_cents, unit, active, effective_from, effective_to, updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,NULL,NULL,NULL)`,
        [
          row.tenant_id,
          row.client_slug,
          row.item_type,
          row.item_code,
          row.display_name,
          row.currency,
          row.amount_cents,
          row.unit,
        ],
      );
    }

    await client.query(
      `INSERT INTO tenant_lesson_capacity_rules (
         tenant_id, client_slug, scope, weekday, service_date, capacity,
         active, effective_from, effective_to, updated_by
       ) VALUES ($1,$2,'default',NULL,NULL,$3,true,NULL,NULL,NULL)`,
      [payload.capacity.tenant_id, payload.capacity.client_slug, payload.capacity.capacity],
    );

    for (const row of payload.lessonTimes) {
      await client.query(
        `INSERT INTO tenant_lesson_time_rules (
           tenant_id, client_slug, time_local, time_local_end, label, lesson_type,
           weekdays_active, service_date, active, effective_from, effective_to, updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,NULL,NULL,NULL)`,
        [
          row.tenant_id,
          row.client_slug,
          row.time_local,
          row.time_local_end,
          row.label,
          row.lesson_type,
          row.weekdays_active,
          row.service_date,
        ],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function compareResolverWithDb(client) {
  const savedFlag = process.env.SUNSET_ADMIN_DB_READ_ENABLED;
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'false';
  const configOnly = resolveTenantBusinessConfig(CLIENT_SLUG);

  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';
  const fromDb = await resolveTenantBusinessConfigAsync(CLIENT_SLUG, { pgClient: client });

  if (savedFlag == null) delete process.env.SUNSET_ADMIN_DB_READ_ENABLED;
  else process.env.SUNSET_ADMIN_DB_READ_ENABLED = savedFlag;

  return {
    flag_off: {
      source: configOnly.source,
      price_count: configOnly.prices.length,
      lesson_cap: configOnly.lesson_capacity.default_daily_cap,
      lesson_times: configOnly.lesson_times.length,
    },
    flag_on_probe: {
      source: fromDb.source,
      price_count: fromDb.prices.length,
      lesson_cap: fromDb.lesson_capacity.default_daily_cap,
      lesson_times: fromDb.lesson_times.length,
      db_read_warning: fromDb.db_read_warning || null,
    },
  };
}

async function main() {
  if (process.env[ALLOW_ENV] !== '1') {
    throw new Error(`${ALLOW_ENV}=1 is required`);
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to run with NODE_ENV=production');
  }

  const target = parseDatabaseTarget(process.env.WOLFHOUSE_DATABASE_URL);
  const payload = buildBackfillPayload();

  const requiredTables = [
    'tenant_price_rules',
    'tenant_lesson_capacity_rules',
    'tenant_lesson_time_rules',
  ];
  const { Client } = require('pg');
  const client = new Client({
    connectionString: process.env.WOLFHOUSE_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    for (const table of requiredTables) {
      if (!(await tableExists(client, table))) {
        throw new Error(`required table missing: ${table}`);
      }
    }

    const before = {
      tenant_price_rules: await countRows(client, 'tenant_price_rules'),
      tenant_lesson_capacity_rules: await countRows(client, 'tenant_lesson_capacity_rules'),
      tenant_lesson_time_rules: await countRows(client, 'tenant_lesson_time_rules'),
      tenant_config_audit_log: await countRows(client, 'tenant_config_audit_log'),
    };

    await runBackfill(client, payload);

    const after = {
      tenant_price_rules: await countRows(client, 'tenant_price_rules'),
      tenant_lesson_capacity_rules: await countRows(client, 'tenant_lesson_capacity_rules'),
      tenant_lesson_time_rules: await countRows(client, 'tenant_lesson_time_rules'),
      tenant_config_audit_log: await countRows(client, 'tenant_config_audit_log'),
    };

    const sanity = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM tenant_price_rules WHERE client_slug = $1) AS sunset_prices,
         (SELECT COUNT(*)::int FROM tenant_price_rules WHERE client_slug <> $1) AS other_prices,
         (SELECT MIN(amount_cents)::int FROM tenant_price_rules WHERE client_slug = $1) AS min_amount_cents,
         (SELECT capacity::int FROM tenant_lesson_capacity_rules
            WHERE client_slug = $1 AND scope = 'default' AND active = true LIMIT 1) AS default_capacity`,
      [CLIENT_SLUG],
    );

    const compare = await compareResolverWithDb(client);

    console.log(JSON.stringify({
      ok: true,
      action: before.tenant_price_rules > 0 ? 'replaced' : 'inserted',
      target: { host: target.host, database: target.database },
      expected: {
        prices: payload.prices.length,
        capacity_default: payload.capacity.capacity,
        lesson_times: payload.lessonTimes.length,
      },
      row_counts_before: before,
      row_counts_after: after,
      sanity: sanity.rows[0],
      resolver_compare: compare,
      audit_log_note: 'tenant_config_audit_log left empty — operational import backfill, not Admin UI write; audit reserved for future write API',
      live_flag_off: isSunsetAdminDbReadEnabled() === false,
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});

module.exports = {
  mapBaselineUnitToDb,
  buildDbItemCode,
  parseSlotTimes,
  buildBackfillPayload,
};
