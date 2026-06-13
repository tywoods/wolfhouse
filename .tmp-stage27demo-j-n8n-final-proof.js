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

function restartMain() {
  const rev = az('az containerapp revision list --name wh-staging-n8n-main --resource-group wh-staging-rg --query "[?properties.trafficWeight==`100`].name" -o tsv');
  az(`az containerapp revision restart --name wh-staging-n8n-main --resource-group wh-staging-rg --revision ${rev}`);
}

function postWebhook(meta) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(meta);
    const req = https.request({
      hostname: N8N_HOST,
      path: `/webhook/${WEBHOOK_PATH}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  const u = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
  const c = new Client({ connectionString: u, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const wf = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  const nodes = bindCredentials(wf.nodes);
  const versionId = crypto.randomUUID();
  const now = new Date();

  await c.query(
    `INSERT INTO workflow_history (
      "versionId", "workflowId", authors, "createdAt", "updatedAt", nodes, connections, name, autosaved, description, "nodeGroups"
    ) VALUES ($1::varchar, $2::varchar, $3, $4::timestamptz, $4::timestamptz, $5::json, $6::json, $7, false, $8, $9::json)`,
    [versionId, WF_ID, 'stage27demo-j-proof', now.toISOString(), JSON.stringify(nodes),
      JSON.stringify(wf.connections), wf.name, wf.meta?.description || wf.name, JSON.stringify([])],
  );

  await c.query(
    `UPDATE workflow_entity SET
      nodes = $2::json, active = true, "versionId" = $3::varchar, "activeVersionId" = $3::varchar,
      "versionCounter" = COALESCE("versionCounter", 0) + 1, "updatedAt" = $4::timestamptz
     WHERE id = $1::varchar`,
    [WF_ID, JSON.stringify(nodes), versionId, now.toISOString()],
  );

  await c.query('DELETE FROM workflow_published_version WHERE "workflowId" = $1', [WF_ID]);
  await c.query(
    `INSERT INTO workflow_published_version ("workflowId", "publishedVersionId", "createdAt", "updatedAt")
     VALUES ($1::varchar, $2::varchar, $3::timestamptz, $3::timestamptz)`,
    [WF_ID, versionId, now.toISOString()],
  );

  await c.query('DELETE FROM webhook_entity WHERE "workflowId" = $1', [WF_ID]);
  await c.query(
    `INSERT INTO webhook_entity ("webhookPath", method, node, "webhookId", "pathLength", "workflowId")
     VALUES ($1, 'POST', $2, $3, $4, $5)`,
    [WEBHOOK_PATH, WEBHOOK_NODE, WEBHOOK_ID, WEBHOOK_PATH.length, WF_ID],
  );

  restartMain();
  console.error('[wait] 60s');
  await new Promise((r) => setTimeout(r, 60000));

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

  const wh = await postWebhook(meta);
  await new Promise((r) => setTimeout(r, 15000));

  const ex = (await c.query(
    'SELECT id, status, mode FROM execution_entity WHERE "workflowId" = $1 ORDER BY "startedAt" DESC LIMIT 1',
    [WF_ID],
  )).rows[0];

  const wrong = JSON.parse(JSON.stringify(meta));
  wrong.entry[0].changes[0].value.metadata.phone_number_id = '9999999999999999';
  const neg = await postWebhook(wrong);

  const replay = await postWebhook(meta);

  // rollback
  await c.query('DELETE FROM webhook_entity WHERE "workflowId" = $1', [WF_ID]);
  await c.query('DELETE FROM workflow_published_version WHERE "workflowId" = $1', [WF_ID]);
  await c.query('UPDATE workflow_entity SET active = false, "activeVersionId" = NULL, "updatedAt" = NOW() WHERE id = $1', [WF_ID]);
  restartMain();

  console.log(JSON.stringify({
    versionId,
    wamid,
    webhook: { status: wh.status, body: wh.body },
    negative: { status: neg.status, body: neg.body },
    idempotency_replay: { status: replay.status, body: replay.body },
    execution: ex,
  }, null, 2));

  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
