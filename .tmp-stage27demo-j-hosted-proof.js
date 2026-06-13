'use strict';
/** Stage 27demo-j hosted proof — temp, do not commit. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execSync, spawnSync } = require('child_process');
const { Client } = require('pg');

const COMMIT = '9b43cb5';
const IMAGE_TAG = `${COMMIT}-stage27demo-j-n8n-review-pipe`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's27demo-j';
const HOST = 'staff-staging.lunafrontdesk.com';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const WF_PATH = path.join(__dirname, 'n8n', 'Luna Open Demo WhatsApp Inbound Review Pipe.json');
const WF_ID = 'stage27demoJReview01';
const PROJECT_ID = 'EZGOr9OgMVSflIF5';
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';
const WEBHOOK_PATH = 'open-demo-whatsapp-inbound-review-27j';
const DEMO_PHONE_ID = '1152900101233109';
const PROOF_MESSAGE = 'What are the packages?';
const PROOF_PHONE = '+491726422307';
const N8N_CLOUD_WEBHOOK = 'https://tywoods.app.n8n.cloud/webhook/booking-assistant';
const STAGING_N8N_WEBHOOK = `https://${N8N_HOST}/webhook/${WEBHOOK_PATH}`;

const REVIEW_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
};

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
  };
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

function deploy() {
  const rev = activeRevision();
  const hz = execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim();
  if (String(rev.image || '').includes(IMAGE_TAG) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200') {
    console.error('[deploy] skip — already on target image');
    return { ...rev, healthz: Number(hz), skipped: true };
  }
  console.error('[deploy] acr build...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('[deploy] containerapp update...');
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REV_SUFFIX}`,
    '-o none',
  ].join(' '));
  for (let i = 0; i < 45; i++) {
    const r = activeRevision();
    const h = execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim();
    if (String(r.image || '').includes(IMAGE_TAG) && r.health === 'Healthy' && r.traffic === 100 && h === '200') {
      return { ...r, healthz: Number(h), skipped: false };
    }
    execSync('powershell -Command "Start-Sleep -Seconds 10"');
  }
  const finalRev = activeRevision();
  const finalHz = execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim();
  return { ...finalRev, healthz: Number(finalHz), skipped: false };
}

function httpsReq(method, hostname, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
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

function buildMetaPayload(opts = {}) {
  const wamid = opts.wamid || `wamid.HBgMNDkxNzI2NDIyMzA3FQIAEh${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const ts = Math.floor(Date.now() / 1000);
  const phone = opts.phone || PROOF_PHONE;
  const from = phone.replace(/^\+/, '');
  const phoneNumberId = opts.phoneNumberId || DEMO_PHONE_ID;
  const text = opts.message || PROOF_MESSAGE;
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '842343435599477',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '34663439419',
            phone_number_id: phoneNumberId,
          },
          contacts: [{ profile: { name: opts.contactName || 'Stage27demoJ Guest' }, wa_id: from }],
          messages: [{
            from,
            id: wamid,
            timestamp: String(ts),
            type: 'text',
            text: { body: text },
          }],
        },
        field: 'messages',
      }],
    }],
    _proof_wamid: wamid,
  };
}

async function importWorkflow(c, pinPayload) {
  const wf = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  const nodes = bindCredentials(wf.nodes);
  const now = new Date();
  const versionId = crypto.randomUUID();
  const pinData = {
    'Webhook - Open Demo WhatsApp Inbound': [{ json: { body: pinPayload } }],
  };

  const existing = await c.query(
    'SELECT id, name, active FROM workflow_entity WHERE id = $1 OR name = $2',
    [WF_ID, wf.name],
  );

  if (existing.rows.length) {
    await c.query(
      `UPDATE workflow_entity SET
        name = $2, active = $3, nodes = $4::json, connections = $5::json, settings = $6::json,
        "pinData" = $7::json, "versionId" = $8, meta = $9::json, "updatedAt" = $10
       WHERE id = $1`,
      [WF_ID, wf.name, true, JSON.stringify(nodes), JSON.stringify(wf.connections),
        JSON.stringify(wf.settings || {}), JSON.stringify(pinData), versionId,
        JSON.stringify(wf.meta || {}), now],
    );
  } else {
    await c.query(
      `INSERT INTO workflow_entity (
        id, name, active, nodes, connections, settings, "staticData", "pinData",
        "versionId", "triggerCount", meta, "parentFolderId", "isArchived", "versionCounter",
        description, "activeVersionId", "nodeGroups", "createdAt", "updatedAt"
      ) VALUES ($1,$2,$3,$4::json,$5::json,$6::json,$7,$8::json,$9,$10,$11::json,$12,$13,$14,$15,$16,$17::json,$18,$19)`,
      [WF_ID, wf.name, true, JSON.stringify(nodes), JSON.stringify(wf.connections),
        JSON.stringify(wf.settings || {}), null, JSON.stringify(pinData), versionId, 0,
        JSON.stringify(wf.meta || {}), null, false, 1, wf.meta?.description || wf.name, null,
        JSON.stringify([]), now, now],
    );
    await c.query(
      `INSERT INTO shared_workflow ("workflowId", "projectId", role, "createdAt", "updatedAt")
       VALUES ($1, $2, 'workflow:owner', NOW(), NOW()) ON CONFLICT DO NOTHING`,
      [WF_ID, PROJECT_ID],
    );
  }
  return { wf, nodes };
}

async function deactivateWorkflow(c) {
  await c.query('UPDATE workflow_entity SET active = false, "updatedAt" = NOW() WHERE id = $1', [WF_ID]);
}

async function getLatestExecution(c) {
  const ex = await c.query(
    `SELECT id, status, mode, "startedAt", "stoppedAt", "workflowId"
     FROM execution_entity WHERE "workflowId" = $1 ORDER BY "startedAt" DESC LIMIT 1`,
    [WF_ID],
  );
  return ex.rows[0] || null;
}

function runHarness(token, opts = {}) {
  const wamid = opts.wamid || `wamid.harness.${crypto.randomBytes(6).toString('hex')}`;
  const args = [
    path.join(__dirname, 'scripts/run-open-demo-whatsapp-inbound-dry-run.js'),
    '--base-url', `https://${HOST}`,
    '--phone-number-id', opts.phoneNumberId || DEMO_PHONE_ID,
    '--guest-phone', opts.guestPhone || PROOF_PHONE,
    '--message', opts.message || PROOF_MESSAGE,
    '--wamid', wamid,
    '--json',
  ];
  const res = spawnSync(process.execPath, args, {
    cwd: __dirname,
    env: { ...process.env, LUNA_BOT_INTERNAL_TOKEN: token },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  let parsed = null;
  try {
    const line = (res.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    parsed = line ? JSON.parse(line) : null;
  } catch { /* ignore */ }
  return { exit: res.status, parsed, wamid, stderr: res.stderr };
}

async function dbProof(guestPhone, proofStart, wamid) {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const conv = await pg.query(`
    SELECT c.id::text, c.phone, c.last_message_preview,
           LEFT(c.staff_reply_draft, 240) AS staff_reply_draft_preview,
           c.updated_at
      FROM conversations c
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND c.phone = $1
     ORDER BY c.updated_at DESC LIMIT 1`, [guestPhone]);
  const sends = await pg.query(`
    SELECT COUNT(*)::int AS n FROM guest_message_sends
     WHERE to_phone = $1 AND created_at >= $2::timestamptz`, [guestPhone, proofStart]);
  const bookings = await pg.query(`
    SELECT COUNT(*)::int AS n FROM bookings b
     INNER JOIN clients cl ON cl.id = b.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND b.phone = $1
       AND b.created_at >= $2::timestamptz`, [guestPhone, proofStart]);
  const dupConv = wamid
    ? await pg.query(`
        SELECT COUNT(*)::int AS n FROM messages m
         INNER JOIN conversations c ON c.id = m.conversation_id
         INNER JOIN clients cl ON cl.id = c.client_id
         WHERE cl.slug = 'wolfhouse-somo' AND c.phone = $1
           AND (m.metadata->>'wamid' = $2 OR m.metadata->>'inbound_message_id' = $2)`, [guestPhone, wamid])
    : { rows: [{ n: 0 }] };
  await pg.end();
  return {
    conversation: conv.rows[0] || null,
    guest_message_sends_since_proof: sends.rows[0].n,
    bookings_since_proof: bookings.rows[0].n,
    inbound_wamid_rows: dupConv.rows[0].n,
  };
}

async function staffApiDirectNegative(token) {
  return httpsReq('POST', HOST, '/staff/bot/open-demo-whatsapp-inbound-dry-run', {
    'X-Luna-Bot-Token': token,
  }, {
    source: 'n8n_open_demo_whatsapp_inbound',
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    phone_number_id: '9999999999999999',
    guest_phone: PROOF_PHONE,
    message_text: PROOF_MESSAGE,
    wamid: `wamid.neg.${crypto.randomBytes(4).toString('hex')}`,
    inbound_message_id: `wamid.neg.${crypto.randomBytes(4).toString('hex')}`,
  });
}

async function runN8nWebhook(metaPayload) {
  const paths = [
    `/webhook/${WEBHOOK_PATH}`,
    `/webhook-test/${WEBHOOK_PATH}`,
    `/webhook-test/${WF_ID}/${WEBHOOK_PATH}`,
  ];
  const results = [];
  for (const p of paths) {
    const r = await httpsReq('POST', N8N_HOST, p, {}, metaPayload);
    results.push({ path: p, status: r.status, body: r.body });
    if (r.status >= 200 && r.status < 300 && r.body && typeof r.body === 'object'
      && (r.body.staff_api_success != null || r.body.proposed_luna_reply_preview)) {
      return { ok: true, path: p, response: r.body, attempts: results };
    }
  }
  return { ok: false, attempts: results };
}

(async () => {
  const proofStart = new Date().toISOString();
  const out = {
    stage: '27demo-j',
    commit: COMMIT,
    image_tag: IMAGE_TAG,
    proof_message: PROOF_MESSAGE,
    proof_phone: PROOF_PHONE,
    demo_phone_number_id: DEMO_PHONE_ID,
    n8n_workflow_name: 'Luna Open Demo WhatsApp Inbound Review Pipe',
    n8n_workflow_id: WF_ID,
    meta_webhook_production: N8N_CLOUD_WEBHOOK,
    staging_n8n_webhook: STAGING_N8N_WEBHOOK,
    proof_start: proofStart,
  };

  try {
    out.deploy = deploy();
    console.error('[env] setting review-only gates...');
    setEnvVars(REVIEW_ENV);
    out.env_gates = envPick(Object.keys(REVIEW_ENV));

    const token = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');

    const metaPayload = buildMetaPayload();
    out.proof_wamid = metaPayload._proof_wamid;
    delete metaPayload._proof_wamid;

    const n8nDbUrl = process.env.N8N_DATABASE_URL
      || az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
    const nc = new Client({ connectionString: n8nDbUrl, ssl: { rejectUnauthorized: false } });
    await nc.connect();
    console.error('[n8n] importing workflow (active for proof)...');
    await importWorkflow(nc, metaPayload);

    console.error('[n8n] webhook POST (Meta-shaped)...');
    out.n8n_pipe = await runN8nWebhook(metaPayload);

    const exec = await getLatestExecution(nc);
    out.n8n_execution = exec;

    console.error('[negative] wrong phone_number_id via Staff API...');
    const neg = await staffApiDirectNegative(token);
    out.negative_staff_api = {
      status: neg.status,
      demo_gate_blocked: neg.body?.demo_gate_blocked,
      demo_gate_code: neg.body?.demo_gate_code,
    };

    const wrongMeta = buildMetaPayload({ phoneNumberId: '9999999999999999' });
    const wrongWamid = wrongMeta._proof_wamid;
    delete wrongMeta._proof_wamid;
    console.error('[negative] wrong phone_number_id via n8n...');
    out.negative_n8n = await runN8nWebhook(wrongMeta);

    console.error('[idempotency] replay same wamid...');
    const replay = await runN8nWebhook(metaPayload);
    out.idempotency_replay = {
      ok: replay.ok,
      staff_api_success: replay.response?.staff_api_success,
      conversation_id: replay.response?.conversation_id,
    };

    console.error('[harness] direct Staff API package-question...');
    out.harness = runHarness(token, { wamid: out.proof_wamid });

    console.error('[db] proof...');
    out.db = await dbProof(PROOF_PHONE, proofStart, out.proof_wamid);

    console.error('[n8n] deactivating workflow...');
    await deactivateWorkflow(nc);
    const wfAfter = await nc.query('SELECT id, name, active FROM workflow_entity WHERE id = $1', [WF_ID]);
    out.n8n_workflow_after = wfAfter.rows[0];
    await nc.end();

    out.final_env_gates = envPick(Object.keys(REVIEW_ENV));
    out.final_revision = activeRevision();

    const pipe = out.n8n_pipe.response || {};
    const harness = out.harness.parsed || {};
    const reviewText = pipe.proposed_luna_reply_preview
      || harness.review?.proposed_luna_reply
      || out.db.conversation?.staff_reply_draft_preview
      || '';
    const packageExplainer = /package|malibu|ericeira|surf/i.test(String(reviewText));

    const checks = {
      deploy_healthy: out.deploy.health === 'Healthy' && out.deploy.healthz === 200,
      n8n_pipe_ok: out.n8n_pipe.ok === true,
      staff_api_200: pipe.staff_api_status === 200 || harness.http_status === 200,
      package_explainer: packageExplainer,
      sends_whatsapp_false: pipe.sends_whatsapp !== true && harness.sends_whatsapp !== true,
      live_send_blocked: pipe.live_send_blocked !== false,
      no_write: pipe.no_write_performed === true || harness.no_write_performed === true,
      negative_blocked: out.negative_staff_api.demo_gate_code === 'phone_number_id_mismatch'
        || out.negative_n8n.attempts?.some((a) => a.body?.error === 'phone_number_id_blocked'),
      no_guest_sends: out.db.guest_message_sends_since_proof === 0,
      no_bookings: out.db.bookings_since_proof === 0,
      workflow_inactive_after: out.n8n_workflow_after?.active === false,
      gates_safe: out.final_env_gates.WHATSAPP_DRY_RUN === 'true'
        && out.final_env_gates.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'false'
        && out.final_env_gates.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false'
        && out.final_env_gates.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'false',
    };
    out.checks = checks;
    out.verdict = Object.values(checks).every(Boolean) ? 'PASS' : 'PARTIAL';
    if (!checks.n8n_pipe_ok) {
      out.real_whatsapp_note = 'Meta webhook still points at n8n Cloud booking-assistant; pipe proved via Meta-shaped POST to staging n8n webhook. For live handset proof, temporarily repoint Meta callback to staging URL per docs §5.';
    }
  } catch (err) {
    out.error = err.message;
    out.verdict = 'FAIL';
  }

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
