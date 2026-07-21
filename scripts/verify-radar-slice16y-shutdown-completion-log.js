'use strict';

/**
 * verify:radar-slice16y-shutdown-completion-log — RADAR Slice 16Y
 *
 * Offline RED/GREEN gate: one bounded non-sensitive readiness-shutdown completion
 * record per Staff API shutdown. Proves SIGTERM/SIGINT success and pool/server
 * failure classifications via real child processes; rejects secrets/tokens/PID/
 * URLs/error text/timing. Live signal evidence remains open. No live deploy.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16y-shutdown-completion-log');

const MASTER = locks.MASTER_BASIS;
const CONTRACT_REL = 'fixtures/radar-operations/slice16y-expected-contract.json';

const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]{20,}/,
  /whsec_[A-Za-z0-9]+/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /password["']?\s*[:=]\s*["'][^"']{8,}/i,
  /ACCOUNT_KEY["']?\s*[:=]\s*["'][^"']{16,}/i,
  new RegExp(String.raw`postgres(?:ql)?:` + String.raw`\/\/[^\s"']+`, 'i'),
  /LUNA_BOT_INTERNAL_TOKEN|DATABASE_URL|STRIPE_SECRET/i,
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

function pathExists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function countProcessListeners(event) {
  return process.listenerCount(event);
}

function clearLifecycleCache() {
  delete require.cache[require.resolve('./lib/staff-api-readiness')];
  delete require.cache[require.resolve('./lib/staff-api-readiness-lifecycle')];
  try {
    delete require.cache[require.resolve('./lib/staff-api-readiness-shutdown-completion-log')];
  } catch (_) {
    // module may not exist yet (RED)
  }
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
  clearLifecycleCache();
  let lifecycle;
  let readiness;
  let completion;
  try {
    lifecycle = require('./lib/staff-api-readiness-lifecycle');
    readiness = require('./lib/staff-api-readiness');
    try {
      completion = require('./lib/staff-api-readiness-shutdown-completion-log');
    } catch (_) {
      completion = null;
    }
  } catch (err) {
    return fn(null, null, null, err);
  }
  lifecycle._resetStaffApiReadinessLifecycleForTests();
  readiness._resetReadinessPoolStateForTests();
  try {
    return await fn(lifecycle, readiness, completion, null);
  } finally {
    lifecycle._resetStaffApiReadinessLifecycleForTests();
    readiness._resetReadinessPoolStateForTests();
    clearLifecycleCache();
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
      resolve({ code: -1, stdout, stderr: `${stderr}\nTIMEOUT`, signal: null });
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

function parseJsonLines(stdout) {
  return String(stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

function completionRecords(linesOrStdout) {
  const objs = Array.isArray(linesOrStdout)
    ? linesOrStdout.map((l) => {
      if (l && typeof l === 'object') return l;
      try { return JSON.parse(String(l)); } catch { return null; }
    }).filter(Boolean)
    : parseJsonLines(linesOrStdout);
  return objs.filter((o) => o && o.event === locks.EVENT_NAME);
}

function writeChildHarness(opts) {
  const harnessPath = path.join(
    __dirname,
    `_tmp-16y-child-${Date.now()}-${Math.random().toString(36).slice(2)}.js`,
  );
  const poolDelayMs = opts.poolDelayMs ?? 20;
  const poolScript = opts.poolScript || `
    readiness._setReadinessPoolForTests({
      connect: () => Promise.resolve({ query: async () => ({ rows: [{ '?column?': 1 }] }), release() {} }),
      async end() { await new Promise((r) => setTimeout(r, ${poolDelayMs})); },
      get totalCount() { return 0; }, get idleCount() { return 0; }, get waitingCount() { return 0; },
    });
  `;
  const extraSignals = opts.extraSignals
    ? `setTimeout(() => { process.kill(process.pid, '${opts.extraSignals}'); }, ${opts.extraSignalDelayMs ?? 60});`
    : '';
  const lifecycleOpts = opts.lifecycleOpts || '';
  const secretCanary = opts.secretCanary
    ? `const SECRET_CANARY = ${JSON.stringify(opts.secretCanary)};`
    : 'const SECRET_CANARY = null;';

  fs.writeFileSync(harnessPath, `'use strict';
const http = require('http');
const lifecycle = require('./lib/staff-api-readiness-lifecycle');
const readiness = require('./lib/staff-api-readiness');
readiness._resetReadinessPoolStateForTests();
lifecycle._resetStaffApiReadinessLifecycleForTests();
${secretCanary}
${poolScript}
const server = http.createServer();
server.listen(0, '127.0.0.1', () => {
  lifecycle.attachStaffApiReadinessLifecycle(server, {
    poolCloseTimeoutMs: 5000,
    serverCloseTimeoutMs: 5000,
    terminate: (signal) => {
      console.log(JSON.stringify({ type: 'terminate', signal }));
      process.exit(signal === 'SIGINT' ? 130 : 143);
    },
    ${lifecycleOpts}
  });
  console.log(JSON.stringify({ type: 'ready' }));
  ${extraSignals}
});
`);
  return harnessPath;
}

function assertSafeShape(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { ok: false, detail: 'not_object' };
  if (rec.event !== locks.EVENT_NAME) return { ok: false, detail: 'bad_event' };
  for (const key of Object.keys(rec)) {
    if (!locks.ALLOWED_RECORD_KEYS.includes(key)) return { ok: false, detail: `unexpected:${key}` };
    if (locks.FORBIDDEN_RECORD_KEYS.includes(key)) return { ok: false, detail: `forbidden:${key}` };
  }
  for (const key of locks.ALLOWED_RECORD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(rec, key)) return { ok: false, detail: `missing:${key}` };
  }
  if (!locks.ALLOWED_SIGNALS.includes(rec.original_signal)) return { ok: false, detail: 'bad_signal' };
  if (!locks.ALLOWED_POOL_RESULTS.includes(rec.pool_close_result)) return { ok: false, detail: 'bad_pool' };
  if (!locks.ALLOWED_SERVER_RESULTS.includes(rec.server_close_result)) return { ok: false, detail: 'bad_server' };
  if (!Array.isArray(rec.failure_classes)) return { ok: false, detail: 'bad_classes' };
  if (rec.completion !== true) return { ok: false, detail: 'completion_not_true' };
  const blob = JSON.stringify(rec);
  for (const re of SECRET_PATTERNS) {
    if (re.test(blob)) return { ok: false, detail: `secret:${re}` };
  }
  if (/\bpid\b|"duration_ms"|"elapsed_ms"|Error:|at\s+\S+\s+\(/i.test(blob)) {
    return { ok: false, detail: 'leaky_blob' };
  }
  return { ok: true };
}

(async () => {
  console.log('verify:radar-slice16y-shutdown-completion-log — RADAR Slice 16Y\n');

  const keepAlive = setInterval(() => {}, 1 << 30);

  const contractExists = pathExists(CONTRACT_REL);
  const completionExists = pathExists(locks.COMPLETION_LOG_REL);
  const lifecycleSrc = pathExists(locks.LIFECYCLE_LIB_REL) ? readText(locks.LIFECYCLE_LIB_REL) : '';
  const readinessMod = pathExists(locks.READINESS_LIB_REL)
    ? require('./lib/staff-api-readiness')
    : null;
  const apiSrc = pathExists(locks.STAFF_API_REL) ? readText(locks.STAFF_API_REL) : '';
  const contract = contractExists ? readJson(CONTRACT_REL) : null;
  const doc = pathExists('docs/RADAR-OPERATIONS-GATE-LEDGER.md')
    ? readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md')
    : '';
  const matrix = pathExists('fixtures/radar-operations/gate-matrix.json')
    ? readJson('fixtures/radar-operations/gate-matrix.json')
    : null;
  const findings = pathExists('fixtures/radar-operations/findings.md')
    ? readText('fixtures/radar-operations/findings.md')
    : '';

  ok('contract present', contractExists);
  ok('contract branch/master/outcome',
    contract
    && contract.branch === locks.BRANCH
    && contract.master_basis === MASTER
    && contract.outcome_id === locks.OUTCOME_ID
    && contract.progress_class === locks.PROGRESS_CLASS);

  await withLifecycleModule(async (lifecycle, readiness, completion) => {
    if (!completion) {
      red('schema_fields_bounded', false, 'completion module missing');
      red('forbidden_keys_rejected', false, 'completion module missing');
      red('secret_token_patterns_rejected', false, 'completion module missing');
      red('pid_timing_url_error_rejected', false, 'completion module missing');
      return;
    }

    const built = completion.buildShutdownCompletionRecord({
      original_signal: 'SIGTERM',
      pool_close_result: 'ok',
      server_close_result: 'ok',
      failure_classes: [],
    });
    const safe = assertSafeShape(built);
    const assertFn = completion.assertSafeShutdownCompletionRecord(built);
    red('schema_fields_bounded',
      safe.ok && assertFn.ok && built.completion === true,
      JSON.stringify({ safe, assertFn, built }));

    const leaky = completion.buildShutdownCompletionRecord({
      original_signal: 'SIGTERM',
      pool_close_result: 'ok',
      server_close_result: 'ok',
      failure_classes: [],
      pid: process.pid,
      secret: ('sk_'+'live_'+'ABC1234567890'),
      token: ('wh'+'sec_'+'abcdefghijklmnopqrstuvwxyz'),
      url: 'https://evil.example/path?x=1',
      error_message: 'boom',
      stack: 'Error: boom\n    at x.js:1:1',
      duration_ms: 1234,
      message: 'nope',
    });
    red('forbidden_keys_rejected',
      leaky
      && !Object.keys(leaky).some((k) => locks.FORBIDDEN_RECORD_KEYS.includes(k))
      && assertSafeShape(leaky).ok
      && completion.assertSafeShutdownCompletionRecord(leaky).ok,
      JSON.stringify(leaky));

    const adversarial = {
      event: locks.EVENT_NAME,
      original_signal: 'SIGTERM',
      pool_close_result: 'ok',
      server_close_result: 'ok',
      failure_classes: [],
      completion: true,
      password: 'hunter2hunter2',
      token: ('sk_'+'test_'+'abcdefghijklmnopqrstuvwxyz'),
      dsn: 'postgres://user:pass@host/db',
    };
    const advAssert = completion.assertSafeShutdownCompletionRecord(adversarial);
    red('secret_token_patterns_rejected',
      advAssert.ok === false,
      JSON.stringify(advAssert));

    const pidTiming = {
      event: locks.EVENT_NAME,
      original_signal: 'SIGINT',
      pool_close_result: 'ok',
      server_close_result: 'ok',
      failure_classes: [],
      completion: true,
      pid: 12345,
      duration_ms: 50,
      url: 'https://example.com',
      error: 'fail',
    };
    red('pid_timing_url_error_rejected',
      completion.assertSafeShutdownCompletionRecord(pidTiming).ok === false);
  });

  await withLifecycleModule(async (lifecycle) => {
    if (!lifecycle) {
      red('success_emits_exactly_one', false, 'lifecycle missing');
      return;
    }
    const logs = [];
    const tracker = createOrderTrackingServer();
    await lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGTERM', {
      closeReadinessPool: async () => {},
      log: (rec) => logs.push(rec),
      terminate: () => {},
    });
    red('success_emits_exactly_one',
      logs.length === 1
      && assertSafeShape(logs[0]).ok
      && logs[0].pool_close_result === 'ok'
      && logs[0].server_close_result === 'ok'
      && logs[0].failure_classes.length === 0
      && logs[0].original_signal === 'SIGTERM'
      && logs[0].completion === true,
      JSON.stringify(logs));
  });

  await withLifecycleModule(async (lifecycle) => {
    if (!lifecycle) {
      red('failure_emits_exactly_one_with_classes', false);
      return;
    }
    const logs = [];
    await lifecycle._triggerStaffApiReadinessShutdownForTests(
      { listening: true, close(cb) { cb(new Error('close failed')); } },
      'SIGINT',
      {
        closeReadinessPool: () => Promise.reject(new Error('pool boom')),
        poolCloseTimeoutMs: 50,
        serverCloseTimeoutMs: 50,
        log: (rec) => logs.push(rec),
        terminate: () => {},
      },
    );
    red('failure_emits_exactly_one_with_classes',
      logs.length === 1
      && assertSafeShape(logs[0]).ok
      && logs[0].pool_close_result === 'rejected'
      && logs[0].server_close_result === 'rejected'
      && logs[0].failure_classes.includes('pool_close_rejected')
      && logs[0].failure_classes.includes('server_close_rejected')
      && !/pool boom|close failed/i.test(JSON.stringify(logs)),
      JSON.stringify(logs));
  });

  await withLifecycleModule(async (lifecycle) => {
    if (!lifecycle) {
      red('same_signal_exactly_one', false);
      red('repeated_signals_exactly_one', false);
      red('mixed_signals_exactly_one', false);
      return;
    }
    const logs = [];
    const tracker = createOrderTrackingServer();
    const p = lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGTERM', {
      closeReadinessPool: () => new Promise((r) => setTimeout(r, 80)),
      log: (rec) => logs.push(rec),
      terminate: () => {},
    });
    void lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGTERM', {
      log: (rec) => logs.push(rec),
      terminate: () => {},
    });
    await p;
    red('same_signal_exactly_one', logs.length === 1 && logs[0].original_signal === 'SIGTERM',
      JSON.stringify(logs));
  });

  await withLifecycleModule(async (lifecycle) => {
    if (!lifecycle) return;
    const logs = [];
    const tracker = createOrderTrackingServer();
    const p = lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGINT', {
      closeReadinessPool: () => new Promise((r) => setTimeout(r, 80)),
      log: (rec) => logs.push(rec),
      terminate: () => {},
    });
    for (let i = 0; i < 4; i += 1) {
      void lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGINT', {
        log: (rec) => logs.push(rec),
        terminate: () => {},
      });
    }
    await p;
    red('repeated_signals_exactly_one', logs.length === 1 && logs[0].original_signal === 'SIGINT',
      JSON.stringify(logs));
  });

  await withLifecycleModule(async (lifecycle) => {
    if (!lifecycle) return;
    const logs = [];
    const tracker = createOrderTrackingServer();
    const p = lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGTERM', {
      closeReadinessPool: () => new Promise((r) => setTimeout(r, 80)),
      log: (rec) => logs.push(rec),
      terminate: () => {},
    });
    void lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGINT', {
      log: (rec) => logs.push(rec),
      terminate: () => {},
    });
    void lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGTERM', {
      log: (rec) => logs.push(rec),
      terminate: () => {},
    });
    await p;
    red('mixed_signals_exactly_one',
      logs.length === 1 && logs[0].original_signal === 'SIGTERM',
      JSON.stringify(logs));
  });

  await withLifecycleModule(async (lifecycle) => {
    if (!lifecycle) {
      red('logger_throw_does_not_block_detach', false);
      red('logger_throw_does_not_block_terminate', false);
      red('terminate_throw_no_duplicate_record', false);
      red('emit_before_detach_and_terminate', false);
      return;
    }
    const before = {
      SIGTERM: countProcessListeners('SIGTERM'),
      SIGINT: countProcessListeners('SIGINT'),
    };
    const tracker = createOrderTrackingServer();
    lifecycle.attachStaffApiReadinessLifecycle(tracker.server, { terminate: false });
    let terminateCalls = 0;
    let listenersAtTerminate = null;
    await lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGTERM', {
      closeReadinessPool: async () => {},
      log: () => { throw new Error('logger boom'); },
      terminate: () => {
        terminateCalls += 1;
        listenersAtTerminate = countProcessListeners('SIGTERM') + countProcessListeners('SIGINT');
      },
    });
    const after = {
      SIGTERM: countProcessListeners('SIGTERM'),
      SIGINT: countProcessListeners('SIGINT'),
    };
    red('logger_throw_does_not_block_detach',
      after.SIGTERM === before.SIGTERM && after.SIGINT === before.SIGINT,
      JSON.stringify({ before, after }));
    red('logger_throw_does_not_block_terminate',
      terminateCalls === 1
      && listenersAtTerminate === before.SIGTERM + before.SIGINT,
      JSON.stringify({ terminateCalls, listenersAtTerminate, before }));
  });

  await withLifecycleModule(async (lifecycle) => {
    if (!lifecycle) return;
    const logs = [];
    const tracker = createOrderTrackingServer();
    await lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGINT', {
      closeReadinessPool: async () => {},
      log: (rec) => {
        logs.push(rec);
      },
      terminate: () => { throw new Error('terminate boom'); },
    });
    red('terminate_throw_no_duplicate_record',
      logs.length === 1 && assertSafeShape(logs[0]).ok,
      JSON.stringify(logs));
  });

  await withLifecycleModule(async (lifecycle, _r, completion) => {
    if (!lifecycle || !completion) {
      red('default_logger_one_stdout_json_line', false);
      return;
    }
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => { lines.push(args.map(String).join(' ')); };
    try {
      const tracker = createOrderTrackingServer();
      await lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGTERM', {
        closeReadinessPool: async () => {},
        terminate: () => {},
      });
    } finally {
      console.log = origLog;
    }
    const recs = completionRecords(lines);
    red('default_logger_one_stdout_json_line',
      recs.length === 1
      && lines.filter((l) => l.includes(locks.EVENT_NAME)).length === 1
      && assertSafeShape(recs[0]).ok,
      JSON.stringify({ lines, recs }));
  });

  await withLifecycleModule(async (lifecycle) => {
    if (!lifecycle) {
      red('injected_logger_supported', false);
      return;
    }
    const injected = [];
    const tracker2 = createOrderTrackingServer();
    await lifecycle._triggerStaffApiReadinessShutdownForTests(tracker2.server, 'SIGINT', {
      closeReadinessPool: async () => {},
      log: (rec) => injected.push(rec),
      terminate: () => {},
    });
    red('injected_logger_supported',
      injected.length === 1 && assertSafeShape(injected[0]).ok && injected[0].original_signal === 'SIGINT',
      JSON.stringify(injected));
  });

  await withLifecycleModule(async (lifecycle) => {
    if (!lifecycle) return;
    const order = [];
    const tracker = createOrderTrackingServer();
    lifecycle.attachStaffApiReadinessLifecycle(tracker.server, { terminate: false });
    await lifecycle._triggerStaffApiReadinessShutdownForTests(tracker.server, 'SIGTERM', {
      closeReadinessPool: async () => {},
      log: () => { order.push('log'); },
      terminate: () => {
        order.push('terminate');
        order.push(`listeners=${countProcessListeners('SIGTERM') + countProcessListeners('SIGINT')}`);
      },
    });
    red('emit_before_detach_and_terminate',
      order[0] === 'log'
      && order[1] === 'terminate'
      && /listeners=\d+/.test(order[2]),
      JSON.stringify(order));
  });

  {
    const harness = writeChildHarness({});
    try {
      const result = await spawnNode(harness, 8000, 'SIGTERM');
      const recs = completionRecords(result.stdout);
      const terminate = parseJsonLines(result.stdout).find((l) => l.type === 'terminate');
      red('child_sigterm_success_one_record',
        result.code === 143
        && recs.length === 1
        && assertSafeShape(recs[0]).ok
        && recs[0].original_signal === 'SIGTERM'
        && recs[0].pool_close_result === 'ok'
        && recs[0].server_close_result === 'ok'
        && terminate && terminate.signal === 'SIGTERM',
        JSON.stringify({ code: result.code, recs, terminate, stderr: result.stderr.slice(0, 200) }));
    } finally {
      fs.unlinkSync(harness);
    }
  }

  {
    const harness = writeChildHarness({});
    try {
      const result = await spawnNode(harness, 8000, 'SIGINT');
      const recs = completionRecords(result.stdout);
      const terminate = parseJsonLines(result.stdout).find((l) => l.type === 'terminate');
      red('child_sigint_success_one_record',
        result.code === 130
        && recs.length === 1
        && assertSafeShape(recs[0]).ok
        && recs[0].original_signal === 'SIGINT'
        && terminate && terminate.signal === 'SIGINT',
        JSON.stringify({ code: result.code, recs, terminate }));
    } finally {
      fs.unlinkSync(harness);
    }
  }

  {
    const harness = writeChildHarness({
      lifecycleOpts: `closeReadinessPool: () => Promise.reject(new Error('pool child fail ' + ('sk_'+'live_'+'SHOULD_NOT_LEAK'))),`,
    });
    try {
      const result = await spawnNode(harness, 8000, 'SIGTERM');
      const recs = completionRecords(result.stdout);
      red('child_pool_failure_classification',
        result.code === 143
        && recs.length === 1
        && recs[0].pool_close_result === 'rejected'
        && recs[0].failure_classes.includes('pool_close_rejected')
        && !/sk_live_|pool child fail/i.test(result.stdout + result.stderr),
        JSON.stringify({ code: result.code, recs, stderr: result.stderr.slice(0, 200) }));
    } finally {
      fs.unlinkSync(harness);
    }
  }

  {
    const harness = writeChildHarness({
      lifecycleOpts: `
    closeReadinessPool: async () => {},
    // force server close rejection via monkeypatch after listen
      `,
      poolScript: `
    readiness._setReadinessPoolForTests({
      connect: () => Promise.resolve({ query: async () => ({ rows: [{ '?column?': 1 }] }), release() {} }),
      async end() {},
      get totalCount() { return 0; }, get idleCount() { return 0; }, get waitingCount() { return 0; },
    });
      `,
    });
    // Rewrite harness for server failure: patch server.close after create
    fs.writeFileSync(harness, `'use strict';
const http = require('http');
const lifecycle = require('./lib/staff-api-readiness-lifecycle');
const readiness = require('./lib/staff-api-readiness');
readiness._resetReadinessPoolStateForTests();
lifecycle._resetStaffApiReadinessLifecycleForTests();
readiness._setReadinessPoolForTests({
  connect: () => Promise.resolve({ query: async () => ({ rows: [{ '?column?': 1 }] }), release() {} }),
  async end() {},
  get totalCount() { return 0; }, get idleCount() { return 0; }, get waitingCount() { return 0; },
});
const server = http.createServer();
const origClose = server.close.bind(server);
server.close = (cb) => { if (typeof cb === 'function') cb(new Error('server close fail ' + ('wh'+'sec_'+'SHOULD_NOT_LEAK'))); };
server.listen(0, '127.0.0.1', () => {
  lifecycle.attachStaffApiReadinessLifecycle(server, {
    poolCloseTimeoutMs: 5000,
    serverCloseTimeoutMs: 5000,
    terminate: (signal) => {
      console.log(JSON.stringify({ type: 'terminate', signal }));
      process.exit(signal === 'SIGINT' ? 130 : 143);
    },
  });
  console.log(JSON.stringify({ type: 'ready' }));
});
`);
    try {
      const result = await spawnNode(harness, 8000, 'SIGINT');
      const recs = completionRecords(result.stdout);
      red('child_server_failure_classification',
        result.code === 130
        && recs.length === 1
        && recs[0].server_close_result === 'rejected'
        && recs[0].failure_classes.includes('server_close_rejected')
        && !/whsec_|server close fail/i.test(result.stdout + result.stderr),
        JSON.stringify({ code: result.code, recs, stderr: result.stderr.slice(0, 200) }));
    } finally {
      fs.unlinkSync(harness);
    }
  }

  {
    const harness = writeChildHarness({
      secretCanary: ('sk_'+'live_'+'LEAKTEST1234567890abcdef'),
      lifecycleOpts: `
    closeReadinessPool: async () => {},
    log: (rec) => {
      // adversarial: attempt to smuggle secret into logger side-channel must not appear in default stdout JSON
      console.log(JSON.stringify(rec));
    },
      `,
    });
    try {
      const result = await spawnNode(harness, 8000, 'SIGTERM');
      const blob = result.stdout + result.stderr;
      const recs = completionRecords(result.stdout);
      red('child_secret_token_absent_from_stdout',
        recs.length === 1
        && assertSafeShape(recs[0]).ok
        && !new RegExp('sk_'+'live_'+'LEAKTEST|wh'+'sec_|eyJ[A-Za-z0-9_-]{20,}\\.').test(blob)
        && !SECRET_PATTERNS.some((re) => re.test(JSON.stringify(recs[0]))),
        JSON.stringify({ recs, sample: blob.slice(0, 300) }));
    } finally {
      fs.unlinkSync(harness);
    }
  }

  red('readyz_contract_unchanged',
    readinessMod
    && readinessMod.READINESS_SQL === 'SELECT 1'
    && /pathname === READYZ_PATH/.test(apiSrc)
    && /handleStaffApiReadyz/.test(apiSrc));

  red('no_close_pg_pool_composition',
    !/\bclosePgPool\b/.test(apiSrc) && !/\bclosePgPool\b/.test(lifecycleSrc));

  red('sixteen_w_semantics_preserved',
    /attachStaffApiReadinessLifecycle/.test(lifecycleSrc)
    && /runStaffApiReadinessShutdown/.test(lifecycleSrc)
    && /process\.on\('SIGTERM'/.test(lifecycleSrc)
    && /process\.on\('SIGINT'/.test(lifecycleSrc)
    && !/process\.once\('SIGTERM'/.test(lifecycleSrc)
    && /detachOwnedSignalListeners/.test(lifecycleSrc)
    && /terminateFn\(shutdownSignal\)/.test(lifecycleSrc)
    && /FAILURE_CLASSES/.test(lifecycleSrc));

  green('completion_wired_in_lifecycle',
    completionExists
    && /staff-api-readiness-shutdown-completion-log/.test(lifecycleSrc)
    && (/buildShutdownCompletionRecord|emitStaffApiReadinessShutdownCompleted|defaultShutdownCompletionLogger/.test(lifecycleSrc)));

  green('always_emits_on_shutdown',
    /completion\s*:\s*true/.test(lifecycleSrc)
    || /buildShutdownCompletionRecord|emitStaffApiReadinessShutdownCompleted/.test(lifecycleSrc));

  green('failure_classes_enum_bounded',
    /FAILURE_CLASSES/.test(lifecycleSrc)
    && /pool_close_throw/.test(lifecycleSrc)
    && /failure_classes/.test(lifecycleSrc));

  const g02 = matrix && Array.isArray(matrix.gates)
    ? matrix.gates.find((g) => g.id === locks.GATE_ID)
    : null;
  green('ledger_source_only_live_open',
    contract
    && contract.live_deploy === false
    && contract.live_mutation === false
    && /open/i.test(String(contract.final_controlled_drill && contract.final_controlled_drill.status))
    && /SIGTERM|lifecycle.?live/i.test(doc)
    && g02
    && Array.isArray(g02.gaps)
    && g02.gaps.some((g) => /SIGINT|SIGTERM|lifecycle.?live|closeReadinessPool.?live|zero.?downtime|readyz.?503/i.test(String(g)))
    && /16Y|shutdown.?completion/i.test(doc + findings + JSON.stringify(matrix)),
    'SIGINT/readyz=503/zero-downtime (or legacy SIGTERM) gap must remain open');

  green('g02_remains_partial',
    g02 && g02.verdict === 'partial'
    && matrix
    && (matrix.slice === locks.SLICE || matrix.slice === 'RADAR-16Z' || (matrix.slice === 'RADAR-16AA' || matrix.slice === 'RADAR-16AB' || matrix.slice === 'RADAR-16AC' || (matrix.slice === 'RADAR-16AD' || (matrix.slice === 'RADAR-16AF' || matrix.slice === 'RADAR-16AG'))))
    && !/\bG02\b[^\n.]{0,40}\b(is|as|fully)\s+proven\b/i.test(doc)
    && !/\bproven\b[^\n.]{0,20}\bG02\b/i.test(doc)
    && /G02 remains partial|G02 verdict stays `?partial`?/i.test(doc));

  green('wolfhouse_sunset_shared_runtime',
    contract
    && contract.tenant_scope
    && contract.tenant_scope.wolfhouse_staging_image === contract.tenant_scope.sunset_staging_image);

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
  console.log('RADAR 16Y readiness shutdown completion log: PASS');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
