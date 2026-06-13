'use strict';
const crypto = require('crypto');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_ID = 'stage27demoJReview01';
const WEBHOOK_PATH = 'open-demo-whatsapp-inbound-review-27j';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
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

function restartN8n() {
  const rev = az('az containerapp revision list --name wh-staging-n8n-main --resource-group wh-staging-rg --query "[?properties.trafficWeight==`100`].name" -o tsv');
  console.error('[n8n] restarting revision', rev);
  az(`az containerapp revision restart --name wh-staging-n8n-main --resource-group wh-staging-rg --revision ${rev}`);
}

(async () => {
  const u = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
  const c = new Client({ connectionString: u, ssl: { rejectUnauthorized: false } });
  await c.connect();

  await c.query('UPDATE workflow_entity SET active = true, "updatedAt" = NOW() WHERE id = $1', [WF_ID]);
  restartN8n();
  console.error('[n8n] waiting 60s...');
  await new Promise((r) => setTimeout(r, 60000));

  const hooks = await c.query(
    'SELECT "workflowId", method, path, node FROM webhook_entity WHERE path = $1 OR "workflowId" = $2',
    [WEBHOOK_PATH, WF_ID],
  );
  console.log('webhook_entity', hooks.rows);

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
  console.log('webhook POST', wh.status, JSON.stringify(wh.body, null, 2));

  await new Promise((r) => setTimeout(r, 8000));
  const ex = (await c.query(
    'SELECT id, status, mode FROM execution_entity WHERE "workflowId" = $1 ORDER BY "startedAt" DESC LIMIT 1',
    [WF_ID],
  )).rows[0];
  console.log('execution', ex);

  let out = null;
  if (ex) {
    const row = (await c.query('SELECT data FROM execution_data WHERE "executionId" = $1', [ex.id])).rows[0];
    const parsed = typeof row?.data === 'string' ? JSON.parse(row.data) : row?.data;
    const rd = parsed?.resultData?.runData || {};
    out = rd['Respond - Meta 200 OK']?.[0]?.data?.main?.[0]?.[0]?.json
      || rd['Code - Map Staff API Debug Response']?.[0]?.data?.main?.[0]?.[0]?.json;
  }

  const wrongMeta = JSON.parse(JSON.stringify(meta));
  wrongMeta.entry[0].changes[0].value.metadata.phone_number_id = '9999999999999999';
  const neg = await req('POST', `/webhook/${WEBHOOK_PATH}`, wrongMeta);
  console.log('negative webhook', neg.status, JSON.stringify(neg.body, null, 2));

  await c.query('UPDATE workflow_entity SET active = false, "updatedAt" = NOW() WHERE id = $1', [WF_ID]);
  restartN8n();

  console.log(JSON.stringify({ wamid, webhook: wh, execution: ex, n8n_output: out, negative: neg }, null, 2));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
