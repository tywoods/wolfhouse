'use strict';
/** Stage 46b.2 — deploy vague-booking intake fix + hosted regression proof. Temp — do not commit. */

const crypto = require('crypto');
const https = require('https');
const path = require('path');
const { Client } = require('pg');
const { execSync, spawnSync } = require('child_process');

const COMMIT = '4cc1a34';
const IMAGE_TAG = `${COMMIT}-stage46b-vague-intake`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's46b-vague-intake';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const DEMO_PHONE_ID = '1152900101233109';
const GUEST_PHONE = '+34600995569';
const GUEST_FROM = '34600995569';

const ENV_NAMES = [
  'OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED',
  'WHATSAPP_DRY_RUN',
  'OPEN_DEMO_BOOKING_WRITES_ENABLED',
  'OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED',
  'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST',
  'OPEN_DEMO_WHATSAPP_ENABLED',
  'LUNA_OPEN_PHONE_TESTING',
];

const VERIFIERS = [
  'verify:stage46b-vague-booking-intake',
  'verify:stage45i-payment-choice-declines-addons',
  'verify:stage45g-open-phone-metadata-persist',
  'verify:stage45b-luna-open-phone-testing',
  'verify:stage42a-cami-behavior-realism',
  'verify:stage32-addons-services-mid-booking',
  'verify:stage43c-staff-manual-booking-ui-payload',
];

const TURN_MESSAGES = [
  'Hello',
  'Book a stay',
  'June 12 to 20th',
  '3 please',
];

const HANDOFF_RE = /looping in|passing this to our team|hand off|handoff|follow up soon/i;
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

function runVerifier(script) {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
    cwd: path.join(__dirname),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    shell: true,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+) passed, (\d+) failed/) || out.match(/PASS — (\d+) passed/);
  return {
    script,
    exit: r.status,
    ok: r.status === 0,
    summary: m ? m[0] : (r.status === 0 ? 'PASS' : 'FAIL'),
  };
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

function envPick(names) {
  const app = JSON.parse(az('az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const env = app.properties.template.containers[0].env || [];
  const out = {};
  for (const n of names) {
    const e = env.find((x) => x.name === n);
    if (!e) out[n] = null;
    else if (e.secretRef) out[n] = { secretRef: e.secretRef };
    else out[n] = e.value;
  }
  return out;
}

function healthz() {
  return execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${STAFF_HOST}/healthz`, { encoding: 'utf8' }).trim();
}

function buildMetaPayload(fromDigits, wamid, messageText, contactName) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: DEMO_PHONE_ID },
          contacts: [{ profile: { name: contactName || 'Stage46b Guest' } }],
          messages: [{
            from: fromDigits,
            id: wamid,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'text',
            text: { body: messageText },
          }],
        },
        field: 'messages',
      }],
    }],
  };
}

function deploy() {
  if (process.env.SKIP_DEPLOY === '1') {
    console.error('[deploy] SKIP_DEPLOY=1');
    return activeRevision();
  }
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
  for (let i = 0; i < 45; i++) {
    const rev = activeRevision();
    const hz = healthz();
    console.error(`[deploy] wait ${i + 1}/45 rev=${rev.name} health=${rev.health} hz=${hz}`);
    if (String(rev.image || '').includes(COMMIT) && rev.health === 'Healthy' && rev.traffic === 100 && hz === '200') {
      return rev;
    }
    execSync('powershell -Command "Start-Sleep -Seconds 10"', { stdio: 'ignore' });
  }
  throw new Error('deploy did not become healthy in time');
}

async function runProof(revision, env) {
  const out = {
    phase: 'stage46b2-hosted-regression',
    commit: COMMIT,
    image: IMAGE,
    revision,
    env,
    live_mode: {
      OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED: env.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED,
      WHATSAPP_DRY_RUN: env.WHATSAPP_DRY_RUN,
    },
    turns: [],
    transcript: [],
    live_sends: [],
    checks: {},
    result: 'FAIL',
  };

  const proofStart = new Date().toISOString();
  for (let i = 0; i < TURN_MESSAGES.length; i++) {
    const wamid = `wamid.46b2-${Date.now()}-t${i + 1}-${crypto.randomBytes(6).toString('hex')}`;
    const payload = buildMetaPayload(GUEST_FROM, wamid, TURN_MESSAGES[i], 'Stage46b Regression');
    console.error(`[turn ${i + 1}] ${TURN_MESSAGES[i]}`);
    const resp = await httpsJson('POST', '/staff/meta/whatsapp/webhook', payload);
    const body = resp.body || {};
    const draft = body.draft || {};
    const sendResult = body.send_result || {};
    const review = body.open_demo?.review || body.review || {};
    const result = review.result || body.result || {};
    const fields = result.extracted_fields || review.extracted_fields || {};
    const bw = body.booking_write_preview || body.booking_write || {};
    const reply = String(draft.suggested_reply || body.suggested_reply || sendResult.message_text || '').slice(0, 600);
    out.turns.push({
      turn: i + 1,
      message: TURN_MESSAGES[i],
      http_status: resp.status,
      reply,
      handoff_reply: HANDOFF_RE.test(reply),
      safe_handoff: result.safe_handoff_required === true,
      intake_state: result.intake_state,
      guest_count: fields.guest_count,
      check_in: fields.check_in,
      check_out: fields.check_out,
      package_interest: fields.package_interest,
      whatsapp_sent: sendResult.send_performed === true || body.whatsapp_sent === true,
      write_status: bw.write_status,
      booking_code: bw.booking_code,
      stripe_link_created: bw.stripe_link_created === true,
    });
    await new Promise((r) => setTimeout(r, i === TURN_MESSAGES.length - 1 ? 18000 : 12000));
  }

  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  if (!/staging|wolfhouse_staging/i.test(whUrl)) throw new Error('DB guard: not staging URL');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const phoneRaw = GUEST_PHONE.replace(/^\+/, '');
  const msgs = (await pg.query(`
    SELECT m.direction::text, LEFT(m.message_text, 600) AS body, m.created_at::text,
           m.metadata->>'open_phone_testing' AS open_phone_testing,
           m.metadata->>'guest_tester_class' AS guest_tester_class
      FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $4
       AND (c.phone = $1 OR c.phone = $2 OR c.phone = $3)
       AND m.created_at >= $5::timestamptz
     ORDER BY m.created_at ASC`,
    [GUEST_PHONE, phoneRaw, `+${phoneRaw}`, CLIENT, proofStart])).rows;

  out.transcript = msgs.map((m) => ({
    direction: m.direction,
    body: m.body,
    at: m.created_at,
    open_phone_testing: m.open_phone_testing,
    guest_tester_class: m.guest_tester_class,
  }));

  const conv = (await pg.query(`
    SELECT c.id::text, c.phone, c.current_hold_booking_id::text AS booking_id,
           c.metadata->>'open_phone_testing' AS open_phone_testing,
           c.metadata->>'guest_tester_class' AS guest_tester_class
      FROM conversations c
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $4 AND (c.phone = $1 OR c.phone = $2 OR c.phone = $3)
     ORDER BY c.updated_at DESC LIMIT 1`,
    [GUEST_PHONE, phoneRaw, `+${phoneRaw}`, CLIENT])).rows[0];

  const sends = (await pg.query(`
    SELECT idempotency_key, status, to_phone, send_kind, created_at::text, blocked_reasons
      FROM guest_message_sends
     WHERE created_at >= $1::timestamptz
       AND (to_phone = $2 OR to_phone = $3 OR to_phone = $4)
     ORDER BY created_at ASC`,
    [proofStart, GUEST_PHONE, phoneRaw, `+${phoneRaw}`])).rows;
  out.live_sends = sends;

  const bookings = conv?.booking_id
    ? (await pg.query(`
        SELECT b.booking_code, b.status::text, b.created_at::text
          FROM bookings b
         WHERE b.id = $1::uuid AND b.created_at >= $2::timestamptz`,
      [conv.booking_id, proofStart])).rows
    : [];

  const payments = conv?.booking_id
    ? (await pg.query(`
        SELECT p.id::text, p.status::text, p.stripe_checkout_session_id, p.created_at::text
          FROM payments p
         WHERE p.booking_id = $1::uuid AND p.created_at >= $2::timestamptz`,
      [conv.booking_id, proofStart])).rows
    : [];

  const confirmSends = (await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends
      WHERE created_at >= $1::timestamptz
        AND (to_phone = $2 OR to_phone = $3 OR to_phone = $4)
        AND send_kind ILIKE '%confirm%'`,
    [proofStart, GUEST_PHONE, phoneRaw, `+${phoneRaw}`])).rows[0].n;

  await pg.end();

  const t2 = out.turns[1] || {};
  const t3 = out.turns[2] || {};
  const t4 = out.turns[3] || {};
  const outbound = out.transcript.filter((m) => m.direction === 'outbound' || m.direction === 'outgoing');
  const inbound = out.transcript.filter((m) => m.direction === 'inbound' || m.direction === 'incoming');

  out.checks = {
    env_live_replies_on: env.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'true',
    env_dry_run_off: env.WHATSAPP_DRY_RUN === 'false',
    env_booking_writes_on: env.OPEN_DEMO_BOOKING_WRITES_ENABLED === 'true',
    env_stripe_test_on: env.OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED === 'true',
    env_confirm_allowlist_unset: env.LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST == null,
    image_has_commit: String(revision.image || '').includes(COMMIT),
    healthz_200: healthz() === '200',
    t2_asks_dates: /dates|check-in|check-out|when/i.test(t2.reply || ''),
    t3_asks_guest_count_not_name: /how many guests|how many people|guests will be staying/i.test(t3.reply || '')
      && !/your name|grab your name|what name/i.test(t3.reply || ''),
    t4_no_handoff: !t4.handoff_reply && t4.safe_handoff !== true,
    t4_guest_count_3: t4.guest_count === 3,
    t4_asks_package: /surf package|malibu|accommodation/i.test(t4.reply || ''),
    no_booking_created: bookings.length === 0 && !t4.booking_code,
    no_payment_created: payments.length === 0 && !t4.stripe_link_created,
    no_confirmation_sends: confirmSends === 0,
    one_outbound_per_inbound: outbound.length === inbound.length && outbound.length === 4,
    no_duplicate_sends: sends.length === outbound.length,
    open_phone_metadata: conv?.open_phone_testing === 'true' || msgs.some((m) => m.open_phone_testing === 'true'),
  };

  out.result = Object.values(out.checks).every(Boolean) ? 'PASS' : 'FAIL';
  return out;
}

(async () => {
  const report = { commit: COMMIT, image: IMAGE, preflight: {}, deploy: {}, proof: {} };
  try {
    if (cmd === 'preflight' || cmd === 'all') {
      report.preflight.head = az('git rev-parse HEAD');
      report.preflight.verifiers = VERIFIERS.map(runVerifier);
      report.preflight.revision_before = activeRevision();
      report.preflight.healthz = healthz();
      console.log(JSON.stringify({ phase: 'preflight', ...report.preflight }, null, 2));
    }
    if (cmd === 'deploy' || cmd === 'all') {
      report.deploy.revision = deploy();
      report.deploy.healthz = healthz();
      report.deploy.env = envPick(ENV_NAMES);
      console.log(JSON.stringify({ phase: 'deploy', ...report.deploy }, null, 2));
    }
    if (cmd === 'proof' || cmd === 'all') {
      const rev = report.deploy.revision || activeRevision();
      const env = report.deploy.env || envPick(ENV_NAMES);
      report.proof = await runProof(rev, env);
      console.log(JSON.stringify(report.proof, null, 2));
      if (report.proof.result !== 'PASS') process.exit(1);
    }
  } catch (e) {
    console.error(e.stderr || e.stdout || e.message || e);
    process.exit(1);
  }
})();
