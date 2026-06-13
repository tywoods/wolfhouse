'use strict';
const { parse } = require('flatted');
const { Client } = require('pg');
const { execSync } = require('child_process');

(async () => {
  const url = process.env.N8N_DATABASE_URL || execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const ex = await c.query(
    `SELECT id, status, mode, "startedAt", "stoppedAt" FROM execution_entity
     WHERE "workflowId" = 'stage8510SharedDryRun01' ORDER BY "startedAt" DESC LIMIT 2`,
  );
  console.log('executions:', JSON.stringify(ex.rows, null, 2));
  if (ex.rows[0]) {
    const data = await c.query('SELECT data FROM execution_data WHERE "executionId" = $1', [ex.rows[0].id]);
    const raw = data.rows[0]?.data;
    const parsed = typeof raw === 'string' ? parse(raw) : raw;
    const rd = parsed?.resultData?.runData || {};
    console.log('run nodes:', Object.keys(rd).join(', '));
    const http = rd['HTTP - Bot Booking Dry Run']?.[0]?.data?.main?.[0]?.[0]?.json;
    const out = rd['Respond - DryRun Result']?.[0]?.data?.main?.[0]?.[0]?.json
      || rd['Code - Map Dry Run Response']?.[0]?.data?.main?.[0]?.[0]?.json;
    console.log('http_status_evidence:', http?.success, http?.dry_run, http?.staff_api_endpoint);
    console.log('output:', JSON.stringify(out, null, 2));
    const err = parsed?.resultData?.error;
    if (err) console.log('error:', JSON.stringify(err, null, 2));
  }
  const wf = await c.query('SELECT active FROM workflow_entity WHERE id = $1', ['stage8510SharedDryRun01']);
  console.log('active:', wf.rows[0]?.active);
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
