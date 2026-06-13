'use strict';
/** Stage 27demo-m hosted proof — temp, do not commit. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const WF_ID = 'stage27demoMStripe01';
const PROJECT_ID = 'EZGOr9OgMVSflIF5';
const WF_PATH = path.join(__dirname, 'n8n', 'Luna Open Demo WhatsApp Stripe Test Link Pipe.json');
const WEBHOOK_PATH = 'open-demo-whatsapp-stripe-test-link-27m';
const WEBHOOK_ID = 'a27demom-0027-4000-8000-000000000030';
const WEBHOOK_NODE = 'Webhook - Open Demo Stripe Test Link Inbound';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';
const DEMO_PHONE_ID = '1152900101233109';
const PROOF_PHONE = '+34600995557';
const BOOKING_CODE = 'WH-G27-0ECC1D9B57';
const PROOF_MESSAGE = 'Please send the deposit payment link';

const BASELINE_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
  STRIPE_LINKS_ENABLED: 'true',
  STAFF_ACTIONS_ENABLED: 'true',
};

const PROOF_ENV = {
  ...BASELINE_ENV,
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
};

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function setEnvVars(pairs) {
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--set-env-vars ${Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join(' ')}`,
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
  return { name: a.name, health: a.properties.healthState, image: a.properties?.template?.containers?.[0]?.image };
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
          contacts: [{ profile: { name: 'Stage27M Stripe Proof' } }],
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
    booking_code: BOOKING_CODE,
    reference_date: '2026-06-08',
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
    [versionId, WF_ID, 'stage27demo-m-proof', now, JSON.stringify(nodes),
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
  await new Promise((r) => setTimeout(r, 75000));
}

async function deactivateWorkflow(c) {
  await c.query('DELETE FROM webhook_entity WHERE "workflowId" = $1', [WF_ID]);
  await c.query('DELETE FROM workflow_published_version WHERE "workflowId" = $1', [WF_ID]);
  await c.query('UPDATE workflow_entity SET active = false, "activeVersionId" = NULL, "updatedAt" = NOW() WHERE id = $1', [WF_ID]);
  restartN8nMain();
}

function summarizeStripe(body) {
  const b = body || {};
  return {
    staff_api_success: b.success === true || b.staff_api_success === true,
    stripe_link_created: b.stripe_link_created === true,
    stripe_link_reused: b.stripe_link_reused === true,
    stripe_link_attempted: b.stripe_link_attempted === true,
    stripe_mode: b.stripe_mode || null,
    booking_code: b.booking_code || null,
    payment_draft_id: b.payment_draft_id || null,
    stripe_checkout_session_id: b.stripe_checkout_session_id || null,
    has_checkout_url: Boolean(b.stripe_checkout_url),
    payment_link_sent: b.payment_link_sent === true,
    whatsapp_sent: b.whatsapp_sent === true,
    sends_whatsapp: b.sends_whatsapp === true,
    confirmation_sent: b.confirmation_sent === true,
    payment_truth_applied: b.payment_truth_applied === true,
    payment_truth_recorded: b.payment_truth_recorded === true,
  };
}

async function dbProof(since) {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const booking = (await pg.query(`
    SELECT b.id::text, b.booking_code, b.status::text, b.payment_status::text,
           b.confirmation_sent_at, b.phone
      FROM bookings b WHERE b.booking_code = $1`, [BOOKING_CODE])).rows[0];

  const pays = booking
    ? (await pg.query(`
        SELECT p.id::text, p.status::text, p.checkout_url, p.stripe_checkout_session_id,
               p.payment_kind::text, p.amount_paid_cents
          FROM payments p WHERE p.booking_id = $1::uuid ORDER BY p.created_at`, [booking.id])).rows
    : [];

  const sends = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE to_phone = $1 AND created_at >= $2::timestamptz`,
    [PROOF_PHONE, since],
  );

  const dupPays = await pg.query(
    `SELECT COUNT(*)::int AS n FROM payments p
       INNER JOIN bookings b ON b.id = p.booking_id
      WHERE b.booking_code = $1 AND p.status IN ('draft','checkout_created','pending')`,
    [BOOKING_CODE],
  );

  await pg.end();
  return { booking, payments: pays, guest_message_sends_since: sends.rows[0].n, draft_checkout_rows: dupPays.rows[0].n };
}

function runHarness() {
  const token = az('az keyvault secret show --vault-name wh-staging-kv --name luna-bot-internal-token --query value -o tsv');
  try {
    const out = execSync([
      'node scripts/run-open-demo-whatsapp-inbound-dry-run.js',
      '--base-url https://staff-staging.lunafrontdesk.com',
      '--phone-number-id', DEMO_PHONE_ID,
      '--guest-phone', PROOF_PHONE,
      '--message', `"${PROOF_MESSAGE}"`,
      '--create-stripe-test-link-confirmed',
      '--json',
    ].join(' '), {
      encoding: 'utf8',
      env: { ...process.env, LUNA_BOT_INTERNAL_TOKEN: token },
      cwd: __dirname,
    });
    return JSON.parse(out.trim());
  } catch (err) {
    const text = (err.stdout || err.message || '').trim();
    const start = text.indexOf('{');
    if (start >= 0) return JSON.parse(text.slice(start));
    throw err;
  }
}

(async () => {
  const proofStart = new Date().toISOString();
  const out = {
    stage: '27demo-m',
    proof_phone: PROOF_PHONE,
    booking_code: BOOKING_CODE,
    proof_start: proofStart,
    deploy_needed: false,
  };

  try {
    out.healthz = Number(execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${STAFF_HOST}/healthz`, { encoding: 'utf8' }).trim());
    out.revision_before = activeRevision();
    out.env_before = envPick(Object.keys(BASELINE_ENV));

    console.error('[prep] extend hold if needed...');
    execSync('node .tmp-stage27demo-m-extend-hold.js', { encoding: 'utf8', cwd: __dirname });

    console.error('[env] baseline then stripe proof gates...');
    setEnvVars(BASELINE_ENV);
    setEnvVars(PROOF_ENV);
    out.env_during = envPick(Object.keys(BASELINE_ENV));
    await new Promise((r) => setTimeout(r, 15000));
    out.revision = activeRevision();

    console.error('[harness] direct Staff API smoke...');
    const harnessBody = runHarness();
    out.harness = { http_ok: harnessBody.success === true, ...summarizeStripe(harnessBody), raw: harnessBody };

    console.error('[n8n] activate stripe test link workflow...');
    const n8nUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
    const nc = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
    await nc.connect();
    await activateWorkflow(nc);

    const wamid = `wamid.HBgLMzQ2MDA5OTU1NTcFQIAEh${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    console.error('[n8n] first POST...');
    let n8n1 = await postWebhook(buildMeta(wamid));
    if (n8n1.status === 404) {
      await new Promise((r) => setTimeout(r, 30000));
      n8n1 = await postWebhook(buildMeta(wamid));
    }
    const body1 = typeof n8n1.body === 'object' ? n8n1.body : {};
    out.n8n_first = { webhook_status: n8n1.status, wamid, ...summarizeStripe(body1) };

    console.error('[n8n] idempotency replay...');
    const n8n2 = await postWebhook(buildMeta(wamid));
    const body2 = typeof n8n2.body === 'object' ? n8n2.body : {};
    out.n8n_idempotency = { webhook_status: n8n2.status, wamid, ...summarizeStripe(body2) };

    out.db = await dbProof(proofStart);

    console.error('[restore] gates + deactivate...');
    setEnvVars(BASELINE_ENV);
    await deactivateWorkflow(nc);
    const wfAfter = await nc.query('SELECT active FROM workflow_entity WHERE id = $1', [WF_ID]);
    out.n8n_workflow_after = { id: WF_ID, name: 'Luna Open Demo WhatsApp Stripe Test Link Pipe', path: WEBHOOK_PATH, active: wfAfter.rows[0]?.active };
    await nc.end();

    out.env_after = envPick(Object.keys(BASELINE_ENV));

    const linkOk = (s) => s.stripe_link_created || s.stripe_link_reused;
    const safetyOk = (s) => !s.payment_link_sent && !s.whatsapp_sent && !s.sends_whatsapp
      && !s.confirmation_sent && !s.payment_truth_applied && !s.payment_truth_recorded;

    out.checks = {
      healthz_200: out.healthz === 200,
      harness_link: linkOk(out.harness) && out.harness.has_checkout_url && out.harness.booking_code === BOOKING_CODE,
      harness_safety: safetyOk(out.harness),
      n8n_link: linkOk(out.n8n_first) && out.n8n_first.has_checkout_url,
      n8n_safety: safetyOk(out.n8n_first),
      idempotent_reuse: out.n8n_idempotency.stripe_link_reused === true,
      db_hold: out.db.booking?.status === 'hold',
      db_waiting: out.db.booking?.payment_status === 'waiting_payment',
      db_checkout: out.db.payments?.some((p) => p.checkout_url && p.stripe_checkout_session_id),
      db_not_paid: !out.db.payments?.some((p) => Number(p.amount_paid_cents || 0) > 0),
      db_no_confirmation: !out.db.booking?.confirmation_sent_at,
      no_guest_sends: out.db.guest_message_sends_since === 0,
      no_dup_drafts: out.db.draft_checkout_rows <= 1,
      workflow_inactive: out.n8n_workflow_after?.active === false,
      gates_restored: out.env_after.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'false'
        && out.env_after.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false',
    };
    out.verdict = Object.values(out.checks).every(Boolean) ? 'PASS' : 'PARTIAL';
  } catch (err) {
    out.error = err.message;
    out.verdict = 'FAIL';
    try { setEnvVars(BASELINE_ENV); } catch { /* ignore */ }
  }

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
