'use strict';
const crypto = require('crypto');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_ID = 'stage27demoJReview01';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const DEMO = '1152900101233109';
const PHONE = '+491726422307';
const MSG = 'What are the packages?';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function req(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const r = https.request({ hostname: N8N_HOST, path, method, headers: h }, (res) => {
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
  const n8nUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
  const c = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();

  let apiKey = (await c.query(
    'SELECT "apiKey" FROM user_api_keys WHERE label = $1 LIMIT 1',
    ['stage27demoJ-temp-proof'],
  )).rows[0]?.apiKey;

  if (!apiKey) {
    const uid = (await c.query('SELECT id FROM "user" LIMIT 1')).rows[0].id;
    apiKey = `wh-s27j-${crypto.randomBytes(16).toString('hex')}`;
    await c.query(
      'INSERT INTO user_api_keys (id, "userId", label, "apiKey", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,NOW(),NOW())',
      [crypto.randomUUID(), uid, 'stage27demoJ-temp-proof', apiKey],
    );
  }

  const wamid = `wamid.HBgMNDkxNzI2NDIyMzA3FQIAEh${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const from = PHONE.replace(/^\+/, '');
  const meta = {
    object: 'whatsapp_business_account',
    entry: [{
      id: '842343435599477',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '34663439419', phone_number_id: DEMO },
          contacts: [{ profile: { name: 'Stage27J' }, wa_id: from }],
          messages: [{
            from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text',
            text: { body: MSG },
          }],
        },
        field: 'messages',
      }],
    }],
  };
  const pin = { 'Webhook - Open Demo WhatsApp Inbound': [{ json: { body: meta } }] };

  const activate = await req('POST', `/api/v1/workflows/${WF_ID}/activate`, { 'X-N8N-API-KEY': apiKey });
  console.log('activate', activate.status, JSON.stringify(activate.body).slice(0, 300));

  const run = await req('POST', `/api/v1/workflows/${WF_ID}/run`, { 'X-N8N-API-KEY': apiKey }, {
    workflowData: { pinData: pin },
  });
  console.log('run', run.status, JSON.stringify(run.body).slice(0, 300));

  await new Promise((r) => setTimeout(r, 15000));

  const ex = (await c.query(
    'SELECT id, status, mode FROM execution_entity WHERE "workflowId" = $1 ORDER BY "startedAt" DESC LIMIT 1',
    [WF_ID],
  )).rows[0];
  console.log('exec', ex);

  let out = null;
  if (ex) {
    const row = (await c.query('SELECT data FROM execution_data WHERE "executionId" = $1', [ex.id])).rows[0];
    const parsed = typeof row?.data === 'string' ? JSON.parse(row.data) : row?.data;
    const rd = parsed?.resultData?.runData || {};
    out = rd['Respond - Meta 200 OK']?.[0]?.data?.main?.[0]?.[0]?.json
      || rd['Code - Map Staff API Debug Response']?.[0]?.data?.main?.[0]?.[0]?.json
      || rd['HTTP - Open Demo Inbound Review']?.[0]?.data?.main?.[0]?.[0]?.json;
  }

  const webhook = await req('POST', `/webhook/${'open-demo-whatsapp-inbound-review-27j'}`, {}, meta);
  console.log('webhook', webhook.status, JSON.stringify(webhook.body).slice(0, 400));

  await req('POST', `/api/v1/workflows/${WF_ID}/deactivate`, { 'X-N8N-API-KEY': apiKey });
  await c.query('UPDATE workflow_entity SET active = false WHERE id = $1', [WF_ID]);
  await c.end();

  console.log(JSON.stringify({ wamid, execution: ex, n8n_output: out, webhook_status: webhook.status, webhook_body: webhook.body }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
