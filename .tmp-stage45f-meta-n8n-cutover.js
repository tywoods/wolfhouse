'use strict';
/** Point Meta demo phone callback to staging n8n review pipe webhook. Temp */

const https = require('https');
const { execSync } = require('child_process');

const DEMO_PHONE_ID = '1152900101233109';
const VERIFY_TOKEN = 'wolfhouse_verify_token';
const N8N_WEBHOOK_URL = 'https://wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io/webhook/open-demo-whatsapp-inbound-review-27j';

function az(cmd) { return execSync(cmd, { encoding: 'utf8' }).trim(); }

function graphGet(token) {
  return new Promise((resolve, reject) => {
    https.get(`https://graph.facebook.com/v21.0/${DEMO_PHONE_ID}?fields=display_phone_number,webhook_configuration&access_token=${encodeURIComponent(token)}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    }).on('error', reject);
  });
}

function graphOverride(token, callbackUrl) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      webhook_configuration: JSON.stringify({ override_callback_uri: callbackUrl, verify_token: VERIFY_TOKEN }),
      access_token: token,
    });
    const data = params.toString();
    const req = https.request({
      hostname: 'graph.facebook.com', path: `/v21.0/${DEMO_PHONE_ID}`, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  const token = az('az keyvault secret show --vault-name wh-staging-kv --name meta-whatsapp-token --query value -o tsv');
  const before = await graphGet(token);
  const prev = before?.webhook_configuration?.application || before?.webhook_configuration?.phone_number;
  let override = null;
  if (prev !== N8N_WEBHOOK_URL) {
    override = await graphOverride(token, N8N_WEBHOOK_URL);
    await new Promise((r) => setTimeout(r, 2000));
  }
  const after = await graphGet(token);
  console.log(JSON.stringify({ before: before?.webhook_configuration, override, after: after?.webhook_configuration, n8n_webhook_url: N8N_WEBHOOK_URL }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
