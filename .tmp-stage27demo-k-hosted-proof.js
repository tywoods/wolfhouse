'use strict';
/** Stage 27demo-k hosted proof — temp, do not commit. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_ID = 'stage27demoKLive01';
const PROJECT_ID = 'EZGOr9OgMVSflIF5';
const WF_PATH = path.join(__dirname, 'n8n', 'Luna Open Demo WhatsApp Inbound Live Reply Pipe.json');
const WEBHOOK_PATH = 'open-demo-whatsapp-inbound-live-reply-27k';
const WEBHOOK_ID = 'a27demok-0027-4000-8000-000000000028';
const WEBHOOK_NODE = 'Webhook - Open Demo Live Reply Inbound';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';
const DEMO_PHONE_ID = '1152900101233109';
const PROOF_PHONE = '+491726422307';
const PROOF_MESSAGE = 'What are the packages?';

const BASELINE_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
};

const LIVE_ENV = {
  ...BASELINE_ENV,
  WHATSAPP_DRY_RUN: 'false',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
};

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function setEnvVars(pairs) {
  const parts = Object.entries(pairs).map(([k, v]) => `${k}=${v}`);
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--set-env-vars ${parts.join(' ')}`,
    '-o none',
  ].join(' '));
}

function envPick(names) {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    out[n] = e ? (e.secretRef ? `(secret:${e.secretRef})` : e.value) : null;
  }
  return out;
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

function restartN8nMain() {
  const rev = az('az containerapp revision list --name wh-staging-n8n-main --resource-group wh-staging-rg --query "[?properties.trafficWeight==`100`].name" -o tsv');
  az(`az containerapp revision restart --name wh-staging-n8n-main --resource-group wh-staging-rg --revision ${rev}`);
}

function bindCredentials(nodes) {
  return nodes.map((n) => {
    if (n.type !== 'n8n-nodes-base.httpRequest') return n;
    return { ...n, credentials: { httpHeaderAuth: { id: CRED_ID, name: CRED_NAME } } };
  });
}

function buildMeta(wamid) {
  const from = PROOF_PHONE.replace(/^\+/, '');
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: DEMO_PHONE_ID },
          contacts: [{ profile: { name: 'Stage27K Live Proof' } }],
          messages: [{
            from,
            id: wamid,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: PROOF_MESSAGE },
          }],
        },
        field: 'messages',
      }],
    }],
  };
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

async function activateWorkflow(c) {
  const wf = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  const nodes = bindCredentials(wf.nodes);
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();

  const existing = await c.query('SELECT id FROM workflow_entity WHERE id = $1', [WF_ID]);
  if (!existing.rows.length) {
    await c.query(
      `INSERT INTO workflow_entity (
        id, name, active, nodes, connections, settings, "staticData", "pinData",
        "versionId", "triggerCount", meta, "parentFolderId", "isArchived", "versionCounter",
        description, "activeVersionId", "nodeGroups", "createdAt", "updatedAt"
      ) VALUES ($1,$2,false,$3::json,$4::json,$5::json,$6,$7::json,$8,0,$9::json,$10,false,1,$11,$12,$13::json,$14,$14)`,
      [WF_ID, wf.name, JSON.stringify(nodes), JSON.stringify(wf.connections), JSON.stringify(wf.settings || {}),
        null, null, versionId, JSON.stringify(wf.meta || {}), null, wf.meta?.description || wf.name, null,
        JSON.stringify([]), now],
    );
    await c.query(
      `INSERT INTO shared_workflow ("workflowId", "projectId", role, "createdAt", "updatedAt")
       VALUES ($1, $2, 'workflow:owner', NOW(), NOW()) ON CONFLICT DO NOTHING`,
      [WF_ID, PROJECT_ID],
    );
  }

  await c.query(
    `INSERT INTO workflow_history (
      "versionId", "workflowId", authors, "createdAt", "updatedAt", nodes, connections, name, autosaved, description, "nodeGroups"
    ) VALUES ($1::varchar, $2::varchar, $3, $4::timestamptz, $4::timestamptz, $5::json, $6::json, $7, false, $8, $9::json)`,
    [versionId, WF_ID, 'stage27demo-k-proof', now, JSON.stringify(nodes),
      JSON.stringify(wf.connections), wf.name, wf.meta?.description || wf.name, JSON.stringify([])],
  );

  await c.query(
    `UPDATE workflow_entity SET nodes = $2::json, active = true, "versionId" = $3::varchar,
      "activeVersionId" = $3::varchar, "versionCounter" = COALESCE("versionCounter", 0) + 1, "updatedAt" = $4::timestamptz
     WHERE id = $1::varchar`,
    [WF_ID, JSON.stringify(nodes), versionId, now],
  );

  await c.query('DELETE FROM workflow_published_version WHERE "workflowId" = $1', [WF_ID]);
  await c.query(
    `INSERT INTO workflow_published_version ("workflowId", "publishedVersionId", "createdAt", "updatedAt")
     VALUES ($1::varchar, $2::varchar, $3::timestamptz, $3::timestamptz)`,
    [WF_ID, versionId, now],
  );

  await c.query('DELETE FROM webhook_entity WHERE "workflowId" = $1', [WF_ID]);
  await c.query(
    `INSERT INTO webhook_entity ("webhookPath", method, node, "webhookId", "pathLength", "workflowId")
     VALUES ($1, 'POST', $2, $3, $4, $5)`,
    [WEBHOOK_PATH, WEBHOOK_NODE, WEBHOOK_ID, WEBHOOK_PATH.length, WF_ID],
  );

  restartN8nMain();
  await new Promise((r) => setTimeout(r, 60000));
}

async function deactivateWorkflow(c) {
  await c.query('DELETE FROM webhook_entity WHERE "workflowId" = $1', [WF_ID]);
  await c.query('DELETE FROM workflow_published_version WHERE "workflowId" = $1', [WF_ID]);
  await c.query('UPDATE workflow_entity SET active = false, "activeVersionId" = NULL, "updatedAt" = NOW() WHERE id = $1', [WF_ID]);
  restartN8nMain();
}

async function dbSnapshot(since, wamid) {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const sendsBefore = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE to_phone = $1`, [PROOF_PHONE],
  );
  const sendsSince = await pg.query(
    `SELECT id::text, status, provider_message_id, message_text, created_at, idempotency_key
       FROM guest_message_sends WHERE to_phone = $1 AND created_at >= $2::timestamptz
       ORDER BY created_at DESC`, [PROOF_PHONE, since],
  );
  const bookings = await pg.query(
    `SELECT COUNT(*)::int AS n FROM bookings b
       INNER JOIN clients cl ON cl.id = b.client_id
      WHERE cl.slug = 'wolfhouse-somo' AND b.phone = $1 AND b.created_at >= $2::timestamptz`,
    [PROOF_PHONE, since],
  );
  const payments = await pg.query(
    `SELECT COUNT(*)::int AS n FROM payments WHERE created_at >= $1::timestamptz`, [since],
  );
  const conv = await pg.query(`
    SELECT c.id::text, c.last_message_preview, LEFT(c.staff_reply_draft, 120) AS draft_preview
      FROM conversations c
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND c.phone = $1
     ORDER BY c.updated_at DESC LIMIT 1`, [PROOF_PHONE]);

  await pg.end();
  return {
    guest_message_sends_total: sendsBefore.rows[0].n,
    guest_message_sends_since: sendsSince.rows,
    bookings_since: bookings.rows[0].n,
    payments_since: payments.rows[0].n,
    conversation: conv.rows[0] || null,
    wamid,
  };
}

(async () => {
  const proofStart = new Date().toISOString();
  const out = {
    stage: '27demo-k',
    proof_message: PROOF_MESSAGE,
    proof_phone: PROOF_PHONE,
    demo_phone_number_id: DEMO_PHONE_ID,
    n8n_workflow_name: 'Luna Open Demo WhatsApp Inbound Live Reply Pipe',
    n8n_workflow_id: WF_ID,
    webhook_path: WEBHOOK_PATH,
    proof_start: proofStart,
  };

  try {
    const hz = execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${STAFF_HOST}/healthz`, { encoding: 'utf8' }).trim();
    out.healthz = Number(hz);
    out.revision = activeRevision();

    console.error('[env] baseline gates...');
    setEnvVars(BASELINE_ENV);
    out.env_before = envPick(Object.keys(BASELINE_ENV));

    const n8nUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
    const nc = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
    await nc.connect();

    console.error('[n8n] activate live-reply workflow...');
    await activateWorkflow(nc);

    const preWamid = `wamid.HBgMNDkxNzI2NDIyMzA3FQIAEh${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    console.error('[pre-live] blocked proof...');
    const preDbBefore = await dbSnapshot(proofStart, preWamid);
    const preLive = await postWebhook(buildMeta(preWamid));
    await new Promise((r) => setTimeout(r, 5000));
    out.pre_live = {
      wamid: preWamid,
      webhook_status: preLive.status,
      body: preLive.body,
      db_before: preDbBefore,
    };

    console.error('[env] live-send window...');
    setEnvVars(LIVE_ENV);
    out.env_during = envPick(Object.keys(BASELINE_ENV));
    await new Promise((r) => setTimeout(r, 15000));

    const liveWamid = `wamid.HBgMNDkxNzI2NDIyMzA3FQIAEh${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    const sendsCountBeforeLive = await dbSnapshot(proofStart, liveWamid);
    console.error('[live] send proof...');
    const live = await postWebhook(buildMeta(liveWamid));
    await new Promise((r) => setTimeout(r, 8000));

    const ex = (await nc.query(
      'SELECT id, status, mode FROM execution_entity WHERE "workflowId" = $1 ORDER BY "startedAt" DESC LIMIT 1',
      [WF_ID],
    )).rows[0];

    out.live = {
      wamid: liveWamid,
      webhook_status: live.status,
      body: live.body,
      execution: ex,
      sends_before_live_count: sendsCountBeforeLive.guest_message_sends_since.length,
    };

    console.error('[restore] gates + deactivate n8n...');
    setEnvVars(BASELINE_ENV);
    await deactivateWorkflow(nc);
    const wfAfter = await nc.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
    out.n8n_workflow_after = wfAfter.rows[0];
    await nc.end();

    out.env_after = envPick(Object.keys(BASELINE_ENV));
    out.db_after = await dbSnapshot(proofStart, liveWamid);

    const pre = preLive.body || {};
    const liveBody = live.body || {};
    const newSends = out.db_after.guest_message_sends_since.filter((r) => r.status === 'sent');
    const liveSend = newSends.find((r) => r.idempotency_key && r.idempotency_key.includes(liveWamid.replace(/\./g, '')))
      || newSends[0];

    out.checks = {
      healthz_200: out.healthz === 200,
      pre_live_success: pre.staff_api_success === true,
      pre_live_blocked: pre.live_send_blocked === true && pre.whatsapp_sent !== true && pre.sends_whatsapp !== true,
      pre_live_has_reply: /package|malibu|uluwatu|waimea/i.test(String(pre.proposed_luna_reply || '')),
      live_success: liveBody.staff_api_success === true,
      live_whatsapp_sent: liveBody.whatsapp_sent === true && liveBody.sends_whatsapp === true,
      live_unblocked: liveBody.live_send_blocked === false,
      live_send_status: liveBody.guest_message_send_status === 'sent',
      provider_message_id: Boolean(liveBody.provider_message_id || liveBody.whatsapp_message_id),
      n8n_execution_success: ex?.status === 'success',
      sends_delta_one: newSends.length >= 1,
      no_bookings: out.db_after.bookings_since === 0,
      no_payments_spike: out.db_after.payments_since === 0,
      workflow_inactive: out.n8n_workflow_after?.active === false,
      gates_restored: out.env_after.WHATSAPP_DRY_RUN === 'true'
        && out.env_after.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'false',
    };
    out.provider_message_id = liveBody.provider_message_id || liveBody.whatsapp_message_id || liveSend?.provider_message_id || null;
    out.verdict = Object.values(out.checks).every(Boolean) ? 'PASS' : 'PARTIAL';
  } catch (err) {
    out.error = err.message;
    out.verdict = 'FAIL';
    try { setEnvVars(BASELINE_ENV); } catch { /* best effort */ }
  }

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
