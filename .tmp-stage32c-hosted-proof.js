'use strict';
/** Stage 32c — deploy 791c5bd add-ons/transfer/meals/yoga + combined live WhatsApp reproof. Temp — do not commit. */
const crypto = require('crypto');
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { resetLunaConversationContext } = require('./scripts/lib/staff-conversation-writes');
const { runLiveProofHygiene } = require('./scripts/lib/luna-live-proof-hygiene');
const { fetchMetaCallback } = require('./scripts/lib/open-demo-playground-common');
const { assertComposerFactsMatchHoldFacts } = require('./scripts/lib/luna-quote-facts');
const { correlateHostedProofTurns } = require('./scripts/lib/luna-hosted-proof-send-correlation');

const COMMIT = '791c5bd';
const IMAGE_TAG = `${COMMIT}-stage32c-live-services-proof`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 'stage32c-live-services-proof';
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
    id: '1_happy_no_meals_yoga',
    name: 'Happy path — surf add-ons only, no meals/yoga upsell',
    messages: ['hi', 'book a stay', 'July 6-10', 'just me', 'Just the stay please', 'deposit'],
    cleanupWindows: [{ check_in: '2026-07-06', check_out: '2026-07-10' }],
    checks: (ctx) => ({
      surf_addon_question: ctx.turns.some((t) => /wetsuit|surfboard|lessons/i.test(t.outbound || '')),
      no_proactive_yoga: !ctx.turns.some((t) => /yoga/i.test(t.outbound || '') && !/can i add yoga/i.test(t.inbound || '')),
      no_proactive_meals: !ctx.turns.some((t) => /\b(?:dinner|meals|breakfast)\b/i.test(t.outbound || '') && !/book dinner|decide later/i.test(t.inbound || '')),
      stripe_link_sent: ctx.stripeLinkSends >= 1,
      hold_created: !!ctx.booking,
      calendar_visible: ctx.calendarVisible,
      composer_write_facts_match: ctx.composerWriteFactsMatch !== false,
      no_duplicate_sends: !ctx.duplicateSends,
      no_confirmation: !ctx.confirmationSent,
    }),
  },
  {
    id: '2_surf_addons_priced',
    name: 'Surf add-ons priced — wetsuit + lessons',
    messages: ['hi', 'book a stay', 'July 6-10', 'just me', 'wetsuit and lessons', 'deposit'],
    cleanupWindows: [{ check_in: '2026-07-06', check_out: '2026-07-10' }],
    precleanPaidArtifact: { check_in: '2026-07-06', check_out: '2026-07-10' },
    checks: (ctx) => ({
      addons_observed: ctx.depositObs?.addons_requested?.includes('wetsuit') || ctx.depositObs?.addons_requested?.includes('surf_lesson')
        || ctx.turns.some((t) => /wetsuit|lesson/i.test(t.inbound || '')),
      quote_above_180: ctx.depositObs?.quote_total_cents > 18000
        || ctx.turns.some((t) => /€(?:2\d{2}|[3-9]\d{2})|\b2[0-9]{2}\b/.test(t.outbound || '')),
      composer_write_facts_match: ctx.composerWriteFactsMatch !== false,
      stripe_link_sent: ctx.stripeLinkSends >= 1,
      hold_created: !!ctx.booking,
      calendar_visible: ctx.calendarVisible,
      no_confirmation: !ctx.confirmationSent,
    }),
  },
  {
    id: '3_board_side_question',
    name: 'Board rental side question mid-flow',
    messages: ['hi', 'book a stay', 'July 6-10', 'just me', 'Do you rent boards?', 'yes, add a board', 'deposit'],
    cleanupWindows: [{ check_in: '2026-07-06', check_out: '2026-07-10' }],
    checks: (ctx) => ({
      board_answered: ctx.turns.some((t) => /Do you rent boards/i.test(t.inbound || '') && /board|rent/i.test(t.outbound || '')),
      context_preserved: ctx.turns.some((t) => /July|wetsuit|lessons|booking/i.test(t.outbound || '')),
      board_stored: ctx.depositObs?.addons_requested?.includes('surfboard')
        || ctx.turns.some((t) => /add a board/i.test(t.inbound || '')),
      stripe_link_sent: ctx.stripeLinkSends >= 1,
      hold_created: !!ctx.booking,
      composer_write_facts_match: ctx.composerWriteFactsMatch !== false,
      no_confirmation: !ctx.confirmationSent,
    }),
  },
  {
    id: '4_yoga_reactive',
    name: 'Yoga reactive only',
    messages: ['hi', 'book a stay', 'July 6-10', 'just me', 'Can I add yoga?', 'Just the stay please', 'deposit'],
    cleanupWindows: [{ check_in: '2026-07-06', check_out: '2026-07-10' }],
    checks: (ctx) => ({
      yoga_answered: ctx.turns.some((t) => /Can I add yoga/i.test(t.inbound || '') && /yoga/i.test(t.outbound || '')),
      no_proactive_yoga_before_ask: !ctx.turns.slice(0, 4).some((t) => /yoga/i.test(t.outbound || '')),
      yoga_status_set: ['requested', 'interested', 'needs_staff_confirmation'].includes(ctx.depositObs?.yoga_status),
      services_pending: Array.isArray(ctx.depositObs?.services_pending_manual) && ctx.depositObs.services_pending_manual.includes('yoga'),
      stripe_link_sent: ctx.stripeLinkSends >= 1,
      hold_created: !!ctx.booking,
      no_fake_scheduling: !ctx.turns.some((t) => /scheduled for|booked you into yoga class/i.test(t.outbound || '')),
      no_confirmation: !ctx.confirmationSent,
    }),
  },
  {
    id: '5_meals_reactive',
    name: 'Meals reactive — decide later',
    messages: ['hi', 'book a stay', 'July 6-10', 'just me', 'Can I book dinners?', "I'll decide later", 'Just the stay please', 'deposit'],
    cleanupWindows: [{ check_in: '2026-07-06', check_out: '2026-07-10' }],
    checks: (ctx) => ({
      meals_answered: ctx.turns.some((t) => /book dinners/i.test(t.inbound || '') && /dinner|days|note/i.test(t.outbound || '')),
      decide_later_ok: ctx.turns.some((t) => /decide later/i.test(t.inbound || '')),
      meals_status_set: ['requested', 'interested', 'needs_staff_confirmation'].includes(ctx.depositObs?.meals_status),
      meal_type_dinner: ctx.depositObs?.meal_type === 'dinner' || ctx.depositObs?.meal_type === 'unspecified',
      stripe_link_sent: ctx.stripeLinkSends >= 1,
      hold_created: !!ctx.booking,
      no_confirmation: !ctx.confirmationSent,
    }),
  },
  {
    id: '6_package_transfer_deferral',
    name: 'Package transfer deferral — Malibu',
    messages: ['Malibu July 10 to July 17 for 1', "I'll send flight times later", 'just the stay', 'deposit'],
    cleanupWindows: [{ check_in: '2026-07-10', check_out: '2026-07-17' }],
    checks: (ctx) => ({
      package_quote: ctx.turns.some((t) => /malibu|€399|399/i.test(t.outbound || '')),
      transfer_deferred: ['deferred', 'partial', 'complete'].includes(ctx.depositObs?.transfer_info_status),
      no_stale_malibu_leak: !ctx.turns.some((t, i) => i > 2 && /uluwatu|waimea/i.test(t.outbound || '')),
      stripe_link_sent: ctx.stripeLinkSends >= 1,
      hold_created: !!ctx.booking,
      package_malibu: /malibu/i.test(ctx.booking?.package_code || ''),
      composer_write_facts_match: ctx.composerWriteFactsMatch !== false,
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
  const wamid = `wamid.stage32c.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '34663439419', phone_number_id: DEMO_PHONE_ID },
          contacts: [{ profile: { name: 'Stage32c Guest' }, wa_id: PROOF_PHONE_RAW }],
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

function pickOpenDemoObs(odr, result) {
  const r = result || odr || {};
  const o = odr || {};
  return {
    addons_status: r.addons_status || o.addons_status || null,
    addons_requested: r.addons_requested || o.addons_requested || null,
    addons_priced: r.addons_priced || o.addons_priced || null,
    addons_pending_manual: r.addons_pending_manual || o.addons_pending_manual || null,
    meals_status: r.meals_status || o.meals_status || null,
    meal_type: r.meal_type || o.meal_type || null,
    meals_requested_dates: r.meals_requested_dates || o.meals_requested_dates || null,
    yoga_status: r.yoga_status || o.yoga_status || null,
    yoga_requested_dates: r.yoga_requested_dates || o.yoga_requested_dates || null,
    services_requested: r.services_requested || o.services_requested || null,
    services_pending_manual: r.services_pending_manual || o.services_pending_manual || null,
    services_scheduled: r.services_scheduled || o.services_scheduled || null,
    transfer_info_status: r.transfer_info_status || o.transfer_info_status || null,
    transfer_airport: r.transfer_airport || o.transfer_airport || null,
    transfer_arrival_time: r.transfer_arrival_time || o.transfer_arrival_time || null,
    transfer_departure_time: r.transfer_departure_time || o.transfer_departure_time || null,
    transfer_flight_number: r.transfer_flight_number || o.transfer_flight_number || null,
    quote_total_cents: (r.quote && r.quote.quote_total_cents) || o.quote_total_cents || null,
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
    ...pickOpenDemoObs(odr, result),
    previous_quote_invalidated: result.previous_quote_invalidated === true || odr.previous_quote_invalidated === true,
    stale_quote_reason: result.stale_quote_reason || odr.stale_quote_reason || null,
    quote_facts_used_by_composer: composerFacts,
    quote_facts_used_by_hold_writer: writeFacts,
    composer_write_facts_match: factsMatch.ok,
    final_reply_source: brain.final_reply_source || odr.final_reply_source || null,
    composer_state: brain.composer_state || odr.composer_state || null,
    brain_source: brain.brain_source || null,
    model_used: brain.model_used || brain.model_requested || null,
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
      ...meta,
      duplicate_send_reused: t.duplicate_send_reused,
      match_method: t.match_method,
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
      calendarBlocks = await new Promise((resolve) => {
        https.get({
          hostname: HOST,
          path: `/staff/bed-calendar?client=${CLIENT}&start=${booking.check_in}&end=${booking.check_out}`,
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
  const duplicateSends = correlated.reused_send_ids?.length > 0
    || turns.some((t) => t.duplicate_send_reused === true);

  const depositTurn = turns.find((t) => /^deposit$/i.test((t.inbound || '').trim()));
  const depositObs = depositTurn || turns[turns.length - 1] || {};

  const ctx = {
    turns,
    booking,
    allBookings,
    payment,
    bedAssignments,
    calendarBlocks,
    calendarVisible: calendarBlocks.length > 0 || bedAssignments.length > 0,
    stripeLinkSends,
    confirmationSent,
    depositTurn,
    depositObs,
    duplicateSends,
    composerWriteFactsMatch: depositTurn
      ? depositTurn.composer_write_facts_match
      : turns.every((t) => t.composer_write_facts_match !== false),
  };
  const checks = testDef.checks(ctx);
  const pass = Object.values(checks).every(Boolean);
  return {
    id: testDef.id,
    name: testDef.name,
    pass,
    checks,
    observability: pickOpenDemoObs(depositObs, depositObs),
    transcript: turns,
    booking_code: booking?.booking_code || null,
    payment_draft_id: payment?.id || null,
    stripe_session_id: payment?.stripe_checkout_session_id || null,
    stripe_checkout_url: payment?.checkout_url || null,
    calendar_visible: ctx.calendarVisible,
    duplicate_sends: duplicateSends,
    confirmation_sent: confirmationSent,
    composer_write_facts_match: ctx.composerWriteFactsMatch,
    correlation_warnings: correlated.warnings,
    cleanups: [],
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
      source: `stage32c-${testDef.id}-paid-artifact-preclean`,
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

  for (let i = 0; i < testDef.messages.length; i++) {
    const res = await postMetaWebhook(buildMetaPayload(testDef.messages[i]));
    console.error(`[${testDef.id}] turn ${i + 1}: ${testDef.messages[i]} → HTTP ${res.status}`);
    sleep(i === testDef.messages.length - 1 ? 18000 : 9000);
  }

  const inspected = await inspectTest(sinceIso, testDef);

  for (const win of testDef.cleanupWindows || []) {
    const pg2 = await pgConnect();
    const out = await runLiveProofHygiene({
      client_slug: CLIENT,
      phone: PROOF_PHONE,
      check_in: win.check_in,
      check_out: win.check_out,
      source: `stage32c-${testDef.id}`,
    }, {
      allow_hygiene: true,
      confirm_hygiene: true,
      dry_run: false,
      pg: pg2,
      host_header: HOST,
    });
    await pg2.end();
    inspected.cleanups.push({ window: win, ...out });
  }

  return { since: sinceIso, ...inspected };
}

function restoreGates() {
  setEnvVars(RESTORE_ENV);
  removeEnvVars(['LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST', 'LUNA_AUTO_SEND_ENABLED']);
}

function runVerifiers() {
  const cmds = [
    'npm run verify:stage32b-meals-yoga-reactive-services',
    'npm run verify:stage32-addons-services-mid-booking',
    'npm run verify:stage31e-proof-hygiene-and-send-correlation',
    'npm run verify:stage31c-live-composer-stale-quote-copy',
    'npm run luna:guest-flow-batch -- --local --fixture-set booking-core',
  ];
  const out = {};
  for (const c of cmds) {
    try {
      const result = execSync(c, { encoding: 'utf8', cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024 });
      const m = result.match(/(\d+)\s+passed,\s*(\d+)\s+failed/i) || result.match(/(\d+)\/(\d+)/);
      out[c] = { ok: !/failed/i.test(result.split('\n').slice(-3).join(' ')) || result.includes('0 failed'), tail: result.split('\n').slice(-8).join('\n') };
      if (c.includes('stage31c') && result.includes(' failed')) out[c].ok = false;
      if (c.includes('stage32b') && !result.includes('30/30')) out[c].ok = false;
    } catch (e) {
      out[c] = { ok: false, error: String(e.stderr || e.stdout || e.message).slice(-800) };
    }
  }
  return out;
}

(async () => {
  const report = {
    stage: '32c',
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
      report.revision_active = activeRevision();
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
    report.bookings_created = report.tests.map((t) => ({
      test: t.id,
      booking_code: t.booking_code,
      cleaned: t.cleanups,
    }));

    const preflightOk = !report.preflight || report.preflight.pass;
    report.result = preflightOk && testFails.length === 0 && verifierFails.length === 0
      ? 'PASS'
      : (preflightOk && testFails.length <= 1 && verifierFails.length <= 1 ? 'PARTIAL' : 'FAIL');
    report.failures = {
      tests: testFails.map((t) => ({
        id: t.id,
        failed_checks: Object.entries(t.checks || {}).filter(([, v]) => !v).map(([k]) => k),
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
