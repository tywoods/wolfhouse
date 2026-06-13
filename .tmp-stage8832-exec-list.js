'use strict';
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.N8N_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const ex = await c.query(
    `SELECT id, status, mode, "startedAt", "stoppedAt" FROM execution_entity
     WHERE "workflowId" = 'stage8832GuestAddon01' ORDER BY "startedAt" DESC LIMIT 2`,
  );
  console.log(JSON.stringify(ex.rows, null, 2));
  await c.end();
})();
