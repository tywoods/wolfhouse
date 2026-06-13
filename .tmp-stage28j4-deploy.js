'use strict';
/** Stage 28j.4 — deploy 4349826 short-stay accommodation pricing to live staging. Temp — do not commit. */
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');
const { resetLunaConversationContext } = require('./scripts/lib/staff-conversation-writes');

const COMMIT = '4349826';
const IMAGE_TAG = `${COMMIT}-stage28j4-short-stay-pricing`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's28j4-short-stay-pricing';
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

const RETEST_MESSAGES = [
  'hi',
  'book a stay',
  'July 1-5',
  '1',
  'no add nothing',
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
    && gates.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'false'
    && (gates.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null || gates.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST === '')
    && spa.rows.some((r) => r.is_active === 'false');
  return {
    pass,
    active_revision: rev,
    healthz: hz,
    gates,
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

(async () => {
  try {
    if (cmd === 'deploy' || cmd === 'all') {
      const before = activeRevision();
      const rev = deploy();
      const pf = await preflight();
      console.log(JSON.stringify({ phase: 'deploy', before, after: rev, preflight: pf }, null, 2));
      if (!pf.pass) process.exit(1);
    }
    if (cmd === 'ready' || cmd === 'all') {
      const pf = await preflight();
      const fs = await freshStart();
      console.log(JSON.stringify({
        phase: 'ready',
        pass: pf.pass,
        fresh_start: fs,
        message: `Ty: send these 5 messages from ${PROOF_PHONE} to demo WhatsApp ${DEMO_WA}:`,
        retest_sequence: RETEST_MESSAGES,
        revision: pf.active_revision,
        gates: pf.gates,
        healthz: pf.healthz,
        image: IMAGE,
        meta_webhook: STAFF_META_CALLBACK,
      }, null, 2));
      if (!pf.pass) process.exit(1);
    }
  } catch (e) {
    console.error(e.stderr || e.stdout || e.message || e);
    process.exit(1);
  }
})();
