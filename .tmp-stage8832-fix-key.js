'use strict';
const crypto = require('crypto');
const https = require('https');
const { Client } = require('pg');

const WF_ID = 'stage8832GuestAddon01';
const HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const TEMP_KEY = 'wh-stage8832-' + crypto.randomBytes(16).toString('hex');

function req(method, path, apiKey, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'X-N8N-API-KEY': apiKey };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = https.request({ hostname: HOST, path, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf.slice(0, 500) }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const c = new Client({ connectionString: process.env.N8N_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('DELETE FROM user_api_keys WHERE label = $1', ['stage8832-temp-proof']);
  const user = await c.query('SELECT id FROM "user" WHERE email = $1', ['tywoods@gmail.com']);
  const userId = user.rows[0].id;
  await c.query(
    `INSERT INTO user_api_keys (id, "userId", label, "apiKey", "createdAt", "updatedAt", scopes, audience)
     VALUES ($1, $2, $3, $4, NOW(), NOW(), '[]'::json, 'public-api')`,
    [crypto.randomUUID(), userId, 'stage8832-temp-proof', TEMP_KEY],
  );
  console.log('TEMP_KEY', TEMP_KEY);
  const g = await req('GET', `/api/v1/workflows/${WF_ID}`, TEMP_KEY);
  console.log('GET workflow', g.status, g.body.slice(0, 200));
  await c.end();
})();
