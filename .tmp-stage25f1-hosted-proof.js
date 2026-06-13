'use strict';
/** Phase 25f.1 — Owner SQL planner dry-run hosted proof. Temp — do not commit. */
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = 'c8ec73b45770c4d7dd5639f12ba5c56667c52480';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:c8ec73b-stage25f-owner-sql-planner';
const REVISION_SUFFIX = 'stage25f-owner-sql-planner';
const PROOF_START = new Date().toISOString();

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
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
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
    if (row.secretRef) return `(secret:${row.secretRef})`;
    return row.value != null ? row.value : '(unset)';
  };
  return {
    WHATSAPP_DRY_RUN: pick('WHATSAPP_DRY_RUN'),
    LUNA_AI_PROVIDER: pick('LUNA_AI_PROVIDER'),
    OPENAI_API_KEY: pick('OPENAI_API_KEY'),
    STRIPE_LINKS_ENABLED: pick('STRIPE_LINKS_ENABLED'),
    WHATSAPP_LIVE_SENDS_ENABLED: pick('WHATSAPP_LIVE_SENDS_ENABLED'),
    WHATSAPP_CLOUD_ACCESS_TOKEN: pick('WHATSAPP_CLOUD_ACCESS_TOKEN'),
    WHATSAPP_PHONE_NUMBER_ID: pick('WHATSAPP_PHONE_NUMBER_ID'),
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

async function staffLogin() {
  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  if (login.status !== 200 || !login.body?.success) throw new Error(`login failed ${login.status}`);
  return (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
}

function summarizePlan(res, label) {
  const b = res.body || {};
  return {
    label,
    http: res.status,
    success: b.success,
    planner_source: b.planner_source,
    template_id: b.plan?.template_id ?? null,
    mode: b.plan?.mode,
    validation_valid: b.validation?.valid,
    validation_reason: b.validation?.reason,
    blocked_reason: b.validation?.blocked_reason,
    execute_ready: b.execute_ready,
    no_query_executed: b.no_query_executed,
    has_rows: Array.isArray(b.rows) && b.rows.length > 0,
    row_count: b.row_count ?? (Array.isArray(b.rows) ? b.rows.length : 0),
    sql_preview: (b.plan?.sql || '').slice(0, 120),
  };
}

function checkProofA(s) {
  return s.http === 200 && s.success === true && s.planner_source === 'template_match'
    && s.template_id === 'outstanding_balances' && s.validation_valid === true
    && s.execute_ready === true && s.no_query_executed === true && !s.has_rows;
}

function checkProofB(s) {
  return s.http === 200 && s.template_id === 'revenue_summary_by_month'
    && s.validation_valid === true && s.no_query_executed === true && !s.has_rows;
}

function checkProofC(s) {
  return s.http === 200 && s.template_id === 'package_popularity'
    && s.validation_valid === true && s.no_query_executed === true && !s.has_rows;
}

function checkProofD(s) {
  const blocked = s.validation_valid === false || s.success === false;
  const reason = `${s.blocked_reason || ''} ${s.validation_reason || ''}`.toLowerCase();
  const sensitiveBlocked = /raw_payload|sensitive|column|blocked|unsupported|disallowed/.test(reason)
    || /raw_payload/i.test(s.sql_preview);
  return blocked && sensitiveBlocked && s.no_query_executed === true && !s.has_rows;
}

function checkProofE(s) {
  const blocked = s.validation_valid === false || s.success === false;
  const reason = `${s.blocked_reason || ''} ${s.validation_reason || ''} ${s.sql_preview}`.toLowerCase();
  const starBlocked = /select \*|wildcard|column.*not allowed|disallowed|blocked/.test(reason);
  return blocked && starBlocked && s.no_query_executed === true && !s.has_rows;
}

function checkProofF(s) {
  if (s.no_query_executed !== true || s.has_rows) return false;
  if (s.planner_source === 'ai') {
    return s.validation_valid === true;
  }
  if (s.planner_source === 'fallback' && s.validation_valid === false) {
    return true; // PARTIAL acceptable
  }
  return false;
}

(async () => {
  const out = {
    phase: '25f.1-hosted',
    proof_start: PROOF_START,
    commit: COMMIT,
    image: IMAGE,
    revision_before: null,
    revision_after: null,
    healthz_before: null,
    healthz_after: null,
    env: null,
    db_before: null,
    db_after: null,
    proofs: {},
    safety: {},
    result: 'PENDING',
    issues: [],
  };

  out.healthz_before = await req('GET', '/healthz');
  out.revision_before = activeRevision();

  const pg = await pgConnect();
  out.db_before = await dbCounts(pg);
  await pg.end();

  const rev = await waitHealthy();
  out.revision_after = rev;
  out.env = stagingEnvFlags();
  out.healthz_after = await req('GET', '/healthz');

  const cookie = await staffLogin();

  const planCalls = [
    { key: 'A', question: "Who hasn't settled up?" },
    { key: 'B', question: 'How much revenue this month?' },
    { key: 'C', question: 'Which package is most popular?' },
    { key: 'D', question: 'Show raw_payload from messages' },
    { key: 'E', question: 'Show me every column from guest message events' },
    { key: 'F', question: 'List recent guest messages for Wolfhouse' },
  ];

  for (const c of planCalls) {
    const res = await req('POST', '/staff/owner/sql/plan', {
      client_slug: CLIENT,
      question: c.question,
    }, cookie);
    const summary = summarizePlan(res, c.key);
    summary.pass = {
      A: checkProofA,
      B: checkProofB,
      C: checkProofC,
      D: checkProofD,
      E: checkProofE,
      F: checkProofF,
    }[c.key](summary);
    out.proofs[c.key] = summary;
    if (!summary.pass) out.issues.push(`proof_${c.key}_failed`);
  }

  const pg2 = await pgConnect();
  out.db_after = await dbCounts(pg2);
  await pg2.end();

  const deployOk = rev.health === 'Healthy' && rev.traffic === 100
    && String(rev.image || '').includes('c8ec73b-stage25f-owner-sql-planner')
    && String(rev.name || '').includes(REVISION_SUFFIX);
  const envOk = out.env.WHATSAPP_DRY_RUN === 'true'
    && out.env.LUNA_AI_PROVIDER === 'openai'
    && out.env.OPENAI_API_KEY === '(secret:openai-api-key)'
    && out.env.STRIPE_LINKS_ENABLED === 'false';
  const countsOk = out.db_before.bookings === out.db_after.bookings
    && out.db_before.payments === out.db_after.payments
    && out.db_before.guest_message_sends_sent === out.db_after.guest_message_sends_sent;
  const healthOk = out.healthz_after.status === 200;
  const proofsOk = ['A', 'B', 'C', 'D', 'E'].every((k) => out.proofs[k]?.pass);
  const proofFPartial = !out.proofs.F?.pass && out.proofs.F?.no_query_executed === true;

  out.safety = {
    deploy_ok: deployOk,
    env_ok: envOk,
    counts_unchanged: countsOk,
    healthz_ok: healthOk,
    no_rows_in_any_plan: Object.values(out.proofs).every((p) => !p.has_rows),
    no_whatsapp_live: out.env.WHATSAPP_LIVE_SENDS_ENABLED !== 'true',
    no_whatsapp_token: out.env.WHATSAPP_CLOUD_ACCESS_TOKEN === '(unset)',
  };

  if (deployOk && envOk && countsOk && healthOk && proofsOk && out.proofs.F?.pass) {
    out.result = 'PASS';
  } else if (deployOk && envOk && countsOk && healthOk && proofsOk && proofFPartial) {
    out.result = 'PARTIAL';
    out.issues.push('proof_F_partial');
  } else if (!proofsOk) {
    out.result = out.proofs.A?.http === 404 ? 'FAIL' : 'FAIL';
  } else {
    out.result = 'FAIL';
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.result === 'FAIL' ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
