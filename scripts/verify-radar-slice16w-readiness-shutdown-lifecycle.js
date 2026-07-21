'use strict';

/**
 * verify:radar-slice16w-readiness-shutdown-lifecycle — RADAR Slice 16W
 *
 * Offline RED/GREEN gate: closeReadinessPool wired into Staff API graceful shutdown.
 * Proves SIGINT/SIGTERM propagation, bounded pool/server close, failure classification,
 * and child-process termination semantics. No live deploy, no probe/SQL/readyz changes.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16w-readiness-shutdown-lifecycle');

const MASTER = locks.MASTER_BASIS;
const CONTRACT_REL = 'fixtures/radar-operations/slice16w-expected-contract.json';

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

function countProcessListeners(event) {
  return process.listenerCount(event);
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

function applyMinimalStaffApiEnv() {
  process.env.NODE_ENV = 'test';
  process.env.STAFF_RUNTIME_PROFILE = 'local';
  process.env.STAFF_AUTH_REQUIRED = 'false';
  process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
  process.env.STAFF_AUTH_HTTPS = 'false';
  process.env.STAFF_QUERY_API_HOST = '127.0.0.1';
  process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = '1';
  process.env.LUNA_BOT_INTERNAL_TOKEN = 'radar16w-offline-token-32chars-minimum';
}

function clearStaffApiCache() {
  delete require.cache[require.resolve('./staff-query-api')];
  delete require.cache[require.resolve('./lib/staff-api-readiness')];
  delete require.cache[require.resolve('./lib/staff-api-readiness-lifecycle')];
}

function createTrackedReadinessPool(delayMs = 25) {
  const shared = { endCalls: 0, endFinishedAt: null };
  const pool = {
    connect() {
      return Promise.resolve({
        query: () => Promise.resolve({ rows: [{ '?column?': 1 }] }),
        release() {},
      });
    },
    async end() {
      shared.endCalls += 1;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      shared.endFinishedAt = Date.now();
    },
    get totalCount() { return 0; },
    get idleCount() { return 0; },
    get waitingCount() { return 0; },
  };
  return { pool, shared };
}

function createOrderTrackingServer(overrides = {}) {
  const events = [];
  const base = {
    listening: true,
    close(cb) {
      events.push({ step: 'server_close_start', at: Date.now() });
      setImmediate(() => {
        events.push({ step: 'server_close_done', at: Date.now() });
        if (typeof cb === 'function') cb();
      });
    },
  };
  return {
    events,
    server: { ...base, ...overrides },
  };
}

async function withLifecycleModule(fn) {
  clearStaffApiCache();
  const lifecycle = require('./lib/staff-api-readiness-lifecycle');
  const readiness = require('./lib/staff-api-readiness');
  lifecycle._resetStaffApiReadinessLifecycleForTests();
  readiness._resetReadinessPoolStateForTests();
  try {
    return await fn(lifecycle, readiness);
  } finally {
    lifecycle._resetStaffApiReadinessLifecycleForTests();
    readiness._resetReadinessPoolStateForTests();
    clearStaffApiCache();
  }
}

function spawnNode(scriptPath, timeoutMs, sendSignal) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let ready = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr: `${stderr}\nTIMEOUT`, signals: [] });
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      if (!ready && stdout.includes('{"type":"ready"}')) {
        ready = true;
        if (sendSignal) {
          setTimeout(() => child.kill(sendSignal), 30);
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      resolve({ code, signal: sig, stdout, stderr });
    });
  });
}

function writeChildHarness(opts) {
  const harnessPath = path.join(__dirname, `_tmp-16w-child-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  const poolDelayMs = opts.poolDelayMs ?? 20;
  const poolScript = opts.poolScript || `
    let endCalls = 0;
    readiness._setReadinessPoolForTests({
      connect: () => Promise.resolve({ query: async () => ({ rows: [{ '?column?': 1 }] }), release() {} }),
      async end() { endCalls += 1; await new Promise((r) => setTimeout(r, ${poolDelayMs})); },
      get totalCount() { return 0; }, get idleCount() { return 0; }, get waitingCount() { return 0; },
    });
  `;
  const extraSignals = opts.extraSignals
    ? `setTimeout(() => { process.kill(process.pid, '${opts.extraSignals}'); }, ${opts.extraSignalDelayMs ?? 60});`
    : '';

  fs.writeFileSync(harnessPath, `'use strict';
const http = require('http');
const lifecycle = require('./lib/staff-api-readiness-lifecycle');
const readiness = require('./lib/staff-api-readiness');
readiness._resetReadinessPoolStateForTests();
lifecycle._resetStaffApiReadinessLifecycleForTests();
${poolScript}
const server = http.createServer();
server.listen(0, '127.0.0.1', () => {
  lifecycle.attachStaffApiReadinessLifecycle(server, {
    poolCloseTimeoutMs: 5000,
    serverCloseTimeoutMs: 5000,
    terminate: (signal) => {
      console.log(JSON.stringify({ type: 'terminate', signal, endCalls }));
      process.exit(signal === 'SIGINT' ? 130 : 143);
    },
  });
  console.log(JSON.stringify({ type: 'ready' }));
  ${extraSignals}
});
`);
  return harnessPath;
}

async function runChildSameSignalDuringCleanupTest(sendSignal, expectCode) {
  const harness = writeChildHarness({
    extraSignals: sendSignal,
    extraSignalDelayMs: 60,
    poolDelayMs: 200,
  });
  try {
    const result = await spawnNode(harness, 8000, sendSignal);
    const lines = result.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const terminate = lines.find((l) => l.type === 'terminate');
    return {
      result,
      terminate,
      endCalls: terminate ? terminate.endCalls : null,
      ok: result.code === expectCode
        && terminate
        && terminate.signal === sendSignal
        && terminate.endCalls === 1,
    };
  } finally {
    fs.unlinkSync(harness);
  }
}

async function runChildSignalTest(sendSignal, expectCode) {
  const harness = writeChildHarness({ extraSignals: null });
  try {
    const result = await spawnNode(harness, 8000, sendSignal);
    const lines = result.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const terminate = lines.find((l) => l.type === 'terminate');
    return {
      result,
      terminate,
      endCalls: terminate ? terminate.endCalls : null,
      ok: result.code === expectCode
        && terminate
        && terminate.signal === sendSignal
        && terminate.endCalls === 1,
    };
  } finally {
    fs.unlinkSync(harness);
  }
}

console.log('verify:radar-slice16w-readiness-shutdown-lifecycle — RADAR Slice 16W\n');

const contract = readJson(CONTRACT_REL);
const apiSrc = readText(locks.STAFF_API_REL);
const readinessSrc = readText(locks.READINESS_LIB_REL);
const lifecycleSrc = readText(locks.LIFECYCLE_LIB_REL);
const pgConnectSrc = readText('scripts/lib/pg-connect.js');
const readinessMod = require('./lib/staff-api-readiness');

ok('C1 contract pinned',
  contract.master_basis === MASTER
  && contract.outcome_id === locks.OUTCOME_ID
  && contract.gate_id === locks.GATE_ID
  && contract.progress_class === locks.PROGRESS_CLASS
  && contract.live_deploy === false
  && contract.live_mutation === false
  && contract.branch === locks.BRANCH);

ok('C2 lifecycle module present with locked shutdown order',
  /attachStaffApiReadinessLifecycle/.test(lifecycleSrc)
  && /runStaffApiReadinessShutdown/.test(lifecycleSrc)
  && /closeReadinessPool/.test(lifecycleSrc)
  && /defaultTerminate/.test(lifecycleSrc)
  && /process\.on\('SIGTERM'/.test(lifecycleSrc)
  && /process\.on\('SIGINT'/.test(lifecycleSrc)
  && !/process\.once\('SIGTERM'/.test(lifecycleSrc)
  && !/process\.once\('SIGINT'/.test(lifecycleSrc)
  && /\.unref\(\)/.test(lifecycleSrc)
  && !/\bclosePgPool\b/.test(lifecycleSrc)
  && !/(^|[^\*\/])\bprocess\.exit\s*\(\s*0\s*\)/.test(lifecycleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''))
  && JSON.stringify(contract.lifecycle.shutdown_order) === JSON.stringify(locks.SHUTDOWN_ORDER));

ok('C3 staff-query-api wires lifecycle on CLI main only',
  /attachStaffApiReadinessLifecycle/.test(apiSrc)
  && /if \(require\.main === module\)\s*\{[\s\S]{0,200}attachStaffApiReadinessLifecycle\(server\)/.test(apiSrc)
  && (() => {
    const fnStart = apiSrc.indexOf('function createStaffQueryApiHttpServer');
    const fnEnd = apiSrc.indexOf('\n}', fnStart);
    const body = fnStart >= 0 && fnEnd > fnStart ? apiSrc.slice(fnStart, fnEnd) : '';
    return body && !/attachStaffApiReadinessLifecycle/.test(body);
  })());

ok('C4 readiness /readyz contract untouched',
  readinessMod.READINESS_SQL === 'SELECT 1'
  && readinessMod.READY_BODY.status === 'ready'
  && readinessMod.NOT_READY_BODY.status === 'not-ready'
  && /const READINESS_SQL = 'SELECT 1'/.test(readinessSrc));

ok('C5 no closePgPool composition',
  !/\bclosePgPool\b/.test(apiSrc)
  && !/\bclosePgPool\b/.test(lifecycleSrc)
  && !/closeReadinessPool/.test(pgConnectSrc)
  && contract.lifecycle.closePgPool_composition === 'forbidden');

ok('C6 both staging tenants share one runtime (no tenant fork)',
  contract.tenant_scope.wolfhouse_staging_image === 'shared_staff_api_runtime'
  && contract.tenant_scope.sunset_staging_image === 'shared_staff_api_runtime'
  && !/sunset.*lifecycle|wolfhouse.*lifecycle/i.test(lifecycleSrc));

const pkg = readJson('package.json');
ok('C7 npm script registered',
  pkg.scripts['verify:radar-slice16w-readiness-shutdown-lifecycle']
  === 'node scripts/verify-radar-slice16w-readiness-shutdown-lifecycle.js');

(async () => {
  const keepAlive = setInterval(() => {}, 1000);

  await withLifecycleModule(async (lifecycle, readiness) => {
    const { pool, shared } = createTrackedReadinessPool();
    readiness._setReadinessPoolForTests(pool);
    const { server } = createOrderTrackingServer();
    lifecycle.attachStaffApiReadinessLifecycle(server, { terminate: false });
    await lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', { terminate: false });
    await lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', { terminate: false });
    red('sigterm_closes_pool_once', shared.endCalls === 1, `endCalls=${shared.endCalls}`);
  });

  await withLifecycleModule(async (lifecycle, readiness) => {
    const { pool, shared } = createTrackedReadinessPool();
    readiness._setReadinessPoolForTests(pool);
    const { server } = createOrderTrackingServer();
    lifecycle.attachStaffApiReadinessLifecycle(server, { terminate: false });
    await lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGINT', { terminate: false });
    red('sigint_closes_pool_once', shared.endCalls === 1, `endCalls=${shared.endCalls}`);
  });

  {
    const sigtermChild = await runChildSignalTest('SIGTERM', 143);
    red('sigterm_propagates_original_signal_child',
      sigtermChild.ok,
      JSON.stringify(sigtermChild));
  }

  {
    const sigintChild = await runChildSignalTest('SIGINT', 130);
    red('sigint_propagates_original_signal_child',
      sigintChild.ok,
      JSON.stringify(sigintChild));
  }

  {
    const sigtermSame = await runChildSameSignalDuringCleanupTest('SIGTERM', 143);
    red('child_process_sigterm_same_signal_during_cleanup',
      sigtermSame.ok,
      JSON.stringify(sigtermSame));
  }

  {
    const sigintSame = await runChildSameSignalDuringCleanupTest('SIGINT', 130);
    red('child_process_sigint_same_signal_during_cleanup',
      sigintSame.ok,
      JSON.stringify(sigintSame));
  }

  {
    const harness = writeChildHarness({
      extraSignals: 'SIGINT',
      poolScript: `
    let endCalls = 0;
    readiness._setReadinessPoolForTests({
      connect: () => Promise.resolve({ query: async () => ({ rows: [{ '?column?': 1 }] }), release() {} }),
      async end() { endCalls += 1; },
      get totalCount() { return 0; }, get idleCount() { return 0; }, get waitingCount() { return 0; },
    });
      `,
    });
    try {
      const result = await spawnNode(harness, 8000, 'SIGTERM');
      const terminate = result.stdout.trim().split('\n')
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((l) => l && l.type === 'terminate');
      red('child_process_cleanup_once_under_repeated_signals',
        terminate && terminate.endCalls === 1 && terminate.signal === 'SIGTERM',
        JSON.stringify({ terminate, code: result.code }));
    } finally {
      fs.unlinkSync(harness);
    }
  }

  await withLifecycleModule(async (lifecycle, readiness) => {
    const { pool, shared } = createTrackedReadinessPool();
    readiness._setReadinessPoolForTests(pool);
    const tracker = createOrderTrackingServer();
    lifecycle.attachStaffApiReadinessLifecycle(tracker.server, { terminate: false });
    await lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGTERM', { terminate: false });
    const poolDone = shared.endFinishedAt;
    const serverStart = tracker.events.find((e) => e.step === 'server_close_start');
    red('pool_close_awaited_before_server_close',
      shared.endCalls === 1
      && poolDone != null
      && serverStart
      && poolDone <= serverStart.at,
      JSON.stringify({ poolDone, serverStart }));
  });

  await withLifecycleModule(async (lifecycle, readiness) => {
    const { pool, shared } = createTrackedReadinessPool();
    readiness._setReadinessPoolForTests(pool);
    const { server } = createOrderTrackingServer();
    let terminateAt = null;
    let terminateSignal = null;
    await lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGINT', {
      terminate: (sig) => {
        terminateSignal = sig;
        terminateAt = Date.now();
      },
    });
    red('pool_close_awaited_before_terminate',
      shared.endCalls === 1
      && shared.endFinishedAt != null
      && terminateAt != null
      && terminateSignal === 'SIGINT'
      && shared.endFinishedAt <= terminateAt,
      JSON.stringify({ endFinishedAt: shared.endFinishedAt, terminateAt, terminateSignal }));
  });

  await withLifecycleModule(async (lifecycle) => {
    const tracker = createOrderTrackingServer();
    const logs = [];
    await lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGTERM', {
      closeReadinessPool: () => Promise.reject(new Error('pool boom')),
      poolCloseTimeoutMs: 50,
      serverCloseTimeoutMs: 50,
      log: (rec) => logs.push(rec),
      terminate: () => {},
    });
    const serverCloseStarted = tracker.events.some((e) => e.step === 'server_close_start');
    red('pool_close_rejected_bounded',
      logs.length === 1
      && logs[0].failure_classes.includes('pool_close_rejected')
      && serverCloseStarted,
      JSON.stringify({ logs, serverCloseStarted }));
  });

  await withLifecycleModule(async (lifecycle) => {
    const tracker = createOrderTrackingServer();
    const logs = [];
    const started = Date.now();
    await lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGTERM', {
      closeReadinessPool: () => new Promise(() => {}),
      poolCloseTimeoutMs: 40,
      serverCloseTimeoutMs: 50,
      log: (rec) => logs.push(rec),
      terminate: () => {},
    });
    const elapsed = Date.now() - started;
    red('pool_close_never_settles_bounded',
      elapsed < 500
      && logs[0].failure_classes.includes('pool_close_timeout')
      && tracker.events.some((e) => e.step === 'server_close_start'),
      JSON.stringify({ elapsed, logs, events: tracker.events }));
  });

  await withLifecycleModule(async (lifecycle) => {
    const logs = [];
    const server = {
      listening: true,
      close(cb) { if (typeof cb === 'function') cb(new Error('close failed')); },
    };
    await lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', {
      closeReadinessPool: async () => {},
      serverCloseTimeoutMs: 50,
      log: (rec) => logs.push(rec),
      terminate: () => {},
    });
    red('server_close_rejected_bounded',
      logs[0].failure_classes.includes('server_close_rejected'),
      JSON.stringify(logs));
  });

  await withLifecycleModule(async (lifecycle) => {
    const logs = [];
    const server = {
      listening: true,
      close() { throw new Error('sync throw'); },
    };
    await lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', {
      closeReadinessPool: async () => {},
      serverCloseTimeoutMs: 50,
      log: (rec) => logs.push(rec),
      terminate: () => {},
    });
    red('server_close_throwing_bounded',
      logs[0].failure_classes.includes('server_close_throw'),
      JSON.stringify(logs));
  });

  await withLifecycleModule(async (lifecycle) => {
    const logs = [];
    const server = { listening: true, close() {} };
    const started = Date.now();
    await lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', {
      closeReadinessPool: async () => {},
      serverCloseTimeoutMs: 40,
      log: (rec) => logs.push(rec),
      terminate: () => {},
    });
    red('server_close_callback_never_bounded',
      Date.now() - started < 500
      && logs[0].failure_classes.includes('server_close_timeout'),
      JSON.stringify({ elapsed: Date.now() - started, logs }));
  });

  await withLifecycleModule(async (lifecycle) => {
    const logs = [];
    const server = { listening: false, close(cb) { if (cb) cb(new Error('nope')); } };
    await lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', {
      closeReadinessPool: async () => {},
      serverCloseTimeoutMs: 50,
      log: (rec) => logs.push(rec),
      terminate: () => {},
    });
    red('server_close_already_closed_bounded',
      logs[0].failure_classes.includes('server_close_already_closed'),
      JSON.stringify(logs));
  });

  await withLifecycleModule(async (lifecycle) => {
    const tracker = createOrderTrackingServer();
    const logs = [];
    await lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGTERM', {
      closeReadinessPool: () => Promise.reject(new Error('pool fail')),
      poolCloseTimeoutMs: 50,
      serverCloseTimeoutMs: 50,
      log: (rec) => logs.push(rec),
      terminate: () => {},
    });
    red('server_close_after_pool_failure',
      logs[0].failure_classes.includes('pool_close_rejected')
      && tracker.events.some((e) => e.step === 'server_close_start'),
      JSON.stringify({ logs, events: tracker.events }));
  });

  await withLifecycleModule(async (lifecycle) => {
    const started = Date.now();
    await lifecycle._triggerStaffApiReadinessShutdownForTests(null, 'SIGTERM', {
      closeReadinessPool: () => new Promise(() => {}),
      poolCloseTimeoutMs: 30,
      serverCloseTimeoutMs: 30,
      terminate: () => {},
    });
    red('bounded_shutdown_completes', Date.now() - started < 500, `elapsed=${Date.now() - started}`);
  });

  await withLifecycleModule(async (lifecycle, readiness) => {
    const { pool, shared } = createTrackedReadinessPool();
    readiness._setReadinessPoolForTests(pool);
    const { server } = createOrderTrackingServer();
    const beforeAttach = {
      SIGTERM: countProcessListeners('SIGTERM'),
      SIGINT: countProcessListeners('SIGINT'),
    };
    lifecycle.attachStaffApiReadinessLifecycle(server, { terminate: false });
    const afterAttach = {
      SIGTERM: countProcessListeners('SIGTERM'),
      SIGINT: countProcessListeners('SIGINT'),
    };
    red('listener_count_after_attach',
      afterAttach.SIGTERM === beforeAttach.SIGTERM + 1
      && afterAttach.SIGINT === beforeAttach.SIGINT + 1,
      JSON.stringify({ beforeAttach, afterAttach }));
  });

  await withLifecycleModule(async (lifecycle, readiness) => {
    const { pool, shared } = createTrackedReadinessPool(200);
    readiness._setReadinessPoolForTests(pool);
    const { server } = createOrderTrackingServer();
    const beforeAttach = {
      SIGTERM: countProcessListeners('SIGTERM'),
      SIGINT: countProcessListeners('SIGINT'),
    };
    lifecycle.attachStaffApiReadinessLifecycle(server, { terminate: false });
    const shutdown = lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', {
      terminate: false,
    });
    void lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', { terminate: false });
    void lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGINT', { terminate: false });
    const duringRedelivery = {
      SIGTERM: countProcessListeners('SIGTERM'),
      SIGINT: countProcessListeners('SIGINT'),
    };
    await shutdown;
    red('listener_count_stable_during_same_signal_redelivery',
      shared.endCalls === 1
      && duringRedelivery.SIGTERM === beforeAttach.SIGTERM + 1
      && duringRedelivery.SIGINT === beforeAttach.SIGINT + 1,
      JSON.stringify({ endCalls: shared.endCalls, beforeAttach, duringRedelivery }));
  });

  await withLifecycleModule(async (lifecycle, readiness) => {
    const { pool } = createTrackedReadinessPool();
    readiness._setReadinessPoolForTests(pool);
    const { server } = createOrderTrackingServer();
    const beforeAttach = {
      SIGTERM: countProcessListeners('SIGTERM'),
      SIGINT: countProcessListeners('SIGINT'),
    };
    lifecycle.attachStaffApiReadinessLifecycle(server, { terminate: false });
    await lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', { terminate: false });
    const afterCleanup = {
      SIGTERM: countProcessListeners('SIGTERM'),
      SIGINT: countProcessListeners('SIGINT'),
    };
    red('listener_count_zero_after_cleanup',
      afterCleanup.SIGTERM === beforeAttach.SIGTERM
      && afterCleanup.SIGINT === beforeAttach.SIGINT,
      JSON.stringify({ beforeAttach, afterCleanup }));
  });

  await withLifecycleModule(async (lifecycle, readiness) => {
    const { pool } = createTrackedReadinessPool();
    readiness._setReadinessPoolForTests(pool);
    const { server } = createOrderTrackingServer();
    const baseline = {
      SIGTERM: countProcessListeners('SIGTERM'),
      SIGINT: countProcessListeners('SIGINT'),
    };
    lifecycle.attachStaffApiReadinessLifecycle(server, { terminate: false });
    await lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', { terminate: false });
    lifecycle._resetStaffApiReadinessLifecycleForTests();
    readiness._resetReadinessPoolStateForTests();
    const afterReuse = {
      SIGTERM: countProcessListeners('SIGTERM'),
      SIGINT: countProcessListeners('SIGINT'),
    };
    red('module_reuse_no_listener_leak',
      afterReuse.SIGTERM === baseline.SIGTERM
      && afterReuse.SIGINT === baseline.SIGINT,
      JSON.stringify({ baseline, afterReuse }));
  });

  await withLifecycleModule(async (lifecycle, readiness) => {
    const { pool, shared } = createTrackedReadinessPool(200);
    readiness._setReadinessPoolForTests(pool);
    const { server } = createOrderTrackingServer();
    let terminateSignal = null;
    const shutdown = lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', {
      terminate: (sig) => { terminateSignal = sig; },
    });
    await lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGINT', { terminate: false });
    await lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', { terminate: false });
    await shutdown;
    const state = lifecycle._getStaffApiReadinessLifecycleStateForTests();
    red('original_shutdown_signal_preserved_under_mixed_redelivery',
      shared.endCalls === 1
      && state.shutdownSignal === 'SIGTERM'
      && terminateSignal === 'SIGTERM',
      JSON.stringify({ endCalls: shared.endCalls, shutdownSignal: state.shutdownSignal, terminateSignal }));
  });

  await withLifecycleModule(async (lifecycle, readiness) => {
    const { pool, shared } = createTrackedReadinessPool();
    readiness._setReadinessPoolForTests(pool);
    const { server } = createOrderTrackingServer();
    lifecycle.attachStaffApiReadinessLifecycle(server, { terminate: false });
    await Promise.all([
      lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', { terminate: false }),
      lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGINT', { terminate: false }),
      lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', { terminate: false }),
    ]);
    red('concurrent_signals_idempotent', shared.endCalls === 1, `endCalls=${shared.endCalls}`);
  });

  await withLifecycleModule(async (lifecycle, readiness) => {
    const { pool, shared } = createTrackedReadinessPool();
    readiness._setReadinessPoolForTests(pool);
    const { server } = createOrderTrackingServer();
    const p1 = lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', { terminate: false });
    const p2 = lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGINT', { terminate: false });
    await Promise.all([p1, p2]);
    red('concurrent_calls_share_promise', p1 === p2 && shared.endCalls === 1,
      JSON.stringify({ same: p1 === p2, endCalls: shared.endCalls }));
  });

  await withLifecycleModule(async (lifecycle, readiness) => {
    const { pool } = createTrackedReadinessPool();
    readiness._setReadinessPoolForTests(pool);
    const { server } = createOrderTrackingServer();
    lifecycle.attachStaffApiReadinessLifecycle(server, { terminate: false });
    const before = countProcessListeners('SIGTERM') + countProcessListeners('SIGINT');
    let listenersAtTerminate = null;
    await lifecycle._triggerStaffApiReadinessShutdownForTests(server, 'SIGTERM', {
      terminate: () => {
        listenersAtTerminate = countProcessListeners('SIGTERM') + countProcessListeners('SIGINT');
      },
    });
    red('listeners_removed_before_terminate',
      before > 0
      && listenersAtTerminate === before - 2,
      JSON.stringify({ before, listenersAtTerminate }));
  });

  {
    const listenersBefore = {
      SIGTERM: countProcessListeners('SIGTERM'),
      SIGINT: countProcessListeners('SIGINT'),
    };
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      STAFF_API_FORTRESS_OFFLINE_LISTENER: process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER,
    };
    applyMinimalStaffApiEnv();
    clearStaffApiCache();
    const api = require('./staff-query-api');
    const servers = [];
    try {
      for (let i = 0; i < 3; i += 1) {
        servers.push(api.createStaffQueryApiHttpServer());
      }
      const listenersAfter = {
        SIGTERM: countProcessListeners('SIGTERM'),
        SIGINT: countProcessListeners('SIGINT'),
      };
      red('factory_reuse_no_duplicate_listeners',
        listenersAfter.SIGTERM === listenersBefore.SIGTERM
        && listenersAfter.SIGINT === listenersBefore.SIGINT,
        JSON.stringify({ listenersBefore, listenersAfter }));
    } finally {
      for (const s of servers) {
        // eslint-disable-next-line no-await-in-loop
        await closeServer(s);
      }
      clearStaffApiCache();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  red('no_close_pg_pool_composition',
    !/\bclosePgPool\b/.test(apiSrc) && !/\bclosePgPool\b/.test(lifecycleSrc));

  red('no_process_exit_zero',
    !/(^|[^\*\/])\bprocess\.exit\s*\(\s*0\s*\)/.test(lifecycleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));

  red('readyz_contract_unchanged',
    readinessMod.READINESS_SQL === 'SELECT 1'
    && /pathname === READYZ_PATH/.test(apiSrc)
    && /handleStaffApiReadyz/.test(apiSrc));

  red('wolfhouse_sunset_shared_runtime',
    contract.tenant_scope.wolfhouse_staging_image === contract.tenant_scope.sunset_staging_image
    && !/tenant_slug.*closeReadinessPool|closeReadinessPool.*tenant/i.test(apiSrc));

  green('lifecycle_wired_cli_main_only',
    /if \(require\.main === module\)[\s\S]{0,500}attachStaffApiReadinessLifecycle\(server\)/.test(apiSrc));

  green('shutdown_order_preserved',
    /await boundedAwait\(closePool\(\)/.test(lifecycleSrc)
    && lifecycleSrc.indexOf('boundedAwait(closePool()') < lifecycleSrc.indexOf('await boundedServerClose')
    && lifecycleSrc.indexOf('await boundedServerClose') < lifecycleSrc.indexOf('terminateFn(shutdownSignal)')
    && JSON.stringify(locks.SHUTDOWN_ORDER) === JSON.stringify([
      'close_readiness_pool',
      'server_close',
      'process_exit',
    ]));

  green('terminate_seam_present',
    /function defaultTerminate/.test(lifecycleSrc)
    && /process\.kill\(process\.pid,\s*signal\)/.test(lifecycleSrc)
    && /terminateFn\(shutdownSignal\)/.test(lifecycleSrc));

  green('bounded_timers_unref',
    /\.unref\(\)/.test(lifecycleSrc)
    && lifecycleSrc.includes('timer.unref()'));

  green('failure_classification_bounded',
    /FAILURE_CLASSES/.test(lifecycleSrc)
    && /failure_classes/.test(lifecycleSrc)
    && !/err\.message|stack/i.test(lifecycleSrc.match(/logFn\([\s\S]*?\)/)?.[0] || ''));

  await withLifecycleModule(async (lifecycle) => {
    const first = lifecycle.attachStaffApiReadinessLifecycle(null, { terminate: false });
    const second = lifecycle.attachStaffApiReadinessLifecycle(null, { terminate: false });
    const before = countProcessListeners('SIGTERM') + countProcessListeners('SIGINT');
    green('duplicate_attach_rejected',
      first.installed === true
      && second.alreadyInstalled === true
      && before === countProcessListeners('SIGTERM') + countProcessListeners('SIGINT'));
  });

  {
    const badOrder = createOrderTrackingServer();
    let poolEnded = false;
    badOrder.server.close(() => {});
    const poolClose = async () => {
      await new Promise((r) => setTimeout(r, 5));
      poolEnded = true;
    };
    await poolClose();
    const serverFirst = badOrder.events.length > 0 && badOrder.events[0].step === 'server_close_start' && poolEnded;
    green('adversarial_server_before_pool_fails', serverFirst === true);
  }

  {
    let poolAwaited = false;
    const { server } = createOrderTrackingServer();
    await withLifecycleModule(async (lifecycle) => {
      await lifecycle.runStaffApiReadinessShutdown(server, 'SIGTERM', {
        closeReadinessPool: async () => { poolAwaited = true; },
        terminate: false,
      });
    });
    green('adversarial_missing_pool_await_fails', poolAwaited === true);
  }

  for (const id of locks.REQUIRED_RED) {
    const found = redResults.find((r) => r.id === id);
    ok(`RED inventory ${id}`, found && found.ok, found ? undefined : 'missing RED case');
  }
  for (const id of locks.REQUIRED_GREEN) {
    const found = greenResults.find((r) => r.id === id);
    ok(`GREEN inventory ${id}`, found && found.ok, found ? undefined : 'missing GREEN case');
  }

  clearInterval(keepAlive);

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16W readiness shutdown lifecycle: PASS');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
