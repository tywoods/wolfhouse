'use strict';
/** Stage 56o — handoff opt-in policy. Temp — do not commit. */

const https = require('https');
const { execSync } = require('child_process');
const { LUNA_GUEST_STAGING_V1 } = require('./scripts/lib/luna-guest-staging-profile');
const { OPEN_DEMO_WHATSAPP_ROUTE } = require('./scripts/lib/open-demo-whatsapp-gate');

const COMMIT = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const IMAGE_TAG = `${COMMIT}-s56o-handoff-optin1`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;
const REV_SUFFIX = 's56o-handoff-optin1';
const STAFF_HOST = 'staff-staging.lunafrontdesk.com';
const GUEST_PHONE = '+4915165139289';
const ENV_EXPECT = { ...LUNA_GUEST_STAGING_V1 };
const cmd = process.argv[2] || 'deploy';

function az(s) { return execSync(s, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function sleep(ms) { execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' }); }
function token() { return az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv'); }
function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((r) => r.properties.trafficWeight === 100) || {};
  return { name: a.name, health: a.properties?.healthState, traffic: a.properties?.trafficWeight, image: a.properties?.template?.containers?.[0]?.image };
}
function postJson(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: STAFF_HOST, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${token()}` },
    }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => { try { resolve({ json: JSON.parse(raw) }); } catch { resolve({ json: { raw } }); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function runTurn(msg) {
  const wamid = `wamid.s56o-${Date.now()}`;
  const { json } = await postJson(OPEN_DEMO_WHATSAPP_ROUTE, {
    source: 'n8n_open_demo_whatsapp_harness', client_slug: 'wolfhouse-somo', channel: 'whatsapp',
    phone_number_id: '1152900101233109', guest_phone: GUEST_PHONE, message_text: msg,
    wamid, inbound_message_id: wamid, received_at: new Date().toISOString(), reference_date: '2026-06-12',
  });
  const body = json.body || json;
  const review = body.review || {};
  const result = review.result || {};
  return {
    handoff: result.safe_handoff_required,
    greeting: result.greeting_only,
    lang: result.detected_language,
    reply: (review.proposed_luna_reply || '').slice(0, 240),
    paused: /Luna is paused|team is helping/i.test(review.proposed_luna_reply || ''),
  };
}

async function smoke() {
  const tests = ['Hey was geht?', 'asdkjfh qwerty', 'mit jemandem sprechen bitte'];
  const checks = {};
  for (const msg of tests) {
    const t = await runTurn(msg);
    console.log(JSON.stringify({ msg, ...t }, null, 2));
    if (msg === 'Hey was geht?') {
      checks.de_greeting = !t.handoff && !t.paused && !/looping in our/i.test(t.reply);
    }
    if (msg === 'asdkjfh qwerty') {
      checks.gibberish_no_handoff = !t.handoff && !/looping in our/i.test(t.reply);
    }
    if (msg === 'mit jemandem sprechen bitte') {
      checks.human_request_ok = t.handoff === true || /team|human|someone/i.test(t.reply);
    }
  }
  const ok = checks.de_greeting && checks.gibberish_no_handoff;
  console.log(JSON.stringify({ checks, ok }, null, 2));
  if (!ok) process.exit(1);
}

function deploy() {
  console.error(`[deploy] ${IMAGE}`);
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  const envArgs = Object.entries(ENV_EXPECT).map(([k, v]) => `${k}=${v}`).join(' ');
  az(`az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image ${IMAGE} --revision-suffix ${REV_SUFFIX} --set-env-vars ${envArgs} -o none`);
  for (let i = 0; i < 60; i++) {
    sleep(10000);
    const cur = activeRevision();
    console.error(`[deploy] ${i + 1}/60 rev=${cur.name} health=${cur.health}`);
    if (String(cur.image || '').includes(IMAGE_TAG) && cur.health === 'Healthy' && cur.traffic === 100) {
      console.log(JSON.stringify({ ok: true, revision: cur }, null, 2));
      return;
    }
  }
  process.exit(1);
}

if (cmd === 'smoke') smoke().catch((e) => { console.error(e); process.exit(1); });
else if (cmd === 'deploy-and-smoke') { deploy(); sleep(5000); smoke().catch((e) => { console.error(e); process.exit(1); }); }
else deploy();
