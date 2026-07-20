'use strict';

/**
 * verify:radar-slice16c-staff-api-readiness — RADAR Slice 16C
 *
 * Offline RED/GREEN gate for Staff API /readyz + ACA probes (Wolfhouse + Sunset).
 * Runtime proofs use real createStaffQueryApiHttpServer/router (fortress dual-gate),
 * dedicated readiness Pool (pg 8.21) with a fake Client, and real signal handlers.
 * No live deploy, no Azure mutation, no real secrets.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16c-staff-api-readiness');
const readiness = require('./lib/staff-api-readiness');

const MASTER = locks.MASTER_BASIS;
const CONTRACT_REL = 'fixtures/radar-operations/slice16c-expected-contract.json';
const PROBE_FIXTURE_REL = 'fixtures/radar-operations/slice16c-probe-contract.json';

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
  process.env.LUNA_BOT_INTERNAL_TOKEN = 'radar16c_bot_token_offline_test_01';
  process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = '1';
}

/**
 * Fake Client that participates in real pg-pool connect/queue/release wrapping.
 * Honors connectionTimeoutMillis (via pool) and query_timeout (client-side).
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
    hangEnd: false,
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
        // Never connects — pool connectionTimeoutMillis must tear down.
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

      const queryTimeout = this.options.query_timeout
        || (this.options.connectionParameters && this.options.connectionParameters.query_timeout)
        || 0;

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
          // Intentionally never resolves on success path while hung.
          this.once('_forceFail', finishErr);
        });
      }

      if (queryTimeout > 0 && state.slowQueryMs && state.slowQueryMs > queryTimeout) {
        return new Promise((resolve, reject) => {
          this._queryTimeoutTimer = setTimeout(() => {
            const err = new Error('Query read timeout');
            if (callback) callback(err);
            reject(err);
          }, queryTimeout);
        });
      }

      return run();
    }

    end(cb) {
      state.endCalls += 1;
      this._ending = true;
      this._queryable = false;
      if (state.hangEnd) {
        return;
      }
      if (typeof cb === 'function') process.nextTick(cb);
    }
  }

  FakeClient._state = state;
  return FakeClient;
}

/**
 * Real pg.Pool with FakeClient — exercises actual queue/timeout/release behavior.
 */
function createFakeClientReadinessPool(overrides = {}) {
  const shared = overrides.shared || createFakeClientClass()._state;
  // reset counters if reusing factory defaults
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
      hangEnd: !!overrides.hangEnd,
      connectError: overrides.connectError || null,
      queryError: overrides.queryError || null,
      slowQueryMs: overrides.slowQueryMs || 0,
    });
  } else {
    if (overrides.hungQuery != null) shared.hungQuery = overrides.hungQuery;
    if (overrides.hangConnect != null) shared.hangConnect = overrides.hangConnect;
    if (overrides.hangEnd != null) shared.hangEnd = overrides.hangEnd;
    if (overrides.connectError !== undefined) shared.connectError = overrides.connectError;
    if (overrides.queryError !== undefined) shared.queryError = overrides.queryError;
  }
  const FakeClient = createFakeClientClass(shared);
  const timeoutMs = overrides.timeoutMs != null ? overrides.timeoutMs : 200;
  const pool = new Pool(readiness.readinessPoolOptions(timeoutMs, {
    Client: FakeClient,
    // No real connection string — FakeClient never dials the network.
    host: '127.0.0.1',
    port: 1,
    database: 'radar16c_fake',
    user: 'radar16c',
    password: 'x',
  }));

  // Wrap release via pool 'release' event to count destroy vs idle returns.
  pool.on('release', (err) => {
    if (err) shared.releaseWithErr += 1;
    else shared.releaseClean += 1;
  });

  return { pool, shared, FakeClient };
}

/** Separate application pool stand-in to prove readiness never consumes it. */
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

function bicepBuild(rel) {
  const outDir = path.join(ROOT, 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `radar-16c-${path.basename(path.dirname(rel))}.json`);
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

function mutateProbePort(text, badPort) {
  return text.replace(/port:\s*3036/g, `port: ${badPort}`);
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

console.log('verify:radar-slice16c-staff-api-readiness — RADAR Slice 16C\n');

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
  && contract.live_mutation === false);

ok('C2 probe fixture matches locks',
  probeFixture.port === locks.PROBE_CONTRACT.port
  && probeFixture.startup.path === locks.PROBE_CONTRACT.startup.path
  && probeFixture.liveness.path === locks.PROBE_CONTRACT.liveness.path
  && probeFixture.readiness.path === locks.PROBE_CONTRACT.readiness.path
  && probeFixture.liveness.initialDelaySeconds === locks.PROBE_CONTRACT.liveness.initialDelaySeconds
  && probeFixture.readiness.periodSeconds === locks.PROBE_CONTRACT.readiness.periodSeconds);

ok('C3 readiness SQL locked to SELECT 1',
  readiness.READINESS_SQL === 'SELECT 1'
  && /const READINESS_SQL = 'SELECT 1'/.test(readinessSrc));

ok('C4 staff-query-api wires /readyz before /healthz via readiness pool',
  /pathname === READYZ_PATH/.test(apiSrc)
  && /handleStaffApiReadyz\(res, sendJSON, withPgClient/.test(apiSrc)
  && /getReadinessPool|readinessPool/.test(apiSrc)
  && apiSrc.indexOf("pathname === READYZ_PATH") < apiSrc.indexOf("pathname === '/healthz'")
  && /require\('\.\/lib\/staff-api-readiness'\)/.test(apiSrc));

ok('C5 /healthz remains static (no readiness/pg in healthz block)', (() => {
  const i = apiSrc.indexOf("pathname === '/healthz'");
  const block = apiSrc.slice(i, i + 600);
  return /status:\s*'ok'/.test(block)
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

ok('C6b public pg 8.21 only — no private queue/connection splice',
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
  && !/\bPromise\.race\s*\(/.test(readinessSrc)
  && !/createReadyzTestListener/.test(readinessSrc));

ok('C6c graceful SIGTERM/SIGINT lifecycle present (bounded)',
  /function attachStaffQueryApiLifecycle/.test(apiSrc)
  && /process\.on\('SIGTERM'/.test(apiSrc)
  && /process\.on\('SIGINT'/.test(apiSrc)
  && /closeReadinessPool/.test(apiSrc)
  && /closePgPool/.test(apiSrc)
  && /closeIdleConnections|closeIdleConnections/.test(apiSrc)
  && /closeAllConnections|forceCloseRemainingConnections|socket\.destroy/.test(apiSrc)
  && /installSignalHandlers/.test(apiSrc)
  && /require\.main === module[\s\S]*attachStaffQueryApiLifecycle/.test(apiSrc)
  && /endPgPoolBounded|timeoutMs/.test(pgConnectSrc));

const whProbe = locks.validateBicepProbeContract(whBicep);
const sunProbe = locks.validateBicepProbeContract(sunsetBicep);
ok('C7 Wolfhouse Bicep probe contract', whProbe.ok, whProbe.detail);
ok('C8 Sunset Bicep probe contract', sunProbe.ok, sunProbe.detail);
ok('C9 Wolfhouse/Sunset probe blocks identical (no drift)',
  whProbe.ok && sunProbe.ok && whProbe.block === sunProbe.block);

ok('C10 drill remains open',
  contract.final_controlled_drill
  && contract.final_controlled_drill.status === 'open'
  && contract.final_controlled_drill.id === '16C_DRILL_readiness_failure_traffic_shed'
  && Array.isArray(contract.still_open)
  && contract.still_open.length >= 2);

const pkg = readJson('package.json');
ok('C11 npm script registered',
  pkg.scripts['verify:radar-slice16c-staff-api-readiness']
  === 'node scripts/verify-radar-slice16c-staff-api-readiness.js');

// ── RED ─────────────────────────────────────────────────────────────────────

(async () => {
  // pg-pool unrefs connectionTimeoutMillis timers; keep the event loop alive for
  // offline saturation proofs that rely solely on those public timeouts.
  const keepAlive = setInterval(() => {}, 1000);

  // RED: missing pool
  {
    readiness._resetReadinessPoolStateForTests();
    readiness._setReadinessPoolForTests(null);
    // Force closed so getReadinessPool returns null
    await readiness.closeReadinessPool({ timeoutMs: 10 });
    const r = await readiness.checkPostgresReadiness(null, { getPool: () => null });
    red('missing_pool', r.ok === false);
    readiness._resetReadinessPoolStateForTests();
  }

  // RED: DB connect error → not-ready, no leak (real server + readiness pool path)
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
      await readiness.endPoolBounded(pool, 200);
    }
  }

  // RED: hung query → query_timeout + release(err) destroy once (real pool path)
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
        red('hung_query_cancel_cleanup',
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
      await readiness.endPoolBounded(pool, 200);
    }
  }

  // RED: late acquire after connectionTimeout — waiter removed by public pool behavior
  {
    const { pool, shared } = createFakeClientReadinessPool({ timeoutMs: 120 });
    const held = await pool.connect();
    try {
      const started = Date.now();
      const r = await readiness.checkPostgresReadiness(null, { pool, timeoutMs: 120 });
      const elapsed = Date.now() - started;
      // Late release of held client must not leave a pending timed-out waiter
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
      await readiness.endPoolBounded(pool, 200);
    }
  }

  // RED: repeated saturation — no waiter accumulation; application pool untouched
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
        await readiness.checkPostgresReadiness(null, { pool, timeoutMs: 80 });
      }
      await new Promise((r2) => setTimeout(r2, 30));
      red('repeated_timeout_no_pool_exhaustion',
        pool.waitingCount === 0
        && app.stats.connectCalls === appBefore.connect
        && app.pool.waitingCount === appBefore.waiting
        && app.pool.totalCount === appBefore.total,
        `readyWaiting=${pool.waitingCount} appConnect=${app.stats.connectCalls} appWaiting=${app.pool.waitingCount}`);
    } finally {
      try { held.release(); } catch (_) { /* ignore */ }
      await readiness.endPoolBounded(pool, 200);
      await readiness.endPoolBounded(app.pool, 200);
    }
  }

  // RED: late acquire after timeout preserves healthy idle client
  {
    const { pool } = createFakeClientReadinessPool({ timeoutMs: 100 });
    const held = await pool.connect();
    const pending = readiness.checkPostgresReadiness(null, { pool, timeoutMs: 100 });
    await new Promise((r) => setTimeout(r, 130));
    const r = await pending;
    held.release();
    await new Promise((r2) => setTimeout(r2, 40));
    // Healthy client returned to idle — not destroyed by late timed-out waiter
    const healthy = await readiness.checkPostgresReadiness(null, { pool, timeoutMs: 200 });
    red('late_acquire_healthy_client_preserved',
      r.ok === false
      && healthy.ok === true
      && pool.idleCount === 1
      && pool.totalCount === 1
      && pool.waitingCount === 0,
      `idle=${pool.idleCount} total=${pool.totalCount} healthy=${healthy.ok}`);
    await readiness.endPoolBounded(pool, 200);
  }

  // RED: sensitive error leakage via checkPostgresReadiness return shape
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
    await readiness.endPoolBounded(pool, 200);
  }

  // RED: DML/DDL query changes rejected
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
    await readiness.endPoolBounded(pool, 200);
  }

  // RED: swapped paths in source would fail static contract
  {
    const healthIdx = apiSrc.indexOf("pathname === '/healthz'");
    const healthBlock = apiSrc.slice(healthIdx, healthIdx + 500);
    const readyIdx = apiSrc.indexOf('pathname === READYZ_PATH');
    const readyBlock = apiSrc.slice(readyIdx, readyIdx + 350);
    const swappedHealthUsesReady = /handleStaffApiReadyz|checkPostgresReadiness|SELECT 1/.test(healthBlock);
    const readyUsesStaticOk = /status:\s*'ok'/.test(readyBlock) && !/handleStaffApiReadyz/.test(readyBlock);
    red('paths_not_swapped_in_source', !swappedHealthUsesReady && !readyUsesStaticOk);

    const liveSwap = mutateLivenessToReadyz(whBicep);
    const liveCheck = locks.validateBicepProbeContract(liveSwap);
    red('liveness_readyz_swap_rejected', liveCheck.ok === false);

    const readySwap = mutateReadinessPathToHealthz(whBicep);
    const readyCheck = locks.validateBicepProbeContract(readySwap);
    red('readiness_healthz_swap_rejected', readyCheck.ok === false);
  }

  // RED: absent probes
  {
    const absent = mutateProbesAbsent(whBicep);
    const r = locks.validateBicepProbeContract(absent);
    red('absent_probes_rejected', r.ok === false && /absent|missing/i.test(String(r.detail || '')));
  }

  // RED: wrong ports
  {
    const badPort = mutateProbePort(whBicep, 8080);
    const block = locks.extractProbesBlock(whBicep);
    const mutatedBlock = block.replace(/port:\s*3036/g, 'port: 8080');
    const mutated = whBicep.replace(block, mutatedBlock);
    const r = locks.validateBicepProbeContract(mutated);
    red('wrong_probe_port_rejected', r.ok === false, r.detail);
    void badPort;
  }

  // RED: wrong timings
  {
    const mutated = mutateProbeTiming(whBicep);
    const r = locks.validateBicepProbeContract(mutated);
    red('wrong_probe_timings_rejected', r.ok === false, r.detail);
  }

  // RED: Sunset/Wolfhouse drift
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

  // ── GREEN ─────────────────────────────────────────────────────────────────

  // GREEN: real createStaffQueryApiHttpServer + readiness pool path success
  {
    const { pool } = createFakeClientReadinessPool({ timeoutMs: 500 });
    try {
      await withRealStaffApiServer({ readinessPool: pool }, async ({ port, api }) => {
        const ready = await httpGet(port, '/readyz');
        const live = await httpGet(port, '/healthz');
        green('real_listener_readyz_200',
          ready.statusCode === 200
          && JSON.parse(ready.body).status === 'ready'
          && !bodyHasSensitiveLeak(ready.body)
          && typeof api.createStaffQueryApiHttpServer === 'function'
          && typeof api.router === 'function'
          && pool.idleCount === 1
          && pool.totalCount === 1);
        green('real_listener_healthz_200_static',
          live.statusCode === 200
          && JSON.parse(live.body).status === 'ok'
          && !bodyHasSensitiveLeak(live.body));
      });
    } finally {
      await readiness.endPoolBounded(pool, 200);
    }
  }

  // GREEN: shutdown with hanging pool.end — bounded close
  {
    let closeCalls = 0;
    let closeStarted = 0;
    const { pool, shared } = createFakeClientReadinessPool({
      timeoutMs: 300,
      hangEnd: true,
    });
    // Warm a client so end() has work that can hang
    await readiness.checkPostgresReadiness(null, { pool, timeoutMs: 300 });
    shared.hangEnd = true;
    try {
      await withRealStaffApiServer({ readinessPool: pool }, async ({ api, server, port }) => {
        const life = api.attachStaffQueryApiLifecycle(server, {
          drainMs: 100,
          poolCloseTimeoutMs: 150,
          closePool: async () => {
            closeCalls += 1;
            closeStarted = Date.now();
            await readiness.endPoolBounded(pool, 150);
          },
          log: () => {},
        });
        const started = Date.now();
        await life.shutdown('test');
        await life.shutdown('test-again');
        const elapsed = Date.now() - started;
        green('shutdown_inflight_readiness_cleanup',
          closeCalls === 1
          && life.isShuttingDown() === true
          && elapsed < 1500,
          `closeCalls=${closeCalls} elapsed=${elapsed}`);
        void port;
      });
    } finally {
      shared.hangEnd = false;
      await readiness.endPoolBounded(pool, 200);
    }
  }

  // GREEN: keep-alive / active sockets force-closed at drain deadline
  {
    const { pool } = createFakeClientReadinessPool({ timeoutMs: 400 });
    try {
      await withRealStaffApiServer({ readinessPool: pool }, async ({ api, server, port }) => {
        const life = api.attachStaffQueryApiLifecycle(server, {
          drainMs: 80,
          poolCloseTimeoutMs: 100,
          closePool: async () => {},
          log: () => {},
        });
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        const hold = await new Promise((resolve, reject) => {
          const req = http.request({
            host: '127.0.0.1',
            port,
            path: '/healthz',
            method: 'GET',
            agent,
            headers: { Connection: 'keep-alive' },
          }, (res) => {
            res.resume();
            res.on('end', () => resolve({ req, socket: req.socket }));
          });
          req.on('error', reject);
          req.end();
        });
        await new Promise((r) => setTimeout(r, 20));
        const socketsBefore = life.getTrackedSocketCount();
        const started = Date.now();
        await life.shutdown('keepalive-test');
        await new Promise((r) => setTimeout(r, 30));
        const elapsed = Date.now() - started;
        const socketsAfter = life.getTrackedSocketCount();
        agent.destroy();
        green('shutdown_keepalive_sockets_force_closed',
          socketsBefore >= 1
          && socketsAfter === 0
          && elapsed < 1000
          && life.isShuttingDown() === true,
          `before=${socketsBefore} after=${socketsAfter} elapsed=${elapsed}`);
        void hold;
      });
    } finally {
      await readiness.endPoolBounded(pool, 200);
    }
  }

  // GREEN: actual SIGTERM/SIGINT install + removal + duplicate idempotent
  {
    const { pool } = createFakeClientReadinessPool({ timeoutMs: 400 });
    try {
      await withRealStaffApiServer({ readinessPool: pool }, async ({ api, server }) => {
        let closeCalls = 0;
        const life = api.attachStaffQueryApiLifecycle(server, {
          drainMs: 50,
          poolCloseTimeoutMs: 100,
          closePool: async () => { closeCalls += 1; },
          log: () => {},
        });
        const remove = life.installSignalHandlers();
        const termCountBefore = process.listenerCount('SIGTERM');
        const intCountBefore = process.listenerCount('SIGINT');
        process.emit('SIGTERM');
        await new Promise((r) => setTimeout(r, 120));
        process.emit('SIGTERM');
        process.emit('SIGINT');
        await new Promise((r) => setTimeout(r, 80));
        remove();
        const termCountAfter = process.listenerCount('SIGTERM');
        const intCountAfter = process.listenerCount('SIGINT');
        green('signal_handlers_duplicate_idempotent',
          closeCalls === 1
          && termCountBefore >= 1
          && intCountBefore >= 1
          && termCountAfter === termCountBefore - 1
          && intCountAfter === intCountBefore - 1
          && life.isShuttingDown() === true,
          `closeCalls=${closeCalls} term ${termCountBefore}->${termCountAfter} int ${intCountBefore}->${intCountAfter}`);
      });
    } finally {
      await readiness.endPoolBounded(pool, 200);
    }
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
        && /"port"\s*:\s*3036/.test(tpl));
    } catch (err) {
      green('compiled_sunset_bicep_has_probes', false,
        String(err && err.stderr || err.message || err).slice(0, 500));
    }
  }

  let ownedOk = true;
  for (const rel of locks.OWNED_RELS) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      ok(`owned exists ${rel}`, false);
      ownedOk = false;
      continue;
    }
    const text = readText(rel);
    const sec = secretFree(text, rel);
    if (!sec.ok) {
      ok(`secret-free ${rel}`, false, sec.detail);
      ownedOk = false;
    }
  }
  ok('C12 owned artifacts secret-free', ownedOk);

  const requiredRed = [
    'missing_pool',
    'db_error_503',
    'hung_query_cancel_cleanup',
    'pool_saturation_acquire_timeout',
    'repeated_timeout_no_pool_exhaustion',
    'late_acquire_healthy_client_preserved',
    'no_sensitive_fields_on_result',
    'dml_ddl_query_rejected',
    'paths_not_swapped_in_source',
    'liveness_readyz_swap_rejected',
    'readiness_healthz_swap_rejected',
    'absent_probes_rejected',
    'wrong_probe_port_rejected',
    'wrong_probe_timings_rejected',
    'sunset_wolfhouse_drift_detected',
  ];
  const requiredGreen = [
    'real_listener_readyz_200',
    'real_listener_healthz_200_static',
    'shutdown_inflight_readiness_cleanup',
    'shutdown_keepalive_sockets_force_closed',
    'signal_handlers_duplicate_idempotent',
    'compiled_wolfhouse_bicep_has_probes',
    'compiled_sunset_bicep_has_probes',
  ];
  ok('C13 all required RED ids ran',
    requiredRed.every((id) => redResults.some((r) => r.id === id && r.ok)));
  ok('C14 all required GREEN ids ran',
    requiredGreen.every((id) => greenResults.some((r) => r.id === id && r.ok)));

  const forbiddenDiff = execFileSync(
    'git',
    ['diff', '--name-only', MASTER, '--', 'database/', 'docker/hermes-staging/'],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
  ok('C15 no database/hermes mutation vs master', forbiddenDiff === '', forbiddenDiff);

  clearInterval(keepAlive);

  console.log(`\nRED: ${redResults.filter((r) => r.ok).length}/${redResults.length}  GREEN: ${greenResults.filter((r) => r.ok).length}/${greenResults.length}`);
  console.log(`Result: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16C staff API readiness: PASS');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
