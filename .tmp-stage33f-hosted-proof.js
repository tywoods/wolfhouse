'use strict';
/** Stage 33f — deploy 57a9954 yoga service attach DB proof. Temp — do not commit. */
const crypto = require('crypto');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { Client } = require('pg');
const { resetLunaConversationContext } = require('./scripts/lib/staff-conversation-writes');
const { runLiveProofHygiene } = require('./scripts/lib/luna-live-proof-hygiene');
const { fetchMetaCallback } = require('./scripts/lib/open-demo-playground-common');
const { assertComposerFactsMatchHoldFacts } = require('./scripts/lib/luna-quote-facts');
const { correlateHostedProofTurns } = require('./scripts/lib/luna-hosted-proof-send-correlation');
const {
  filterBookingsSince,
  pickProofBookingCandidate,
  pollForPaymentLinkSend,
  isStripePaymentLinkSend,
} = require('./scripts/lib/luna-hosted-proof-booking-lookup');

const COMMIT = '57a9954';
const IMAGE_TAG = `${COMMIT}-stage33f-yoga-service-attach-proof`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 'stage33f-yoga-attach';
const HOST = 'staff-staging.lunafrontdesk.com';
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

const PROOF_WINDOW = { check_in: '2026-07-10', check_out: '2026-07-17' };

const TEST_A = {
  id: 'A_yoga_pending_attach',
  name: 'Yoga pending manual service attach after hold',
  messages: ['Malibu July 10 to July 17 for 1', 'just the stay', 'Can I add yoga?', 'deposit'],
  cleanupWindows: [PROOF_WINDOW],
  checkIn: PROOF_WINDOW.check_in,
  checkOut: PROOF_WINDOW.check_out,
  checks: (ctx) => ({
    malibu_preserved: /malibu/i.test(ctx.booking?.package_code || '')
      || ctx.turns.some((t) => /malibu/i.test(t.outbound || '')),
    yoga_status_requested: ['requested', 'interested', 'needs_staff_confirmation'].includes(ctx.depositObs?.yoga_status),
    services_pending_manual: Array.isArray(ctx.depositObs?.services_pending_manual)
      && ctx.depositObs.services_pending_manual.includes('yoga'),
    service_interest_no_yoga: !(ctx.depositObs?.addons_requested || []).includes('yoga'),
    plan_status_ready: ctx.depositPlanStatus === 'ready' || !!ctx.booking,
    hold_created: !!ctx.booking,
    payment_draft_created: !!ctx.payment,
    stripe_link_sent: ctx.stripeLinkSends >= 1 || !!ctx.payment?.stripe_checkout_session_id,
    attached_manual_services: ctx.attachedManualServices?.includes('yoga')
      || ctx.depositWriteObs?.attached_manual_services?.includes('yoga'),
    yoga_record_exists: ctx.serviceRecords?.some((r) => r.service_type === 'yoga'),
    yoga_record_source: ctx.serviceRecords?.some((r) => r.service_type === 'yoga' && r.source === 'luna_guest'),
    yoga_pending_origin: ctx.serviceRecords?.some((r) => r.service_type === 'yoga'
      && r.metadata?.pending_origin === 'luna_guest_pending'),
    yoga_intent_status: ctx.serviceRecords?.some((r) => r.service_type === 'yoga'
      && r.metadata?.intent_status === 'requested'),
    yoga_pending_manual_meta: ctx.serviceRecords?.some((r) => r.service_type === 'yoga'
      && (r.metadata?.pending_manual === true || r.metadata?.service_pending_manual === true)),
    yoga_record_status: ctx.serviceRecords?.some((r) => r.service_type === 'yoga' && r.status === 'requested'),
    yoga_needs_scheduling: ctx.serviceRecords?.some((r) => r.service_type === 'yoga' && r.metadata?.needs_scheduling === true),
    yoga_no_fake_date: ctx.serviceRecords?.every((r) => r.service_type !== 'yoga' || r.service_date == null),
    no_duplicate_yoga: (ctx.serviceRecords || []).filter((r) => r.service_type === 'yoga').length <= 1,
    no_confirmation: !ctx.confirmationSent,
  }),
};

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
  const wamid = `wamid.stage33f.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '34663439419', phone_number_id: DEMO_PHONE_ID },
          contacts: [{ profile: { name: 'Stage33e Guest' }, wa_id: PROOF_PHONE_RAW }],
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
  await demoteOwner(pg);
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
    meals_status: r.meals_status || o.meals_status || null,
    yoga_status: r.yoga_status || o.yoga_status || null,
    services_pending_manual: r.services_pending_manual || o.services_pending_manual || null,
    attached_manual_services: r.attached_manual_services || o.attached_manual_services || null,
    quote_total_cents: (r.quote && r.quote.quote_total_cents) || o.quote_total_cents || null,
    transfer_info_status: r.transfer_info_status || o.transfer_info_status || null,
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
    services_pending_manual: result.services_pending_manual || odr.services_pending_manual || null,
    attached_manual_services: result.attached_manual_services || odr.attached_manual_services || null,
    final_reply_source: brain.final_reply_source || odr.final_reply_source || null,
    composer_state: brain.composer_state || odr.composer_state || null,
    composer_write_facts_match: factsMatch.ok,
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
    `SELECT id::text, status, message_text, provider_message_id, send_kind, created_at::text, updated_at::text
       FROM guest_message_sends
      WHERE client_slug = $1 AND REPLACE(COALESCE(to_phone,''),'+','') = $2
        AND (created_at >= $3::timestamptz OR updated_at >= $3::timestamptz)
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

  const allBookingsRaw = (await pg.query(
    `SELECT b.id::text, b.booking_code, b.package_code, b.status::text, b.payment_status::text,
            b.check_in::text, b.check_out::text, b.guest_count, b.confirmation_sent_at::text,
            b.created_at::text, b.updated_at::text
       FROM bookings b JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND REPLACE(COALESCE(b.phone,''),'+','') = $2
        AND (b.created_at >= $3::timestamptz OR b.updated_at >= $3::timestamptz)
      ORDER BY GREATEST(b.updated_at, b.created_at) DESC`,
    [CLIENT, PROOF_PHONE_RAW, sinceIso],
  )).rows;

  const allBookings = filterBookingsSince(allBookingsRaw, sinceIso);
  const booking = pickProofBookingCandidate(allBookings.length ? allBookings : allBookingsRaw, {
    sinceIso,
    checkIn: testDef.checkIn,
    checkOut: testDef.checkOut,
    conversationId: conv?.id || null,
  }) || allBookingsRaw.find((b) => b.status !== 'cancelled') || allBookingsRaw[0] || null;

  let payment = null;
  let serviceRecords = [];
  if (booking) {
    payment = (await pg.query(
      `SELECT p.id::text, p.status::text, p.payment_kind::text, p.amount_due_cents,
              p.stripe_checkout_session_id, p.checkout_url, p.created_at::text
         FROM payments p WHERE p.booking_id = $1::uuid ORDER BY p.created_at DESC LIMIT 1`,
      [booking.id],
    )).rows[0] || null;
    serviceRecords = (await pg.query(
      `SELECT id::text, service_type, service_date::text, status, source, metadata, created_at::text
         FROM booking_service_records
        WHERE booking_id = $1::uuid
          AND source = 'luna_guest'
          AND metadata->>'pending_origin' = 'luna_guest_pending'
        ORDER BY created_at ASC`,
      [booking.id],
    )).rows.map((r) => ({
      ...r,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {}),
    }));
  }

  await pg.end();

  let stripeLinkSends = sends.filter((s) => isStripePaymentLinkSend(s)).length;
  let lateStripeSend = null;
  if (stripeLinkSends === 0) {
    const poll = await pollForPaymentLinkSend(async () => {
      const pgPoll = await pgConnect();
      const rows = (await pgPoll.query(
        `SELECT id::text, status, message_text, provider_message_id, send_kind, created_at::text, updated_at::text
           FROM guest_message_sends
          WHERE client_slug = $1 AND REPLACE(COALESCE(to_phone,''),'+','') = $2
            AND (created_at >= $3::timestamptz OR updated_at >= $3::timestamptz)
          ORDER BY created_at ASC`,
        [CLIENT, PROOF_PHONE_RAW, sinceIso],
      )).rows;
      await pgPoll.end();
      return rows;
    }, {
      sinceIso,
      bookingId: booking?.id || null,
      paymentDraftId: payment?.id || null,
      conversationId: conv?.id || null,
      intervalMs: 2000,
      maxWaitMs: 45000,
      firstWindowMs: 12000,
    });
    if (poll.send) {
      lateStripeSend = poll;
      stripeLinkSends = 1;
    }
  }

  const confirmationSent = sends.some((s) => s.send_kind === 'confirmation' && s.status === 'sent')
    || allBookingsRaw.some((b) => b.confirmation_sent_at);
  const depositTurn = turns.find((t) => /^deposit$/i.test((t.inbound || '').trim()));
  const depositObs = depositTurn || turns[turns.length - 1] || {};
  const depositEvent = events.find((ev) => /^deposit$/i.test(String(ev.message_text || '').trim()));
  const depositOdr = depositEvent?.open_demo_result || {};
  const depositPlanStatus = depositOdr.hold_payment_draft_plan?.plan_status
    || depositOdr.review?.hold_payment_draft_plan?.plan_status
    || null;
  const depositWriteObs = depositOdr.demo_booking_write || depositOdr.booking_write || null;

  const attachedManualServices = serviceRecords
    .filter((r) => r.source === 'luna_guest' && r.metadata?.pending_origin === 'luna_guest_pending')
    .map((r) => (r.service_type === 'meal' ? 'meals' : r.service_type));

  const ctx = {
    turns,
    booking,
    payment,
    serviceRecords,
    attachedManualServices,
    stripeLinkSends,
    lateStripeSend,
    confirmationSent,
    depositObs,
    depositPlanStatus,
    depositWriteObs,
  };
  const checks = testDef.checks(ctx);
  const pass = Object.values(checks).every(Boolean);
  return {
    id: testDef.id,
    name: testDef.name,
    pass,
    checks,
    observability: pickOpenDemoObs(depositObs, depositObs),
    deposit_write: depositWriteObs,
    transcript: turns,
    booking_id: booking?.id || null,
    booking_code: booking?.booking_code || null,
    payment_draft_id: payment?.id || null,
    stripe_session_id: payment?.stripe_checkout_session_id || null,
    stripe_checkout_url: payment?.checkout_url || null,
    service_records: serviceRecords,
    attached_manual_services: attachedManualServices,
    late_send_observed: lateStripeSend?.late_send_observed === true,
    confirmation_sent: confirmationSent,
    correlation_warnings: correlated.warnings,
    conversation_id: conv?.id || null,
    cleanups: [],
  };
}

async function runTest(testDef) {
  const sinceIso = new Date().toISOString();
  const pg = await pgConnect();
  await demoteOwner(pg);
  await freshStart(pg);
  await pg.end();

  for (let i = 0; i < testDef.messages.length; i++) {
    const res = await postMetaWebhook(buildMetaPayload(testDef.messages[i]));
    console.error(`[${testDef.id}] turn ${i + 1}: ${testDef.messages[i]} → HTTP ${res.status}`);
    sleep(i === testDef.messages.length - 1 ? 35000 : 10000);
  }

  const inspected = await inspectTest(sinceIso, testDef);

  for (const win of testDef.cleanupWindows || []) {
    const pg2 = await pgConnect();
    const out = await runLiveProofHygiene({
      client_slug: CLIENT,
      phone: PROOF_PHONE,
      check_in: win.check_in,
      check_out: win.check_out,
      source: `stage33f-${testDef.id}`,
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

async function runPreclean() {
  const pg = await pgConnect();
  await demoteOwner(pg);
  const out = await runLiveProofHygiene({
    client_slug: CLIENT,
    phone: PROOF_PHONE,
    check_in: PROOF_WINDOW.check_in,
    check_out: PROOF_WINDOW.check_out,
    source: 'stage33f-preclean',
  }, {
    allow_hygiene: true,
    confirm_hygiene: true,
    allow_staging_paid_proof_reset: true,
    dry_run: false,
    pg,
    host_header: HOST,
  });
  await freshStart(pg);
  await pg.end();
  return out;
}

function restoreGates() {
  setEnvVars(RESTORE_ENV);
  removeEnvVars(['LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST', 'LUNA_AUTO_SEND_ENABLED']);
}

function runVerifiers() {
  const cmds = [
    'npm run verify:stage33e1-pending-service-db-constraint-mapping',
    'npm run verify:stage33d1-open-demo-pending-service-attach-wiring',
    'npm run verify:stage33c-pending-service-attach-hold-write',
    'npm run verify:stage33-package-addons-and-service-attach',
    'npm run verify:stage32b-meals-yoga-reactive-services',
    'npm run luna:guest-flow-batch -- --local --fixture-set booking-core',
  ];
  const out = {};
  for (const c of cmds) {
    try {
      const result = execSync(c, { encoding: 'utf8', cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024 });
      out[c] = { ok: !/\d+ failed/i.test(result) || /0 failed/.test(result), tail: result.split('\n').slice(-6).join('\n') };
    } catch (e) {
      out[c] = { ok: false, error: String(e.stderr || e.stdout || e.message).slice(-800) };
    }
  }
  return out;
}

(async () => {
  const report = {
    stage: '33f',
    commit: COMMIT,
    image: IMAGE,
    image_tag: IMAGE_TAG,
    result: 'FAIL',
    tests: [],
  };

  try {
    if (cmd === 'deploy' || cmd === 'all') {
      report.gates_before = envPick(GATE_NAMES);
      report.deploy = deploy();
      report.gates_during = envPick(GATE_NAMES);
      report.revision_active = activeRevision();
      report.healthz_during = healthz();
    }
    if (cmd === 'preclean' || cmd === 'all') {
      report.preclean = await runPreclean();
    }
    if (cmd === 'preflight' || cmd === 'all') {
      report.preflight = await preflight();
    }
    if (cmd === 'tests' || cmd === 'all') {
      setEnvVars(LIVE_ENV);
      removeEnvVars(['LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST', 'LUNA_AUTO_SEND_ENABLED']);
      sleep(20000);
      report.gates_during = envPick(GATE_NAMES);
      report.tests.push(await runTest(TEST_A));
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
      report.n8n_final = await n8nInactive();
    }
    if (cmd === 'verifiers' || cmd === 'all') {
      report.verifiers = runVerifiers();
    }

    const testFails = report.tests.filter((t) => !t.pass);
    const verifierFails = report.verifiers
      ? Object.entries(report.verifiers).filter(([, v]) => !v.ok).map(([k]) => k)
      : [];
    const preflightOk = !report.preflight || report.preflight.pass;
    const yogaDbPass = report.tests[0]?.checks?.yoga_record_exists === true
      && report.tests[0]?.checks?.yoga_record_source === true
      && report.tests[0]?.checks?.yoga_pending_origin === true;
    report.result = preflightOk && yogaDbPass && testFails.length === 0 && verifierFails.length === 0
      ? 'PASS'
      : (yogaDbPass ? 'PARTIAL' : 'FAIL');
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

  const outPath = path.join(__dirname, '.tmp-stage33f-proof-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.result === 'PASS' ? 0 : report.result === 'PARTIAL' ? 2 : 1);
})();
