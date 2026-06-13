'use strict';
const https = require('https');
const crypto = require('crypto');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_ID = 'stage16aIntakeShadow01';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const payload = {
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  from: '+15555550160',
  guest_name: 'Shadow Intake EN Complete',
  language: 'en',
  message_text: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
};

function req(method, path, key, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'X-N8N-API-KEY': key };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = https.request({ hostname: N8N_HOST, path, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf.slice(0, 600) }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  for (const label of ['stage12e-temp-proof', 'stage8832-temp-proof', 'stage16b-temp-proof']) {
    const k = await c.query('SELECT "apiKey", scopes, "userId" FROM user_api_keys WHERE label = $1', [label]);
    const key = k.rows[0]?.apiKey;
    if (!key) { console.log(label, 'NO KEY'); continue; }
    console.log('\n==', label, 'userId', k.rows[0].userId, 'scopes', k.rows[0].scopes);
    const pin = { 'Webhook - Intake Shadow Trigger': [{ json: payload }] };
    for (const [method, path, body] of [
      ['GET', `/api/v1/workflows/${WF_ID}`, null],
      ['POST', `/api/v1/workflows/${WF_ID}/run`, { workflowData: { pinData: pin } }],
      ['POST', `/rest/workflows/${WF_ID}/run`, { workflowData: { pinData: pin } }],
    ]) {
      const r = await req(method, path, key, body);
      console.log(method, path, '->', r.status, r.body.slice(0, 250));
    }
  }
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
