'use strict';

/**
 * verify:radar-slice16j-staff-request-correlation — RADAR Slice 16J
 *
 * Offline RED/GREEN gate for Staff API HTTP request correlation.
 * GREEN proofs use real createStaffQueryApiHttpServer (fortress dual-gate).
 * No async queue / signal-shutdown ownership proofs (out of scope).
 * No live deploy, no Azure mutation, no real secrets.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16j-staff-request-correlation');
const corr = require('./lib/staff-api-request-correlation');

const MASTER = locks.MASTER_BASIS;
const CONTRACT_REL = 'fixtures/radar-operations/slice16j-expected-contract.json';

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
  'invalid_id_rejected',
  'oversize_id_rejected',
  'undersize_id_rejected',
  'non_v4_uuid_rejected',
  'array_id_rejected',
  'uuid_v4_accepted_normalized',
  'secret_query_body_header_canaries_absent',
  'forged_tenant_headers_ignored',
  'concurrent_context_isolation',
  'aborted_completion_once',
  'double_completion_once',
  'route_query_stripped',
  'no_process_handlers_installed',
  'no_async_queue_ownership',
];

const REQUIRED_GREEN = [
  'listener_supplied_uuid',
  'listener_generated_uuid',
  'listener_concurrent_isolation',
  'listener_downstream_access',
  'listener_2xx',
  'listener_4xx',
  'listener_5xx',
  'listener_sensitive_canaries_absent',
  'listener_one_record_max',
  'listener_no_exit_mutation',
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

function httpRequest(port, opts) {
  const {
    method = 'GET',
    reqPath = '/',
    headers = {},
    body = null,
    timeoutMs = 8000,
  } = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (body != null) req.write(body);
    req.end();
  });
}

function clearStaffApiCache() {
  for (const key of Object.keys(require.cache)) {
    if (/staff-query-api\.js$/.test(key)
      || /staff-auth-config\.js$/.test(key)
      || /staff-portal-clients\.js$/.test(key)
      || /staff-api-request-correlation\.js$/.test(key)
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
  process.env.LUNA_BOT_INTERNAL_TOKEN = 'radar16j_bot_token_offline_test_01';
  process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = '1';
  if (!process.env.META_WEBHOOK_SKIP_VERIFY) {
    process.env.META_WEBHOOK_SKIP_VERIFY = '1';
  }
}

function loadStaffApi() {
  applyMinimalStaffApiEnv();
  clearStaffApiCache();
  const api = require('../scripts/staff-query-api.js');
  if (typeof api.createStaffQueryApiHttpServer !== 'function') {
    throw new Error('createStaffQueryApiHttpServer not exported — dual-gate inactive');
  }
  return api;
}

function eventBlobLooksLeaky(event) {
  const blob = JSON.stringify(event);
  const needles = [
    'sk_' + 'live_',
    'sk_' + 'test_',
    'whsec_',
    'Bearer ',
    'password=',
    'Authorization',
    'postgres' + '://',
    'postgresql' + '://',
    '?token=',
    '?session_id=',
    'guest_phone',
    'error_message',
    'at Object.',
    'Error:',
    '+34123456789',
    'alice@example.com',
  ];
  for (const n of needles) {
    if (blob.includes(n)) return true;
  }
  if (typeof event.route === 'string' && event.route.includes('?')) return true;
  return false;
}

function makeMockReqRes({ method, url, headers }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = Object.assign(
    {},
    ...Object.entries(headers || {}).map(([k, v]) => ({ [String(k).toLowerCase()]: v })),
  );

  const res = new EventEmitter();
  res.statusCode = 200;
  res.headersSent = false;
  res.writableFinished = false;
  const hdrs = {};
  res.setHeader = (k, v) => { hdrs[String(k).toLowerCase()] = v; };
  res.getHeader = (k) => hdrs[String(k).toLowerCase()];
  res.writeHead = (code, maybeHeaders) => {
    res.statusCode = code;
    if (maybeHeaders && typeof maybeHeaders === 'object') {
      for (const [k, v] of Object.entries(maybeHeaders)) hdrs[String(k).toLowerCase()] = v;
    }
    res.headersSent = true;
    return res;
  };
  res.end = () => {
    if (!res.headersSent) res.writeHead(res.statusCode);
    res.writableFinished = true;
    res.emit('finish');
    res.emit('close');
    return res;
  };
  res.write = () => true;
  return { req, res, hdrs };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitFor(pred, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 5);
    };
    tick();
  });
}

function countProcessListeners(event) {
  return process.listenerCount(event);
}

async function main() {
  console.log('verify:radar-slice16j-staff-request-correlation — RADAR Slice 16J\n');

  const contract = readJson(CONTRACT_REL);
  const libSrc = readText(locks.CORRELATION_LIB_REL);
  const apiSrc = readText(locks.STAFF_API_REL);
  const verifySrc = readText('scripts/verify-radar-slice16j-staff-request-correlation.js');
  const locksSrc = readText('scripts/lib/radar-slice16j-staff-request-correlation.js');

  ok('C1 contract pinned',
    contract.outcome_id === locks.OUTCOME_ID
    && contract.gate_id === locks.GATE_ID
    && contract.master_basis === MASTER
    && contract.progress_class === locks.PROGRESS_CLASS
    && contract.live_deploy === false
    && contract.supersedes
    && contract.supersedes.outcome_id === '16D_staff_api_request_correlation');

  ok('C2 AsyncLocalStorage + randomUUID + accessors present',
    /AsyncLocalStorage/.test(libSrc)
    && /randomUUID/.test(libSrc)
    && /getRequestContext/.test(libSrc)
    && /function requestId/.test(libSrc)
    && /runWithRequestCorrelation/.test(libSrc));

  ok('C3 staff-query-api wires correlation at createServer',
    /runWithRequestCorrelation/.test(apiSrc)
    && /createStaffQueryApiHttpServer/.test(apiSrc)
    && /resolveTrustedIngressBinding/.test(apiSrc)
    && /getRequestContext/.test(apiSrc));

  ok('C4 no async queue / signal shutdown ownership',
    !/deliveryQueue|sinkQueue|enqueueCompletion|installCorrelationProcessShutdown|flushCorrelation|SIGTERM|SIGINT|beforeExit/.test(libSrc)
    && !/process\.on\s*\(/.test(libSrc)
    && !/process\.exit/.test(libSrc)
    && /console\.log\(JSON\.stringify/.test(libSrc));

  ok('C5 handler signatures unchanged',
    !/async function router\(req, res, correlation/.test(apiSrc)
    && !/function sendJSON\(res, statusCode, body, correlation/.test(apiSrc));

  const sec = secretFree(
    [JSON.stringify(contract), libSrc, locksSrc].join('\n'),
    '16j artifacts',
  );
  ok('C6 secret-free 16J artifacts', sec.ok, sec.detail);
  ok('C6b verifier present', typeof verifySrc === 'string' && verifySrc.length > 100);

  const listenersBefore = {
    SIGTERM: countProcessListeners('SIGTERM'),
    SIGINT: countProcessListeners('SIGINT'),
    beforeExit: countProcessListeners('beforeExit'),
    exit: countProcessListeners('exit'),
  };

  // ── RED: ID accept/reject ─────────────────────────────────────────────────
  {
    const bad = corr.acceptOrGenerateRequestId('not-a-uuid');
    red('invalid_id_rejected',
      bad.accepted_from_header === false
      && corr.UUID_V4_RE.test(bad.request_id)
      && bad.request_id === bad.request_id.toLowerCase());
  }
  {
    const over = corr.acceptOrGenerateRequestId(`a${'b'.repeat(200)}`);
    red('oversize_id_rejected',
      over.accepted_from_header === false
      && over.reject_reason === 'oversize'
      && corr.UUID_V4_RE.test(over.request_id));
  }
  {
    const under = corr.acceptOrGenerateRequestId('abcd');
    red('undersize_id_rejected',
      under.accepted_from_header === false
      && under.reject_reason === 'undersize');
  }
  {
    // Valid UUID shape but version nibble ≠ 4
    const nonV4 = corr.acceptOrGenerateRequestId('11111111-2222-1333-a444-555555555555');
    red('non_v4_uuid_rejected',
      nonV4.accepted_from_header === false
      && corr.UUID_V4_RE.test(nonV4.request_id));
  }
  {
    const arr = corr.acceptOrGenerateRequestId(['11111111-2222-4333-a444-555555555555']);
    red('array_id_rejected',
      arr.accepted_from_header === false
      && arr.reject_reason === 'ambiguous_array');
  }
  {
    const upper = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
    const good = corr.acceptOrGenerateRequestId(upper);
    red('uuid_v4_accepted_normalized',
      good.accepted_from_header === true
      && good.request_id === upper.toLowerCase()
      && corr.UUID_V4_RE.test(good.request_id));
  }

  // ── RED: sensitive canaries absent from completion event ──────────────────
  {
    const livePrefix = 'sk_' + 'live_';
    const store = {
      request_id: '11111111-2222-4333-8444-555555555555',
      method: 'POST',
      route: corr.normalizeRoute(
        `/healthz?token=${livePrefix}SHOULD_NOT_APPEAR&email=alice@example.com`,
      ),
      status: 200,
      startedAtMs: Date.now() - 7,
      tenant_slug: null,
      ingress_binding_present: false,
      aborted: false,
      completed: false,
      url: `/healthz?token=${livePrefix}SHOULD_NOT_APPEAR`,
      query: { token: `${livePrefix}SHOULD_NOT_APPEAR`, email: 'alice@example.com' },
      headers: {
        authorization: 'Bearer ' + 'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaa.bbbb',
        'x-guest-name': 'Alice Example',
      },
      body: {
        guest_phone: '+34123456789',
        email: 'alice@example.com',
        name: 'Alice Example',
        password: 'hunter2hunter2',
      },
      stack: 'Error: boom\n    at Object.<anonymous>',
      message: 'super secret failure detail',
      error_message: 'db password=hunter2hunter2',
    };
    const event = corr.buildCompletionEvent(store);
    const safe = corr.assertSafeCompletionEvent(event);
    red('secret_query_body_header_canaries_absent',
      safe.ok
      && !eventBlobLooksLeaky(event)
      && event.route === '/healthz'
      && event.duration_ms % corr.DURATION_MS_BUCKET === 0
      && event.duration_ms >= 5
      && !JSON.stringify(event).includes(livePrefix)
      && !JSON.stringify(event).includes('alice@')
      && !JSON.stringify(event).includes('guest_phone')
      && !JSON.stringify(event).includes('hunter2')
      && !JSON.stringify(event).includes('Alice')
      && !Object.prototype.hasOwnProperty.call(event, 'url')
      && !Object.prototype.hasOwnProperty.call(event, 'query')
      && !Object.prototype.hasOwnProperty.call(event, 'headers')
      && !Object.prototype.hasOwnProperty.call(event, 'body')
      && !Object.prototype.hasOwnProperty.call(event, 'stack')
      && !Object.prototype.hasOwnProperty.call(event, 'message')
      && !Object.prototype.hasOwnProperty.call(event, 'tenant_slug'),
      safe.detail);
  }

  // ── RED: forged tenant headers ignored ────────────────────────────────────
  {
    const forged = [];
    corr.setCompletionEmitSink((e) => forged.push(e));
    const id = '11111111-2222-4333-8444-555555555501';
    const { req, res } = makeMockReqRes({
      method: 'GET',
      url: '/healthz?client=forged-evil-tenant&tenant_slug=forged-evil',
      headers: {
        'x-request-id': id,
        'x-client-slug': 'forged-evil-tenant',
        'x-tenant-slug': 'forged-evil-tenant',
        'x-tenant-id': 'forged-evil-tenant',
      },
    });
    await corr.runWithRequestCorrelation(req, res, async () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    }, { ingressBinding: null });
    await waitFor(() => forged.length >= 1, 500);
    red('forged_tenant_headers_ignored',
      forged.length === 1
      && !Object.prototype.hasOwnProperty.call(forged[0], 'tenant_slug')
      && forged[0].request_id === id,
      JSON.stringify(forged[0]));
    corr.setCompletionEmitSink(null);
  }

  // ── RED: concurrent ALS isolation ─────────────────────────────────────────
  {
    const seen = [];
    corr.setCompletionEmitSink((e) => seen.push(e));
    const ids = [
      '11111111-2222-4333-8444-555555555510',
      '11111111-2222-4333-8444-555555555511',
      '11111111-2222-4333-8444-555555555512',
      '11111111-2222-4333-8444-555555555513',
      '11111111-2222-4333-8444-555555555514',
    ];
    const results = await Promise.all(ids.map(async (id, i) => {
      const { req, res } = makeMockReqRes({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-request-id': id },
      });
      return corr.runWithRequestCorrelation(req, res, async () => {
        await sleep(8 + (i * 3));
        const ctx = corr.getRequestContext();
        const rid = corr.requestId();
        res.writeHead(200);
        res.end('ok');
        return {
          id,
          ctxId: ctx && ctx.requestId,
          rid,
        };
      }, {
        ingressBinding: { tenant_slug: `tenant-${i}` },
      });
    }));
    await waitFor(() => seen.length >= 5, 1000);
    const bleed = results.some((r) => r.ctxId !== r.id || r.rid !== r.id);
    const eventIds = new Set(seen.map((e) => e.request_id));
    red('concurrent_context_isolation',
      !bleed && eventIds.size === 5 && seen.length === 5,
      JSON.stringify({ results, eventIds: [...eventIds], events: seen.length }));
    corr.setCompletionEmitSink(null);
  }

  // ── RED: aborted emits once ───────────────────────────────────────────────
  {
    const events = [];
    corr.setCompletionEmitSink((e) => events.push(e));
    const id = '11111111-2222-4333-8444-555555555520';
    const { req, res } = makeMockReqRes({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': id },
    });
    await corr.runWithRequestCorrelation(req, res, async () => {
      res.statusCode = 200;
      res.emit('close');
    });
    await waitFor(() => events.length >= 1, 500);
    corr.emitCompletionOnce({
      request_id: id,
      method: 'GET',
      route: '/healthz',
      status: 200,
      startedAtMs: Date.now(),
      tenant_slug: null,
      ingress_binding_present: false,
      aborted: true,
      completed: true,
    });
    red('aborted_completion_once',
      events.length === 1 && events[0].request_id === id,
      JSON.stringify(events));
    corr.setCompletionEmitSink(null);
  }

  // ── RED: finish+close double emit once ────────────────────────────────────
  {
    const events = [];
    corr.setCompletionEmitSink((e) => events.push(e));
    const id = '11111111-2222-4333-8444-555555555530';
    const { req, res } = makeMockReqRes({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': id },
    });
    await corr.runWithRequestCorrelation(req, res, async () => {
      res.writeHead(204);
      res.end();
      res.emit('close');
      res.emit('finish');
    });
    await waitFor(() => events.length >= 1, 500);
    red('double_completion_once',
      events.length === 1 && events[0].request_id === id,
      `count=${events.length}`);
    corr.setCompletionEmitSink(null);
  }

  // ── RED: route query stripped ─────────────────────────────────────────────
  {
    const a = corr.normalizeRoute(
      '/staff/conversations/11111111-2222-4333-a444-555555555555?x=1&token=secret',
    );
    const b = corr.normalizeRoute(
      `/staff/conversations/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee?secret=${'sk_' + 'live_'}x`,
    );
    red('route_query_stripped',
      a === b
      && a === '/staff/conversations/:id'
      && !a.includes('?')
      && !a.includes('secret'),
      JSON.stringify({ a, b }));
  }

  // ── RED: no process handler / async queue ownership in source ─────────────
  {
    red('no_async_queue_ownership',
      !/deliveryQueue|SINK_QUEUE|enqueueCompletionEvent|flushCorrelationEmitSink|installCorrelationProcessShutdownHooks/.test(libSrc)
      && locks.MUST_NOT_OWN.every((k) => contract.event_context_contract.completion_ownership[k] === false
        || (k === 'async_log_queue' && contract.event_context_contract.completion_ownership.async_log_queue === false)));
  }
  {
    const listenersAfterUnit = {
      SIGTERM: countProcessListeners('SIGTERM'),
      SIGINT: countProcessListeners('SIGINT'),
      beforeExit: countProcessListeners('beforeExit'),
      exit: countProcessListeners('exit'),
    };
    red('no_process_handlers_installed',
      listenersAfterUnit.SIGTERM === listenersBefore.SIGTERM
      && listenersAfterUnit.SIGINT === listenersBefore.SIGINT
      && listenersAfterUnit.beforeExit === listenersBefore.beforeExit
      && listenersAfterUnit.exit === listenersBefore.exit
      && !/process\.on\(/.test(libSrc),
      JSON.stringify({ listenersBefore, listenersAfterUnit }));
  }

  // ── GREEN: real listener ──────────────────────────────────────────────────
  const collected = [];
  applyMinimalStaffApiEnv();
  // Trusted ingress binding for listener proofs
  process.env.DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
  clearStaffApiCache();

  const exitCodeBefore = process.exitCode;
  let api;
  let server;
  let port;
  try {
    api = loadStaffApi();
    const corrFromApi = require('./lib/staff-api-request-correlation');
    corrFromApi.setCompletionEmitSink((e) => collected.push(e));

    server = api.createStaffQueryApiHttpServer();
    port = await listen(server);

    const suppliedId = 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111';
    const supplied = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': suppliedId, accept: 'application/json' },
    });
    await waitFor(() => collected.some((e) => e.request_id === suppliedId), 2000);
    const eSupplied = collected.find((e) => e.request_id === suppliedId);
    green('listener_supplied_uuid',
      supplied.statusCode === 200
      && supplied.headers['x-request-id'] === suppliedId
      && eSupplied
      && eSupplied.tenant_slug === 'wolfhouse-somo'
      && eSupplied.route === '/healthz'
      && corr.assertSafeCompletionEvent(eSupplied).ok,
      JSON.stringify({ status: supplied.statusCode, hdr: supplied.headers['x-request-id'], event: eSupplied }));

    const beforeGen = collected.length;
    const generated = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': 'NOT-A-UUID!!!!', accept: 'application/json' },
    });
    await waitFor(() => collected.length > beforeGen, 2000);
    const genId = generated.headers['x-request-id'];
    const eGen = collected.find((e) => e.request_id === genId);
    green('listener_generated_uuid',
      generated.statusCode === 200
      && typeof genId === 'string'
      && corr.UUID_V4_RE.test(genId)
      && genId === genId.toLowerCase()
      && eGen
      && eGen.request_id === genId,
      `genId=${genId}`);

    // Concurrent isolation on real listener
    const concIds = [
      'aaaaaaaa-bbbb-4ccc-8ddd-222222222220',
      'aaaaaaaa-bbbb-4ccc-8ddd-222222222221',
      'aaaaaaaa-bbbb-4ccc-8ddd-222222222222',
      'aaaaaaaa-bbbb-4ccc-8ddd-222222222223',
    ];
    const beforeConc = collected.length;
    const concRes = await Promise.all(concIds.map((id) => httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': id, accept: 'application/json' },
    })));
    await waitFor(
      () => collected.filter((e) => concIds.includes(e.request_id)).length >= concIds.length,
      2000,
    );
    const concEvents = concIds.map((id) => collected.find((e) => e.request_id === id));
    green('listener_concurrent_isolation',
      concRes.every((r, i) => r.statusCode === 200 && r.headers['x-request-id'] === concIds[i])
      && concEvents.every(Boolean)
      && new Set(concEvents.map((e) => e.request_id)).size === concIds.length,
      JSON.stringify({
        statuses: concRes.map((r) => r.statusCode),
        headers: concRes.map((r) => r.headers['x-request-id']),
      }));

    // Downstream ALS access via fortress-gated handler override
    let downstreamSeen = null;
    api.setStaffQueryApiRequestHandlerForOfflineTest(async (req, res) => {
      downstreamSeen = {
        ctx: api.getRequestContext(),
        rid: api.requestId(),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const downId = 'aaaaaaaa-bbbb-4ccc-8ddd-333333333333';
    const downRes = await httpRequest(port, {
      method: 'GET',
      reqPath: '/any-downstream-path',
      headers: { 'x-request-id': downId, accept: 'application/json' },
    });
    api.setStaffQueryApiRequestHandlerForOfflineTest(null);
    green('listener_downstream_access',
      downRes.statusCode === 200
      && downstreamSeen
      && downstreamSeen.ctx
      && downstreamSeen.ctx.requestId === downId
      && downstreamSeen.rid === downId
      && downstreamSeen.ctx.tenantSlug === 'wolfhouse-somo',
      JSON.stringify(downstreamSeen));

    green('listener_2xx',
      supplied.statusCode === 200
      && supplied.headers['x-request-id'] === suppliedId
      && eSupplied
      && eSupplied.status === 200);

    const before404 = collected.length;
    const notFound = await httpRequest(port, {
      method: 'GET',
      reqPath: '/nope-16j',
      headers: {
        'x-request-id': 'aaaaaaaa-bbbb-4ccc-8ddd-444444444444',
        accept: 'application/json',
      },
    });
    await waitFor(() => collected.length > before404, 2000);
    const e404 = collected.find((e) => e.request_id === 'aaaaaaaa-bbbb-4ccc-8ddd-444444444444');
    green('listener_4xx',
      notFound.statusCode === 404
      && notFound.headers['x-request-id'] === 'aaaaaaaa-bbbb-4ccc-8ddd-444444444444'
      && e404
      && e404.status === 404
      && e404.route === '/nope-16j'
      && corr.assertSafeCompletionEvent(e404).ok,
      JSON.stringify({ status: notFound.statusCode, event: e404 }));

    const before500 = collected.length;
    api.setStaffQueryApiRequestHandlerForOfflineTest(async () => {
      throw new Error('radar16j_forced_internal_error_should_not_leak');
    });
    const errRes = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: {
        'x-request-id': 'aaaaaaaa-bbbb-4ccc-8ddd-555555555555',
        accept: 'application/json',
      },
    });
    api.setStaffQueryApiRequestHandlerForOfflineTest(null);
    await waitFor(() => collected.length > before500, 2000);
    const e500 = collected.find((e) => e.request_id === 'aaaaaaaa-bbbb-4ccc-8ddd-555555555555');
    green('listener_5xx',
      errRes.statusCode === 500
      && errRes.headers['x-request-id'] === 'aaaaaaaa-bbbb-4ccc-8ddd-555555555555'
      && !errRes.body.includes('radar16j_forced_internal_error')
      && !errRes.body.includes('stack')
      && e500
      && e500.status === 500
      && corr.assertSafeCompletionEvent(e500).ok
      && !eventBlobLooksLeaky(e500),
      JSON.stringify({ status: errRes.statusCode, body: errRes.body.slice(0, 120), event: e500 }));

    // Sensitive query/body/header canaries absent from all collected events
    const canaryPath = `/healthz?token=${'sk_' + 'live_'}CANARY&email=alice@example.com&phone=%2B34123456789`;
    const beforeCanary = collected.length;
    const canaryRes = await httpRequest(port, {
      method: 'POST',
      reqPath: canaryPath,
      headers: {
        'x-request-id': 'aaaaaaaa-bbbb-4ccc-8ddd-666666666666',
        accept: 'application/json',
        authorization: 'Bearer ' + 'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaa.bbbb',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        guest_phone: '+34123456789',
        email: 'alice@example.com',
        name: 'Alice Example',
        password: 'hunter2hunter2',
      }),
    });
    await waitFor(() => collected.length > beforeCanary, 2000);
    const eCanary = collected.find((e) => e.request_id === 'aaaaaaaa-bbbb-4ccc-8ddd-666666666666');
    green('listener_sensitive_canaries_absent',
      canaryRes.headers['x-request-id'] === 'aaaaaaaa-bbbb-4ccc-8ddd-666666666666'
      && eCanary
      && !eventBlobLooksLeaky(eCanary)
      && eCanary.route === '/healthz'
      && !JSON.stringify(eCanary).includes('alice@')
      && !JSON.stringify(eCanary).includes('hunter2')
      && !JSON.stringify(eCanary).includes('Bearer')
      && collected.every((e) => !eventBlobLooksLeaky(e) && corr.assertSafeCompletionEvent(e).ok),
      JSON.stringify(eCanary));

    // One record max per request_id
    const counts = {};
    for (const e of collected) {
      counts[e.request_id] = (counts[e.request_id] || 0) + 1;
    }
    green('listener_one_record_max',
      Object.values(counts).every((n) => n === 1),
      JSON.stringify(counts));

    green('listener_no_exit_mutation',
      process.exitCode === exitCodeBefore
      && countProcessListeners('SIGTERM') === listenersBefore.SIGTERM
      && countProcessListeners('SIGINT') === listenersBefore.SIGINT
      && countProcessListeners('beforeExit') === listenersBefore.beforeExit,
      JSON.stringify({
        exitCodeBefore,
        exitCodeAfter: process.exitCode,
        sigterm: countProcessListeners('SIGTERM'),
      }));
  } catch (err) {
    for (const id of REQUIRED_GREEN) {
      if (!greenResults.some((r) => r.id === id)) {
        green(id, false, String(err && err.stack || err));
      }
    }
  } finally {
    try {
      const corrFromApi = require('./lib/staff-api-request-correlation');
      corrFromApi.setCompletionEmitSink(null);
    } catch (_) { /* ignore */ }
    corr.setCompletionEmitSink(null);
    if (server) await closeServer(server);
  }

  ok('C7 all required RED ids ran',
    REQUIRED_RED.every((id) => redResults.some((r) => r.id === id)),
    `missing=${REQUIRED_RED.filter((id) => !redResults.some((r) => r.id === id)).join(',')}`);
  ok('C8 all required GREEN ids ran',
    REQUIRED_GREEN.every((id) => greenResults.some((r) => r.id === id)),
    `missing=${REQUIRED_GREEN.filter((id) => !greenResults.some((r) => r.id === id)).join(',')}`);
  ok('C9 all RED passed', redResults.every((r) => r.ok),
    JSON.stringify(redResults.filter((r) => !r.ok)));
  ok('C10 all GREEN passed', greenResults.every((r) => r.ok),
    JSON.stringify(greenResults.filter((r) => !r.ok)));

  ok('C11 drill remains open',
    contract.final_controlled_drill
    && contract.final_controlled_drill.status === 'open'
    && contract.final_controlled_drill.id === '16J_DRILL_correlation_log_query');

  ok('C12 npm script registered',
    /verify:radar-slice16j-staff-request-correlation/.test(readText('package.json')));

  ok('C13 duration bucket locked',
    contract.event_context_contract.duration_ms.bucket_ms === locks.DURATION_MS_BUCKET
    && corr.DURATION_MS_BUCKET === locks.DURATION_MS_BUCKET);

  console.log(`\nRED: ${redResults.filter((r) => r.ok).length}/${redResults.length}  GREEN: ${greenResults.filter((r) => r.ok).length}/${greenResults.length}`);
  console.log(`Result: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16J Staff API request correlation (source-partial): PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
