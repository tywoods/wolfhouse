'use strict';
/** Phase 25j.1 hosted proof — temp */
const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const COMMIT = '0b41bffee51bdb0e00a6e3de6e7e40f6064f4284';
const SHORT = COMMIT.slice(0, 7);
const IMAGE = `whstagingacr.azurecr.io/wh-staff-api:${SHORT}-stage25j-owner-perms3`;
const CLIENT = 'wolfhouse-somo';

function az(c) { return execSync(c, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim(); }

function login(email, password) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ client: CLIENT, email, password });
    const r = https.request({
      hostname: HOST, path: '/staff/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let body = raw;
        try { body = JSON.parse(raw); } catch {}
        resolve({
          cookie: (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; '),
          status: res.statusCode,
          body,
        });
      });
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json,text/html', ...(cookie ? { Cookie: cookie } : {}) };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let raw = '';
      res.on('data', (x) => { raw += x; });
      res.on('end', () => {
        let p = raw;
        try { p = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: p, raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.error('Build/deploy...');
  az(`az acr build --registry whstagingacr --image wh-staff-api:${SHORT}-stage25j-owner-perms3 --file Dockerfile .`);
  az(`az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image ${IMAGE} --revision-suffix stage25j-owner-perms3 -o none`);
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    const rev = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'))
      .find((x) => x.properties.trafficWeight === 100);
    if (rev?.properties?.healthState === 'Healthy' && String(rev.name || '').includes('stage25j-owner-perms3')) break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  const healthz = await req('GET', '/healthz');
  const out = {
    result: 'PENDING',
    commit: COMMIT,
    image: IMAGE,
    healthz: healthz.status,
    operator: {},
    admin: {},
    issues: [],
  };

  const opLogin = await login('operator.stage72c@example.test', 'OperatorPass123!');
  out.operator.login_status = opLogin.status;
  out.operator.role = opLogin.body?.role;

  const opSession = await req('GET', '/staff/auth/session', null, opLogin.cookie);
  out.operator.session = {
    status: opSession.status,
    role: opSession.body?.role,
    can_use_owner_insights: opSession.body?.can_use_owner_insights,
  };

  const opUi = await req('GET', '/staff/ui', null, opLogin.cookie);
  const opHtml = opUi.raw || '';
  out.operator.ui = {
    operations: opHtml.includes('cc-section-hdr">Operations</div>'),
    denied_msg: opHtml.includes('Owner Insights requires owner access'),
    gate_fn: opHtml.includes('applyOwnerInsightsGate'),
    active_wrapper: opHtml.includes('id="cc-owner-insights-active"'),
  };

  const opPe = await req('POST', '/staff/owner/sql/plan-and-execute', {
    client_slug: CLIENT,
    question: 'How much revenue this month?',
    max_rows: 50,
    timeout_ms: 3000,
  }, opLogin.cookie);
  out.operator.plan_execute = {
    status: opPe.status,
    error: opPe.body?.error,
  };

  const opAsk = await req('POST', '/staff/ask-luna', {
    client_slug: CLIENT,
    question: 'Who is checking in today?',
    source: 'staff_portal',
  }, opLogin.cookie);
  out.operator.operations_ask_luna = {
    status: opAsk.status,
    success: opAsk.body?.success,
  };

  const adminLogin = await login('admin.stage72c@example.test', 'AdminPass123!');
  out.admin.login_status = adminLogin.status;
  out.admin.role = adminLogin.body?.role;

  if (adminLogin.status === 200) {
    const adSession = await req('GET', '/staff/auth/session', null, adminLogin.cookie);
    out.admin.session = {
      status: adSession.status,
      role: adSession.body?.role,
      can_use_owner_insights: adSession.body?.can_use_owner_insights,
    };
    const adPe = await req('POST', '/staff/owner/sql/plan-and-execute', {
      client_slug: CLIENT,
      question: 'How much revenue this month?',
      max_rows: 50,
      timeout_ms: 3000,
    }, adminLogin.cookie);
    out.admin.plan_execute = {
      status: adPe.status,
      success: adPe.body?.success,
      error: adPe.body?.error,
      answer_len: (adPe.body?.answer || '').length,
    };
  } else {
    out.admin.note = 'admin test user not available on staging — PARTIAL for owner portal positive path';
  }

  if (healthz.status !== 200) out.issues.push('healthz');
  if (opPe.status !== 403 || opPe.body?.error !== 'owner_insights_forbidden') out.issues.push('operator_not_blocked');
  if (opSession.body?.can_use_owner_insights !== false) out.issues.push('operator_session_flag');
  if (!out.operator.ui.denied_msg || !out.operator.ui.gate_fn) out.issues.push('operator_ui_gate');
  if (!out.operator.operations_ask_luna.success) out.issues.push('operations_broken');
  if (adminLogin.status === 200) {
    if (out.admin.session?.can_use_owner_insights !== true) out.issues.push('admin_session_flag');
    if (out.admin.plan_execute?.error === 'owner_insights_forbidden') out.issues.push('admin_owner_gate_blocked');
    else if (out.admin.plan_execute?.status !== 200 || !out.admin.plan_execute?.success) out.issues.push('admin_pe_failed');
  }

  out.result = out.issues.length === 0
    ? (adminLogin.status === 200 ? 'PASS' : 'PARTIAL')
    : 'FAIL';
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'FAIL' ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
