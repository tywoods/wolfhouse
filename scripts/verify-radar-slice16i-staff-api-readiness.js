'use strict';

/**
 * verify:radar-slice16i-staff-api-readiness — RADAR Slice 16I
 *
 * Offline RED/GREEN gate for Staff API /readyz + ACA probes (Wolfhouse + Sunset).
 * Runtime proofs use real createStaffQueryApiHttpServer/router (fortress dual-gate)
 * and a dedicated readiness Pool (pg 8.21) with a fake Client.
 * No signal/shutdown framework proofs. No live deploy, no Azure mutation, no secrets.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16i-staff-api-readiness');
const readiness = require('./lib/staff-api-readiness');

const MASTER = locks.MASTER_BASIS;
const CONTRACT_REL = 'fixtures/radar-operations/slice16i-expected-contract.json';
const PROBE_FIXTURE_REL = 'fixtures/radar-operations/slice16i-probe-contract.json';

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

const REQUIRED_RED = [
  'missing_pool',
  'db_error_503',
  'hung_query_timeout_destroy',
  'pool_saturation_acquire_timeout',
  'repeated_timeout_waiting_zero',
  'app_pool_untouched',
  'no_sensitive_fields_on_result',
  'dml_ddl_query_rejected',
  'paths_not_swapped_in_source',
  'liveness_readyz_swap_rejected',
  'readiness_healthz_swap_rejected',
  'absent_probes_rejected',
  'wrong_probe_port_rejected',
  'wrong_probe_timings_rejected',
  'sunset_wolfhouse_drift_detected',
  'probe_interval_not_exceeding_bound_rejected',
];

const REQUIRED_GREEN = [
  'real_listener_readyz_200',
  'real_listener_healthz_200_static',
  'generic_ready_not_ready_bodies',
  'pg_pool_max1_idle_reuse_release_once',
  'pg_pool_error_then_success_no_guard_poison',
  'close_readiness_pool_idempotent',
  'compiled_wolfhouse_bicep_has_probes',
  'compiled_sunset_bicep_has_probes',
  'probe_interval_exceeds_max_operation_bound',
  'bounded_pool_contract_locked',
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

function bodyHasSensitiveLeak(bodyText, extras = []) {
  const needles = [
    'password',
    'Connection refused',
    'ECONNREFUSED',
    'stack',
    'SELECT 1',
    'postgres' + '://',
    'postgresql' + '://',
    'WOLFHOUSE_DATABASE_URL',
    'at Object.',
    'Error:',
    ...extras,
  ];
  const lower = String(bodyText || '').toLowerCase();
  for (const n of needles) {
    if (lower.includes(String(n).toLowerCase())) return true;
  }
  return false;
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

function httpGet(port, reqPath, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: reqPath,
      method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, body });
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
      || /pg-connect\.js$/.test(key)) {
      delete require.cache[key];
    }
  }
}

function applyMinimalStaffApiEnv() {
  process.env.NODE_ENV = 'test';
  process.env.STAFF_RUNTIME_PROFILE = 'test';
  process.env.STAFF_AUTH_REQUIRED = 'true';
  process.env.STAFF_AUTH_HTTPS = 'false';
  process.env.STAFF_QUERY_API_HOST = '127.0.0.1';
  process.env.LUNA_BOT_INTERNAL_TOKEN = 'radar16i_bot_token_offline_test_01';
  process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = '1';
}

/**
 * Fake Client that participates in real pg-pool connect/queue/release wrapping.
 * Honors connectionTimeoutMillis (via pool) and query_timeout / statement_timeout.
 */
function createFakeClientClass(shared) {
  const state = shared || {
    connectCalls: 0,
    queryCalls: 0,
    endCalls: 0,
    destroyCalls: 0,
    releaseWithErr: 0,
    releaseClean: 0,
    hungQuery: false,
    connectError: null,
    queryError: null,
    hangConnect: false,
    constructed: 0,
  };

  class FakeClient extends EventEmitter {
    constructor(opts = {}) {
      super();
      state.constructed += 1;
      this.options = opts;
      this._queryable = true;
      this._ending = false;
      this._connected = false;
      this._queryTimeoutTimer = null;
      this.connection = {
        stream: {
          destroy: () => {
            state.destroyCalls += 1;
            this._queryable = false;
            this._ending = true;
          },
        },
      };
    }

    isConnected() {
      return this._connected;
    }

    unref() { /* pool allowExitOnIdle */ }

    connect(cb) {
      state.connectCalls += 1;
      if (state.hangConnect) {
        return;
      }
      if (state.connectError) {
        const err = state.connectError;
        process.nextTick(() => cb(err));
        return;
      }
      this._connected = true;
      this._queryable = true;
      process.nextTick(() => cb(null));
    }

    _effectiveQueryTimeoutMs() {
      const qt = Number(this.options.query_timeout
        || (this.options.connectionParameters && this.options.connectionParameters.query_timeout)
        || 0);
      const st = Number(this.options.statement_timeout
        || (this.options.connectionParameters && this.options.connectionParameters.statement_timeout)
        || 0);
      const positives = [qt, st].filter((n) => Number.isFinite(n) && n > 0);
      if (!positives.length) return 0;
      return Math.min(...positives);
    }

    query(sqlConfig, values, cb) {
      state.queryCalls += 1;
      let text = sqlConfig;
      let callback = cb;
      if (typeof sqlConfig === 'object' && sqlConfig !== null) {
        text = sqlConfig.text;
        callback = typeof values === 'function' ? values : cb;
      } else if (typeof values === 'function') {
        callback = values;
      }

      const queryTimeout = this._effectiveQueryTimeoutMs();

      const run = () => {
        if (state.queryError) {
          const err = state.queryError;
          if (callback) callback(err);
          return Promise.reject(err);
        }
        if (text !== readiness.READINESS_SQL && text !== 'SELECT 1') {
          const err = new Error(`unexpected sql ${text}`);
          if (callback) callback(err);
          return Promise.reject(err);
        }
        const result = { rows: [{ '?column?': 1 }] };
        if (callback) callback(null, result);
        return Promise.resolve(result);
      };

      if (state.hungQuery) {
        return new Promise((resolve, reject) => {
          const finishErr = (err) => {
            if (this._queryTimeoutTimer) {
              clearTimeout(this._queryTimeoutTimer);
              this._queryTimeoutTimer = null;
            }
            if (callback) callback(err);
            reject(err);
          };
          if (queryTimeout > 0) {
            this._queryTimeoutTimer = setTimeout(() => {
              finishErr(new Error('Query read timeout'));
            }, queryTimeout);
          }
          this.once('_forceFail', finishErr);
        });
      }

      return run();
    }

    end(cb) {
      state.endCalls += 1;
      this._ending = true;
      this._queryable = false;
      if (typeof cb === 'function') process.nextTick(cb);
    }
  }

  FakeClient._state = state;
  return FakeClient;
}

function createFakeClientReadinessPool(overrides = {}) {
  const shared = overrides.shared || createFakeClientClass()._state;
  if (!overrides.shared) {
    Object.assign(shared, {
      connectCalls: 0,
      queryCalls: 0,
      endCalls: 0,
      destroyCalls: 0,
      releaseWithErr: 0,
      releaseClean: 0,
      constructed: 0,
      hungQuery: !!overrides.hungQuery,
      hangConnect: !!overrides.hangConnect,
      connectError: overrides.connectError || null,
      queryError: overrides.queryError || null,
    });
  } else {
    if (overrides.hungQuery != null) shared.hungQuery = overrides.hungQuery;
    if (overrides.hangConnect != null) shared.hangConnect = overrides.hangConnect;
    if (overrides.connectError !== undefined) shared.connectError = overrides.connectError;
    if (overrides.queryError !== undefined) shared.queryError = overrides.queryError;
  }
  const FakeClient = createFakeClientClass(shared);
  const timeoutMs = overrides.timeoutMs != null ? overrides.timeoutMs : 200;
  const pool = new Pool(readiness.readinessPoolOptions({
    Client: FakeClient,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs,
    host: '127.0.0.1',
    port: 1,
    database: 'radar16i_fake',
    user: 'radar16i',
    password: 'x',
  }));

  pool.on('release', (err) => {
    if (err) shared.releaseWithErr += 1;
    else shared.releaseClean += 1;
  });

  return { pool, shared, FakeClient };
}

function createAppPoolProbe() {
  const stats = { connectCalls: 0, waitingPeak: 0 };
  const FakeClient = createFakeClientClass();
  const pool = new Pool({
    Client: FakeClient,
    max: 2,
    connectionTimeoutMillis: 5000,
    host: '127.0.0.1',
    port: 1,
    database: 'app_fake',
    user: 'app',
    password: 'x',
  });
  const origConnect = pool.connect.bind(pool);
  pool.connect = (...args) => {
    stats.connectCalls += 1;
    stats.waitingPeak = Math.max(stats.waitingPeak, pool.waitingCount);
    return origConnect(...args);
  };
  return { pool, stats };
}

async function endPool(pool) {
  if (!pool || typeof pool.end !== 'function') return;
  try {
    await pool.end();
  } catch (_) { /* ignore */ }
}

function bicepBuild(rel) {
  const outDir = path.join(ROOT, 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `radar-16i-${path.basename(path.dirname(rel))}.json`);
  execFileSync(
    'az',
    ['bicep', 'build', '--file', path.join(ROOT, rel), '--outfile', out],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `/opt/data/.local/bin:${process.env.PATH || ''}`,
        DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return out;
}

function mutateProbesAbsent(text) {
  const block = locks.extractProbesBlock(text);
  if (!block) return text;
  return text.replace(block, '/* probes removed by RED */');
}

function mutateProbeTiming(text) {
  return text
    .replace(/initialDelaySeconds:\s*30/, 'initialDelaySeconds: 1')
    .replace(/periodSeconds:\s*20/, 'periodSeconds: 1');
}

function mutateReadinessPathToHealthz(text) {
  const block = locks.extractProbesBlock(text);
  if (!block) return text;
  const swapped = block.replace(
    /type:\s*'Readiness'([\s\S]*?)path:\s*'\/readyz'/,
    "type: 'Readiness'$1path: '/healthz'",
  );
  return text.replace(block, swapped);
}

function mutateLivenessToReadyz(text) {
  const block = locks.extractProbesBlock(text);
  if (!block) return text;
  const swapped = block.replace(
    /type:\s*'Liveness'([\s\S]*?)path:\s*'\/healthz'/,
    "type: 'Liveness'$1path: '/readyz'",
  );
  return text.replace(block, swapped);
}

function mutateReadinessPeriodTooShort(text) {
  const block = locks.extractProbesBlock(text);
  if (!block) return text;
  // periodSeconds: 1 → 1000ms < max operation bound 3500ms
  const swapped = block.replace(
    /type:\s*'Readiness'([\s\S]*?)periodSeconds:\s*10/,
    "type: 'Readiness'$1periodSeconds: 1",
  );
  return text.replace(block, swapped);
}

async function withRealStaffApiServer(seams, fn) {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    STAFF_RUNTIME_PROFILE: process.env.STAFF_RUNTIME_PROFILE,
    STAFF_AUTH_REQUIRED: process.env.STAFF_AUTH_REQUIRED,
    STAFF_AUTH_HTTPS: process.env.STAFF_AUTH_HTTPS,
    STAFF_QUERY_API_HOST: process.env.STAFF_QUERY_API_HOST,
    LUNA_BOT_INTERNAL_TOKEN: process.env.LUNA_BOT_INTERNAL_TOKEN,
    STAFF_API_FORTRESS_OFFLINE_LISTENER: process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER,
  };
  applyMinimalStaffApiEnv();
  clearStaffApiCache();
  delete require.cache[require.resolve('./lib/staff-api-readiness')];
  const api = require('./staff-query-api');
  const readinessMod = require('./lib/staff-api-readiness');
  if (typeof api.createStaffQueryApiHttpServer !== 'function') {
    throw new Error('createStaffQueryApiHttpServer not exported — dual-gate inactive');
  }
  api.setFortress15j3OfflineSeams(seams || null);
  if (seams && seams.readinessPool) {
    readinessMod._setReadinessPoolForTests(seams.readinessPool);
  }
  const server = api.createStaffQueryApiHttpServer();
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

console.log('verify:radar-slice16i-staff-api-readiness — RADAR Slice 16I\n');

const contract = readJson(CONTRACT_REL);
const probeFixture = readJson(PROBE_FIXTURE_REL);
const apiSrc = readText(locks.STAFF_API_REL);
const readinessSrc = readText(locks.READINESS_LIB_REL);
const pgConnectSrc = readText('scripts/lib/pg-connect.js');
const whBicep = readText(locks.WOLFHOUSE_BICEP_REL);
const sunsetBicep = readText(locks.SUNSET_BICEP_REL);

ok('C1 contract pinned',
  contract.master_basis === MASTER
  && contract.outcome_id === locks.OUTCOME_ID
  && contract.gate_id === locks.GATE_ID
  && contract.progress_class === locks.PROGRESS_CLASS
  && contract.live_deploy === false
  && contract.live_mutation === false
  && contract.supersedes
  && contract.supersedes.tip_sha === locks.DEFERRED_16C.tip_sha
  && contract.supersedes.policy === locks.DEFERRED_16C.policy);

ok('C2 probe fixture matches locks',
  probeFixture.port === locks.PROBE_CONTRACT.port
  && probeFixture.startup.path === locks.PROBE_CONTRACT.startup.path
  && probeFixture.liveness.path === locks.PROBE_CONTRACT.liveness.path
  && probeFixture.readiness.path === locks.PROBE_CONTRACT.readiness.path
  && probeFixture.liveness.initialDelaySeconds === locks.PROBE_CONTRACT.liveness.initialDelaySeconds
  && probeFixture.readiness.periodSeconds === locks.PROBE_CONTRACT.readiness.periodSeconds
  && probeFixture.bounded_pool.max_operation_bound_ms === readiness.MAX_OPERATION_BOUND_MS);

ok('C3 readiness SQL locked to SELECT 1',
  readiness.READINESS_SQL === 'SELECT 1'
  && /const READINESS_SQL = 'SELECT 1'/.test(readinessSrc));

ok('C4 staff-query-api wires /readyz before /healthz via readiness pool',
  /pathname === READYZ_PATH/.test(apiSrc)
  && /handleStaffApiReadyz\(res, sendJSON, withPgClient/.test(apiSrc)
  && /getReadinessPool|readinessPool/.test(apiSrc)
  && apiSrc.indexOf('pathname === READYZ_PATH') < apiSrc.indexOf('pathname === HEALTHZ_PATH')
  && /require\('\.\/lib\/staff-api-readiness'\)/.test(apiSrc));

ok('C5 /healthz remains static (no readiness/pg in healthz block)', (() => {
  // 16K routes via HEALTHZ_PATH + handleStaffApiHealthz (still DB-independent).
  const marker = /pathname === HEALTHZ_PATH/.test(apiSrc)
    ? 'pathname === HEALTHZ_PATH'
    : "pathname === '/healthz'";
  const i = apiSrc.indexOf(marker);
  const block = apiSrc.slice(i, i + 600);
  return i >= 0
    && (/handleStaffApiHealthz/.test(block) || /status:\s*'ok'/.test(block))
    && !/handleStaffApiReadyz/.test(block)
    && !/checkPostgresReadiness/.test(block)
    && !/withPgClient/.test(block)
    && !/SELECT 1/.test(block);
})());

ok('C6 readiness lib never returns error details',
  /NOT_READY_BODY/.test(readinessSrc)
  && /status: 'not-ready'/.test(readinessSrc)
  && !/error:\s*err/.test(readinessSrc)
  && !/err\.message/.test(readinessSrc)
  && !/err\.stack/.test(readinessSrc)
  && !/JSON\.stringify\(err/.test(readinessSrc));

ok('C6b public pg 8.21 only — no private queue / race / abort / app pool',
  !/pool\._pendingQueue/.test(readinessSrc)
  && !/_pendingQueue\.splice/.test(readinessSrc)
  && !/pool\._clients/.test(readinessSrc)
  && !/pool\._idle/.test(readinessSrc)
  && /connectionTimeoutMillis/.test(readinessSrc)
  && /query_timeout/.test(readinessSrc)
  && /statement_timeout/.test(readinessSrc)
  && /max:\s*1/.test(readinessSrc)
  && /function createReadinessPool/.test(readinessSrc)
  && /client\.release\(err\)/.test(readinessSrc)
  && /let released = false/.test(readinessSrc)
  && /const releaseOnce = /.test(readinessSrc)
  && !/__staffApiReadinessReleased/.test(readinessSrc)
  && !/client\.__[A-Za-z]/.test(readinessSrc)
  && !/\bPromise\.race\s*\(/.test(readinessSrc)
  && !/\bAbortController\b/.test(readinessSrc)
  && /const \{ getConnectionString \} = require\('\.\/pg-connect'\)/.test(readinessSrc)
  && !/require\('\.\/pg-connect'\)[\s\S]{0,80}getPool/.test(readinessSrc)
  && !/require\('\.\/pg-connect'\)[\s\S]{0,80}withPgClient/.test(readinessSrc)
  && !/createReadyzTestListener/.test(readinessSrc));

ok('C6c no signal/shutdown framework in Staff API (16I scope)',
  !/attachStaffQueryApiLifecycle/.test(apiSrc)
  && !/process\.on\('SIGTERM'/.test(apiSrc)
  && !/process\.on\('SIGINT'/.test(apiSrc)
  && !/closePgPool/.test(apiSrc)
  && /closeReadinessPool/.test(readinessSrc)
  && /lifecycle_integration/.test(JSON.stringify(contract.lifecycle))
  && contract.lifecycle.lifecycle_integration === 'open'
  && contract.lifecycle.signal_shutdown_framework === 'absent_intentional');

ok('C6d closePgPool unchanged / not composed',
  !/closeReadinessPool/.test(pgConnectSrc)
  && /async function closePgPool\(\)/.test(pgConnectSrc)
  && !/timeoutMs/.test(pgConnectSrc));

ok('C6e bounded pool constants',
  readiness.CONNECTION_TIMEOUT_MS <= 1500
  && readiness.STATEMENT_TIMEOUT_MS <= 1500
  && readiness.QUERY_TIMEOUT_MS <= 2000
  && readiness.MAX_OPERATION_BOUND_MS
    === readiness.CONNECTION_TIMEOUT_MS + readiness.QUERY_TIMEOUT_MS
  && locks.PROBE_CONTRACT.readiness.periodSeconds * 1000
    > readiness.MAX_OPERATION_BOUND_MS);

const whProbe = locks.validateBicepProbeContract(whBicep);
const sunProbe = locks.validateBicepProbeContract(sunsetBicep);
ok('C7 Wolfhouse Bicep probe contract', whProbe.ok, whProbe.detail);
ok('C8 Sunset Bicep probe contract', sunProbe.ok, sunProbe.detail);
ok('C9 Wolfhouse/Sunset probe blocks identical (no drift)',
  whProbe.ok && sunProbe.ok && whProbe.block === sunProbe.block);

ok('C10 drill + lifecycle remain open',
  contract.final_controlled_drill
  && contract.final_controlled_drill.status === 'open'
  && contract.final_controlled_drill.id === '16I_DRILL_readiness_failure_traffic_shed'
  && Array.isArray(contract.still_open)
  && contract.still_open.length >= 3
  && contract.still_open.some((s) => /lifecycle/i.test(s)));

const pkg = readJson('package.json');
ok('C11 npm script registered',
  pkg.scripts['verify:radar-slice16i-staff-api-readiness']
  === 'node scripts/verify-radar-slice16i-staff-api-readiness.js');

(async () => {
  const keepAlive = setInterval(() => {}, 1000);

  {
    readiness._resetReadinessPoolStateForTests();
    readiness._setReadinessPoolForTests(null);
    await readiness.closeReadinessPool();
    const r = await readiness.checkPostgresReadiness(null, { getPool: () => null });
    red('missing_pool', r.ok === false);
    readiness._resetReadinessPoolStateForTests();
  }

  {
    const { pool, shared } = createFakeClientReadinessPool({
      timeoutMs: 300,
      connectError: new Error([
        'ECONNREFUSED',
        ' password=supersecret ',
        'postgres',
        '://wolf:hunter2@db:5432/wolfhouse',
      ].join('')),
    });
    try {
      await withRealStaffApiServer({ readinessPool: pool }, async ({ port }) => {
        const res = await httpGet(port, '/readyz');
        red('db_error_503',
          res.statusCode === 503
          && JSON.parse(res.body).status === 'not-ready'
          && !bodyHasSensitiveLeak(res.body, ['supersecret', 'hunter2'])
          && shared.connectCalls >= 1);
      });
    } finally {
      await endPool(pool);
    }
  }

  {
    const { pool, shared } = createFakeClientReadinessPool({
      timeoutMs: 150,
      hungQuery: true,
    });
    try {
      await withRealStaffApiServer({ readinessPool: pool }, async ({ port }) => {
        const started = Date.now();
        const res = await httpGet(port, '/readyz', 4000);
        const elapsed = Date.now() - started;
        await new Promise((r) => setTimeout(r, 50));
        red('hung_query_timeout_destroy',
          res.statusCode === 503
          && JSON.parse(res.body).status === 'not-ready'
          && elapsed < 2000
          && shared.releaseWithErr >= 1
          && pool.waitingCount === 0
          && pool.totalCount === 0
          && !bodyHasSensitiveLeak(res.body),
          `elapsed=${elapsed} releaseWithErr=${shared.releaseWithErr} total=${pool.totalCount} waiting=${pool.waitingCount}`);
      });
    } finally {
      await endPool(pool);
    }
  }

  {
    const { pool, shared } = createFakeClientReadinessPool({ timeoutMs: 120 });
    const held = await pool.connect();
    try {
      const started = Date.now();
      const r = await readiness.checkPostgresReadiness(null, { pool });
      const elapsed = Date.now() - started;
      held.release();
      await new Promise((r2) => setTimeout(r2, 30));
      red('pool_saturation_acquire_timeout',
        r.ok === false
        && elapsed < 800
        && pool.waitingCount === 0
        && pool.idleCount === 1
        && pool.totalCount === 1,
        `elapsed=${elapsed} waiting=${pool.waitingCount} idle=${pool.idleCount} total=${pool.totalCount} connects=${shared.connectCalls}`);
    } finally {
      try { held.release(); } catch (_) { /* may already be released */ }
      await endPool(pool);
    }
  }

  {
    const { pool } = createFakeClientReadinessPool({ timeoutMs: 80 });
    const app = createAppPoolProbe();
    const held = await pool.connect();
    const appBefore = {
      connect: app.stats.connectCalls,
      waiting: app.pool.waitingCount,
      total: app.pool.totalCount,
    };
    try {
      for (let i = 0; i < 8; i += 1) {
        await readiness.checkPostgresReadiness(null, { pool });
      }
      await new Promise((r2) => setTimeout(r2, 30));
      red('repeated_timeout_waiting_zero',
        pool.waitingCount === 0,
        `readyWaiting=${pool.waitingCount}`);
      red('app_pool_untouched',
        app.stats.connectCalls === appBefore.connect
        && app.pool.waitingCount === appBefore.waiting
        && app.pool.totalCount === appBefore.total,
        `appConnect=${app.stats.connectCalls} appWaiting=${app.pool.waitingCount}`);
    } finally {
      try { held.release(); } catch (_) { /* ignore */ }
      await endPool(pool);
      await endPool(app.pool);
    }
  }

  {
    const { pool } = createFakeClientReadinessPool({
      timeoutMs: 200,
      connectError: new Error('ECONNREFUSED password=supersecret'),
    });
    const r = await readiness.checkPostgresReadiness(null, { pool });
    red('no_sensitive_fields_on_result',
      r.ok === false
      && Object.keys(r).length === 1
      && !('error' in r)
      && !('message' in r)
      && !('stack' in r));
    await endPool(pool);
  }

  {
    const { pool } = createFakeClientReadinessPool({ timeoutMs: 200 });
    const badSqls = [
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET x=1',
      'DELETE FROM t',
      'DROP TABLE t',
      'ALTER TABLE t ADD c int',
      'SELECT 1; DELETE FROM t',
      'select 1',
      'SELECT 1 FROM users',
    ];
    let allRejected = true;
    for (const sql of badSqls) {
      const gate = readiness.assertReadOnlyReadinessSql(sql);
      const check = await readiness.checkPostgresReadiness(null, { pool, sql });
      if (gate.ok || check.ok) allRejected = false;
    }
    red('dml_ddl_query_rejected', allRejected);
    await endPool(pool);
  }

  {
    const healthIdx = apiSrc.indexOf('pathname === HEALTHZ_PATH');
    const healthBlock = apiSrc.slice(healthIdx, healthIdx + 500);
    const readyIdx = apiSrc.indexOf('pathname === READYZ_PATH');
    const readyBlock = apiSrc.slice(readyIdx, readyIdx + 350);
    const swappedHealthUsesReady = /handleStaffApiReadyz|checkPostgresReadiness|SELECT 1/.test(healthBlock);
    const readyUsesStaticOk = /status:\s*'ok'/.test(readyBlock) && !/handleStaffApiReadyz/.test(readyBlock);
    red('paths_not_swapped_in_source',
      healthIdx >= 0 && !swappedHealthUsesReady && !readyUsesStaticOk);

    const liveSwap = mutateLivenessToReadyz(whBicep);
    const liveCheck = locks.validateBicepProbeContract(liveSwap);
    red('liveness_readyz_swap_rejected', liveCheck.ok === false);

    const readySwap = mutateReadinessPathToHealthz(whBicep);
    const readyCheck = locks.validateBicepProbeContract(readySwap);
    red('readiness_healthz_swap_rejected', readyCheck.ok === false);
  }

  {
    const absent = mutateProbesAbsent(whBicep);
    const r = locks.validateBicepProbeContract(absent);
    red('absent_probes_rejected', r.ok === false && /absent|missing/i.test(String(r.detail || '')));
  }

  {
    const block = locks.extractProbesBlock(whBicep);
    const mutatedBlock = block.replace(/port:\s*3036/g, 'port: 8080');
    const mutated = whBicep.replace(block, mutatedBlock);
    const r = locks.validateBicepProbeContract(mutated);
    red('wrong_probe_port_rejected', r.ok === false, r.detail);
  }

  {
    const mutated = mutateProbeTiming(whBicep);
    const r = locks.validateBicepProbeContract(mutated);
    red('wrong_probe_timings_rejected', r.ok === false, r.detail);
  }

  {
    const drifted = sunsetBicep.replace(
      locks.extractProbesBlock(sunsetBicep),
      locks.extractProbesBlock(sunsetBicep).replace('periodSeconds: 20', 'periodSeconds: 99'),
    );
    const a = locks.validateBicepProbeContract(whBicep);
    const b = locks.validateBicepProbeContract(drifted);
    red('sunset_wolfhouse_drift_detected',
      a.ok === true
      && (b.ok === false || a.block !== b.block));
  }

  {
    // Static contract: readiness period must exceed max operation bound.
    const short = mutateReadinessPeriodTooShort(whBicep);
    const periodMatch = short.match(/type:\s*'Readiness'[\s\S]{0,200}periodSeconds:\s*(\d+)/);
    const periodSec = periodMatch ? Number(periodMatch[1]) : null;
    red('probe_interval_not_exceeding_bound_rejected',
      periodSec === 1
      && periodSec * 1000 <= readiness.MAX_OPERATION_BOUND_MS
      && locks.PROBE_CONTRACT.readiness.periodSeconds * 1000
        > readiness.MAX_OPERATION_BOUND_MS);
  }

  {
    const { pool } = createFakeClientReadinessPool({ timeoutMs: 500 });
    try {
      await withRealStaffApiServer({ readinessPool: pool }, async ({ port, api }) => {
        const ready = await httpGet(port, '/readyz');
        const live = await httpGet(port, '/healthz');
        const readyBody = JSON.parse(ready.body);
        const liveBody = JSON.parse(live.body);
        green('real_listener_readyz_200',
          ready.statusCode === 200
          && readyBody.status === 'ready'
          && !bodyHasSensitiveLeak(ready.body)
          && typeof api.createStaffQueryApiHttpServer === 'function'
          && typeof api.router === 'function'
          && pool.idleCount === 1
          && pool.totalCount === 1);
        green('real_listener_healthz_200_static',
          live.statusCode === 200
          && liveBody.status === 'ok'
          && !bodyHasSensitiveLeak(live.body));
        green('generic_ready_not_ready_bodies',
          JSON.stringify(readyBody) === JSON.stringify(readiness.READY_BODY)
          && Object.keys(readyBody).length === 1);
      });
    } finally {
      await endPool(pool);
    }
  }

  {
    // Actual installed pg-pool (max=1) + FakeClient: same healthy client reused
    // across consecutive real-listener /readyz — release once per checkout,
    // idle preserved, waitingCount=0, third acquisition succeeds.
    const { pool, shared } = createFakeClientReadinessPool({ timeoutMs: 500 });
    try {
      await withRealStaffApiServer({ readinessPool: pool }, async ({ port }) => {
        const r1 = await httpGet(port, '/readyz');
        const after1 = {
          status: r1.statusCode,
          body: JSON.parse(r1.body).status,
          releaseClean: shared.releaseClean,
          releaseWithErr: shared.releaseWithErr,
          constructed: shared.constructed,
          idle: pool.idleCount,
          total: pool.totalCount,
          waiting: pool.waitingCount,
        };
        const r2 = await httpGet(port, '/readyz');
        const after2 = {
          status: r2.statusCode,
          body: JSON.parse(r2.body).status,
          releaseClean: shared.releaseClean,
          releaseWithErr: shared.releaseWithErr,
          constructed: shared.constructed,
          idle: pool.idleCount,
          total: pool.totalCount,
          waiting: pool.waitingCount,
        };
        let thirdOk = false;
        let thirdWaiting = -1;
        let thirdIdleBeforeRelease = -1;
        const releaseCleanBeforeThird = shared.releaseClean;
        const third = await pool.connect();
        try {
          thirdWaiting = pool.waitingCount;
          thirdIdleBeforeRelease = pool.idleCount;
          thirdOk = true;
        } finally {
          third.release();
        }
        await new Promise((r) => setTimeout(r, 20));
        green('pg_pool_max1_idle_reuse_release_once',
          after1.status === 200 && after1.body === 'ready'
          && after2.status === 200 && after2.body === 'ready'
          && after1.releaseClean === 1 && after2.releaseClean === 2
          && after1.releaseWithErr === 0 && after2.releaseWithErr === 0
          && after1.constructed === 1 && after2.constructed === 1
          && after1.idle === 1 && after2.idle === 1
          && after1.total === 1 && after2.total === 1
          && after1.waiting === 0 && after2.waiting === 0
          && releaseCleanBeforeThird === 2
          && thirdOk === true
          && thirdWaiting === 0
          && thirdIdleBeforeRelease === 0
          && pool.waitingCount === 0
          && pool.idleCount === 1
          && pool.totalCount === 1
          && shared.constructed === 1,
          `after1=${JSON.stringify(after1)} after2=${JSON.stringify(after2)} `
          + `releaseCleanBeforeThird=${releaseCleanBeforeThird} `
          + `thirdOk=${thirdOk} thirdWaiting=${thirdWaiting} thirdIdle=${thirdIdleBeforeRelease} `
          + `idle=${pool.idleCount} waiting=${pool.waitingCount} `
          + `releaseClean=${shared.releaseClean} constructed=${shared.constructed}`);
      });
    } finally {
      await endPool(pool);
    }
  }

  {
    // Sequential error then success: destroy via release(err) once, then a fresh
    // checkout succeeds — prior closure-local guard must not poison the next.
    const { pool, shared } = createFakeClientReadinessPool({
      timeoutMs: 300,
      queryError: new Error('readiness probe boom'),
    });
    try {
      await withRealStaffApiServer({ readinessPool: pool }, async ({ port }) => {
        const failRes = await httpGet(port, '/readyz');
        await new Promise((r) => setTimeout(r, 30));
        const afterFail = {
          status: failRes.statusCode,
          body: JSON.parse(failRes.body).status,
          releaseWithErr: shared.releaseWithErr,
          releaseClean: shared.releaseClean,
          constructed: shared.constructed,
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        };
        shared.queryError = null;
        const okRes = await httpGet(port, '/readyz');
        await new Promise((r) => setTimeout(r, 20));
        const afterOk = {
          status: okRes.statusCode,
          body: JSON.parse(okRes.body).status,
          releaseWithErr: shared.releaseWithErr,
          releaseClean: shared.releaseClean,
          constructed: shared.constructed,
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        };
        green('pg_pool_error_then_success_no_guard_poison',
          afterFail.status === 503 && afterFail.body === 'not-ready'
          && afterFail.releaseWithErr === 1
          && afterFail.releaseClean === 0
          && afterFail.constructed >= 1
          && afterFail.total === 0
          && afterFail.waiting === 0
          && afterOk.status === 200 && afterOk.body === 'ready'
          && afterOk.releaseWithErr === 1
          && afterOk.releaseClean === 1
          && afterOk.constructed === afterFail.constructed + 1
          && afterOk.idle === 1
          && afterOk.total === 1
          && afterOk.waiting === 0
          && !bodyHasSensitiveLeak(failRes.body)
          && !bodyHasSensitiveLeak(okRes.body),
          `afterFail=${JSON.stringify(afterFail)} afterOk=${JSON.stringify(afterOk)}`);
      });
    } finally {
      await endPool(pool);
    }
  }

  {
    readiness._resetReadinessPoolStateForTests();
    const { pool } = createFakeClientReadinessPool({ timeoutMs: 300 });
    readiness._setReadinessPoolForTests(pool);
    await readiness.closeReadinessPool();
    await readiness.closeReadinessPool();
    await readiness.closeReadinessPool();
    green('close_readiness_pool_idempotent',
      readiness._getReadinessPoolForTests() === null
      && readiness.getReadinessPool() === null);
    readiness._resetReadinessPoolStateForTests();
  }

  {
    try {
      const outWh = bicepBuild(locks.WOLFHOUSE_BICEP_REL);
      const compiledWh = JSON.parse(fs.readFileSync(outWh, 'utf8'));
      const tpl = JSON.stringify(compiledWh);
      green('compiled_wolfhouse_bicep_has_probes',
        fs.existsSync(outWh)
        && /"type"\s*:\s*"Liveness"/.test(tpl)
        && /"type"\s*:\s*"Readiness"/.test(tpl)
        && /"type"\s*:\s*"Startup"/.test(tpl)
        && /"path"\s*:\s*"\/readyz"/.test(tpl)
        && /"path"\s*:\s*"\/healthz"/.test(tpl)
        && /"port"\s*:\s*3036/.test(tpl));
    } catch (err) {
      green('compiled_wolfhouse_bicep_has_probes', false,
        String(err && err.stderr || err.message || err).slice(0, 500));
    }
  }

  {
    try {
      const outSun = bicepBuild(locks.SUNSET_BICEP_REL);
      const compiledSun = JSON.parse(fs.readFileSync(outSun, 'utf8'));
      const tpl = JSON.stringify(compiledSun);
      green('compiled_sunset_bicep_has_probes',
        fs.existsSync(outSun)
        && /"type"\s*:\s*"Liveness"/.test(tpl)
        && /"type"\s*:\s*"Readiness"/.test(tpl)
        && /"path"\s*:\s*"\/readyz"/.test(tpl)
        && /"path"\s*:\s*"\/healthz"/.test(tpl)
        && /"port"\s*:\s*3036/.test(tpl));
    } catch (err) {
      green('compiled_sunset_bicep_has_probes', false,
        String(err && err.stderr || err.message || err).slice(0, 500));
    }
  }

  green('probe_interval_exceeds_max_operation_bound',
    locks.PROBE_CONTRACT.readiness.periodSeconds * 1000
      > readiness.MAX_OPERATION_BOUND_MS
    && probeFixture.readiness.periodSeconds * 1000
      > probeFixture.bounded_pool.max_operation_bound_ms);

  green('bounded_pool_contract_locked',
    readiness.CONNECTION_TIMEOUT_MS === 1500
    && readiness.STATEMENT_TIMEOUT_MS === 1500
    && readiness.QUERY_TIMEOUT_MS === 2000
    && readiness.MAX_OPERATION_BOUND_MS === 3500
    && /connectionTimeoutMillis:\s*CONNECTION_TIMEOUT_MS/.test(readinessSrc)
    && /statement_timeout:\s*STATEMENT_TIMEOUT_MS/.test(readinessSrc)
    && /query_timeout:\s*QUERY_TIMEOUT_MS/.test(readinessSrc));

  const ownedSec = locks.OWNED_RELS.every((rel) => {
    const text = readText(rel);
    return secretFree(text, rel).ok;
  });
  ok('C12 owned artifacts secret-free', ownedSec);

  const redIds = redResults.map((r) => r.id);
  const greenIds = greenResults.map((r) => r.id);
  ok('C13 all required RED ids ran',
    REQUIRED_RED.every((id) => redIds.includes(id)),
    `missing=${REQUIRED_RED.filter((id) => !redIds.includes(id)).join(',')}`);
  ok('C14 all required GREEN ids ran',
    REQUIRED_GREEN.every((id) => greenIds.includes(id)),
    `missing=${REQUIRED_GREEN.filter((id) => !greenIds.includes(id)).join(',')}`);
  ok('C15 all RED passed', redResults.every((r) => r.ok));
  ok('C16 all GREEN passed', greenResults.every((r) => r.ok));

  clearInterval(keepAlive);

  console.log(`\nRED: ${redResults.filter((r) => r.ok).length}/${redResults.length}  GREEN: ${greenResults.filter((r) => r.ok).length}/${greenResults.length}`);
  console.log(`Result: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16I Staff API readiness (source-partial): PASS');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
