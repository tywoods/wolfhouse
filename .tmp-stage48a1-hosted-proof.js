'use strict';
/** Stage 48a.1 — deploy package-info fix + hosted dry-run proof. Temp — do not commit. */

const crypto = require('crypto');
const https = require('https');
const { execSync } = require('child_process');

const COMMIT = '558a3db';
const IMAGE_TAG = `${COMMIT}-stage48a-package-info`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's48a-package-info';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const BASE_URL = `https://${STAFF_HOST}`;
const CLIENT = 'wolfhouse-somo';
const REVIEW_ROUTE = '/staff/bot/guest-inbound-review-dry-run';

const ENV_EXPECT = {
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'false',
  OPEN_DEMO_BOOKING_WRITES_ENABLED: 'true',
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED: 'true',
  LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST: null,
};

const TRANSCRIPT = [
  'Oh hello',
  'lets book a stay',
  'June 12-22',
  '3',
  'tell me more about the packages',
];

const HANDOFF_RE = /looping in our Wolfhouse team|passing this to our team|hand off|handoff|staff will follow up/i;
const EXPLAIN_ASK_RE = /want me to explain them quickly|do you already know which one you prefer/i;
const WELCOME_RE = /book a stay|checking some info/i;
const STRIPE_RE = /stripe link|checkout\.stripe/i;

const cmd = process.argv[2] || 'all';

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

function sleep(ms) {
  execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' });
}

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
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: buf });
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
    if (!e) out[n] = null;
    else if (e.secretRef) out[n] = { secretRef: e.secretRef };
    else out[n] = e.value;
  }
  return out;
}

function healthz() {
  return execSync(`curl.exe -s -o NUL -w "%{http_code}" ${BASE_URL}/healthz`, { encoding: 'utf8' }).trim();
}

function resolveBotToken() {
  try {
    return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
  } catch {
    return '';
  }
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
    '-o none',
  ].join(' '));
  for (let i = 0; i < 60; i++) {
    const rev = activeRevision();
    const hz = healthz();
    console.error(`[deploy] wait ${i + 1}/60 rev=${rev.name} health=${rev.health} hz=${hz}`);
    if (String(rev.image || '').includes(COMMIT) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200') {
      return rev;
    }
    sleep(10000);
  }
  throw new Error('deploy did not become healthy in time');
}

function buildReviewPayload(phone, message, guestContext, turnIndex) {
  return {
    source: 'stage48a1_hosted_proof',
    client_slug: CLIENT,
    channel: 'whatsapp',
    guest_phone: phone,
    contact_name: 'Stage48a1 Guest',
    message_text: message,
    reference_date: '2026-06-11',
    received_at: new Date().toISOString(),
    inbound_message_id: `stage48a1-${crypto.randomBytes(6).toString('hex')}-t${turnIndex + 1}`,
    automation_gate_context: {
      public_guest_automation_enabled: false,
      whatsapp_dry_run: true,
      live_send_allowed: false,
    },
    ...(guestContext ? { guest_context: guestContext } : {}),
  };
}

async function runDryRunTurn(token, phone, message, guestContext, turnIndex) {
  const headers = token ? { 'X-Luna-Bot-Token': token } : {};
  const res = await httpsJson('POST', REVIEW_ROUTE, buildReviewPayload(phone, message, guestContext, turnIndex), headers);
  const body = res.body || {};
  const review = body.review || {};
  const r = review.result || {};
  const fields = r.extracted_fields || {};
  const plan = review.hold_payment_draft_plan || body.hold_payment_draft_plan || {};
  const reply = String(review.proposed_luna_reply || body.proposed_luna_reply || '');
  return {
    http_status: res.status,
    success: body.success === true,
    message,
    reply,
    handoff: HANDOFF_RE.test(reply) || r.safe_handoff_required === true,
    fields,
    no_write: body.no_write_performed === true,
    sends_whatsapp: body.sends_whatsapp === true,
    creates_booking: body.creates_booking === true,
    creates_stripe_link: body.creates_stripe_link === true,
    write_ready: plan.ready_for_hold_draft === true,
    slim_guest_context: body.slim_guest_context_for_next_turn || null,
  };
}

async function hostedTranscript(token) {
  const phone = `+34600${crypto.randomBytes(4).toString('hex').slice(0, 7).replace(/[^0-9]/g, '0').slice(0, 7)}`;
  const turns = [];
  let ctx = null;
  for (let i = 0; i < TRANSCRIPT.length; i++) {
    const t = await runDryRunTurn(token, phone, TRANSCRIPT[i], ctx, i);
    turns.push(t);
    ctx = t.slim_guest_context;
  }
  return { phone, turns };
}

function envMatches(actual) {
  const checks = {};
  for (const [k, expected] of Object.entries(ENV_EXPECT)) {
    const v = actual[k];
    if (expected === null) checks[k] = v == null || v === '' || (typeof v === 'object' && !v.value);
    else checks[k] = v === expected;
  }
  return checks;
}

async function main() {
  const out = {
    phase: 'stage48a1-hosted-proof',
    commit: COMMIT,
    image: IMAGE,
    revision: null,
    healthz: null,
    env: null,
    env_checks: null,
    transcript: null,
    checks: {},
    result: 'FAIL',
  };

  if (cmd === 'deploy' || cmd === 'all') {
    out.revision = deploy();
    out.healthz = healthz();
  } else {
    out.revision = activeRevision();
    out.healthz = healthz();
  }

  out.env = envPick();
  out.env_checks = envMatches(out.env);

  const token = resolveBotToken();
  out.transcript = await hostedTranscript(token);
  const turns = out.transcript.turns;
  const last = turns[turns.length - 1];
  const mid = turns.slice(1, 4);

  out.checks = {
    revision_has_commit: String(out.revision.image || '').includes(COMMIT),
    healthz_200: out.healthz === '200',
    revision_healthy: out.revision.health === 'Healthy',
    env_unchanged: Object.values(out.env_checks).every(Boolean),
    turn5_no_handoff: !last.handoff,
    turn5_no_explain_ask: !EXPLAIN_ASK_RE.test(last.reply),
    turn5_has_packages: /malibu/i.test(last.reply) && /uluwatu/i.test(last.reply) && /waimea/i.test(last.reply),
    turn5_next_step: /which one sounds best|want me to check malibu/i.test(last.reply),
    turn5_dates: last.fields.check_in === '2026-06-12' && last.fields.check_out === '2026-06-22',
    turn5_guest_count: last.fields.guest_count === 3,
    turn5_no_write: last.no_write === true && !last.creates_booking && !last.creates_stripe_link && !last.write_ready,
    turn5_no_stripe: !STRIPE_RE.test(last.reply),
    mid_no_welcome_reset: !mid.some((t) => WELCOME_RE.test(t.reply)),
    turn1_welcome_or_greeting: WELCOME_RE.test(turns[0].reply) || /luna from wolfhouse/i.test(turns[0].reply),
  };

  const pass = Object.values(out.checks).every(Boolean);
  out.result = pass ? 'PASS' : 'FAIL';
  console.log(JSON.stringify(out, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
