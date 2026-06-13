'use strict';
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.N8N_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const keys = await c.query('SELECT id, label, LEFT("apiKey", 20) AS prefix, "userId", scopes FROM user_api_keys ORDER BY "createdAt" DESC LIMIT 5');
  console.log(JSON.stringify(keys.rows, null, 2));
  await c.end();
})();
