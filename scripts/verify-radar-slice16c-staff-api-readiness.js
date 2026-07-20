'use strict';

/**
 * verify:radar-slice16c-staff-api-readiness — RADAR Slice 16C
 *
 * Offline RED/GREEN gate for Staff API /readyz + ACA probes (Wolfhouse + Sunset).
 * Runtime proofs use real createStaffQueryApiHttpServer/router (fortress dual-gate),
 * not a synthetic listener. No live deploy, no Azure mutation, no real secrets.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

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
 * Instrumented withPgClient behaviors for real-router proofs.
 * Tracks pending acquires, checked-out clients, active queries, and late work.
 */
function createInstrumentedWithPgClient(behavior, tracker) {
  const t = tracker || {
    pendingAcquires: 0,
    checkedOut: 0,
    activeQueries: 0,
    lateWorkAfterTimeout: 0,
    acquireStarts: 0,
    queryStarts: 0,
    releases: 0,
  };

  async function withPgClient(fn) {
    t.acquireStarts += 1;
    t.pendingAcquires += 1;
    try {
      if (behavior === 'missing') {
        return undefined;
      }
      if (behavior === 'error') {
        const err = new Error([
          'ECONNREFUSED',
          ' ',
          'pass',
          'word',
          '=',
          'supersecret',
          ' ',
          'postgres',
          ':',
          '/',
          '/',
          'wolf:hunter2@db:5432/wolfhouse',
        ].join(''));
        err.stack = 'Error: boom\n    at Object.query (fake.js:1:1)';
        throw err;
      }
      if (behavior === 'ok' || behavior === 'hung_query' || behavior === 'slow_acquire') {
        if (behavior === 'slow_acquire') {
          await new Promise((r) => setTimeout(r, readiness.READINESS_TIMEOUT_MS + 800));
        }
        t.pendingAcquires -= 1;
        t.checkedOut += 1;
        /** @type {{ _destroyed: boolean, _rejectQuery: ((err: Error) => void) | null, connection: object, query: Function }} */
        const client = {
          _destroyed: false,
          _rejectQuery: null,
          connection: {
            stream: {
              destroy() {
                client._destroyed = true;
                if (typeof client._rejectQuery === 'function') {
                  const reject = client._rejectQuery;
                  client._rejectQuery = null;
                  reject(new Error('readiness_query_cancelled'));
                }
              },
            },
          },
          query: async (sql) => {
            t.queryStarts += 1;
            t.activeQueries += 1;
            try {
              if (behavior === 'hung_query') {
                await new Promise((resolve, reject) => {
                  client._rejectQuery = reject;
                  const timer = setTimeout(resolve, readiness.READINESS_TIMEOUT_MS + 2000);
                  const prevDestroy = client.connection.stream.destroy.bind(client.connection.stream);
                  client.connection.stream.destroy = () => {
                    clearTimeout(timer);
                    prevDestroy();
                  };
                });
              }
              if (client._destroyed) throw new Error('readiness_query_cancelled');
              if (sql !== readiness.READINESS_SQL) {
                throw new Error(`unexpected sql ${sql}`);
              }
              return { rows: [{ '?column?': 1 }] };
            } finally {
              t.activeQueries -= 1;
              client._rejectQuery = null;
            }
          },
        };
        try {
          return await fn(client);
        } finally {
          t.checkedOut -= 1;
          t.releases += 1;
        }
      }
      throw new Error(`unknown behavior ${behavior}`);
    } catch (err) {
      t.pendingAcquires = Math.max(0, t.pendingAcquires - 1);
      throw err;
    }
  }

  withPgClient._tracker = t;
  return withPgClient;
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

async function withRealStaffApiServer(withPgClientImpl, fn) {
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
  // Re-require readiness after cache clear so staff-query-api gets fresh copy
  delete require.cache[require.resolve('./lib/staff-api-readiness')];
  const api = require('./staff-query-api');
  if (typeof api.createStaffQueryApiHttpServer !== 'function') {
    throw new Error('createStaffQueryApiHttpServer not exported — dual-gate inactive');
  }
  api.setFortress15j3OfflineSeams({ withPgClient: withPgClientImpl });
  const server = api.createStaffQueryApiHttpServer();
  const port = await listen(server);
  try {
    return await fn({ api, server, port });
  } finally {
    await closeServer(server);
    api.setFortress15j3OfflineSeams(null);
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

ok('C4 staff-query-api wires /readyz before /healthz',
  /pathname === READYZ_PATH/.test(apiSrc)
  && /handleStaffApiReadyz\(res, sendJSON, withPgClient/.test(apiSrc)
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

ok('C6b no Promise.race — cancellable readiness operation',
  !/\bPromise\.race\s*\(/.test(readinessSrc)
  && /function createReadinessOperation/.test(readinessSrc)
  && /function acquirePoolClientBounded/.test(readinessSrc)
  && /function cancel\(/.test(readinessSrc)
  && !/createReadyzTestListener/.test(readinessSrc));

ok('C6c graceful SIGTERM/SIGINT lifecycle present',
  /function attachStaffQueryApiLifecycle/.test(apiSrc)
  && /process\.on\('SIGTERM'/.test(apiSrc)
  && /process\.on\('SIGINT'/.test(apiSrc)
  && /closePgPool/.test(apiSrc)
  && /installSignalHandlers/.test(apiSrc)
  && /require\.main === module[\s\S]*attachStaffQueryApiLifecycle/.test(apiSrc));

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
  // RED: missing pool / withPgClient
  {
    const r = await readiness.checkPostgresReadiness(null);
    red('missing_pool', r.ok === false);
    const r2 = await readiness.checkPostgresReadiness(undefined);
    red('missing_pool_undefined', r2.ok === false);
  }

  // RED: DB error → not-ready, no leak (real server)
  {
    const withPg = createInstrumentedWithPgClient('error');
    await withRealStaffApiServer(withPg, async ({ port }) => {
      const res = await httpGet(port, '/readyz');
      red('db_error_503',
        res.statusCode === 503
        && JSON.parse(res.body).status === 'not-ready'
        && !bodyHasSensitiveLeak(res.body, ['supersecret', 'hunter2']));
    });
  }

  // RED: hung query → timeout cancels + cleanup (real server)
  {
    const tracker = {
      pendingAcquires: 0,
      checkedOut: 0,
      activeQueries: 0,
      lateWorkAfterTimeout: 0,
      acquireStarts: 0,
      queryStarts: 0,
      releases: 0,
    };
    const withPg = createInstrumentedWithPgClient('hung_query', tracker);
    await withRealStaffApiServer(withPg, async ({ port }) => {
      const started = Date.now();
      const res = await httpGet(port, '/readyz', readiness.READINESS_TIMEOUT_MS + 3000);
      const elapsed = Date.now() - started;
      // Allow release to settle
      await new Promise((r) => setTimeout(r, 100));
      red('hung_query_cancel_cleanup',
        res.statusCode === 503
        && JSON.parse(res.body).status === 'not-ready'
        && elapsed < readiness.READINESS_TIMEOUT_MS + 1500
        && tracker.checkedOut === 0
        && tracker.activeQueries === 0
        && tracker.releases >= 1
        && !bodyHasSensitiveLeak(res.body),
        `elapsed=${elapsed} checkedOut=${tracker.checkedOut} active=${tracker.activeQueries} releases=${tracker.releases}`);
    });
  }

  // RED: pool saturation / acquisition timeout — pending waiter removed
  {
    const satPool = {
      _pendingQueue: [],
      get waitingCount() { return this._pendingQueue.length; },
      checkedOut: 0,
      lateReleases: 0,
      connect(cb) {
        const item = { callback: cb, timedOut: false };
        satPool._pendingQueue.push(item);
        // Never resolves unless someone pulses — timeout must remove waiter
      },
    };
    const started = Date.now();
    const r = await readiness.checkPostgresReadiness(null, {
      timeoutMs: 200,
      pool: satPool,
    });
    const elapsed = Date.now() - started;
    await new Promise((r2) => setTimeout(r2, 50));
    red('pool_saturation_acquire_timeout',
      r.ok === false
      && elapsed < 800
      && satPool._pendingQueue.length === 0
      && satPool.waitingCount === 0
      && satPool.checkedOut === 0,
      `elapsed=${elapsed} pending=${satPool._pendingQueue.length} waiting=${satPool.waitingCount}`);
  }

  // RED: repeated timeouts must not accumulate pending/probe tasks or exhaust pool
  {
    const satPool = {
      _pendingQueue: [],
      get waitingCount() { return this._pendingQueue.length; },
      checkedOut: 0,
      connectCalls: 0,
      connect(cb) {
        this.connectCalls += 1;
        const item = { callback: cb, timedOut: false };
        this._pendingQueue.push(item);
      },
    };
    for (let i = 0; i < 8; i += 1) {
      await readiness.checkPostgresReadiness(null, { timeoutMs: 80, pool: satPool });
    }
    await new Promise((r2) => setTimeout(r2, 30));
    red('repeated_timeout_no_pool_exhaustion',
      satPool._pendingQueue.length === 0
      && satPool.waitingCount === 0
      && satPool.checkedOut === 0
      && satPool.connectCalls === 8,
      `pending=${satPool._pendingQueue.length} calls=${satPool.connectCalls}`);
  }

  // RED: sensitive error leakage via checkPostgresReadiness return shape
  {
    const r = await readiness.checkPostgresReadiness(createInstrumentedWithPgClient('error'));
    red('no_sensitive_fields_on_result',
      r.ok === false
      && Object.keys(r).length === 1
      && !('error' in r)
      && !('message' in r)
      && !('stack' in r));
  }

  // RED: DML/DDL query changes rejected
  {
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
      const check = await readiness.checkPostgresReadiness(
        createInstrumentedWithPgClient('ok'),
        { sql },
      );
      if (gate.ok || check.ok) allRejected = false;
    }
    red('dml_ddl_query_rejected', allRejected);
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

  // GREEN: real createStaffQueryApiHttpServer success + healthz independence
  {
    await withRealStaffApiServer(createInstrumentedWithPgClient('ok'), async ({ port, api }) => {
      const ready = await httpGet(port, '/readyz');
      const live = await httpGet(port, '/healthz');
      green('real_listener_readyz_200',
        ready.statusCode === 200
        && JSON.parse(ready.body).status === 'ready'
        && !bodyHasSensitiveLeak(ready.body)
        && typeof api.createStaffQueryApiHttpServer === 'function'
        && typeof api.router === 'function');
      green('real_listener_healthz_200_static',
        live.statusCode === 200
        && JSON.parse(live.body).status === 'ok'
        && !bodyHasSensitiveLeak(live.body));
    });
  }

  // GREEN: shutdown with in-flight readiness — drain + close pool exactly once
  {
    let closeCalls = 0;
    const tracker = {
      pendingAcquires: 0,
      checkedOut: 0,
      activeQueries: 0,
      lateWorkAfterTimeout: 0,
      acquireStarts: 0,
      queryStarts: 0,
      releases: 0,
    };
    const withPg = createInstrumentedWithPgClient('hung_query', tracker);
    await withRealStaffApiServer(withPg, async ({ api, server, port }) => {
      const life = api.attachStaffQueryApiLifecycle(server, {
        drainMs: 500,
        closePool: async () => { closeCalls += 1; },
        log: () => {},
      });
      const inflight = httpGet(port, '/readyz', readiness.READINESS_TIMEOUT_MS + 4000);
      await new Promise((r) => setTimeout(r, 50));
      await life.shutdown('test');
      await life.shutdown('test-again'); // exactly-once pool close
      let inflightStatus = null;
      try {
        const res = await inflight;
        inflightStatus = res.statusCode;
      } catch (_) {
        inflightStatus = 'closed';
      }
      await new Promise((r) => setTimeout(r, 100));
      green('shutdown_inflight_readiness_cleanup',
        closeCalls === 1
        && life.isShuttingDown() === true
        && tracker.checkedOut === 0
        && (inflightStatus === 503 || inflightStatus === 'closed' || inflightStatus === 200),
        `closeCalls=${closeCalls} checkedOut=${tracker.checkedOut} inflight=${inflightStatus}`);
    });
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

  console.log(`\nRED: ${redResults.filter((r) => r.ok).length}/${redResults.length}  GREEN: ${greenResults.filter((r) => r.ok).length}/${greenResults.length}`);
  console.log(`Result: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16C staff API readiness: PASS');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
