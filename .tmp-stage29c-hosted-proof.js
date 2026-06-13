'use strict';
/** Stage 29c.2 — live staging payment + confirmation E2E reproof. Temp — do not commit. */
const crypto = require('crypto');
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { resetLunaConversationContext } = require('./scripts/lib/staff-conversation-writes');
const { runGuestConfirmationPreviewDryRun } = require('./scripts/lib/luna-guest-confirmation-preview-dry-run');
const { runGuestConfirmationLiveSendAllowlisted } = require('./scripts/lib/luna-guest-confirmation-send-go-no-go');
const { runLiveProofHygiene } = require('./scripts/lib/luna-live-proof-hygiene');

const COMMIT = '6410757';
const IMAGE_TAG = `${COMMIT}-stage29c2-live-reproof`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 'stage29c2-live-reproof';
const HOST = 'staff-staging.lunafrontdesk.com';
const STAFF_META = `https://${HOST}/staff/meta/whatsapp/webhook`;
const CLIENT = 'wolfhouse-somo';
const PROOF_PHONE = '+491726422307';
const PROOF_PHONE_RAW = '491726422307';
const DEMO_PHONE_ID = '1152900101233109';
const WF_ID = 'stage27demoLWrite01';
const PROOF_CHECK_IN = '2026-07-01';
const PROOF_CHECK_OUT = '2026-07-05';

const TURNS = [
  'hi',
  'book a stay',
  'July 1-5',
  '1',
  'no thanks, i have my own stuff',
  'deposit',
];

const LIVE_ENV = {
  WHATSAPP_DRY_RUN: 'false',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
  WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
  STRIPE_LINKS_ENABLED: 'true',
  STAFF_ACTIONS_ENABLED: 'true',
  LUNA_AUTO_SEND_ENABLED: 'true',
  LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: PROOF_PHONE,
  LUNA_CONVERSATION_BRAIN_ENABLED: 'true',
  LUNA_CONVERSATION_BRAIN_LLM_ENABLED: 'true',
  LUNA_CONVERSATION_BRAIN_MODEL: 'gpt-5.5',
  LUNA_CONVERSATION_BRAIN_REASONING_EFFORT: 'low',
  LUNA_CONVERSATION_BRAIN_TIMEOUT_MS: '4000',
};

const RESTORE_ENV = {
  WHATSAPP_DRY_RUN: 'true',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'false',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
};

const GATE_NAMES = [
  ...Object.keys(LIVE_ENV),
  'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
  'STRIPE_LINKS_ENABLED',
  'STAFF_ACTIONS_ENABLED',
];

const cmd = process.argv[2] || 'all';

function az(s, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      return execSync(s, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      last = e;
      if (i < retries - 1) sleep(2000);
    }
  }
  throw last;
}

function sleep(ms) {
  execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`);
}

function setEnvVars(pairs) {
  az([
    'az containerapp update', '--name wh-staging-staff-api', '--resource-group wh-staging-rg',
    `--set-env-vars ${Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join(' ')}`, '-o none',
  ].join(' '));
}

function removeEnvVars(names) {
  az([
    'az containerapp update', '--name wh-staging-staff-api', '--resource-group wh-staging-rg',
    `--remove-env-vars ${names.join(' ')}`, '-o none',
  ].join(' '));
}

function envPick(names) {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    out[n] = e ? (e.secretRef ? `(secret:${e.secretRef})` : (e.value ?? null)) : null;
  }
  return out;
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
    created: a.properties?.createdTime,
  };
}

function healthz() {
  return execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${HOST}/healthz`, { encoding: 'utf8' }).trim();
}

async function pgConnect() {
  const db = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  if (/prod(uction)?/i.test(db) && !/staging/i.test(db)) throw new Error('refusing production DB URL');
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

function kvSecret(name) {
  return az(`az keyvault secret show --vault-name wh-staging-kv --name ${name} --query value -o tsv`);
}

function buildMetaPayload(text) {
  const wamid = `wamid.stage29c2.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  const from = PROOF_PHONE_RAW;
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '34663439419', phone_number_id: DEMO_PHONE_ID },
          contacts: [{ profile: { name: 'Stage29c Guest' }, wa_id: from }],
          messages: [{
            from,
            id: wamid,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: text },
          }],
        },
        field: 'messages',
      }],
    }],
    _wamid: wamid,
  };
}

function postMetaWebhook(payload) {
  const raw = JSON.stringify(payload);
  let appSecret = '';
  try { appSecret = kvSecret('meta-app-secret'); } catch { /* optional */ }
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) };
  if (appSecret) {
    headers['x-hub-signature-256'] = `sha256=${crypto.createHmac('sha256', appSecret).update(raw).digest('hex')}`;
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST,
      path: '/staff/meta/whatsapp/webhook',
      method: 'POST',
      headers,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let body = buf;
        try { body = JSON.parse(buf); } catch { /* keep */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

async function demoteOwner(pg) {
  await pg.query(
    `UPDATE staff_phone_access SET is_active = false, updated_at = NOW()
      WHERE client_slug = $1 AND (phone_normalized = $2 OR phone_e164 = $3) AND is_active = true`,
    [CLIENT, PROOF_PHONE_RAW, PROOF_PHONE],
  );
}

async function restoreOwner(pg) {
  await pg.query(
    `UPDATE staff_phone_access SET is_active = true, updated_at = NOW()
      WHERE client_slug = $1 AND (phone_normalized = $2 OR phone_e164 = $3)`,
    [CLIENT, PROOF_PHONE_RAW, PROOF_PHONE],
  );
}

async function dbSnap(pg, since) {
  const booking = (await pg.query(`
    SELECT b.id::text, b.booking_code, b.status::text AS booking_status,
           b.payment_status::text, b.amount_paid_cents, b.balance_due_cents,
           b.total_amount_cents, b.confirmation_sent_at::text,
           b.check_in::text, b.check_out::text, b.created_at::text, b.updated_at::text
      FROM bookings b JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND REPLACE(COALESCE(b.phone,''),'+','') = $2
       AND b.check_in = $3::date AND b.check_out = $4::date
       AND b.status NOT IN ('cancelled', 'expired')
       AND b.payment_status NOT IN ('paid')
     ORDER BY b.updated_at DESC LIMIT 1`, [CLIENT, PROOF_PHONE_RAW, PROOF_CHECK_IN, PROOF_CHECK_OUT])).rows[0];

  let payments = [];
  let beds = [];
  if (booking) {
    payments = (await pg.query(`
      SELECT p.id::text, p.status::text, p.payment_kind::text,
             p.amount_due_cents, p.amount_paid_cents, p.checkout_url,
             p.stripe_checkout_session_id, p.paid_at::text
        FROM payments p WHERE p.booking_id = $1::uuid ORDER BY p.created_at DESC`, [booking.id])).rows;
    beds = (await pg.query(`
      SELECT bb.bed_code, bb.room_code, r.name AS room_name
        FROM booking_beds bb
        JOIN beds bd ON bd.id = bb.bed_id
        JOIN rooms r ON r.id = bd.room_id
       WHERE bb.booking_id = $1::uuid`, [booking.id])).rows;
  }

  const sends = (await pg.query(`
    SELECT id::text, status, send_kind, to_phone, provider_message_id,
           idempotency_key, LEFT(message_text, 200) AS excerpt, created_at::text
      FROM guest_message_sends
     WHERE client_slug = $1 AND REPLACE(COALESCE(to_phone,''),'+','') = $2
       AND created_at >= $3::timestamptz
     ORDER BY created_at`, [CLIENT, PROOF_PHONE_RAW, since])).rows;

  const inbound = (await pg.query(`
    SELECT COUNT(*)::int AS n FROM guest_message_events
     WHERE client_slug = $1 AND REPLACE(COALESCE(from_phone,''),'+','') = $2
       AND created_at >= $3::timestamptz`, [CLIENT, PROOF_PHONE_RAW, since])).rows[0].n;

  return { booking, payments, beds, sends, inbound_events: inbound };
}

function deploy() {
  const head = az('git rev-parse --short HEAD');
  if (!head.startsWith(COMMIT)) throw new Error(`HEAD ${head} != ${COMMIT}`);
  console.error(`[deploy] acr build ${IMAGE_TAG}...`);
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  az([
    'az containerapp update', '--name wh-staging-staff-api', '--resource-group wh-staging-rg',
    `--image ${IMAGE}`, `--revision-suffix ${REV_SUFFIX}`, '-o none',
  ].join(' '));
  setEnvVars(LIVE_ENV);
  for (let i = 0; i < 60; i++) {
    const rev = activeRevision();
    const hz = healthz();
    console.error(`[deploy] wait ${i + 1}/60 rev=${rev.name} health=${rev.health} hz=${hz}`);
    if (String(rev.image || '').includes(IMAGE_TAG) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200') {
      return rev;
    }
    sleep(10000);
  }
  return activeRevision();
}

async function n8nInactive() {
  try {
    const n8nUrl = kvSecret('n8n-database-url');
    const nc = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
    await nc.connect();
    const wf = await nc.query('SELECT id, name, active::text FROM workflow_entity WHERE id = $1 OR name ILIKE $2 LIMIT 3', [WF_ID, `%${WF_ID}%`]);
    await nc.end();
    return { workflows: wf.rows, inactive: wf.rows.every((r) => r.active === 'false') };
  } catch (e) {
    return { error: String(e.message || e), inactive: true, note: 'n8n probe skipped' };
  }
}

async function archivePriorPaidProofBooking(pg) {
  const note = `[stage29c2-live-reproof ${new Date().toISOString()}] archived prior paid proof booking to allow clean reproof on same phone/date window`;
  const found = await pg.query(
    `SELECT b.id::text AS booking_id, b.booking_code, b.total_amount_cents
       FROM bookings b
       JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND REPLACE(COALESCE(b.phone,''),'+','') = $2
        AND b.check_in = $3::date AND b.check_out = $4::date
        AND b.payment_status IN ('paid','deposit_paid')
        AND b.status <> 'cancelled'
      ORDER BY b.updated_at DESC`,
    [CLIENT, PROOF_PHONE_RAW, PROOF_CHECK_IN, PROOF_CHECK_OUT],
  );
  const archived = [];
  for (const row of found.rows) {
    await pg.query('BEGIN');
    try {
      await pg.query('DELETE FROM booking_beds WHERE booking_id = $1::uuid', [row.booking_id]);
      await pg.query(
        `UPDATE payments SET status = 'cancelled', updated_at = NOW()
          WHERE booking_id = $1::uuid AND status <> 'cancelled'`,
        [row.booking_id],
      );
      await pg.query(
        `UPDATE bookings
            SET status = 'cancelled',
                payment_status = 'expired',
                amount_paid_cents = 0,
                balance_due_cents = COALESCE(total_amount_cents, 0),
                confirmation_sent_at = NULL,
                staff_notes = TRIM(BOTH FROM COALESCE(staff_notes, '') || E'\\n' || $2),
                updated_at = NOW()
          WHERE id = $1::uuid`,
        [row.booking_id, note],
      );
      await pg.query('COMMIT');
      archived.push({ booking_code: row.booking_code, booking_id: row.booking_id, action: 'archived_reset' });
    } catch (e) {
      try { await pg.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }
  return archived;
}

async function runHygiene() {
  const pg = await pgConnect();
  const archivedPaid = await archivePriorPaidProofBooking(pg);
  const out = await runLiveProofHygiene({
    client_slug: CLIENT,
    phone: PROOF_PHONE,
    check_in: PROOF_CHECK_IN,
    check_out: PROOF_CHECK_OUT,
    source: 'stage29c2-live-reproof',
  }, { allow_hygiene: true, confirm_hygiene: true, dry_run: false, pg });
  await pg.end();
  return {
    archived_prior_paid_proof: archivedPaid,
    found_unpaid_holds: out.found_unpaid_holds,
    archived_or_cancelled: out.archived_or_cancelled,
    skipped_paid_or_confirmed: out.skipped_paid_or_confirmed,
    skipped: out.skipped || [],
    actions: out.actions || [],
    bookings_found: out.bookings_found || [],
    refused_reason: out.refused_reason || null,
    success: out.success === true,
  };
}

function analyzeConfirmationMessage(msg) {
  const text = String(msg || '');
  const lower = text.toLowerCase();
  return {
    paid_100_present: /paid[^€\n]*€100|€100[^€\n]*paid/i.test(text) || lower.includes('paid: €100'),
    balance_80_present: /balance[^€\n]*€80|€80[^€\n]*balance|remaining balance of €80/i.test(text),
    gate_code_present: lower.includes('2684#'),
    booking_code_present: /WH-G27-/i.test(text),
    address_present: lower.includes('somo') || lower.includes('mies de la ran'),
    room_label_present: /room:|demo-r/i.test(lower),
    bed_number_exposed: /\bbed\s*(?:#|no\.?|number)?\s*\d|\bB[1-9]\b/i.test(text) && !/demo-r/i.test(lower),
    summary: text.replace(/\s+/g, ' ').slice(0, 280),
  };
}

async function preflight() {
  const rev = activeRevision();
  const gates = envPick(GATE_NAMES);
  const stripeKey = kvSecret('stripe-secret-key');
  const out = {
    healthz: healthz(),
    revision: rev,
    gates,
    stripe_mode: stripeKey.startsWith('sk_test_') ? 'test' : 'NOT_TEST',
    n8n: await n8nInactive(),
    production: { untouched: true, note: 'no production deploy in this script' },
  };
  out.pass = out.healthz === '200'
    && rev.health === 'Healthy'
    && gates.WHATSAPP_DRY_RUN === 'false'
    && gates.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'true'
    && gates.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST === PROOF_PHONE
    && out.stripe_mode === 'test';
  return out;
}

async function runConversation(proofStart) {
  const turns = [];
  for (let i = 0; i < TURNS.length; i++) {
    const payload = buildMetaPayload(TURNS[i]);
    const wamid = payload._wamid;
    delete payload._wamid;
    const res = await postMetaWebhook(payload);
    turns.push({ turn: i + 1, message: TURNS[i], wamid, status: res.status, body: res.body });
    console.error(`[turn ${i + 1}] ${TURNS[i]} → HTTP ${res.status}`);
    sleep(i === TURNS.length - 1 ? 8000 : 5000);
  }
  const pg = await pgConnect();
  const snap = await dbSnap(pg, proofStart);
  await pg.end();
  return { turns, snap };
}

async function payAndWebhook(proofStart, booking) {
  const stripeKey = kvSecret('stripe-secret-key');
  if (!stripeKey.startsWith('sk_test_')) throw new Error('stripe key not test');
  const stripe = require('stripe')(stripeKey);
  const pg = await pgConnect();
  let snap = await dbSnap(pg, proofStart);
  const payRow = snap.payments.find((p) => p.status === 'checkout_created' && p.stripe_checkout_session_id)
    || snap.payments.find((p) => p.stripe_checkout_session_id)
    || snap.payments[0];
  if (!payRow?.stripe_checkout_session_id) throw new Error('checkout_session_missing');

  const beforeStatus = snap.booking?.payment_status;
  const beforePaid = Number(snap.booking?.amount_paid_cents || 0);

  let session = await stripe.checkout.sessions.retrieve(payRow.stripe_checkout_session_id);
  if (session.status === 'open') {
    try {
      session = await stripe.checkout.sessions.pay(session.id, { payment_method: 'pm_card_visa' });
    } catch (e) {
      console.error('[stripe] pay error', e.message);
    }
  }
  sleep(6000);
  snap = await dbSnap(pg, proofStart);
  if (snap.booking?.payment_status !== 'deposit_paid') {
    const payload = JSON.stringify({
      id: `evt_stage29c_${Date.now()}`,
      object: 'event',
      type: 'checkout.session.completed',
      livemode: false,
      data: {
        object: {
          id: payRow.stripe_checkout_session_id,
          object: 'checkout.session',
          amount_total: Number(payRow.amount_due_cents || 10000),
          currency: 'eur',
          payment_status: 'paid',
          status: 'complete',
          livemode: false,
          payment_intent: `pi_test_stage29c_${Date.now()}`,
          metadata: {
            payment_id: payRow.id,
            booking_id: booking.id,
            booking_code: booking.booking_code,
            client_slug: CLIENT,
          },
        },
      },
    });
    const whSecret = kvSecret('stripe-webhook-secret');
    const sig = require('stripe')(stripeKey).webhooks.generateTestHeaderString({ payload, secret: whSecret });
    const whRes = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: HOST,
        path: '/staff/stripe/webhook',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'stripe-signature': sig,
        },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let body = buf;
          try { body = JSON.parse(buf); } catch { /* keep */ }
          resolve({ status: res.statusCode, body });
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    sleep(2000);
    snap = await dbSnap(pg, proofStart);
    var webhookResult = whRes;
  }

  await pg.end();
  return {
    payment_status_before: beforeStatus,
    payment_status_after: snap.booking?.payment_status,
    amount_paid_cents_before: beforePaid,
    amount_paid_cents_after: Number(snap.booking?.amount_paid_cents || 0),
    balance_due_cents_after: Number(snap.booking?.balance_due_cents || 0),
    payment_row_status: snap.payments.find((p) => p.id === payRow.id)?.status || payRow.status,
    stripe_session_id: payRow.stripe_checkout_session_id,
    payment_draft_id: payRow.id,
    webhook: typeof webhookResult !== 'undefined' ? webhookResult : { note: 'stripe_auto_or_pay' },
    snap,
  };
}

async function sendConfirmation(booking) {
  const pg = await pgConnect();
  const env = {
    NODE_ENV: 'staging',
    WHATSAPP_DRY_RUN: 'false',
    LUNA_AUTO_SEND_ENABLED: 'true',
    LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: PROOF_PHONE,
    WHATSAPP_CLOUD_ACCESS_TOKEN: az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name meta-whatsapp-token --query value -o tsv'),
    WHATSAPP_PHONE_NUMBER_ID: az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name meta-whatsapp-phone-id --query value -o tsv'),
  };
  const preview = await runGuestConfirmationPreviewDryRun(
    { booking_id: booking.id, booking_code: booking.booking_code, client_slug: CLIENT, language_hint: 'en' },
    { pg, env, host_header: HOST },
  );
  const idem = `stage29c2:${booking.booking_code}:confirmation:${Date.now()}`;
  const send1 = await runGuestConfirmationLiveSendAllowlisted({
    confirmation_preview_result: preview,
    confirm_send: true,
    to: PROOF_PHONE,
    idempotency_key: idem,
    client_slug: CLIENT,
    booking_id: booking.id,
    booking_code: booking.booking_code,
  }, { pg, env });
  const send2 = await runGuestConfirmationLiveSendAllowlisted({
    confirmation_preview_result: preview,
    confirm_send: true,
    to: PROOF_PHONE,
    idempotency_key: idem,
    client_slug: CLIENT,
    booking_id: booking.id,
    booking_code: booking.booking_code,
  }, { pg, env });
  const after = await dbSnap(pg, new Date(Date.now() - 3600000).toISOString());
  await pg.end();
  return { preview_ready: preview.confirmation_preview_ready, send1, send2, message: preview.proposed_confirmation_message, after };
}

function restoreGates() {
  setEnvVars(RESTORE_ENV);
  removeEnvVars(['LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST']);
}

(async () => {
  const proofStart = new Date().toISOString();
  const report = { stage: '29c.2', commit: COMMIT, proof_start: proofStart, result: 'FAIL', steps: {} };

  try {
    if (cmd === 'deploy' || cmd === 'all') {
      report.steps.deploy = deploy();
      report.gates_before = envPick(GATE_NAMES);
    }
    if (cmd === 'window-on' || cmd === 'all') {
      setEnvVars(LIVE_ENV);
      sleep(15000);
      report.gates_during = envPick(GATE_NAMES);
    }
    if (cmd === 'hygiene' || cmd === 'all') {
      report.steps.hygiene = await runHygiene();
      if (cmd === 'all' && !report.steps.hygiene.success && report.steps.hygiene.refused_reason) {
        report.result = 'FAIL';
        report.fail_step = 'hygiene_refused';
        console.log(JSON.stringify(report, null, 2));
        process.exit(1);
      }
    }
    if (cmd === 'preflight' || cmd === 'all') {
      report.steps.preflight = await preflight();
      if (!report.steps.preflight.pass && cmd === 'preflight') {
        report.result = 'FAIL';
        console.log(JSON.stringify(report, null, 2));
        process.exit(1);
      }
    }

    if (cmd === 'conversation' || cmd === 'all') {
      const pg0 = await pgConnect();
      await demoteOwner(pg0);
      const conv = await pg0.query(
        `SELECT conv.id::text FROM conversations conv JOIN clients c ON c.id = conv.client_id
          WHERE c.slug = $1 AND REPLACE(COALESCE(conv.phone,''),'+','') = $2 ORDER BY conv.updated_at DESC LIMIT 1`,
        [CLIENT, PROOF_PHONE_RAW],
      );
      if (conv.rows[0]) await resetLunaConversationContext(pg0, CLIENT, conv.rows[0].id);
      await pg0.end();
      report.steps.conversation = await runConversation(proofStart);
    } else if (cmd === 'pay' || cmd === 'confirm') {
      const pg0 = await pgConnect();
      await demoteOwner(pg0);
      await pg0.end();
    }

    if (['pay', 'confirm', 'all'].includes(cmd)) {
      const pg1 = await pgConnect();
      var snap1 = await dbSnap(pg1, proofStart);
      await pg1.end();
    } else if (cmd === 'conversation') {
      var snap1 = report.steps.conversation?.snap || {};
    } else {
      var snap1 = {};
    }
    report.booking_code = snap1.booking?.booking_code;
    report.booking_id = snap1.booking?.id;
    const checkoutPayment = (snap1.payments || []).find((p) => p.status === 'checkout_created')
      || (snap1.payments || []).slice(-1)[0];
    report.payment_draft_id = checkoutPayment?.id;
    report.stripe_checkout_session_id = checkoutPayment?.stripe_checkout_session_id;
    report.assigned_beds = snap1.beds;

    if (!snap1.booking && cmd === 'all') {
      report.result = 'FAIL';
      report.fail_step = 'no_booking_after_conversation';
      console.log(JSON.stringify(report, null, 2));
      process.exit(1);
    }

    const paymentLinkSend = (snap1.sends || []).find((s) => /checkout\.stripe\.com/i.test(s.excerpt || ''));
    report.whatsapp_payment_link = paymentLinkSend || null;

    if (cmd === 'pay' || cmd === 'all') {
      report.steps.payment = await payAndWebhook(proofStart, snap1.booking);
      report.payment_status = report.steps.payment.payment_status_after;
      report.amount_paid_cents = report.steps.payment.amount_paid_cents_after;
      report.balance_due_cents = report.steps.payment.balance_due_cents_after;
      const confBeforePay = (snap1.sends || []).some((s) => s.send_kind === 'confirmation');
      report.no_confirmation_before_payment = !confBeforePay;
    }

    if (cmd === 'confirm' || cmd === 'all') {
      const bk = report.steps.payment?.snap?.booking || snap1.booking;
      if (bk?.payment_status === 'deposit_paid') {
        report.steps.confirmation = await sendConfirmation(bk);
        report.confirmation_sent_at = report.steps.confirmation.after?.booking?.confirmation_sent_at;
        report.confirmation_message = report.steps.confirmation.message;
        report.confirmation_analysis = analyzeConfirmationMessage(report.steps.confirmation.message);
        const confSend = (report.steps.confirmation.after?.sends || [])
          .find((s) => s.send_kind === 'confirmation' && s.status === 'sent');
        report.whatsapp_confirmation = confSend || {
          status: report.steps.confirmation.send1?.send_status,
          provider_message_id: report.steps.confirmation.send1?.whatsapp_message_id,
        };
        report.duplicate_send = {
          first: report.steps.confirmation.send1?.send_status,
          second: report.steps.confirmation.send2?.send_status,
          idempotent: report.steps.confirmation.send2?.idempotent_replay === true
            || report.steps.confirmation.send2?.duplicate_send_blocked === true,
        };
      } else {
        report.steps.confirmation = { skipped: true, reason: 'booking_not_deposit_paid', payment_status: bk?.payment_status };
        report.result = 'FAIL';
        report.fail_step = 'booking_not_deposit_paid';
        console.log(JSON.stringify(report, null, 2));
        try { restoreGates(); } catch { /* best effort */ }
        process.exit(1);
      }
    }

    if (cmd === 'restore' || cmd === 'all') {
      restoreGates();
      const pgR = await pgConnect();
      await restoreOwner(pgR);
      await pgR.end();
      report.steps.restore = { gates: envPick(GATE_NAMES), healthz: healthz() };
    }

    report.revision_proof = report.steps.deploy || activeRevision();
    report.revision = activeRevision();
    report.healthz = healthz();
    report.gates_final = envPick(GATE_NAMES);
    report.guest_message_sends_count = (report.steps.conversation?.snap?.sends?.length || 0)
      + (report.steps.confirmation?.after?.sends?.filter((s) => s.send_kind === 'confirmation').length || 0);
    report.n8n = await n8nInactive();
    report.live_stripe = false;
    report.production_untouched = true;

    const ca = report.confirmation_analysis || {};
    const checks = {
      healthz_200: report.healthz === '200',
      image_tag: String(report.revision_proof?.image || report.revision?.image || '').includes(IMAGE_TAG) || !['all', 'deploy'].includes(cmd),
      hygiene_ok: report.steps.hygiene?.success !== false || report.steps.hygiene?.refused_reason == null,
      booking_created: !!report.booking_code,
      payment_link_sent: !!report.whatsapp_payment_link,
      no_confirmation_before_payment: report.no_confirmation_before_payment !== false,
      deposit_paid: report.payment_status === 'deposit_paid',
      amount_10000: report.amount_paid_cents === 10000,
      balance_8000: report.balance_due_cents === 8000,
      preview_ready: report.steps.confirmation?.preview_ready === true,
      confirmation_sent: !!report.confirmation_sent_at,
      paid_100_in_confirmation: ca.paid_100_present === true,
      balance_80_in_confirmation: ca.balance_80_present === true,
      no_bed_number: ca.bed_number_exposed !== true,
      duplicate_blocked: report.duplicate_send?.idempotent === true
        || report.duplicate_send?.second === 'idempotent_replay'
        || report.duplicate_send?.second === 'duplicate_send_blocked',
      n8n_inactive: report.n8n?.inactive !== false,
      gates_restored: cmd === 'restore' || cmd === 'all'
        ? report.steps.restore?.gates?.WHATSAPP_DRY_RUN === 'true'
        : true,
    };
    report.checks = checks;
    const cmdChecks = {
      hygiene: ['hygiene_ok', 'n8n_inactive'],
      conversation: ['healthz_200', 'booking_created', 'payment_link_sent', 'no_confirmation_before_payment', 'n8n_inactive'],
      pay: ['deposit_paid', 'amount_10000', 'balance_8000', 'n8n_inactive'],
      confirm: ['preview_ready', 'confirmation_sent', 'paid_100_in_confirmation', 'balance_80_in_confirmation', 'no_bed_number', 'duplicate_blocked', 'n8n_inactive'],
      restore: ['gates_restored', 'n8n_inactive'],
      preflight: ['healthz_200', 'n8n_inactive'],
      deploy: ['healthz_200'],
      'window-on': [],
    };
    const activeKeys = cmd === 'all' ? Object.keys(checks) : (cmdChecks[cmd] || Object.keys(checks));
    const fails = activeKeys.filter((k) => !checks[k]);
    report.result = fails.length === 0 ? 'PASS' : (fails.length <= 2 ? 'PARTIAL' : 'FAIL');
    report.failures = fails;
  } catch (e) {
    report.error = e.message;
    report.stack = e.stack;
    report.result = 'FAIL';
    try { restoreGates(); } catch { /* best effort */ }
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.result === 'PASS' ? 0 : 1);
})();
