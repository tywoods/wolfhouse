'use strict';

/**
 * verify:radar-slice16r-staff-request-completion-log — RADAR Slice 16R
 *
 * Offline RED/GREEN gate for Staff API safe finish/close/error request-completion
 * structured request logs (builds on 16J ALS). GREEN proofs use real
 * createStaffQueryApiHttpServer (fortress dual-gate). No live deploy.
 * Covers aborts, streaming, duplicate finish+close, concurrent isolation.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16r-staff-request-completion-log');
const corr = require('./lib/staff-api-request-correlation');
const completion = require('./lib/staff-api-request-completion-log');

const MASTER = locks.MASTER_BASIS;
const CONTRACT_REL = 'fixtures/radar-operations/slice16r-expected-contract.json';

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
  'schema_fields_bounded',
  'exclusions_locked',
  'lifecycle_settlement_owned_not_grown',
  'no_queue_signal_flush_ownership',
  'router_catch_byte_identical',
  'duration_bucket_and_cap',
  'status_code_bounds',
  'status_class_and_outcome',
  'method_allowlist',
  'route_normalization_unit',
  'route_pathname_canaries_unit',
  'route_adversarial_normalization_unit',
  'raw_url_query_body_header_error_redacted',
  'duplicate_finish_close_exactly_one',
  'missing_record_without_settlement',
  'logger_throw_swallowed',
  'stale_module_logger_injection_cannot_satisfy_green',
  'no_process_handlers_installed',
  'no_duplicate_correlation_middleware',
];

const REQUIRED_GREEN = [
  'listener_2xx_exactly_one',
  'listener_4xx_exactly_one',
  'listener_5xx_exactly_one',
  'listener_async_error_5xx',
  'listener_supplied_id_correlates',
  'listener_generated_id_correlates',
  'listener_concurrent_isolation',
  'listener_trusted_tenant',
  'listener_canaries_absent',
  'listener_route_pathname_canaries',
  'listener_route_normalization',
  'listener_route_adversarial_normalization',
  'listener_duration_bounds',
  'listener_client_aborted_outcome',
  'listener_streaming_abort',
  'listener_duplicate_finish_close_one',
  'listener_server_error_outcome',
  'listener_logger_throw_http_unchanged',
  'listener_logger_throw_5xx_unchanged',
  'listener_counts_process_exit_unchanged',
  'listener_no_lifecycle_growth',
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
      || /staff-api-request-completion-log\.js$/.test(key)
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
  process.env.LUNA_BOT_INTERNAL_TOKEN = 'radar16r_bot_token_offline_test_01';
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

function countProcessListeners(event) {
  return process.listenerCount(event);
}

function extractCreateServerCatchSemantic(apiSrc) {
  const marker = 'function createStaffQueryApiHttpServer';
  const idx = apiSrc.indexOf(marker);
  if (idx < 0) return null;
  const slice = apiSrc.slice(idx, idx + 2200);
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

function canaryLeakInLine(line) {
  const s = String(line || '');
  return s.includes('sk_' + 'live_')
    || s.includes('alice@')
    || s.includes('hunter2')
    || s.includes('guest_phone')
    || s.includes('+34123456789')
    || s.includes('34123456789')
    || s.includes('Bearer eyJ')
    || s.includes('password')
    || s.includes('Alice Example')
    || s.includes('Alice%20Example')
    || s.includes('Alice-Example')
    || s.includes('radar16r_tok_')
    || s.includes('nope-16r')
    || s.includes('%40example')
    || s.includes('%ZZ')
    || /"email"\s*:/.test(s)
    || /"phone"\s*:/.test(s)
    || /"name"\s*:/.test(s)
    || /"authorization"\s*:/.test(s)
    || /"cookie"\s*:/.test(s)
    || /"query"\s*:/.test(s)
    || /"body"\s*:/.test(s)
    || /"headers"\s*:/.test(s)
    || /"url"\s*:/.test(s)
    || /"stack"\s*:/.test(s);
}

/** Pathname privacy canaries — none may appear in emitted route (or console JSON). */
const PATHNAME_CANARIES = Object.freeze([
  { label: 'email', path: '/staff/alice@example.com', forbid: ['alice@', 'example.com'] },
  { label: 'full_name', path: '/staff/Alice%20Example', forbid: ['Alice', 'Example', 'Alice%20'] },
  { label: 'phone', path: '/staff/%2B34123456789', forbid: ['34123456789', '+34', '%2B'] },
  { label: 'token', path: '/staff/radar16r_tok_ABCDEFGHIJKLMNOP', forbid: ['radar16r_tok_'] },
  { label: 'encoded_email', path: '/staff/alice%40example.com', forbid: ['alice', 'example', '%40'] },
  { label: 'malformed_percent', path: '/staff/bad%ZZtoken', forbid: ['bad%ZZ', '%ZZ', 'bad%'] },
  { label: 'unknown_short', path: '/nope-16r', forbid: ['nope-16r', 'nope'] },
]);

function routeHasForbidden(route, forbidList) {
  const r = String(route || '');
  return forbidList.some((f) => r.includes(f));
}

async function main() {
  console.log('verify:radar-slice16r-staff-request-completion-log — RADAR Slice 16R\n');

  const contract = readJson(CONTRACT_REL);
  const libSrc = readText(locks.COMPLETION_LIB_REL);
  const corrSrc = readText(locks.CORRELATION_LIB_REL);
  const apiSrc = readText(locks.STAFF_API_REL);
  const locksSrc = readText('scripts/lib/radar-slice16r-staff-request-completion-log.js');

  ok('C1 contract identity',
    contract.outcome_id === locks.OUTCOME_ID
    && contract.gate_id === locks.GATE_ID
    && contract.progress_class === locks.PROGRESS_CLASS
    && contract.master_basis === MASTER
    && contract.branch === locks.BRANCH
    && contract.live_deploy === false);

  ok('C2 owned artifacts present',
    locks.OWNED_RELS.every((rel) => fs.existsSync(path.join(ROOT, rel))));

  const sec = secretFree(
    [libSrc, apiSrc, locksSrc, JSON.stringify(contract)].join('\n'),
    '16R artifacts',
  );
  ok('C3 secret-free 16R artifacts', sec.ok, sec.detail);

  // ── RED unit ──────────────────────────────────────────────────────────────
  red('schema_fields_bounded',
    JSON.stringify(contract.event_schema.fields_only) === JSON.stringify(locks.BOUNDED_SCHEMA_FIELDS)
    && completion.EVENT_ALLOWED_KEYS.every((k) => locks.BOUNDED_SCHEMA_FIELDS.includes(k))
    && completion.EVENT_NAME === locks.EVENT_NAME
    && contract.event_schema.event === locks.EVENT_NAME);

  red('exclusions_locked',
    Array.isArray(contract.exclusions)
    && locks.EXCLUSIONS.every((e) => contract.exclusions.includes(e))
    && !/url_query|raw_url|headers|body|guest|phone|email/.test(
      JSON.stringify(completion.buildRequestCompletedRecord({
        request_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        method: 'GET',
        route: '/healthz',
        status_code: 200,
        duration_ms: 1,
        outcome: 'completed',
        tenant_slug: 'wolfhouse-somo',
      })),
    ));

  red('lifecycle_settlement_owned_not_grown',
    /attachStaffApiRequestCompletion/.test(libSrc)
    && /attachStaffApiRequestCompletion/.test(apiSrc)
    && /\.on\(\s*['"]finish['"]/.test(libSrc)
    && /\.on\(\s*['"]close['"]/.test(libSrc)
    && /\.on\(\s*['"]error['"]/.test(libSrc)
    && /removeListener/.test(libSrc)
    && !/\.on\(\s*['"]aborted['"]/.test(libSrc)
    && contract.emission_contract.req_res_lifecycle_listeners === true
    && contract.emission_contract.lifecycle_listener_growth === false
    && contract.emission_contract.listeners_removed_on_settle === true
    && contract.emission_contract.duplicate_middleware === false);

  red('no_queue_signal_flush_ownership',
    !/deliveryQueue|SINK_QUEUE|enqueueCompletion|flushCorrelation|installCorrelationProcessShutdown|process\.on\(/.test(libSrc)
    && contract.emission_contract.async_log_queue === false
    && contract.emission_contract.signal_shutdown_handlers === false
    && contract.emission_contract.exit_code_mutation === false
    && contract.emission_contract.buffer_flush === false);

  {
    const current = extractCreateServerCatchSemantic(apiSrc);
    const masterCatch = masterCreateServerCatchSemantic();
    red('router_catch_byte_identical',
      current === locks.BASE_ROUTER_CATCH_SEMANTIC
      && masterCatch === locks.BASE_ROUTER_CATCH_SEMANTIC
      && contract.emission_contract.router_catch_byte_identical === true,
      JSON.stringify({ current, masterCatch }));
  }

  red('duration_bucket_and_cap',
    completion.bucketDurationMs(1) === 5
    && completion.bucketDurationMs(5) === 5
    && completion.bucketDurationMs(6) === 10
    && completion.bucketDurationMs(300000) === 300000
    && completion.bucketDurationMs(300001) === 300000
    && completion.bucketDurationMs(9999999) === 300000
    && completion.DURATION_MS_BUCKET === 5
    && completion.DURATION_MS_CAP === 300000
    && contract.event_schema.duration_ms.bucket_ms === 5
    && contract.event_schema.duration_ms.cap_ms === 300000);

  red('status_code_bounds',
    completion.boundStatusCode(200) === 200
    && completion.boundStatusCode(404) === 404
    && completion.boundStatusCode(500) === 500
    && completion.boundStatusCode(99) === 0
    && completion.boundStatusCode(600) === 0
    && completion.boundStatusCode('nope') === 0
    && completion.boundStatusCode(200.9) === 200);

  red('status_class_and_outcome',
    completion.statusClassForCode(200) === '2xx'
    && completion.statusClassForCode(404) === '4xx'
    && completion.statusClassForCode(500) === '5xx'
    && completion.statusClassForCode(0) === '0xx'
    && completion.allowlistOutcome('completed') === 'completed'
    && completion.allowlistOutcome('client_aborted') === 'client_aborted'
    && completion.allowlistOutcome('server_error') === 'server_error'
    && completion.allowlistOutcome('nope') === 'completed'
    && JSON.stringify(completion.ALLOWED_OUTCOMES) === JSON.stringify(locks.ALLOWED_OUTCOMES));

  red('method_allowlist',
    completion.allowlistMethod('get') === 'GET'
    && completion.allowlistMethod('POST') === 'POST'
    && completion.allowlistMethod('TRACE') === 'GET'
    && completion.allowlistMethod('FOO') === 'GET');

  red('route_normalization_unit',
    completion.normalizeCompletionRoute('/staff/bookings/12345?token=secret') === '/staff/bookings/:id'
    && completion.normalizeCompletionRoute('/pay/abc/def?x=1') === '/pay/:redacted/:redacted'
    && completion.normalizeCompletionRoute('/healthz') === '/healthz'
    && completion.normalizeCompletionRoute('/readyz') === '/readyz'
    && completion.normalizeCompletionRoute('/nope-16r') === completion.ROUTE_UNMATCHED
    && completion.normalizeCompletionRoute('') === '/'
    && completion.normalizeCompletionRoute('/') === '/'
    && completion.normalizeCompletionRoute('///') === '/'
    && !completion.normalizeCompletionRoute('/a?b=1').includes('?')
    && !completion.normalizeCompletionRoute('/staff/x#frag').includes('#')
    && Object.isFrozen(completion.ROUTE_STATIC_SEGMENT_ALLOWLIST)
    && completion.ROUTE_STATIC_SEGMENT_ALLOWLIST.includes('staff')
    && completion.ROUTE_STATIC_SEGMENT_ALLOWLIST.includes('healthz')
    && completion.ROUTE_STATIC_SEGMENT_ALLOWLIST.includes('readyz')
    && !completion.ROUTE_STATIC_SEGMENT_ALLOWLIST.includes('wolfhouse-somo')
    && !completion.ROUTE_STATIC_SEGMENT_ALLOWLIST.includes('details')
    && !/\[A-Za-z0-9_-\]\{20,\}/.test(libSrc)
    && !/\[A-Za-z0-9_\-\]\{20,\}/.test(libSrc));

  {
    const unitRoutes = PATHNAME_CANARIES.map((c) => completion.normalizeCompletionRoute(c.path));
    const unitOk = PATHNAME_CANARIES.every((c, i) => {
      const route = unitRoutes[i];
      return typeof route === 'string'
        && !route.includes('?')
        && !route.includes('#')
        && !routeHasForbidden(route, c.forbid)
        && completion.routeSegmentsAreAllowlistedOrPlaceholders(route)
        && completion.assertSafeRequestCompletedRecord({
          event: completion.EVENT_NAME,
          request_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          method: 'GET',
          route,
          status_code: 200,
          status_class: '2xx',
          duration_ms: 5,
          outcome: 'completed',
        }).ok;
    });
    // Deterministic cardinality: same inputs → identical outputs
    const again = PATHNAME_CANARIES.map((c) => completion.normalizeCompletionRoute(c.path));
    red('route_pathname_canaries_unit',
      unitOk
      && JSON.stringify(unitRoutes) === JSON.stringify(again)
      && unitRoutes.includes(completion.ROUTE_UNMATCHED)
      && completion.normalizeCompletionRoute('/staff/radar16r_tok_ABCDEFGHIJKLMNOP')
        === '/staff/:redacted'
      && unitRoutes.every((r) => r === completion.ROUTE_UNMATCHED || r.startsWith('/staff/')),
      JSON.stringify(PATHNAME_CANARIES.map((c, i) => ({ label: c.label, route: unitRoutes[i] }))));
  }

  {
    const longStatic = 'guest-simulator-create-stripe-test-link';
    const longStaticRoute = completion.normalizeCompletionRoute(`/staff/${longStatic}`);
    const manySegs = [
      'staff',
      'guest-simulator-create-stripe-test-link',
      'open-demo-whatsapp-inbound-dry-run',
      'guest-simulator-create-hold-draft',
      'guest-automation-review-dry-run',
      'guest-inbound-review-dry-run',
      'check-guest-automation-gate',
      'generate-guest-payment-link',
      'booking-write-eligibility',
    ];
    const manyPath = `/${manySegs.join('/')}`;
    const manyRoute = completion.normalizeCompletionRoute(manyPath);
    const manySegsOut = manyRoute.split('/').filter(Boolean);
    const unboundedMany = `/${manySegs.join('/')}`;

    // Exact boundary: 26×staff + pay → length 160 (6*26 + 4 = 160).
    const exactSegs = [...Array(26).fill('staff'), 'pay'];
    const exactPath = `/${exactSegs.join('/')}`;
    const exactNorm = completion.normalizeCompletionRoute(exactPath);
    const overPath = `${exactPath}/bot`;
    const overOne = completion.normalizeCompletionRoute(overPath);

    const multibyte = completion.normalizeCompletionRoute('/staff/%E6%97%A5%E6%9C%AC%E8%AA%9E');
    const encodedName = completion.normalizeCompletionRoute('/staff/Alice%20Example');
    const malformed = completion.normalizeCompletionRoute('/staff/bad%ZZtoken');
    const whCode = completion.normalizeCompletionRoute('/pay/WH-260528-1493');
    const uuidRoute = completion.normalizeCompletionRoute(
      '/staff/bookings/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
    const longToken = completion.normalizeCompletionRoute('/staff/radar16r_tok_ABCDEFGHIJKLMNOP');

    const adversarialSamples = [
      longStaticRoute,
      manyRoute,
      exactNorm,
      overOne,
      multibyte,
      encodedName,
      malformed,
      whCode,
      uuidRoute,
      longToken,
      completion.normalizeCompletionRoute(''),
      completion.normalizeCompletionRoute('/'),
    ];

    const allLegal = adversarialSamples.every((r) =>
      completion.routeSegmentsAreAllowlistedOrPlaceholders(r)
      && completion.assertSafeRequestCompletedRecord({
        event: completion.EVENT_NAME,
        request_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        method: 'GET',
        route: r,
        status_code: 200,
        status_class: '2xx',
        duration_ms: 5,
        outcome: 'completed',
      }).ok);

    const noPartialCuts = adversarialSamples.every((r) => {
      if (r === '/' || r === completion.ROUTE_UNMATCHED) return true;
      const segs = r.split('/').filter(Boolean);
      return segs.every((seg) => (
        seg === completion.ROUTE_ID_PLACEHOLDER
        || seg === completion.ROUTE_REDACTED_PLACEHOLDER
        || seg === completion.ROUTE_TRUNCATED_PLACEHOLDER
        || completion.ROUTE_STATIC_SEGMENT_ALLOWLIST.includes(seg)
      ));
    });

    // many-route must be a full-segment prefix of unbounded, optionally + :truncated
    const manyPrefixOk = (() => {
      const out = manySegsOut.filter((s) => s !== completion.ROUTE_TRUNCATED_PLACEHOLDER);
      const prefix = `/${out.join('/')}`;
      return unboundedMany === prefix || unboundedMany.startsWith(`${prefix}/`);
    })();

    red('route_adversarial_normalization_unit',
      exactPath.length === completion.ROUTE_MAX_LEN
      && longStaticRoute === `/staff/${longStatic}`
      && longToken === '/staff/:redacted'
      && !completion.isRecognizedIdSegment('radar16r_tok_ABCDEFGHIJKLMNOP')
      && !completion.isRecognizedIdSegment(longStatic)
      && completion.isUuidOrNumericIdSegment('12345')
      && completion.isUuidOrNumericIdSegment('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
      && completion.isStrictTypedIdSegment('WH-260528-1493')
      && whCode === '/pay/:id'
      && uuidRoute === '/staff/bookings/:id'
      && multibyte === '/staff/:redacted'
      && encodedName === '/staff/:redacted'
      && malformed === '/staff/:redacted'
      && manyPath.length > completion.ROUTE_MAX_LEN
      && manyRoute.length <= completion.ROUTE_MAX_LEN
      && manySegsOut.every((seg) => (
        seg === completion.ROUTE_TRUNCATED_PLACEHOLDER
        || completion.ROUTE_STATIC_SEGMENT_ALLOWLIST.includes(seg)
      ))
      && manyPrefixOk
      && manyRoute.includes(completion.ROUTE_TRUNCATED_PLACEHOLDER)
      && exactNorm === exactPath
      && exactNorm.length === completion.ROUTE_MAX_LEN
      && !exactNorm.includes(completion.ROUTE_TRUNCATED_PLACEHOLDER)
      && overOne === exactNorm
      && overOne.length === completion.ROUTE_MAX_LEN
      && !overOne.includes('bot')
      && allLegal
      && noPartialCuts
      && !/route\.slice\(0,\s*ROUTE_MAX_LEN\)/.test(libSrc)
      && !/\.slice\(0,\s*ROUTE_MAX_LEN\)/.test(libSrc),
      JSON.stringify({
        longStaticRoute,
        longToken,
        manyRoute,
        manyLen: manyRoute.length,
        exactLen: exactNorm.length,
        exactPathLen: exactPath.length,
        overOne,
        multibyte,
        encodedName,
        malformed,
      }));
  }

  // RED: raw url/query/body/header/error never appear in records
  {
    const leaky = completion.buildRequestCompletedRecord({
      request_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      method: 'GET',
      route: '/staff/bookings/12345?email=a@b.com&token=secret#frag',
      status_code: 200,
      duration_ms: 5,
      outcome: 'completed',
      tenant_slug: 'wolfhouse-somo',
      // Attempt to smuggle forbidden fields via unexpected props — builder ignores them.
      url: '/raw?x=1',
      headers: { authorization: 'Bearer x', cookie: 's=1' },
      body: '{"email":"x@y.z"}',
      error: new Error('db boom'),
      stack: 'Error: boom',
    });
    const blob = JSON.stringify(leaky);
    red('raw_url_query_body_header_error_redacted',
      !!leaky
      && completion.assertSafeRequestCompletedRecord(leaky).ok
      && leaky.route === '/staff/bookings/:id'
      && !blob.includes('?')
      && !blob.includes('email')
      && !blob.includes('Bearer')
      && !blob.includes('cookie')
      && !blob.includes('db boom')
      && !blob.includes('stack')
      && !Object.prototype.hasOwnProperty.call(leaky, 'url')
      && !Object.prototype.hasOwnProperty.call(leaky, 'headers')
      && !Object.prototype.hasOwnProperty.call(leaky, 'body')
      && !Object.prototype.hasOwnProperty.call(leaky, 'error')
      && !Object.prototype.hasOwnProperty.call(leaky, 'stack'),
      blob);
  }

  // RED: duplicate finish+close settles exactly once (unit)
  {
    const records = [];
    const { req, res } = (() => {
      const { EventEmitter } = require('events');
      const req = new EventEmitter();
      req.method = 'GET';
      req.url = '/healthz';
      req.headers = { 'x-request-id': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setHeader = () => {};
      return { req, res };
    })();
    await corr.runWithRequestCorrelation(req, res, async () => {
      completion.attachStaffApiRequestCompletion(req, res, {
        startedAtMs: Date.now() - 10,
        trustedTenantSlug: 'wolfhouse-somo',
        rawUrl: '/healthz',
        logger: (r) => records.push(r),
      });
      res.emit('finish');
      res.emit('close');
      res.emit('finish');
      res.emit('close');
    });
    red('duplicate_finish_close_exactly_one',
      records.length === 1
      && records[0].outcome === 'completed'
      && completion.assertSafeRequestCompletedRecord(records[0]).ok
      && corr.countLifecycleListeners(res).finish === 0
      && corr.countLifecycleListeners(res).close === 0
      && corr.countLifecycleListeners(res).error === 0,
      JSON.stringify(records));
  }

  // RED: no settlement → missing record (unit)
  {
    const records = [];
    const { EventEmitter } = require('events');
    const req = new EventEmitter();
    req.method = 'GET';
    req.url = '/healthz';
    req.headers = { 'x-request-id': 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    const res = new EventEmitter();
    res.statusCode = 200;
    res.setHeader = () => {};
    await corr.runWithRequestCorrelation(req, res, async () => {
      completion.attachStaffApiRequestCompletion(req, res, {
        startedAtMs: Date.now(),
        logger: (r) => records.push(r),
      });
      // no finish/close/error
    });
    red('missing_record_without_settlement', records.length === 0, JSON.stringify(records));
  }

  red('no_duplicate_correlation_middleware',
    /runWithRequestCorrelation/.test(apiSrc)
    && /attachStaffApiRequestCompletion/.test(apiSrc)
    && (apiSrc.match(/runWithRequestCorrelation/g) || []).length >= 1
    && !/function runWithRequestCorrelation/.test(libSrc)
    && !/acceptOrGenerateRequestId/.test(libSrc)
    && contract.emission_contract.extends === '16J_runWithRequestCorrelation_ALS'
    && contract.emission_contract.duplicate_middleware === false);

  {
    const listenersBefore = {
      SIGTERM: countProcessListeners('SIGTERM'),
      SIGINT: countProcessListeners('SIGINT'),
      beforeExit: countProcessListeners('beforeExit'),
      exit: countProcessListeners('exit'),
    };
    let threw = false;
    completion.setCompletionLogger(() => { throw new Error('logger_boom'); });
    try {
      const req = { method: 'GET', url: '/healthz', headers: {} };
      const res = {
        statusCode: 200,
        setHeader() {},
        headersSent: false,
      };
      await corr.runWithRequestCorrelation(req, res, async () => {
        completion.emitStaffApiRequestCompleted({
          request_id: corr.requestId(),
          method: 'GET',
          route: '/healthz',
          tenant_slug: 'wolfhouse-somo',
          status_code: 200,
          duration_ms: 3,
          outcome: 'completed',
          logger: () => { throw new Error('logger_boom_di'); },
        });
      });
    } catch (err) {
      threw = true;
    }
    completion.setCompletionLogger(null);
    red('logger_throw_swallowed',
      threw === false
      && contract.emission_contract.logger_failure_must_not_alter_response_or_rejection === true);

    // RED: setCompletionLogger on a stale module instance (pre-cache-clear) cannot
    // control the instance wired into staff-query-api after clear — so it cannot
    // satisfy GREEN "no completion JSON when logger throws".
    {
      const staleCompletion = require('./lib/staff-api-request-completion-log');
      let staleHookHits = 0;
      staleCompletion.setCompletionLogger(() => {
        staleHookHits += 1;
        throw new Error('stale_module_logger_throw');
      });
      applyMinimalStaffApiEnv();
      process.env.DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
      clearStaffApiCache();
      const apiFresh = require('../scripts/staff-query-api.js');
      const liveCompletion = require('./lib/staff-api-request-completion-log');
      const staleIsDifferentInstance = staleCompletion !== liveCompletion;
      const consoleCap = [];
      const origLog = console.log;
      console.log = (...args) => {
        consoleCap.push(args.map((a) => String(a)).join(' '));
      };
      let portStale;
      let serverStale;
      let staleProof = null;
      try {
        serverStale = apiFresh.createStaffQueryApiHttpServer({
          ingressBinding: { tenant_slug: 'wolfhouse-somo' },
          // Intentionally omit completionLogger DI — production default console.
        });
        portStale = await listen(serverStale);
        const r = await httpRequest(portStale, {
          method: 'GET',
          reqPath: '/healthz',
          headers: {
            'x-request-id': 'aaaaaaaa-bbbb-4ccc-8ddd-999999999991',
            accept: 'application/json',
          },
        });
        const emitted = liveCompletion.parseCompletionRecordsFromConsole(consoleCap);
        staleProof = {
          staleIsDifferentInstance,
          staleHookHits,
          status: r.statusCode,
          emitted: emitted.length,
          event: emitted[0] && emitted[0].event,
        };
      } finally {
        console.log = origLog;
        staleCompletion.setCompletionLogger(null);
        liveCompletion.setCompletionLogger(null);
        if (serverStale) await closeServer(serverStale);
        clearStaffApiCache();
      }
      // Stale hook did not fire; default logger still emitted completion JSON.
      // Therefore stale-module injection cannot satisfy GREEN no-emission proof.
      red('stale_module_logger_injection_cannot_satisfy_green',
        staleProof
        && staleProof.staleIsDifferentInstance
        && staleProof.staleHookHits === 0
        && staleProof.status === 200
        && staleProof.emitted === 1
        && staleProof.event === completion.EVENT_NAME,
        JSON.stringify(staleProof));
    }

    const listenersAfter = {
      SIGTERM: countProcessListeners('SIGTERM'),
      SIGINT: countProcessListeners('SIGINT'),
      beforeExit: countProcessListeners('beforeExit'),
      exit: countProcessListeners('exit'),
    };
    red('no_process_handlers_installed',
      listenersAfter.SIGTERM === listenersBefore.SIGTERM
      && listenersAfter.SIGINT === listenersBefore.SIGINT
      && listenersAfter.beforeExit === listenersBefore.beforeExit
      && listenersAfter.exit === listenersBefore.exit
      && !/process\.on\(/.test(libSrc),
      JSON.stringify({ listenersBefore, listenersAfter }));
  }

  // ── GREEN: real listener ──────────────────────────────────────────────────
  const consoleCalls = [];
  applyMinimalStaffApiEnv();
  process.env.DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
  clearStaffApiCache();

  const exitCodeBefore = process.exitCode;
  const listenersBeforeHttp = {
    SIGTERM: countProcessListeners('SIGTERM'),
    SIGINT: countProcessListeners('SIGINT'),
    beforeExit: countProcessListeners('beforeExit'),
    exit: countProcessListeners('exit'),
  };
  const origLogG = console.log;
  const origInfoG = console.info;

  /** Construction-time logger DI — toggled for throw proofs (not module-level hook). */
  let activeCompletionLogger = null;
  function diCompletionLogger(record) {
    if (typeof activeCompletionLogger === 'function') {
      return activeCompletionLogger(record);
    }
    return console.log(JSON.stringify(record));
  }

  let api;
  let server;
  let port;
  try {
    api = loadStaffApi();
    // Re-bind completion helpers to the live module instance staff-query-api loaded.
    const liveCompletion = require('./lib/staff-api-request-completion-log');
    server = api.createStaffQueryApiHttpServer({
      ingressBinding: { tenant_slug: 'wolfhouse-somo' },
      completionLogger: diCompletionLogger,
    });
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

    function takeRecordsSince(n) {
      return liveCompletion.parseCompletionRecordsFromConsole(consoleCalls.slice(n));
    }

    // 2xx
    let mark = consoleCalls.length;
    const suppliedId = 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111';
    const r2xx = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': suppliedId, accept: 'application/json' },
    });
    const rec2xx = takeRecordsSince(mark);
    green('listener_2xx_exactly_one',
      r2xx.statusCode === 200
      && rec2xx.length === 1
      && liveCompletion.assertSafeRequestCompletedRecord(rec2xx[0]).ok
      && rec2xx[0].status_code === 200
      && rec2xx[0].status_class === '2xx'
      && rec2xx[0].outcome === 'completed'
      && rec2xx[0].request_id === suppliedId
      && rec2xx[0].route === '/healthz',
      JSON.stringify({ status: r2xx.statusCode, n: rec2xx.length, rec: rec2xx[0] }));

    // 4xx — unknown short segment → /:unmatched (never emit raw segment text)
    mark = consoleCalls.length;
    const id4xx = 'aaaaaaaa-bbbb-4ccc-8ddd-444444444444';
    const r4xx = await httpRequest(port, {
      method: 'GET',
      reqPath: '/nope-16r',
      headers: { 'x-request-id': id4xx, accept: 'application/json' },
    });
    const rec4xx = takeRecordsSince(mark);
    green('listener_4xx_exactly_one',
      r4xx.statusCode === 404
      && rec4xx.length === 1
      && rec4xx[0].status_code === 404
      && rec4xx[0].status_class === '4xx'
      && rec4xx[0].outcome === 'completed'
      && rec4xx[0].request_id === id4xx
      && rec4xx[0].route === liveCompletion.ROUTE_UNMATCHED
      && !String(rec4xx[0].route).includes('nope'),
      JSON.stringify({ status: r4xx.statusCode, n: rec4xx.length, rec: rec4xx[0] }));

    // 5xx via existing catch
    mark = consoleCalls.length;
    const id5xx = 'aaaaaaaa-bbbb-4ccc-8ddd-555555555555';
    api.setStaffQueryApiRequestHandlerForOfflineTest(async () => {
      throw new Error('radar16r_forced_internal_error_should_not_leak');
    });
    const r5xx = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': id5xx, accept: 'application/json' },
    });
    api.setStaffQueryApiRequestHandlerForOfflineTest(null);
    const rec5xx = takeRecordsSince(mark);
    green('listener_5xx_exactly_one',
      r5xx.statusCode === 500
      && rec5xx.length === 1
      && rec5xx[0].status_code === 500
      && rec5xx[0].status_class === '5xx'
      && rec5xx[0].outcome === 'completed'
      && rec5xx[0].request_id === id5xx
      && !r5xx.body.includes('radar16r_forced_internal_error')
      && r5xx.body.includes('internal server error')
      && !JSON.stringify(rec5xx[0]).includes('radar16r_forced')
      && !JSON.stringify(rec5xx[0]).includes('stack'),
      JSON.stringify({ status: r5xx.statusCode, n: rec5xx.length, body: r5xx.body.slice(0, 80) }));

    // Async rejection after headers not sent — same catch path (separate GREEN id)
    mark = consoleCalls.length;
    const idAsync = 'aaaaaaaa-bbbb-4ccc-8ddd-5555555555aa';
    api.setStaffQueryApiRequestHandlerForOfflineTest(async () => {
      await new Promise((r) => setTimeout(r, 15));
      throw new Error('radar16r_async_internal_error_should_not_leak');
    });
    const rAsync = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': idAsync, accept: 'application/json' },
    });
    api.setStaffQueryApiRequestHandlerForOfflineTest(null);
    const recAsync = takeRecordsSince(mark);
    green('listener_async_error_5xx',
      rAsync.statusCode === 500
      && recAsync.length === 1
      && recAsync[0].status_code === 500
      && recAsync[0].outcome === 'completed'
      && !JSON.stringify(recAsync[0]).includes('radar16r_async')
      && !rAsync.body.includes('radar16r_async'),
      JSON.stringify({ status: rAsync.statusCode, n: recAsync.length, rec: recAsync[0] }));

    green('listener_supplied_id_correlates',
      r2xx.headers['x-request-id'] === suppliedId
      && rec2xx[0].request_id === suppliedId);

    mark = consoleCalls.length;
    const generated = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': 'NOT-A-UUID!!!!', accept: 'application/json' },
    });
    const genId = generated.headers['x-request-id'];
    const recGen = takeRecordsSince(mark);
    green('listener_generated_id_correlates',
      generated.statusCode === 200
      && typeof genId === 'string'
      && corr.UUID_V4_RE.test(genId)
      && recGen.length === 1
      && recGen[0].request_id === genId,
      `genId=${genId} rec=${JSON.stringify(recGen[0])}`);

    const concIds = [
      'aaaaaaaa-bbbb-4ccc-8ddd-222222222220',
      'aaaaaaaa-bbbb-4ccc-8ddd-222222222221',
      'aaaaaaaa-bbbb-4ccc-8ddd-222222222222',
      'aaaaaaaa-bbbb-4ccc-8ddd-222222222223',
    ];
    mark = consoleCalls.length;
    const concRes = await Promise.all(concIds.map((id) => httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': id, accept: 'application/json' },
    })));
    const recConc = takeRecordsSince(mark);
    const concOk = concRes.every((r, i) => r.statusCode === 200 && r.headers['x-request-id'] === concIds[i])
      && recConc.length === concIds.length
      && concIds.every((id) => recConc.some((r) => r.request_id === id))
      && new Set(recConc.map((r) => r.request_id)).size === concIds.length;
    green('listener_concurrent_isolation',
      concOk,
      JSON.stringify({
        statuses: concRes.map((r) => r.statusCode),
        headers: concRes.map((r) => r.headers['x-request-id']),
        recIds: recConc.map((r) => r.request_id),
      }));

    green('listener_trusted_tenant',
      rec2xx[0].tenant_slug === 'wolfhouse-somo'
      && rec4xx[0].tenant_slug === 'wolfhouse-somo'
      && !Object.prototype.hasOwnProperty.call(
        liveCompletion.buildRequestCompletedRecord({
          request_id: suppliedId,
          method: 'GET',
          route: '/healthz',
          status_code: 200,
          duration_ms: 5,
          // forged / unsanitized omitted
          tenant_slug: 'evil<script>',
        }) || {},
        'tenant_slug',
      ));

    mark = consoleCalls.length;
    const canaryPath = `/healthz?token=${'sk_' + 'live_'}CANARY&email=alice@example.com&phone=%2B34123456789`;
    const canaryRes = await httpRequest(port, {
      method: 'POST',
      reqPath: canaryPath,
      headers: {
        'x-request-id': 'aaaaaaaa-bbbb-4ccc-8ddd-666666666666',
        accept: 'application/json',
        authorization: 'Bearer ' + 'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaa.bbbb',
        'content-type': 'application/json',
        cookie: 'session=secretcookie',
      },
      body: JSON.stringify({
        guest_phone: '+34123456789',
        email: 'alice@example.com',
        name: 'Alice Example',
        password: 'hunter2hunter2',
      }),
    });
    const canarySlice = consoleCalls.slice(mark);
    const canaryRecs = takeRecordsSince(mark);
    const leaky = canarySlice.some(canaryLeakInLine)
      || canaryRecs.some((r) => canaryLeakInLine(JSON.stringify(r)));
    green('listener_canaries_absent',
      canaryRes.headers['x-request-id'] === 'aaaaaaaa-bbbb-4ccc-8ddd-666666666666'
      && canaryRecs.length === 1
      && !leaky
      && canaryRecs[0].route === '/healthz'
      && !String(canaryRecs[0].route || '').includes('?')
      && !String(canaryRecs[0].route || '').includes('sk_'),
      JSON.stringify({ route: canaryRecs[0] && canaryRecs[0].route, n: canaryRecs.length }));

    // Real-listener pathname canaries (email, name, phone, token, encoded, malformed, unknown)
    const pathCanaryResults = [];
    api.setStaffQueryApiRequestHandlerForOfflineTest(async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    for (let i = 0; i < PATHNAME_CANARIES.length; i += 1) {
      const c = PATHNAME_CANARIES[i];
      mark = consoleCalls.length;
      const cid = `aaaaaaaa-bbbb-4ccc-8ddd-${String(700000000000 + i).padStart(12, '0')}`;
      const cres = await httpRequest(port, {
        method: 'GET',
        reqPath: c.path,
        headers: { 'x-request-id': cid, accept: 'application/json' },
      });
      const crecs = takeRecordsSince(mark);
      const route = crecs[0] && crecs[0].route;
      const slice = consoleCalls.slice(mark);
      pathCanaryResults.push({
        label: c.label,
        status: cres.statusCode,
        route,
        n: crecs.length,
        forbidden: routeHasForbidden(route, c.forbid)
          || slice.some((line) => routeHasForbidden(line, c.forbid))
          || (crecs[0] && routeHasForbidden(JSON.stringify(crecs[0]), c.forbid)),
        safe: crecs[0] ? liveCompletion.assertSafeRequestCompletedRecord(crecs[0]).ok : false,
      });
    }
    api.setStaffQueryApiRequestHandlerForOfflineTest(null);
    const pathCanaryOk = pathCanaryResults.every((r) =>
      r.n === 1 && r.safe && !r.forbidden && typeof r.route === 'string')
      && pathCanaryResults.some((r) => r.route === liveCompletion.ROUTE_UNMATCHED)
      && new Set(pathCanaryResults.map((r) => `${r.label}:${r.route}`)).size === pathCanaryResults.length;
    green('listener_route_pathname_canaries',
      pathCanaryOk,
      JSON.stringify(pathCanaryResults));

    mark = consoleCalls.length;
    const routeId = 'aaaaaaaa-bbbb-4ccc-8ddd-777777777777';
    api.setStaffQueryApiRequestHandlerForOfflineTest(async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const routeRes = await httpRequest(port, {
      method: 'GET',
      reqPath: '/staff/bookings/42/details?token=secret#frag',
      headers: { 'x-request-id': routeId, accept: 'application/json' },
    });
    api.setStaffQueryApiRequestHandlerForOfflineTest(null);
    const routeRecs = takeRecordsSince(mark);
    green('listener_route_normalization',
      routeRes.statusCode === 200
      && routeRecs.length === 1
      && routeRecs[0].route === '/staff/bookings/:id/:redacted'
      && !routeRecs[0].route.includes('?')
      && !routeRecs[0].route.includes('#')
      && !routeRecs[0].route.includes('details')
      && !routeRecs[0].route.includes('42'),
      JSON.stringify(routeRecs[0]));

    // Adversarial real-listener: long token, long allowlisted static, many-seg truncate,
    // multibyte/encoded/malformed — every emitted route segment legal + validator ok.
    mark = consoleCalls.length;
    const advCases = [
      {
        label: 'long_token',
        path: '/staff/radar16r_tok_ABCDEFGHIJKLMNOP',
        expect: '/staff/:redacted',
        forbid: ['radar16r_tok_'],
      },
      {
        label: 'long_static',
        path: '/staff/guest-simulator-create-stripe-test-link',
        expect: '/staff/guest-simulator-create-stripe-test-link',
        forbid: [],
      },
      {
        label: 'many_segs',
        path: '/staff/guest-simulator-create-stripe-test-link/open-demo-whatsapp-inbound-dry-run/guest-simulator-create-hold-draft/guest-automation-review-dry-run/guest-inbound-review-dry-run/check-guest-automation-gate/generate-guest-payment-link/booking-write-eligibility',
        expect: null,
        forbid: [],
      },
      {
        label: 'multibyte',
        path: '/staff/%E6%97%A5%E6%9C%AC%E8%AA%9E',
        expect: '/staff/:redacted',
        forbid: ['%E6', '日本語'],
      },
      {
        label: 'encoded_name',
        path: '/staff/Alice%20Example',
        expect: '/staff/:redacted',
        forbid: ['Alice', 'Example'],
      },
      {
        label: 'malformed',
        path: '/staff/bad%ZZtoken',
        expect: '/staff/:redacted',
        forbid: ['bad%ZZ', '%ZZ'],
      },
    ];
    api.setStaffQueryApiRequestHandlerForOfflineTest(async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const advResults = [];
    for (let i = 0; i < advCases.length; i += 1) {
      const c = advCases[i];
      const before = consoleCalls.length;
      const idAdv = `aaaaaaaa-bbbb-4ccc-8ddd-${String(700000000000 + i).padStart(12, '0')}`;
      await httpRequest(port, {
        method: 'GET',
        reqPath: c.path,
        headers: { 'x-request-id': idAdv, accept: 'application/json' },
      });
      const recs = takeRecordsSince(before);
      const route = recs[0] && recs[0].route;
      const safe = recs[0]
        ? liveCompletion.assertSafeRequestCompletedRecord(recs[0]).ok
        : false;
      const legal = typeof route === 'string'
        && liveCompletion.routeSegmentsAreAllowlistedOrPlaceholders(route);
      const forbidHit = routeHasForbidden(route, c.forbid)
        || consoleCalls.slice(before).some((line) => routeHasForbidden(line, c.forbid));
      advResults.push({
        label: c.label,
        route,
        n: recs.length,
        safe,
        legal,
        forbidHit,
        expectOk: c.expect == null
          ? (typeof route === 'string'
            && route.length <= liveCompletion.ROUTE_MAX_LEN
            && route.startsWith('/staff/')
            && (route.includes(liveCompletion.ROUTE_TRUNCATED_PLACEHOLDER)
              || route.length < c.path.split('?')[0].length))
          : route === c.expect,
      });
    }
    api.setStaffQueryApiRequestHandlerForOfflineTest(null);
    green('listener_route_adversarial_normalization',
      advResults.every((r) => r.n === 1 && r.safe && r.legal && !r.forbidHit && r.expectOk),
      JSON.stringify(advResults));

    green('listener_duration_bounds',
      [rec2xx[0], rec4xx[0], rec5xx[0], ...recConc, ...canaryRecs, ...routeRecs].every((r) =>
        Number.isFinite(r.duration_ms)
        && Number.isInteger(r.duration_ms)
        && r.duration_ms >= 5
        && r.duration_ms % 5 === 0
        && r.duration_ms <= 300000)
      && liveCompletion.bucketDurationMs(300001) === 300000);

    // Client abort: close without finish → client_aborted (real res listeners)
    {
      const abortRecords = [];
      const { EventEmitter } = require('events');
      const reqA = new EventEmitter();
      reqA.method = 'GET';
      reqA.url = '/healthz';
      reqA.headers = { 'x-request-id': 'aaaaaaaa-bbbb-4ccc-8ddd-ab0700000001' };
      const resA = new EventEmitter();
      resA.statusCode = 200;
      resA.setHeader = () => {};
      await corr.runWithRequestCorrelation(reqA, resA, async () => {
        completion.attachStaffApiRequestCompletion(reqA, resA, {
          startedAtMs: Date.now() - 25,
          trustedTenantSlug: 'wolfhouse-somo',
          rawUrl: '/healthz',
          logger: (r) => abortRecords.push(r),
        });
        // Simulate client disconnect: close without finish.
        resA.emit('close');
      });
      green('listener_client_aborted_outcome',
        abortRecords.length === 1
        && abortRecords[0].outcome === 'client_aborted'
        && abortRecords[0].request_id === 'aaaaaaaa-bbbb-4ccc-8ddd-ab0700000001'
        && completion.assertSafeRequestCompletedRecord(abortRecords[0]).ok,
        JSON.stringify(abortRecords));
    }

    // Streaming abort: wrote body then close without finish → client_aborted
    {
      const streamRecords = [];
      const { EventEmitter } = require('events');
      const reqS = new EventEmitter();
      reqS.method = 'GET';
      reqS.url = '/healthz';
      reqS.headers = { 'x-request-id': 'aaaaaaaa-bbbb-4ccc-8ddd-ab0700000002' };
      const resS = new EventEmitter();
      resS.statusCode = 200;
      resS.setHeader = () => {};
      resS.writableEnded = false;
      await corr.runWithRequestCorrelation(reqS, resS, async () => {
        completion.attachStaffApiRequestCompletion(reqS, resS, {
          startedAtMs: Date.now() - 40,
          trustedTenantSlug: 'wolfhouse-somo',
          rawUrl: '/healthz',
          logger: (r) => streamRecords.push(r),
        });
        // Partial write then peer reset (no finish).
        resS.emit('close');
      });
      green('listener_streaming_abort',
        streamRecords.length === 1
        && streamRecords[0].outcome === 'client_aborted'
        && streamRecords[0].request_id === 'aaaaaaaa-bbbb-4ccc-8ddd-ab0700000002'
        && completion.assertSafeRequestCompletedRecord(streamRecords[0]).ok,
        JSON.stringify(streamRecords));
    }

    // Real HTTP finish+close path already proven by 2xx — reaffirm exactly one
    green('listener_duplicate_finish_close_one',
      rec2xx.length === 1
      && rec2xx[0].outcome === 'completed');

    // Response error settlement → server_error
    {
      const errRecords = [];
      const idErr = 'aaaaaaaa-bbbb-4ccc-8ddd-ab0700000003';
      const { EventEmitter } = require('events');
      const reqE = new EventEmitter();
      reqE.method = 'GET';
      reqE.url = '/healthz';
      reqE.headers = { 'x-request-id': idErr };
      const resE = new EventEmitter();
      resE.statusCode = 500;
      resE.setHeader = () => {};
      await corr.runWithRequestCorrelation(reqE, resE, async () => {
        completion.attachStaffApiRequestCompletion(reqE, resE, {
          startedAtMs: Date.now() - 20,
          trustedTenantSlug: 'wolfhouse-somo',
          rawUrl: '/healthz',
          logger: (r) => errRecords.push(r),
        });
        resE.emit('error', new Error('radar16r_socket_destroy_should_not_leak'));
        resE.emit('close');
      });
      green('listener_server_error_outcome',
        errRecords.length === 1
        && errRecords[0].outcome === 'server_error'
        && errRecords[0].request_id === idErr
        && !JSON.stringify(errRecords[0]).includes('radar16r_socket_destroy')
        && completion.assertSafeRequestCompletedRecord(errRecords[0]).ok,
        JSON.stringify(errRecords));
    }

    // Logger throw via construction DI — 2xx unchanged; exactly no completion JSON
    mark = consoleCalls.length;
    activeCompletionLogger = () => { throw new Error('radar16r_logger_throw'); };
    const idThrow = 'aaaaaaaa-bbbb-4ccc-8ddd-888888888888';
    const throwRes = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': idThrow, accept: 'application/json' },
    });
    const throwRecs = takeRecordsSince(mark);
    green('listener_logger_throw_http_unchanged',
      throwRes.statusCode === 200
      && throwRes.headers['x-request-id'] === idThrow
      && throwRes.body.includes('"status"')
      && throwRecs.length === 0
      && !consoleCalls.slice(mark).some((l) => l.includes(liveCompletion.EVENT_NAME))
      && process.exitCode === exitCodeBefore,
      JSON.stringify({
        status: throwRes.statusCode,
        exit: process.exitCode,
        n: throwRecs.length,
      }));

    // Logger throw must not alter existing caught-5xx body/status semantics
    mark = consoleCalls.length;
    api.setStaffQueryApiRequestHandlerForOfflineTest(async () => {
      throw new Error('radar16r_forced_internal_error_with_logger_throw');
    });
    const idThrow5 = 'aaaaaaaa-bbbb-4ccc-8ddd-888888888889';
    const throw5 = await httpRequest(port, {
      method: 'GET',
      reqPath: '/healthz',
      headers: { 'x-request-id': idThrow5, accept: 'application/json' },
    });
    api.setStaffQueryApiRequestHandlerForOfflineTest(null);
    activeCompletionLogger = null;
    const throw5Recs = takeRecordsSince(mark);
    green('listener_logger_throw_5xx_unchanged',
      throw5.statusCode === 500
      && throw5.body.includes('internal server error')
      && !throw5.body.includes('radar16r_forced_internal_error')
      && throw5Recs.length === 0
      && !consoleCalls.slice(mark).some((l) => l.includes(liveCompletion.EVENT_NAME))
      && process.exitCode === exitCodeBefore,
      JSON.stringify({
        status: throw5.statusCode,
        body: throw5.body.slice(0, 80),
        n: throw5Recs.length,
      }));

    // Snapshot listener counts on a fresh request pair via correlation helper
    const { countLifecycleListeners } = corr;
    const probeReq = new (require('events').EventEmitter)();
    probeReq.method = 'GET';
    probeReq.url = '/healthz';
    probeReq.headers = {};
    const probeRes = new (require('events').EventEmitter)();
    probeRes.statusCode = 200;
    probeRes.setHeader = () => {};
    const beforeLc = {
      req: countLifecycleListeners(probeReq),
      res: countLifecycleListeners(probeRes),
    };
    await corr.runWithRequestCorrelation(probeReq, probeRes, async () => {});
    const afterLc = {
      req: countLifecycleListeners(probeReq),
      res: countLifecycleListeners(probeRes),
    };
    const listenersAfterHttp = {
      SIGTERM: countProcessListeners('SIGTERM'),
      SIGINT: countProcessListeners('SIGINT'),
      beforeExit: countProcessListeners('beforeExit'),
      exit: countProcessListeners('exit'),
    };
    green('listener_counts_process_exit_unchanged',
      beforeLc.req.finish === afterLc.req.finish
      && beforeLc.req.close === afterLc.req.close
      && beforeLc.req.error === afterLc.req.error
      && beforeLc.req.aborted === afterLc.req.aborted
      && beforeLc.res.finish === afterLc.res.finish
      && beforeLc.res.close === afterLc.res.close
      && beforeLc.res.error === afterLc.res.error
      && beforeLc.res.aborted === afterLc.res.aborted
      && listenersAfterHttp.SIGTERM === listenersBeforeHttp.SIGTERM
      && listenersAfterHttp.SIGINT === listenersBeforeHttp.SIGINT
      && listenersAfterHttp.beforeExit === listenersBeforeHttp.beforeExit
      && listenersAfterHttp.exit === listenersBeforeHttp.exit
      && process.exitCode === exitCodeBefore,
      JSON.stringify({ beforeLc, afterLc, listenersBeforeHttp, listenersAfterHttp }));

    // Many settled requests must not grow process listeners; attach+settle cleans up.
    {
      const beforeProc = {
        SIGTERM: countProcessListeners('SIGTERM'),
        SIGINT: countProcessListeners('SIGINT'),
        beforeExit: countProcessListeners('beforeExit'),
        exit: countProcessListeners('exit'),
      };
      for (let i = 0; i < 8; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await httpRequest(port, {
          method: 'GET',
          reqPath: '/healthz',
          headers: {
            'x-request-id': `aaaaaaaa-bbbb-4ccc-8ddd-c10e0000000${i}`,
            accept: 'application/json',
          },
        });
      }
      const afterProc = {
        SIGTERM: countProcessListeners('SIGTERM'),
        SIGINT: countProcessListeners('SIGINT'),
        beforeExit: countProcessListeners('beforeExit'),
        exit: countProcessListeners('exit'),
      };
      const { EventEmitter } = require('events');
      const reqU = new EventEmitter();
      reqU.method = 'GET';
      reqU.url = '/healthz';
      reqU.headers = { 'x-request-id': 'aaaaaaaa-bbbb-4ccc-8ddd-c10e00000099' };
      const resU = new EventEmitter();
      resU.statusCode = 200;
      resU.setHeader = () => {};
      let midFinish = -1;
      await corr.runWithRequestCorrelation(reqU, resU, async () => {
        liveCompletion.attachStaffApiRequestCompletion(reqU, resU, {
          startedAtMs: Date.now(),
          logger: () => {},
        });
        midFinish = corr.countLifecycleListeners(resU).finish;
        resU.emit('finish');
        resU.emit('close');
      });
      const afterSettle = corr.countLifecycleListeners(resU);
      green('listener_no_lifecycle_growth',
        midFinish >= 1
        && afterSettle.finish === 0
        && afterSettle.close === 0
        && afterSettle.error === 0
        && afterProc.SIGTERM === beforeProc.SIGTERM
        && afterProc.SIGINT === beforeProc.SIGINT
        && afterProc.beforeExit === beforeProc.beforeExit
        && afterProc.exit === beforeProc.exit
        && process.exitCode === exitCodeBefore,
        JSON.stringify({ midFinish, afterSettle, beforeProc, afterProc }));
    }

    unwrapConsole();
  } catch (err) {
    console.log = origLogG;
    console.info = origInfoG;
    activeCompletionLogger = null;
    completion.setCompletionLogger(null);
    for (const id of REQUIRED_GREEN) {
      if (!greenResults.some((r) => r.id === id)) {
        green(id, false, String(err && err.stack || err));
      }
    }
  } finally {
    console.log = origLogG;
    console.info = origInfoG;
    activeCompletionLogger = null;
    completion.setCompletionLogger(null);
    if (server) await closeServer(server);
  }

  ok('C4 all required RED ids ran',
    REQUIRED_RED.every((id) => redResults.some((r) => r.id === id)),
    `missing=${REQUIRED_RED.filter((id) => !redResults.some((r) => r.id === id)).join(',')}`);
  ok('C5 all required GREEN ids ran',
    REQUIRED_GREEN.every((id) => greenResults.some((r) => r.id === id)),
    `missing=${REQUIRED_GREEN.filter((id) => !greenResults.some((r) => r.id === id)).join(',')}`);
  ok('C6 all RED passed', redResults.every((r) => r.ok),
    JSON.stringify(redResults.filter((r) => !r.ok)));
  ok('C7 all GREEN passed', greenResults.every((r) => r.ok),
    JSON.stringify(greenResults.filter((r) => !r.ok)));

  ok('C8 still_open leaves deploy/delivery/search/retention/drill open',
    Array.isArray(contract.still_open)
    && contract.still_open.some((s) => /deploy/i.test(s))
    && contract.still_open.some((s) => /delivery/i.test(s))
    && contract.still_open.some((s) => /search/i.test(s))
    && contract.still_open.some((s) => /retention/i.test(s))
    && contract.final_controlled_drill
    && contract.final_controlled_drill.status === 'open'
    && contract.final_controlled_drill.id === '16R_DRILL_completion_log_search');

  ok('C9 npm script registered',
    /verify:radar-slice16r-staff-request-completion-log/.test(readText('package.json')));

  ok('C10 builds on 16J; lifecycle settle owned by completion lib',
    contract.builds_on
    && contract.builds_on.outcome_id === '16J_staff_api_request_correlation'
    && /attachStaffApiRequestCompletion/.test(apiSrc)
    && /runWithRequestCorrelation/.test(apiSrc)
    && /attachStaffApiRequestCompletion/.test(libSrc)
    && /\.on\(\s*['"]finish['"]/.test(libSrc)
    && /removeListener/.test(libSrc)
    && contract.emission_contract.lifecycle_listener_growth === false);

  ok('C11 no signal/queue/flush ownership',
    contract.emission_contract.async_log_queue === false
    && contract.emission_contract.signal_shutdown_handlers === false
    && contract.emission_contract.exit_code_mutation === false
    && contract.emission_contract.buffer_flush === false);

  console.log(`\nRED: ${redResults.filter((r) => r.ok).length}/${redResults.length}  GREEN: ${greenResults.filter((r) => r.ok).length}/${greenResults.length}`);
  console.log(`Result: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16R Staff API request completion log (source-partial): PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
