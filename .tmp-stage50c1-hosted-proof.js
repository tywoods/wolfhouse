'use strict';
/** Stage 50c.1 — deploy GPT tool planner + greeting-safe Cami author. Temp — do not commit. */

const crypto = require('crypto');
const https = require('https');
const { execSync } = require('child_process');

const COMMIT = '35bdab2';
const IMAGE_TAG = `${COMMIT}-stage50c1-planner-cami`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's50c1-planner-cami';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const REVIEW_ROUTE = '/staff/bot/guest-inbound-review-dry-run';

const ENV_EXPECT = {
  LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED: 'true',
  LUNA_GUEST_GPT_TOOL_PLANNER_ENABLED: 'true',
  LUNA_GUEST_GPT_TOOL_PLANNER_ACTIVE: 'true',
  LUNA_GUEST_AGENT_BRAIN_ENABLED: 'true',
};

const cmd = process.argv[2] || 'status';

function az(cmdStr, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      return execSync(cmdStr, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      last = err;
      if (i < retries - 1) execSync('powershell -Command "Start-Sleep -Seconds 2"', { stdio: 'ignore' });
    }
  }
  throw last;
}

function sleep(ms) { execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' }); }

function httpsJson(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: STAFF_HOST, path: reqPath, method,
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
        resolve({ status: res.statusCode, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
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

function resolveBotToken() {
  try {
    return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
  } catch { return ''; }
}

function deploy() {
  const head = az('git rev-parse --short HEAD');
  if (!head.startsWith(COMMIT)) throw new Error(`HEAD is ${head}, expected ${COMMIT}`);
  console.error(`[deploy] acr build ${IMAGE_TAG}...`);
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  console.error('[deploy] containerapp update...');
  az([
    'az containerapp update',
    '--name wh-staging-staff-api',
    '--resource-group wh-staging-rg',
    `--image ${IMAGE}`,
    `--revision-suffix ${REV_SUFFIX}`,
    '--set-env-vars',
    'LUNA_GUEST_CAMI_REPLY_AUTHOR_ENABLED=true',
    'LUNA_GUEST_GPT_TOOL_PLANNER_ENABLED=true',
    'LUNA_GUEST_GPT_TOOL_PLANNER_ACTIVE=true',
    '-o none',
  ].join(' '));
  for (let i = 0; i < 60; i++) {
    const rev = activeRevision();
    const hz = healthz();
    const env = envPick();
    console.error(`[deploy] wait ${i + 1}/60 rev=${rev.name} hz=${hz} planner=${env.LUNA_GUEST_GPT_TOOL_PLANNER_ACTIVE}`);
    const envOk = Object.entries(ENV_EXPECT).every(([k, v]) => env[k] === v);
    if (String(rev.image || '').includes(COMMIT) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200' && envOk) return rev;
    sleep(10000);
  }
  throw new Error('deploy did not become healthy in time');
}

async function dryRunProof() {
  const token = resolveBotToken();
  const phone = `+34604${String(Date.now()).slice(-6)}`;
  const headers = token ? { 'X-Luna-Bot-Token': token } : {};

  async function turn(message, ctx, idx) {
    const payload = {
      source: 'stage50c1_hosted_proof',
      client_slug: CLIENT,
      channel: 'whatsapp',
      guest_phone: phone,
      contact_name: 'Stage50c1 Guest',
      message_text: message,
      reference_date: '2026-06-11',
      received_at: new Date().toISOString(),
      inbound_message_id: `stage50c1-${crypto.randomBytes(6).toString('hex')}-t${idx}`,
      automation_gate_context: { public_guest_automation_enabled: false, whatsapp_dry_run: true, live_send_allowed: false },
      ...(ctx ? { guest_context: ctx } : {}),
    };
    const res = await httpsJson('POST', REVIEW_ROUTE, payload, headers);
    const body = res.body || {};
    const review = body.review || {};
    const r = review.result || {};
    return {
      message,
      reply: String(review.proposed_luna_reply || ''),
      cami: r.cami_reply_author || {},
      planner: r.guest_gpt_tool_planner || {},
      fields: r.extracted_fields || {},
      ctx: body.slim_guest_context_for_next_turn || null,
    };
  }

  const t1 = await turn('hello!', null, 1);
  const t2 = await turn('June 19-29 for 3 of us, waimea please', t1.ctx, 2);

  const checks = {
    greeting_no_package_dump: !/malibu|uluwatu|waimea|€\s*249|€\s*349|€\s*499/i.test(t1.reply),
    greeting_book_or_info: /book a stay|info/i.test(t1.reply),
    greeting_skip_cami: t1.cami.cami_author_used !== true,
    multi_field_dates: t2.fields.check_in === '2026-06-19' && t2.fields.check_out === '2026-06-29',
    multi_field_count: t2.fields.guest_count === 3,
    multi_field_package: String(t2.fields.package_interest || t2.fields.package_code || '').toLowerCase() === 'waimea',
    planner_observed: t2.planner.gpt_tool_planner_enabled === true && t2.planner.gpt_tool_planner_used === true,
  };

  return {
    phase: 'stage50c1-dryrun',
    revision: activeRevision(),
    healthz: healthz(),
    env: envPick(),
    phone,
    turns: [
      { message: t1.message, reply_preview: t1.reply.slice(0, 500), cami: t1.cami, fields: t1.fields },
      { message: t2.message, reply_preview: t2.reply.slice(0, 500), planner: t2.planner, fields: t2.fields },
    ],
    checks,
    result: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
  };
}

async function main() {
  if (cmd === 'deploy') {
    const rev = deploy();
    console.log(JSON.stringify({ phase: 'deploy', revision: rev, healthz: healthz(), env: envPick() }, null, 2));
    return;
  }
  if (cmd === 'dryrun') {
    console.log(JSON.stringify(await dryRunProof(), null, 2));
    return;
  }
  if (cmd === 'all') {
    deploy();
    await new Promise((r) => setTimeout(r, 5000));
    console.log(JSON.stringify(await dryRunProof(), null, 2));
    return;
  }
  console.log(JSON.stringify({ phase: 'status', revision: activeRevision(), healthz: healthz(), env: envPick() }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
