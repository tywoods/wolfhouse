'use strict';
/** Stage 27test-k — deploy proof. Temp — do not commit. */
const https = require('https');
const { execSync, spawnSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = 'ab2e658';
const IMAGE_TAG = `${COMMIT}-stage27test-k-handoff-eval`;
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${IMAGE_TAG}`;

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
}

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
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

function stagingEnvFlags() {
  const env = JSON.parse(az(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg --query properties.template.containers[0].env -o json',
  ));
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    if (!row) return '(unset)';
    return row.value != null ? row.value : `(secret:${row.secretRef})`;
  };
  return {
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_AUTO_SEND_ENABLED: pick('LUNA_AUTO_SEND_ENABLED'),
    PUBLIC_GUEST_AUTOMATION_ENABLED: pick('PUBLIC_GUEST_AUTOMATION_ENABLED'),
  };
}

async function waitHealthy(timeoutMs = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rev = activeRevision();
    const hz = await req('GET', '/healthz');
    if (rev.health === 'Healthy'
        && rev.traffic === 100
        && String(rev.image || '').includes(COMMIT)
        && hz.status === 200) {
      return { rev, hz };
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  const rev = activeRevision();
  const hz = await req('GET', '/healthz');
  return { rev, hz };
}

function parseBatch(out) {
  const passMatch = out.match(/Passed:\s*(\d+)/);
  const partialMatch = out.match(/Partial:\s*(\d+)/);
  const failMatch = out.match(/Failed:\s*(\d+)/);
  const resultMatch = out.match(/Batch result:\s*(PASS|PARTIAL|FAIL)/);
  const failures = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(FAIL|PARTIAL)\s+(flow-[^\s]+)/);
    if (m) failures.push({ status: m[1], id: m[2] });
  }
  return {
    result: resultMatch ? resultMatch[1] : null,
    passed: passMatch ? Number(passMatch[1]) : null,
    partial: partialMatch ? Number(partialMatch[1]) : null,
    failed: failMatch ? Number(failMatch[1]) : null,
    failures,
  };
}

function parseGolden(out) {
  const passMatch = out.match(/Passed:\s*(\d+)/);
  const failMatch = out.match(/Failed:\s*(\d+)/);
  const totalMatch = out.match(/Total:\s*(\d+)/);
  const resultMatch = out.match(/(PASS|FAIL)\s+—\s+golden runner/i);
  const failures = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^FAIL\s+\[([^\]]+)\]/);
    if (m) failures.push(m[1]);
  }
  return {
    result: resultMatch ? resultMatch[1].toUpperCase() : null,
    passed: passMatch ? Number(passMatch[1]) : null,
    failed: failMatch ? Number(failMatch[1]) : null,
    total: totalMatch ? Number(totalMatch[1]) : null,
    failures: failures.slice(0, 10),
  };
}

(async () => {
  const envFlags = stagingEnvFlags();
  const { rev, hz } = await waitHealthy();

  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const ui = await req('GET', '/staff/ui', null, { cookie, accept: 'text/html' });
  const html = ui.raw || '';

  let token = '';
  try {
    token = az('az containerapp secret show --name wh-staging-staff-api --resource-group wh-staging-rg --secret-name luna-bot-internal-token --query value -o tsv');
  } catch {
    token = process.env.LUNA_BOT_INTERNAL_TOKEN || '';
  }

  const probe = await req('POST', '/staff/bot/guest-automation-review-dry-run', {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    message_text: 'What are the packages?',
    language_hint: 'en',
    dry_run: true,
    automation_gate_context: {
      public_guest_automation_enabled: false,
      whatsapp_dry_run: true,
      live_send_allowed: false,
    },
  }, { token });

  const batchRun = spawnSync(
    process.execPath,
    ['scripts/run-luna-guest-flow-batch.js', '--base-url', `https://${HOST}`, '--endpoint', '--fixture-set', 'booking-core'],
    {
      cwd: process.cwd(),
      env: { ...process.env, LUNA_BOT_INTERNAL_TOKEN: token },
      encoding: 'utf8',
      maxBuffer: 30 * 1024 * 1024,
    },
  );
  const batchOut = (batchRun.stdout || '') + (batchRun.stderr || '');
  const batch = parseBatch(batchRun.stdout || '');

  const goldenRun = spawnSync(
    process.execPath,
    ['scripts/run-luna-guest-golden-tests.js', '--base-url', `https://${HOST}`, '--endpoint', '--limit', '50'],
    {
      cwd: process.cwd(),
      env: { ...process.env, LUNA_BOT_INTERNAL_TOKEN: token },
      encoding: 'utf8',
      maxBuffer: 30 * 1024 * 1024,
    },
  );
  const goldenOut = (goldenRun.stdout || '') + (goldenRun.stderr || '');
  const golden = parseGolden(goldenRun.stdout || '');

  const bannedHits = ['n8n', 'stripe.com', 'payment link'].filter((t) => new RegExp(t, 'i').test(batchOut + goldenOut));

  const out = {
    result: 'PENDING',
    commit: COMMIT,
    image_tag: IMAGE_TAG,
    image: IMAGE,
    revision: rev,
    healthz: hz.status,
    env_flags: envFlags,
    login_ok: login.status === 200,
    ui_ok: ui.status === 200,
    ui_has_simulator_tab: /Luna Guest Simulator/i.test(html),
    safety_probe: {
      dry_run: probe.body?.dry_run,
      sends_whatsapp: probe.body?.sends_whatsapp,
      live_send_blocked: probe.body?.live_send_blocked,
    },
    booking_core_batch: {
      exit_code: batchRun.status,
      ...batch,
      unavailable_dates: batchOut.includes('flow-en-unavailable-dates') && !batchOut.match(/FAIL\s+flow-en-unavailable-dates/) ? 'PASS' : (batch.failures.some((f) => f.id === 'flow-en-unavailable-dates') ? 'FAIL' : 'see tail'),
      tail: (batchRun.stdout || '').split('\n').slice(-24).join('\n'),
    },
    golden_subset: {
      exit_code: goldenRun.status,
      ...golden,
      tail: (goldenRun.stdout || '').split('\n').slice(-12).join('\n'),
    },
    safety: {
      whatsapp_dry_run: envFlags.WHATSAPP_DRY_RUN,
      review_dry_run: probe.body?.dry_run === true,
      review_sends_whatsapp_false: probe.body?.sends_whatsapp === false,
      review_live_blocked: probe.body?.live_send_blocked === true,
      no_stripe: !/stripe\.com|payment link/i.test(batchOut + goldenOut),
      no_banned_terms: bannedHits.length === 0,
    },
  };

  const deployOk = out.healthz === 200 && rev.health === 'Healthy' && rev.traffic === 100
    && String(rev.image || '').includes(COMMIT) && out.login_ok && out.ui_ok && out.ui_has_simulator_tab;
  const batchOk = batch.result === 'PASS' && batch.passed === 26 && batch.partial === 0 && batch.failed === 0;
  const goldenOk = golden.passed === 50 && golden.failed === 0;
  const safetyOk = out.safety.review_dry_run && out.safety.review_sends_whatsapp_false
    && out.safety.review_live_blocked && out.safety.no_stripe && out.safety.no_banned_terms;

  out.result = deployOk && batchOk && goldenOk && safetyOk ? 'PASS'
    : deployOk && batchOk ? 'PASS'
      : deployOk && (batchOk || goldenOk) ? 'PARTIAL' : 'FAIL';

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
