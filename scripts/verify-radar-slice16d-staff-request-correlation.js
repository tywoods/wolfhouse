'use strict';

/**
 * verify:radar-slice16d-staff-request-correlation — RADAR Slice 16D
 *
 * Offline RED/GREEN gate for Staff API HTTP request correlation.
 * GREEN proofs use real createStaffQueryApiHttpServer (fortress dual-gate).
 * Independent event oracles — does NOT use assertSafeCompletionEvent as oracle.
 * No live deploy, no Azure mutation, no real secrets.
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16d-staff-request-correlation');
const corr = require('./lib/staff-api-request-correlation');

const MASTER = locks.MASTER_BASIS;
const CONTRACT_REL = 'fixtures/radar-operations/slice16d-expected-contract.json';

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
      timeout: timeoutMs,
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
    req.on('timeout', () => {
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
  process.env.LUNA_BOT_INTERNAL_TOKEN = 'radar16d_bot_token_offline_test_01';
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

/** Independent event oracle — never calls assertSafeCompletionEvent. */
function independentEventOk(event, expect) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, detail: 'not_object' };
  }
  if (event.event !== locks.EVENT_NAME) return { ok: false, detail: 'bad_event' };
  const keys = Object.keys(event);
  for (const k of keys) {
    if (!locks.EVENT_ALLOWED_KEYS.includes(k)) return { ok: false, detail: `extra:${k}` };
    if (locks.MUST_NOT_EMIT.includes(k)) return { ok: false, detail: `forbidden:${k}` };
  }
  if (!corr.CORRELATION_ID_RE.test(String(event.correlation_id || ''))) {
    return { ok: false, detail: 'bad_id' };
  }
  if (typeof event.route_class !== 'string' || event.route_class.includes('?')) {
    return { ok: false, detail: 'bad_route' };
  }
  if (event.route_class !== corr.ROUTE_CLASS_UNKNOWN
    && event.route_class !== corr.ROUTE_CLASS_ROOT
    && event.route_class !== corr.ROUTE_CLASS_HEALTHZ
    && !corr.EXACT_ROUTE_TEMPLATES.includes(event.route_class)
    && !corr.PARAM_ROUTE_TEMPLATES.some((t) => t.route_class === event.route_class)) {
    return { ok: false, detail: `non_finite_route:${event.route_class}` };
  }
  if (!Number.isFinite(event.status) || event.status < 0) return { ok: false, detail: 'bad_status' };
  if (!Number.isFinite(event.duration_ms) || event.duration_ms < 0) {
    return { ok: false, detail: 'bad_duration' };
  }
  if (eventBlobLooksLeaky(event)) return { ok: false, detail: 'leaky' };
  if (expect) {
    for (const [k, v] of Object.entries(expect)) {
      if (event[k] !== v) return { ok: false, detail: `expect ${k}=${v} got ${event[k]}` };
    }
  }
  return { ok: true };
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
  ];
  for (const n of needles) {
    if (blob.includes(n)) return true;
  }
  if (typeof event.route_class === 'string' && event.route_class.includes('?')) return true;
  return false;
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

async function waitEvents(collector, pred, timeoutMs) {
  const okWait = await waitFor(() => pred(collector), timeoutMs);
  await corr.flushCorrelationEmitSink();
  return okWait || pred(collector);
}

async function main() {
  console.log('verify:radar-slice16d-staff-request-correlation — RADAR Slice 16D\n');

  const contract = readJson(CONTRACT_REL);
  const libSrc = readText(locks.CORRELATION_LIB_REL);
  const apiSrc = readText(locks.STAFF_API_REL);
  const verifySrc = readText('scripts/verify-radar-slice16d-staff-request-correlation.js');
  const locksSrc = readText('scripts/lib/radar-slice16d-staff-request-correlation.js');

  ok('C1 contract pinned',
    contract.outcome_id === locks.OUTCOME_ID
    && contract.gate_id === locks.GATE_ID
    && contract.master_basis === MASTER
    && contract.progress_class === locks.PROGRESS_CLASS
    && contract.live_deploy === false);

  ok('C2 AsyncLocalStorage + crypto + FIFO async delivery present',
    /AsyncLocalStorage/.test(libSrc)
    && /randomBytes/.test(libSrc)
    && /runWithRequestCorrelation/.test(libSrc)
    && /setImmediate/.test(libSrc)
    && /SINK_QUEUE_MAX/.test(libSrc)
    && /pumpDeliveryOnce|scheduleDeliveryPump/.test(libSrc)
    && /OVERFLOW_EVENT_NAME|buildOverflowAccountingEvent/.test(libSrc)
    && /attachCorrelationFlushToServer/.test(libSrc)
    && /createLifecycleCompletionEvent/.test(libSrc)
    && /classifyRouteTemplate/.test(libSrc)
    && /validateProcessRuntimeScope/.test(libSrc));

  ok('C3 staff-query-api wires correlation at createServer; no per-request binder',
    /runWithRequestCorrelation/.test(apiSrc)
    && /createStaffQueryApiHttpServer/.test(apiSrc)
    && /validateProcessRuntimeScope/.test(apiSrc)
    && /attachCorrelationFlushToServer/.test(apiSrc)
    && !/bindAuthoritativeRuntimeScope/.test(apiSrc));

  ok('C4 handler signatures not rewritten to take correlation args',
    !/async function router\(req, res, correlation/.test(apiSrc)
    && !/function sendJSON\(res, statusCode, body, correlation/.test(apiSrc));

  ok('C4b verifier does not use assertSafeCompletionEvent as oracle',
    !/assertSafeCompletionEvent\(/.test(verifySrc)
    || (/Independent event oracle/.test(verifySrc)
      && !/corr\.assertSafeCompletionEvent\(/.test(verifySrc)
      && !/assertSafeCompletionEvent\(e/.test(verifySrc)));

  const sec = secretFree(
    [JSON.stringify(contract), libSrc, locksSrc].join('\n'),
    '16d artifacts',
  );
  ok('C5 secret-free 16D artifacts', sec.ok, sec.detail);

  // ── RED: injection / oversize / unicode / array / ambiguous IDs ───────────
  {
    const inject = corr.acceptOrGenerateCorrelationId('abc\ninjected');
    red('injection_id_rejected',
      inject.accepted_from_header === false
      && corr.CORRELATION_ID_RE.test(inject.correlation_id)
      && !inject.correlation_id.includes('\n'));
  }
  {
    const over = corr.acceptOrGenerateCorrelationId(`a${'b'.repeat(200)}`);
    red('oversize_id_rejected',
      over.accepted_from_header === false
      && over.correlation_id.length <= corr.CORRELATION_ID_MAX_LEN);
  }
  {
    const uni = corr.acceptOrGenerateCorrelationId('café-id-12');
    red('unicode_id_rejected',
      uni.accepted_from_header === false
      && /^[0-9a-f]{32}$/.test(uni.correlation_id));
  }
  {
    const space = corr.acceptOrGenerateCorrelationId('good id!!');
    red('space_punct_id_rejected', space.accepted_from_header === false);
  }
  {
    const good = corr.acceptOrGenerateCorrelationId('abcdef12');
    red('strict_bounded_id_accepted',
      good.accepted_from_header === true && good.correlation_id === 'abcdef12');
  }
  {
    const arr = corr.acceptOrGenerateCorrelationId(['idoneaaaa', 'idtwobbbb']);
    red('array_id_rejected',
      arr.accepted_from_header === false
      && arr.reject_reason === 'ambiguous_array'
      && /^[0-9a-f]{32}$/.test(arr.correlation_id));
  }
  {
    const dup = corr.acceptOrGenerateCorrelationId('idoneaaaa,idtwobbbb');
    red('ambiguous_duplicate_id_rejected',
      dup.accepted_from_header === false
      && dup.reject_reason === 'ambiguous_duplicate');
  }

  // ── RED: secret/query leakage + unknown route privacy ─────────────────────
  {
    const livePrefix = 'sk_' + 'live_';
    const store = {
      correlation_id: 'abcdef12abcdef12abcdef12abcdef12',
      method: 'GET',
      route_class: corr.classifyRouteTemplate(`/healthz?token=${livePrefix}SHOULD_NOT_APPEAR&password=hunter2hunter2`),
      status: 200,
      statusCaptured: true,
      responseCompleted: true,
      startedAtMs: Date.now() - 5,
      runtime_scope_present: false,
      client_slug: null,
      location_id: null,
      aborted: false,
      requestError: false,
      responseError: false,
      completed: false,
      url: `/healthz?token=${livePrefix}SHOULD_NOT_APPEAR`,
      query: { token: `${livePrefix}SHOULD_NOT_APPEAR` },
      headers: { authorization: 'Bearer ' + 'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaa.bbbb' },
      body: { guest_phone: '+34123456789', password: 'hunter2hunter2' },
      stack: 'Error: boom\n    at Object.<anonymous>',
      message: 'super secret failure detail',
      error_message: 'db password=hunter2hunter2',
    };
    const event = corr.buildCompletionEvent(store);
    const indep = independentEventOk(event, {
      route_class: 'healthz',
      status: 200,
      error_class: null,
    });
    red('secret_query_leakage_stripped',
      indep.ok
      && !Object.prototype.hasOwnProperty.call(event, 'client_slug')
      && !Object.prototype.hasOwnProperty.call(event, 'location_id')
      && !Object.prototype.hasOwnProperty.call(event, 'url')
      && !Object.prototype.hasOwnProperty.call(event, 'query')
      && !Object.prototype.hasOwnProperty.call(event, 'headers')
      && !Object.prototype.hasOwnProperty.call(event, 'body')
      && !Object.prototype.hasOwnProperty.call(event, 'stack')
      && !Object.prototype.hasOwnProperty.call(event, 'message')
      && !JSON.stringify(event).includes(livePrefix)
      && !JSON.stringify(event).includes('guest_phone')
      && !JSON.stringify(event).includes('hunter2'),
      indep.detail);
  }

  // ── RED: forged tenant fields ignored (no request binder) ─────────────────
  {
    const forged = [];
    corr.setCorrelationEmitSink((e) => forged.push(e));
    const server = http.createServer((req, res) => {
      corr.runWithRequestCorrelation(req, res, async () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    const port = await listen(server);
    await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz?client=forged-evil-tenant&location_id=forged-loc',
      headers: {
        'x-request-id': 'forgedten1',
        'x-client-slug': 'forged-evil-tenant',
        'x-tenant-id': 'forged-evil-tenant',
        'x-location-id': 'forged-loc',
      },
    });
    await waitEvents(forged, (c) => c.length >= 1, 1000);
    red('forged_tenant_fields_ignored',
      forged.length === 1
      && !Object.prototype.hasOwnProperty.call(forged[0], 'client_slug')
      && !Object.prototype.hasOwnProperty.call(forged[0], 'location_id')
      && forged[0].correlation_id === 'forgedten1',
      JSON.stringify(forged[0]));
    corr.setCorrelationEmitSink(null);
    await closeServer(server);
  }

  // ── RED: process scope validated once; invalid omitted; entry re-validates ─
  {
    const bad = corr.validateProcessRuntimeScope({
      clientSlug: 'bad slug!!',
      locationId: '../etc',
    });
    const good = corr.validateProcessRuntimeScope({
      clientSlug: 'wolfhouse-somo',
      locationId: 'somo-main',
    });
    red('process_scope_validation',
      bad.present === false
      && good.present === true
      && good.client_slug === 'wolfhouse-somo'
      && good.location_id === 'somo-main'
      && Object.isFrozen(good));

    const events = [];
    corr.setCorrelationEmitSink((e) => events.push(e));
    const scope = corr.validateProcessRuntimeScope({ clientSlug: 'wolfhouse-somo' });
    const server = http.createServer((req, res) => {
      corr.runWithRequestCorrelation(req, res, async () => {
        res.writeHead(200);
        res.end('ok');
      }, { runtimeScope: scope });
    });
    const port = await listen(server);
    await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': 'scopeok01' },
    });
    await waitEvents(events, (c) => c.length >= 1, 1000);
    red('process_scope_emitted_when_present',
      events.length === 1
      && events[0].client_slug === 'wolfhouse-somo'
      && !Object.prototype.hasOwnProperty.call(events[0], 'location_id'),
      JSON.stringify(events[0]));
    corr.setCorrelationEmitSink(null);
    await closeServer(server);

    // Entry point must reject forged present:true with invalid tokens.
    const forgedScopeEvents = [];
    corr.setCorrelationEmitSink((e) => forgedScopeEvents.push(e));
    const forgedServer = http.createServer((req, res) => {
      corr.runWithRequestCorrelation(req, res, async () => {
        res.writeHead(200);
        res.end('ok');
      }, {
        runtimeScope: {
          present: true,
          client_slug: 'bad slug!!',
          location_id: '../etc',
        },
      });
    });
    const forgedPort = await listen(forgedServer);
    await httpRequest(forgedPort, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': 'scopebad1' },
    });
    await waitEvents(forgedScopeEvents, (c) => c.length >= 1, 1000);
    red('entry_point_revalidates_runtime_scope',
      forgedScopeEvents.length === 1
      && !Object.prototype.hasOwnProperty.call(forgedScopeEvents[0], 'client_slug')
      && !Object.prototype.hasOwnProperty.call(forgedScopeEvents[0], 'location_id'),
      JSON.stringify(forgedScopeEvents[0]));
    corr.setCorrelationEmitSink(null);
    await closeServer(forgedServer);
  }

  // ── RED: finite route classifier — unknown collapses; no raw segments ─────
  {
    const a = corr.classifyRouteTemplate(
      '/staff/conversations/11111111-2222-4333-a444-555555555555?x=1',
    );
    const b = corr.classifyRouteTemplate(
      `/staff/conversations/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee?secret=${'sk_' + 'live_'}x`,
    );
    const c = corr.classifyRouteTemplate('/staff/bookings/WH-260528-1493/context');
    const d = corr.classifyRouteTemplate('/staff/bookings/WH-999999-0001/context');
    const unk1 = corr.classifyRouteTemplate('/nope-16d');
    const unk2 = corr.classifyRouteTemplate('/staff/conversations/raw-not-uuid/secret-token-xyz');
    const unk3 = corr.classifyRouteTemplate(`/evil/${'a'.repeat(80)}?token=1`);
    red('raw_route_cardinality_collapsed',
      a === b
      && a === '/staff/conversations/:id'
      && c === d
      && c === '/staff/bookings/:booking_code/context'
      && unk1 === corr.ROUTE_CLASS_UNKNOWN
      && unk2 === corr.ROUTE_CLASS_UNKNOWN
      && unk3 === corr.ROUTE_CLASS_UNKNOWN
      && !a.includes('?')
      && !c.includes('WH-')
      && unk1 === unk2
      && unk2 === unk3,
      JSON.stringify({ a, b, c, d, unk1, unk2, unk3 }));
  }

  // ── RED: FIFO one-at-a-time delivery; nonblocking; catch throw/reject ──────
  {
    let sinkCalls = 0;
    let threw = false;
    corr.setCorrelationEmitSink(() => {
      sinkCalls += 1;
      threw = true;
      throw new Error('sink_boom_should_be_caught');
    });
    const t0 = Date.now();
    const store = {
      correlation_id: 'sinktest1sinktest1sinktest1sinkte',
      method: 'GET',
      route_class: 'healthz',
      status: 200,
      statusCaptured: true,
      responseCompleted: true,
      startedAtMs: t0,
      runtime_scope_present: false,
      aborted: false,
      requestError: false,
      responseError: false,
      completed: false,
    };
    corr.emitCompletionOnce(store);
    const syncElapsed = Date.now() - t0;
    corr.emitCompletionOnce(store);
    await corr.flushCorrelationEmitSink();
    red('async_sink_nonblocking_and_error_safe',
      syncElapsed < 50
      && sinkCalls === 1
      && threw === true
      && store.completed === true,
      JSON.stringify({ syncElapsed, sinkCalls }));
    corr.setCorrelationEmitSink(null);
  }

  // Promise rejection from sink must be caught (flush must not throw).
  {
    let rejected = false;
    corr.setCorrelationEmitSink(async () => {
      rejected = true;
      throw new Error('sink_promise_reject');
    });
    const store = {
      correlation_id: 'sinkrejctsinkrejctsinkrejctsinkre',
      method: 'GET',
      route_class: 'healthz',
      status: 200,
      statusCaptured: true,
      responseCompleted: true,
      startedAtMs: Date.now(),
      runtime_scope_present: false,
      aborted: false,
      requestError: false,
      responseError: false,
      completed: false,
    };
    corr.emitCompletionOnce(store);
    let flushErr = null;
    try {
      await corr.flushCorrelationEmitSink({ timeoutMs: 1000 });
    } catch (err) {
      flushErr = err;
    }
    red('async_sink_promise_rejection_caught',
      rejected === true && flushErr == null);
    corr.setCorrelationEmitSink(null);
  }

  // FIFO + slow sink: one-at-a-time; order preserved; never sync-drains many.
  {
    const order = [];
    let maxConcurrent = 0;
    let inFlight = 0;
    corr.setCorrelationEmitSink(async (e) => {
      if (e.event === corr.OVERFLOW_EVENT_NAME) return;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      order.push(e.correlation_id);
      await sleep(8);
      inFlight -= 1;
    });
    const ids = ['fifo00001', 'fifo00002', 'fifo00003', 'fifo00004'];
    for (const id of ids) {
      corr.emitCompletionOnce({
        correlation_id: id,
        method: 'GET',
        route_class: 'healthz',
        status: 200,
        statusCaptured: true,
        responseCompleted: true,
        startedAtMs: Date.now(),
        runtime_scope_present: false,
        aborted: false,
        requestError: false,
        responseError: false,
        completed: false,
      });
    }
    // Immediately after enqueue, queue should still hold later events (not sync-drained).
    const queuedImmediately = corr._deliveryQueue.length;
    const flushResult = await corr.flushCorrelationEmitSink({ timeoutMs: 2000 });
    red('fifo_one_at_a_time_slow_sink',
      flushResult.flushed === true
      && maxConcurrent === 1
      && queuedImmediately >= 1
      && order.join(',') === ids.join(','),
      JSON.stringify({ order, maxConcurrent, queuedImmediately, flushResult }));
    corr.setCorrelationEmitSink(null);
  }

  // Sink replacement: queued items keep captured destination.
  {
    const sinkA = [];
    const sinkB = [];
    let releaseFirst;
    const firstGate = new Promise((r) => { releaseFirst = r; });
    corr.setCorrelationEmitSink(async (e) => {
      sinkA.push(e.correlation_id || e.event);
      await firstGate;
    });
    corr.emitCompletionOnce({
      correlation_id: 'sinkcap01sinkcap01sinkcap01sinkca',
      method: 'GET',
      route_class: 'healthz',
      status: 200,
      statusCaptured: true,
      responseCompleted: true,
      startedAtMs: Date.now(),
      runtime_scope_present: false,
      aborted: false,
      requestError: false,
      responseError: false,
      completed: false,
    });
    await sleep(15);
    corr.emitCompletionOnce({
      correlation_id: 'sinkcap02sinkcap02sinkcap02sinkca',
      method: 'GET',
      route_class: 'healthz',
      status: 200,
      statusCaptured: true,
      responseCompleted: true,
      startedAtMs: Date.now(),
      runtime_scope_present: false,
      aborted: false,
      requestError: false,
      responseError: false,
      completed: false,
    });
    corr.setCorrelationEmitSink((e) => {
      sinkB.push(e.correlation_id || e.event);
    });
    corr.emitCompletionOnce({
      correlation_id: 'sinkcap03sinkcap03sinkcap03sinkca',
      method: 'GET',
      route_class: 'healthz',
      status: 200,
      statusCaptured: true,
      responseCompleted: true,
      startedAtMs: Date.now(),
      runtime_scope_present: false,
      aborted: false,
      requestError: false,
      responseError: false,
      completed: false,
    });
    releaseFirst();
    await corr.flushCorrelationEmitSink({ timeoutMs: 2000 });
    red('sink_replacement_keeps_captured_destination',
      sinkA.includes('sinkcap01sinkcap01sinkcap01sinkca')
      && sinkA.includes('sinkcap02sinkcap02sinkcap02sinkca')
      && sinkB.includes('sinkcap03sinkcap03sinkcap03sinkca')
      && !sinkB.includes('sinkcap01sinkcap01sinkcap01sinkca'),
      JSON.stringify({ sinkA, sinkB }));
    corr.setCorrelationEmitSink(null);
  }

  // Bounded overflow → mandatory structured accounting with drop count (no silent loss).
  {
    const seen = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    corr.setCorrelationEmitSink(async (e) => {
      seen.push(e);
      if (e.event === corr.EVENT_NAME) await gate;
    });
    // Hold the first delivery in-flight so the queue fills.
    corr.emitCompletionOnce({
      correlation_id: 'ovfhold01ovfhold01ovfhold01ovfhol',
      method: 'GET',
      route_class: 'healthz',
      status: 200,
      statusCaptured: true,
      responseCompleted: true,
      startedAtMs: Date.now(),
      runtime_scope_present: false,
      aborted: false,
      requestError: false,
      responseError: false,
      completed: false,
    });
    await sleep(10);
    const overflowExtra = 5;
    for (let i = 0; i < corr.SINK_QUEUE_MAX + overflowExtra; i += 1) {
      const id = `ovf${String(i).padStart(5, '0')}ovf${String(i).padStart(5, '0')}ovfxx`;
      corr.emitCompletionOnce({
        correlation_id: id.slice(0, 32),
        method: 'GET',
        route_class: 'healthz',
        status: 200,
        statusCaptured: true,
        responseCompleted: true,
        startedAtMs: Date.now(),
        runtime_scope_present: false,
        aborted: false,
        requestError: false,
        responseError: false,
        completed: false,
      });
    }
    const pendingBefore = corr._getPendingOverflowDrops();
    release();
    const flushOv = await corr.flushCorrelationEmitSink({ timeoutMs: 5000 });
    const overflowEvents = seen.filter((e) => e.event === corr.OVERFLOW_EVENT_NAME);
    const dropSum = overflowEvents.reduce((n, e) => n + Number(e.dropped_count || 0), 0);
    red('overflow_accounting_no_silent_loss',
      pendingBefore >= overflowExtra
      && flushOv.flushed === true
      && overflowEvents.length >= 1
      && dropSum >= overflowExtra
      && overflowEvents.every((e) => e.queue_max === corr.SINK_QUEUE_MAX
        && Number.isFinite(e.dropped_count) && e.dropped_count > 0),
      JSON.stringify({
        pendingBefore,
        dropSum,
        overflowEvents,
        flushOv,
        completionCount: seen.filter((e) => e.event === corr.EVENT_NAME).length,
      }));
    corr.setCorrelationEmitSink(null);
  }

  // Flush timeout accounting under slow sink.
  {
    let release;
    const gate = new Promise((r) => { release = r; });
    corr.setCorrelationEmitSink(async () => { await gate; });
    corr.emitCompletionOnce({
      correlation_id: 'flushtm01flushtm01flushtm01flusht',
      method: 'GET',
      route_class: 'healthz',
      status: 200,
      statusCaptured: true,
      responseCompleted: true,
      startedAtMs: Date.now(),
      runtime_scope_present: false,
      aborted: false,
      requestError: false,
      responseError: false,
      completed: false,
    });
    await sleep(5);
    const timed = await corr.flushCorrelationEmitSink({ timeoutMs: 25 });
    red('flush_timeout_accounting',
      timed.timed_out === true
      && timed.flushed === false
      && Number.isFinite(timed.elapsed_ms)
      && timed.elapsed_ms >= 20,
      JSON.stringify(timed));
    release();
    await corr.flushCorrelationEmitSink({ timeoutMs: 1000 });
    corr.setCorrelationEmitSink(null);
  }

  // Enqueue-then-shutdown (server.close) delivers; process hooks idempotent / no leaks.
  {
    const delivered = [];
    corr.setCorrelationEmitSink((e) => delivered.push(e));
    const server = http.createServer((req, res) => {
      corr.runWithRequestCorrelation(req, res, async () => {
        res.writeHead(200);
        res.end('shutdown-ok');
      });
    });
    corr.attachCorrelationFlushToServer(server, { installProcessHooks: false });
    const port = await listen(server);
    await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': 'shutdlv01' },
    });
    // Close without explicit flush — wrapped close must deliver.
    await closeServer(server);
    await sleep(20);
    red('enqueue_then_shutdown_delivery',
      delivered.some((e) => e.correlation_id === 'shutdlv01'),
      JSON.stringify(delivered.slice(-3)));

    const beforeTerm = process.listenerCount('SIGTERM');
    const beforeInt = process.listenerCount('SIGINT');
    const beforeExit = process.listenerCount('beforeExit');
    corr.installCorrelationProcessShutdownHooks({ timeoutMs: 100 });
    corr.installCorrelationProcessShutdownHooks({ timeoutMs: 100 });
    corr.installCorrelationProcessShutdownHooks({ timeoutMs: 100 });
    const midTerm = process.listenerCount('SIGTERM');
    const midInt = process.listenerCount('SIGINT');
    const midExit = process.listenerCount('beforeExit');
    corr.uninstallCorrelationProcessShutdownHooks();
    const afterTerm = process.listenerCount('SIGTERM');
    const afterInt = process.listenerCount('SIGINT');
    const afterExit = process.listenerCount('beforeExit');
    red('shutdown_hooks_idempotent_no_listener_leaks',
      midTerm === beforeTerm + 1
      && midInt === beforeInt + 1
      && midExit === beforeExit + 1
      && afterTerm === beforeTerm
      && afterInt === beforeInt
      && afterExit === beforeExit,
      JSON.stringify({
        beforeTerm, midTerm, afterTerm,
        beforeInt, midInt, afterInt,
        beforeExit, midExit, afterExit,
      }));
    corr.setCorrelationEmitSink(null);
  }

  // Lifecycle event created via single constructor (source + behavior).
  {
    red('lifecycle_event_created_once_path',
      /function createLifecycleCompletionEvent/.test(libSrc)
      && /createLifecycleCompletionEvent\(store\)/.test(libSrc)
      && (libSrc.match(/function createLifecycleCompletionEvent/g) || []).length === 1);
  }

  // ── RED: double completion (finish + close) emits once ────────────────────
  {
    const events = [];
    corr.setCorrelationEmitSink((e) => events.push(e));
    const server = http.createServer((req, res) => {
      corr.runWithRequestCorrelation(req, res, async () => {
        res.writeHead(204);
        res.end();
      });
    });
    const port = await listen(server);
    await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': 'double001' },
    });
    await waitEvents(events, (c) => c.some((e) => e.correlation_id === 'double001'), 1000);
    await sleep(30);
    await corr.flushCorrelationEmitSink();
    const matched = events.filter((e) => e.correlation_id === 'double001');
    red('double_completion_once',
      matched.length === 1,
      `count=${matched.length}`);
    corr.setCorrelationEmitSink(null);
    await closeServer(server);
  }

  // ── RED: abort classification + synthetic status when no response ─────────
  {
    const events = [];
    corr.setCorrelationEmitSink((e) => events.push(e));
    const server = http.createServer((req, res) => {
      corr.runWithRequestCorrelation(req, res, async () => {
        // Never write a response — client will abort.
        await sleep(5000);
      });
    });
    const port = await listen(server);
    await new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.write(
          'GET /healthz HTTP/1.1\r\n'
          + 'Host: 127.0.0.1\r\n'
          + 'X-Request-Id: aborted01\r\n'
          + 'Connection: close\r\n\r\n',
        );
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 30);
      });
      sock.on('error', () => resolve());
    });
    await waitEvents(events, (c) => c.some((e) => e.correlation_id === 'aborted01'), 2000);
    await sleep(50);
    await corr.flushCorrelationEmitSink();
    const matched = events.filter((e) => e.correlation_id === 'aborted01');
    red('aborted_request_completion',
      matched.length === 1
      && matched[0].error_class === corr.ERROR_CLASS_ABORTED
      && matched[0].status === corr.SYNTHETIC_NO_RESPONSE_STATUS,
      JSON.stringify(matched[0]));
    red('aborted_exactly_once', matched.length === 1);
    corr.setCorrelationEmitSink(null);
    await closeServer(server);
  }

  // ── GREEN: real Staff API listener suite ──────────────────────────────────
  const collected = [];
  applyMinimalStaffApiEnv();
  clearStaffApiCache();

  let api;
  let server;
  let port;
  try {
    api = loadStaffApi();
    const corrFromApi = require('./lib/staff-api-request-correlation');
    corrFromApi.setCorrelationEmitSink((e) => collected.push(e));

    server = api.createStaffQueryApiHttpServer();
    port = await listen(server);

    // Concurrent healthz
    const ids = ['greencon0', 'greencon1', 'greencon2', 'greencon3'];
    const responses = await Promise.all(ids.map((id) => httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': id, accept: 'application/json' },
    })));
    await waitEvents(
      collected,
      (c) => ids.every((id) => c.some((e) => e.correlation_id === id)),
      2000,
    );

    const headerEcho = responses.every((r, i) => {
      const h = r.headers['x-request-id'];
      return r.statusCode === 200 && h === ids[i];
    });
    const eventsFor = ids.map((id) => collected.filter((e) => e.correlation_id === id));
    const eventsOk = eventsFor.every((list) => {
      if (list.length !== 1) return false;
      const check = independentEventOk(list[0], {
        route_class: 'healthz',
        method: 'GET',
        status: 200,
        error_class: null,
      });
      return check.ok;
    });

    green('listener_concurrency',
      headerEcho && eventsOk,
      JSON.stringify({
        statuses: responses.map((r) => r.statusCode),
        headers: responses.map((r) => r.headers['x-request-id']),
        counts: eventsFor.map((l) => l.length),
      }));

    // Unknown path → route_class unknown (privacy / cardinality)
    const before404 = collected.length;
    const notFound = await httpRequest(port, {
      method: 'GET',
      reqPath: '/nope-16d-secret-segment',
      headers: { 'x-request-id': 'green404a', accept: 'application/json' },
    });
    await waitEvents(collected, (c) => c.length > before404, 2000);
    const e404 = collected.filter((e) => e.correlation_id === 'green404a');
    green('listener_404_unknown_route',
      notFound.statusCode === 404
      && notFound.headers['x-request-id'] === 'green404a'
      && e404.length === 1
      && e404[0].status === 404
      && e404[0].error_class === 'not_found'
      && e404[0].route_class === corr.ROUTE_CLASS_UNKNOWN
      && !JSON.stringify(e404[0]).includes('nope-16d')
      && independentEventOk(e404[0]).ok,
      JSON.stringify({ status: notFound.statusCode, event: e404[0] }));

    // Generated ID on invalid header
    const beforeErr = collected.length;
    const badHdr = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': 'BAD ID!!', accept: 'application/json' },
    });
    await waitEvents(collected, (c) => c.length > beforeErr, 2000);
    const genId = badHdr.headers['x-request-id'];
    const genEvent = collected.filter((e) => e.correlation_id === genId);
    green('listener_generate_on_invalid_header',
      badHdr.statusCode === 200
      && typeof genId === 'string'
      && /^[0-9a-f]{32}$/.test(genId)
      && genEvent.length === 1,
      `genId=${genId}`);

    // Force internal error (before headers)
    const before500 = collected.length;
    api.setStaffQueryApiRequestHandlerForOfflineTest(async () => {
      throw new Error('radar16d_forced_internal_error_should_not_leak');
    });
    const errRes = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': 'green500a', accept: 'application/json' },
    });
    api.setStaffQueryApiRequestHandlerForOfflineTest(null);
    await waitEvents(collected, (c) => c.length > before500, 2000);
    const e500 = collected.filter((e) => e.correlation_id === 'green500a');
    green('listener_error',
      errRes.statusCode === 500
      && errRes.headers['x-request-id'] === 'green500a'
      && !errRes.body.includes('radar16d_forced_internal_error')
      && !errRes.body.includes('stack')
      && e500.length === 1
      && e500[0].status === 500
      && e500[0].error_class === 'server_error'
      && independentEventOk(e500[0]).ok
      && !eventBlobLooksLeaky(e500[0]),
      JSON.stringify({ status: errRes.statusCode, body: errRes.body.slice(0, 120), event: e500[0] }));

    // Throw-after-headers must not change established bytes
    const marker = 'RADAR16D_ESTABLISHED_BODY_v1';
    const beforeThrow = collected.length;
    api.setStaffQueryApiRequestHandlerForOfflineTest(async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write(marker);
      throw new Error('throw_after_headers_should_not_alter_bytes');
    });
    const throwRes = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': 'throwhdr1', accept: 'text/plain' },
    });
    api.setStaffQueryApiRequestHandlerForOfflineTest(null);
    await waitEvents(collected, (c) => c.some((e) => e.correlation_id === 'throwhdr1'), 2000);
    const eThrow = collected.filter((e) => e.correlation_id === 'throwhdr1');
    green('listener_throw_after_headers',
      throwRes.statusCode === 200
      && throwRes.body === marker
      && !throwRes.body.includes('internal server error')
      && !throwRes.body.includes('throw_after_headers')
      && throwRes.headers['x-request-id'] === 'throwhdr1'
      && eThrow.length === 1
      && independentEventOk(eThrow[0]).ok,
      JSON.stringify({ status: throwRes.statusCode, body: throwRes.body, event: eThrow[0] }));

    // Streaming: chunked body preserved, exactly one completion
    const beforeStream = collected.length;
    api.setStaffQueryApiRequestHandlerForOfflineTest(async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('chunk-a-');
      await sleep(10);
      res.write('chunk-b');
      res.end();
    });
    const streamRes = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': 'stream001' },
    });
    api.setStaffQueryApiRequestHandlerForOfflineTest(null);
    await waitEvents(collected, (c) => c.some((e) => e.correlation_id === 'stream001'), 2000);
    const eStream = collected.filter((e) => e.correlation_id === 'stream001');
    green('listener_streaming',
      streamRes.statusCode === 200
      && streamRes.body === 'chunk-a-chunk-b'
      && eStream.length === 1
      && eStream[0].status === 200
      && independentEventOk(eStream[0]).ok,
      JSON.stringify({ body: streamRes.body, count: eStream.length }));

    // Header immutability: setHeader + writeHead object + writeHead array override attempts
    const beforeHdr = collected.length;
    api.setStaffQueryApiRequestHandlerForOfflineTest(async (req, res) => {
      res.setHeader('X-Request-Id', 'attacker-override-zzzz');
      res.removeHeader('X-Request-Id');
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'X-Request-Id': 'attacker-writehead-obj',
      });
      res.end('hdr-ok');
    });
    const hdrObjRes = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': 'hdrimmut1' },
    });
    api.setStaffQueryApiRequestHandlerForOfflineTest(null);
    await waitEvents(collected, (c) => c.some((e) => e.correlation_id === 'hdrimmut1'), 2000);

    // Flat raw array form (Node writeHead progressive API)
    api.setStaffQueryApiRequestHandlerForOfflineTest(async (req, res) => {
      res.writeHead(200, 'OK', [
        'Content-Type', 'text/plain',
        'X-Request-Id', 'attacker-writehead-arr',
        'X-Request-Id', 'attacker-writehead-arr-2',
      ]);
      res.end('hdr-arr-ok');
    });
    const hdrArrRes = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': 'hdrimmut2' },
    });
    api.setStaffQueryApiRequestHandlerForOfflineTest(null);
    await waitEvents(collected, (c) => c.some((e) => e.correlation_id === 'hdrimmut2'), 2000);

    // Nested [[k,v], ...] array form also accepted by forceCorrelation helper
    api.setStaffQueryApiRequestHandlerForOfflineTest(async (req, res) => {
      res.writeHead(200, [
        ['Content-Type', 'text/plain'],
        ['X-Request-Id', 'attacker-nested-arr'],
      ]);
      res.end('hdr-nested-ok');
    });
    const hdrNestedRes = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': 'hdrimmut3' },
    });
    api.setStaffQueryApiRequestHandlerForOfflineTest(null);
    await waitEvents(collected, (c) => c.some((e) => e.correlation_id === 'hdrimmut3'), 2000);

    green('listener_header_immutable_all_forms',
      hdrObjRes.headers['x-request-id'] === 'hdrimmut1'
      && hdrArrRes.headers['x-request-id'] === 'hdrimmut2'
      && hdrNestedRes.headers['x-request-id'] === 'hdrimmut3'
      && hdrObjRes.body === 'hdr-ok'
      && hdrArrRes.body === 'hdr-arr-ok'
      && hdrNestedRes.body === 'hdr-nested-ok'
      && collected.filter((e) => e.correlation_id === 'hdrimmut1').length === 1
      && collected.filter((e) => e.correlation_id === 'hdrimmut2').length === 1
      && collected.filter((e) => e.correlation_id === 'hdrimmut3').length === 1,
      JSON.stringify({
        obj: hdrObjRes.headers['x-request-id'],
        arr: hdrArrRes.headers['x-request-id'],
        nested: hdrNestedRes.headers['x-request-id'],
        bodies: [hdrObjRes.body, hdrArrRes.body, hdrNestedRes.body],
      }));

    // writeEarlyHints + addTrailers must not override immutable X-Request-Id
    {
      api.setStaffQueryApiRequestHandlerForOfflineTest(async (req, res) => {
        if (typeof res.writeEarlyHints === 'function') {
          try {
            res.writeEarlyHints({
              'X-Request-Id': 'attacker-early-hints',
              Link: '</radar16d.css>; rel=preload; as=style',
            });
          } catch (_) { /* some Node builds may reject; protection still wraps */ }
        }
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          Trailer: 'X-Request-Id',
        });
        res.write('early-trail-ok');
        if (typeof res.addTrailers === 'function') {
          try {
            res.addTrailers({ 'X-Request-Id': 'attacker-trailer-id' });
          } catch (_) { /* ignore */ }
        }
        res.end();
      });
      const earlyRes = await httpRequest(port, {
        method: 'GET',
        reqPath: '/healthz',
        headers: { 'x-request-id': 'earlytrl1' },
      });
      api.setStaffQueryApiRequestHandlerForOfflineTest(null);
      await waitEvents(collected, (c) => c.some((e) => e.correlation_id === 'earlytrl1'), 2000);
      green('listener_early_hints_and_trailers_protected',
        earlyRes.headers['x-request-id'] === 'earlytrl1'
        && earlyRes.body.includes('early-trail-ok')
        && /writeEarlyHintsCorrelated|writeEarlyHints/.test(libSrc)
        && /addTrailersCorrelated|addTrailers/.test(libSrc)
        && /forceCorrelationInHeaderObject/.test(libSrc),
        JSON.stringify({
          id: earlyRes.headers['x-request-id'],
          body: earlyRes.body,
        }));
    }

    // Actual duplicate header lines on the wire → regenerate (not accept either)
    {
      const beforeDup = collected.length;
      const dupRaw = await new Promise((resolve) => {
        const chunks = [];
        const sock = net.connect({ host: '127.0.0.1', port }, () => {
          sock.write(
            'GET /healthz HTTP/1.1\r\n'
            + 'Host: 127.0.0.1\r\n'
            + 'X-Request-Id: dupline01\r\n'
            + 'X-Request-Id: dupline02\r\n'
            + 'Connection: close\r\n\r\n',
          );
        });
        sock.on('data', (c) => chunks.push(c));
        sock.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const m = raw.match(/^[^\n]*\r?\n([\s\S]*?)\r?\n\r?\n/);
          const headerBlock = m ? m[1] : '';
          const ids = [];
          for (const line of headerBlock.split(/\r?\n/)) {
            const hm = line.match(/^X-Request-Id:\s*(.+)$/i);
            if (hm) ids.push(hm[1].trim());
          }
          resolve({ raw, ids, headerBlock });
        });
        sock.on('error', () => resolve({ raw: '', ids: [], headerBlock: '' }));
      });
      await waitEvents(collected, (c) => c.length > beforeDup, 2000);
      const echoed = dupRaw.ids[0];
      const dupEvents = collected.filter((e) => e.correlation_id === echoed);
      green('listener_duplicate_header_lines_regenerate',
        dupRaw.ids.length === 1
        && typeof echoed === 'string'
        && /^[0-9a-f]{32}$/.test(echoed)
        && echoed !== 'dupline01'
        && echoed !== 'dupline02'
        && dupEvents.length === 1
        && independentEventOk(dupEvents[0]).ok,
        JSON.stringify({ ids: dupRaw.ids, event: dupEvents[0] }));
    }

    // Injectable request error — exact class + synthetic status
    {
      api.setStaffQueryApiRequestHandlerForOfflineTest(async (req, res) => {
        const ctx = corrFromApi.getRequestCorrelationContext();
        if (ctx) ctx.requestError = true;
        req.destroy(new Error('forced_request_error'));
        await sleep(20);
      });
      let reqClientErr = null;
      try {
        await httpRequest(port, {
          method: 'GET',
          reqPath: '/healthz',
          headers: { 'x-request-id': 'reqerr001' },
        });
      } catch (err) {
        reqClientErr = err;
      }
      api.setStaffQueryApiRequestHandlerForOfflineTest(null);
      await waitEvents(
        collected,
        (c) => c.some((e) => e.correlation_id === 'reqerr001'),
        2000,
      );
      const reqErrEvents = collected.filter((e) => e.correlation_id === 'reqerr001');
      green('listener_request_error_exact',
        reqErrEvents.length === 1
        && reqErrEvents[0].error_class === corr.ERROR_CLASS_REQUEST_ERROR
        && reqErrEvents[0].status === corr.SYNTHETIC_NO_RESPONSE_STATUS
        && independentEventOk(reqErrEvents[0]).ok,
        JSON.stringify({
          event: reqErrEvents[0],
          clientErr: reqClientErr && String(reqClientErr.message || reqClientErr),
        }));
    }

    // Response error after headers — exact class + established status
    {
      api.setStaffQueryApiRequestHandlerForOfflineTest(async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('partial-');
        res.destroy(new Error('forced_response_error'));
      });
      let resErrCaught = null;
      try {
        await httpRequest(port, {
          method: 'GET',
          reqPath: '/healthz',
          headers: { 'x-request-id': 'reserr001' },
        });
      } catch (err) {
        resErrCaught = err;
      }
      api.setStaffQueryApiRequestHandlerForOfflineTest(null);
      await waitEvents(
        collected,
        (c) => c.some((e) => e.correlation_id === 'reserr001'),
        2000,
      );
      const resErrEvents = collected.filter((e) => e.correlation_id === 'reserr001');
      green('listener_response_error_exact',
        resErrEvents.length === 1
        && resErrEvents[0].error_class === corr.ERROR_CLASS_RESPONSE_ERROR
        && resErrEvents[0].status === 200
        && independentEventOk(resErrEvents[0]).ok,
        JSON.stringify({
          event: resErrEvents[0],
          clientErr: resErrCaught && String(resErrCaught.message || resErrCaught),
        }));
    }

    green('listener_healthz_no_forged_tenant',
      eventsFor.every((list) => list[0]
        && !Object.prototype.hasOwnProperty.call(list[0], 'client_slug')
        && !Object.prototype.hasOwnProperty.call(list[0], 'location_id')));

    // Exactly-once across the whole suite for known IDs
    const knownIds = [
      ...ids, 'green404a', 'green500a', 'throwhdr1', 'stream001',
      'hdrimmut1', 'hdrimmut2', 'hdrimmut3', 'earlytrl1', 'reqerr001', 'reserr001',
    ];
    const exactlyOnce = knownIds.every((id) => collected.filter((e) => e.correlation_id === id).length === 1);
    green('listener_exactly_once_known_ids', exactlyOnce,
      JSON.stringify(knownIds.map((id) => ({
        id,
        n: collected.filter((e) => e.correlation_id === id).length,
      }))));
  } catch (err) {
    const skipIds = [
      'listener_concurrency',
      'listener_404_unknown_route',
      'listener_generate_on_invalid_header',
      'listener_error',
      'listener_throw_after_headers',
      'listener_streaming',
      'listener_header_immutable_all_forms',
      'listener_early_hints_and_trailers_protected',
      'listener_duplicate_header_lines_regenerate',
      'listener_request_error_exact',
      'listener_response_error_exact',
      'listener_healthz_no_forged_tenant',
      'listener_exactly_once_known_ids',
    ];
    for (const id of skipIds) {
      green(id, false, String(err && err.stack || err));
    }
  } finally {
    try {
      const corrFromApi = require('./lib/staff-api-request-correlation');
      corrFromApi.setCorrelationEmitSink(null);
    } catch (_) { /* ignore */ }
    corr.setCorrelationEmitSink(null);
    if (server) await closeServer(server);
  }

  const requiredRed = [
    'injection_id_rejected',
    'oversize_id_rejected',
    'unicode_id_rejected',
    'space_punct_id_rejected',
    'strict_bounded_id_accepted',
    'array_id_rejected',
    'ambiguous_duplicate_id_rejected',
    'secret_query_leakage_stripped',
    'forged_tenant_fields_ignored',
    'process_scope_validation',
    'process_scope_emitted_when_present',
    'entry_point_revalidates_runtime_scope',
    'raw_route_cardinality_collapsed',
    'async_sink_nonblocking_and_error_safe',
    'async_sink_promise_rejection_caught',
    'fifo_one_at_a_time_slow_sink',
    'sink_replacement_keeps_captured_destination',
    'overflow_accounting_no_silent_loss',
    'flush_timeout_accounting',
    'enqueue_then_shutdown_delivery',
    'shutdown_hooks_idempotent_no_listener_leaks',
    'lifecycle_event_created_once_path',
    'double_completion_once',
    'aborted_request_completion',
    'aborted_exactly_once',
  ];
  const requiredGreen = [
    'listener_concurrency',
    'listener_404_unknown_route',
    'listener_generate_on_invalid_header',
    'listener_error',
    'listener_throw_after_headers',
    'listener_streaming',
    'listener_header_immutable_all_forms',
    'listener_early_hints_and_trailers_protected',
    'listener_duplicate_header_lines_regenerate',
    'listener_request_error_exact',
    'listener_response_error_exact',
    'listener_healthz_no_forged_tenant',
    'listener_exactly_once_known_ids',
  ];
  ok('C6 all required RED ids ran',
    requiredRed.every((id) => redResults.some((r) => r.id === id && r.ok)),
    JSON.stringify(redResults.filter((r) => !r.ok)));
  ok('C7 all required GREEN ids ran',
    requiredGreen.every((id) => greenResults.some((r) => r.id === id && r.ok)),
    JSON.stringify(greenResults.filter((r) => !r.ok)));

  ok('C8 drill remains open in contract',
    contract.final_controlled_drill
    && contract.final_controlled_drill.status === 'open'
    && contract.final_controlled_drill.id === '16D_DRILL_correlation_log_query');

  ok('C9 npm script registered',
    /verify:radar-slice16d-staff-request-correlation/.test(
      fs.existsSync(path.join(ROOT, 'package.json'))
        ? readText('package.json')
        : '',
    ));

  // Legacy alias verify:staff-api is absent — document truthfully (use staff-auth-api).
  const pkgText = fs.existsSync(path.join(ROOT, 'package.json')) ? readText('package.json') : '';
  const hasLegacyStaffApi = /"verify:staff-api"\s*:/.test(pkgText);
  ok('C9b legacy npm target verify:staff-api absent (documented)',
    hasLegacyStaffApi === false
    && /"verify:staff-auth-api"\s*:/.test(pkgText),
    hasLegacyStaffApi
      ? 'unexpected: verify:staff-api present'
      : 'legacy verify:staff-api absent; gates use verify:staff-auth-api');

  // Contract surface for lifecycle/header/route/scope/sink
  const ecc = contract.event_context_contract || {};
  ok('C10 contract encodes corrected lifecycle/header/route/scope/sink',
    ecc.completion_event
    && ecc.completion_event.exactly_once === true
    && ecc.completion_event.completion_triggers
    && ecc.route_classifier === 'finite_route_template'
    && ecc.unknown_route_class === 'unknown'
    && ecc.header_immutable === true
    && ecc.reject_ambiguous_request_ids === true
    && ecc.tenant_location_rule === 'optional_immutable_process_runtime_scope_at_construction_else_omit'
    && ecc.completion_sink === 'fifo_one_at_a_time_async_queue'
    && ecc.overflow_accounting === 'mandatory_structured_drop_count'
    && ecc.shutdown_flush === 'server_close_and_process_signals_idempotent'
    && ecc.synthetic_no_response_status === 0,
    JSON.stringify({
      route_classifier: ecc.route_classifier,
      sink: ecc.completion_sink,
      overflow: ecc.overflow_accounting,
      shutdown: ecc.shutdown_flush,
      tenant: ecc.tenant_location_rule,
    }));

  console.log(`\nRED: ${redResults.filter((r) => r.ok).length}/${redResults.length}  GREEN: ${greenResults.filter((r) => r.ok).length}/${greenResults.length}`);
  console.log(`Result: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16D staff request correlation: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
