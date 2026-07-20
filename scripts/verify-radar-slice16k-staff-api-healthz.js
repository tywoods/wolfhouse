'use strict';

/**
 * verify:radar-slice16k-staff-api-healthz — RADAR Slice 16K
 *
 * Offline RED/GREEN gate for minimized public Staff API /healthz.
 * Real-listener proofs use createStaffQueryApiHttpServer (fortress dual-gate)
 * with env canaries. Does not alter /readyz. No live deploy / Azure mutation.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16k-staff-api-healthz');
const healthz = require('./lib/staff-api-healthz');
const readiness = require('./lib/staff-api-readiness');

const MASTER = locks.MASTER_BASIS;
const CONTRACT_REL = 'fixtures/radar-operations/slice16k-expected-contract.json';

const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]{20,}/,
  /whsec_[A-Za-z0-9]+/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /password["']?\s*[:=]\s*["'][^"']{8,}/i,
  /ACCOUNT_KEY["']?\s*[:=]\s*["'][^"']{16,}/i,
  new RegExp(String.raw`postgres(?:ql)?:` + String.raw`\/\/[^\s"']+`, 'i'),
];

const CANARY = Object.freeze({
  OPENAI_API_KEY: 'sk-radar16k-OPENAI-CANARY-KEY-DO-NOT-LEAK',
  ANTHROPIC_API_KEY: 'sk-ant-radar16k-ANTHROPIC-CANARY-DO-NOT-LEAK',
  STORMGLASS_API_KEY: 'sg-radar16k-STORMGLASS-CANARY-DO-NOT-LEAK',
  LUNA_AI_PROVIDER: 'openai',
  LUNA_AI_MODEL: 'gpt-4o-mini-radar16k-MODEL-CANARY',
  OPENAI_MODEL: 'gpt-4o-mini-radar16k-MODEL-CANARY',
  DEFAULT_CLIENT_SLUG: 'wolfhouse-radar16k-TENANT-CANARY',
  LUNA_BOT_CLIENT_SLUG: 'sunset-radar16k-TENANT-CANARY',
});

const REQUIRED_RED = [
  'fat_healthz_body_rejected',
  'auth_enabled_field_rejected',
  'luna_ai_field_rejected',
  'stormglass_field_rejected',
  'stage_note_fields_rejected',
  'tenant_provider_model_key_rejected',
  'wrong_service_name_rejected',
  'extra_unexpected_field_rejected',
  'readyz_not_swapped_into_healthz',
  'authenticated_ai_status_route_preserved',
];

const REQUIRED_GREEN = [
  'real_listener_healthz_generic_schema',
  'real_listener_cache_control_no_store',
  'env_canaries_absent_from_healthz',
  'no_unexpected_healthz_fields',
  'healthz_no_db_call',
  'readyz_unchanged_generic_body',
  'wolfhouse_sunset_same_generic_body',
  'root_alias_same_generic_body',
];

let pass = 0;
let fail = 0;
const redResults = [];
const greenResults = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function red(id, cond, detail) {
  const passed = ok(`RED ${id}`, cond, detail);
  redResults.push({ id, ok: !!cond });
  return passed;
}

function green(id, cond, detail) {
  const passed = ok(`GREEN ${id}`, cond, detail);
  greenResults.push({ id, ok: !!cond });
  return passed;
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function secretFree(text, label) {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return { ok: false, detail: `${label} matched ${re}` };
  }
  return { ok: true };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    } catch (_) { /* ignore */ }
    server.close(() => resolve());
  });
}

function httpGet(port, reqPath, timeoutMs = 8000, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: reqPath,
      method: 'GET',
      timeout: timeoutMs,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

function clearStaffApiCache() {
  for (const key of Object.keys(require.cache)) {
    if (/staff-query-api\.js$/.test(key)
      || /staff-auth-config\.js$/.test(key)
      || /staff-portal-clients\.js$/.test(key)
      || /staff-api-readiness\.js$/.test(key)
      || /staff-api-healthz\.js$/.test(key)
      || /luna-ai-provider\.js$/.test(key)
      || /staff-stormglass-config\.js$/.test(key)
      || /pg-connect\.js$/.test(key)) {
      delete require.cache[key];
    }
  }
}

function applyMinimalStaffApiEnv(extra = {}) {
  process.env.NODE_ENV = 'test';
  process.env.STAFF_RUNTIME_PROFILE = 'test';
  process.env.STAFF_AUTH_REQUIRED = 'true';
  process.env.STAFF_AUTH_HTTPS = 'false';
  process.env.STAFF_QUERY_API_HOST = '127.0.0.1';
  process.env.LUNA_BOT_INTERNAL_TOKEN = 'radar16k_bot_token_offline_test_01';
  process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = '1';
  for (const [k, v] of Object.entries(extra)) {
    process.env[k] = v;
  }
}

async function withRealStaffApiServer(seams, fn) {
  const savedKeys = [
    'NODE_ENV',
    'STAFF_RUNTIME_PROFILE',
    'STAFF_AUTH_REQUIRED',
    'STAFF_AUTH_HTTPS',
    'STAFF_QUERY_API_HOST',
    'LUNA_BOT_INTERNAL_TOKEN',
    'STAFF_API_FORTRESS_OFFLINE_LISTENER',
    ...Object.keys(CANARY),
    ...Object.keys((seams && seams.env) || {}),
  ];
  const saved = {};
  for (const k of savedKeys) saved[k] = process.env[k];

  applyMinimalStaffApiEnv({ ...CANARY, ...((seams && seams.env) || {}) });
  clearStaffApiCache();
  const api = require('./staff-query-api');
  const readinessMod = require('./lib/staff-api-readiness');
  if (typeof api.createStaffQueryApiHttpServer !== 'function') {
    throw new Error('createStaffQueryApiHttpServer not exported — dual-gate inactive');
  }
  const offlineSeams = {};
  if (seams && seams.readinessPool) offlineSeams.readinessPool = seams.readinessPool;
  if (seams && typeof seams.withPgClient === 'function') {
    offlineSeams.withPgClient = seams.withPgClient;
  }
  api.setFortress15j3OfflineSeams(Object.keys(offlineSeams).length ? offlineSeams : null);
  if (seams && seams.readinessPool) {
    readinessMod._setReadinessPoolForTests(seams.readinessPool);
  }
  const server = api.createStaffQueryApiHttpServer({
    ingressBinding: seams && seams.ingressBinding,
  });
  const port = await listen(server);
  try {
    return await fn({ api, server, port, readinessMod });
  } finally {
    await closeServer(server);
    api.setFortress15j3OfflineSeams(null);
    readinessMod._resetReadinessPoolStateForTests();
    clearStaffApiCache();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function createTrackingReadinessPool() {
  const shared = {
    connectCalls: 0,
    queryCalls: 0,
  };
  const client = {
    query(sql) {
      shared.queryCalls += 1;
      if (sql !== 'SELECT 1') {
        return Promise.reject(new Error('unexpected sql'));
      }
      return Promise.resolve({ rows: [{ '?column?': 1 }] });
    },
    release() { /* noop */ },
    on() { return client; },
    removeListener() { return client; },
  };
  const pool = {
    connect() {
      shared.connectCalls += 1;
      return Promise.resolve(client);
    },
    async end() { /* noop */ },
    get idleCount() { return 1; },
    get totalCount() { return 1; },
    get waitingCount() { return 0; },
  };
  return { pool, shared };
}

function createDbSpyWithPgClient() {
  const shared = { calls: 0 };
  function withPgClient(fn) {
    shared.calls += 1;
    return fn({
      query() {
        return Promise.resolve({ rows: [] });
      },
    });
  }
  return { withPgClient, shared };
}

function bodyContainsAny(bodyText, needles) {
  const text = String(bodyText || '');
  const lower = text.toLowerCase();
  for (const n of needles) {
    if (lower.includes(String(n).toLowerCase())) return n;
  }
  return null;
}

async function main() {
  console.log('verify:radar-slice16k-staff-api-healthz — RADAR Slice 16K\n');

  const contract = readJson(CONTRACT_REL);
  const apiSrc = readText(locks.STAFF_API_REL);
  const healthzSrc = readText(locks.HEALTHZ_LIB_REL);
  const readinessSrc = readText('scripts/lib/staff-api-readiness.js');

  ok('C1 contract pinned',
    contract.master_basis === MASTER
    && contract.outcome_id === locks.OUTCOME_ID
    && contract.gate_id === locks.GATE_ID
    && contract.progress_class === locks.PROGRESS_CLASS
    && contract.live_deploy === false
    && contract.live_mutation === false
    && contract.branch === locks.BRANCH);

  ok('C2 public schema frozen',
    contract.public_healthz_schema.status === 'ok'
    && contract.public_healthz_schema.service === 'staff-api'
    && healthz.HEALTHZ_BODY.status === 'ok'
    && healthz.HEALTHZ_BODY.service === 'staff-api'
    && JSON.stringify(healthz.HEALTHZ_BODY)
      === JSON.stringify(contract.public_healthz_schema));

  ok('C3 staff-query-api wires handleStaffApiHealthz',
    /require\('\.\/lib\/staff-api-healthz'\)/.test(apiSrc)
    && /handleStaffApiHealthz\(res, sendJSON\)/.test(apiSrc)
    && /pathname === HEALTHZ_PATH/.test(apiSrc)
    && !/resolveLunaAiHealthSummary/.test(apiSrc)
    && !/getStormglassConfigStatus\(\)/.test(apiSrc));

  ok('C4 /healthz remains DB-independent in source', (() => {
    const i = apiSrc.indexOf('pathname === HEALTHZ_PATH');
    const block = apiSrc.slice(i, i + 350);
    return /handleStaffApiHealthz/.test(block)
      && !/withPgClient/.test(block)
      && !/handleStaffApiReadyz/.test(block)
      && !/SELECT 1/.test(block)
      && !/getReadinessPool/.test(block);
  })());

  ok('C5 /readyz wiring preserved',
    /pathname === READYZ_PATH/.test(apiSrc)
    && /handleStaffApiReadyz\(res, sendJSON, withPgClient/.test(apiSrc)
    && apiSrc.indexOf('pathname === READYZ_PATH')
      < apiSrc.indexOf('pathname === HEALTHZ_PATH'));

  ok('C6 authenticated AI diagnostics route preserved',
    /pathname === '\/staff\/ask-luna\/ai-status'/.test(apiSrc)
    && /handleAskLunaAiStatus/.test(apiSrc)
    && /resolveLunaAiDiagnostics/.test(apiSrc));

  ok('C7 healthz lib has no env/provider introspection',
    !/process\.env/.test(healthzSrc)
    && !/resolveLunaAi/.test(healthzSrc)
    && !/getStormglassConfigStatus|hasStormglassConfig/.test(healthzSrc)
    && !/require\([^)]*stormglass/.test(healthzSrc)
    && !/require\([^)]*luna-ai-provider/.test(healthzSrc));

  ok('C8 sendJSON Cache-Control no-store present',
    /function sendJSON\(/.test(apiSrc)
    && /'Cache-Control':\s*'no-store'/.test(apiSrc));

  const sec = secretFree([
    healthzSrc,
    readText(CONTRACT_REL),
    readText('scripts/lib/radar-slice16k-staff-api-healthz.js'),
  ].join('\n'), '16k artifacts');
  ok('C9 secret-free 16K artifacts', sec.ok, sec.detail);

  ok('C10 readiness lib READY_BODY unchanged',
    /const READY_BODY = Object\.freeze\(\{ status: 'ready' \}\)/.test(readinessSrc)
    && readiness.READY_BODY.status === 'ready'
    && readiness.NOT_READY_BODY.status === 'not-ready');

  {
    const fat = {
      status: 'ok',
      service: 'staff-api',
      auth_enabled: true,
      stage: '7.7b',
      stormglass: { configured: true },
      luna_ai: { provider: 'openai', model: 'gpt-4o-mini', key_present: true },
      note: 'internal',
    };
    const r = healthz.assertPublicHealthzBody(fat);
    red('fat_healthz_body_rejected', r.ok === false);
  }
  {
    red('auth_enabled_field_rejected',
      healthz.assertPublicHealthzBody({
        status: 'ok', service: 'staff-api', auth_enabled: true,
      }).ok === false);
  }
  {
    red('luna_ai_field_rejected',
      healthz.assertPublicHealthzBody({
        status: 'ok', service: 'staff-api', luna_ai: { provider: 'openai' },
      }).ok === false);
  }
  {
    red('stormglass_field_rejected',
      healthz.assertPublicHealthzBody({
        status: 'ok', service: 'staff-api', stormglass: { configured: true },
      }).ok === false);
  }
  {
    red('stage_note_fields_rejected',
      healthz.assertPublicHealthzBody({
        status: 'ok', service: 'staff-api', stage: '7.7b', note: 'x',
      }).ok === false);
  }
  {
    red('tenant_provider_model_key_rejected',
      healthz.assertPublicHealthzBody({
        status: 'ok',
        service: 'staff-api',
        tenant_slug: 'wolfhouse',
        provider: 'openai',
        model: 'gpt-4o-mini',
        key_fingerprint: 'abcd',
      }).ok === false);
  }
  {
    red('wrong_service_name_rejected',
      healthz.assertPublicHealthzBody({
        status: 'ok', service: 'wolfhouse-staff-query-api',
      }).ok === false);
  }
  {
    red('extra_unexpected_field_rejected',
      healthz.assertPublicHealthzBody({
        status: 'ok', service: 'staff-api', extra: 1,
      }).ok === false);
  }
  {
    const i = apiSrc.indexOf('pathname === HEALTHZ_PATH');
    const block = apiSrc.slice(i, i + 400);
    red('readyz_not_swapped_into_healthz',
      !/handleStaffApiReadyz/.test(block)
      && !/READYZ_PATH/.test(block)
      && /handleStaffApiHealthz/.test(block));
  }
  {
    red('authenticated_ai_status_route_preserved',
      /\/staff\/ask-luna\/ai-status/.test(apiSrc)
      && /requireAuth\(req, res, 'viewer'\)/.test(
        apiSrc.slice(
          apiSrc.indexOf("/staff/ask-luna/ai-status"),
          apiSrc.indexOf("/staff/ask-luna/ai-status") + 500,
        ),
      ));
  }

  {
    const { pool, shared: poolShared } = createTrackingReadinessPool();
    const dbSpy = createDbSpyWithPgClient();
    try {
      await withRealStaffApiServer({
        readinessPool: pool,
        withPgClient: dbSpy.withPgClient,
        ingressBinding: { tenant_slug: 'wolfhouse' },
      }, async ({ port }) => {
        const hz = await httpGet(port, '/healthz');
        let body;
        try { body = JSON.parse(hz.body); } catch { body = null; }
        const assert = healthz.assertPublicHealthzBody(body);
        const leak = bodyContainsAny(hz.body, [
          ...Object.values(CANARY),
          'auth_enabled',
          'stormglass',
          'luna_ai',
          'key_fingerprint',
          'key_present',
          'key_source',
          'wolfhouse-staff-query-api',
          '7.7b',
          'shadow-mode',
          'openai',
          'anthropic',
          'gpt-4o',
          'provider',
          'fingerprint',
        ]);
        green('real_listener_healthz_generic_schema',
          hz.statusCode === 200
          && assert.ok
          && JSON.stringify(body) === JSON.stringify(healthz.HEALTHZ_BODY),
          assert.detail || hz.body.slice(0, 200));
        green('real_listener_cache_control_no_store',
          /no-store/i.test(String(hz.headers['cache-control'] || '')),
          String(hz.headers['cache-control'] || ''));
        green('env_canaries_absent_from_healthz',
          leak === null,
          leak ? `leaked:${leak}` : '');
        green('no_unexpected_healthz_fields',
          body
          && Object.keys(body).sort().join(',') === 'service,status');

        const dbCallsBefore = dbSpy.shared.calls;
        const connectBefore = poolShared.connectCalls;
        const queryBefore = poolShared.queryCalls;
        await httpGet(port, '/healthz');
        green('healthz_no_db_call',
          dbSpy.shared.calls === dbCallsBefore
          && poolShared.connectCalls === connectBefore
          && poolShared.queryCalls === queryBefore,
          `db=${dbSpy.shared.calls - dbCallsBefore} `
          + `connect=${poolShared.connectCalls - connectBefore} `
          + `query=${poolShared.queryCalls - queryBefore}`);

        const ready = await httpGet(port, '/readyz');
        let readyBody;
        try { readyBody = JSON.parse(ready.body); } catch { readyBody = null; }
        green('readyz_unchanged_generic_body',
          ready.statusCode === 200
          && readyBody
          && readyBody.status === 'ready'
          && Object.keys(readyBody).length === 1
          && JSON.stringify(readyBody) === JSON.stringify(readiness.READY_BODY)
          && poolShared.connectCalls === connectBefore + 1
          && poolShared.queryCalls === queryBefore + 1);

        const root = await httpGet(port, '/', 8000, { Accept: 'application/json' });
        let rootBody;
        try { rootBody = JSON.parse(root.body); } catch { rootBody = null; }
        green('root_alias_same_generic_body',
          root.statusCode === 200
          && JSON.stringify(rootBody) === JSON.stringify(healthz.HEALTHZ_BODY)
          && /no-store/i.test(String(root.headers['cache-control'] || '')),
          `status=${root.statusCode} body=${String(root.body).slice(0, 200)}`);
      });
    } finally {
      await pool.end();
    }
  }

  {
    const { pool: poolA } = createTrackingReadinessPool();
    const { pool: poolB } = createTrackingReadinessPool();
    try {
      let bodyA = null;
      let bodyB = null;
      await withRealStaffApiServer({
        readinessPool: poolA,
        ingressBinding: { tenant_slug: 'wolfhouse' },
        env: { DEFAULT_CLIENT_SLUG: 'wolfhouse' },
      }, async ({ port }) => {
        const hz = await httpGet(port, '/healthz');
        bodyA = JSON.parse(hz.body);
      });
      await withRealStaffApiServer({
        readinessPool: poolB,
        ingressBinding: { tenant_slug: 'sunset' },
        env: { DEFAULT_CLIENT_SLUG: 'sunset' },
      }, async ({ port }) => {
        const hz = await httpGet(port, '/healthz');
        bodyB = JSON.parse(hz.body);
      });
      green('wolfhouse_sunset_same_generic_body',
        JSON.stringify(bodyA) === JSON.stringify(healthz.HEALTHZ_BODY)
        && JSON.stringify(bodyB) === JSON.stringify(healthz.HEALTHZ_BODY)
        && JSON.stringify(bodyA) === JSON.stringify(bodyB),
        `A=${JSON.stringify(bodyA)} B=${JSON.stringify(bodyB)}`);
    } finally {
      await poolA.end();
      await poolB.end();
    }
  }

  const redMissing = REQUIRED_RED.filter((id) => !redResults.some((r) => r.id === id && r.ok));
  const greenMissing = REQUIRED_GREEN.filter((id) => !greenResults.some((r) => r.id === id && r.ok));
  ok('R1 all required RED ids passed', redMissing.length === 0, redMissing.join(','));
  ok('G1 all required GREEN ids passed', greenMissing.length === 0, greenMissing.join(','));

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: ROOT, encoding: 'utf8',
    }).trim();
    // Successor 16L may own HEAD while 16K source remains frozen on master basis.
    const allowed = new Set([
      locks.BRANCH,
      'radar/slice-16l-capacity-pressure-alerts',
    ]);
    ok('C11 HEAD on 16K branch or successor 16L', allowed.has(branch), branch);
  } catch (err) {
    ok('C11 HEAD on 16K branch or successor 16L', false, String(err && err.message));
  }

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  console.log(`RED ${redResults.filter((r) => r.ok).length}/${REQUIRED_RED.length} `
    + `GREEN ${greenResults.filter((r) => r.ok).length}/${REQUIRED_GREEN.length}`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16K Staff API healthz minimization (source-partial): PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
