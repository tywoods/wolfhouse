'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
(async () => {
  const u = execSync('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const c = new Client({ connectionString: u, ssl: { rejectUnauthorized: false } });
  await c.connect();
  for (const table of ['workflow_published_version', 'workflow_publish_history', 'workflow_publication_outbox']) {
    const cols = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = '${table}' ORDER BY ordinal_position`);
    const sample = await c.query(`SELECT * FROM ${table} LIMIT 3`);
    console.log('\n', table, cols.rows.map((r) => r.column_name));
    console.log(sample.rows);
  }
  const stage863 = await c.query('SELECT id, active, "activeVersionId", "versionId" FROM workflow_entity WHERE id = $1', ['stage863AskLuna01']);
  console.log('\nstage863', stage863.rows);
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
