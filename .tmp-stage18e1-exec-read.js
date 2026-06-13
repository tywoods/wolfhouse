'use strict';
const { parse } = require('flatted');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_ID = 'stage16aIntakeShadow01';

(async () => {
  const n8nUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const n8n = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
  await n8n.connect();

  const wf = await n8n.query('SELECT id, name, active, nodes FROM workflow_entity WHERE id = $1', [WF_ID]);
  const nodes = typeof wf.rows[0].nodes === 'string' ? JSON.parse(wf.rows[0].nodes) : wf.rows[0].nodes;
  const http = nodes.find((n) => n.name === 'HTTP - Guest Reply Draft');

  const ex = await n8n.query(
    `SELECT id, status, mode, "startedAt" FROM execution_entity
     WHERE "workflowId" = $1 ORDER BY "startedAt" DESC LIMIT 3`,
    [WF_ID],
  );

  const results = [];
  for (const row of ex.rows) {
    const data = await n8n.query('SELECT data FROM execution_data WHERE "executionId" = $1', [row.id]);
    const raw = data.rows[0]?.data;
    let parsed = null;
    try { parsed = typeof raw === 'string' ? parse(raw) : raw; } catch { parsed = null; }
    const rd = parsed?.resultData?.runData || {};
    results.push({
      execution_id: row.id,
      status: row.status,
      mode: row.mode,
      startedAt: row.startedAt,
      nodes: Object.keys(rd),
      has_guest_reply_draft_http: !!rd['HTTP - Guest Reply Draft'],
      has_old_preview_http: !!rd['HTTP - Message Intake Preview'],
    });
  }

  await n8n.end();
  console.log(JSON.stringify({
    workflow: { id: wf.rows[0].id, name: wf.rows[0].name, active: wf.rows[0].active },
    http_node_url: http?.parameters?.url,
    credential: http?.credentials?.httpHeaderAuth,
    executions: results,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
