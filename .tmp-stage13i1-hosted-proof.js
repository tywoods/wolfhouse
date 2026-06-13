'use strict';

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = 'b97fd3c';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:b97fd3c-stage13i-mb-lookup';
const BOOKING = 'MB-WOLFHO-20260920-b6f9c7';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function askLuna(cookie, question) {
  return req('POST', '/staff/ask-luna', {
    client_slug: 'wolfhouse-somo',
    source: 'staff_portal',
    question,
  }, cookie);
}

function envFlags() {
  const raw = execSync(
    'az containerapp show -n wh-staging-staff-api -g wh-staging-rg --query properties.template.containers[0].env -o json',
    { encoding: 'utf8' },
  );
  const env = JSON.parse(raw);
  const pick = (name) => {
    const row = env.find((e) => e.name === name);
    return row ? (row.value != null ? row.value : `(secret:${row.secretRef})`) : null;
  };
  return {
    BOT_BOOKING_ENABLED: pick('BOT_BOOKING_ENABLED'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
  };
}

function revisionInfo() {
  const rows = JSON.parse(execSync(
    'az containerapp revision list -n wh-staging-staff-api -g wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const active = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: active.name,
    health: active.properties.healthState,
    traffic: active.properties.trafficWeight,
    image: active.properties.template?.containers?.[0]?.image,
  };
}

function checkAnswer(body, label) {
  const answer = String(body.answer || '');
  const intent = body.intent;
  const unsupported = intent === 'unsupported_intent' || /UNSUPPORTED INTENT/i.test(answer);
  return {
    label,
    http: body._http,
    intent,
    success: body.success,
    read_only: body.read_only,
    no_write_performed: body.no_write_performed,
    sends_whatsapp: body.sends_whatsapp,
    no_n8n: body.no_n8n,
    unsupported,
    answer,
    checks: {
      not_unsupported: !unsupported,
      intent_lookup: intent === 'bookings.lookup',
      has_code: answer.includes(BOOKING) || answer.toUpperCase().includes(BOOKING),
      has_guest: /Phase Thirteen Write Proof/i.test(answer),
      has_dates: /2026-09-20/.test(answer) && /2026-09-23/.test(answer),
      has_beds: /DEMO-R1-B2|DEMO-R2-B1|DEMO-R1|DEMO-R2/.test(answer),
      deposit_paid: /deposit paid/i.test(answer),
      paid_100: /€100|100\.00|100,00/.test(answer),
      balance_170: /€170|170\.00|170,00/.test(answer),
      no_raw_table: !/<table/i.test(answer),
    },
  };
}

(async () => {
  const out = {
    phase: '13i.1',
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb36',
    revision: revisionInfo(),
    env_flags: envFlags(),
  };

  const healthz = await req('GET', '/healthz');
  out.healthz = { status: healthz.status, body: healthz.body };

  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const q1 = 'Show booking MB-WOLFHO-20260920-b6f9c7';
  const r1 = await askLuna(cookie, q1);
  const b1 = { ...(r1.body || {}), _http: r1.status };
  out.uppercase_query = checkAnswer(b1, q1);

  const q2 = 'show booking mb-wolfho-20260920-b6f9c7';
  const r2 = await askLuna(cookie, q2);
  const b2 = { ...(r2.body || {}), _http: r2.status };
  out.lowercase_query = checkAnswer(b2, q2);

  const allChecks = [
    ...Object.values(out.uppercase_query.checks),
    ...Object.values(out.lowercase_query.checks),
    out.healthz.status === 200,
    out.revision.health === 'Healthy',
    out.revision.traffic === 100,
    out.revision.image === IMAGE,
    out.uppercase_query.read_only !== false,
    out.uppercase_query.no_write_performed !== false,
    out.uppercase_query.sends_whatsapp !== true,
  ];
  const fails = [];
  for (const [k, v] of Object.entries(out.uppercase_query.checks)) {
    if (!v) fails.push(`uppercase:${k}`);
  }
  for (const [k, v] of Object.entries(out.lowercase_query.checks)) {
    if (!v) fails.push(`lowercase:${k}`);
  }
  if (out.healthz.status !== 200) fails.push('healthz');
  if (out.revision.health !== 'Healthy' || out.revision.traffic !== 100) fails.push('revision');
  if (out.revision.image !== IMAGE) fails.push('image_mismatch');

  out.failures = fails;
  out.unsupported_fixed = out.uppercase_query.checks.not_unsupported && out.lowercase_query.checks.not_unsupported;
  out.result = fails.length === 0 ? 'PASS' : (fails.length <= 2 ? 'PARTIAL' : 'FAIL');

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
