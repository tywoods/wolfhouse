'use strict';

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = 'da9bcbdf61b77ec79e060d2c5a89fa698ff1f809';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:da9bcbd-stage11b-stormglass-utc-window';
const METRIC_KEYS = [
  'wave_height_m', 'swell_height_m', 'swell_period_s',
  'swell_direction_deg', 'wind_speed_mps', 'wind_direction_deg',
];

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
      headers: {
        Accept: 'application/json,text/html',
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

function numericMetrics(fc) {
  fc = fc || {};
  const out = {};
  for (const k of METRIC_KEYS) {
    out[k] = typeof fc[k] === 'number' && Number.isFinite(fc[k]) ? fc[k] : null;
  }
  out.count = Object.values(out).filter((v) => typeof v === 'number').length;
  return out;
}

function staffSafe(body) {
  const s = String(body?.forecast?.summary || '');
  const c = String(body?.forecast?.caution || '');
  return s.includes('Staff should confirm lessons day-by-day')
    && (c.includes('not auto-cancelled') || c.includes('not auto-cancelled'))
    && !/cancelled automatically|automatically cancel/i.test(s + c);
}

(async () => {
  const rows = JSON.parse(execSync(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const active = rows.find((x) => x.properties.trafficWeight === 100) || {};
  const revision = {
    name: active.name,
    health: active.properties.healthState,
    traffic: active.properties.trafficWeight,
    image: active.properties.template?.containers?.[0]?.image,
  };

  const healthz = await req('GET', '/healthz');
  const hz = healthz.body || {};

  const login = await req('POST', '/staff/auth/login', {
    client: 'wolfhouse-somo',
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const today = await req('GET', '/staff/surf-forecast?client=wolfhouse-somo&day=today', null, cookie);
  const tomorrow = await req('GET', '/staff/surf-forecast?client=wolfhouse-somo&day=tomorrow', null, cookie);
  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiRaw = ui.raw || '';

  const todayNums = numericMetrics(today.body?.forecast);
  const tomorrowNums = numericMetrics(tomorrow.body?.forecast);

  const out = {
    result: 'PENDING',
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb2y',
    revision,
    deploy_ok: revision.health === 'Healthy'
      && revision.traffic === 100
      && revision.image === IMAGE,
    healthz: {
      status: healthz.status,
      stormglass: hz.stormglass,
    },
    today: {
      http: today.status,
      body: today.body,
      numeric: todayNums,
      staff_safe: staffSafe(today.body),
    },
    tomorrow: {
      http: tomorrow.status,
      body: tomorrow.body,
      numeric: tomorrowNums,
      staff_safe: staffSafe(tomorrow.body),
    },
    key_safety: {
      today_no_env: !/STORMGLASS_API_KEY/.test(JSON.stringify(today.body || {})),
      tomorrow_no_env: !/STORMGLASS_API_KEY/.test(JSON.stringify(tomorrow.body || {})),
      ui_no_stormglass: !/STORMGLASS/i.test(uiRaw),
      ui_no_domain: !/stormglass\.io/i.test(uiRaw),
      healthz_configured_only: hz.stormglass
        ? Object.keys(hz.stormglass).join(',') === 'configured'
        : false,
    },
    safety: {
      staging_only: true,
      read_only_both: today.body?.read_only === true && tomorrow.body?.read_only === true,
    },
  };

  const shapeOk = (b) => b?.success === true
    && b?.source === 'stormglass'
    && b?.read_only === true
    && b?.spot === 'Somo';

  const pass = out.deploy_ok
    && out.healthz.status === 200
    && out.healthz.stormglass?.configured === true
    && today.status === 200
    && tomorrow.status === 200
    && shapeOk(today.body)
    && shapeOk(tomorrow.body)
    && todayNums.count >= 1
    && tomorrowNums.count >= 1
    && out.today.staff_safe
    && out.tomorrow.staff_safe
    && out.key_safety.today_no_env
    && out.key_safety.ui_no_stormglass;

  out.result = pass ? 'PASS' : 'PARTIAL';
  console.log(JSON.stringify(out, null, 2));
  process.exit(pass ? 0 : 2);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
