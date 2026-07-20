'use strict';

/**
 * verify:radar-slice16j-staff-request-correlation — RADAR Slice 16J
 *
 * Offline RED/GREEN gate for Staff API HTTP request correlation
 * (header + AsyncLocalStorage only). No completion logging.
 * GREEN proofs use real createStaffQueryApiHttpServer (fortress dual-gate).
 * No live deploy, no Azure mutation, no real secrets.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const { execSync } = require('child_process');

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
  'forged_tenant_headers_ignored',
  'concurrent_context_isolation',
  'route_query_stripped',
  'no_req_res_listeners_beyond_base',
  'synthetic_error_behavior_baseline',
  'router_catch_unchanged_from_base',
  'no_console_log_side_effect',
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
  'listener_no_completion_console',
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

function countProcessListeners(event) {
  return process.listenerCount(event);
}

function sameListenerSnapshot(a, b) {
  return a.finish === b.finish
    && a.close === b.close
    && a.error === b.error
    && a.aborted === b.aborted;
}

function extractCreateServerCatchSemantic(apiSrc) {
  const marker = 'function createStaffQueryApiHttpServer';
  const idx = apiSrc.indexOf(marker);
  if (idx < 0) return null;
  const slice = apiSrc.slice(idx, idx + 1600);
  const m = slice.match(
    /\}\s*catch\s*\(\s*err\s*\)\s*\{[\s\S]*?^\s*\}/m,
  );
  if (!m) return null;
  return m[0]
    .split('\n')
    .map((line) => line.replace(/^\s+/, ''))
    .join('\n')
    .trim();
}

function masterCreateServerCatchSemantic() {
  try {
    const out = execSync(
      `git show ${MASTER}:scripts/staff-query-api.js`,
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return extractCreateServerCatchSemantic(out);
  } catch (_) {
    return null;
  }
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
    && contract.event_context_contract.completion_logging === false
    && contract.event_context_contract.req_res_lifecycle_listeners === false
    && contract.event_context_contract.console_completion_emission === false
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

  ok('C4 no completion logging / lifecycle listeners / queue / signals',
    !/deliveryQueue|sinkQueue|enqueueCompletion|installCorrelationProcessShutdown|flushCorrelation|SIGTERM|SIGINT|beforeExit/.test(libSrc)
    && !/process\.on\s*\(/.test(libSrc)
    && !/process\.exit/.test(libSrc)
    && !/console\.log\(JSON\.stringify/.test(libSrc)
    && !/\.on\(\s*['"]finish['"]/.test(libSrc)
    && !/\.on\(\s*['"]close['"]/.test(libSrc)
    && !/\.on\(\s*['"]aborted['"]/.test(libSrc)
    && !/\.on\(\s*['"]error['"]/.test(libSrc)
    && !/emitCompletionOnce|buildCompletionEvent|setCompletionEmitSink|assertSafeCompletionEvent/.test(libSrc)
    && !/DURATION_MS_BUCKET|staff_api_http_request_complete/.test(libSrc));

  ok('C5 handler signatures unchanged',
    !/async function router\(req, res, correlation/.test(apiSrc)
    && !/function sendJSON\(res, statusCode, body, correlation/.test(apiSrc)
    && !/headersSent/.test(extractCreateServerCatchSemantic(apiSrc) || ''));

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

  // ── RED: forged tenant headers ignored ────────────────────────────────────
  {
    const id = '11111111-2222-4333-8444-555555555501';
    let seen = null;
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
      seen = corr.getRequestContext();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    }, { ingressBinding: null });
    red('forged_tenant_headers_ignored',
      seen
      && seen.requestId === id
      && seen.tenantSlug == null,
      JSON.stringify(seen));
  }

  // ── RED: concurrent ALS isolation ─────────────────────────────────────────
  {
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
          tenant: ctx && ctx.tenantSlug,
        };
      }, {
        ingressBinding: { tenant_slug: `tenant-${i}` },
      });
    }));
    const bleed = results.some((r) => r.ctxId !== r.id || r.rid !== r.id);
    const tenantsOk = results.every((r, i) => r.tenant === `tenant-${i}`);
    red('concurrent_context_isolation',
      !bleed && tenantsOk && results.length === 5,
      JSON.stringify(results));
  }

  // ── RED: route query stripped (ALS context helper; not logged) ────────────
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

  // ── RED: no req/res lifecycle listeners beyond base ───────────────────────
  {
    const { req, res } = makeMockReqRes({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': '11111111-2222-4333-8444-555555555540' },
    });
    const beforeReq = corr.countLifecycleListeners(req);
    const beforeRes = corr.countLifecycleListeners(res);
    await corr.runWithRequestCorrelation(req, res, async () => {
      const midReq = corr.countLifecycleListeners(req);
      const midRes = corr.countLifecycleListeners(res);
      red('no_req_res_listeners_beyond_base',
        sameListenerSnapshot(beforeReq, midReq)
        && sameListenerSnapshot(beforeRes, midRes)
        && midReq.finish === 0
        && midReq.close === 0
        && midReq.error === 0
        && midReq.aborted === 0
        && midRes.finish === 0
        && midRes.close === 0
        && midRes.error === 0
        && midRes.aborted === 0,
        JSON.stringify({ beforeReq, beforeRes, midReq, midRes }));
      res.writeHead(200);
      res.end('ok');
    });
  }

  // ── RED: synthetic req/res error behavior = baseline (no new error listeners)
  {
    async function runErrorProbe(withCorrelation) {
      const { req, res } = makeMockReqRes({
        method: 'GET',
        url: '/healthz',
        headers: withCorrelation
          ? { 'x-request-id': '11111111-2222-4333-8444-555555555550' }
          : {},
      });
      const reqErrors = [];
      const resErrors = [];
      const before = {
        req: corr.countLifecycleListeners(req),
        res: corr.countLifecycleListeners(res),
      };

      const probe = async () => {
        const afterSetup = {
          req: corr.countLifecycleListeners(req),
          res: corr.countLifecycleListeners(res),
        };
        req.on('error', (e) => reqErrors.push(String(e && e.message)));
        res.on('error', (e) => resErrors.push(String(e && e.message)));
        req.emit('error', new Error('probe_req'));
        res.emit('error', new Error('probe_res'));
        if (withCorrelation) {
          res.writeHead(200);
          res.end('ok');
        }
        return afterSetup;
      };

      const afterSetup = withCorrelation
        ? await corr.runWithRequestCorrelation(req, res, async () => probe(), {})
        : await probe();
      return { before, afterSetup, reqErrors, resErrors };
    }

    const [base, wrapped] = await Promise.all([
      runErrorProbe(false),
      runErrorProbe(true),
    ]);
    red('synthetic_error_behavior_baseline',
      sameListenerSnapshot(base.before.req, base.afterSetup.req)
      && sameListenerSnapshot(wrapped.before.req, wrapped.afterSetup.req)
      && sameListenerSnapshot(wrapped.before.res, wrapped.afterSetup.res)
      && wrapped.afterSetup.req.error === 0
      && wrapped.afterSetup.res.error === 0
      && base.afterSetup.req.error === 0
      && base.afterSetup.res.error === 0
      && JSON.stringify(base.reqErrors) === JSON.stringify(wrapped.reqErrors)
      && JSON.stringify(base.resErrors) === JSON.stringify(wrapped.resErrors)
      && JSON.stringify(base.reqErrors) === JSON.stringify(['probe_req'])
      && JSON.stringify(base.resErrors) === JSON.stringify(['probe_res']),
      JSON.stringify({ base, wrapped }));
  }

  // ── RED: router catch block unchanged from master base ────────────────────
  {
    const currentCatch = extractCreateServerCatchSemantic(apiSrc);
    const masterCatch = masterCreateServerCatchSemantic();
    red('router_catch_unchanged_from_base',
      typeof currentCatch === 'string'
      && typeof masterCatch === 'string'
      && currentCatch === masterCatch
      && currentCatch === locks.BASE_ROUTER_CATCH_SEMANTIC
      && !/headersSent/.test(currentCatch),
      JSON.stringify({
        currentCatch,
        masterCatch,
        locked: locks.BASE_ROUTER_CATCH_SEMANTIC,
      }));
  }

  // ── RED: no console/log side effect from correlation path ─────────────────
  {
    const calls = [];
    const origLog = console.log;
    const origInfo = console.info;
    const origWarn = console.warn;
    const origError = console.error;
    const spy = (fn) => (...args) => {
      calls.push({ fn, args: args.map((a) => String(a)) });
    };
    // Keep verifier PASS/FAIL visible — only wrap during the correlation call.
    console.log = spy('log');
    console.info = spy('info');
    console.warn = spy('warn');
    console.error = spy('error');
    try {
      const id = '11111111-2222-4333-8444-555555555560';
      const { req, res } = makeMockReqRes({
        method: 'GET',
        url: `/healthz?token=${'sk_' + 'live_'}CANARY`,
        headers: { 'x-request-id': id },
      });
      await corr.runWithRequestCorrelation(req, res, async () => {
        res.writeHead(200);
        res.end('ok');
      }, { ingressBinding: { tenant_slug: 'wolfhouse-somo' } });
    } finally {
      console.log = origLog;
      console.info = origInfo;
      console.warn = origWarn;
      console.error = origError;
    }
    red('no_console_log_side_effect',
      calls.length === 0
      && !/console\.log\(JSON\.stringify/.test(libSrc)
      && contract.event_context_contract.console_completion_emission === false,
      JSON.stringify(calls));
  }

  // ── RED: no process handler / async queue ownership ───────────────────────
  {
    const ownership = contract.event_context_contract.completion_ownership;
    red('no_async_queue_ownership',
      !/deliveryQueue|SINK_QUEUE|enqueueCompletionEvent|flushCorrelationEmitSink|installCorrelationProcessShutdownHooks/.test(libSrc)
      && ownership.async_log_queue === false
      && ownership.signal_shutdown_handlers === false
      && ownership.req_res_lifecycle_listeners === false
      && ownership.completion_console_emission === false
      && ownership.duration_route_status_logging === false
      && ownership.one_record_completion_claim === false);
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
  const consoleCalls = [];
  applyMinimalStaffApiEnv();
  process.env.DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
  clearStaffApiCache();

  const exitCodeBefore = process.exitCode;
  const origLogG = console.log;
  const origInfoG = console.info;
  // Do not swallow verifier output — wrap after loading, around HTTP only.
  let api;
  let server;
  let port;
  try {
    api = loadStaffApi();
    server = api.createStaffQueryApiHttpServer();
    port = await listen(server);

    const wrapConsole = () => {
      console.log = (...args) => {
        consoleCalls.push(args.map((a) => String(a)).join(' '));
        return origLogG.apply(console, args);
      };
      console.info = (...args) => {
        consoleCalls.push(args.map((a) => String(a)).join(' '));
        return origInfoG.apply(console, args);
      };
    };
    const unwrapConsole = () => {
      console.log = origLogG;
      console.info = origInfoG;
    };

    wrapConsole();
    const beforeHttpConsole = consoleCalls.length;

    const suppliedId = 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111';
    const supplied = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': suppliedId, accept: 'application/json' },
    });
    green('listener_supplied_uuid',
      supplied.statusCode === 200
      && supplied.headers['x-request-id'] === suppliedId,
      JSON.stringify({ status: supplied.statusCode, hdr: supplied.headers['x-request-id'] }));

    const generated = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': 'NOT-A-UUID!!!!', accept: 'application/json' },
    });
    const genId = generated.headers['x-request-id'];
    green('listener_generated_uuid',
      generated.statusCode === 200
      && typeof genId === 'string'
      && corr.UUID_V4_RE.test(genId)
      && genId === genId.toLowerCase(),
      `genId=${genId}`);

    const concIds = [
      'aaaaaaaa-bbbb-4ccc-8ddd-222222222220',
      'aaaaaaaa-bbbb-4ccc-8ddd-222222222221',
      'aaaaaaaa-bbbb-4ccc-8ddd-222222222222',
      'aaaaaaaa-bbbb-4ccc-8ddd-222222222223',
    ];
    const concRes = await Promise.all(concIds.map((id) => httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': id, accept: 'application/json' },
    })));
    green('listener_concurrent_isolation',
      concRes.every((r, i) => r.statusCode === 200 && r.headers['x-request-id'] === concIds[i]),
      JSON.stringify({
        statuses: concRes.map((r) => r.statusCode),
        headers: concRes.map((r) => r.headers['x-request-id']),
      }));

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
      && supplied.headers['x-request-id'] === suppliedId);

    const notFound = await httpRequest(port, {
      method: 'GET',
      reqPath: '/nope-16j',
      headers: {
        'x-request-id': 'aaaaaaaa-bbbb-4ccc-8ddd-444444444444',
        accept: 'application/json',
      },
    });
    green('listener_4xx',
      notFound.statusCode === 404
      && notFound.headers['x-request-id'] === 'aaaaaaaa-bbbb-4ccc-8ddd-444444444444',
      JSON.stringify({ status: notFound.statusCode }));

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
    green('listener_5xx',
      errRes.statusCode === 500
      && errRes.headers['x-request-id'] === 'aaaaaaaa-bbbb-4ccc-8ddd-555555555555'
      && !errRes.body.includes('radar16j_forced_internal_error')
      && !errRes.body.includes('stack'),
      JSON.stringify({ status: errRes.statusCode, body: errRes.body.slice(0, 120) }));

    const canaryPath = `/healthz?token=${'sk_' + 'live_'}CANARY&email=alice@example.com&phone=%2B34123456789`;
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
    const httpConsoleSlice = consoleCalls.slice(beforeHttpConsole);
    const leakyConsole = httpConsoleSlice.some((line) =>
      line.includes('sk_' + 'live_')
      || line.includes('alice@')
      || line.includes('hunter2')
      || line.includes('guest_phone')
      || line.includes('staff_api_http_request_complete')
      || line.includes('"duration_ms"')
      || line.includes('"request_id"'));
    green('listener_sensitive_canaries_absent',
      canaryRes.headers['x-request-id'] === 'aaaaaaaa-bbbb-4ccc-8ddd-666666666666'
      && !leakyConsole,
      JSON.stringify({ hdr: canaryRes.headers['x-request-id'], consoleN: httpConsoleSlice.length }));

    green('listener_no_completion_console',
      !httpConsoleSlice.some((line) =>
        line.includes('staff_api_http_request_complete')
        || (line.includes('"request_id"') && line.includes('"duration_ms"'))
        || line.includes('"event":"staff_api')),
      JSON.stringify(httpConsoleSlice.slice(0, 5)));

    unwrapConsole();

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
    console.log = origLogG;
    console.info = origInfoG;
    for (const id of REQUIRED_GREEN) {
      if (!greenResults.some((r) => r.id === id)) {
        green(id, false, String(err && err.stack || err));
      }
    }
  } finally {
    console.log = origLogG;
    console.info = origInfoG;
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

  ok('C11 drill + completion logs remain open',
    contract.final_controlled_drill
    && contract.final_controlled_drill.status === 'open'
    && contract.final_controlled_drill.id === '16J_DRILL_correlation_log_query'
    && Array.isArray(contract.still_open)
    && contract.still_open.some((s) => /completion logs/i.test(s)));

  ok('C12 npm script registered',
    /verify:radar-slice16j-staff-request-correlation/.test(readText('package.json')));

  ok('C13 completion logging locked off',
    contract.event_context_contract.completion_logging === false
    && contract.event_context_contract.one_record_completion_claim === false
    && !/DURATION_MS_BUCKET/.test(locksSrc));

  console.log(`\nRED: ${redResults.filter((r) => r.ok).length}/${redResults.length}  GREEN: ${greenResults.filter((r) => r.ok).length}/${greenResults.length}`);
  console.log(`Result: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16J Staff API request correlation (source-partial): PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
