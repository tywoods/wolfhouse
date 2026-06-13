'use strict';
/** Stage 56k deploy — date intake + handoff/needs_human sync. Temp — do not commit. */

const https = require('https');
const { execSync } = require('child_process');
const { LUNA_GUEST_STAGING_V1 } = require('./scripts/lib/luna-guest-staging-profile');
const { OPEN_DEMO_WHATSAPP_ROUTE } = require('./scripts/lib/open-demo-whatsapp-gate');
const { isGenuineLunaHandoffReply } = require('./scripts/lib/luna-guest-handoff-persist');

const COMMIT = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const IMAGE_TAG = `${COMMIT}-s56k-intake-handoff1`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's56k-intake-handoff1';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const GUEST_PHONE = '+491726422307';
const ENV_EXPECT = { ...LUNA_GUEST_STAGING_V1 };

const cmd = process.argv[2] || 'deploy';
const HANDOFF_RE = /passing this to our team|looping in our(?:\s+Wolfhouse)?\s+team|connect you with our team/i;

function az(cmdStr) {
  return execSync(cmdStr, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sleep(ms) {
  execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' });
}

function token() {
  return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
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

function healthz() {
  return execSync(`curl.exe -s -o NUL -w "%{http_code}" https://${STAFF_HOST}/healthz`, { encoding: 'utf8' }).trim();
}

function postJson(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: STAFF_HOST,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${token()}`,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, json: { raw } }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildOpenDemoPayload(msg, guestContext, turnIndex) {
  const wamid = `wamid.s56k-${Date.now()}-t${turnIndex}`;
  return {
    source: 'n8n_open_demo_whatsapp_harness',
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    phone_number_id: '1152900101233109',
    guest_phone: GUEST_PHONE,
    guest_email: 'open-demo+491726422307@example.test',
    message_text: msg,
    wamid,
    inbound_message_id: wamid,
    received_at: new Date().toISOString(),
    reference_date: '2026-06-12',
    ...(guestContext ? { guest_context: guestContext } : {}),
  };
}

async function runTurn(msg, guestContext, turnIndex) {
  const payload = buildOpenDemoPayload(msg, guestContext, turnIndex);
  const { status, json } = await postJson(OPEN_DEMO_WHATSAPP_ROUTE, payload);
  const body = json.body || json;
  const review = body.review || {};
  const result = review.result || {};
  return {
    status,
    reply: review.proposed_luna_reply || '',
    lane: result.message_lane,
    handoff: result.safe_handoff_required === true,
    fields: result.extracted_fields || {},
    nextContext: body.slim_guest_context_for_next_turn || null,
  };
}

async function smoke() {
  console.log('\n=== Stage 56k smoke — date intake + no basic handoff ===\n');
  const report = { turns: [], checks: {} };
  let ctx = null;

  let t = await runTurn('I would like to book from Sept 1st to the 15th', ctx, 0);
  report.turns.push({ msg: 'dates range', lane: t.lane, handoff: t.handoff, fields: t.fields, reply: t.reply.slice(0, 160) });
  report.checks.dates_parsed = t.fields.check_in === '2026-09-01' && t.fields.check_out === '2026-09-15';
  ctx = t.nextContext || ctx;

  t = await runTurn('We are 2 people', ctx, 1);
  report.turns.push({ msg: '2 people', lane: t.lane, handoff: t.handoff, fields: t.fields, reply: t.reply.slice(0, 160) });
  report.checks.no_handoff_turn2 = !t.handoff && !HANDOFF_RE.test(t.reply);
  ctx = t.nextContext || ctx;

  // Simulate partial-parse recovery: check_out missing, guest answers day-only checkout.
  const partialCtx = {
    ...(ctx || {}),
    intake_state: 'collecting_required_details',
    message_lane: 'new_booking_inquiry',
    extracted_fields: {
      check_in: '2026-09-01',
      guest_count: 2,
      check_out: null,
    },
    check_in: '2026-09-01',
    guest_count: 2,
    check_out: null,
  };
  t = await runTurn('15th', partialCtx, 2);
  report.turns.push({ msg: '15th checkout', lane: t.lane, handoff: t.handoff, fields: t.fields, reply: t.reply.slice(0, 160) });
  report.checks.day_only_checkout = t.fields.check_out === '2026-09-15';
  report.checks.no_handoff_turn3 = !t.handoff && !HANDOFF_RE.test(t.reply);
  report.checks.handoff_regex = isGenuineLunaHandoffReply(
    "Thanks for your patience — I'm looping in our Wolfhouse team so they can help with the next step",
  );

  report.ok = report.checks.dates_parsed
    && report.checks.no_handoff_turn2
    && report.checks.day_only_checkout
    && report.checks.no_handoff_turn3
    && report.checks.handoff_regex;

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

function deploy() {
  console.error(`[deploy] commit=${COMMIT} image=${IMAGE}`);
  console.error('[deploy] acr build...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  const envArgs = Object.entries(ENV_EXPECT).map(([k, v]) => `${k}=${v}`).join(' ');
  console.error('[deploy] containerapp update...');
  az(`az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image ${IMAGE} --revision-suffix ${REV_SUFFIX} --set-env-vars ${envArgs} -o none`);

  for (let i = 0; i < 60; i++) {
    sleep(10000);
    const cur = activeRevision();
    const hz = healthz();
    console.error(`[deploy] wait ${i + 1}/60 rev=${cur.name} health=${cur.health} hz=${hz}`);
    if (String(cur.image || '').includes(IMAGE_TAG) && cur.health === 'Healthy' && cur.traffic === 100 && hz === '200') {
      console.log(JSON.stringify({ ok: true, revision: cur, commit: COMMIT, image: IMAGE }, null, 2));
      return;
    }
  }
  console.error('Deploy timeout');
  process.exit(1);
}

if (cmd === 'smoke') {
  smoke().catch((e) => { console.error(e); process.exit(1); });
} else if (cmd === 'deploy-and-smoke') {
  deploy();
  sleep(5000);
  smoke().catch((e) => { console.error(e); process.exit(1); });
} else {
  deploy();
}
