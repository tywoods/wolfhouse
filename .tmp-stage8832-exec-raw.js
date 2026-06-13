'use strict';
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.N8N_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const data = await c.query('SELECT data FROM execution_data WHERE "executionId" = 6');
  const raw = data.rows[0]?.data;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  console.log('top keys:', Object.keys(parsed || {}));
  console.log('resultData keys:', Object.keys(parsed?.resultData || {}));
  console.log('stringified sample:', JSON.stringify(parsed).slice(0, 2000));
  await c.end();
})();
