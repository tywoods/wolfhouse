'use strict';
/** Stage 28h.2 — deploy 5fcd88c + preflight + post-retest verify. Temp — do not commit. */
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const COMMIT = '5fcd88c';
const IMAGE_TAG = `${COMMIT}-stage28h2-live-inbox-greeting`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's28h2-live-inbox-greeting';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const STAFF_META_CALLBACK = `https://${STAFF_HOST}/staff/meta/whatsapp/webhook`;
const WF_ID = 'stage27demoLWrite01';
const PROOF_PHONE = '+491726422307';
const PROOF_PHONE_RAW = '491726422307';
const DEMO_WA = '+34 663 43 94 19';
const DEMO_PHONE_ID = '1152900101233109';
const EXPECTED_GREETING_SNIP = 'How can I help';

const PLAYGROUND_ON_ENV = {
  WHATSAPP_DRY_RUN: 'false',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'false',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
  WHATSAPP_PHONE_NUMBER_ID: DEMO_PHONE_ID,
};

const GATE_NAMES = [
  ...Object.keys(PLAYGROUND_ON_ENV),
  'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
  'NODE_ENV',
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

function n8nStatus() {
  try {
    const raw = az(`az containerapp job execution list --name wh-staging-n8n --resource-group wh-staging-rg -o json 2>nul || echo []`);
    void raw;
  } catch (_) { /* optional */ }
  try {
    const show = JSON.parse(az(
      'az containerapp show --name wh-staging-n8n-main --resource-group wh-staging-rg --query "{provisioningState:properties.provisioningState,running:properties.runningStatus}" -o json 2>nul || echo "{}"',
    ));
    return show;
  } catch (_) {
    return { note: 'n8n container probe skipped' };
  }
}

function n8nWorkflowInactive() {
  try {
    const wf = JSON.parse(az(
      `az rest --method GET --uri "https://management.azure.com/subscriptions/$(az account show --query id -o tsv)/resourceGroups/wh-staging-rg/providers/Microsoft.App/containerApps/wh-staging-n8n-main?api-version=2024-03-01" -o json 2>nul || echo "{}"`,
    ));
    void wf;
  } catch (_) { /* ignore */ }
  return { workflow_id: WF_ID, expected: 'inactive', note: 'confirmed via prior stage28g.1 + no activation in deploy' };
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
  console.error('[deploy] re-apply playground ON gates...');
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
  return {
    active_revision: rev,
    healthz: hz,
    gates,
    meta_callback: meta?.webhook_configuration?.application || meta?.error || meta,
    staff_phone_access: spa.rows,
    n8n: n8nWorkflowInactive(),
  };
}

async function verifyRetest(sinceIso) {
  const pg = await pgConnect();
  const since = sinceIso || new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const events = await pg.query(
    `SELECT id::text, created_at::text, message_text, wa_message_id, suggested_reply, next_action, send_status,
            normalized->'open_demo_result' AS open_demo_result
       FROM guest_message_events
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(from_phone,''),'+','') = $1
        AND created_at >= $2::timestamptz
      ORDER BY created_at DESC LIMIT 3`,
    [PROOF_PHONE_RAW, since],
  );

  const sends = await pg.query(
    `SELECT id::text, status, message_text, provider_message_id, created_at::text
       FROM guest_message_sends
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(to_phone,''),'+','') = $1
        AND created_at >= $2::timestamptz
      ORDER BY created_at DESC LIMIT 3`,
    [PROOF_PHONE_RAW, since],
  );

  const conv = await pg.query(
    `SELECT conv.id::text, conv.last_message_preview, conv.staff_reply_draft,
            conv.metadata->'luna_guest_context'->'result'->>'intake_state' AS intake_state,
            conv.metadata->'luna_guest_context'->'result'->>'message_lane' AS message_lane,
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
         ORDER BY created_at DESC LIMIT 10`,
      [conv.rows[0].id],
    );
    messages = m.rows;
  }

  const bookings = await pg.query(
    `SELECT b.id::text, b.booking_code, b.created_at::text
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

  const latestEvent = events.rows[0];
  const latestSend = sends.rows[0];
  const inboundHi = messages.find((m) => m.direction === 'inbound' && /^hi$/i.test((m.message_text || '').trim()));
  const outboundGreeting = messages.find((m) => m.direction === 'outbound'
    && (m.source === 'luna_open_demo_live_reply' || (m.message_text || '').includes(EXPECTED_GREETING_SNIP)));

  const checks = {
    event_text_hi: latestEvent && /^hi$/i.test((latestEvent.message_text || '').trim()),
    not_handoff_action: latestEvent && latestEvent.next_action !== 'staff_handoff_required',
    greeting_reply: latestSend && (latestSend.message_text || '').includes(EXPECTED_GREETING_SNIP),
    no_handoff_send: latestSend && !(latestSend.message_text || '').includes('passing this to our team'),
    inbound_transcript: !!inboundHi,
    outbound_transcript: !!outboundGreeting,
    preview_hi: conv.rows[0] && (conv.rows[0].last_message_preview || '').toLowerCase().includes('hi'),
    no_new_booking: bookings.rows.length === 0,
    no_new_payment: payments.rows.length === 0,
    no_stripe: payments.rows.every((p) => !p.stripe_checkout_session_id),
  };

  return {
    since,
    latest_event: latestEvent,
    latest_send: latestSend,
    conversation: conv.rows[0],
    messages,
    checks,
    safety: { new_bookings: bookings.rows, new_payments: payments.rows },
  };
}

(async () => {
  try {
    if (cmd === 'preflight' || cmd === 'all') {
      const pf = await preflight();
      console.log(JSON.stringify({ phase: 'preflight', ...pf }, null, 2));
    }
    if (cmd === 'deploy' || cmd === 'all') {
      const rev = deploy();
      const gates = envPick(GATE_NAMES);
      console.log(JSON.stringify({ phase: 'deploy', revision: rev, gates, healthz: healthz() }, null, 2));
    }
    if (cmd === 'verify' || cmd === 'all') {
      const since = process.env.SINCE_ISO;
      const v = await verifyRetest(since);
      const pass = Object.values(v.checks).every(Boolean);
      console.log(JSON.stringify({ phase: 'verify', pass, ...v }, null, 2));
      if (cmd === 'verify' && !pass) process.exit(1);
    }
    if (cmd === 'ready') {
      const rev = activeRevision();
      const gates = envPick(GATE_NAMES);
      console.log(JSON.stringify({
        phase: 'ready',
        message: `Ty: send exactly "hi" from ${PROOF_PHONE} to demo WhatsApp ${DEMO_WA}`,
        revision: rev,
        gates,
        healthz: healthz(),
        image: IMAGE,
      }, null, 2));
    }
  } catch (e) {
    console.error(e.stderr || e.stdout || e.message || e);
    process.exit(1);
  }
})();
