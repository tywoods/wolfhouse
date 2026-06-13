'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
(async () => {
  const u = execSync('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const c = new Client({ connectionString: u, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const cols = await c.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'workflow_entity' ORDER BY ordinal_position");
  const wf = await c.query('SELECT * FROM workflow_entity WHERE id = $1', ['stage27demoJReview01']);
  const hist = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%workflow%' ORDER BY table_name");
  console.log('workflow columns', cols.rows.map((r) => r.column_name));
  console.log('workflow row keys', Object.keys(wf.rows[0] || {}));
  console.log('workflow', {
    id: wf.rows[0]?.id,
    active: wf.rows[0]?.active,
    activeVersionId: wf.rows[0]?.activeVersionId,
    versionId: wf.rows[0]?.versionId,
    versionCounter: wf.rows[0]?.versionCounter,
  });
  console.log('workflow tables', hist.rows);
  if (hist.rows.some((r) => r.table_name === 'workflow_history')) {
    const wh = await c.query('SELECT * FROM workflow_history WHERE "workflowId" = $1', ['stage27demoJReview01']);
    console.log('workflow_history', wh.rows);
  }
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
