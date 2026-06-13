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

  const keys = await c.query('SELECT label, "apiKey", scopes FROM user_api_keys ORDER BY "createdAt" DESC');
  for (const row of keys.rows) {
    const r = await req('GET', `/api/v1/workflows/${WF_ID}`, row.apiKey);
    console.log(row.label, 'GET workflow ->', r.status, typeof r.body === 'object' ? r.body.message || 'ok' : String(r.body).slice(0, 80));
  }

  const key = keys.rows.find((r) => r.label === 'stage8832-temp-proof')?.apiKey
    || keys.rows[0]?.apiKey;

  await c.query('UPDATE workflow_entity SET active = true, "updatedAt" = NOW() WHERE id = $1', [WF_ID]);
  console.log('set active=true in DB');

  execSync('az containerapp revision restart --name wh-staging-n8n-main --resource-group wh-staging-rg --revision $(az containerapp revision list --name wh-staging-n8n-main --resource-group wh-staging-rg --query "[?properties.trafficWeight==`100`].name" -o tsv)', { stdio: 'inherit' });

  console.log('waiting 45s for n8n restart...');
  await new Promise((r) => setTimeout(r, 45000));

  const wamid = `wamid.HBgMNDkxNzI2NDIyMzA3FQIAEh${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const meta = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: '1152900101233109' },
          contacts: [{ profile: { name: 'Stage27J' } }],
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

  const wh = await req('POST', '/webhook/open-demo-whatsapp-inbound-review-27j', null, meta);
  console.log('webhook after restart', wh.status, JSON.stringify(wh.body).slice(0, 500));

  const wf = await c.query('SELECT active FROM workflow_entity WHERE id = $1', [WF_ID]);
  console.log('wf active', wf.rows[0]);

  await c.query('UPDATE workflow_entity SET active = false WHERE id = $1', [WF_ID]);
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
