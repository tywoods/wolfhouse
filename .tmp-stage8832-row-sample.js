'use strict';
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.N8N_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query("SELECT id, \"nodeGroups\", description, \"activeVersionId\" FROM workflow_entity WHERE id = 'stage863AskLuna01'");
  console.log(JSON.stringify(r.rows[0], null, 2));
  await c.end();
})();
