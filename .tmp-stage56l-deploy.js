'use strict';
/** Stage 56l deploy — payment choice preservation + multi-answer intake. Temp — do not commit. */

const https = require('https');
const { execSync } = require('child_process');
const { LUNA_GUEST_STAGING_V1 } = require('./scripts/lib/luna-guest-staging-profile');
const { OPEN_DEMO_WHATSAPP_ROUTE } = require('./scripts/lib/open-demo-whatsapp-gate');

const COMMIT = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const IMAGE_TAG = `${COMMIT}-s56l-payment-preserve3`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's56l-payment-preserve3';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const GUEST_PHONE = '+491726422307';
const ENV_EXPECT = { ...LUNA_GUEST_STAGING_V1 };

const cmd = process.argv[2] || 'deploy';

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

async function runTurn(msg, ctx, i, flags = {}) {
  const wamid = `wamid.s56l-${Date.now()}-t${i}`;
  const payload = {
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
    ...(ctx ? { guest_context: ctx } : {}),
    ...(flags.hold ? { create_demo_hold_draft_confirmed: true } : {}),
    ...(flags.bed ? { assign_demo_bed_confirmed: true } : {}),
    ...(flags.stripe ? { create_stripe_test_link_confirmed: true } : {}),
    ...(flags.live ? { send_live_reply_confirmed: true } : {}),
  };
  const { json } = await postJson(OPEN_DEMO_WHATSAPP_ROUTE, payload);
  const body = json.body || json;
  const review = body.review || {};
  const result = review.result || {};
  const pc = review.payment_choice || {};
  const plan = review.hold_payment_draft_plan || {};
  return {
    composer: review.composer_state,
    pc: pc.payment_choice,
    pcReady: pc.payment_choice_ready,
    reasons: pc.payment_choice_reasons,
    planKind: plan.payment_kind,
    planCents: plan.payment_amount_cents,
    handoff: result.safe_handoff_required,
    reply: (review.proposed_luna_reply || '').slice(0, 240),
    next: body.slim_guest_context_for_next_turn,
  };
}

async function smoke() {
  console.log('\n=== Stage 56l smoke — payment preserve + multi-answer ===\n');
  const checks = {};
  let ctx = null;

  let t = await runTurn('I would like to book from Sept 1st to the 15th for 2 people', ctx, 0);
  ctx = t.next || ctx;

  t = await runTurn('Malibu please', ctx, 1);
  ctx = t.next || ctx;

  t = await runTurn('Deposit and yes transfer to and from Santander', ctx, 2);
  checks.deposit_captured = t.pc === 'deposit' && t.pcReady === true;
  checks.plan_deposit = t.planKind === 'deposit' && t.planCents === 10000;
  ctx = t.next || ctx;

  t = await runTurn('Arrive day of checkin at noon and leave day of checkout at noon also', ctx, 3);
  checks.deposit_preserved_after_times = t.pc === 'deposit' && t.pcReady === true;
  checks.no_reask_deposit = !/deposit or (?:the )?full|pay the full/i.test(t.reply);
  ctx = t.next || ctx;

  t = await runTurn('Yes please send the link', ctx, 4, { hold: true, bed: true, stripe: true });
  checks.link_turn_deposit_ready = t.pc === 'deposit' && t.pcReady === true;
  checks.plan_still_deposit = t.planKind === 'deposit' && t.planCents === 10000;
  ctx = t.next || ctx;

  const report = { checks, turns: 4, ok: false };
  report.ok = checks.deposit_captured
    && checks.plan_deposit
    && checks.deposit_preserved_after_times
    && checks.no_reask_deposit
    && checks.link_turn_deposit_ready
    && checks.plan_still_deposit;

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
