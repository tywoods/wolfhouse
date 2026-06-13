'use strict';
/** Stage 28c — real-handset booking-write proof. Temp — do not commit. */
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
const WEBHOOK_ID_POST = 'a27demol-0027-4000-8000-000000000029';
const WEBHOOK_NODE_POST = 'Webhook - Open Demo Booking Write Inbound';
const WEBHOOK_ID_GET = 'a28c1-0027-4000-8000-000000000031';
const WEBHOOK_NODE_GET = 'Webhook - Meta GET Hub Verify';
const N8N_HOST = 'wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const STAGING_N8N_CALLBACK = `https://${N8N_HOST}/webhook/${WEBHOOK_PATH}`;
const STAFF_META_CALLBACK = `https://${STAFF_HOST}/staff/meta/whatsapp/webhook`;
const CRED_ID = 'stage8512LunaBotTok01';
const CRED_NAME = 'Luna Bot Internal Token (staging)';
const DEMO_PHONE_ID = '1152900101233109';
const DEMO_WA_DISPLAY = '+34 663 43 94 19';
const VERIFY_TOKEN = 'wolfhouse_verify_token';

const TESTER = {
  name: 'Engineering stand-in (Ale/Cami not recorded)',
  phone_e164: '+34600995557',
  caveat: '28a allowlisted Ale/Cami numbers not confirmed; using 27demo anchor phone',
};
const CHECK_IN = '2026-11-10';
const CHECK_OUT = '2026-11-17';
const SCRIPTED_TURNS = [
  'Hi, we are 2 people interested in the Malibu package',
  'November 10 to November 17',
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
const WRITE_ENV = { ...BASELINE_ENV, OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true' };
const GATE_NAMES = [...Object.keys(BASELINE_ENV), 'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST'];

const POLL_MS = Number(process.env.STAGE28C_POLL_MS || 12 * 60 * 1000);
const POLL_INTERVAL_MS = 20000;

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function setEnvVars(pairs) {
  az([
    'az containerapp update', '--name wh-staging-staff-api', '--resource-group wh-staging-rg',
    `--set-env-vars ${Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join(' ')}`, '-o none',
  ].join(' '));
}

function envPick(names) {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
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
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    }).on('error', reject);
  });
}

function httpsReq(method, host, reqPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = https.request({
      hostname: host, path: reqPath, method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function graphPostPhoneOverride(token, callbackUrl) {
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

async function graphGetPhoneWebhook(token) {
  return new Promise((resolve, reject) => {
    https.get(`https://graph.facebook.com/v21.0/${DEMO_PHONE_ID}?fields=display_phone_number,webhook_configuration&access_token=${encodeURIComponent(token)}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    }).on('error', reject);
  });
}

async function checkAvailability(pg) {
  const occ = await pg.query(`
    SELECT bb.bed_code, b.booking_code
      FROM booking_beds bb
      JOIN bookings b ON b.id = bb.booking_id
      JOIN clients cl ON cl.id = b.client_id
     WHERE cl.slug = 'wolfhouse-somo'
       AND bb.bed_code LIKE 'DEMO-%'
       AND bb.assignment_start_date < $2::date
       AND bb.assignment_end_date > $1::date
       AND b.status NOT IN ('cancelled', 'expired')`, [CHECK_IN, CHECK_OUT]);
  const beds = await pg.query("SELECT bed_code FROM beds WHERE bed_code LIKE 'DEMO-%' ORDER BY bed_code");
  const occupied = new Set(occ.rows.map((r) => r.bed_code));
  const free = beds.rows.filter((b) => !occupied.has(b.bed_code));
  return { free_beds: free.length, free_codes: free.map((b) => b.bed_code), conflicts: occ.rows };
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
    `INSERT INTO workflow_history ("versionId","workflowId",authors,"createdAt","updatedAt",nodes,connections,name,autosaved,description,"nodeGroups")
     VALUES ($1::varchar,$2::varchar,$3,$4::timestamptz,$4::timestamptz,$5::json,$6::json,$7,false,$8,$9::json)`,
    [versionId, WF_ID, 'stage28c-proof', now, JSON.stringify(nodes), JSON.stringify(wf.connections), wf.name, wf.meta?.description || wf.name, JSON.stringify([])],
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
    `INSERT INTO webhook_entity ("webhookPath",method,node,"webhookId","pathLength","workflowId") VALUES ($1,'GET',$2,$3,$4,$5)`,
    [WEBHOOK_PATH, WEBHOOK_NODE_GET, WEBHOOK_ID_GET, WEBHOOK_PATH.length, WF_ID],
  );
  await c.query(
    `INSERT INTO webhook_entity ("webhookPath",method,node,"webhookId","pathLength","workflowId") VALUES ($1,'POST',$2,$3,$4,$5)`,
    [WEBHOOK_PATH, WEBHOOK_NODE_POST, WEBHOOK_ID_POST, WEBHOOK_PATH.length, WF_ID],
  );
  restartN8n();
  await new Promise((r) => setTimeout(r, 75000));
  return versionId;
}

async function deactivateWorkflow(c) {
  await c.query('DELETE FROM webhook_entity WHERE "workflowId"=$1', [WF_ID]);
  await c.query('DELETE FROM workflow_published_version WHERE "workflowId"=$1', [WF_ID]);
  await c.query('UPDATE workflow_entity SET active=false,"activeVersionId"=NULL,"updatedAt"=NOW() WHERE id=$1', [WF_ID]);
  restartN8n();
}

async function dbSnapshot(pg, phone, since) {
  const conv = await pg.query(`
    SELECT c.id::text, c.phone, c.last_message_preview, c.updated_at::text
      FROM conversations c
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND c.phone = $1
     ORDER BY c.updated_at DESC LIMIT 1`, [phone]);
  const msgs = await pg.query(`
    SELECT m.direction::text, LEFT(m.message_text, 200) AS body, m.created_at::text, m.metadata->>'wamid' AS wamid
      FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND c.phone = $1 AND m.created_at >= $2::timestamptz
     ORDER BY m.created_at ASC`, [phone, since]);
  const booking = await pg.query(`
    SELECT b.id::text, b.booking_code, b.status::text, b.payment_status::text, b.check_in::text, b.check_out::text,
           b.confirmation_sent_at, b.created_at::text
      FROM bookings b
     INNER JOIN clients cl ON cl.id = b.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND b.phone = $1 AND b.created_at >= $2::timestamptz
     ORDER BY b.created_at DESC LIMIT 3`, [phone, since]);
  let beds = { rows: [] };
  let pays = { rows: [] };
  if (booking.rows[0]) {
    beds = await pg.query('SELECT bed_code, room_code FROM booking_beds WHERE booking_id=$1::uuid', [booking.rows[0].id]);
    pays = await pg.query(`SELECT id::text, status::text, checkout_url, stripe_checkout_session_id FROM payments WHERE booking_id=$1::uuid`, [booking.rows[0].id]);
  }
  const sends = await pg.query('SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE to_phone=$1 AND created_at>=$2::timestamptz', [phone, since]);
  const dup = await pg.query(`
    SELECT COUNT(*)::int AS n FROM bookings b
     INNER JOIN clients cl ON cl.id = b.client_id
     WHERE cl.slug='wolfhouse-somo' AND b.phone=$1 AND b.check_in=$2::date AND b.created_at>=$3::timestamptz`,
    [phone, CHECK_IN, since]);
  return {
    conversation: conv.rows[0] || null,
    messages: msgs.rows,
    inbound_count: msgs.rows.filter((m) => m.direction === 'inbound').length,
    bookings: booking.rows,
    booking_beds: beds.rows,
    payments: pays.rows,
    guest_message_sends: sends.rows[0].n,
    duplicate_bookings_same_checkin: dup.rows[0].n,
  };
}

async function staffPortalProof(bookingCode) {
  const login = await httpsReq('POST', STAFF_HOST, '/staff/auth/login', {
    client: 'wolfhouse-somo', email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = (login.headers || {});
  const setCookie = login.raw ? null : null;
  return new Promise((resolve) => {
    const loginReq = https.request({
      hostname: STAFF_HOST, path: '/staff/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', async () => {
        const cookies = (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
        const cal = await new Promise((r) => {
          https.get({
            hostname: STAFF_HOST,
            path: `/staff/bed-calendar?client=wolfhouse-somo&start=2026-11-01&end=2026-11-30`,
            headers: { Cookie: cookies },
          }, (calRes) => {
            let b = '';
            calRes.on('data', (c) => { b += c; });
            calRes.on('end', () => r({ status: calRes.statusCode, body: b }));
          });
        });
        const inbox = await new Promise((r) => {
          https.get({
            hostname: STAFF_HOST,
            path: '/staff/conversations?client=wolfhouse-somo&limit=20',
            headers: { Cookie: cookies },
          }, (inRes) => {
            let b = '';
            inRes.on('data', (c) => { b += c; });
            inRes.on('end', () => {
              let parsed = {};
              try { parsed = JSON.parse(b); } catch { /* */ }
              r({ status: inRes.statusCode, body: parsed });
            });
          });
        });
        resolve({
          login_status: res.statusCode,
          calendar_http: cal.status,
          calendar_has_booking: cal.body.includes(bookingCode || '___none___'),
          inbox_http: inbox.status,
          inbox_has_phone: JSON.stringify(inbox.body).includes(TESTER.phone_e164),
        });
      });
    });
    loginReq.write(JSON.stringify({ client: 'wolfhouse-somo', email: 'operator.stage72c@example.test', password: 'OperatorPass123!' }));
    loginReq.end();
  });
}

(async () => {
  const proofStart = new Date().toISOString();
  const out = {
    stage: '28c',
    commit: 'e6e6d2d',
    tester: TESTER,
    demo_whatsapp: DEMO_WA_DISPLAY,
    demo_phone_number_id: DEMO_PHONE_ID,
    dates: { check_in: CHECK_IN, check_out: CHECK_OUT },
    scripted_turns: SCRIPTED_TURNS,
    proof_start: proofStart,
    true_handset_path: null,
  };

  let nc;
  let pg;
  let metaToken;
  let metaBefore;
  let restoreCallback = STAFF_META_CALLBACK;

  try {
    out.healthz = Number(execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${STAFF_HOST}/healthz`, { encoding: 'utf8' }).trim());
    out.revision = activeRevision();
    out.gates_before = envPick(GATE_NAMES);

    const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
    pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await pg.connect();
    out.availability = await checkAvailability(pg);
    if (out.availability.free_beds < 2) {
      out.verdict = 'FAIL';
      out.blocker = 'insufficient_demo_bed_availability';
      throw new Error(`Only ${out.availability.free_beds} free demo beds for ${CHECK_IN}–${CHECK_OUT}`);
    }
    await pg.end();
    pg = null;

    metaToken = az('az keyvault secret show --vault-name wh-staging-kv --name meta-whatsapp-token --query value -o tsv');
    metaBefore = await graphGetPhoneWebhook(metaToken);
    restoreCallback = metaBefore?.webhook_configuration?.application
      || metaBefore?.webhook_configuration?.override_callback_uri
      || STAFF_META_CALLBACK;
    out.meta_callback_before = metaBefore?.webhook_configuration || metaBefore;

    const n8nUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
    nc = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
    await nc.connect();

    console.error('[n8n] activate 28c.1 GET+POST workflow...');
    out.n8n_version_id = await activateWorkflow(nc);
    const hooks = await nc.query('SELECT method, node, "webhookPath" FROM webhook_entity WHERE "workflowId"=$1 ORDER BY method', [WF_ID]);
    out.webhook_entity_rows = hooks.rows;
    const wfDuring = await nc.query('SELECT active, name FROM workflow_entity WHERE id=$1', [WF_ID]);
    out.n8n_workflow_during = wfDuring.rows[0];

    const getVerify = await httpsGet(N8N_HOST, `/webhook/${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=test123`);
    out.n8n_get_verify = {
      status: getVerify.status,
      body: getVerify.body,
      raw_text_ok: getVerify.body === 'test123',
      not_json: !getVerify.body.trim().startsWith('{'),
    };

    console.error('[meta] repoint phone override to staging n8n...');
    const metaOverride = await graphPostPhoneOverride(metaToken, STAGING_N8N_CALLBACK);
    out.meta_override_attempt = metaOverride;
    const metaDuring = await graphGetPhoneWebhook(metaToken);
    out.meta_callback_during = metaDuring?.webhook_configuration || metaDuring;

    console.error('[env] booking-write gates...');
    setEnvVars(WRITE_ENV);
    await new Promise((r) => setTimeout(r, 15000));
    out.gates_during = envPick(GATE_NAMES);

    console.error(`[poll] waiting up to ${POLL_MS / 1000}s for handset inbound from ${TESTER.phone_e164}...`);
    console.error('[poll] SEND NOW from WhatsApp:');
    SCRIPTED_TURNS.forEach((t, i) => console.error(`  ${i + 1}. ${t}`));

    pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await pg.connect();
    const deadline = Date.now() + POLL_MS;
    let snap = null;
    while (Date.now() < deadline) {
      snap = await dbSnapshot(pg, TESTER.phone_e164, proofStart);
      const b = snap.bookings[0];
      if (snap.inbound_count >= 3 && b && b.status === 'hold') break;
      if (snap.inbound_count >= 1) console.error(`[poll] inbound=${snap.inbound_count} bookings=${snap.bookings.length}`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    out.db = snap;
    out.transcript = snap.messages.map((m) => ({ direction: m.direction, body: m.body, at: m.created_at }));

    const booking = snap.bookings[0];
    if (booking) {
      out.booking_code = booking.booking_code;
      out.portal = await staffPortalProof(booking.booking_code);
    }

    out.true_handset_path = snap.inbound_count >= 3
      && out.meta_override_attempt?.status === 200
      && out.n8n_get_verify?.raw_text_ok;

    console.error('[rollback] meta callback + gates + n8n...');
    const metaRestore = await graphPostPhoneOverride(metaToken, restoreCallback);
    out.meta_restore = metaRestore;
    const metaAfter = await graphGetPhoneWebhook(metaToken);
    out.meta_callback_after = metaAfter?.webhook_configuration || metaAfter;

    setEnvVars(BASELINE_ENV);
    await deactivateWorkflow(nc);
    const wfAfter = await nc.query('SELECT active FROM workflow_entity WHERE id=$1', [WF_ID]);
    const hooksAfter = await nc.query('SELECT COUNT(*)::int AS n FROM webhook_entity WHERE "workflowId"=$1', [WF_ID]);
    out.n8n_workflow_after = { active: wfAfter.rows[0]?.active, webhook_entity_rows: hooksAfter.rows[0].n };
    await nc.end();
    nc = null;

    out.gates_after = envPick(GATE_NAMES);

    const b = booking || {};
    const pays = snap.payments || [];
    out.checks = {
      healthz_200: out.healthz === 200,
      availability_ok: out.availability.free_beds >= 2,
      n8n_get_verify_200: out.n8n_get_verify?.status === 200,
      n8n_get_raw_challenge: out.n8n_get_verify?.raw_text_ok === true,
      webhook_get_post_rows: hooks.rows.length === 2,
      meta_override_ok: out.meta_override_attempt?.status === 200,
      meta_restored: String(out.meta_callback_after?.application || out.meta_callback_after?.override_callback_uri || '').includes('staff-staging'),
      write_gates_during: out.gates_during.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'true',
      gates_restored: out.gates_after.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'false',
      n8n_inactive_after: out.n8n_workflow_after?.active === false,
      webhook_cleared: out.n8n_workflow_after?.webhook_entity_rows === 0,
      inbound_messages_3plus: snap.inbound_count >= 3,
      booking_hold: b.status === 'hold',
      payment_waiting: b.payment_status === 'waiting_payment',
      payment_draft: pays.some((p) => p.status === 'draft' || p.status === 'pending'),
      beds_assigned: (snap.booking_beds || []).length >= 2,
      no_stripe_session: !pays.some((p) => p.stripe_checkout_session_id),
      no_guest_sends: snap.guest_message_sends === 0,
      no_confirmation: !b.confirmation_sent_at,
      no_dup_bookings: snap.duplicate_bookings_same_checkin <= 1,
      conversation_visible: !!snap.conversation,
      calendar_visible: out.portal?.calendar_has_booking === true,
      inbox_visible: out.portal?.inbox_has_phone === true,
      true_handset: out.true_handset_path === true,
    };

    const critical = ['booking_hold', 'payment_waiting', 'beds_assigned', 'inbound_messages_3plus', 'true_handset', 'meta_override_ok', 'n8n_get_raw_challenge'];
    const critFail = critical.filter((k) => !out.checks[k]);
    out.verdict = critFail.length === 0 && Object.values(out.checks).every(Boolean) ? 'PASS'
      : critFail.length === 0 ? 'PARTIAL' : (out.checks.booking_hold ? 'PARTIAL' : 'FAIL');
    out.failed_checks = Object.entries(out.checks).filter(([, v]) => !v).map(([k]) => k);
  } catch (err) {
    out.error = err.message;
    out.verdict = out.verdict || 'FAIL';
    try {
      if (metaToken && restoreCallback) await graphPostPhoneOverride(metaToken, restoreCallback);
      setEnvVars(BASELINE_ENV);
      if (nc) await deactivateWorkflow(nc);
    } catch { /* ignore */ }
  } finally {
    try { if (pg) await pg.end(); } catch { /* */ }
    try { if (nc) await nc.end(); } catch { /* */ }
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.verdict === 'PASS' ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
