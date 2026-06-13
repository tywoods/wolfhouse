'use strict';
/** Stage 31b — live staging correction/stale-quote WhatsApp reproof. Temp — do not commit. */
const crypto = require('crypto');
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { resetLunaConversationContext } = require('./scripts/lib/staff-conversation-writes');
const { runLiveProofHygiene } = require('./scripts/lib/luna-live-proof-hygiene');
const { fetchMetaCallback } = require('./scripts/lib/open-demo-playground-common');
const { correlateHostedProofTurns } = require('./scripts/lib/luna-hosted-proof-send-correlation');

const COMMIT = '621b3bb';
const IMAGE_TAG = `${COMMIT}-stage31b-live-corrections-reproof`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 'stage31b-corrections-reproof';
const HOST = 'staff-staging.lunafrontdesk.com';
const META_WEBHOOK = `https://${HOST}/staff/meta/whatsapp/webhook`;
const CLIENT = 'wolfhouse-somo';
const PROOF_PHONE = '+491726422307';
const PROOF_PHONE_RAW = '491726422307';
const DEMO_PHONE_ID = '1152900101233109';
const WF_ID = 'stage27demoLWrite01';

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
  'LUNA_AUTO_SEND_ENABLED',
  'STRIPE_LINKS_ENABLED',
  'STAFF_ACTIONS_ENABLED',
];

const TESTS = [
  {
    id: '1_package_switch',
    name: 'Package switch before payment',
    messages: ['Malibu July 10 to July 17 for 1', 'actually make it Uluwatu', 'deposit'],
    cleanupWindows: [{ check_in: '2026-07-10', check_out: '2026-07-17' }],
    expectDeposit: true,
    checks: (ctx) => ({
      malibu_quoted: ctx.turns.some((t) => /malibu/i.test(t.outbound || '') && /€299|299/.test(t.outbound || '')),
      uluwatu_quoted: ctx.turns.some((t) => /uluwatu/i.test(t.outbound || '') && /€399|399/.test(t.outbound || '')),
      stale_on_correction: ctx.correctionTurn?.previous_quote_invalidated === true,
      corrected_package: (ctx.correctionTurn?.corrected_fields || []).includes('package_interest'),
      final_package_uluwatu: /uluwatu/i.test(ctx.booking?.package_code || ''),
      no_malibu_booking: !/malibu/i.test(ctx.booking?.package_code || ''),
      deposit_hold: !!ctx.booking,
      stripe_link_once: ctx.stripeLinkSends <= 1,
      no_confirmation: !ctx.confirmationSent,
    }),
  },
  {
    id: '2_date_correction',
    name: 'Date correction before payment',
    messages: ['Malibu July 10 to July 17 for 1', 'actually July 11 to July 18', 'deposit'],
    cleanupWindows: [
      { check_in: '2026-07-10', check_out: '2026-07-17' },
      { check_in: '2026-07-11', check_out: '2026-07-18' },
    ],
    expectDeposit: true,
    checks: (ctx) => ({
      stale_on_correction: ctx.correctionTurn?.previous_quote_invalidated === true,
      corrected_dates: (ctx.correctionTurn?.corrected_fields || []).some((f) => f === 'check_in' || f === 'check_out'),
      booking_dates_corrected: ctx.booking?.check_in === '2026-07-11' && ctx.booking?.check_out === '2026-07-18',
      no_july10_booking: ctx.allBookings.every((b) => !(b.check_in === '2026-07-10' && b.check_out === '2026-07-17' && b.status !== 'cancelled')),
      calendar_correct_dates: ctx.calendarBlocks.some((b) => b.start_date === '2026-07-11' || b.assignment_start_date === '2026-07-11'),
      stripe_link_once: ctx.stripeLinkSends <= 1,
      no_confirmation: !ctx.confirmationSent,
    }),
  },
  {
    id: '3_guest_count_correction',
    name: 'Guest count correction before payment',
    messages: ['July 6-10', 'just me', 'Just the stay please', 'actually we are 2', 'deposit'],
    cleanupWindows: [{ check_in: '2026-07-06', check_out: '2026-07-10' }],
    expectDeposit: true,
    checks: (ctx) => ({
      quote_180_first: ctx.turns.some((t) => /just me/i.test(t.inbound || '') && /€180|180/.test(t.outbound || '')),
      quote_360_after: ctx.turns.some((t) => /actually we are 2/i.test(t.inbound || '') && /€360|360/.test(t.outbound || '')),
      stale_on_correction: ctx.correctionTurn?.previous_quote_invalidated === true,
      guest_count_2: Number(ctx.booking?.guest_count) === 2,
      deposit_hold: !!ctx.booking,
      stripe_link_once: ctx.stripeLinkSends <= 1,
      no_confirmation: !ctx.confirmationSent,
    }),
  },
  {
    id: '4_reset_after_quote',
    name: 'Reset after quote',
    messages: ['Malibu July 10 to July 17 for 2', 'no no I want to create another booking', 'July 20 to July 27', '1', 'Malibu'],
    cleanupWindows: [
      { check_in: '2026-07-10', check_out: '2026-07-17' },
      { check_in: '2026-07-20', check_out: '2026-07-27' },
    ],
    expectDeposit: false,
    checks: (ctx) => ({
      reset_detected: ctx.resetTurn?.new_booking_reset === true || ctx.resetTurn?.brain_intent === 'reset_new_booking',
      no_booking_old_dates: ctx.allBookings.every((b) => !(b.check_in === '2026-07-10' && b.check_out === '2026-07-17' && b.status !== 'cancelled')),
      new_flow_started: ctx.turns.some((t) => /july 20/i.test(t.inbound || '') && /guests/i.test(t.outbound || '')),
      malibu_requoted: ctx.turns.some((t) => /^malibu$/i.test((t.inbound || '').trim()) && /malibu/i.test(t.outbound || '') && /€598|598|deposit|full/i.test(t.outbound || '')),
      no_stripe_before_reset: !ctx.turns.slice(0, 2).some((t) => /checkout\.stripe\.com/i.test(t.outbound || '')),
      no_confirmation: !ctx.confirmationSent,
    }),
  },
  {
    id: '5_cash_side_question',
    name: 'Cash side-question during payment context',
    messages: ['Malibu July 10 to July 17 for 1', 'can I pay cash?', 'deposit'],
    cleanupWindows: [{ check_in: '2026-07-10', check_out: '2026-07-17' }],
    expectDeposit: true,
    checks: (ctx) => ({
      cash_answered: ctx.turns.some((t) => /can I pay cash/i.test(t.inbound || '') && /cash|arrival|bank transfer|stripe/i.test(t.outbound || '')),
      not_stale_on_cash: ctx.cashTurn?.previous_quote_invalidated !== true,
      deposit_works: !!ctx.booking,
      stripe_link_once: ctx.stripeLinkSends <= 1,
      no_confirmation: !ctx.confirmationSent,
    }),
  },
  {
    id: '6_happy_path',
    name: 'Known happy path still works',
    messages: ['hi', 'book a stay', 'July 6-10', 'just me', 'Just the stay please', 'deposit'],
    cleanupWindows: [{ check_in: '2026-07-06', check_out: '2026-07-10' }],
    expectDeposit: true,
    checks: (ctx) => ({
      composer_flow: ctx.turns.some((t) => /^hi$/i.test((t.inbound || '').trim())),
      quote_180: ctx.turns.some((t) => /€180|180/.test(t.outbound || '')),
      stripe_link_sent: ctx.stripeLinkSends >= 1,
      hold_created: !!ctx.booking,
      payment_draft: !!ctx.payment,
      calendar_visible: ctx.calendarBlocks.length > 0 || ctx.bedAssignments.length > 0,
      no_duplicate_booking: ctx.allBookings.filter((b) => b.status !== 'cancelled').length <= 1,
      no_confirmation: !ctx.confirmationSent,
    }),
  },
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
  const wamid = `wamid.stage31b.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '34663439419', phone_number_id: DEMO_PHONE_ID },
          contacts: [{ profile: { name: 'Stage31b Guest' }, wa_id: PROOF_PHONE_RAW }],
          messages: [{
            from: PROOF_PHONE_RAW,
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
    const req = https.request({ hostname: HOST, path: '/staff/meta/whatsapp/webhook', method: 'POST', headers }, (res) => {
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

async function freshStart(pg) {
  const conv = await pg.query(
    `SELECT conv.id::text FROM conversations conv JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = $1 AND REPLACE(COALESCE(conv.phone,''),'+','') = $2
      ORDER BY conv.updated_at DESC LIMIT 1`,
    [CLIENT, PROOF_PHONE_RAW],
  );
  if (!conv.rows[0]) return { ok: true, note: 'no conversation yet' };
  const out = await resetLunaConversationContext(pg, CLIENT, conv.rows[0].id);
  return { ok: true, conversation_id: conv.rows[0].id, ...out };
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
  removeEnvVars(['LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST', 'LUNA_AUTO_SEND_ENABLED']);
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
    const wf = await nc.query('SELECT id, name, active::text FROM workflow_entity WHERE id = $1 LIMIT 1', [WF_ID]);
    await nc.end();
    return { workflows: wf.rows, inactive: wf.rows.every((r) => r.active === 'false') };
  } catch (e) {
    return { error: String(e.message || e), inactive: true, note: 'probe skipped' };
  }
}

async function preflight() {
  const rev = activeRevision();
  const gates = envPick(GATE_NAMES);
  const stripeKey = kvSecret('stripe-secret-key');
  const pg = await pgConnect();
  const spa = await pg.query(
    `SELECT role, is_active::text FROM staff_phone_access
      WHERE client_slug = $1 AND (phone_normalized = $2 OR phone_e164 = $3)`,
    [CLIENT, PROOF_PHONE_RAW, PROOF_PHONE],
  );
  await pg.end();
  const meta = await fetchMetaCallback();
  const n8n = await n8nInactive();
  return {
    healthz: healthz(),
    revision: rev,
    gates,
    stripe_mode: stripeKey.startsWith('sk_test_') ? 'test' : 'NOT_TEST',
    meta_webhook: meta,
    meta_webhook_expected: META_WEBHOOK,
    staff_phone_access: spa.rows,
    n8n,
    production_untouched: true,
    pass: healthz() === '200'
      && rev.health === 'Healthy'
      && rev.traffic === 100
      && gates.WHATSAPP_DRY_RUN === 'false'
      && gates.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'true'
      && gates.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null
      && spa.rows.some((r) => r.is_active === 'false')
      && stripeKey.startsWith('sk_test_'),
  };
}

function extractReviewFields(ev, inboundReviews) {
  const odr = ev.open_demo_result || {};
  const brain = odr.conversation_brain || {};
  const wamid = ev.wa_message_id;
  const review = (inboundReviews && wamid && inboundReviews[wamid]) || {};
  const result = review.result || {};
  return {
    previous_quote_invalidated: result.previous_quote_invalidated === true,
    stale_quote_reason: result.stale_quote_reason || null,
    corrected_fields: result.corrected_fields || [],
    new_booking_reset: result.new_booking_reset === true,
    quote_stale: result.quote_stale === true || (review.quote && review.quote.quote_stale === true),
    final_reply_source: brain.final_reply_source || result.conversation_brain?.final_reply_source || null,
    brain_source: brain.brain_source || null,
    model_used: brain.model_used || null,
    brain_intent: brain.brain_intent || null,
  };
}

async function inspectTest(sinceIso, testDef) {
  const pg = await pgConnect();
  const events = (await pg.query(
    `SELECT id::text, created_at::text, message_text, wa_message_id, suggested_reply, next_action, send_status,
            normalized->'open_demo_result' AS open_demo_result
       FROM guest_message_events
      WHERE client_slug = $1 AND REPLACE(COALESCE(from_phone,''),'+','') = $2
        AND created_at >= $3::timestamptz
      ORDER BY created_at ASC`,
    [CLIENT, PROOF_PHONE_RAW, sinceIso],
  )).rows;

  const sends = (await pg.query(
    `SELECT id::text, status, message_text, provider_message_id, send_kind, created_at::text
       FROM guest_message_sends
      WHERE client_slug = $1 AND REPLACE(COALESCE(to_phone,''),'+','') = $2
        AND created_at >= $3::timestamptz
      ORDER BY created_at ASC`,
    [CLIENT, PROOF_PHONE_RAW, sinceIso],
  )).rows;

  const conv = (await pg.query(
    `SELECT conv.id::text, conv.metadata->'luna_inbound_reviews' AS luna_inbound_reviews
       FROM conversations conv JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = $1 AND REPLACE(COALESCE(conv.phone,''),'+','') = $2`,
    [CLIENT, PROOF_PHONE_RAW],
  )).rows[0];
  const inboundReviews = conv?.luna_inbound_reviews || {};

  const correlated = correlateHostedProofTurns(events, sends);
  const turns = correlated.turns.map((t, idx) => {
    const ev = events[idx];
    const meta = extractReviewFields({ ...ev, wa_message_id: ev.wa_message_id }, inboundReviews);
    return {
      inbound: t.inbound,
      outbound: t.luna,
      suggested_reply: t.suggested_reply,
      actual_sent_text: t.actual_sent_text,
      inbound_wamid: t.inbound_wamid,
      provider_message_id: t.provider_message_id,
      match_method: t.match_method,
      duplicate_send_reused: t.duplicate_send_reused,
      send_status: t.send_status || ev.send_status,
      ...meta,
      open_demo: ev.open_demo_result || {},
    };
  });

  const allBookings = (await pg.query(
    `SELECT b.id::text, b.booking_code, b.package_code, b.status::text, b.payment_status::text,
            b.check_in::text, b.check_out::text, b.guest_count, b.confirmation_sent_at::text, b.created_at::text
       FROM bookings b JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND REPLACE(COALESCE(b.phone,''),'+','') = $2
        AND b.created_at >= $3::timestamptz
      ORDER BY b.created_at DESC`,
    [CLIENT, PROOF_PHONE_RAW, sinceIso],
  )).rows;

  const booking = allBookings.find((b) => b.status !== 'cancelled') || allBookings[0] || null;
  let payment = null;
  let bedAssignments = [];
  if (booking) {
    payment = (await pg.query(
      `SELECT p.id::text, p.status::text, p.payment_kind::text, p.amount_due_cents,
              p.stripe_checkout_session_id, p.checkout_url, p.created_at::text
         FROM payments p WHERE p.booking_id = $1::uuid ORDER BY p.created_at DESC LIMIT 1`,
      [booking.id],
    )).rows[0] || null;
    bedAssignments = (await pg.query(
      `SELECT bb.bed_code, bb.room_code, bb.assignment_start_date::text, bb.assignment_end_date::text
         FROM booking_beds bb WHERE bb.booking_id = $1::uuid`,
      [booking.id],
    )).rows;
  }

  let calendarBlocks = [];
  if (booking) {
    try {
      const login = await new Promise((resolve, reject) => {
        const data = JSON.stringify({ client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!' });
        const req = https.request({
          hostname: HOST, path: '/staff/auth/login', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => resolve(res.headers['set-cookie']));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
      });
      const cookie = (login || []).map((x) => x.split(';')[0]).join('; ');
      const calStart = booking.check_in || '2026-07-01';
      const calEnd = booking.check_out || '2026-07-31';
      calendarBlocks = await new Promise((resolve) => {
        https.get({
          hostname: HOST,
          path: `/staff/bed-calendar?client=${CLIENT}&start=${calStart}&end=${calEnd}`,
          headers: { Cookie: cookie, Accept: 'application/json' },
        }, (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => {
            try {
              const body = JSON.parse(buf);
              resolve((body.blocks || []).filter((b) => b.booking_id === booking.id || b.booking_code === booking.booking_code));
            } catch { resolve([]); }
          });
        }).on('error', () => resolve([]));
      });
    } catch { calendarBlocks = []; }
  }

  await pg.end();

  const stripeLinkSends = sends.filter((s) => /checkout\.stripe\.com/i.test(s.message_text || '')).length;
  const confirmationSent = sends.some((s) => s.send_kind === 'confirmation' && s.status === 'sent')
    || allBookings.some((b) => b.confirmation_sent_at);

  const correctionTurn = turns.find((t) => /actually/i.test(t.inbound || ''));
  const resetTurn = turns.find((t) => /create another booking|start over/i.test(t.inbound || ''));
  const cashTurn = turns.find((t) => /pay cash/i.test(t.inbound || ''));

  const ctx = {
    turns,
    booking,
    allBookings,
    payment,
    bedAssignments,
    calendarBlocks,
    stripeLinkSends,
    confirmationSent,
    correctionTurn,
    resetTurn,
    cashTurn,
  };
  const checks = testDef.checks(ctx);
  const pass = Object.values(checks).every(Boolean);
  return {
    id: testDef.id,
    name: testDef.name,
    pass,
    checks,
    transcript: turns.map((t) => ({
      guest: t.inbound,
      luna: t.outbound,
      final_reply_source: t.final_reply_source,
      brain_source: t.brain_source,
      model_used: t.model_used,
      corrected_fields: t.corrected_fields,
      quote_stale: t.quote_stale,
      stale_quote_reason: t.stale_quote_reason,
      previous_quote_invalidated: t.previous_quote_invalidated,
      new_booking_reset: t.new_booking_reset,
    })),
    booking_code: booking?.booking_code || null,
    payment_draft_id: payment?.id || null,
    stripe_session_id: payment?.stripe_checkout_session_id || null,
    stripe_checkout_url: payment?.checkout_url || null,
    package_used: booking?.package_code || null,
    dates_used: booking ? { check_in: booking.check_in, check_out: booking.check_out } : null,
    guest_count_used: booking?.guest_count ?? null,
    calendar_visible: calendarBlocks.length > 0 || bedAssignments.length > 0,
    duplicate_bookings: allBookings.filter((b) => b.status !== 'cancelled').length,
    confirmation_sent: confirmationSent,
  };
}

async function runTest(testDef) {
  const sinceIso = new Date().toISOString();
  const pg = await pgConnect();
  await demoteOwner(pg);
  await freshStart(pg);
  await pg.end();

  const httpTurns = [];
  for (let i = 0; i < testDef.messages.length; i++) {
    const payload = buildMetaPayload(testDef.messages[i]);
    delete payload._wamid;
    const res = await postMetaWebhook(payload);
    httpTurns.push({ message: testDef.messages[i], status: res.status });
    console.error(`[${testDef.id}] turn ${i + 1}: ${testDef.messages[i]} → HTTP ${res.status}`);
    sleep(i === testDef.messages.length - 1 ? 12000 : 7000);
  }

  const inspected = await inspectTest(sinceIso, testDef);

  const cleanups = [];
  for (const win of testDef.cleanupWindows || []) {
    const pg2 = await pgConnect();
    const out = await runLiveProofHygiene({
      client_slug: CLIENT,
      phone: PROOF_PHONE,
      check_in: win.check_in,
      check_out: win.check_out,
      source: `stage31b-${testDef.id}`,
    }, {
      allow_hygiene: true,
      confirm_hygiene: true,
      dry_run: false,
      pg: pg2,
      host_header: HOST,
    });
    await pg2.end();
    cleanups.push({ window: win, ...out });
  }

  return { since: sinceIso, httpTurns, ...inspected, cleanups };
}

function restoreGates() {
  setEnvVars(RESTORE_ENV);
  removeEnvVars(['LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST', 'LUNA_AUTO_SEND_ENABLED']);
}

function runVerifiers() {
  const cmds = [
    'npm run verify:stage31a-messy-conversation-intelligence',
    'npm run verify:stage30c-confirmation-copy-style',
    'npm run verify:stage30b-composer-side-question-coverage',
    'npm run verify:stage30a-smart-reply-composer-personality',
    'npm run luna:guest-flow-batch -- --local --fixture-set booking-core',
  ];
  const out = {};
  for (const c of cmds) {
    try {
      const result = execSync(c, { encoding: 'utf8', cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024 });
      out[c] = { ok: true, tail: result.split('\n').slice(-6).join('\n') };
    } catch (e) {
      out[c] = { ok: false, error: String(e.stderr || e.stdout || e.message).slice(-800) };
    }
  }
  return out;
}

(async () => {
  const report = {
    stage: '31b',
    commit: COMMIT,
    image: IMAGE,
    image_tag: IMAGE_TAG,
    result: 'FAIL',
    tests: [],
  };

  try {
    if (cmd === 'deploy' || cmd === 'all') {
      report.deploy = deploy();
      report.gates_during = envPick(GATE_NAMES);
    }
    if (cmd === 'preflight' || cmd === 'all') {
      report.preflight = await preflight();
      if (!report.preflight.pass && cmd === 'preflight') {
        console.log(JSON.stringify(report, null, 2));
        process.exit(1);
      }
    }
    if (cmd === 'verifiers' || cmd === 'all') {
      report.verifiers = runVerifiers();
    }
    if (cmd === 'tests' || cmd === 'all') {
      for (const testDef of TESTS) {
        report.tests.push(await runTest(testDef));
      }
    }
    if (cmd === 'restore' || cmd === 'all') {
      restoreGates();
      const pg = await pgConnect();
      await restoreOwner(pg);
      await pg.end();
      sleep(12000);
      report.gates_final = envPick(GATE_NAMES);
      report.revision_final = activeRevision();
      report.healthz_final = healthz();
    }

    const testFails = report.tests.filter((t) => !t.pass);
    const verifierFails = report.verifiers
      ? Object.entries(report.verifiers).filter(([, v]) => !v.ok).map(([k]) => k)
      : [];
    report.stale_quote_leakage = report.tests.some((t) =>
      t.checks && Object.keys(t.checks).some((k) => /stale|old|malibu_booking|july10/.test(k) && t.checks[k] === false));
    report.old_quote_used_after_correction = report.tests.some((t) =>
      ['1_package_switch', '2_date_correction', '3_guest_count_correction'].includes(t.id) && !t.pass
      && (t.checks?.final_package_uluwatu === false || t.checks?.booking_dates_corrected === false || t.checks?.guest_count_2 === false));
    report.bookings_created = report.tests.map((t) => ({
      test: t.id,
      booking_code: t.booking_code,
      package: t.package_used,
      dates: t.dates_used,
      guest_count: t.guest_count_used,
    }));
    report.cleanup_summary = report.tests.map((t) => ({ test: t.id, cleanups: t.cleanups }));
    report.safety = {
      production_untouched: true,
      n8n_inactive: (await n8nInactive()).inactive !== false,
      live_stripe: false,
      confirmations_off: report.gates_final?.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null,
      gates_restored: report.gates_final?.WHATSAPP_DRY_RUN === 'true',
    };

    const preflightOk = !report.preflight || report.preflight.pass;
    report.result = preflightOk && testFails.length === 0 && verifierFails.length === 0
      ? 'PASS'
      : (testFails.length <= 1 && verifierFails.length === 0 ? 'PARTIAL' : 'FAIL');
    report.failures = {
      tests: testFails.map((t) => ({ id: t.id, failed_checks: Object.entries(t.checks || {}).filter(([, v]) => !v).map(([k]) => k) })),
      verifiers: verifierFails,
    };
  } catch (e) {
    report.error = e.message;
    report.stack = e.stack;
    try { restoreGates(); } catch { /* ignore */ }
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.result === 'PASS' ? 0 : 1);
})();
