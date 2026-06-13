'use strict';
/** Stage 51 full deploy — local working tree + LUNA_GUEST_STAGING_V1 flags. Temp — do not commit. */

const https = require('https');
const { execSync } = require('child_process');

const COMMIT = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const IMAGE_TAG = `${COMMIT}-stage51-staging-v1`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's51-staging-v1';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';

const ENV_EXPECT = {
  OPEN_DEMO_WHATSAPP_ENABLED: 'true',
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'false',
  LUNA_GUEST_AGENT_BRAIN_ENABLED: 'true',
  LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'true',
  LUNA_GUEST_GPT_TOOL_PLANNER_ENABLED: 'true',
  LUNA_GUEST_GPT_TOOL_PLANNER_ACTIVE: 'true',
  LUNA_GUEST_GPT_WRITE_TOOLS_ENABLED: 'true',
  LUNA_GUEST_GPT_WRITE_TOOLS_ACTIVE: 'true',
  LUNA_GUEST_SERVICE_PAY_NOW_ENABLED: 'false',
  STAFF_ACTIONS_ENABLED: 'true',
  STRIPE_LINKS_ENABLED: 'true',
};

const cmd = process.argv[2] || 'deploy';

function az(cmdStr) {
  return execSync(cmdStr, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sleep(ms) {
  execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' });
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((r) => r.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties?.healthState,
    traffic: a.properties?.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

function envPick() {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const out = {};
  for (const n of Object.keys(ENV_EXPECT)) {
    const e = env.find((x) => x.name === n);
    out[n] = e ? e.value : null;
  }
  return out;
}

function healthz() {
  return execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${STAFF_HOST}/healthz`, { encoding: 'utf8' }).trim();
}

function deploy() {
  console.error(`[deploy] commit=${COMMIT} image=${IMAGE}`);
  console.error('[deploy] acr build...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  const envArgs = Object.entries(ENV_EXPECT).map(([k, v]) => `${k}=${v}`).join(' ');
  console.error('[deploy] containerapp update + staging v1 flags...');
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REV_SUFFIX}`,
    '--set-env-vars',
    envArgs,
    '-o none',
  ].join(' '));
  for (let i = 0; i < 60; i++) {
    const rev = activeRevision();
    const hz = healthz();
    const env = envPick();
    const envOk = Object.entries(ENV_EXPECT).every(([k, v]) => env[k] === v);
    console.error(`[deploy] wait ${i + 1}/60 rev=${rev.name} health=${rev.health} hz=${hz} envOk=${envOk}`);
    if (String(rev.image || '').includes('stage51-staging-v1') && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200' && envOk) {
      console.log(JSON.stringify({ ok: true, revision: rev.name, image: rev.image, env }, null, 2));
      return;
    }
    sleep(5000);
  }
  throw new Error('deploy did not become healthy in time');
}

function httpsJson(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: STAFF_HOST, path, method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function proof() {
  let token = '';
  try {
    token = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
  } catch { /* optional */ }

  const ui = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: STAFF_HOST,
      path: '/staff/ui?cb=stage51',
      method: 'GET',
      headers: { Accept: 'text/html' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw: buf }));
    });
    req.on('error', reject);
    req.end();
  });

  const headers = token ? { 'X-Luna-Bot-Token': token } : {};
  const dry = await httpsJson('POST', '/staff/bot/guest-inbound-review-dry-run', {
    source: 'stage51_deploy_proof',
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    guest_phone: `+34651${String(Date.now()).slice(-6)}`,
    contact_name: 'Stage51 Proof',
    message_text: 'Oh hello!!!',
    reference_date: '2026-06-11',
    received_at: new Date().toISOString(),
    automation_gate_context: { public_guest_automation_enabled: false, whatsapp_dry_run: true, live_send_allowed: false },
  }, headers);

  const review = dry.body?.review || {};
  const r = review.result || {};
  const obs = review.observability || dry.body?.observability || {};
  const out = {
    revision: activeRevision(),
    env: envPick(),
    calendar: {
      max_4000: ui.raw.includes('BC_GRID_HEIGHT_MAX = 4000'),
      resize_fix: ui.raw.includes("wrap.style.maxHeight = ''"),
    },
    luna: {
      status: dry.status,
      reply: String(review.proposed_luna_reply || '').slice(0, 200),
      has_reply_pipeline: !!(obs.guest_reply_pipeline || r.guest_reply_pipeline),
      write_planner: r.guest_gpt_write_tool_planner || obs.guest_gpt_write_tool_planner || null,
      cami_skipped_hello: (obs.guest_reply_pipeline?.cami_skipped === true) || (r.guest_reply_pipeline?.cami_skipped === true),
    },
  };
  console.log(JSON.stringify(out, null, 2));
}

if (cmd === 'proof') {
  proof().catch((e) => { console.error(e); process.exit(1); });
} else {
  deploy();
}
