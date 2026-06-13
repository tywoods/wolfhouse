'use strict';
/**
 * Stage 8.8.32 — import guest addon dry-run workflow + hosted execution proof
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });

const WF_PATH = path.join(__dirname, 'n8n', 'Wolfhouse Guest Add-on Request - Dry Run.json');
const WF_ID = 'stage8832GuestAddon01';
const PROJECT_ID = 'EZGOr9OgMVSflIF5';
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const WEBHOOK_PATH = 'guest-addon-dry-run-8831';
const BOOKING_CODE = 'MB-WOLFHO-20260901-cb4799';
const BOOKING_ID = 'e15b7554-c766-4357-beb3-d23262e3b7b8';
const SERVICE_DATE = '2026-09-04';
const STATE_FILE = path.join(__dirname, '.tmp-stage8832-state.json');

const PAYLOAD = {
  client_slug: 'wolfhouse-somo',
  booking_code: BOOKING_CODE,
  guest_phone: '+34999000123',
  service_type: 'wetsuit',
  service_date: SERVICE_DATE,
  quantity: 1,
  payment_choice: 'pay_now',
  source: 'luna_whatsapp',
};

const IDEMPOTENCY_KEY = [
  PAYLOAD.booking_code,
  PAYLOAD.service_type,
  PAYLOAD.service_date,
  String(PAYLOAD.quantity),
  PAYLOAD.guest_phone.replace(/\+/g, ''),
].join('-').slice(0, 120);

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function httpsReq(method, hostname, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ hostname, path: reqPath, method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep string */ }
        resolve({ status: res.statusCode, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function bindCredentials(nodes) {
  return nodes.map((n) => {
    if (n.type !== 'n8n-nodes-base.httpRequest') return n;
    const copy = { ...n, credentials: { httpHeaderAuth: { id: CRED_ID, name: CRED_NAME } } };
    return copy;
  });
}

function safetyCheck(wf) {
  const nodeBlob = JSON.stringify(wf.nodes);
  const checks = [
    ['no graph.facebook.com', !/graph\.facebook\.com/i.test(nodeBlob)],
    ['no Twilio', !/twilio/i.test(nodeBlob)],
    ['no api.stripe.com', !/api\.stripe\.com/i.test(nodeBlob)],
    ['no WhatsApp send node', !wf.nodes.some((n) => /whatsapp.*send|send.*whatsapp/i.test(n.name || ''))],
    ['active false in repo', wf.active === false],
    ['http cred name', wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest').every(
      (n) => n.credentials?.httpHeaderAuth?.name === CRED_NAME,
    )],
  ];
  return checks;
}

async function importWorkflow(c) {
  const wf = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  const nodes = bindCredentials(wf.nodes);
  const now = new Date();
  const versionId = crypto.randomUUID();

  const existing = await c.query(
    'SELECT id, name, active FROM workflow_entity WHERE id = $1 OR name = $2',
    [WF_ID, wf.name],
  );

  const pinData = {
    'Webhook - Guest Addon DryRun Trigger': [{ json: PAYLOAD }],
  };

  const meta = wf.meta || {};
  const row = {
    id: WF_ID,
    name: wf.name,
    active: false,
    nodes: JSON.stringify(nodes),
    connections: JSON.stringify(wf.connections),
    settings: JSON.stringify(wf.settings || {}),
    staticData: null,
    pinData: JSON.stringify(pinData),
    versionId,
    triggerCount: 0,
    meta: JSON.stringify(meta),
    parentFolderId: null,
    isArchived: false,
    versionCounter: 1,
    description: meta.description || wf.name,
    activeVersionId: null,
    nodeGroups: [],
    createdAt: now,
    updatedAt: now,
  };

  if (existing.rows.length) {
    await c.query(
      `UPDATE workflow_entity SET
        name = $2, active = $3, nodes = $4::json, connections = $5::json, settings = $6::json,
        "staticData" = $7, "pinData" = $8::json, "versionId" = $9, meta = $10::json,
        "updatedAt" = $11
       WHERE id = $1`,
      [WF_ID, row.name, false, row.nodes, row.connections, row.settings, row.staticData, row.pinData, versionId, row.meta, now],
    );
    console.log('UPDATED workflow', WF_ID);
  } else {
    await c.query(
      `INSERT INTO workflow_entity (
        id, name, active, nodes, connections, settings, "staticData", "pinData",
        "versionId", "triggerCount", meta, "parentFolderId", "isArchived", "versionCounter",
        description, "activeVersionId", "nodeGroups", "createdAt", "updatedAt"
      ) VALUES ($1,$2,$3,$4::json,$5::json,$6::json,$7,$8::json,$9,$10,$11::json,$12,$13,$14,$15,$16,$17::json,$18,$19)`,
      [WF_ID, row.name, false, row.nodes, row.connections, row.settings, row.staticData, row.pinData,
        versionId, 0, row.meta, null, false, 1, row.description, null, JSON.stringify([]), now, now],
    );
    await c.query(
      `INSERT INTO shared_workflow ("workflowId", "projectId", role, "createdAt", "updatedAt")
       VALUES ($1, $2, 'workflow:owner', NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [WF_ID, PROJECT_ID],
    );
    console.log('INSERTED workflow', WF_ID);
  }

  return { wf, nodes, safetyCheck: safetyCheck({ ...wf, nodes }) };
}

async function getOrCreateApiKey(c) {
  const existing = await c.query(
    'SELECT id, "apiKey", label FROM user_api_keys WHERE label = $1 LIMIT 1',
    ['stage8832-temp-proof'],
  );
  if (existing.rows[0]?.apiKey) return existing.rows[0].apiKey;

  const apiKey = 'wh-stage8832-' + crypto.randomBytes(16).toString('hex');
  const id = crypto.randomUUID();
  const user = await c.query('SELECT id FROM "user" LIMIT 1');
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error('no n8n user found');

  await c.query(
    `INSERT INTO user_api_keys (id, "userId", label, "apiKey", "createdAt", "updatedAt", scopes)
     VALUES ($1, $2, 'stage8832-temp-proof', $3, NOW(), NOW(), NULL)
     ON CONFLICT DO NOTHING`,
    [id, userId, apiKey],
  );
  return apiKey;
}

async function runViaApi(apiKey) {
  const attempts = [
    { path: `/api/v1/workflows/${WF_ID}/run`, body: { workflowData: { pinData: { 'Webhook - Guest Addon DryRun Trigger': [{ json: PAYLOAD }] } } } },
    { path: `/api/v1/workflows/${WF_ID}/run`, body: {} },
  ];
  for (const a of attempts) {
    const r = await httpsReq('POST', N8N_HOST, a.path, { 'X-N8N-API-KEY': apiKey }, a.body);
    console.log('API run', a.path, '->', r.status, typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 300));
    if (r.status >= 200 && r.status < 300) return r;
  }
  return null;
}

async function runViaWebhookTest() {
  const paths = [
    `/webhook-test/${WEBHOOK_PATH}`,
    `/webhook-test/${WF_ID}/${WEBHOOK_PATH}`,
  ];
  for (const p of paths) {
    const r = await httpsReq('POST', N8N_HOST, p, {}, PAYLOAD);
    console.log('webhook-test', p, '->', r.status, typeof r.body === 'string' ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 400));
    if (r.status >= 200 && r.status < 300 && r.body && typeof r.body === 'object' && (r.body.reply_draft || r.body.create_success !== undefined)) {
      return r;
    }
  }
  return null;
}

async function getLatestExecution(c) {
  const ex = await c.query(
    `SELECT id, status, mode, "startedAt", "stoppedAt", "workflowId"
     FROM execution_entity WHERE "workflowId" = $1 ORDER BY "startedAt" DESC LIMIT 1`,
    [WF_ID],
  );
  return ex.rows[0] || null;
}

async function getExecutionOutput(c, executionId) {
  const data = await c.query('SELECT data FROM execution_data WHERE "executionId" = $1', [executionId]);
  if (!data.rows[0]?.data) return null;
  const raw = data.rows[0].data;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return parsed;
}

async function dbProof() {
  const dbUrl = process.env.WOLFHOUSE_DATABASE_URL || (
    await new Promise((resolve, reject) => {
      const { execSync } = require('child_process');
      try {
        resolve(execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim());
      } catch (e) { reject(e); }
    })
  );
  const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const bookingBefore = await c.query(
    'SELECT payment_status, amount_paid_cents, balance_due_cents, confirmation_sent_at FROM bookings WHERE booking_code = $1',
    [BOOKING_CODE],
  );

  const svc = await c.query(
    `SELECT id, service_type, service_date, source, payment_status, amount_paid_cents, payment_id, metadata
       FROM booking_service_records
      WHERE booking_id = $1 AND service_type = 'wetsuit' AND service_date = $2::date AND source = 'luna_guest'
      ORDER BY created_at DESC`,
    [BOOKING_ID, SERVICE_DATE],
  );

  let payment = null;
  if (svc.rows[0]?.payment_id) {
    const pr = await c.query(
      'SELECT id, status, payment_kind, amount_cents, stripe_checkout_session_id FROM payments WHERE id = $1',
      [svc.rows[0].payment_id],
    );
    payment = pr.rows[0];
  }

  const dup = await c.query(
    `SELECT COUNT(*)::int AS n FROM booking_service_records
      WHERE booking_id = $1 AND service_type = 'wetsuit' AND service_date = $2::date AND source = 'luna_guest'`,
    [BOOKING_ID, SERVICE_DATE],
  );

  await c.end();
  return { booking: bookingBefore.rows[0], services: svc.rows, payment, dupCount: dup.rows[0].n };
}

async function main() {
  const n8n = new Client({
    connectionString: process.env.N8N_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await n8n.connect();

  console.log('=== IMPORT ===');
  const { nodes, safetyCheck: sc } = await importWorkflow(n8n);
  for (const [label, ok] of sc) console.log(ok ? 'PASS' : 'FAIL', label);

  const wfRow = await n8n.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
  console.log('workflow row:', wfRow.rows[0]);

  console.log('\n=== EXEC RUN 1 ===');
  let run1 = await runViaWebhookTest();
  const apiKey = await getOrCreateApiKey(n8n);
  if (!run1 || run1.status >= 400 || (typeof run1.body === 'object' && !run1.body.reply_draft && run1.body.create_success === undefined)) {
    run1 = await runViaApi(apiKey);
  }

  // Wait for execution to finish
  await new Promise((r) => setTimeout(r, 8000));

  let exec1 = await getLatestExecution(n8n);
  console.log('execution 1:', exec1);

  let out1 = run1?.body;
  if (exec1 && (!out1 || typeof out1 !== 'object' || !out1.reply_draft)) {
    const exData = await getExecutionOutput(n8n, exec1.id);
    console.log('execution data keys:', exData ? Object.keys(exData) : null);
    if (exData?.resultData?.runData) {
      const rd = exData.resultData.runData;
      const respond = rd['Respond - DryRun Result']?.[0]?.data?.main?.[0]?.[0]?.json
        || rd['Code - Format DryRun Reply']?.[0]?.data?.main?.[0]?.[0]?.json;
      if (respond) out1 = respond;
    }
  }

  console.log('\n=== EXEC RUN 2 (idempotency) ===');
  let run2 = await runViaWebhookTest();
  if (!run2 || run2.status >= 400) run2 = await runViaApi(apiKey);
  await new Promise((r) => setTimeout(r, 8000));
  let exec2 = await getLatestExecution(n8n);
  let out2 = run2?.body;
  if (exec2 && (!out2 || typeof out2 !== 'object' || !out2.reply_draft)) {
    const exData = await getExecutionOutput(n8n, exec2.id);
    if (exData?.resultData?.runData) {
      const rd = exData.resultData.runData;
      out2 = rd['Respond - DryRun Result']?.[0]?.data?.main?.[0]?.[0]?.json
        || rd['Code - Format DryRun Reply']?.[0]?.data?.main?.[0]?.[0]?.json
        || out2;
    }
  }

  const wfFinal = await n8n.query('SELECT active FROM workflow_entity WHERE id = $1', [WF_ID]);
  await n8n.end();

  console.log('\n=== DB PROOF ===');
  const db = await dbProof();

  const state = {
    workflow_id: WF_ID,
    workflow_name: wfRow.rows[0]?.name,
    active: wfFinal.rows[0]?.active,
    execution_id_1: exec1?.id,
    execution_id_2: exec2?.id,
    idempotency_key: IDEMPOTENCY_KEY,
    run1: out1,
    run2: out2,
    db,
    safety: Object.fromEntries(sc),
  };
  saveState(state);

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    workflow: wfRow.rows[0],
    active_after: wfFinal.rows[0]?.active,
    exec1: exec1?.id,
    exec2: exec2?.id,
    run1_success: out1?.create_success,
    run1_checkout: out1?.checkout_url?.slice?.(0, 60),
    run2_idempotent: out2?.idempotent,
    service_record_id: out2?.service_record_id || out1?.service_record_id,
    payment_id: out2?.payment_id || out1?.payment_id,
    db_service_count: db.dupCount,
    payment_status: db.payment?.status,
  }, null, 2));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
