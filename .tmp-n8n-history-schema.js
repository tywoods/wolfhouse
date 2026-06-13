'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
(async () => {
  const u = execSync('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const c = new Client({ connectionString: u, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const cols = await c.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'workflow_history' ORDER BY ordinal_position");
  console.log(JSON.stringify(cols.rows, null, 2));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
