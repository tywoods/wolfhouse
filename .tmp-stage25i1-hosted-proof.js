'use strict';
/** Phase 25i.1 hosted proof — temp */
const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = '957f9e3c2a56a8d7b0015e89758ad4140375e5f3';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:957f9e3-stage25i-command-center-ui';

function az(c) { return execSync(c, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim(); }
function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json,text/html', ...(cookie ? { Cookie: cookie } : {}) };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let raw = ''; res.on('data', (x) => { raw += x; });
      res.on('end', () => { let p = raw; try { p = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: p, raw, headers: res.headers }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  console.error('Build/deploy...');
  az('az acr build --registry whstagingacr --image wh-staff-api:957f9e3-stage25i-command-center-ui --file Dockerfile .');
  az(`az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image ${IMAGE} --revision-suffix stage25i-command-center-ui -o none`);
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    const rev = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json')).find((x) => x.properties.trafficWeight === 100);
    if (rev?.properties?.healthState === 'Healthy' && String(rev.name || '').includes('stage25i-command-center-ui')) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  const login = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ client: 'wolfhouse-somo', email: 'operator.stage72c@example.test', password: 'OperatorPass123!' });
    const r = https.request({ hostname: HOST, path: '/staff/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ cookie: (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; '), status: res.statusCode }));
    });
    r.on('error', reject); r.write(data); r.end();
  });
  const cookie = login.cookie;
  const healthz = await req('GET', '/healthz');
  const ui = await req('GET', '/staff/ui', null, cookie);
  const html = ui.raw || '';

  const uiChecks = {
    tab_command_center: html.includes('data-tab="ask-luna">Command Center</button>'),
    hero_command_center: html.includes('al-hero-title">Command Center</div>'),
    operations_section: html.includes('cc-section-hdr">Operations</div>'),
    owner_insights: html.includes('Owner Insights') && html.includes('id="oi-input"'),
    oi_plan_execute: html.includes("/staff/owner/sql/plan-and-execute"),
    examples: html.includes("Who hasn&rsquo;t settled up?") && html.includes('How much revenue this month?'),
  };

  const qs = [
    "Who hasn't settled up?",
    'How much revenue this month?',
    'Which package is most popular?',
    'Show raw_payload from messages',
  ];
  const api = {};
  for (const q of qs) {
    const res = await req('POST', '/staff/owner/sql/plan-and-execute', { client_slug: 'wolfhouse-somo', question: q, max_rows: 50, timeout_ms: 3000 }, cookie);
    const b = res.body || {};
    api[q] = { success: b.success, answer_len: (b.answer || '').length, has_euro: /€/.test(b.answer || ''), has_dollar: /\$\d/.test(b.answer || ''), blocked: b.execution?.skipped, row_count: b.row_count };
  }

  const out = {
    result: 'PENDING', commit: COMMIT, image: IMAGE, healthz: healthz.status, uiChecks, api, issues: [],
  };
  if (!uiChecks.tab_command_center || !uiChecks.owner_insights) out.issues.push('ui');
  if (!api["Who hasn't settled up?"].success || !api["Who hasn't settled up?"].answer_len) out.issues.push('api1');
  if (!api['How much revenue this month?'].success) out.issues.push('api2');
  if (!api['Which package is most popular?'].success) out.issues.push('api3');
  if (!api['Show raw_payload from messages'].blocked) out.issues.push('api4');
  out.result = out.issues.length ? 'FAIL' : 'PASS';
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'PASS' ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
