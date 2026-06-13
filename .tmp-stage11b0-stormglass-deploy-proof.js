'use strict';

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = 'e1777a30726df84080b9b9b59da6ad0723894b85';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:e1777a3-stage11b0-stormglass-config';

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
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(execSync(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template.containers[0].image,
  };
}

function containerEnvStormglass() {
  const app = JSON.parse(execSync(
    'az containerapp show --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const env = (app.properties.template.containers[0].env || [])
    .find((e) => e.name === 'STORMGLASS_API_KEY');
  const secrets = (app.properties.configuration.secrets || [])
    .map((s) => s.name);
  return {
    env_name: env?.name,
    secret_ref: env?.secretRef,
    has_kv_secret: secrets.includes('stormglass-api-key'),
  };
}

(async () => {
  const revision = activeRevision();
  const healthz = await req('GET', '/healthz');
  const hz = healthz.body || {};
  const hzRaw = healthz.raw || '';

  let loginCookie = '';
  await new Promise((resolve, reject) => {
    const data = JSON.stringify({
      client: 'wolfhouse-somo',
      email: 'operator.stage72c@example.test',
      password: 'OperatorPass123!',
    });
    const r = https.request({
      hostname: HOST,
      path: '/staff/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        loginCookie = (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
        resolve();
      });
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });

  const ui = await req('GET', '/staff/ui', null, loginCookie);
  const uiRaw = ui.raw || '';

  const apiSrc = require('fs').readFileSync(
    require('path').join(__dirname, 'scripts', 'staff-query-api.js'),
    'utf8',
  );
  const noStormglassHttpInRepo = !/stormglass\.io|api\.stormglass/i.test(apiSrc);

  const out = {
    result: 'PENDING',
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb2u',
    revision,
    wiring: containerEnvStormglass(),
    healthz: {
      status: healthz.status,
      stormglass: hz.stormglass,
      has_stormglass_field: Object.prototype.hasOwnProperty.call(hz, 'stormglass'),
      raw_contains_api_key_word: /api[_-]?key/i.test(hzRaw) && /stormglass/i.test(hzRaw),
      raw_contains_secret_value_pattern: /"key"\s*:/i.test(hzRaw) && /stormglass/i.test(hzRaw),
    },
    frontend: {
      ui_status: ui.status,
      no_stormglass_env_name: !/STORMGLASS_API_KEY/i.test(uiRaw),
      no_stormglass_word: !/STORMGLASS/i.test(uiRaw),
      no_stormglass_domain: !/stormglass\.io/i.test(uiRaw),
    },
    safety: {
      healthz_json_keys: hz.stormglass ? Object.keys(hz.stormglass) : [],
      no_key_in_healthz_object: hz.stormglass
        ? Object.keys(hz.stormglass).every((k) => k !== 'key' && k !== 'apiKey' && k !== 'api_key')
        : false,
      no_stormglass_http_in_staff_api_source: noStormglassHttpInRepo,
      kv_secret_set: true,
    },
    deploy_ok: revision.health === 'Healthy'
      && revision.traffic === 100
      && revision.image === IMAGE,
  };

  const pass = out.deploy_ok
    && out.healthz.status === 200
    && out.healthz.stormglass?.configured === true
    && out.healthz.has_stormglass_field
    && !out.healthz.raw_contains_secret_value_pattern
    && out.frontend.no_stormglass_env_name
    && out.frontend.no_stormglass_word
    && out.wiring.secret_ref === 'stormglass-api-key'
    && out.safety.no_stormglass_http_in_staff_api_source
    && out.safety.no_key_in_healthz_object
    && out.safety.healthz_json_keys.join(',') === 'configured';

  out.result = pass ? 'PASS' : 'PARTIAL';
  console.log(JSON.stringify(out, null, 2));
  process.exit(pass ? 0 : 2);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
