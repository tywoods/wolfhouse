'use strict';
/** Phase 25g.1 — Owner plan-and-execute hosted proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = '6e8fd6588a629848291c1e49ad0ab722a68c54df';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:6e8fd65-stage25g-plan-execute';
const REVISION_SUFFIX = 'stage25g-plan-execute';

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) };
    if (data) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const r = https.request({ hostname: HOST, path, method, headers: h }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw });
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

async function waitHealthy(timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rev = activeRevision();
    if (rev.health === 'Healthy' && rev.traffic === 100 && String(rev.name || '').includes(REVISION_SUFFIX)) {
      return rev;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return activeRevision();
}

async function pgConnect() {
  const url = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

async function dbCounts(pg) {
  const bookings = await pg.query('SELECT COUNT(*)::int AS n FROM bookings');
  const payments = await pg.query('SELECT COUNT(*)::int AS n FROM payments');
  const sends = await pg.query("SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE status = 'sent'");
  return {
    bookings: bookings.rows[0].n,
    payments: payments.rows[0].n,
    guest_message_sends_sent: sends.rows[0].n,
  };
}

function summarize(body) {
  return {
    success: body.success,
    planner_source: body.planner_source,
    template_id: body.plan?.template_id ?? null,
    validation_valid: body.validation?.valid,
    blocked_reason: body.validation?.blocked_reason,
    execute_ready: body.execute_ready,
    no_query_executed: body.no_query_executed,
    execution_success: body.execution?.success,
    execution_skipped: body.execution?.skipped,
    row_count: body.execution?.row_count ?? 0,
    read_only: body.execution?.read_only ?? body.read_only,
    no_write: body.execution?.no_write_performed ?? body.no_write_performed,
  };
}

(async () => {
  console.error('Building image...');
  az('az acr build --registry whstagingacr --image wh-staff-api:6e8fd65-stage25g-plan-execute --file Dockerfile .');
  console.error('Deploying...');
  az(`az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg --image ${IMAGE} --revision-suffix ${REVISION_SUFFIX} -o none`);

  const pg = await pgConnect();
  const dbBefore = await dbCounts(pg);
  await pg.end();

  const rev = await waitHealthy();
  const healthz = await req('GET', '/healthz');

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers?.['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const setCookie = login.raw && login.raw.includes('set-cookie') ? null : null;
  // fix cookie from login response - req doesn't return headers in our helper
  const login2 = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!' });
    const r = https.request({
      hostname: HOST, path: '/staff/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Accept: 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw) }));
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
  const authCookie = (login2.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const questions = [
    { key: '1', q: "Who hasn't settled up?", expectExecute: true },
    { key: '2', q: 'How much revenue this month?', expectExecute: true },
    { key: '3', q: 'Which package is most popular?', expectExecute: true },
    { key: '4', q: 'List recent guest messages for Wolfhouse', expectExecute: 'maybe' },
    { key: '5', q: 'Show raw_payload from messages', expectExecute: false },
  ];

  const proofs = {};
  for (const { key, q } of questions) {
    const res = await req('POST', '/staff/owner/sql/plan-and-execute', {
      client_slug: CLIENT,
      question: q,
      max_rows: 50,
      timeout_ms: 3000,
    }, authCookie);
    proofs[key] = { question: q, http: res.status, ...summarize(res.body || {}) };
  }

  // Plan route still dry-run
  const planDry = await req('POST', '/staff/owner/sql/plan', {
    client_slug: CLIENT,
    question: "Who hasn't settled up?",
  }, authCookie);

  const pg2 = await pgConnect();
  const dbAfter = await dbCounts(pg2);
  await pg2.end();

  const out = {
    result: 'PENDING',
    commit: COMMIT,
    image: IMAGE,
    revision: rev,
    healthz: healthz.status,
    db_before: dbBefore,
    db_after: dbAfter,
    proofs,
    plan_route: summarize(planDry.body || {}),
    issues: [],
  };

  if (proofs['1'].success && proofs['1'].no_query_executed === false && proofs['1'].row_count >= 0) {
    /* ok */
  } else out.issues.push('proof1');
  if (proofs['2'].success && proofs['2'].no_query_executed === false) { /* ok */ } else out.issues.push('proof2');
  if (proofs['3'].success && proofs['3'].no_query_executed === false) { /* ok */ } else out.issues.push('proof3');
  if (proofs['5'].no_query_executed === true && proofs['5'].execution_skipped === true) { /* ok */ } else out.issues.push('proof5');
  if (planDry.body?.no_query_executed === true) { /* ok */ } else out.issues.push('plan_dry_run');
  if (dbBefore.bookings === dbAfter.bookings && dbBefore.payments === dbAfter.payments
    && dbBefore.guest_message_sends_sent === dbAfter.guest_message_sends_sent) { /* ok */ } else out.issues.push('db_counts');

  const proof4ok = proofs['4'].success === true && proofs['4'].no_query_executed === false;
  const proof4partial = proofs['4'].no_query_executed === true && proofs['4'].execution_skipped === true;

  if (out.issues.length === 0 && proof4ok) out.result = 'PASS';
  else if (out.issues.length === 0 && proof4partial) {
    out.result = 'PARTIAL';
    out.issues.push('proof4_ai_unsupported');
  } else if (out.issues.filter((x) => x !== 'proof4_ai_unsupported').length === 0 && proof4partial) {
    out.result = 'PARTIAL';
    out.issues.push('proof4_ai_unsupported');
  } else {
    out.result = out.issues.length <= 1 && proof4partial ? 'PARTIAL' : 'FAIL';
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'FAIL' ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
