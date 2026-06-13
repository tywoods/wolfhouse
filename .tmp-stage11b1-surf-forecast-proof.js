'use strict';

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = '2634fd55c9cef9a5df2e6117a098556d22f2fced';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:2634fd5-stage11b-surf-forecast';

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

function checkForecast(body) {
  const fc = body.forecast || {};
  const fcKeys = [
    'wave_height_m', 'swell_height_m', 'swell_period_s', 'swell_direction_deg',
    'wind_speed_mps', 'wind_direction_deg', 'summary', 'caution',
  ];
  const missing = fcKeys.filter((k) => fc[k] == null || fc[k] === '');
  return {
    ok: body.success === true
      && body.source === 'stormglass'
      && body.read_only === true
      && body.spot === 'Somo'
      && body.client_slug === 'wolfhouse-somo'
      && missing.length === 0,
    missing,
  };
}

function staffSafe(summary, caution) {
  const s = String(summary || '');
  const c = String(caution || '');
  return s.includes('Staff should confirm lessons day-by-day')
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

  const todayCheck = checkForecast(today.body || {});
  const tomorrowCheck = checkForecast(tomorrow.body || {});
  const todayRaw = JSON.stringify(today.body || {});
  const tomorrowRaw = JSON.stringify(tomorrow.body || {});

  const out = {
    result: 'PENDING',
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb2v',
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
      ok: todayCheck.ok,
      missing: todayCheck.missing,
      body: today.body,
    },
    tomorrow: {
      http: tomorrow.status,
      ok: tomorrowCheck.ok,
      missing: tomorrowCheck.missing,
      body: tomorrow.body,
    },
    key_safety: {
      today_no_stormglass_env: !/STORMGLASS_API_KEY/.test(todayRaw),
      tomorrow_no_stormglass_env: !/STORMGLASS_API_KEY/.test(tomorrowRaw),
      healthz_only_configured: hz.stormglass
        ? Object.keys(hz.stormglass).every((k) => k === 'configured')
        : false,
      ui_no_stormglass_env: !/STORMGLASS_API_KEY/i.test(uiRaw),
      ui_no_stormglass_word: !/STORMGLASS/i.test(uiRaw),
      ui_no_stormglass_domain: !/stormglass\.io/i.test(uiRaw),
    },
    staff_safe: {
      today: staffSafe(today.body?.forecast?.summary, today.body?.forecast?.caution),
      tomorrow: staffSafe(tomorrow.body?.forecast?.summary, tomorrow.body?.forecast?.caution),
      today_caution_not_auto: /not auto-cancelled/i.test(today.body?.forecast?.caution || ''),
      tomorrow_caution_not_auto: /not auto-cancelled/i.test(tomorrow.body?.forecast?.caution || ''),
    },
    safety: {
      staging_only: HOST.includes('staging'),
      read_only_both: today.body?.read_only === true && tomorrow.body?.read_only === true,
      no_db_write_fields: !todayRaw.includes('write_performed') && !tomorrowRaw.includes('write_performed'),
    },
  };

  const pass = out.deploy_ok
    && out.healthz.status === 200
    && out.healthz.stormglass?.configured === true
    && today.status === 200
    && tomorrow.status === 200
    && todayCheck.ok
    && tomorrowCheck.ok
    && out.staff_safe.today
    && out.staff_safe.tomorrow
    && out.key_safety.today_no_stormglass_env
    && out.key_safety.ui_no_stormglass_env
    && out.key_safety.ui_no_stormglass_word;

  out.result = pass ? 'PASS' : 'PARTIAL';
  console.log(JSON.stringify(out, null, 2));
  process.exit(pass ? 0 : 2);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
