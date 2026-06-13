'use strict';
/** Stage 56p — DE language stickiness + canonical package copy. Temp — do not commit. */

const https = require('https');
const { execSync } = require('child_process');
const { LUNA_GUEST_STAGING_V1 } = require('./scripts/lib/luna-guest-staging-profile');
const { OPEN_DEMO_WHATSAPP_ROUTE } = require('./scripts/lib/open-demo-whatsapp-gate');

const COMMIT = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const IMAGE_TAG = `${COMMIT}-s56p-de-packages1`;
const REV_SUFFIX = 's56p-de-packages1';
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
  return { name: a.name, health: a.properties?.healthState, image: a.properties?.template?.containers?.[0]?.image };
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
async function turn(msg, ctx, i) {
  const wamid = `wamid.s56p-${Date.now()}-${i}`;
  const { json } = await postJson(OPEN_DEMO_WHATSAPP_ROUTE, {
    source: 'n8n_open_demo_whatsapp_harness', client_slug: 'wolfhouse-somo', channel: 'whatsapp',
    phone_number_id: '1152900101233109', guest_phone: GUEST_PHONE, message_text: msg,
    wamid, inbound_message_id: wamid, received_at: new Date().toISOString(), reference_date: '2026-06-12',
    ...(ctx ? { guest_context: ctx } : {}),
  });
  const body = json.body || json;
  const review = body.review || {};
  const result = review.result || {};
  return {
    lang: result.detected_language,
    composer: review.composer_state,
    reply: (review.proposed_luna_reply || '').slice(0, 320),
    next: body.slim_guest_context_for_next_turn,
  };
}
async function smoke() {
  let ctx = null;
  const steps = [
    'Was geht\'s',
    'Ich will buchen',
    'Vom 22.07-29.07',
    'Wir sind zu zweit',
    'Was gibt es für Pakete?',
    'Was ist in den Paketen enthalten?',
    'Uluwatu bitte',
    'Anzahlung',
  ];
  const checks = {};
  for (let i = 0; i < steps.length; i++) {
    const t = await turn(steps[i], ctx, i);
    console.log(JSON.stringify({ i, msg: steps[i], ...t }, null, 2));
    ctx = t.next || ctx;
    if (i === 4) checks.no_yoga = !/yoga|frühstück|breakfast|workshop/i.test(t.reply);
    if (i === 5) checks.no_reask_checkin = !/wann.*einchecken|check-in/i.test(t.reply.toLowerCase());
    if (i === 6) checks.quote_de = /\b(Anzahlung|zahlung|gesamt|€)\b/i.test(t.reply) && !/^Perfect/i.test(t.reply);
    if (i === 7) checks.deposit_de = /\b(Anzahlung|Zahlungslink|reserviert)\b/i.test(t.reply);
  }
  const ok = checks.no_yoga !== false && checks.quote_de && checks.deposit_de;
  console.log(JSON.stringify({ checks, ok }, null, 2));
  if (!ok) process.exit(1);
}
function deploy() {
  console.error(`[deploy] ${IMAGE_TAG}`);
  az(`az acr build --registry whstagingacr --image wh-staff-api:${IMAGE_TAG} --file Dockerfile .`);
  const envArgs = Object.entries(ENV_EXPECT).map(([k, v]) => `${k}=${v}`).join(' ');
  az(`az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG} --revision-suffix ${REV_SUFFIX} --set-env-vars ${envArgs} -o none`);
  for (let i = 0; i < 60; i++) {
    sleep(10000);
    const cur = activeRevision();
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
