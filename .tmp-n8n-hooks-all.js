'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
(async () => {
  const u = execSync('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const c = new Client({ connectionString: u, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const rows = await c.query(`
    SELECT w."webhookPath", w.method, w.node, w."webhookId", w."pathLength", w."workflowId", we.name, we.active
    FROM webhook_entity w
    JOIN workflow_entity we ON we.id = w."workflowId"
    ORDER BY w."webhookPath" LIMIT 20`);
  console.log(JSON.stringify(rows.rows, null, 2));
  const wf = await c.query('SELECT nodes FROM workflow_entity WHERE id = $1', ['stage863AskLuna01']);
  if (wf.rows[0]) {
    const nodes = typeof wf.rows[0].nodes === 'string' ? JSON.parse(wf.rows[0].nodes) : wf.rows[0].nodes;
    const wh = nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
    console.log('stage863 webhook node', wh);
  }
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
