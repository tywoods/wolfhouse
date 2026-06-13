'use strict';
const { parse } = require('flatted');
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.N8N_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const data = await c.query('SELECT data FROM execution_data WHERE "executionId" = $1', [process.argv[2] || 6]);
  const raw = data.rows[0]?.data;
  const parsed = typeof raw === 'string' ? parse(raw) : raw;
  const runData = parsed?.resultData?.runData || {};
  console.log('nodes executed:', Object.keys(runData).join(' -> '));
  const preview = runData['HTTP - Bot Addon Preview']?.[0]?.data?.main?.[0]?.[0]?.json;
  const create = runData['HTTP - Bot Addon Create']?.[0]?.data?.main?.[0]?.[0]?.json;
  const out = runData['Code - Format DryRun Reply']?.[0]?.data?.main?.[0]?.[0]?.json
    || runData['Respond - DryRun Result']?.[0]?.data?.main?.[0]?.[0]?.json;
  console.log('preview next_action:', preview?.next_action);
  console.log('create:', JSON.stringify(create, null, 2));
  console.log('final output:', JSON.stringify(out, null, 2));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
