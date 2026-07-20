'use strict';

/**
 * verify:radar-slice16d-staff-request-correlation — RADAR Slice 16D
 *
 * Offline RED/GREEN gate for Staff API HTTP request correlation.
 * GREEN proofs use real createStaffQueryApiHttpServer (fortress dual-gate).
 * No live deploy, no Azure mutation, no real secrets.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

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
  // Meta signature config may exit without local skip; keep test-safe.
  if (!process.env.META_WEBHOOK_SKIP_VERIFY) {
    process.env.META_WEBHOOK_SKIP_VERIFY = '1';
  }
}

function loadStaffApi() {
  applyMinimalStaffApiEnv();
  clearStaffApiCache();
  // Re-require correlation after cache clear so sink attaches to same module instance.
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
  ];
  for (const n of needles) {
    if (blob.includes(n)) return true;
  }
  for (const [k, v] of Object.entries(event)) {
    if (typeof v === 'string' && v.includes('?') && k === 'route_class') return true;
  }
  return false;
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

  ok('C2 AsyncLocalStorage + crypto generate present',
    /AsyncLocalStorage/.test(libSrc)
    && /randomBytes/.test(libSrc)
    && /runWithRequestCorrelation/.test(libSrc));

  ok('C3 staff-query-api wires correlation at createServer',
    /runWithRequestCorrelation/.test(apiSrc)
    && /createStaffQueryApiHttpServer/.test(apiSrc)
    && /bindAuthoritativeRuntimeScope/.test(apiSrc));

  ok('C4 handler signatures not rewritten to take correlation args',
    !/async function router\(req, res, correlation/.test(apiSrc)
    && !/function sendJSON\(res, statusCode, body, correlation/.test(apiSrc));

  const sec = secretFree(
    [JSON.stringify(contract), libSrc, locksSrc].join('\n'),
    '16d artifacts',
  );
  ok('C5 secret-free 16D artifacts', sec.ok, sec.detail);
  ok('C5b verifier present', typeof verifySrc === 'string' && verifySrc.length > 100);

  // ── RED: injection / oversize / unicode IDs ───────────────────────────────
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

  // ── RED: secret/query leakage in completion event ─────────────────────────
  {
    // Leakage needles assembled to avoid false-positive secret scans of this verifier.
    const livePrefix = 'sk_' + 'live_';
    const store = {
      correlation_id: 'abcdef12abcdef12abcdef12abcdef12',
      method: 'GET',
      route_class: corr.normalizeRouteClass(`/healthz?token=${livePrefix}SHOULD_NOT_APPEAR&password=hunter2hunter2`),
      status: 200,
      startedAtMs: Date.now() - 5,
      client_slug: null,
      location_id: null,
      aborted: false,
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
    const safe = corr.assertSafeCompletionEvent(event);
    red('secret_query_leakage_stripped',
      safe.ok
      && !eventBlobLooksLeaky(event)
      && event.route_class === 'healthz'
      && !JSON.stringify(event).includes(livePrefix)
      && !JSON.stringify(event).includes('guest_phone')
      && !JSON.stringify(event).includes('hunter2')
      && !Object.prototype.hasOwnProperty.call(event, 'url')
      && !Object.prototype.hasOwnProperty.call(event, 'query')
      && !Object.prototype.hasOwnProperty.call(event, 'headers')
      && !Object.prototype.hasOwnProperty.call(event, 'body')
      && !Object.prototype.hasOwnProperty.call(event, 'stack')
      && !Object.prototype.hasOwnProperty.call(event, 'message'),
      safe.detail);
  }

  // ── RED: forged tenant fields from headers/query must not bind ────────────
  {
    const forged = [];
    corr.setCorrelationEmitSink((e) => forged.push(e));
    const { req, res } = makeMockReqRes({
      method: 'GET',
      url: '/healthz?client=forged-evil-tenant&location_id=forged-loc',
      headers: {
        'x-request-id': 'forgedten1',
        'x-client-slug': 'forged-evil-tenant',
        'x-tenant-id': 'forged-evil-tenant',
        'x-location-id': 'forged-loc',
      },
    });
    await corr.runWithRequestCorrelation(req, res, async () => {
      // Deliberately do NOT call bindAuthoritativeRuntimeScope.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await waitFor(() => forged.length >= 1, 500);
    red('forged_tenant_fields_ignored',
      forged.length === 1
      && forged[0].client_slug === null
      && forged[0].location_id === null
      && forged[0].correlation_id === 'forgedten1',
      JSON.stringify(forged[0]));
    corr.setCorrelationEmitSink(null);
  }

  // ── RED: concurrent context bleed ─────────────────────────────────────────
  {
    const seen = [];
    corr.setCorrelationEmitSink((e) => seen.push(e));
    const results = await Promise.all([0, 1, 2, 3, 4].map(async (i) => {
      const id = `concurrent${i}x`;
      const { req, res } = makeMockReqRes({
        method: 'GET',
        url: `/healthz`,
        headers: { 'x-request-id': id },
      });
      return corr.runWithRequestCorrelation(req, res, async () => {
        corr.bindAuthoritativeRuntimeScope({ clientSlug: `tenant-${i}` });
        await sleep(10 + (i * 3));
        const ctx = corr.getRequestCorrelationContext();
        res.writeHead(200);
        res.end('ok');
        return {
          id,
          ctxId: ctx && ctx.correlation_id,
          ctxTenant: ctx && ctx.client_slug,
        };
      });
    }));
    await waitFor(() => seen.length >= 5, 1000);
    const bleed = results.some((r, i) => r.ctxTenant !== `tenant-${i}` || r.ctxId !== `concurrent${i}x`);
    const tenants = new Set(seen.map((e) => e.client_slug));
    red('concurrent_context_bleed',
      !bleed && tenants.size === 5 && seen.length === 5,
      JSON.stringify({ results, tenants: [...tenants], events: seen.length }));
    corr.setCorrelationEmitSink(null);
  }

  // ── RED: aborted request emits once with error_class=aborted ──────────────
  {
    const events = [];
    corr.setCorrelationEmitSink((e) => events.push(e));
    const { req, res } = makeMockReqRes({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'aborted01' },
    });
    await corr.runWithRequestCorrelation(req, res, async () => {
      // Simulate abort before finish: close without writableFinished.
      res.statusCode = 200;
      res.emit('close');
    });
    await waitFor(() => events.length >= 1, 500);
    red('aborted_request_completion',
      events.length === 1
      && events[0].error_class === 'aborted'
      && events[0].correlation_id === 'aborted01',
      JSON.stringify(events[0]));
    // Double-emit attempt
    corr.emitCompletionOnce({
      correlation_id: 'aborted01',
      method: 'GET',
      route_class: 'healthz',
      status: 200,
      startedAtMs: Date.now(),
      client_slug: null,
      location_id: null,
      aborted: true,
      completed: true,
    });
    red('aborted_no_second_emit_via_flag', events.length === 1);
    corr.setCorrelationEmitSink(null);
  }

  // ── RED: double completion (finish + close) emits once ────────────────────
  {
    const events = [];
    corr.setCorrelationEmitSink((e) => events.push(e));
    const { req, res } = makeMockReqRes({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'double001' },
    });
    await corr.runWithRequestCorrelation(req, res, async () => {
      res.writeHead(204);
      res.end();
      // Force an extra close after finish (Node may also emit close).
      res.emit('close');
      res.emit('finish');
    });
    await waitFor(() => events.length >= 1, 500);
    red('double_completion_once',
      events.length === 1 && events[0].correlation_id === 'double001',
      `count=${events.length}`);
    corr.setCorrelationEmitSink(null);
  }

  // ── RED: raw route cardinality ────────────────────────────────────────────
  {
    const a = corr.normalizeRouteClass(
      '/staff/conversations/11111111-2222-4333-a444-555555555555?x=1',
    );
    const b = corr.normalizeRouteClass(
      `/staff/conversations/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee?secret=${'sk_' + 'live_'}x`,
    );
    const c = corr.normalizeRouteClass('/staff/conversations/42');
    const d = corr.normalizeRouteClass('/staff/bookings/WH-260528-1493/detail');
    const e = corr.normalizeRouteClass('/staff/bookings/WH-999999-0001/detail');
    red('raw_route_cardinality_collapsed',
      a === b
      && a === '/staff/conversations/:id'
      && c === '/staff/conversations/:id'
      && d === e
      && d === '/staff/bookings/:booking_code/detail'
      && !a.includes('?')
      && !d.includes('WH-260528'),
      JSON.stringify({ a, b, c, d, e }));
  }

  // ── GREEN: real listener concurrency / error / 404 ────────────────────────
  const collected = [];
  // Prefer the module instance the API will use.
  applyMinimalStaffApiEnv();
  clearStaffApiCache();
  const corrRuntime = require('./lib/staff-api-request-correlation');
  corrRuntime.setCorrelationEmitSink((e) => collected.push(e));

  let api;
  let server;
  let port;
  try {
    api = loadStaffApi();
    // Ensure sink is on the same module instance staff-query-api required.
    const corrFromApi = require('./lib/staff-api-request-correlation');
    corrFromApi.setCorrelationEmitSink((e) => collected.push(e));

    server = api.createStaffQueryApiHttpServer();
    port = await listen(server);

    // Concurrent healthz with distinct IDs
    const ids = ['greencon0', 'greencon1', 'greencon2', 'greencon3'];
    const responses = await Promise.all(ids.map((id) => httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': id, accept: 'application/json' },
    })));
    await waitFor(() => collected.filter((e) => ids.includes(e.correlation_id)).length >= ids.length, 2000);

    const headerEcho = responses.every((r, i) => {
      const h = r.headers['x-request-id'];
      return r.statusCode === 200 && h === ids[i];
    });
    const eventsFor = ids.map((id) => collected.find((e) => e.correlation_id === id));
    const eventsOk = eventsFor.every((e) => e
      && e.route_class === 'healthz'
      && e.method === 'GET'
      && e.status === 200
      && e.error_class === null
      && corr.assertSafeCompletionEvent(e).ok
      && !eventBlobLooksLeaky(e));

    green('listener_concurrency',
      headerEcho && eventsOk && new Set(eventsFor.map((e) => e.correlation_id)).size === ids.length,
      JSON.stringify({
        statuses: responses.map((r) => r.statusCode),
        headers: responses.map((r) => r.headers['x-request-id']),
        eventCount: eventsFor.filter(Boolean).length,
      }));

    // 404 — short path so route_class is not collapsed to /:token
    const before404 = collected.length;
    const notFound = await httpRequest(port, {
      method: 'GET',
      reqPath: '/nope-16d',
      headers: { 'x-request-id': 'green404a', accept: 'application/json' },
    });
    await waitFor(() => collected.length > before404, 2000);
    const e404 = collected.find((e) => e.correlation_id === 'green404a');
    green('listener_404',
      notFound.statusCode === 404
      && notFound.headers['x-request-id'] === 'green404a'
      && e404
      && e404.status === 404
      && e404.error_class === 'not_found'
      && e404.route_class === '/nope-16d'
      && corr.assertSafeCompletionEvent(e404).ok,
      JSON.stringify({ status: notFound.statusCode, event: e404 }));

    // Generated ID when header missing / invalid
    const beforeErr = collected.length;
    const badHdr = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': 'BAD ID!!', accept: 'application/json' },
    });
    await waitFor(() => collected.length > beforeErr, 2000);
    const genId = badHdr.headers['x-request-id'];
    const genEvent = collected.find((e) => e.correlation_id === genId);
    green('listener_generate_on_invalid_header',
      badHdr.statusCode === 200
      && typeof genId === 'string'
      && /^[0-9a-f]{32}$/.test(genId)
      && genEvent
      && genEvent.correlation_id === genId,
      `genId=${genId}`);

    // Force internal error via fortress-gated handler override (real listener path).
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
    await waitFor(() => collected.length > before500, 2000);
    const e500 = collected.find((e) => e.correlation_id === 'green500a');
    green('listener_error',
      errRes.statusCode === 500
      && errRes.headers['x-request-id'] === 'green500a'
      && !errRes.body.includes('radar16d_forced_internal_error')
      && !errRes.body.includes('stack')
      && e500
      && e500.status === 500
      && e500.error_class === 'server_error'
      && corr.assertSafeCompletionEvent(e500).ok
      && !eventBlobLooksLeaky(e500),
      JSON.stringify({ status: errRes.statusCode, body: errRes.body.slice(0, 120), event: e500 }));

    // Authoritative bind works; forged header still ignored when bind not used on healthz
    green('listener_healthz_no_forged_tenant',
      eventsFor.every((e) => e.client_slug === null && e.location_id === null));
  } catch (err) {
    green('listener_concurrency', false, String(err && err.stack || err));
    green('listener_404', false, 'skipped');
    green('listener_generate_on_invalid_header', false, 'skipped');
    green('listener_error', false, 'skipped');
    green('listener_healthz_no_forged_tenant', false, 'skipped');
  } finally {
    try {
      const corrFromApi = require('./lib/staff-api-request-correlation');
      corrFromApi.setCorrelationEmitSink(null);
    } catch (_) { /* ignore */ }
    corr.setCorrelationEmitSink(null);
    if (server) await closeServer(server);
  }

  // Required RED/GREEN coverage checklist
  const requiredRed = [
    'injection_id_rejected',
    'oversize_id_rejected',
    'unicode_id_rejected',
    'space_punct_id_rejected',
    'strict_bounded_id_accepted',
    'secret_query_leakage_stripped',
    'forged_tenant_fields_ignored',
    'concurrent_context_bleed',
    'aborted_request_completion',
    'aborted_no_second_emit_via_flag',
    'double_completion_once',
    'raw_route_cardinality_collapsed',
  ];
  const requiredGreen = [
    'listener_concurrency',
    'listener_404',
    'listener_generate_on_invalid_header',
    'listener_error',
    'listener_healthz_no_forged_tenant',
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

  // Diff hygiene vs master for owned non-staff paths is handled by other gates.
  ok('C9 npm script will be registered (package.json)',
    /verify:radar-slice16d-staff-request-correlation/.test(
      fs.existsSync(path.join(ROOT, 'package.json'))
        ? readText('package.json')
        : '',
    ));

  console.log(`\nRED: ${redResults.filter((r) => r.ok).length}/${redResults.length}  GREEN: ${greenResults.filter((r) => r.ok).length}/${greenResults.length}`);
  console.log(`Result: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16D staff request correlation: PASS');
}

function makeMockReqRes({ method, url, headers }) {
  const { EventEmitter } = require('events');
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
  res.end = (chunk) => {
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
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 5);
    };
    tick();
  }).catch(() => false);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
