#!/usr/bin/env node
'use strict';
const { withPgClient } = require('/app/scripts/lib/pg-connect');

const APPROVED_DB = 'sunset_staging';
const TABLES = ['tenant_price_rules', 'tenant_lesson_capacity_rules', 'tenant_lesson_time_rules'];

async function snapshot(client) {
  const db = (await client.query('SELECT current_database() AS db')).rows[0].db;
  const tables = (await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 'tenant_%' ORDER BY 1`,
  )).rows.map((r) => r.table_name);
  const location_id_columns = {};
  for (const t of TABLES) {
    const c = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name='location_id' LIMIT 1`,
      [t],
    );
    location_id_columns[t] = c.rows.length > 0;
  }
  const counts = {};
  for (const loc of ['sunset-somo', 'sunset-sardinero']) {
    counts[loc] = {};
    for (const t of TABLES) {
      if (!location_id_columns[t]) {
        const r = await client.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE client_slug='sunset'`);
        counts[loc][t] = r.rows[0].n;
      } else {
        const r = await client.query(
          `SELECT COUNT(*)::int AS n FROM ${t} WHERE client_slug='sunset' AND location_id=$1`, [loc],
        );
        counts[loc][t] = r.rows[0].n;
      }
    }
  }
  return { database: db, tables, location_id_columns, counts };
}

async function seedSardinero(client) {
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO tenant_price_rules (
       tenant_id, client_slug, location_id, item_type, item_code, display_name,
       currency, amount_cents, unit, active, effective_from, effective_to, updated_by
     )
     SELECT tenant_id, client_slug, 'sunset-sardinero', item_type, item_code, display_name,
            currency, amount_cents, unit, active, effective_from, effective_to, NULL
       FROM tenant_price_rules
      WHERE client_slug='sunset' AND location_id='sunset-somo' AND active=true
        AND NOT EXISTS (
          SELECT 1 FROM tenant_price_rules t2
           WHERE t2.client_slug=tenant_price_rules.client_slug
             AND t2.location_id='sunset-sardinero'
             AND t2.item_type=tenant_price_rules.item_type
             AND t2.item_code=tenant_price_rules.item_code
             AND t2.unit=tenant_price_rules.unit AND t2.active=true
        )`,
  );
  await client.query(
    `INSERT INTO tenant_lesson_capacity_rules (
       tenant_id, client_slug, location_id, scope, weekday, service_date, capacity,
       active, effective_from, effective_to, updated_by
     )
     SELECT tenant_id, client_slug, 'sunset-sardinero', scope, weekday, service_date, capacity,
            active, effective_from, effective_to, NULL
       FROM tenant_lesson_capacity_rules
      WHERE client_slug='sunset' AND location_id='sunset-somo' AND active=true
        AND NOT EXISTS (
          SELECT 1 FROM tenant_lesson_capacity_rules t2
           WHERE t2.client_slug=tenant_lesson_capacity_rules.client_slug
             AND t2.location_id='sunset-sardinero'
             AND t2.scope=tenant_lesson_capacity_rules.scope
             AND COALESCE(t2.weekday,-1)=COALESCE(tenant_lesson_capacity_rules.weekday,-1)
             AND COALESCE(t2.service_date,DATE '1970-01-01')=COALESCE(tenant_lesson_capacity_rules.service_date,DATE '1970-01-01')
             AND t2.active=true
        )`,
  );
  await client.query(
    `INSERT INTO tenant_lesson_time_rules (
       tenant_id, client_slug, location_id, time_local, time_local_end, label, lesson_type,
       weekdays_active, service_date, active, effective_from, effective_to, updated_by
     )
     SELECT tenant_id, client_slug, 'sunset-sardinero', time_local, time_local_end, label, lesson_type,
            weekdays_active, service_date, active, effective_from, effective_to, NULL
       FROM tenant_lesson_time_rules
      WHERE client_slug='sunset' AND location_id='sunset-somo' AND active=true
        AND NOT EXISTS (
          SELECT 1 FROM tenant_lesson_time_rules t2
           WHERE t2.client_slug=tenant_lesson_time_rules.client_slug
             AND t2.location_id='sunset-sardinero'
             AND t2.time_local=tenant_lesson_time_rules.time_local
             AND t2.lesson_type=tenant_lesson_time_rules.lesson_type
             AND COALESCE(t2.service_date,DATE '1970-01-01')=COALESCE(tenant_lesson_time_rules.service_date,DATE '1970-01-01')
             AND t2.active=true
        )`,
  );
  await client.query('COMMIT');
}

async function main() {
  const phase = process.argv[2] || 'verify';
  const migB64 = process.env.MIGRATION_SQL_B64 || '';
  await withPgClient(async (client) => {
    if (phase === 'preflight') {
      const s = await snapshot(client);
      if (s.database !== APPROVED_DB) throw new Error(`wrong db ${s.database}`);
      console.log(JSON.stringify({ ok: true, ...s, migration_needed: !s.location_id_columns.tenant_price_rules }));
      return;
    }
    if (phase === 'migrate') {
      const s = await snapshot(client);
      if (s.database !== APPROVED_DB) throw new Error(`wrong db ${s.database}`);
      if (s.location_id_columns.tenant_price_rules) {
        console.log(JSON.stringify({ ok: true, skipped: true, reason: 'already applied' }));
        return;
      }
      if (!migB64) throw new Error('MIGRATION_SQL_B64 required');
      const sql = Buffer.from(migB64, 'base64').toString('utf8');
      await client.query(sql);
      console.log(JSON.stringify({ ok: true, applied: '023', after: await snapshot(client) }, null, 2));
      return;
    }
    if (phase === 'seed') {
      await seedSardinero(client);
      console.log(JSON.stringify({ ok: true, after: await snapshot(client) }, null, 2));
      return;
    }
    if (phase === 'verify') {
      const s = await snapshot(client);
      const ok = s.location_id_columns.tenant_price_rules
        && s.counts['sunset-somo'].tenant_price_rules > 0
        && s.counts['sunset-sardinero'].tenant_price_rules > 0
        && s.counts['sunset-somo'].tenant_lesson_capacity_rules > 0
        && s.counts['sunset-sardinero'].tenant_lesson_capacity_rules > 0
        && s.counts['sunset-somo'].tenant_lesson_time_rules > 0
        && s.counts['sunset-sardinero'].tenant_lesson_time_rules > 0;
      console.log(JSON.stringify({ ok, ...s }, null, 2));
      if (!ok) process.exit(1);
    }
  });
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
