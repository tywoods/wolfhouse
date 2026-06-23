'use strict';
const { Client } = require('pg');

(async () => {
  const url = process.env.WOLFHOUSE_DATABASE_URL;
  if (!url) {
    console.error('missing WOLFHOUSE_DATABASE_URL');
    process.exit(2);
  }
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const tables = [
    'tenant_price_rules',
    'tenant_lesson_capacity_rules',
    'tenant_lesson_time_rules',
    'tenant_config_audit_log',
  ];
  const out = {};
  for (const t of tables) {
    const r = await c.query(
      `SELECT COUNT(*)::int AS n FROM ${t} WHERE client_slug = $1`,
      ['sunset'],
    );
    out[t] = r.rows[0].n;
  }
  console.log(JSON.stringify(out, null, 2));
  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
