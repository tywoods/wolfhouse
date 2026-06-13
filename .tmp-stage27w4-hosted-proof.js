'use strict';
const https = require('https');
const { execSync, spawnSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = '46d12ca';
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${COMMIT}-stage27w4-payment-plan-context`;
const REV_SUFFIX = 'stage27w4-payment-plan-context';

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

async function waitHealthy(timeoutMs = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rev = activeRevision();
    const hz = await req('GET', '/healthz');
    if (rev.health === 'Healthy' && rev.traffic === 100
        && String(rev.name || '').includes(REV_SUFFIX)
        && String(rev.image || '').includes(COMMIT)
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
  const scripts = [...ui.raw.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((x) => x[1]);
  const main = scripts[scripts.length - 1];
  let parseOk = false;
  let parseErr = null;
  try { new Function(main); parseOk = true; } catch (e) { parseErr = e.message; }

  let token = '';
  try {
    token = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
  } catch {
    token = process.env.LUNA_BOT_INTERNAL_TOKEN || '';
  }

  const harness = spawnSync(process.execPath, [
    'scripts/run-luna-guest-simulator-flow.js',
    '--base-url', `https://${HOST}`,
    '--fixture', 'booking-deposit',
    '--json',
  ], {
    cwd: require('path').join(__dirname),
    env: { ...process.env, LUNA_BOT_INTERNAL_TOKEN: token },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  let flow = null;
  try {
    flow = JSON.parse(harness.stdout || '{}');
  } catch {
    flow = { parse_error: true, stdout: harness.stdout, stderr: harness.stderr };
  }

  const t3 = (flow.turns || []).find((t) => t.step === 3) || {};
  const plan = {
    plan_status: t3.hold_plan_status,
    would_create_hold: t3.hold_plan_status === 'ready',
  };

  const out = {
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb6c',
    revision: rev,
    healthz: hz.status,
    login_ok: login.status === 200,
    ui_ok: ui.status === 200,
    ui_has_simulator: /Luna Guest Simulator/.test(ui.raw || ''),
    ui_script_parse_ok: parseOk,
    ui_script_parse_error: parseErr,
    harness_exit: harness.status,
    harness_result: flow.result,
    turn1: (flow.turns || []).find((t) => t.step === 1),
    turn2: (flow.turns || []).find((t) => t.step === 2),
    turn3: t3,
    turn3_payment_choice_ready: t3.payment_choice_ready,
    turn3_plan_status: t3.hold_plan_status,
    turn3_would_create_hold: flow.turns && flow.turns[2] && flow.turns[2].hold_plan_status === 'ready',
    dry_run: flow.review_only,
    safety: flow.safety,
    first_failure: flow.first_failure,
  };

  out.pass = out.revision.health === 'Healthy'
    && out.revision.traffic === 100
    && String(out.revision.image || '').includes(COMMIT)
    && out.healthz === 200
    && out.login_ok
    && out.ui_ok
    && out.ui_has_simulator
    && out.ui_script_parse_ok
    && out.harness_exit === 0
    && out.harness_result === 'PASS'
    && out.turn1 && out.turn1.expect_pass
    && out.turn2 && out.turn2.expect_pass
    && out.turn3 && out.turn3.expect_pass
    && out.turn3.payment_choice_ready === true
    && out.turn3.payment_choice === 'deposit'
    && out.turn3.next_safe_step === 'ready_for_hold_payment_draft'
    && out.turn3.hold_plan_status === 'ready';

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
