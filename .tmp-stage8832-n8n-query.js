'use strict';
const { Client } = require('pg');

(async () => {
  const c = new Client({
    connectionString: process.env.N8N_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  const wfs = await c.query(
    "SELECT id, name, active FROM workflow_entity WHERE name ILIKE '%Guest Add-on%' OR id ILIKE '%8832%' ORDER BY name"
  );
  console.log('workflows:', JSON.stringify(wfs.rows, null, 2));
  const creds = await c.query(
    "SELECT id, name, type FROM credentials_entity WHERE name ILIKE '%Luna Bot%'"
  );
  console.log('creds:', JSON.stringify(creds.rows, null, 2));
  const proj = await c.query('SELECT id, name FROM project LIMIT 3');
  console.log('projects:', JSON.stringify(proj.rows, null, 2));
  const sample = await c.query(
    "SELECT id, name, active, LEFT(nodes::text, 300) AS nodes_preview FROM workflow_entity WHERE id = 'stage863AskLuna01'"
  );
  if (sample.rows[0]) {
    const nodes = await c.query(
      "SELECT nodes FROM workflow_entity WHERE id = 'stage863AskLuna01'"
    );
    const n = nodes.rows[0].nodes;
    const http = n.filter((x) => x.type === 'n8n-nodes-base.httpRequest');
    console.log('ask-luna http cred sample:', JSON.stringify(http[0]?.credentials, null, 2));
  }
  await c.end();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
