'use strict';
const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = '98c1b0c';
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${COMMIT}-stage27w-luna-guest-simulator`;

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
}

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: headers.accept || 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers.cookie ? { Cookie: headers.cookie } : {}),
        ...(headers.token ? { 'X-Luna-Bot-Token': headers.token } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

async function waitHealthy(timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rev = activeRevision();
    const hz = await req('GET', '/healthz');
    if (rev.health === 'Healthy' && rev.traffic === 100
        && String(rev.name || '').includes('stage27w-luna-guest-simulator')
        && hz.status === 200) {
      return rev;
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  return activeRevision();
}

(async () => {
  const rev = await waitHealthy();
  const hz = await req('GET', '/healthz');

  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ui = await req('GET', '/staff/ui', null, { cookie, accept: 'text/html' });

  let token = '';
  try {
    token = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
  } catch {
    token = process.env.LUNA_BOT_INTERNAL_TOKEN || '';
  }

  const review = await req('POST', '/staff/bot/guest-automation-review-dry-run', {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    message_text: 'Hi, we are 2 people and want to stay July 10-17',
    language_hint: 'en',
  }, { token });

  const out = {
    commit: COMMIT,
    image: IMAGE,
    revision: rev,
    healthz: hz.status,
    login_ok: login.status === 200,
    ui_has_simulator_tab: /Luna Guest Simulator/.test(ui.raw || ''),
    ui_has_review_route: /guest-automation-review-dry-run/.test(ui.raw || ''),
    ui_has_hold_button: /Create Test Hold \+ Draft Payment/.test(ui.raw || ''),
    review_status: review.status,
    review_dry_run: review.body?.dry_run,
    review_lane: review.body?.review?.message_lane || review.body?.message_lane,
    review_sends_whatsapp: review.body?.sends_whatsapp,
    review_live_blocked: review.body?.live_send_blocked,
  };
  out.pass = out.healthz === 200
    && out.revision.health === 'Healthy'
    && out.revision.traffic === 100
    && String(out.revision.image || '').includes(COMMIT)
    && out.login_ok
    && out.ui_has_simulator_tab
    && out.ui_has_review_route
    && out.review_status === 200
    && out.review_dry_run === true
    && out.review_sends_whatsapp === false
    && out.review_live_blocked === true;

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
