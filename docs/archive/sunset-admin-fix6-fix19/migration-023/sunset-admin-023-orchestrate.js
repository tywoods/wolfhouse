#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { withPgClient } = require('/opt/wolfhouse/WH/scripts/lib/pg-connect');

const APPROVED_DB = 'sunset_staging';

async function main() {
  const phase = process.argv[2] || 'preflight';
  await withPgClient(async (c) => {
    const db = (await c.query('SELECT current_database() AS db')).rows[0].db;
    if (db !== APPROVED_DB) throw new Error(`wrong database: ${db}`);

    const tables = await c.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name LIKE 'tenant_%' ORDER BY 1`,
    );
    const tableNames = tables.rows.map((r) => r.table_name);

    const locCols = {};
    for (const t of ['tenant_price_rules', 'tenant_lesson_capacity_rules', 'tenant_lesson_time_rules']) {
      if (!tableNames.includes(t)) continue;
      const cols = await c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND column_name='location_id'`,
        [t],
      );
      locCols[t] = cols.rows.length > 0;
    }

    const counts = {};
    for (const loc of ['sunset-somo', 'sunset-sardinero']) {
      counts[loc] = {};
      for (const t of ['tenant_price_rules', 'tenant_lesson_capacity_rules', 'tenant_lesson_time_rules']) {
        if (!tableNames.includes(t)) { counts[loc][t] = null; continue; }
        if (locCols[t]) {
          const r = await c.query(
            `SELECT COUNT(*)::int AS n FROM ${t} WHERE client_slug='sunset' AND location_id=$1`,
            [loc],
          );
          counts[loc][t] = r.rows[0].n;
        } else {
          const r = await c.query(
            `SELECT COUNT(*)::int AS n FROM ${t} WHERE client_slug='sunset'`,
          );
          counts[loc][t] = r.rows[0].n;
        }
      }
    }

    const out = { phase, database: db, tables: tableNames, location_id_columns: locCols, counts };
    console.log(JSON.stringify(out, null, 2));

    if (phase === 'preflight') {
      if (!tableNames.includes('tenant_price_rules')) throw new Error('tenant_price_rules missing');
      if (locCols.tenant_price_rules) throw new Error('location_id already present pre-023');
    }
  });
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
