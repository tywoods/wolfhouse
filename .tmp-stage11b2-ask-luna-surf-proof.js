'use strict';

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = '5603150cc1db9805badce253e7654b2057696570';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:5603150-stage11b-ask-luna-surf-forecast';
const UNAVAILABLE =
  'Surf forecast is unavailable right now because the forecast provider quota/connection failed. Staff should check conditions manually.';

const SURF_INTENTS = new Set(['forecast.surf_today', 'forecast.surf_tomorrow']);
const SURF_QUESTIONS = [
  'How are the waves today?',
  'How are the waves tomorrow?',
  'Surf forecast today',
  'Is it good for lessons tomorrow?',
];
const LESSONS_QUESTION = 'Who has lessons today?';

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

function askLuna(cookie, question) {
  return req('POST', '/staff/ask-luna', {
    client_slug: 'wolfhouse-somo',
    source: 'staff_portal',
    question,
  }, cookie);
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

  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiRaw = ui.raw || '';

  const surfResults = {};
  for (const q of SURF_QUESTIONS) {
    const res = await askLuna(cookie, q);
    const b = res.body || {};
    surfResults[q] = {
      http: res.status,
      intent: b.intent,
      success: b.success,
      read_only: b.read_only,
      no_write_performed: b.no_write_performed,
      sends_whatsapp: b.sends_whatsapp,
      surf_forecast_unavailable: b.surf_forecast_unavailable,
      answer_preview: String(b.answer || '').slice(0, 200),
      answer: b.answer,
    };
  }

  const lessonsRes = await askLuna(cookie, LESSONS_QUESTION);
  const lessonsBody = lessonsRes.body || {};

  const anyNumeric = Object.values(surfResults).some((r) =>
    r.answer && /• Waves: \d/.test(r.answer) && !r.answer.includes('unavailable'));
  const allUnavailable = Object.values(surfResults).every((r) =>
    r.answer === UNAVAILABLE || r.surf_forecast_unavailable === true
    || (r.answer && r.answer.includes('quota/connection failed')));
  const surfRouted = SURF_QUESTIONS.every((q) => SURF_INTENTS.has(surfResults[q].intent));
  const lessonsOk = lessonsBody.intent === 'services.lessons_today'
    && lessonsBody.intent !== 'forecast.surf_today';

  const out = {
    result: 'PENDING',
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb31',
    revision,
    deploy_ok: revision.health === 'Healthy'
      && revision.traffic === 100
      && revision.image === IMAGE,
    healthz: { status: healthz.status, stormglass: hz.stormglass },
    surf_intent_routing: surfResults,
    lessons_routing: {
      http: lessonsRes.status,
      intent: lessonsBody.intent,
      success: lessonsBody.success,
      answer_preview: String(lessonsBody.answer || '').slice(0, 120),
    },
    forecast_mode: anyNumeric ? 'numeric' : (allUnavailable ? 'quota_unavailable' : 'mixed'),
    key_safety: {
      ui_no_stormglass_key: !/STORMGLASS_API_KEY/i.test(uiRaw),
      ui_no_stormglass_word: !/STORMGLASS/i.test(uiRaw),
      ui_no_stormglass_domain: !/stormglass\.io/i.test(uiRaw),
      responses_no_key: Object.values(surfResults).every((r) =>
        !/STORMGLASS_API_KEY/i.test(JSON.stringify(r))),
    },
    safety: {
      all_read_only: Object.values(surfResults).every((r) => r.read_only === true),
      all_no_write: Object.values(surfResults).every((r) => r.no_write_performed === true),
      all_no_whatsapp: Object.values(surfResults).every((r) => r.sends_whatsapp === false),
      no_crash: SURF_QUESTIONS.every((q) => surfResults[q].http === 200),
      unavailable_no_judgment: allUnavailable
        ? Object.values(surfResults).every((r) =>
          !/looks small|looks moderate|looks big|good surf|bad surf/i.test(r.answer || ''))
        : true,
      no_auto_cancel: Object.values(surfResults).every((r) =>
        !/cancelled automatically|automatically cancel/i.test(r.answer || '')),
    },
  };

  const pass = out.deploy_ok
    && out.healthz.status === 200
    && out.healthz.stormglass?.configured === true
    && surfRouted
    && lessonsOk
    && out.safety.no_crash
    && out.safety.all_read_only
    && out.safety.all_no_write
    && out.key_safety.ui_no_stormglass_key
    && (anyNumeric || allUnavailable)
    && out.safety.unavailable_no_judgment
    && out.safety.no_auto_cancel;

  out.result = pass ? 'PASS' : 'PARTIAL';
  out.checks = { surfRouted, lessonsOk, anyNumeric, allUnavailable };
  console.log(JSON.stringify(out, null, 2));
  process.exit(pass ? 0 : 2);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
