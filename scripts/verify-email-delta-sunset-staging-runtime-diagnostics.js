'use strict';

/**
 * Hostile offline gate: Sunset delta poller/runtime diagnostic telemetry.
 *
 * Proves closed-enum stage + sanitized code at the runtime tick boundary,
 * known grant/401/cursor/query/transport/store/HTTP-class classifications, and that
 * tokens, URLs/cursors, Graph bodies, mailbox/message IDs, emails, subjects,
 * headers, secrets, exception messages/stacks, and provider payloads cannot
 * leak into the log. External fail-closed behavior stays generic.
 *
 * No live/DB/Azure/deploy/Graph/network.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LIB_REL = 'scripts/lib/email-delta-sunset-staging-runtime-diagnostics.js';
const VERIFY_REL = 'scripts/verify-email-delta-sunset-staging-runtime-diagnostics.js';
const COMP_REL = 'scripts/lib/email-delta-sunset-staging-runtime-composition.js';
const WORKER_REL = 'scripts/lib/email-delta-sunset-staging-worker.js';
const PKG_PATH = path.join(ROOT, 'package.json');

const PLANTED = [
  'password=LEAKED_SECRET',
  'pii-user@example.com',
  'https://graph.microsoft.com/v1.0/users/ada@example.com/messages/delta?$skiptoken=CURSOR_LEAK',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.LEAKED_TOKEN',
  'AAMkAGI2TG93c2U-mailbox-id',
  'AAMkAGI2TWVzc2FnZS1pZA',
  'Re: booking subject NEVER_LOG',
  'Authorization: Bearer leaked-header',
  'client_secret=super-secret-value',
  'support@lunafrontdesk.com',
].join(' ');

const {
  EVENT_NAME,
  STAGES,
  CODES,
  EVENT_KEYS,
  classifyDeltaRuntimeGrantStatus,
  classifyDeltaRuntimeHttpStatus,
  classifyDeltaRuntimeTransportError,
  classifyDeltaRuntimeQueryFailure,
  classifyDeltaRuntimePageFailure,
  classifyDeltaRuntimePageInternalStage,
  classifyDeltaRuntimeGrantSessionInternalStage,
  classifyDeltaRuntimeUnknown,
  buildDeltaRuntimeTickFailedEvent,
  assertSafeDeltaRuntimeTickFailedEvent,
  createDeltaRuntimeDiagnosticSink,
  emitDeltaRuntimeTickFailed,
  readTrustedDeltaRuntimeDiagnostic,
  brandDeltaRuntimeDiagnostic,
} = require('./lib/email-delta-sunset-staging-runtime-diagnostics');

const {
  AUTHORITY_BOUND_PAGE_INTERNAL_STAGES,
  FAILURE_CODE: PAGE_FAILURE_CODE,
  createAuthorityBoundMessagesDeltaPageOperation,
  readTrustedAuthorityBoundPageInternalStage,
  bindTrustedAuthorityBoundPageInternalStageObserver,
} = require('./lib/email-authority-bound-messages-delta-page-operation');

const {
  DELEGATED_GRANT_ACCESS_SESSION_INTERNAL_STAGES,
  readTrustedDelegatedGrantAccessSessionInternalStage,
} = require('./lib/email-delegated-grant-access-session');

const INTERNAL_STAGES = Object.freeze([
  'authority',
  'status',
  'lease',
  'grant',
  'transport',
  'seal',
  'store',
  'release',
]);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function noLeak(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  assert.doesNotMatch(text, /LEAKED|pii-user|skiptoken|CURSOR_LEAK|eyJhbGci|AAMkAGI2|NEVER_LOG|Bearer leaked|super-secret|lunafrontdesk|password=/i);
}

test('package script and exports are exact/frozen', () => {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  assert.equal(
    pkg.scripts['verify:email-delta-sunset-staging-runtime-diagnostics'],
    'node scripts/verify-email-delta-sunset-staging-runtime-diagnostics.js',
  );
  const mod = require('./lib/email-delta-sunset-staging-runtime-diagnostics');
  assert.equal(Object.isFrozen(mod), true);
  assert.equal(EVENT_NAME, 'email_delta_runtime_tick_failed');
  assert.deepEqual(EVENT_KEYS, Object.freeze(['event', 'stage', 'code']));
  assert.deepEqual(STAGES, Object.freeze([
    'schema', 'query', 'grant', 'cursor', 'transport', 'store', 'page', 'project', 'tick',
    'authority', 'status', 'lease', 'seal', 'release',
  ]));
  assert.deepEqual(CODES, Object.freeze([
    'dead_grant', 'unauthorized', 'cursor', 'query', 'transport', 'store', 'unknown',
    'authority', 'status', 'lease', 'grant', 'seal', 'release',
    'open', 'secret', 'token', 'response', 'reseal', 'commit',
    'bad_request', 'forbidden', 'not_found', 'timeout', 'throttled', 'server_error',
  ]));
  assert.deepEqual(AUTHORITY_BOUND_PAGE_INTERNAL_STAGES, INTERNAL_STAGES);
  assert.deepEqual(DELEGATED_GRANT_ACCESS_SESSION_INTERNAL_STAGES, Object.freeze([
    'status', 'lease', 'open', 'secret', 'token', 'response',
    'dead_grant', 'reseal', 'commit', 'release',
  ]));
  assert.equal(typeof classifyDeltaRuntimePageInternalStage, 'function');
  assert.equal(typeof classifyDeltaRuntimeGrantSessionInternalStage, 'function');
  assert.equal(typeof readTrustedAuthorityBoundPageInternalStage, 'function');
  assert.equal(typeof bindTrustedAuthorityBoundPageInternalStageObserver, 'function');
  assert.equal(typeof readTrustedDelegatedGrantAccessSessionInternalStage, 'function');
});

test('known grant / 401 / cursor / query / transport / store classifications', () => {
  assert.deepEqual(
    classifyDeltaRuntimeGrantStatus('reauthorization_required'),
    Object.freeze({ stage: 'grant', code: 'dead_grant' }),
  );
  assert.deepEqual(
    classifyDeltaRuntimeGrantStatus('unavailable'),
    Object.freeze({ stage: 'grant', code: 'unknown' }),
  );
  assert.deepEqual(
    classifyDeltaRuntimeGrantStatus('uncertain'),
    Object.freeze({ stage: 'grant', code: 'unknown' }),
  );
  assert.deepEqual(
    classifyDeltaRuntimeHttpStatus(401),
    Object.freeze({ stage: 'transport', code: 'unauthorized' }),
  );
  assert.deepEqual(
    classifyDeltaRuntimeHttpStatus(410),
    Object.freeze({ stage: 'cursor', code: 'cursor' }),
  );
  assert.equal(classifyDeltaRuntimeHttpStatus(200), null);
  assert.deepEqual(
    classifyDeltaRuntimeHttpStatus(400),
    Object.freeze({ stage: 'transport', code: 'bad_request' }),
  );
  assert.deepEqual(
    classifyDeltaRuntimeHttpStatus(500),
    Object.freeze({ stage: 'transport', code: 'server_error' }),
  );
  assert.deepEqual(
    classifyDeltaRuntimeQueryFailure(),
    Object.freeze({ stage: 'query', code: 'query' }),
  );
  assert.deepEqual(
    classifyDeltaRuntimePageFailure(),
    Object.freeze({ stage: 'store', code: 'store' }),
  );
  const timeout = Object.freeze({ code: 'microsoft_graph_messages_delta_page_failed' });
  assert.equal(classifyDeltaRuntimeTransportError(timeout), null);
  assert.deepEqual(
    classifyDeltaRuntimeUnknown(),
    Object.freeze({ stage: 'tick', code: 'unknown' }),
  );
});

test('forged grant/http/transport values cannot classify or leak', () => {
  for (const bad of [
    PLANTED,
    { status: PLANTED },
    { status: 'reauthorization_required', extra: PLANTED },
    Object.assign(Object.create({ status: 'reauthorization_required' }), {}),
    { status: 'invalid_grant' },
    { status: '401' },
    401,
    null,
    undefined,
  ]) {
    const classified = classifyDeltaRuntimeGrantStatus(bad);
    if (classified) noLeak(classified);
    if (bad !== 'reauthorization_required') {
      assert.equal(
        classified == null
          || (classified.stage === 'grant' && classified.code === 'unknown')
          || classified.code !== 'dead_grant'
          || typeof bad === 'string',
        true,
      );
    }
  }
  assert.equal(classifyDeltaRuntimeGrantStatus(PLANTED), null);
  assert.equal(classifyDeltaRuntimeGrantStatus({ status: 'reauthorization_required' }), null);
  assert.equal(classifyDeltaRuntimeHttpStatus(PLANTED), null);
  assert.equal(classifyDeltaRuntimeHttpStatus('401'), null);
  assert.equal(classifyDeltaRuntimeHttpStatus({ statusCode: 401, url: PLANTED }), null);

  const forged = new Error(PLANTED);
  forged.code = 'cursor_gone';
  forged.stage = 'transport';
  forged.graph_stage = 'http_status_not_200';
  forged.body = PLANTED;
  assert.equal(classifyDeltaRuntimeTransportError(forged), null);
  assert.equal(readTrustedDeltaRuntimeDiagnostic(forged), null);
});

test('event builder is exact three-key allowlist and copies nothing extra', () => {
  const good = buildDeltaRuntimeTickFailedEvent({
    stage: 'grant',
    code: 'dead_grant',
    extra: PLANTED,
    message: PLANTED,
    url: PLANTED,
  });
  assert.deepEqual(good, Object.freeze({
    event: 'email_delta_runtime_tick_failed',
    stage: 'grant',
    code: 'dead_grant',
  }));
  assert.deepEqual(Reflect.ownKeys(good), ['event', 'stage', 'code']);
  assert.equal(Object.isFrozen(good), true);
  assert.equal(assertSafeDeltaRuntimeTickFailedEvent(good).ok, true);
  noLeak(good);

  assert.equal(buildDeltaRuntimeTickFailedEvent({ stage: PLANTED, code: 'dead_grant' }), null);
  assert.equal(buildDeltaRuntimeTickFailedEvent({ stage: 'grant', code: PLANTED }), null);
  assert.equal(buildDeltaRuntimeTickFailedEvent({ stage: 'grant' }), null);
  assert.equal(buildDeltaRuntimeTickFailedEvent(null), null);
});

test('hostile sink + emit never log secrets, messages, stacks, or payloads', () => {
  const logs = [];
  const sink = createDeltaRuntimeDiagnosticSink({
    logger(record) { logs.push(record); },
  });
  sink.recordFromThrown(new Error(PLANTED));
  sink.recordFromGrantStatus(PLANTED);
  sink.recordFromHttpStatus(PLANTED);
  sink.recordFromTransportError(Object.assign(new Error(PLANTED), {
    code: PLANTED,
    response: { body: PLANTED, headers: { authorization: PLANTED } },
  }));
  sink.emitFailure();
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], {
    event: 'email_delta_runtime_tick_failed',
    stage: 'tick',
    code: 'unknown',
  });
  noLeak(logs);

  const specific = createDeltaRuntimeDiagnosticSink({
    logger(record) { logs.push(record); },
  });
  specific.recordFromGrantStatus('reauthorization_required');
  specific.recordFromThrown(new Error(PLANTED));
  specific.emitFailure();
  assert.deepEqual(logs[1], {
    event: 'email_delta_runtime_tick_failed',
    stage: 'grant',
    code: 'dead_grant',
  });
  noLeak(logs);
});

const GRAPH_HTTP_STATUS_CLASSES = Object.freeze([
  [400, 'transport', 'bad_request'],
  [401, 'transport', 'unauthorized'],
  [403, 'transport', 'forbidden'],
  [404, 'transport', 'not_found'],
  [408, 'transport', 'timeout'],
  [410, 'cursor', 'cursor'],
  [429, 'transport', 'throttled'],
  [500, 'transport', 'server_error'],
  [502, 'transport', 'server_error'],
  [503, 'transport', 'server_error'],
  [599, 'transport', 'server_error'],
]);

test('closed-enum Graph HTTP status classes stay allowlisted and copy nothing extra', () => {
  for (const [status, stage, code] of GRAPH_HTTP_STATUS_CLASSES) {
    const classified = classifyDeltaRuntimeHttpStatus(status);
    assert.deepEqual(classified, Object.freeze({ stage, code }), String(status));
    assert.equal(STAGES.includes(classified.stage), true, stage);
    assert.equal(CODES.includes(classified.code), true, code);
    assert.deepEqual(Reflect.ownKeys(classified), ['stage', 'code']);
    noLeak(classified);
  }
  for (const untouched of [0, 200, 204, 301, 399, 402, 409, 418, 422, 600, 408.5, '400', '500']) {
    assert.equal(classifyDeltaRuntimeHttpStatus(untouched), null, String(untouched));
  }
  assert.equal(classifyDeltaRuntimeHttpStatus({ statusCode: 403, body: PLANTED, url: PLANTED }), null);
});

test('Graph HTTP status classes beat grant/release and cannot be masked', () => {
  for (const [status, stage, code] of GRAPH_HTTP_STATUS_CLASSES) {
    const logs = [];
    const sink = createDeltaRuntimeDiagnosticSink({
      logger(record) { logs.push(record); },
    });
    sink.recordFromGrantSessionInternalStage('release');
    sink.recordFromPageInternalStage('grant');
    sink.recordFromGrantStatus('unavailable');
    sink.recordFromHttpStatus(status);
    sink.recordFromTransportBoundaryFailure();
    sink.emitFailure();
    assert.equal(logs.length, 1, String(status));
    assert.deepEqual(logs[0], {
      event: 'email_delta_runtime_tick_failed',
      stage,
      code,
    });
    assert.deepEqual(Reflect.ownKeys(logs[0]), ['event', 'stage', 'code']);
    noLeak(logs);
  }

  const deadLogs = [];
  const deadSink = createDeltaRuntimeDiagnosticSink({
    logger(record) { deadLogs.push(record); },
  });
  deadSink.recordFromHttpStatus(400);
  deadSink.recordFromGrantStatus('reauthorization_required');
  deadSink.emitFailure();
  assert.deepEqual(deadLogs[0], {
    event: 'email_delta_runtime_tick_failed',
    stage: 'grant',
    code: 'dead_grant',
  });
});

test('priority keeps dead_grant/401/cursor over later store/unknown', () => {
  const logs = [];
  const sink = createDeltaRuntimeDiagnosticSink({
    logger(record) { logs.push(record); },
  });
  sink.recordFromHttpStatus(401);
  sink.recordFromPageFailure();
  sink.emitFailure();
  assert.deepEqual(logs[0], {
    event: 'email_delta_runtime_tick_failed',
    stage: 'transport',
    code: 'unauthorized',
  });

  const grantSink = createDeltaRuntimeDiagnosticSink({
    logger(record) { logs.push(record); },
  });
  grantSink.recordFromHttpStatus(400);
  grantSink.recordFromGrantStatus('reauthorization_required');
  grantSink.recordFromPageFailure();
  grantSink.emitFailure();
  assert.deepEqual(logs[1], {
    event: 'email_delta_runtime_tick_failed',
    stage: 'grant',
    code: 'dead_grant',
  });

  const cursorSink = createDeltaRuntimeDiagnosticSink({
    logger(record) { logs.push(record); },
  });
  cursorSink.recordFromHttpStatus(410);
  cursorSink.recordFromTransportError(new Error(PLANTED));
  cursorSink.emitFailure();
  assert.deepEqual(logs[2], {
    event: 'email_delta_runtime_tick_failed',
    stage: 'cursor',
    code: 'cursor',
  });
});

test('closed-enum internal page stages map 1:1 and stay allowlisted', () => {
  for (const stage of INTERNAL_STAGES) {
    const classified = classifyDeltaRuntimePageInternalStage(stage);
    assert.deepEqual(classified, Object.freeze({ stage, code: stage }));
    assert.equal(STAGES.includes(classified.stage), true, stage);
    assert.equal(CODES.includes(classified.code), true, stage);
    noLeak(classified);
  }
  assert.equal(classifyDeltaRuntimePageInternalStage(PLANTED), null);
  assert.equal(classifyDeltaRuntimePageInternalStage('tick'), null);
  assert.equal(classifyDeltaRuntimePageInternalStage({ stage: 'authority' }), null);
  assert.equal(classifyDeltaRuntimePageInternalStage('schema'), null);
});

test('trusted page result mapping distinguishes all eight internal stages without leaking', () => {
  for (const stage of INTERNAL_STAGES) {
    const logs = [];
    const sink = createDeltaRuntimeDiagnosticSink({
      logger(record) { logs.push(record); },
    });
    const planted = Object.freeze({
      ok: false,
      error: PAGE_FAILURE_CODE,
      message: PLANTED,
      url: PLANTED,
      token: PLANTED,
    });
    assert.equal(readTrustedAuthorityBoundPageInternalStage(planted), null);
    sink.recordFromTrustedPageResult(
      planted,
      () => Object.freeze({ stage, code: stage }),
    );
    sink.emitFailure();
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0], {
      event: 'email_delta_runtime_tick_failed',
      stage,
      code: stage,
    });
    assert.deepEqual(Reflect.ownKeys(logs[0]), ['event', 'stage', 'code']);
    noLeak(logs);
  }
});

test('forged page results and observer payloads cannot classify or leak', () => {
  const logs = [];
  const sink = createDeltaRuntimeDiagnosticSink({
    logger(record) { logs.push(record); },
  });
  const forged = Object.freeze({
    ok: false,
    error: PAGE_FAILURE_CODE,
    stage: 'authority',
    code: 'authority',
    message: PLANTED,
  });
  assert.equal(readTrustedAuthorityBoundPageInternalStage(forged), null);
  assert.equal(readTrustedAuthorityBoundPageInternalStage(new Error(PLANTED)), null);
  assert.equal(
    bindTrustedAuthorityBoundPageInternalStageObserver(forged, () => {
      throw new Error(PLANTED);
    }),
    false,
  );
  sink.recordFromTrustedPageResult(forged, readTrustedAuthorityBoundPageInternalStage);
  sink.recordFromPageInternalStage(PLANTED);
  sink.recordFromPageInternalStage({ stage: PLANTED, code: PLANTED });
  sink.emitFailure();
  assert.deepEqual(logs[0], {
    event: 'email_delta_runtime_tick_failed',
    stage: 'store',
    code: 'store',
  });
  noLeak(logs);
});

test('closed-enum grant-session stages map onto grant + specific code', () => {
  const expected = Object.freeze({
    status: 'status',
    lease: 'lease',
    open: 'open',
    secret: 'secret',
    token: 'token',
    response: 'response',
    dead_grant: 'dead_grant',
    reseal: 'reseal',
    commit: 'commit',
    release: 'release',
  });
  for (const stage of DELEGATED_GRANT_ACCESS_SESSION_INTERNAL_STAGES) {
    const classified = classifyDeltaRuntimeGrantSessionInternalStage(stage);
    assert.deepEqual(classified, Object.freeze({
      stage: 'grant',
      code: expected[stage],
    }));
    assert.equal(STAGES.includes(classified.stage), true, stage);
    assert.equal(CODES.includes(classified.code), true, stage);
    noLeak(classified);
  }
  assert.equal(classifyDeltaRuntimeGrantSessionInternalStage(PLANTED), null);
  assert.equal(classifyDeltaRuntimeGrantSessionInternalStage('grant'), null);
  assert.equal(classifyDeltaRuntimeGrantSessionInternalStage({ stage: 'open' }), null);
  assert.equal(classifyDeltaRuntimeGrantSessionInternalStage('unauthorized'), null);
});

test('trusted grant-session result mapping distinguishes fail sites without leaking', () => {
  for (const stage of DELEGATED_GRANT_ACCESS_SESSION_INTERNAL_STAGES) {
    const logs = [];
    const sink = createDeltaRuntimeDiagnosticSink({
      logger(record) { logs.push(record); },
    });
    const planted = Object.freeze({
      ok: false,
      status: 'unavailable',
      grant_generation: 1,
      message: PLANTED,
      refresh_token: PLANTED,
    });
    assert.equal(readTrustedDelegatedGrantAccessSessionInternalStage(planted), null);
    sink.recordFromTrustedGrantSessionResult(
      planted,
      () => Object.freeze({ stage, code: stage }),
    );
    sink.emitFailure();
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0], {
      event: 'email_delta_runtime_tick_failed',
      stage: 'grant',
      code: stage === 'dead_grant' ? 'dead_grant' : stage,
    });
    assert.deepEqual(Reflect.ownKeys(logs[0]), ['event', 'stage', 'code']);
    noLeak(logs);
  }
});

test('grant-session specific codes beat generic grant/unknown and lose to dead_grant', () => {
  const logs = [];
  const openSink = createDeltaRuntimeDiagnosticSink({
    logger(record) { logs.push(record); },
  });
  openSink.recordFromGrantStatus('unavailable');
  openSink.recordFromPageInternalStage('grant');
  openSink.recordFromGrantSessionInternalStage('open');
  openSink.emitFailure();
  assert.deepEqual(logs[0], {
    event: 'email_delta_runtime_tick_failed',
    stage: 'grant',
    code: 'open',
  });

  const deadSink = createDeltaRuntimeDiagnosticSink({
    logger(record) { logs.push(record); },
  });
  deadSink.recordFromGrantSessionInternalStage('token');
  deadSink.recordFromGrantStatus('reauthorization_required');
  deadSink.recordFromPageInternalStage('grant');
  deadSink.emitFailure();
  assert.deepEqual(logs[1], {
    event: 'email_delta_runtime_tick_failed',
    stage: 'grant',
    code: 'dead_grant',
  });
  noLeak(logs);
});

test('forged grant-session payloads cannot classify or leak', () => {
  const logs = [];
  const sink = createDeltaRuntimeDiagnosticSink({
    logger(record) { logs.push(record); },
  });
  const forged = Object.freeze({
    ok: false,
    status: 'unavailable',
    stage: 'secret',
    code: 'secret',
    message: PLANTED,
  });
  assert.equal(readTrustedDelegatedGrantAccessSessionInternalStage(forged), null);
  sink.recordFromTrustedGrantSessionResult(
    forged,
    readTrustedDelegatedGrantAccessSessionInternalStage,
  );
  sink.recordFromGrantSessionInternalStage(PLANTED);
  sink.recordFromGrantSessionInternalStage({ stage: PLANTED, code: PLANTED });
  sink.emitFailure();
  assert.deepEqual(logs[0], {
    event: 'email_delta_runtime_tick_failed',
    stage: 'tick',
    code: 'unknown',
  });
  noLeak(logs);
});

test('dead_grant still beats later internal page stages', () => {
  const logs = [];
  const sink = createDeltaRuntimeDiagnosticSink({
    logger(record) { logs.push(record); },
  });
  sink.recordFromGrantStatus('reauthorization_required');
  sink.recordFromPageInternalStage('store');
  sink.recordFromPageInternalStage('grant');
  sink.emitFailure();
  assert.deepEqual(logs[0], {
    event: 'email_delta_runtime_tick_failed',
    stage: 'grant',
    code: 'dead_grant',
  });
});

test('page-operation factory still exists for the trusted seam', () => {
  assert.equal(typeof createAuthorityBoundMessagesDeltaPageOperation, 'function');
  assert.equal(PAGE_FAILURE_CODE, 'authority_bound_messages_delta_page_failed');
});

test('branded diagnostic is unforgeable and emit never throws', () => {
  const branded = brandDeltaRuntimeDiagnostic(
    new Error('Email delta sunset-staging runtime composition failed.'),
    'query',
    'query',
  );
  assert.deepEqual(
    readTrustedDeltaRuntimeDiagnostic(branded),
    Object.freeze({ stage: 'query', code: 'query' }),
  );
  const forged = new Error(PLANTED);
  forged.stage = 'query';
  forged.code = 'query';
  assert.equal(readTrustedDeltaRuntimeDiagnostic(forged), null);

  const threw = [];
  emitDeltaRuntimeTickFailed(
    { stage: 'tick', code: 'unknown' },
    () => { throw new Error(PLANTED); },
  );
  emitDeltaRuntimeTickFailed({ stage: PLANTED, code: PLANTED }, (r) => threw.push(r));
  assert.equal(threw.length, 0);
});

test('runtime composition catch logs only closed stage+code and does not leak', () => {
  const compositionSrc = fs.readFileSync(path.join(ROOT, COMP_REL), 'utf8');
  assert.match(compositionSrc, /email-delta-sunset-staging-runtime-diagnostics/);
  assert.match(compositionSrc, /createDeltaRuntimeDiagnosticSink/);
  assert.match(compositionSrc, /recordFromTrustedPageResult/);
  assert.match(compositionSrc, /readTrustedAuthorityBoundPageInternalStage/);
  assert.match(compositionSrc, /recordFromTrustedGrantSessionResult/);
  assert.match(compositionSrc, /readTrustedDelegatedGrantAccessSessionInternalStage/);
  assert.doesNotMatch(compositionSrc, /console\.error\('email_delta_runtime_tick_failed'\)/);
  const workerSrc = fs.readFileSync(path.join(ROOT, WORKER_REL), 'utf8');
  assert.doesNotMatch(workerSrc, /gmail|imap/i);
});

test('fresh-process hostile emit cannot print planted exception text', () => {
  const probe = `
    const { emitDeltaRuntimeTickFailed, createDeltaRuntimeDiagnosticSink } =
      require(${JSON.stringify(path.join(ROOT, LIB_REL))});
    const planted = ${JSON.stringify(PLANTED)};
    const sink = createDeltaRuntimeDiagnosticSink();
    sink.recordFromThrown(new Error(planted));
    sink.emitFailure();
    emitDeltaRuntimeTickFailed({ stage: 'tick', code: 'unknown', message: planted, url: planted });
  `;
  const result = spawnSync(process.execPath, ['-e', probe], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  noLeak(out);
  assert.match(out, /"event":"email_delta_runtime_tick_failed"/);
  assert.match(out, /"stage":"tick"/);
  assert.match(out, /"code":"unknown"/);
});

(async () => {
  let pass = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('PASS', name);
      pass += 1;
    } catch (err) {
      console.error('FAIL', name, err);
      process.exitCode = 1;
    }
  }
  console.log(`${pass}/${tests.length} passed`);
})();
