'use strict';
/** Stage 28j.9 — deploy c2ed8fd calendar fix. Temp — do not commit. */
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');

const COMMIT = 'c2ed8fd';
const IMAGE_TAG = `${COMMIT}-stage28j9-calendar-payment-link-fix`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's28j9-calendar-fix';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const STAFF_META_CALLBACK = `https://${STAFF_HOST}/staff/meta/whatsapp/webhook`;
const WF_ID = 'stage27demoLWrite01';
const BOOKING = 'WH-G27-FCD6347442';

const PLAYGROUND_ON_ENV = {
  WHATSAPP_DRY_RUN: 'false',
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: '1152900101233109',
  WHATSAPP_PHONE_NUMBER_ID: '1152900101233109',
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

function stripeKeyIsTest() {
  try {
    const key = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name stripe-secret-key --query value -o tsv');
    return { present: !!key, is_test: String(key).startsWith('sk_test_'), prefix: String(key).slice(0, 8) };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

async function pgConnect() {
  const db = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
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
      `SELECT id, name, active::text FROM workflow_entity WHERE id = $1 LIMIT 1`,
      [WF_ID],
    );
    await nc.end();
    return { workflows: wf.rows, inactive: wf.rows.every((r) => r.active === 'false') };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: STAFF_HOST, path, method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers.cookie ? { Cookie: headers.cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* */ }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function deploy() {
  if (process.env.SKIP_DEPLOY === '1') {
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
  console.error('[deploy] re-apply staging gates...');
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
  const n8n = await n8nWorkflowInactive();
  const pass = String(rev.image || '').includes(IMAGE_TAG)
    && rev.health === 'Healthy'
    && rev.traffic === 100
    && hz === '200'
    && gates.WHATSAPP_DRY_RUN === 'false'
    && gates.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'true'
    && (gates.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null || gates.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST === '')
    && stripeKey.is_test === true
    && n8n.inactive !== false;
  return { pass, active_revision: rev, healthz: hz, gates, stripe_key: stripeKey, n8n, image: IMAGE, meta_webhook: STAFF_META_CALLBACK };
}

async function inspectCalendar() {
  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const setCookie = login.headers && login.headers['set-cookie'];
  const cookie = (setCookie || []).map((x) => x.split(';')[0]).join('; ');
  const cal = await req('GET', '/staff/bed-calendar?client=wolfhouse-somo&start=2026-07-01&end=2026-07-06', null, { cookie });
  const blocks = (cal.body && cal.body.blocks) || [];
  const match = blocks.filter((b) => b.booking_code === BOOKING);

  const pg = await pgConnect();
  const b = await pg.query(
    `SELECT b.id::text, b.booking_code, b.status::text, b.payment_status::text,
            b.amount_paid_cents, b.balance_due_cents, b.confirmation_sent_at::text
       FROM bookings b WHERE b.booking_code = $1`,
    [BOOKING],
  );
  const p = b.rows[0] ? await pg.query(
    `SELECT status::text FROM payments WHERE booking_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
    [b.rows[0].id],
  ) : { rows: [] };
  const bb = b.rows[0] ? await pg.query(
    `SELECT bed_code, room_code FROM booking_beds WHERE booking_id = $1::uuid`,
    [b.rows[0].id],
  ) : { rows: [] };
  await pg.end();

  const block = match[0] || null;
  const blockKey = block ? `${block.room_code || ''}|${block.bed_code || ''}` : null;
  const uiWouldMatch = blockKey === 'DEMO-R1|DEMO-R1-B1';

  const adapterSrc = require('fs').readFileSync(require('path').join(__dirname, 'scripts/lib/meta-open-demo-inbound-adapter.js'), 'utf8');
  const duplicateFixDeployed = adapterSrc.includes('send_payment_link_whatsapp_confirmed: stripeOk && liveReplyGate.ok !== true');

  return {
    booking: b.rows[0] || null,
    payment_status: b.rows[0] && b.rows[0].payment_status,
    payment_row_status: p.rows[0] && p.rows[0].status,
    booking_beds: bb.rows,
    calendar_http: cal.status,
    calendar_success: cal.body && cal.body.success,
    calendar_block: block,
    block_key: blockKey,
    ui_grid_key: 'DEMO-R1|DEMO-R1-B1',
    ui_would_match: uiWouldMatch,
    calendar_visible: !!block && uiWouldMatch,
    confirmation_sent: !!(b.rows[0] && b.rows[0].confirmation_sent_at),
    duplicate_payment_link_fix_deployed: duplicateFixDeployed,
  };
}

(async () => {
  try {
    if (cmd === 'deploy' || cmd === 'all') {
      const before = activeRevision();
      const after = deploy();
      const pf = await preflight();
      console.log(JSON.stringify({ phase: 'deploy', before, after, preflight: pf }, null, 2));
      if (!pf.pass) process.exit(1);
    }
    if (cmd === 'inspect' || cmd === 'all') {
      const pf = await preflight();
      const cal = await inspectCalendar();
      const pass = pf.pass && cal.calendar_visible
        && cal.booking && cal.booking.status === 'hold'
        && cal.payment_status === 'deposit_paid'
        && cal.payment_row_status === 'paid'
        && !cal.confirmation_sent;
      console.log(JSON.stringify({ phase: 'calendar_proof', pass, preflight: pf, ...cal }, null, 2));
      if (!pass) process.exit(1);
    }
  } catch (e) {
    console.error(e.stderr || e.stdout || e.message || e);
    process.exit(1);
  }
})();
