'use strict';
const { parse } = require('flatted');
const { Client } = require('pg');
const { execSync } = require('child_process');

(async () => {
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const ex = await c.query(
    `SELECT id, status, mode, "startedAt" FROM execution_entity
     WHERE "workflowId" = 'stage16aIntakeShadow01' ORDER BY "startedAt" DESC LIMIT 5`,
  );
  console.log('executions:', JSON.stringify(ex.rows, null, 2));
  const wf = await c.query(
    'SELECT id, name, active FROM workflow_entity WHERE id = $1',
    ['stage16aIntakeShadow01'],
  );
  console.log('workflow:', wf.rows[0]);
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
