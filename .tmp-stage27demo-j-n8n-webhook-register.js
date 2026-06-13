'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_ID = 'stage27demoJReview01';
const WF_PATH = path.join(__dirname, 'n8n', 'Luna Open Demo WhatsApp Inbound Review Pipe.json');
const WEBHOOK_PATH = 'open-demo-whatsapp-inbound-review-27j';
const WEBHOOK_ID = 'a27demoj-0027-4000-8000-000000000027';
const WEBHOOK_NODE = 'Webhook - Open Demo WhatsApp Inbound';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function bindCredentials(nodes) {
  return nodes.map((n) => {
    if (n.type !== 'n8n-nodes-base.httpRequest') return n;
    return { ...n, credentials: { httpHeaderAuth: { id: CRED_ID, name: CRED_NAME } } };
  });
}

function restartN8n(app) {
  const rev = az(`az containerapp revision list --name ${app} --resource-group wh-staging-rg --query "[?properties.trafficWeight==\`100\`].name" -o tsv`);
  console.error(`[n8n] restart ${app} revision ${rev}`);
  az(`az containerapp revision restart --name ${app} --resource-group wh-staging-rg --revision ${rev}`);
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = https.request({ hostname: N8N_HOST, path, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const u = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
  const c = new Client({ connectionString: u, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const wf = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  const nodes = bindCredentials(wf.nodes);
  await c.query(
    `UPDATE workflow_entity SET nodes = $2::json, active = true, "updatedAt" = NOW() WHERE id = $1`,
    [WF_ID, JSON.stringify(nodes)],
  );
  await c.query('DELETE FROM webhook_entity WHERE "workflowId" = $1', [WF_ID]);
  await c.query(
    `INSERT INTO webhook_entity ("webhookPath", method, node, "webhookId", "pathLength", "workflowId")
     VALUES ($1, 'POST', $2, $3, $4, $5)`,
    [WEBHOOK_PATH, WEBHOOK_NODE, WEBHOOK_ID, WEBHOOK_PATH.length, WF_ID],
  );

  restartN8n('wh-staging-n8n-main');
  restartN8n('wh-staging-n8n-worker');
  console.error('[n8n] waiting 75s...');
  await new Promise((r) => setTimeout(r, 75000));

  const hooks = await c.query('SELECT * FROM webhook_entity WHERE "workflowId" = $1', [WF_ID]);

  const wamid = `wamid.HBgMNDkxNzI2NDIyMzA3FQIAEh${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const meta = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: '1152900101233109' },
          contacts: [{ profile: { name: 'Stage27J Pipe Proof' } }],
          messages: [{
            from: '491726422307',
            id: wamid,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: 'What are the packages?' },
          }],
        },
        field: 'messages',
      }],
    }],
  };

  const wh = await req('POST', `/webhook/${WEBHOOK_PATH}`, meta);
  await new Promise((r) => setTimeout(r, 12000));
  const ex = (await c.query(
    'SELECT id, status, mode FROM execution_entity WHERE "workflowId" = $1 ORDER BY "startedAt" DESC LIMIT 1',
    [WF_ID],
  )).rows[0];

  let out = wh.body;
  if (ex) {
    const row = (await c.query('SELECT data FROM execution_data WHERE "executionId" = $1', [ex.id])).rows[0];
    const parsed = typeof row?.data === 'string' ? JSON.parse(row.data) : row?.data;
    const rd = parsed?.resultData?.runData || {};
    out = rd['Respond - Meta 200 OK']?.[0]?.data?.main?.[0]?.[0]?.json || out;
  }

  await c.query('DELETE FROM webhook_entity WHERE "workflowId" = $1', [WF_ID]);
  await c.query('UPDATE workflow_entity SET active = false, "updatedAt" = NOW() WHERE id = $1', [WF_ID]);
  restartN8n('wh-staging-n8n-main');
  restartN8n('wh-staging-n8n-worker');

  console.log(JSON.stringify({ hooks: hooks.rows, wamid, webhook_status: wh.status, webhook_body: wh.body, execution: ex, n8n_output: out }, null, 2));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
