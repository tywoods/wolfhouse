'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');

(async () => {
  const url = process.env.N8N_DATABASE_URL || execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const data = await c.query('SELECT data, "workflowData" FROM execution_data WHERE "executionId" = 8');
  const raw = data.rows[0]?.data;
  console.log('data type:', typeof raw, 'len:', raw ? (typeof raw === 'string' ? raw.length : JSON.stringify(raw).length) : 0);
  if (typeof raw === 'string') {
    console.log('prefix:', raw.slice(0, 500));
    try {
      const p = JSON.parse(raw);
      console.log('top keys:', Object.keys(p));
      if (p.resultData) console.log('resultData keys:', Object.keys(p.resultData));
    } catch (e) {
      console.log('parse err', e.message);
    }
  } else if (raw) {
    console.log('object keys:', Object.keys(raw));
    console.log(JSON.stringify(raw, null, 2).slice(0, 2000));
  }
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
