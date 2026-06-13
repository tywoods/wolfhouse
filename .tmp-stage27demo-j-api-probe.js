'use strict';
const crypto = require('crypto');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_ID = 'stage27demoJReview01';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';

function req(method, path, key, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = key ? { 'X-N8N-API-KEY': key } : {};
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
  const u = execSync('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const c = new Client({ connectionString: u, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const k8832 = (await c.query('SELECT "apiKey" FROM user_api_keys WHERE label = $1', ['stage8832-temp-proof'])).rows[0]?.apiKey;
  const k27j = (await c.query('SELECT "apiKey" FROM user_api_keys WHERE label = $1', ['stage27demoJ-temp-proof'])).rows[0]?.apiKey;

  for (const [label, key] of [['8832', k8832], ['27j', k27j]]) {
    if (!key) continue;
    const get = await req('GET', `/api/v1/workflows/${WF_ID}`, key);
    console.log(label, 'GET', get.status);
    const act = await req('POST', `/api/v1/workflows/${WF_ID}/activate`, key);
    console.log(label, 'ACTIVATE', act.status, JSON.stringify(act.body).slice(0, 200));
  }

  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
