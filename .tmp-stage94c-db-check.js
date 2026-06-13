'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');

const stagingUrl = execSync(
  'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
  { encoding: 'utf8' },
).trim();

if (!/wh-staging-pg-app|wolfhouse_staging/i.test(stagingUrl)) {
  console.error('BLOCKER: not staging DB URL');
  process.exit(1);
}

(async () => {
  const c = new Client({ connectionString: stagingUrl });
  await c.connect();
  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    ['bot_pause_states'],
  );
  const idx = await c.query(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = $1
     ORDER BY indexname`,
    ['bot_pause_states'],
  );
  const cnt = await c.query('SELECT COUNT(*)::int AS n FROM bot_pause_states');
  console.log(JSON.stringify({
    staging_db: true,
    column_count: cols.rows.length,
    columns: cols.rows.map(r => r.column_name),
    indexes: idx.rows.map(r => r.indexname),
    row_count: cnt.rows[0].n,
  }, null, 2));
  await c.end();
})().catch(err => { console.error(err); process.exit(1); });
