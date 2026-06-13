'use strict';
/** Stage 27demo-l hosted proof — temp, do not commit. */
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
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';
const DEMO_PHONE_ID = '1152900101233109';
const PROOF_PHONE = '+34600995557';
const GUEST_EMAIL = 'open-demo+34600995557@example.test';
const REFERENCE_DATE = '2026-06-08';
const CHECK_IN = '2026-09-09';
const CHECK_OUT = '2026-09-16';

const TURNS = [
  'Hi, we are 2 people interested in the Malibu package',
  'September 9 to September 16',
  'Deposit is fine',
];

const BASELINE_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
};

const WRITE_ENV = {
  ...BASELINE_ENV,
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

function buildMeta(message, wamid, guestContext) {
  const from = PROOF_PHONE.replace(/^\+/, '');
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: DEMO_PHONE_ID },
          contacts: [{ profile: { name: 'Stage27L Write Proof' } }],
          messages: [{
            from,
            id: wamid,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: message },
          }],
        },
        field: 'messages',
      }],
    }],
    guest_email: GUEST_EMAIL,
    reference_date: REFERENCE_DATE,
  };
  if (guestContext) payload.guest_context = guestContext;
  return payload;
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
    [versionId, WF_ID, 'stage27demo-l-proof', now, JSON.stringify(nodes),
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

async function dbProof(bookingCode, since) {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  let booking = null;
  let beds = { rows: [] };
  let payments = { rows: [] };
  if (bookingCode) {
    booking = (await pg.query(`
      SELECT b.id::text, b.booking_code, b.status::text, b.payment_status::text,
             b.assignment_status::text, b.check_in::text, b.check_out::text, b.phone, b.confirmation_sent_at
        FROM bookings b
       INNER JOIN clients cl ON cl.id = b.client_id
       WHERE cl.slug = 'wolfhouse-somo' AND b.booking_code = $1`, [bookingCode])).rows[0];

    if (booking) {
      beds = await pg.query(`
        SELECT bb.id::text, bb.bed_code, bb.room_code, bb.assignment_start_date::text, bb.assignment_end_date::text
          FROM booking_beds bb WHERE bb.booking_id = $1::uuid`, [booking.id]);
      payments = await pg.query(`
        SELECT p.id::text, p.status::text, p.checkout_url, p.stripe_checkout_session_id, p.payment_kind::text
          FROM payments p WHERE p.booking_id = $1::uuid ORDER BY p.created_at`, [booking.id]);
    }
  }

  const sends = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE to_phone = $1 AND created_at >= $2::timestamptz`,
    [PROOF_PHONE, since],
  );
  const dupBookings = await pg.query(
    `SELECT COUNT(*)::int AS n FROM bookings b
       INNER JOIN clients cl ON cl.id = b.client_id
      WHERE cl.slug = 'wolfhouse-somo' AND b.phone = $1
        AND b.check_in = $2::date AND b.created_at >= $3::timestamptz`,
    [PROOF_PHONE, CHECK_IN, since],
  );

  await pg.end();
  return {
    booking,
    booking_beds: beds.rows,
    payments: payments.rows,
    guest_message_sends_since: sends.rows[0].n,
    duplicate_bookings_same_checkin: dupBookings.rows[0].n,
  };
}

(async () => {
  const proofStart = new Date().toISOString();
  const out = {
    stage: '27demo-l',
    proof_phone: PROOF_PHONE,
    guest_email: GUEST_EMAIL,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    n8n_workflow_name: 'Luna Open Demo WhatsApp Booking Write Pipe',
    n8n_workflow_id: WF_ID,
    webhook_path: WEBHOOK_PATH,
    proof_start: proofStart,
  };

  try {
    out.healthz = Number(execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${STAFF_HOST}/healthz`, { encoding: 'utf8' }).trim());
    out.revision = activeRevision();

    console.error('[env] baseline then write gate...');
    setEnvVars(BASELINE_ENV);
    setEnvVars(WRITE_ENV);
    out.env_during = envPick(Object.keys(BASELINE_ENV));
    await new Promise((r) => setTimeout(r, 12000));

    const n8nUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
    const nc = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
    await nc.connect();

    console.error('[n8n] activate booking-write workflow...');
    await activateWorkflow(nc);

    let guestContext = null;
    const turnResults = [];
    const wamids = [];

    let turn3Body = null;
    let turn3Status = null;
    let turn3Context = null;

    for (let i = 0; i < TURNS.length; i++) {
      const wamid = `wamid.HBgLMzQ2MDA5OTU1NTcFQIAEh${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
      wamids.push(wamid);
      console.error(`[turn ${i + 1}]`, TURNS[i].slice(0, 40));
      if (i === 2) turn3Context = guestContext;
      let res = await postWebhook(buildMeta(TURNS[i], wamid, guestContext));
      if (res.status === 404) {
        await new Promise((r) => setTimeout(r, 30000));
        res = await postWebhook(buildMeta(TURNS[i], wamid, guestContext));
      }
      const body = typeof res.body === 'object' ? res.body : {};
      turnResults.push({
        turn: i + 1,
        message: TURNS[i],
        wamid,
        webhook_status: res.status,
        write_status: body.write_status || null,
        assignment_write_status: body.assignment_write_status || null,
        staff_api_success: body.staff_api_success,
        booking_code: body.booking_code || null,
      });
      if (i === 2) {
        turn3Body = body;
        turn3Status = res.status;
      }
      if (body.slim_guest_context_for_next_turn) {
        guestContext = body.slim_guest_context_for_next_turn;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    out.turns = turnResults;
    const idemRes = await postWebhook(buildMeta(TURNS[2], wamids[2], turn3Context));
    const idemBody = typeof idemRes.body === 'object' ? idemRes.body : {};
    out.idempotency = {
      wamid: wamids[2],
      write_status: idemBody.write_status,
      assignment_write_status: idemBody.assignment_write_status,
      booking_code: idemBody.booking_code,
    };

    out.turn3 = { webhook_status: turn3Status, body: turn3Body };

    out.db = await dbProof(out.turn3.body?.booking_code || out.idempotency.booking_code, proofStart);

    console.error('[restore] gates + deactivate...');
    setEnvVars(BASELINE_ENV);
    await deactivateWorkflow(nc);
    const wfAfter = await nc.query('SELECT active FROM workflow_entity WHERE id = $1', [WF_ID]);
    out.n8n_workflow_after = { active: wfAfter.rows[0]?.active };
    await nc.end();

    out.env_after = envPick(Object.keys(BASELINE_ENV));

    const t3 = out.turn3.body || {};
    out.checks = {
      healthz_200: out.healthz === 200,
      turn3_success: t3.staff_api_success === true,
      write_created: t3.write_status === 'created' || t3.write_status === 'reused_existing',
      assignment_created: t3.assignment_write_status === 'created' || t3.assignment_write_status === 'reused_existing',
      booking_code: Boolean(t3.booking_code),
      payment_draft: Boolean(t3.payment_draft_id),
      calendar_visible: t3.calendar_visible_expected === true,
      no_stripe: t3.stripe_link_created !== true,
      no_whatsapp: t3.whatsapp_sent !== true && t3.sends_whatsapp !== true,
      no_confirmation: t3.confirmation_sent !== true,
      idempotent_reuse: out.idempotency.write_status === 'reused_existing'
        && out.idempotency.assignment_write_status === 'reused_existing',
      db_hold: out.db.booking?.status === 'hold',
      db_assigned: out.db.booking_beds?.length >= 1,
      no_stripe_session: !out.db.payments?.some((p) => p.stripe_checkout_session_id),
      no_guest_sends: out.db.guest_message_sends_since === 0,
      no_dup_bookings: out.db.duplicate_bookings_same_checkin <= 1,
      workflow_inactive: out.n8n_workflow_after?.active === false,
      gates_restored: out.env_after.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false',
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
