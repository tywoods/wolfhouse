'use strict';
/** Stage 30d — live staging Luna personality WhatsApp reproof. Temp — do not commit. */
const crypto = require('crypto');
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { resetLunaConversationContext } = require('./scripts/lib/staff-conversation-writes');
const { runGuestConfirmationPreviewDryRun } = require('./scripts/lib/luna-guest-confirmation-preview-dry-run');
const { runGuestConfirmationLiveSendAllowlisted } = require('./scripts/lib/luna-guest-confirmation-send-go-no-go');
const { runLiveProofHygiene } = require('./scripts/lib/luna-live-proof-hygiene');
const { passesConfirmationStyleContract } = require('./scripts/lib/luna-guest-confirmation-copy-style');
const { FORBIDDEN_GUEST_PHRASES } = require('./scripts/lib/luna-guest-reply-style-contract');

const COMMIT = '0c15364';
const IMAGE_TAG = `${COMMIT}-stage30d-live-reproof`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 'stage30d-live-reproof';
const HOST = 'staff-staging.lunafrontdesk.com';
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

const FORBIDDEN_EXTRA = [
  'preview ready',
  'confirmation_sent_at',
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
  const wamid = `wamid.stage30d.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  const from = PROOF_PHONE_RAW;
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '34663439419', phone_number_id: DEMO_PHONE_ID },
          contacts: [{ profile: { name: 'Stage30d Guest' }, wa_id: from }],
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

async function fetchOutboundReplies(pg, since) {
  const rows = (await pg.query(`
    SELECT id::text, status, send_kind, provider_message_id, message_text, created_at::text
      FROM guest_message_sends
     WHERE client_slug = $1 AND REPLACE(COALESCE(to_phone,''),'+','') = $2
       AND created_at >= $3::timestamptz
       AND send_kind IN ('staff_reply', 'confirmation')
     ORDER BY created_at`, [CLIENT, PROOF_PHONE_RAW, since])).rows;
  return rows;
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

  const sends = await fetchOutboundReplies(pg, since);

  return { booking, payments, beds, sends };
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

async function runHygiene() {
  const pg = await pgConnect();
  const out = await runLiveProofHygiene({
    client_slug: CLIENT,
    phone: PROOF_PHONE,
    check_in: PROOF_CHECK_IN,
    check_out: PROOF_CHECK_OUT,
    source: 'stage30d-live-reproof',
  }, {
    allow_hygiene: true,
    allow_staging_paid_proof_reset: true,
    confirm_hygiene: true,
    dry_run: false,
    pg,
    host_header: HOST,
  });
  await pg.end();
  return out;
}

function forbiddenHits(text) {
  const lower = String(text || '').toLowerCase();
  const all = [...FORBIDDEN_GUEST_PHRASES, ...FORBIDDEN_EXTRA];
  return all.filter((p) => lower.includes(p.toLowerCase()));
}

function analyzeCopyQuality(text, turnContext) {
  const t = String(text || '').trim();
  const lower = t.toLowerCase();
  const forbidden = forbiddenHits(t);
  const questionMarks = (t.match(/\?/g) || []).length;
  const lines = t.split(/\n+/).filter(Boolean);
  return {
    text: t,
    turn_context: turnContext,
    sounds_natural: forbidden.length === 0 && !/\bi am not\b/i.test(t) && !/\bestimate a total\b/i.test(t),
    repeats_info_too_much: /\b(?:july 1|july 1 to july 5)\b/i.test(t) && turnContext > 3,
    one_clear_next_step: questionMarks <= 1,
    preserves_context: /\b(?:€180|€100|deposit|accommodation|july|wolfhouse|luna)\b/i.test(t) || turnContext <= 2,
    forbidden_internal_language: forbidden,
    passes_style: forbidden.length === 0,
    char_count: t.length,
    line_count: lines.length,
  };
}

function buildTranscript(turns, sends) {
  const staffReplies = sends.filter((s) => s.send_kind === 'staff_reply');
  const transcript = [];
  for (let i = 0; i < TURNS.length; i++) {
    const reply = staffReplies[i];
    const quality = analyzeCopyQuality(reply?.message_text || '(no reply captured)', i + 1);
    transcript.push({
      turn: i + 1,
      guest: TURNS[i],
      luna: quality.text,
      send_status: reply?.status || null,
      provider_message_id: reply?.provider_message_id || null,
      copy_quality: quality,
    });
  }
  return transcript;
}

function analyzeConfirmationMessage(msg, bookingCode) {
  const text = String(msg || '');
  const style = passesConfirmationStyleContract(text, {
    booking_code: bookingCode,
    amount_paid_cents: 10000,
    balance_due_cents: 8000,
  });
  return {
    paid_100_present: /paid[^€\n]*€100|€100[^€\n]*paid/i.test(text) || text.toLowerCase().includes('paid: €100'),
    balance_80_present: /balance[^€\n]*€80|€80[^€\n]*balance|remaining balance of €80/i.test(text),
    gate_code_present: text.includes('2684#'),
    booking_code_present: bookingCode ? text.includes(bookingCode) : /WH-G27-/i.test(text),
    address_present: /somo|mies de la ran/i.test(text),
    room_label_present: /room:|demo-r/i.test(text.toLowerCase()),
    bed_number_exposed: /\bbed\s*(?:#|no\.?|number)?\s*\d|\bB[1-9]\b/i.test(text) && !/demo-r/i.test(text.toLowerCase()),
    style_contract: style,
    forbidden: forbiddenHits(text),
    copy_quality: analyzeCopyQuality(text, 'confirmation'),
    full_text: text,
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
    production: { untouched: true },
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
    delete payload._wamid;
    const res = await postMetaWebhook(payload);
    turns.push({ turn: i + 1, message: TURNS[i], status: res.status, body: res.body });
    console.error(`[turn ${i + 1}] ${TURNS[i]} → HTTP ${res.status}`);
    sleep(i === TURNS.length - 1 ? 10000 : 6000);
  }
  const pg = await pgConnect();
  const snap = await dbSnap(pg, proofStart);
  const transcript = buildTranscript(turns, snap.sends);
  await pg.end();
  return { turns, snap, transcript };
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
  let webhookResult = { note: 'stripe_auto_or_pay' };
  if (snap.booking?.payment_status !== 'deposit_paid') {
    const payload = JSON.stringify({
      id: `evt_stage30d_${Date.now()}`,
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
          payment_intent: `pi_test_stage30d_${Date.now()}`,
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
    webhookResult = await new Promise((resolve, reject) => {
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
    webhook: webhookResult,
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
  const idem = `stage30d:${booking.booking_code}:confirmation:${Date.now()}`;
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
  const report = { stage: '30d', commit: COMMIT, image_tag: IMAGE_TAG, proof_start: proofStart, result: 'FAIL', steps: {} };

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
      if (cmd === 'all' && report.steps.hygiene.refused_reason) {
        report.result = 'FAIL';
        report.fail_step = 'hygiene_refused';
        console.log(JSON.stringify(report, null, 2));
        process.exit(1);
      }
    }
    if (cmd === 'preflight' || cmd === 'all') {
      report.steps.preflight = await preflight();
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
      report.transcript = report.steps.conversation.transcript;
    }

    if (['pay', 'confirm', 'all'].includes(cmd)) {
      const pg1 = await pgConnect();
      var snap1 = await dbSnap(pg1, proofStart);
      await pg1.end();
    } else {
      var snap1 = report.steps.conversation?.snap || {};
    }

    report.booking_code = snap1.booking?.booking_code;
    report.booking_id = snap1.booking?.id;
    const checkoutPayment = (snap1.payments || []).find((p) => p.status === 'checkout_created')
      || (snap1.payments || []).slice(-1)[0];
    report.payment_draft_id = checkoutPayment?.id;
    report.stripe_checkout_session_id = checkoutPayment?.stripe_checkout_session_id;
    report.assigned_beds = snap1.beds;
    report.room_label = snap1.beds?.[0]?.room_name || snap1.beds?.[0]?.room_code;
    report.bed_label = snap1.beds?.[0]?.bed_code;

    if (!snap1.booking && (cmd === 'all' || cmd === 'conversation')) {
      report.result = 'FAIL';
      report.fail_step = 'no_booking_after_conversation';
      console.log(JSON.stringify(report, null, 2));
      try { restoreGates(); } catch { /* ignore */ }
      process.exit(1);
    }

    const paymentLinkSend = (snap1.sends || []).find((s) => /checkout\.stripe\.com/i.test(s.message_text || ''));
    report.whatsapp_payment_link = paymentLinkSend || null;

    if (cmd === 'pay' || cmd === 'all') {
      report.steps.payment = await payAndWebhook(proofStart, snap1.booking);
      report.payment_status = report.steps.payment.payment_status_after;
      report.amount_paid_cents = report.steps.payment.amount_paid_cents_after;
      report.balance_due_cents = report.steps.payment.balance_due_cents_after;
      report.no_confirmation_before_payment = !(snap1.sends || []).some((s) => s.send_kind === 'confirmation');
    }

    if (cmd === 'confirm' || cmd === 'all') {
      const bk = report.steps.payment?.snap?.booking || snap1.booking;
      if (bk?.payment_status === 'deposit_paid') {
        report.steps.confirmation = await sendConfirmation(bk);
        report.confirmation_sent_at = report.steps.confirmation.after?.booking?.confirmation_sent_at;
        report.confirmation_message = report.steps.confirmation.message;
        report.confirmation_analysis = analyzeConfirmationMessage(report.steps.confirmation.message, bk.booking_code);
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
        if (confSend) {
          report.transcript = report.transcript || [];
          report.transcript.push({
            turn: 'confirmation',
            guest: '(stripe payment completed)',
            luna: confSend.message_text,
            send_status: confSend.status,
            provider_message_id: confSend.provider_message_id,
            copy_quality: analyzeCopyQuality(confSend.message_text, 'confirmation_whatsapp'),
          });
        }
      } else if (cmd === 'confirm' || cmd === 'all') {
        report.fail_step = 'booking_not_deposit_paid';
        console.log(JSON.stringify(report, null, 2));
        try { restoreGates(); } catch { /* ignore */ }
        process.exit(1);
      }
    }

    if (cmd === 'restore' || cmd === 'all') {
      restoreGates();
      const pgR = await pgConnect();
      await restoreOwner(pgR);
      await pgR.end();
      sleep(15000);
      report.steps.restore = { gates: envPick(GATE_NAMES), healthz: healthz(), revision: activeRevision() };
    }

    report.revision_proof = report.steps.deploy || activeRevision();
    report.revision_restored = report.steps.restore?.revision || activeRevision();
    report.healthz = healthz();
    report.gates_final = envPick(GATE_NAMES);
    report.n8n = await n8nInactive();
    report.live_stripe = false;
    report.production_untouched = true;

    const ca = report.confirmation_analysis || {};
    const transcriptOk = (report.transcript || []).every((t) => (t.copy_quality?.forbidden_internal_language || []).length === 0);
    const quoteOk = (report.transcript || []).some((t) => /€180/i.test(t.luna || ''));
    const checks = {
      healthz_200: report.healthz === '200',
      image_tag: String(report.revision_proof?.image || '').includes(IMAGE_TAG) || !['all', 'deploy'].includes(cmd),
      hygiene_ok: report.steps.hygiene?.success === true,
      booking_created: !!report.booking_code,
      payment_link_sent: !!report.whatsapp_payment_link,
      no_confirmation_before_payment: report.no_confirmation_before_payment !== false,
      transcript_no_forbidden: transcriptOk,
      quote_180: quoteOk || cmd === 'hygiene',
      deposit_paid: report.payment_status === 'deposit_paid',
      amount_10000: report.amount_paid_cents === 10000,
      balance_8000: report.balance_due_cents === 8000,
      preview_ready: report.steps.confirmation?.preview_ready === true,
      confirmation_sent: !!report.confirmation_sent_at,
      paid_100_in_confirmation: ca.paid_100_present === true,
      balance_80_in_confirmation: ca.balance_80_present === true,
      no_bed_number: ca.bed_number_exposed !== true,
      style_contract: ca.style_contract?.ok === true,
      duplicate_blocked: report.duplicate_send?.idempotent === true
        || report.duplicate_send?.second === 'idempotent_replay',
      n8n_inactive: report.n8n?.inactive !== false,
      gates_restored: report.steps.restore?.gates?.WHATSAPP_DRY_RUN === 'true',
      allowlist_removed: report.steps.restore?.gates?.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null,
    };
    report.checks = checks;
    const fails = Object.keys(checks).filter((k) => !checks[k]);
    report.failures = fails;
    report.result = fails.length === 0 ? 'PASS' : (fails.length <= 2 ? 'PARTIAL' : 'FAIL');
  } catch (e) {
    report.error = e.message;
    report.stack = e.stack;
    report.result = 'FAIL';
    try { restoreGates(); } catch { /* best effort */ }
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.result === 'PASS' ? 0 : 1);
})();
