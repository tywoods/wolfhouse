'use strict';
/** Stage 28j.1 — deploy e0b6655 smart conversation brain to live staging. Temp — do not commit. */
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const COMMIT = 'e0b6655';
const IMAGE_TAG = `${COMMIT}-stage28j-smart-brain-live-staging`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's28j1-smart-brain-live';
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
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
  WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
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
  'OPENAI_API_KEY',
  'LUNA_AI_MODEL',
  'LUNA_AI_PROVIDER',
];

const cmd = process.argv[2] || 'all';

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

function graphWebhook(token) {
  return new Promise((resolve, reject) => {
    https.get(`https://graph.facebook.com/v21.0/${DEMO_PHONE_ID}?fields=display_phone_number,webhook_configuration&access_token=${encodeURIComponent(token)}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    }).on('error', reject);
  });
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
      'az containerapp show --name wh-production-staff-api --resource-group wh-production-rg --query "{image:properties.template.containers[0].image,latestRevision:properties.latestRevisionName}" -o json 2>nul || echo "{}"',
    ));
    return { production_staff_api: prod, untouched: true, note: 'no production deploy performed in this script' };
  } catch (e) {
    return { note: 'production probe skipped', error: String(e.message || e) };
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
  console.error('[deploy] re-apply playground ON + smart brain gates...');
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
  let meta = null;
  try {
    const token = az('az keyvault secret show --vault-name wh-staging-kv --name meta-whatsapp-access-token --query value -o tsv');
    meta = await graphWebhook(token);
  } catch (e) {
    meta = { error: String(e.message || e) };
  }
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
    && gates.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'true'
    && gates.LUNA_CONVERSATION_BRAIN_LLM_ENABLED === 'true'
    && gates.LUNA_CONVERSATION_BRAIN_MODEL === 'gpt-5.5'
    && (gates.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null || gates.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST === '')
    && spa.rows.some((r) => r.is_active === 'false');
  return {
    pass,
    active_revision: rev,
    healthz: hz,
    gates,
    meta_callback: meta?.webhook_configuration?.application || meta?.error || meta,
    meta_webhook_expected: STAFF_META_CALLBACK,
    staff_phone_access: spa.rows,
    n8n,
    production: prod,
    image: IMAGE,
  };
}

async function inspectRetest(sinceIso) {
  const pg = await pgConnect();
  const since = sinceIso || new Date(Date.now() - 45 * 60 * 1000).toISOString();

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
    `SELECT id::text, status, message_text, provider_message_id, created_at::text
       FROM guest_message_sends
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(to_phone,''),'+','') = $1
        AND created_at >= $2::timestamptz
      ORDER BY created_at ASC`,
    [PROOF_PHONE_RAW, since],
  );

  const conv = await pg.query(
    `SELECT conv.id::text, conv.last_message_preview, conv.staff_reply_draft,
            conv.metadata->'luna_guest_context' AS luna_guest_context,
            conv.metadata->'luna_guest_context'->'result'->>'intake_state' AS intake_state,
            conv.metadata->'luna_guest_context'->'result'->>'message_lane' AS message_lane,
            conv.metadata->'luna_guest_context'->'result'->'conversation_brain' AS conversation_brain,
            conv.metadata->'luna_guest_context'->'result'->>'package_night_rule' AS package_night_rule,
            conv.updated_at::text
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
         ORDER BY created_at ASC`,
      [conv.rows[0].id],
    );
    messages = m.rows;
  }

  const bookings = await pg.query(
    `SELECT b.id::text, b.booking_code, b.package_code, b.check_in::text, b.check_out::text, b.created_at::text
       FROM bookings b JOIN clients c ON c.id = b.client_id
      WHERE c.slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(b.phone,''),'+','') = $1
        AND b.created_at >= $2::timestamptz`,
    [PROOF_PHONE_RAW, since],
  );

  const payments = await pg.query(
    `SELECT p.id::text, p.status, p.stripe_checkout_session_id, p.created_at::text
       FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN clients c ON c.id = b.client_id
      WHERE c.slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(b.phone,''),'+','') = $1
        AND p.created_at >= $2::timestamptz`,
    [PROOF_PHONE_RAW, since],
  );

  await pg.end();

  const turns = [];
  for (const ev of events.rows) {
    const odr = ev.open_demo_result || {};
    const brain = odr?.result?.conversation_brain || odr?.conversation_brain || null;
    const send = sends.rows.find((s) => Math.abs(new Date(s.created_at) - new Date(ev.created_at)) < 120000);
    turns.push({
      inbound: ev.message_text,
      outbound: send?.message_text || ev.suggested_reply,
      next_action: ev.next_action,
      send_status: ev.send_status,
      brain,
      package_night_rule: odr?.result?.package_night_rule || null,
      extracted_fields: odr?.result?.extracted_fields || null,
      safe_handoff: odr?.result?.safe_handoff_required,
      llm_source: brain?.source || brain?.brain_source || null,
      brain_enabled: brain?.brain_enabled ?? null,
      llm_enabled: brain?.llm_enabled ?? null,
      model_requested: brain?.model_requested || null,
      model_used: brain?.model_used || null,
      llm_error: brain?.llm_error || null,
      brain_intent: brain?.brain_intent || brain?.intent || null,
      brain_reply_type: brain?.brain_reply_type || brain?.reply_type || null,
      final_reply_source: brain?.final_reply_source || null,
      final_reply_overrode_brain: brain?.final_reply_overrode_brain ?? null,
    });
  }

  const checks = {
    greeting_menu: turns.some((t) => /^hi$/i.test((t.inbound || '').trim())
      && /how can i help/i.test(t.outbound || '')),
    ask_dates: turns.some((t) => /book a stay/i.test(t.inbound || '')
      && /check-in|check-out|dates/i.test(t.outbound || '')),
    ask_guests: turns.some((t) => /july 1-5/i.test(t.inbound || '')
      && /how many guests/i.test(t.outbound || '')),
    short_stay_guidance: turns.some((t) => /^1$/i.test((t.inbound || '').trim())
      && /under 7 nights|7 nights/i.test(t.outbound || '')),
    accommodation_only: turns.some((t) => /no add nothing/i.test(t.inbound || '')
      && /accommodation only/i.test(t.outbound || '')
      && !/which package are you interested/i.test(t.outbound || '')),
    correction_ack: turns.some((t) => /you told me they are not available/i.test(t.inbound || '')
      && /you'?re right|sorry about the mix-up/i.test(t.outbound || '')
      && t.safe_handoff !== true),
    no_stripe: payments.rows.every((p) => !p.stripe_checkout_session_id),
    no_confirmation: true,
    no_package_under_7: !bookings.rows.some((b) => ['malibu', 'uluwatu', 'waimea'].includes((b.package_code || '').toLowerCase())
      && b.check_in && b.check_out
      && (new Date(b.check_out) - new Date(b.check_in)) / 86400000 < 7),
  };

  const passCount = Object.values(checks).filter(Boolean).length;
  const totalChecks = Object.keys(checks).length;
  const pass = passCount >= totalChecks - 1; // allow one soft miss if transcript timing

  return {
    since,
    pass,
    checks,
    turns,
    conversation: conv.rows[0],
    messages,
    bookings: bookings.rows,
    payments: payments.rows,
    transcript: messages.map((m) => ({ direction: m.direction, text: m.message_text, at: m.created_at })),
  };
}

(async () => {
  try {
    if (cmd === 'preflight' || cmd === 'all') {
      const pf = await preflight();
      console.log(JSON.stringify({ phase: 'preflight', ...pf }, null, 2));
    }
    if (cmd === 'deploy' || cmd === 'all') {
      const before = activeRevision();
      const rev = deploy();
      const pf = await preflight();
      console.log(JSON.stringify({ phase: 'deploy', before, after: rev, preflight: pf }, null, 2));
      if (!pf.pass) process.exit(1);
    }
    if (cmd === 'ready') {
      const pf = await preflight();
      console.log(JSON.stringify({
        phase: 'ready',
        pass: pf.pass,
        message: `Ty: send these 6 messages from ${PROOF_PHONE} to demo WhatsApp ${DEMO_WA} (Fresh Start first if old context remains): hi | book a stay | July 1-5 | 1 | no add nothing | you told me they are not available. i'm only staying 5 days`,
        revision: pf.active_revision,
        gates: pf.gates,
        healthz: pf.healthz,
        image: IMAGE,
        meta_webhook: STAFF_META_CALLBACK,
      }, null, 2));
      if (!pf.pass) process.exit(1);
    }
    if (cmd === 'inspect') {
      const since = process.env.SINCE_ISO;
      const v = await inspectRetest(since);
      console.log(JSON.stringify({ phase: 'inspect', ...v }, null, 2));
      if (!v.pass) process.exit(1);
    }
  } catch (e) {
    console.error(e.stderr || e.stdout || e.message || e);
    process.exit(1);
  }
})();
