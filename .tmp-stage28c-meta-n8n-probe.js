'use strict';
/** Probe Meta override after n8n activation — temp, do not commit. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_ID = 'stage27demoLWrite01';
const PROJECT_ID = 'EZGOr9OgMVSflIF5';
const WF_PATH = path.join(__dirname, 'n8n', 'Luna Open Demo WhatsApp Booking Write Pipe.json');
const WEBHOOK_PATH = 'open-demo-whatsapp-booking-write-27l';
const WEBHOOK_ID = 'a27demol-0027-4000-8000-000000000029';
const WEBHOOK_NODE = 'Webhook - Open Demo Booking Write Inbound';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';
const PHONE_ID = '1152900101233109';
const STAGING_URL = `https://${N8N_HOST}/webhook/${WEBHOOK_PATH}`;
const VERIFY = 'wolfhouse_verify_token';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 }).trim();
}

function restartN8n() {
  for (const app of ['wh-staging-n8n-main', 'wh-staging-n8n-worker']) {
    const rev = az(`az containerapp revision list --name ${app} --resource-group wh-staging-rg --query "[?properties.trafficWeight==\`100\`].name" -o tsv`);
    if (rev) az(`az containerapp revision restart --name ${app} --resource-group wh-staging-rg --revision ${rev}`);
  }
}

function bindCredentials(nodes) {
  return nodes.map((n) => {
    if (n.type !== 'n8n-nodes-base.httpRequest') return n;
    return { ...n, credentials: { httpHeaderAuth: { id: CRED_ID, name: CRED_NAME } } };
  });
}

function httpsGet(host, reqPath) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: host, path: reqPath }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf.slice(0, 250) }));
    }).on('error', reject);
  });
}

function graphPostPhoneOverride(token, callbackUrl) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      webhook_configuration: JSON.stringify({
        override_callback_uri: callbackUrl,
        verify_token: VERIFY,
      }),
      access_token: token,
    });
    const data = params.toString();
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v21.0/${PHONE_ID}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
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

async function activateWorkflow(c) {
  const wf = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  const nodes = bindCredentials(wf.nodes);
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.query(
    `INSERT INTO workflow_history ("versionId","workflowId",authors,"createdAt","updatedAt",nodes,connections,name,autosaved,description,"nodeGroups")
     VALUES ($1::varchar,$2::varchar,$3,$4::timestamptz,$4::timestamptz,$5::json,$6::json,$7,false,$8,$9::json)`,
    [versionId, WF_ID, 'stage28c-probe', now, JSON.stringify(nodes), JSON.stringify(wf.connections), wf.name, wf.meta?.description || wf.name, JSON.stringify([])],
  );
  await c.query(
    `UPDATE workflow_entity SET nodes=$2::json,active=true,"versionId"=$3::varchar,"activeVersionId"=$3::varchar,
      "versionCounter"=COALESCE("versionCounter",0)+1,"updatedAt"=$4::timestamptz WHERE id=$1::varchar`,
    [WF_ID, JSON.stringify(nodes), versionId, now],
  );
  await c.query('DELETE FROM workflow_published_version WHERE "workflowId"=$1', [WF_ID]);
  await c.query(
    `INSERT INTO workflow_published_version ("workflowId","publishedVersionId","createdAt","updatedAt") VALUES ($1,$2,$3,$3)`,
    [WF_ID, versionId, now],
  );
  await c.query('DELETE FROM webhook_entity WHERE "workflowId"=$1', [WF_ID]);
  await c.query(
    `INSERT INTO webhook_entity ("webhookPath",method,node,"webhookId","pathLength","workflowId") VALUES ($1,'POST',$2,$3,$4,$5)`,
    [WEBHOOK_PATH, WEBHOOK_NODE, WEBHOOK_ID, WEBHOOK_PATH.length, WF_ID],
  );
  restartN8n();
  await new Promise((r) => setTimeout(r, 75000));
}

async function deactivateWorkflow(c) {
  await c.query('DELETE FROM webhook_entity WHERE "workflowId"=$1', [WF_ID]);
  await c.query('DELETE FROM workflow_published_version WHERE "workflowId"=$1', [WF_ID]);
  await c.query('UPDATE workflow_entity SET active=false,"activeVersionId"=NULL,"updatedAt"=NOW() WHERE id=$1', [WF_ID]);
  restartN8n();
}

(async () => {
  const token = az('az keyvault secret show --vault-name wh-staging-kv --name meta-whatsapp-token --query value -o tsv');
  const n8nUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
  const nc = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
  await nc.connect();

  const before = await httpsGet(N8N_HOST, `/webhook/${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=probe1`);
  await activateWorkflow(nc);
  const afterActive = await httpsGet(N8N_HOST, `/webhook/${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=probe2`);
  const overrideAttempt = await graphPostPhoneOverride(token, STAGING_URL);
  const phone = await new Promise((resolve, reject) => {
    https.get(`https://graph.facebook.com/v21.0/${PHONE_ID}?fields=display_phone_number,webhook_configuration&access_token=${encodeURIComponent(token)}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    }).on('error', reject);
  });

  await deactivateWorkflow(nc);
  const afterOff = await httpsGet(N8N_HOST, `/webhook/${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=probe3`);
  const wf = await nc.query('SELECT active FROM workflow_entity WHERE id=$1', [WF_ID]);
  await nc.end();

  console.log(JSON.stringify({
    get_verify_before_activation: before,
    get_verify_after_activation: afterActive,
    meta_override_attempt: overrideAttempt,
    phone_webhook_after: phone,
    get_verify_after_deactivation: afterOff,
    workflow_active_after_rollback: wf.rows[0]?.active,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
