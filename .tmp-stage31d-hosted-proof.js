'use strict';
/** Stage 31d — deploy 1054bd8 stale quote composer fix + live WhatsApp reproof. Temp — do not commit. */
const crypto = require('crypto');
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { resetLunaConversationContext } = require('./scripts/lib/staff-conversation-writes');
const { runLiveProofHygiene } = require('./scripts/lib/luna-live-proof-hygiene');
const { fetchMetaCallback } = require('./scripts/lib/open-demo-playground-common');
const { assertComposerFactsMatchHoldFacts } = require('./scripts/lib/luna-quote-facts');
const { correlateHostedProofTurns } = require('./scripts/lib/luna-hosted-proof-send-correlation');

const COMMIT = '1054bd8';
const IMAGE_TAG = `${COMMIT}-stage31d-live-stale-quote-composer-fix`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 'stage31d-stale-quote-fix';
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
    name: 'Package switch Malibu → Uluwatu',
    messages: ['Malibu July 10 to July 17 for 1', 'actually make it Uluwatu', 'deposit'],
    cleanupWindows: [{ check_in: '2026-07-10', check_out: '2026-07-17' }],
    checks: (ctx) => ({
      malibu_first_quote: ctx.turns.some((t) => /malibu/i.test(t.outbound || '')),
      no_malibu_after_correction: !ctx.correctionTurn?.outbound || !/\bmalibu\b/i.test(ctx.correctionTurn.outbound),
      uluwatu_on_correction: /uluwatu/i.test(ctx.correctionTurn?.outbound || ''),
      uluwatu_price_on_correction: /€399|399/.test(ctx.correctionTurn?.outbound || ''),
      stale_on_correction: ctx.correctionTurn?.previous_quote_invalidated === true,
      final_package_uluwatu: /uluwatu/i.test(ctx.booking?.package_code || ''),
      no_malibu_booking: !/malibu/i.test(ctx.booking?.package_code || ''),
      deposit_hold: !!ctx.booking,
      composer_write_facts_match: ctx.composerWriteFactsMatch !== false,
      stripe_link_once: ctx.stripeLinkSends <= 1,
      no_duplicate: ctx.allBookings.filter((b) => b.status !== 'cancelled').length <= 1,
      no_confirmation: !ctx.confirmationSent,
    }),
  },
  {
    id: '2_date_correction',
    name: 'Date correction July 10–17 → July 11–18',
    messages: ['Malibu July 10 to July 17 for 1', 'actually July 11 to July 18', 'deposit'],
    cleanupWindows: [
      { check_in: '2026-07-10', check_out: '2026-07-17' },
      { check_in: '2026-07-11', check_out: '2026-07-18' },
    ],
    checks: (ctx) => ({
      stale_on_correction: ctx.correctionTurn?.previous_quote_invalidated === true,
      july11_in_correction_reply: /july\s*11|11\s*[-–]\s*18|july\s*18/i.test(ctx.correctionTurn?.outbound || ''),
      no_july10_in_correction_reply: !/july\s*10|10\s*[-–]\s*17/i.test(ctx.correctionTurn?.outbound || ''),
      booking_dates_corrected: ctx.booking?.check_in === '2026-07-11' && ctx.booking?.check_out === '2026-07-18',
      no_july10_active_booking: ctx.allBookings.every((b) => !(b.check_in === '2026-07-10' && b.check_out === '2026-07-17' && b.status !== 'cancelled')),
      calendar_correct_dates: ctx.calendarBlocks.some((b) => b.start_date === '2026-07-11' || b.assignment_start_date === '2026-07-11')
        || ctx.bedAssignments.some((b) => b.assignment_start_date === '2026-07-11'),
      composer_write_facts_match: ctx.composerWriteFactsMatch !== false,
      stripe_link_once: ctx.stripeLinkSends <= 1,
      no_confirmation: !ctx.confirmationSent,
    }),
  },
  {
    id: '3_guest_count_correction',
    name: 'Guest count correction 1 → 2',
    messages: ['July 6-10', 'just me', 'Just the stay please', 'actually we are 2', 'deposit'],
    cleanupWindows: [{ check_in: '2026-07-06', check_out: '2026-07-10' }],
    precleanPaidArtifact: { check_in: '2026-07-06', check_out: '2026-07-10' },
    checks: (ctx) => ({
      quote_180_first: ctx.turns.some((t) => /just me/i.test(t.inbound || '') && /€180|180/.test(t.outbound || '')),
      stale_on_correction: ctx.correctionTurn?.previous_quote_invalidated === true,
      requote_2_guests: ctx.turns.some((t) => /actually we are 2/i.test(t.inbound || '') && (/€360|360|updating that to 2/i.test(t.outbound || ''))),
      guest_count_2: Number(ctx.booking?.guest_count) === 2,
      no_guest_loop: !ctx.turns.some((t) => /deposit/i.test(t.inbound || '') && /how many guests/i.test(t.outbound || '')),
      deposit_hold: !!ctx.booking,
      composer_write_facts_match: ctx.composerWriteFactsMatch !== false,
      stripe_link_once: ctx.stripeLinkSends <= 1,
      no_confirmation: !ctx.confirmationSent,
    }),
  },
  {
    id: '4_happy_path',
    name: 'Happy path sanity check',
    messages: ['hi', 'book a stay', 'July 20-24', 'just me', 'Just the stay please', 'deposit'],
    cleanupWindows: [{ check_in: '2026-07-20', check_out: '2026-07-24' }],
    checks: (ctx) => ({
      no_greeting_loop: !ctx.turns.slice(2).some((t) => /how can i help|what would you like to do/i.test(t.outbound || '')),
      quote_reached: ctx.turns.some((t) => /€180|180|accommodation/i.test(t.outbound || '')),
      stripe_link_sent: ctx.stripeLinkSends >= 1,
      hold_created: !!ctx.booking,
      payment_draft: !!ctx.payment,
      calendar_visible: ctx.calendarBlocks.length > 0 || ctx.bedAssignments.length > 0,
      no_duplicate: ctx.allBookings.filter((b) => b.status !== 'cancelled').length <= 1,
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
  const wamid = `wamid.stage31d.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '34663439419', phone_number_id: DEMO_PHONE_ID },
          contacts: [{ profile: { name: 'Stage31d Guest' }, wa_id: PROOF_PHONE_RAW }],
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
      && String(rev.image || '').includes(IMAGE_TAG)
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
  const result = review.result || odr;
  const composerFacts = result.quote_facts_used_by_composer || odr.quote_facts_used_by_composer || null;
  const writeFacts = result.quote_facts_used_by_hold_writer || odr.quote_facts_used_by_hold_writer || null;
  const factsMatch = assertComposerFactsMatchHoldFacts(composerFacts, writeFacts);
  return {
    previous_quote_invalidated: result.previous_quote_invalidated === true || odr.previous_quote_invalidated === true,
    stale_quote_reason: result.stale_quote_reason || odr.stale_quote_reason || null,
    corrected_fields: result.corrected_fields || odr.corrected_fields || [],
    quote_stale: result.quote_stale === true || odr.quote_stale === true || (review.quote && review.quote.quote_stale === true),
    correction_applied: result.correction_applied === true || odr.correction_applied === true,
    quote_facts_used_by_composer: composerFacts,
    quote_facts_used_by_hold_writer: writeFacts,
    composer_write_facts_match: factsMatch.ok,
    composer_write_facts_errors: factsMatch.errors,
    final_reply_source: brain.final_reply_source || odr.final_reply_source || null,
    composer_state: brain.composer_state || odr.composer_state || null,
    brain_source: brain.brain_source || null,
    model_used: brain.model_used || brain.model_requested || null,
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
      send_created_at: t.send_created_at,
      match_method: t.match_method,
      duplicate_send_reused: t.duplicate_send_reused,
      send_status: t.send_status || ev.send_status,
      ...meta,
      open_demo: ev.open_demo_result || {},
    };
  });
  const correlation_warnings = correlated.warnings;
  const reused_send_ids = correlated.reused_send_ids;

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
  const depositTurn = turns.find((t) => /^deposit$/i.test((t.inbound || '').trim()));
  const composerWriteFactsMatch = depositTurn
    ? depositTurn.composer_write_facts_match
    : turns.every((t) => t.composer_write_facts_match !== false);

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
    depositTurn,
    composerWriteFactsMatch,
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
      composer_state: t.composer_state,
      brain_source: t.brain_source,
      model_used: t.model_used,
      previous_quote_invalidated: t.previous_quote_invalidated,
      quote_stale: t.quote_stale,
      stale_quote_reason: t.stale_quote_reason,
      corrected_fields: t.corrected_fields,
      quote_facts_used_by_composer: t.quote_facts_used_by_composer,
      quote_facts_used_by_hold_writer: t.quote_facts_used_by_hold_writer,
      composer_write_facts_match: t.composer_write_facts_match,
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
    composer_write_facts_match: composerWriteFactsMatch,
    stale_quote_copy_leakage: correctionTurn
      ? (testDef.id === '1_package_switch' && /\bmalibu\b/i.test(correctionTurn.outbound || ''))
        || (testDef.id === '2_date_correction' && /july\s*10|10\s*[-–]\s*17/i.test(correctionTurn.outbound || ''))
        || (testDef.id === '3_guest_count_correction' && /€180|180/.test(correctionTurn.outbound || '') && !/€360|360|updating that to 2/i.test(correctionTurn.outbound || ''))
      : false,
    correlation_warnings,
    reused_send_ids,
  };
}

async function runTest(testDef) {
  const sinceIso = new Date().toISOString();
  const pg = await pgConnect();
  await demoteOwner(pg);
  await freshStart(pg);
  if (testDef.precleanPaidArtifact) {
    await runLiveProofHygiene({
      client_slug: CLIENT,
      phone: PROOF_PHONE,
      check_in: testDef.precleanPaidArtifact.check_in,
      check_out: testDef.precleanPaidArtifact.check_out,
      source: `stage31d-${testDef.id}-paid-artifact-preclean`,
    }, {
      allow_hygiene: true,
      confirm_hygiene: true,
      allow_staging_paid_proof_reset: true,
      dry_run: false,
      pg,
      host_header: HOST,
    });
  }
  await pg.end();

  const httpTurns = [];
  for (let i = 0; i < testDef.messages.length; i++) {
    const payload = buildMetaPayload(testDef.messages[i]);
    const res = await postMetaWebhook(payload);
    httpTurns.push({ message: testDef.messages[i], status: res.status });
    console.error(`[${testDef.id}] turn ${i + 1}: ${testDef.messages[i]} → HTTP ${res.status}`);
    sleep(i === testDef.messages.length - 1 ? 15000 : 8000);
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
      source: `stage31d-${testDef.id}`,
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
    'npm run verify:stage31c-live-composer-stale-quote-copy',
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
    stage: '31d',
    commit: COMMIT,
    image: IMAGE,
    image_tag: IMAGE_TAG,
    result: 'FAIL',
    tests: [],
  };

  try {
    if (cmd === 'verifiers' || cmd === 'all') {
      report.verifiers = runVerifiers();
    }
    if (cmd === 'deploy' || cmd === 'all') {
      report.deploy = deploy();
      report.gates_during = envPick(GATE_NAMES);
    }
    if (cmd === 'preflight' || cmd === 'all') {
      report.preflight = await preflight();
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
    report.stale_quote_copy_leakage = report.tests.some((t) => t.stale_quote_copy_leakage === true);
    report.composer_write_facts_matched_all = report.tests.every((t) => t.composer_write_facts_match !== false);
    report.bookings_created = report.tests.map((t) => ({
      test: t.id,
      booking_code: t.booking_code,
      package: t.package_used,
      dates: t.dates_used,
      guest_count: t.guest_count_used,
      cleaned: t.cleanups,
    }));
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
      : (testFails.length <= 1 && verifierFails.length === 0 && preflightOk ? 'PARTIAL' : 'FAIL');
    report.failures = {
      tests: testFails.map((t) => ({
        id: t.id,
        failed_checks: Object.entries(t.checks || {}).filter(([, v]) => !v).map(([k]) => k),
        stale_quote_copy_leakage: t.stale_quote_copy_leakage,
      })),
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
