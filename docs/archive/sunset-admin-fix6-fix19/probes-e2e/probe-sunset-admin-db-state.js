#!/usr/bin/env node
'use strict';
const { withPgClient } = require('/opt/wolfhouse/WH/scripts/lib/pg-connect');

withPgClient(async (c) => {
  const tables = await c.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'tenant_%'
      ORDER BY 1`,
  );
  const mig = await c.query(
    `SELECT version, name FROM schema_migrations
      WHERE name LIKE '%021%' OR name LIKE '%admin%' OR name LIKE '%023%'
      ORDER BY version`,
  ).catch(async () => {
    const alt = await c.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'schema_migrations' LIMIT 5`,
    ).catch(() => ({ rows: [] }));
    return { rows: [], schema_cols: alt.rows };
  });

  const out = { tables: tables.rows.map((r) => r.table_name), migrations: mig.rows };
  if (mig.schema_cols) out.migration_schema_cols = mig.schema_cols;

  for (const t of ['tenant_price_rules', 'tenant_lesson_capacity_rules', 'tenant_lesson_time_rules']) {
    if (!out.tables.includes(t)) continue;
    const cols = await c.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [t],
    );
    out[`${t}_columns`] = cols.rows.map((r) => r.column_name);
    const cnt = await c.query(
      `SELECT COUNT(*)::int AS n FROM ${t} WHERE client_slug = 'sunset'`,
    );
    out[`${t}_sunset_rows`] = cnt.rows[0].n;
    if (cols.rows.some((r) => r.column_name === 'location_id')) {
      const loc = await c.query(
        `SELECT location_id, COUNT(*)::int AS n FROM ${t}
          WHERE client_slug = 'sunset' GROUP BY location_id ORDER BY 1`,
      );
      out[`${t}_by_location`] = loc.rows;
    }
  }

  const db = await c.query('SELECT current_database() AS db');
  out.database = db.rows[0].db;
  console.log(JSON.stringify(out, null, 2));
}).catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
