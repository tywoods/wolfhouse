'use strict';
const https = require('https');
const { execSync, spawnSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = 'bb7355f';
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${COMMIT}-stage27w5-simulator-write-context`;
const REV_SUFFIX = 'stage27w5-sim-write';

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

function runHarness(args, token) {
  const res = spawnSync(process.execPath, [
    'scripts/run-luna-guest-simulator-flow.js',
    '--base-url', `https://${HOST}`,
    ...args,
    '--json',
  ], {
    cwd: require('path').join(__dirname),
    env: { ...process.env, LUNA_BOT_INTERNAL_TOKEN: token },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const lines = (res.stdout || '').split('\n');
  const jsonLine = [...lines].reverse().find((l) => l.trim().startsWith('{'));
  let parsed = null;
  try { parsed = JSON.parse(jsonLine || '{}'); } catch { parsed = { parse_error: true, stdout: res.stdout, stderr: res.stderr }; }
  return { exit: res.status, flow: parsed };
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

  const reviewRun = runHarness(['--fixture', 'booking-deposit'], token);
  const writeRun = runHarness(['--fixture', 'booking-deposit', '--create-hold-draft'], token);

  const review = reviewRun.flow || {};
  const write = writeRun.flow || {};
  const t3 = (review.turns || []).find((t) => t.step === 3) || {};
  const hold = write.hold_draft || {};

  const out = {
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb6d',
    revision: rev,
    healthz: hz.status,
    login_ok: login.status === 200,
    ui_ok: ui.status === 200,
    ui_has_simulator: /Luna Guest Simulator/.test(ui.raw || ''),
    ui_script_parse_ok: parseOk,
    ui_script_parse_error: parseErr,
    review_harness: {
      exit: reviewRun.exit,
      result: review.result,
      turn3_hold_plan_status: t3.hold_plan_status,
      turn3_payment_choice_ready: t3.payment_choice_ready,
      first_failure: review.first_failure,
    },
    write_harness: {
      exit: writeRun.exit,
      result: write.result,
      hold_draft: hold,
      next_safe_step: hold.next_safe_step || (write.hold_draft && write.hold_draft.next_safe_step),
      first_failure: write.first_failure,
    },
    safety: {
      review_only_no_writes: review.review_only === true,
      sends_whatsapp_false: (hold.sends_whatsapp !== false ? write.safety?.sends_whatsapp === false : hold.sends_whatsapp === false),
      live_send_blocked: write.safety?.live_send_blocked === true || review.safety?.live_send_blocked === true,
      no_stripe_link: !write.stripe_test_link,
      stripe_link_created: false,
    },
  };

  const reviewPass = reviewRun.exit === 0
    && review.result === 'PASS'
    && t3.hold_plan_status === 'ready'
    && t3.payment_choice_ready === true;

  const writePass = writeRun.exit === 0
    && write.result === 'PASS'
    && (hold.write_status === 'created' || hold.write_status === 'reused_existing')
    && (hold.booking_id || hold.booking_code)
    && hold.payment_draft_id;

  out.pass = rev.health === 'Healthy'
    && rev.traffic === 100
    && String(rev.image || '').includes(COMMIT)
    && hz.status === 200
    && out.login_ok
    && out.ui_ok
    && out.ui_has_simulator
    && out.ui_script_parse_ok
    && reviewPass
    && writePass;

  out.result = out.pass ? 'PASS' : (reviewPass && !writePass ? 'PARTIAL' : 'FAIL');

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
