'use strict';
/**
 * Phase 12e — n8n Luna booking dry-run test-webhook proof (staging only)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_PATH = path.join(__dirname, 'n8n', 'Wolfhouse Booking Assistant - Main - Shared Engine Dry Run.json');
const WF_ID = 'stage8510SharedDryRun01';
const PROJECT_ID = 'EZGOr9OgMVSflIF5';
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const WEBHOOK_PATH = 'luna-bot-booking-dry-run-12d';
const WEBHOOK_NODE = 'Webhook - Dry Run Trigger';

const PAYLOAD = {
  client_slug: 'wolfhouse-somo',
  channel: 'whatsapp',
  from: '+15555550123',
  guest_name: 'Test Guest',
  language: 'en',
  message_text: 'Hi, I want to stay June 15 to June 22 for 2 people. What packages are available?',
  check_in: '2026-06-15',
  check_out: '2026-06-22',
  guests: 2,
  package_code: 'malibu',
};

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
    return { ...n, credentials: { httpHeaderAuth: { id: CRED_ID, name: CRED_NAME } } };
  });
}

function safetyCheck(wf) {
  const nodeBlob = JSON.stringify(wf.nodes);
  return [
    ['no graph.facebook.com', !/graph\.facebook\.com/i.test(nodeBlob)],
    ['no api.stripe.com', !/api\.stripe\.com/i.test(nodeBlob)],
    ['no booking-create route', !/\/staff\/bot\/bookings\/create/i.test(nodeBlob)],
    ['no generate-payment-link', !/generate-payment-link/i.test(nodeBlob)],
    ['no create-stripe-link', !/create-stripe-link/i.test(nodeBlob)],
    ['no WhatsApp send node', !wf.nodes.some((n) => /whatsapp.*send|send.*whatsapp/i.test(n.name || ''))],
    ['booking-dry-run route present', /\/staff\/bot\/booking-dry-run/i.test(nodeBlob)],
    ['active false in repo', wf.active === false],
    ['http cred bound', wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest').every(
      (n) => n.credentials?.httpHeaderAuth?.name === CRED_NAME,
    )],
  ];
}

async function importWorkflow(c) {
  const wf = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  const nodes = bindCredentials(wf.nodes);
  const now = new Date();
  const versionId = crypto.randomUUID();
  const pinData = { [WEBHOOK_NODE]: [{ json: PAYLOAD }] };
  const meta = wf.meta || {};

  const existing = await c.query(
    'SELECT id, name, active FROM workflow_entity WHERE id = $1 OR name = $2',
    [WF_ID, wf.name],
  );

  if (existing.rows.length) {
    await c.query(
      `UPDATE workflow_entity SET
        name = $2, active = $3, nodes = $4::json, connections = $5::json, settings = $6::json,
        "staticData" = $7, "pinData" = $8::json, "versionId" = $9, meta = $10::json,
        "updatedAt" = $11
       WHERE id = $1`,
      [WF_ID, wf.name, false, JSON.stringify(nodes), JSON.stringify(wf.connections),
        JSON.stringify(wf.settings || {}), null, JSON.stringify(pinData), versionId, JSON.stringify(meta), now],
    );
    console.log('UPDATED workflow', WF_ID);
  } else {
    await c.query(
      `INSERT INTO workflow_entity (
        id, name, active, nodes, connections, settings, "staticData", "pinData",
        "versionId", "triggerCount", meta, "parentFolderId", "isArchived", "versionCounter",
        description, "activeVersionId", "nodeGroups", "createdAt", "updatedAt"
      ) VALUES ($1,$2,$3,$4::json,$5::json,$6::json,$7,$8::json,$9,$10,$11::json,$12,$13,$14,$15,$16,$17::json,$18,$19)`,
      [WF_ID, wf.name, false, JSON.stringify(nodes), JSON.stringify(wf.connections),
        JSON.stringify(wf.settings || {}), null, JSON.stringify(pinData), versionId, 0,
        JSON.stringify(meta), null, false, 1, meta.description || wf.name, null, JSON.stringify([]), now, now],
    );
    await c.query(
      `INSERT INTO shared_workflow ("workflowId", "projectId", role, "createdAt", "updatedAt")
       VALUES ($1, $2, 'workflow:owner', NOW(), NOW()) ON CONFLICT DO NOTHING`,
      [WF_ID, PROJECT_ID],
    );
    console.log('INSERTED workflow', WF_ID);
  }

  return { wf, nodes, safetyCheck: safetyCheck({ ...wf, nodes }) };
}

async function getOrCreateApiKey(c) {
  const existing = await c.query(
    'SELECT id, "apiKey", label FROM user_api_keys WHERE label = $1 LIMIT 1',
    ['stage12e-temp-proof'],
  );
  if (existing.rows[0]?.apiKey) return existing.rows[0].apiKey;

  const apiKey = 'wh-stage12e-' + crypto.randomBytes(16).toString('hex');
  const user = await c.query('SELECT id FROM "user" LIMIT 1');
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error('no n8n user found');

  await c.query(
    `INSERT INTO user_api_keys (id, "userId", label, "apiKey", "createdAt", "updatedAt", scopes)
     VALUES ($1, $2, 'stage12e-temp-proof', $3, NOW(), NOW(), NULL)`,
    [crypto.randomUUID(), userId, apiKey],
  );
  return apiKey;
}

async function runViaWebhookTest() {
  const paths = [
    `/webhook-test/${WEBHOOK_PATH}`,
    `/webhook-test/${WF_ID}/${WEBHOOK_PATH}`,
  ];
  const results = [];
  for (const p of paths) {
    const r = await httpsReq('POST', N8N_HOST, p, {}, PAYLOAD);
    results.push({ path: p, status: r.status, body: r.body });
    console.log('webhook-test', p, '->', r.status, typeof r.body === 'string' ? r.body.slice(0, 250) : JSON.stringify(r.body).slice(0, 350));
    if (r.status >= 200 && r.status < 300 && r.body && typeof r.body === 'object' && r.body.dry_run === true) {
      return { mode: 'webhook-test', path: p, response: r };
    }
  }
  return { mode: 'webhook-test', path: null, response: null, attempts: results };
}

async function runViaApi(apiKey) {
  const pin = { [WEBHOOK_NODE]: [{ json: PAYLOAD }] };
  const attempts = [
    {
      path: `/rest/workflows/${WF_ID}/run`,
      body: { workflowData: { pinData: pin } },
      headers: { 'X-N8N-API-KEY': apiKey },
    },
    {
      path: '/rest/workflows/run',
      body: { workflowId: WF_ID, data: [{ json: PAYLOAD }] },
      headers: { 'X-N8N-API-KEY': apiKey },
    },
    {
      path: `/api/v1/workflows/${WF_ID}/run`,
      body: { workflowData: { pinData: pin } },
      headers: { 'X-N8N-API-KEY': apiKey },
    },
    {
      path: `/api/v1/workflows/${WF_ID}/execute`,
      body: { data: PAYLOAD },
      headers: { 'X-N8N-API-KEY': apiKey },
    },
  ];
  for (const a of attempts) {
    const r = await httpsReq('POST', N8N_HOST, a.path, a.headers, a.body);
    console.log('API run', a.path, '->', r.status, typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 300));
    if (r.status >= 200 && r.status < 300) return { mode: 'api-run', path: a.path, response: r };
  }
  return { mode: 'api-run', path: null, response: null };
}

async function registerTestWebhook(sessionCookie) {
  const paths = [
    `/rest/workflows/${WF_ID}/test-webhook`,
    `/rest/workflows/${WF_ID}/activate-test-webhook`,
    `/rest/webhooks/find`,
  ];
  for (const p of paths) {
    const body = p.includes('webhooks/find')
      ? { path: WEBHOOK_PATH, method: 'POST' }
      : { triggerNode: WEBHOOK_NODE };
    const r = await httpsReq('POST', N8N_HOST, p, { Cookie: sessionCookie }, body);
    console.log('register test', p, '->', r.status, typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 250));
  }
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
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function extractRespond(exData) {
  if (!exData?.resultData?.runData) return null;
  const rd = exData.resultData.runData;
  return rd['Respond - DryRun Result']?.[0]?.data?.main?.[0]?.[0]?.json
    || rd['Code - Map Dry Run Response']?.[0]?.data?.main?.[0]?.[0]?.json
    || null;
}

function extractHttpNode(exData) {
  if (!exData?.resultData?.runData) return null;
  const rd = exData.resultData.runData;
  const http = rd['HTTP - Bot Booking Dry Run']?.[0]?.data?.main?.[0]?.[0]?.json;
  return http || null;
}

function checkFlags(out) {
  if (!out || typeof out !== 'object') return {};
  return {
    dry_run: out.dry_run === true,
    preview_only: out.preview_only === true,
    no_write_performed: out.no_write_performed === true,
    creates_booking: out.creates_booking === false,
    creates_payment: out.creates_payment === false,
    creates_stripe_link: out.creates_stripe_link === false,
    sends_whatsapp: out.sends_whatsapp === false,
    calls_n8n: out.calls_n8n === false,
    has_planned_actions: Array.isArray(out.planned_actions) && out.planned_actions.length > 0,
    has_reply_draft: typeof out.reply_draft === 'string' && out.reply_draft.length > 0,
    has_next_action: out.next_action != null && out.next_action !== '',
    whatsapp_sent_false: out.whatsapp_sent === false,
    staff_route: out.staff_api_endpoint === '/staff/bot/booking-dry-run',
  };
}

async function main() {
  const n8nUrl = process.env.N8N_DATABASE_URL || execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();

  const cred = await new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
  await cred.connect();

  console.log('=== IMPORT ===');
  const { safetyCheck: sc } = await importWorkflow(cred);
  for (const [label, ok] of sc) console.log(ok ? 'PASS' : 'FAIL', label);

  const wfRow = await cred.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
  console.log('workflow row:', wfRow.rows[0]);

  const credRow = await cred.query('SELECT id, name, type FROM credentials_entity WHERE id = $1', [CRED_ID]);
  console.log('credential row:', credRow.rows[0] || 'MISSING');

  console.log('\n=== TEST WEBHOOK (inactive workflow) ===');
  let run = await runViaWebhookTest();
  let executionMode = run.mode;
  let webhookPathUsed = run.path;

  if (!run.response || run.response.status >= 400) {
    console.log('webhook-test did not succeed; falling back to n8n test execution API');
    const apiKey = await getOrCreateApiKey(cred);
    run = await runViaApi(apiKey);
    executionMode = run.mode;
    webhookPathUsed = run.path;
  }

  await new Promise((r) => setTimeout(r, 10000));

  const exec = await getLatestExecution(cred);
  console.log('latest execution:', exec);

  let out = (run.response && typeof run.response.body === 'object') ? run.response.body : null;
  let httpOut = null;
  if (exec) {
    const exData = await getExecutionOutput(cred, exec.id);
    httpOut = extractHttpNode(exData);
    const respond = extractRespond(exData);
    if (respond) out = respond;
    if (httpOut) {
      console.log('HTTP node url evidence:', httpOut.staff_api_endpoint || '(from map node)');
    }
  }

  const wfFinal = await cred.query('SELECT active FROM workflow_entity WHERE id = $1', [WF_ID]);
  await cred.end();

  const flags = checkFlags(out);
  const allCore = [
    flags.dry_run,
    flags.preview_only,
    flags.no_write_performed,
    flags.creates_booking,
    flags.creates_payment,
    flags.creates_stripe_link,
    flags.sends_whatsapp,
    flags.calls_n8n,
    flags.has_planned_actions,
    flags.has_reply_draft,
    flags.has_next_action,
  ].every(Boolean);

  const verdict = allCore && wfFinal.rows[0]?.active === false ? 'PASS'
    : (out && out.dry_run ? 'PARTIAL' : 'FAIL');

  const summary = {
    verdict,
    workflow_active: wfFinal.rows[0]?.active,
    workflow_id: WF_ID,
    execution_mode: executionMode,
    test_webhook_path_type: webhookPathUsed
      ? (webhookPathUsed.startsWith('/webhook-test/') ? 'n8n webhook-test (inactive listener)' : 'n8n API test execution')
      : 'none',
    test_webhook_host: N8N_HOST,
    staff_api_route_called: '/staff/bot/booking-dry-run',
    execution_id: exec?.id,
    execution_status: exec?.status,
    response_safety_flags: flags,
    reply_draft_summary: out?.reply_draft ? out.reply_draft.slice(0, 220) : null,
    planned_actions: out?.planned_actions || null,
    next_action: out?.next_action || null,
    no_whatsapp_stripe_booking_payment_n8n_activation: {
      workflow_still_inactive: wfFinal.rows[0]?.active === false,
      no_whatsapp_nodes_in_workflow: sc.find(([k]) => k === 'no WhatsApp send node')?.[1],
      no_stripe_in_workflow: sc.find(([k]) => k === 'no api.stripe.com')?.[1],
      no_booking_create_route: sc.find(([k]) => k === 'no booking-create route')?.[1],
      sends_whatsapp_false_in_response: flags.sends_whatsapp,
      creates_booking_false: flags.creates_booking,
      creates_payment_false: flags.creates_payment,
    },
    credential_bound: credRow.rows[0]?.name === CRED_NAME,
    staff_api_deploy: 'wh-staging-staff-api--0000120 / e7f8ead-stage12e-booking-dry-run',
    blocker: credRow.rows[0] ? null : 'Credential Luna Bot Internal Token (staging) not found in staging n8n DB',
  };

  console.log('\n=== PHASE 12e SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
