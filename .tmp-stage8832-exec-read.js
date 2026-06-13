'use strict';
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.N8N_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const ex = await c.query(
    `SELECT id, status, mode, "startedAt", "stoppedAt" FROM execution_entity
     WHERE "workflowId" = 'stage8832GuestAddon01' ORDER BY "startedAt" DESC LIMIT 3`,
  );
  console.log('executions:', JSON.stringify(ex.rows, null, 2));
  if (ex.rows[0]) {
    const data = await c.query('SELECT data FROM execution_data WHERE "executionId" = $1', [ex.rows[0].id]);
    const raw = data.rows[0]?.data;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const rd = parsed?.resultData?.runData || {};
    const nodes = Object.keys(rd);
    console.log('run nodes:', nodes.join(', '));
    const out = rd['Code - Format DryRun Reply']?.[0]?.data?.main?.[0]?.[0]?.json
      || rd['Respond - DryRun Result']?.[0]?.data?.main?.[0]?.[0]?.json;
    console.log('output:', JSON.stringify(out, null, 2));
  }
  const wf = await c.query('SELECT active FROM workflow_entity WHERE id = $1', ['stage8832GuestAddon01']);
  console.log('active:', wf.rows[0]?.active);
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
