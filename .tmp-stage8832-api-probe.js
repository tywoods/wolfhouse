'use strict';
const https = require('https');
const { Client } = require('pg');

const WF_ID = 'stage8832GuestAddon01';
const HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';

function req(method, path, key, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'X-N8N-API-KEY': key };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = https.request({ hostname: HOST, path, method, headers }, (res) => {
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
  const c = new Client({ connectionString: process.env.N8N_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const k = await c.query('SELECT "apiKey" FROM user_api_keys WHERE label = $1', ['stage8832-temp-proof']);
  const key = k.rows[0]?.apiKey;
  console.log('api key present:', Boolean(key));

  const paths = [
    ['GET', `/api/v1/workflows/${WF_ID}`],
    ['GET', `/api/v1/workflows/${WF_ID}/executions`],
    ['POST', `/api/v1/workflows/${WF_ID}/execute`],
    ['POST', `/api/v1/executions`],
    ['POST', `/rest/workflows/${WF_ID}/run`],
    ['POST', `/rest/workflows/run`],
  ];

  for (const [method, path] of paths) {
    const body = method === 'POST'
      ? (path.includes('/rest/workflows/run') ? { workflowId: WF_ID } : { workflowData: {} })
      : null;
    const r = await req(method, path, key, body);
    console.log(`${method} ${path} -> ${r.status}`, r.body.slice(0, 200));
  }
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
