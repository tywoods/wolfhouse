'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
(async () => {
  const u = execSync('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const c = new Client({ connectionString: u, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const cols = await c.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'webhook_entity' ORDER BY ordinal_position");
  const wf = await c.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', ['stage27demoJReview01']);
  const hooks = await c.query('SELECT * FROM webhook_entity LIMIT 5');
  console.log(JSON.stringify({ webhook_columns: cols.rows.map((r) => r.column_name), wf: wf.rows, sample_hooks: hooks.rows }, null, 2));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
