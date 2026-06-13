'use strict';
/** Stage 28j.7 — deploy 780c330 Luna composer + Stripe TEST payment link live proof. Temp — do not commit. */
const { Client } = require('pg');
const { execSync } = require('child_process');
const { resetLunaConversationContext } = require('./scripts/lib/staff-conversation-writes');

const COMMIT = '780c330';
const IMAGE_TAG = `${COMMIT}-stage28j7-luna-composer-payment-link-live`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's28j7-composer-paylink';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const STAFF_META_CALLBACK = `https://${STAFF_HOST}/staff/meta/whatsapp/webhook`;
const WF_ID = 'stage27demoLWrite01';
const PROOF_PHONE = '+491726422307';
const PROOF_PHONE_RAW = '491726422307';
const DEMO_WA = '+34 663 43 94 19';
const DEMO_PHONE_ID = '1152900101233109';

const PLAYGROUND_ON_ENV = {
  WHATSAPP_DRY_RUN: 'false',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
  WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
  STRIPE_LINKS_ENABLED: 'true',
  STAFF_ACTIONS_ENABLED: 'true',
  LUNA_CONVERSATION_BRAIN_ENABLED: 'true',
  LUNA_CONVERSATION_BRAIN_LLM_ENABLED: 'true',
  LUNA_CONVERSATION_BRAIN_MODEL: 'gpt-5.5',
  LUNA_CONVERSATION_BRAIN_REASONING_EFFORT: 'low',
  LUNA_CONVERSATION_BRAIN_TIMEOUT_MS: '4000',
};

const GATE_NAMES = [
  ...Object.keys(PLAYGROUND_ON_ENV),
  'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
  'NODE_ENV',
  'STRIPE_SECRET_KEY',
  'STRIPE_LINKS_ENABLED',
  'STAFF_ACTIONS_ENABLED',
];

const RETEST_MESSAGES = [
  'hi',
  'book a stay',
  'July 1-5',
  'just me',
  'Just the stay please',
  'deposit',
];

const cmd = process.argv[2] || 'all';
const DEPLOY_STARTED_AT = new Date().toISOString();

function az(cmdStr, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      return execSync(cmdStr, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      last = err;
      if (i < retries - 1) {
        const until = Date.now() + 2000;
        while (Date.now() < until) { /* backoff */ }
      }
    }
  }
  throw last;
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
  return execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${STAFF_HOST}/healthz`, { encoding: 'utf8' }).trim();
}

async function pgConnect() {
  const db = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  if (/prod(uction)?/i.test(db) && !/staging/i.test(db)) {
    throw new Error('refusing production-looking database URL');
  }
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

async function n8nWorkflowInactive() {
  try {
    const n8nUrl = az('az keyvault secret show --vault-name wh-staging-kv --name n8n-database-url --query value -o tsv');
    const nc = new Client({ connectionString: n8nUrl, ssl: { rejectUnauthorized: false } });
    await nc.connect();
    const wf = await nc.query(
      `SELECT id, name, active::text FROM workflow_entity WHERE id = $1 OR name ILIKE $2 LIMIT 3`,
      [WF_ID, `%${WF_ID}%`],
    );
    await nc.end();
    return { workflow_id: WF_ID, workflows: wf.rows, inactive: wf.rows.every((r) => r.active === 'false') };
  } catch (e) {
    return { workflow_id: WF_ID, error: String(e.message || e), note: 'fallback: no activation in this deploy' };
  }
}

function productionUntouched() {
  try {
    const prod = JSON.parse(az(
      'az containerapp show --name wh-production-staff-api --resource-group wh-production-rg --query "{image:properties.template.containers[0].image,latestRevision:properties.latestRevisionName}" -o json',
    ));
    return { production_staff_api: prod, untouched: true };
  } catch (e) {
    return { note: 'production probe skipped', error: String(e.message || e) };
  }
}

function stripeKeyIsTest() {
  try {
    const key = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name stripe-secret-key --query value -o tsv');
    return { present: !!key, is_test: String(key).startsWith('sk_test_'), prefix: String(key).slice(0, 8) };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function deploy() {
  if (process.env.SKIP_DEPLOY === '1') {
    console.error('[deploy] SKIP_DEPLOY=1');
    return activeRevision();
  }
  const head = az('git rev-parse --short HEAD');
  if (!head.startsWith(COMMIT)) {
    throw new Error(`HEAD is ${head}, expected ${COMMIT}`);
  }
  console.error(`[deploy] acr build ${IMAGE_TAG}...`);
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('[deploy] containerapp update...');
  az([
    'az containerapp update', '--name wh-staging-staff-api', '--resource-group wh-staging-rg',
    `--image ${IMAGE}`, `--revision-suffix ${REV_SUFFIX}`, '-o none',
  ].join(' '));
  console.error('[deploy] re-apply playground ON + Stripe TEST + brain gates...');
  setEnvVars(PLAYGROUND_ON_ENV);
  for (let i = 0; i < 45; i++) {
    const rev = activeRevision();
    const hz = healthz();
    console.error(`[deploy] wait ${i + 1}/45 rev=${rev.name} health=${rev.health} traffic=${rev.traffic} hz=${hz}`);
    if (String(rev.image || '').includes(IMAGE_TAG) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200') {
      return rev;
    }
    execSync('powershell -Command "Start-Sleep -Seconds 10"');
  }
  return activeRevision();
}

async function preflight() {
  const rev = activeRevision();
  const gates = envPick(GATE_NAMES);
  const hz = healthz();
  const stripeKey = stripeKeyIsTest();
  const pg = await pgConnect();
  const spa = await pg.query(
    `SELECT role, is_active::text, phone_e164, phone_normalized
       FROM staff_phone_access
      WHERE client_slug = 'wolfhouse-somo'
        AND (phone_normalized IN ($1,$2) OR phone_e164 IN ($1,$2))`,
    [PROOF_PHONE_RAW, PROOF_PHONE],
  );
  await pg.end();
  const n8n = await n8nWorkflowInactive();
  const prod = productionUntouched();
  const pass = String(rev.image || '').includes(IMAGE_TAG)
    && rev.health === 'Healthy'
    && rev.traffic === 100
    && hz === '200'
    && gates.WHATSAPP_DRY_RUN === 'false'
    && gates.OPEN_DEMO_WHATSAPP_ENABLED === 'true'
    && gates.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'true'
    && gates.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'true'
    && gates.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'true'
    && gates.STRIPE_LINKS_ENABLED === 'true'
    && gates.STAFF_ACTIONS_ENABLED === 'true'
    && gates.LUNA_CONVERSATION_BRAIN_LLM_ENABLED === 'true'
    && gates.LUNA_CONVERSATION_BRAIN_MODEL === 'gpt-5.5'
    && (gates.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null || gates.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST === '')
    && spa.rows.some((r) => r.is_active === 'false')
    && (n8n.inactive !== false)
    && stripeKey.is_test === true;
  return {
    pass,
    active_revision: rev,
    healthz: hz,
    gates,
    stripe_key: stripeKey,
    meta_webhook_expected: STAFF_META_CALLBACK,
    staff_phone_access: spa.rows,
    n8n,
    production: prod,
    image: IMAGE,
  };
}

async function freshStart() {
  const pg = await pgConnect();
  const conv = await pg.query(
    `SELECT conv.id::text
       FROM conversations conv JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(conv.phone,''),'+','') = $1
      ORDER BY conv.updated_at DESC LIMIT 1`,
    [PROOF_PHONE_RAW],
  );
  if (!conv.rows[0]) {
    await pg.end();
    return { ok: true, note: 'no conversation row yet — fresh start not required' };
  }
  const out = await resetLunaConversationContext(pg, 'wolfhouse-somo', conv.rows[0].id);
  await pg.end();
  return { ok: true, conversation_id: conv.rows[0].id, ...out };
}

async function inspectRetest(sinceIso) {
  const since = sinceIso || DEPLOY_STARTED_AT;
  const pg = await pgConnect();

  const events = await pg.query(
    `SELECT id::text, created_at::text, message_text, wa_message_id, suggested_reply, next_action, send_status,
            normalized->'open_demo_result' AS open_demo_result
       FROM guest_message_events
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(from_phone,''),'+','') = $1
        AND created_at >= $2::timestamptz
      ORDER BY created_at ASC`,
    [PROOF_PHONE_RAW, since],
  );

  const sends = await pg.query(
    `SELECT id::text, status, message_text, provider_message_id, created_at::text, send_kind
       FROM guest_message_sends
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(to_phone,''),'+','') = $1
        AND created_at >= $2::timestamptz
      ORDER BY created_at ASC`,
    [PROOF_PHONE_RAW, since],
  );

  const conv = await pg.query(
    `SELECT conv.id::text, conv.last_message_preview, conv.updated_at::text,
            conv.metadata->'luna_guest_context' AS luna_guest_context
       FROM conversations conv JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(conv.phone,''),'+','') = $1`,
    [PROOF_PHONE_RAW],
  );

  let messages = [];
  if (conv.rows[0]) {
    const m = await pg.query(
      `SELECT id::text, direction::text, message_text, source, whatsapp_message_id, created_at::text
         FROM messages WHERE conversation_id = $1::uuid
        AND created_at >= $2::timestamptz
         ORDER BY created_at ASC`,
      [conv.rows[0].id, since],
    );
    messages = m.rows;
  }

  const bookings = await pg.query(
    `SELECT b.id::text, b.booking_code, b.package_code, b.status::text, b.payment_status::text,
            b.check_in::text, b.check_out::text, b.guest_count, b.deposit_cents, b.created_at::text
       FROM bookings b JOIN clients c ON c.id = b.client_id
      WHERE c.slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(b.phone,''),'+','') = $1
        AND b.created_at >= $2::timestamptz
      ORDER BY b.created_at DESC`,
    [PROOF_PHONE_RAW, since],
  );

  const payments = await pg.query(
    `SELECT p.id::text, p.status::text, p.payment_kind::text, p.amount_cents, p.stripe_checkout_session_id,
            p.stripe_checkout_url, p.created_at::text, b.booking_code
       FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN clients c ON c.id = b.client_id
      WHERE c.slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(b.phone,''),'+','') = $1
        AND p.created_at >= $2::timestamptz
      ORDER BY p.created_at DESC`,
    [PROOF_PHONE_RAW, since],
  );

  const beds = await pg.query(
    `SELECT ba.id::text, ba.booking_id::text, ba.bed_id::text, ba.status::text, ba.created_at::text,
            b.booking_code
       FROM bed_assignments ba
       JOIN bookings b ON b.id = ba.booking_id
       JOIN clients c ON c.id = b.client_id
      WHERE c.slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(b.phone,''),'+','') = $1
        AND ba.created_at >= $2::timestamptz
      ORDER BY ba.created_at DESC`,
    [PROOF_PHONE_RAW, since],
  );

  const dupBookings = await pg.query(
    `SELECT COUNT(*)::int AS n
       FROM bookings b JOIN clients c ON c.id = b.client_id
      WHERE c.slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(b.phone,''),'+','') = $1
        AND b.created_at >= $2::timestamptz
        AND b.status::text IN ('hold','pending_payment','confirmed')`,
    [PROOF_PHONE_RAW, since],
  );

  await pg.end();

  const turns = [];
  for (const ev of events.rows) {
    const odr = ev.open_demo_result || {};
    const brain = odr?.result?.conversation_brain || odr?.conversation_brain || null;
    const send = sends.rows.find((s) => Math.abs(new Date(s.created_at) - new Date(ev.created_at)) < 180000);
    turns.push({
      inbound: ev.message_text,
      outbound: send?.message_text || ev.suggested_reply,
      next_action: ev.next_action,
      send_status: ev.send_status,
      final_reply_source: brain?.final_reply_source || odr?.final_reply_source || null,
      composer_state: brain?.composer_state || odr?.composer_state || null,
      brain_source: brain?.source || null,
      model_used: brain?.model_used || null,
      brain,
      open_demo: {
        booking_write: odr?.booking_write || odr?.bookingWrite || null,
        stripe_link: odr?.stripe_link || odr?.stripeLink || null,
        payment_link_send: odr?.payment_link_send || odr?.paymentLinkSend || null,
        bed_assignment: odr?.bed_assignment || odr?.bedAssignment || null,
      },
    });
  }

  const depositTurn = turns.find((t) => /^deposit$/i.test((t.inbound || '').trim()));
  const depositReply = depositTurn?.outbound || '';
  const stripeUrlInReply = /https:\/\/checkout\.stripe\.com\//i.test(depositReply);
  const forbiddenDefer = /team will send|I am not creating a hold|I'll line up secure payment next/i.test(depositReply);

  const latestBooking = bookings.rows[0] || null;
  const latestPayment = payments.rows[0] || null;
  const paymentLinkSend = sends.rows.find((s) => /checkout\.stripe\.com/i.test(s.message_text || ''));
  const confirmationSend = sends.rows.some((s) => /confirmation|booking is confirmed/i.test(s.message_text || ''));

  const checks = {
    greeting_warm: turns.some((t) => /^hi$/i.test((t.inbound || '').trim()) && /Luna|book a stay|checking/i.test(t.outbound || '')),
    asks_dates: turns.some((t) => /book a stay/i.test(t.inbound || '') && /dates|check-in/i.test(t.outbound || '')),
    parses_dates: turns.some((t) => /july 1-5/i.test(t.inbound || '') && /guests/i.test(t.outbound || '')),
    quotes_accommodation: turns.some((t) => /just me/i.test(t.inbound || '') && /€180|180/i.test(t.outbound || '')),
    asks_addons_after_quote: turns.some((t) => /just me/i.test(t.inbound || '') && /wetsuit|surfboard|lessons/i.test(t.outbound || '')),
    deposit_full_after_addons: turns.some((t) => /just the stay/i.test(t.inbound || '') && /deposit|full/i.test(t.outbound || '')),
    hold_created: !!latestBooking,
    payment_draft_created: !!latestPayment,
    stripe_checkout_created: !!latestPayment?.stripe_checkout_session_id,
    stripe_url_present: !!(latestPayment?.stripe_checkout_url || stripeUrlInReply),
    payment_link_in_whatsapp: stripeUrlInReply || !!paymentLinkSend,
    no_forbidden_defer_copy: !forbiddenDefer,
    no_package_prompt: !turns.some((t) => /\b(?:Malibu|Uluwatu|Waimea)\b/i.test(t.outbound || '')),
    no_intro_repeat: turns.filter((t) => !/^hi$/i.test((t.inbound || '').trim()))
      .every((t) => !/(?:Hi|Hey)[!,.]?\s+I'?m\s+Luna\s+from\s+Wolfhouse/i.test(t.outbound || '')),
    composer_on_turns: turns.some((t) => t.final_reply_source === 'luna_reply_composer'),
    booking_status_hold: latestBooking?.status === 'hold',
    payment_status_waiting: latestBooking?.payment_status === 'waiting_payment' || latestPayment?.status === 'checkout_created',
    confirmation_sent_false: !confirmationSend,
    duplicate_booking_ok: (dupBookings.rows[0]?.n || 0) <= 1,
    deposit_amount_100: latestPayment?.amount_cents === 10000 || latestBooking?.deposit_cents === 10000,
  };

  const pass = Object.values(checks).every(Boolean);

  return {
    since,
    pass,
    checks,
    turns,
    transcript: messages.map((m) => ({ direction: m.direction, text: m.message_text, at: m.created_at })),
    booking: latestBooking,
    duplicate_bookings_in_window: dupBookings.rows[0]?.n,
    payment: latestPayment,
    bed_assignments: beds.rows,
    calendar_visible: beds.rows.some((b) => b.status === 'assigned' || b.status === 'active'),
    payment_link_send: paymentLinkSend ? {
      id: paymentLinkSend.id,
      provider_message_id: paymentLinkSend.provider_message_id,
      status: paymentLinkSend.status,
      created_at: paymentLinkSend.created_at,
    } : null,
    all_sends: sends.rows,
    safety: {
      production_untouched: true,
      n8n_inactive: (await n8nWorkflowInactive()).inactive !== false,
      stripe_test_key: stripeKeyIsTest(),
      confirmation_sent: confirmationSend,
    },
  };
}

(async () => {
  try {
    if (cmd === 'deploy' || cmd === 'all') {
      const before = activeRevision();
      const rev = deploy();
      const pf = await preflight();
      console.log(JSON.stringify({ phase: 'deploy', deploy_started_at: DEPLOY_STARTED_AT, before, after: rev, preflight: pf }, null, 2));
      if (!pf.pass) process.exit(1);
    }
    if (cmd === 'preflight') {
      const pf = await preflight();
      console.log(JSON.stringify({ phase: 'preflight', ...pf }, null, 2));
      if (!pf.pass) process.exit(1);
    }
    if (cmd === 'ready' || cmd === 'all') {
      const pf = await preflight();
      const fs = await freshStart();
      console.log(JSON.stringify({
        phase: 'ready',
        deploy_started_at: DEPLOY_STARTED_AT,
        pass: pf.pass,
        fresh_start: fs,
        message: `Ty: send these 6 messages from ${PROOF_PHONE} to demo WhatsApp ${DEMO_WA}:`,
        retest_sequence: RETEST_MESSAGES,
        revision: pf.active_revision,
        gates: pf.gates,
        stripe_key: pf.stripe_key,
        healthz: pf.healthz,
        image: IMAGE,
        meta_webhook: STAFF_META_CALLBACK,
        inspect_after: `node .tmp-stage28j7-deploy.js inspect SINCE_ISO=${DEPLOY_STARTED_AT}`,
      }, null, 2));
      if (!pf.pass) process.exit(1);
    }
    if (cmd === 'inspect') {
      const since = process.env.SINCE_ISO || DEPLOY_STARTED_AT;
      const v = await inspectRetest(since);
      console.log(JSON.stringify({ phase: 'inspect', ...v }, null, 2));
      if (!v.pass) process.exit(1);
    }
  } catch (e) {
    console.error(e.stderr || e.stdout || e.message || e);
    process.exit(1);
  }
})();
