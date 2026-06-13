'use strict';
/** Stage 27test-e — deploy proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { spawnSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = '58ccff3';
const IMAGE_TAG = `${COMMIT}-stage27test-e-side-questions`;
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

  const pkgReview = await req('POST', '/staff/bot/guest-automation-review-dry-run', {
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

  const pkgReply = pkgReview.body?.review?.proposed_luna_reply
    || pkgReview.body?.proposed_luna_reply || '';
  const pkgHandoff = pkgReview.body?.review?.handoff_reasons
    || pkgReview.body?.handoff_reasons || [];

  const batch = spawnSync(
    process.execPath,
    ['scripts/run-luna-guest-flow-batch.js', '--base-url', `https://${HOST}`, '--endpoint', '--fixture-set', 'booking-core', '--count', '10'],
    {
      cwd: process.cwd(),
      env: { ...process.env, LUNA_BOT_INTERNAL_TOKEN: token },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    },
  );

  const batchOut = batch.stdout || '';
  const batchErr = batch.stderr || '';
  const passMatch = batchOut.match(/Passed:\s*(\d+)/);
  const partialMatch = batchOut.match(/Partial:\s*(\d+)/);
  const failMatch = batchOut.match(/Failed:\s*(\d+)/);
  const resultMatch = batchOut.match(/Batch result:\s*(PASS|PARTIAL|FAIL)/);

  const sideFlows = {};
  for (const id of ['flow-en-package-mid-flow', 'flow-en-cash-before-deposit']) {
    const re = new RegExp(`(PASS|PARTIAL|FAIL)\\s+${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
    const m = batchOut.match(re);
    sideFlows[id] = m ? m[1] : 'MISSING';
  }

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
    ui_has_review_route: /guest-automation-review-dry-run/.test(html),
    package_explainer: {
      http: pkgReview.status,
      dry_run: pkgReview.body?.dry_run,
      sends_whatsapp: pkgReview.body?.sends_whatsapp,
      live_send_blocked: pkgReview.body?.live_send_blocked,
      handoff_count: Array.isArray(pkgHandoff) ? pkgHandoff.length : null,
      reply_has_malibu: /malibu/i.test(pkgReply),
      reply_has_uluwatu: /uluwatu/i.test(pkgReply),
      reply_has_waimea: /waimea/i.test(pkgReply),
      reply_preview: pkgReply.slice(0, 280),
    },
    booking_core_batch: {
      exit_code: batch.status,
      result: resultMatch ? resultMatch[1] : null,
      passed: passMatch ? Number(passMatch[1]) : null,
      partial: partialMatch ? Number(partialMatch[1]) : null,
      failed: failMatch ? Number(failMatch[1]) : null,
      side_flows: sideFlows,
      tail: batchOut.split('\n').slice(-15).join('\n'),
    },
    safety: {
      whatsapp_dry_run: envFlags.WHATSAPP_DRY_RUN,
      public_guest_automation: envFlags.PUBLIC_GUEST_AUTOMATION_ENABLED,
      review_dry_run: pkgReview.body?.dry_run === true,
      review_sends_whatsapp: pkgReview.body?.sends_whatsapp === false,
      review_live_blocked: pkgReview.body?.live_send_blocked === true,
      no_stripe_in_batch: !/stripe\.com|payment link/i.test(batchOut),
    },
  };

  const batchOk = out.booking_core_batch.result === 'PASS'
    && out.booking_core_batch.passed === 10
    && out.booking_core_batch.partial === 0
    && out.booking_core_batch.failed === 0
    && sideFlows['flow-en-package-mid-flow'] === 'PASS'
    && sideFlows['flow-en-cash-before-deposit'] === 'PASS';

  const pkgOk = out.package_explainer.http === 200
    && out.package_explainer.handoff_count === 0
    && out.package_explainer.reply_has_malibu
    && out.package_explainer.reply_has_uluwatu
    && out.package_explainer.reply_has_waimea;

  const deployOk = out.healthz === 200
    && rev.health === 'Healthy'
    && rev.traffic === 100
    && String(rev.image || '').includes(COMMIT)
    && out.login_ok
    && out.ui_ok
    && out.ui_has_simulator_tab;

  out.result = deployOk && batchOk && pkgOk ? 'PASS' : (deployOk && (batchOk || pkgOk) ? 'PARTIAL' : 'FAIL');

  if (batchErr) out.booking_core_batch.stderr_tail = batchErr.split('\n').slice(-5).join('\n');

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
