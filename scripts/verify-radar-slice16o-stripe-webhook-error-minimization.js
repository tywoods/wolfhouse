'use strict';

/**
 * verify:radar-slice16o-stripe-webhook-error-minimization — RADAR Slice 16O
 *
 * Offline RED/GREEN gate for generic fail-closed public Stripe webhook error
 * responses (raw-body read, missing webhook secret, SDK load, signature
 * verification). Real-listener proofs use createStaffQueryApiHttpServer
 * (fortress dual-gate). No live deploy / Azure mutation / migration.
 *
 * Test canaries are intentionally neutral (no sk_test_/whsec_ scanner shapes).
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16o-stripe-webhook-error-minimization');
const pubErr = require('./lib/stripe-webhook-public-errors');

const MASTER = locks.MASTER_BASIS;
const CONTRACT_REL = 'fixtures/radar-operations/slice16o-expected-contract.json';
const LOG_FILE = path.join(ROOT, 'logs', 'staff-query-log.jsonl');

/** Neutral canaries — must not match sunset secret-scan sk_test_/whsec_ patterns. */
const CANARY = Object.freeze({
  ERR_MSG: 'CANARY_STRIPE_SDK_LOAD_EXCEPTION_DO_NOT_LEAK',
  SIG_HEADER: 't=1,v1=CANARY_SUPPLIED_SIGNATURE_DO_NOT_LEAK',
  WHSEC: 'radar16o_CANARY_WEBHOOK_SECRET_DO_NOT_LEAK',
  STRIPE_KEY: 'radar16o_CANARY_STRIPE_SECRET_PLACEHOLDER',
  BODY_MARKER: 'CANARY_EVENT_PAYLOAD_DO_NOT_LEAK',
  EXC_CLASS: 'Radar16oFakeSdkLoadError',
  BODY_READ_MSG: 'CANARY_BODY_TOO_LARGE_DO_NOT_LEAK',
});

const REQUIRED_RED = [
  'source_rejects_sdk_e_message_concat',
  'source_rejects_sig_e_message_concat',
  'source_rejects_body_read_e_message_concat',
  'source_rejects_missing_secret_env_naming',
  'source_rejects_raw_exception_audit',
  'fat_unavailable_body_rejected',
  'fat_signature_body_rejected',
  'fat_invalid_webhook_request_body_rejected',
  'raw_exception_audit_reason_rejected',
  'raw_detail_key_rejected',
];

const REQUIRED_GREEN = [
  'real_listener_missing_signature_generic_400',
  'real_listener_malformed_signature_generic_400',
  'real_listener_parser_throw_signature_generic_400',
  'real_listener_sdk_load_failure_generic_500',
  'real_listener_oversize_generic_400',
  'real_listener_body_read_rejection_generic_400',
  'real_listener_missing_secret_generic_500',
  'no_canaries_in_response_bodies',
  'zero_db_calls_on_public_error_paths',
  'no_console_canary_leak',
  'request_id_retained',
  'audit_allowlisted_reason_only',
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

function extractHandleStripeWebhook(src) {
  const start = src.indexOf('async function handleStripeWebhook');
  if (start < 0) return '';
  const next = src.indexOf('\nasync function ', start + 10);
  const end = next > 0 ? next : start + 8000;
  return src.slice(start, end);
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

function httpPost(port, reqPath, { headers = {}, body = '', timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: reqPath,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* leave null */ }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: text,
          json,
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(payload);
    req.end();
  });
}

function clearStaffApiCache() {
  for (const key of Object.keys(require.cache)) {
    if (/staff-query-api\.js$/.test(key)
      || /staff-auth-config\.js$/.test(key)
      || /staff-portal-clients\.js$/.test(key)
      || /staff-api-readiness\.js$/.test(key)
      || /staff-api-healthz\.js$/.test(key)
      || /stripe-webhook-public-errors\.js$/.test(key)
      || /pg-connect\.js$/.test(key)) {
      delete require.cache[key];
    }
  }
}

function applyMinimalStaffApiEnv(extra = {}) {
  process.env.NODE_ENV = 'test';
  process.env.STAFF_RUNTIME_PROFILE = 'test';
  process.env.STAFF_AUTH_REQUIRED = 'true';
  process.env.STAFF_AUTH_HTTPS = 'false';
  process.env.STAFF_QUERY_API_HOST = '127.0.0.1';
  process.env.LUNA_BOT_INTERNAL_TOKEN = 'radar16o_bot_token_offline_test_01';
  process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = '1';
  process.env.STRIPE_WEBHOOK_SKIP_VERIFY = 'false';
  process.env.STRIPE_WEBHOOK_SECRET = CANARY.WHSEC;
  process.env.STRIPE_SECRET_KEY = CANARY.STRIPE_KEY;
  process.env.STRIPE_WEBHOOK_CLIENT_SLUG = 'wolfhouse-somo';
  process.env.DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function createDbSpyWithPgClient() {
  const shared = { calls: 0, claims: 0, mutations: 0 };
  function withPgClient(fn) {
    shared.calls += 1;
    return fn({
      query(sql) {
        const s = String(sql || '');
        if (/INSERT\s+INTO\s+payment_events/i.test(s) || /stripe_event_id/i.test(s)) {
          shared.claims += 1;
        }
        if (/UPDATE\s+payments|UPDATE\s+bookings|INSERT\s+INTO/i.test(s)) {
          shared.mutations += 1;
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    });
  }
  return { withPgClient, shared };
}

function bodyContainsAny(bodyText, needles) {
  const text = String(bodyText || '');
  for (const n of needles) {
    if (text.includes(String(n))) return n;
  }
  return null;
}

function readAuditTail(sinceBytes) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const buf = fs.readFileSync(LOG_FILE);
    const slice = buf.slice(Math.min(sinceBytes, buf.length)).toString('utf8');
    return slice.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function auditLogSize() {
  try {
    if (!fs.existsSync(LOG_FILE)) return 0;
    return fs.statSync(LOG_FILE).size;
  } catch (_) {
    return 0;
  }
}

async function withRealStaffApiServer(seams, fn) {
  const savedKeys = [
    'NODE_ENV',
    'STAFF_RUNTIME_PROFILE',
    'STAFF_AUTH_REQUIRED',
    'STAFF_AUTH_HTTPS',
    'STAFF_QUERY_API_HOST',
    'LUNA_BOT_INTERNAL_TOKEN',
    'STAFF_API_FORTRESS_OFFLINE_LISTENER',
    'STRIPE_WEBHOOK_SKIP_VERIFY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_CLIENT_SLUG',
    'DEFAULT_CLIENT_SLUG',
    ...Object.keys((seams && seams.env) || {}),
  ];
  const saved = {};
  for (const k of savedKeys) saved[k] = process.env[k];

  applyMinimalStaffApiEnv((seams && seams.env) || {});
  clearStaffApiCache();
  const api = require('./staff-query-api');
  if (typeof api.createStaffQueryApiHttpServer !== 'function') {
    throw new Error('createStaffQueryApiHttpServer not exported — dual-gate inactive');
  }
  const offlineSeams = {};
  if (seams && typeof seams.withPgClient === 'function') {
    offlineSeams.withPgClient = seams.withPgClient;
  }
  if (seams && typeof seams.loadStripe === 'function') {
    offlineSeams.loadStripe = seams.loadStripe;
  }
  if (seams && typeof seams.forceBodyReadError === 'function') {
    offlineSeams.forceBodyReadError = seams.forceBodyReadError;
  }
  api.setFortress15j3OfflineSeams(Object.keys(offlineSeams).length ? offlineSeams : null);
  const server = api.createStaffQueryApiHttpServer({
    ingressBinding: seams && seams.ingressBinding,
  });
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

async function main() {
  console.log('verify:radar-slice16o-stripe-webhook-error-minimization — RADAR Slice 16O\n');

  const contract = readJson(CONTRACT_REL);
  const apiSrc = readText(locks.STAFF_API_REL);
  const libSrc = readText(locks.PUBLIC_ERRORS_LIB_REL);
  const stripeFn = extractHandleStripeWebhook(apiSrc);

  ok('C1 contract pinned',
    contract.master_basis === MASTER
    && contract.outcome_id === locks.OUTCOME_ID
    && contract.gate_id === locks.GATE_ID
    && contract.progress_class === locks.PROGRESS_CLASS
    && contract.live_deploy === false
    && contract.live_mutation === false
    && contract.branch === locks.BRANCH);

  ok('C2 public schemas frozen',
    contract.response_contract.sdk_unavailable.body.code === pubErr.STRIPE_WEBHOOK_UNAVAILABLE_CODE
    && contract.response_contract.sdk_unavailable.body.retryable === true
    && contract.response_contract.invalid_signature.body.code === pubErr.INVALID_STRIPE_SIGNATURE_CODE
    && contract.response_contract.invalid_signature.body.message
      === pubErr.INVALID_STRIPE_SIGNATURE_MESSAGE
    && contract.response_contract.invalid_webhook_request.body.code
      === pubErr.INVALID_WEBHOOK_REQUEST_CODE
    && JSON.stringify(pubErr.buildStripeWebhookUnavailableBody())
      === JSON.stringify(contract.response_contract.sdk_unavailable.body)
    && JSON.stringify(pubErr.buildInvalidStripeSignatureBody())
      === JSON.stringify(contract.response_contract.invalid_signature.body)
    && JSON.stringify(pubErr.buildInvalidWebhookRequestBody())
      === JSON.stringify(contract.response_contract.invalid_webhook_request.body)
    && contract.audit_contract.allowed_reasons.includes('body_read_failed')
    && contract.audit_contract.allowed_reasons.includes('webhook_secret_unavailable'));

  ok('C3 staff-query-api wires public-error helpers',
    /require\('\.\/lib\/stripe-webhook-public-errors'\)/.test(apiSrc)
    && /buildInvalidStripeSignatureBody/.test(stripeFn)
    && /buildInvalidWebhookRequestBody/.test(stripeFn)
    && /buildStripeWebhookUnavailableBody/.test(stripeFn)
    && /buildStripeWebhookPublicErrorAudit/.test(stripeFn)
    && /AUDIT_REASON_BODY_READ_FAILED|body_read_failed/.test(stripeFn)
    && /AUDIT_REASON_WEBHOOK_SECRET_UNAVAILABLE|webhook_secret_unavailable/.test(stripeFn));

  ok('C4 signature verification still before routing/DB', (() => {
    const iSig = stripeFn.indexOf('constructEvent');
    const iTenant = stripeFn.indexOf('resolveStripeWebhookExpectedClientSlug');
    const iLookup = stripeFn.indexOf('lookupPaymentForStripeSession');
    const iClaim = stripeFn.indexOf('withStripeWebhookEventClaim');
    return iSig > 0 && iTenant > iSig && iLookup > iTenant
      && (iClaim < 0 || iClaim > iLookup);
  })());

  ok('C5 STRIPE_WEBHOOK_SKIP_VERIFY remains false-default path',
    /STRIPE_WEBHOOK_SKIP_VERIFY === 'true'/.test(apiSrc)
    && !/STRIPE_WEBHOOK_SKIP_VERIFY\s*=\s*['"]true['"]/.test(apiSrc)
    && /STRIPE_WEBHOOK_SKIP_VERIFY/.test(stripeFn));

  ok('C6 still_open leaves deploy + privacy drill',
    Array.isArray(contract.still_open)
    && contract.still_open.some((s) => /live deploy/i.test(s))
    && contract.still_open.some((s) => /privacy drill/i.test(s))
    && contract.final_controlled_drill
    && contract.final_controlled_drill.status === 'open');

  ok('C7 canaries are scanner-neutral',
    !/sk_test_[A-Za-z0-9]{8,}/.test(libSrc)
    && !/whsec_[A-Za-z0-9]+/.test(String(CANARY.WHSEC))
    && !/sk_test_[A-Za-z0-9]{8,}/.test(String(CANARY.STRIPE_KEY))
    && !/whsec_[A-Za-z0-9]+/.test(readText('scripts/verify-radar-slice16o-stripe-webhook-error-minimization.js'))
    && !/sk_test_[A-Za-z0-9]{8,}/.test(readText('scripts/verify-radar-slice16o-stripe-webhook-error-minimization.js')));

  // ── Source REDs ───────────────────────────────────────────────────────────
  console.log('\n── Source anti-pattern REDs ──');

  red('source_rejects_sdk_e_message_concat',
    !/Stripe SDK load failed:\s*['"]\s*\+\s*e\.message/.test(stripeFn)
    && !/stripe_webhook_unavailable[\s\S]{0,200}e\.message/.test(stripeFn)
    && !/buildStripeWebhookUnavailableBody[\s\S]{0,120}\+\s*e\.message/.test(stripeFn)
    && !/SDK load failed:\s*['"]\s*\+\s*/.test(stripeFn));

  red('source_rejects_sig_e_message_concat',
    !/Webhook signature verification failed:\s*['"]\s*\+\s*e\.message/.test(stripeFn)
    && !/Missing stripe-signature header/.test(stripeFn)
    && !/invalid_stripe_signature[\s\S]{0,200}e\.message/.test(stripeFn)
    && !/constructEvent[\s\S]{0,220}error:\s*['"][^'"]*['"]\s*\+\s*e\.message/.test(stripeFn));

  red('source_rejects_body_read_e_message_concat',
    !/Failed to read request body:\s*['"]\s*\+\s*e\.message/.test(stripeFn)
    && !/readBodyRaw[\s\S]{0,220}error:\s*['"][^'"]*['"]\s*\+\s*[a-zA-Z_]+\.message/.test(stripeFn)
    && /buildInvalidWebhookRequestBody/.test(stripeFn)
    && /AUDIT_REASON_BODY_READ_FAILED|body_read_failed/.test(stripeFn));

  red('source_rejects_missing_secret_env_naming',
    !/STRIPE_WEBHOOK_SECRET not configured/.test(stripeFn)
    && !/Set it in env before enabling/.test(stripeFn)
    && !/sendJSON\(res,\s*503[\s\S]{0,200}STRIPE_WEBHOOK_SECRET/.test(stripeFn)
    && /AUDIT_REASON_WEBHOOK_SECRET_UNAVAILABLE|webhook_secret_unavailable/.test(stripeFn)
    && /sendJSON\(res,\s*500,\s*buildStripeWebhookUnavailableBody\(\)/.test(stripeFn));

  red('source_rejects_raw_exception_audit',
    !/appendAuditLog\([\s\S]{0,200}error:\s*e\.message/.test(stripeFn)
    && !/appendAuditLog\([\s\S]{0,200}stack:\s*/.test(stripeFn)
    && !/appendAuditLog\([\s\S]{0,200}signature:\s*sig/.test(stripeFn)
    && /AUDIT_REASON_SDK_LOAD_FAILED|sdk_load_failed/.test(stripeFn)
    && /AUDIT_REASON_SIGNATURE_VERIFICATION_FAILED|signature_verification_failed/.test(stripeFn)
    && /AUDIT_REASON_BODY_READ_FAILED|body_read_failed/.test(stripeFn)
    && /AUDIT_REASON_WEBHOOK_SECRET_UNAVAILABLE|webhook_secret_unavailable/.test(stripeFn));

  red('fat_unavailable_body_rejected', (() => {
    const r = pubErr.assertStripeWebhookUnavailableBody({
      success: false,
      code: 'stripe_webhook_unavailable',
      retryable: true,
      error: CANARY.ERR_MSG,
    });
    return r.ok === false;
  })());

  red('fat_signature_body_rejected', (() => {
    const r = pubErr.assertInvalidStripeSignatureBody({
      success: false,
      code: 'invalid_stripe_signature',
      message: 'Invalid Stripe webhook signature',
      error: 'Webhook signature verification failed: ' + CANARY.ERR_MSG,
    });
    return r.ok === false;
  })());

  red('fat_invalid_webhook_request_body_rejected', (() => {
    const r = pubErr.assertInvalidWebhookRequestBody({
      success: false,
      code: 'invalid_webhook_request',
      error: 'Failed to read request body: ' + CANARY.BODY_READ_MSG,
      detail: CANARY.BODY_READ_MSG,
    });
    return r.ok === false;
  })());

  red('raw_exception_audit_reason_rejected', (() => {
    let threw = false;
    try {
      pubErr.buildStripeWebhookPublicErrorAudit(CANARY.ERR_MSG);
    } catch (_) {
      threw = true;
    }
    return threw === true;
  })());

  red('raw_detail_key_rejected', (() => {
    const a = pubErr.assertInvalidWebhookRequestBody({
      success: false,
      code: 'invalid_webhook_request',
      detail: CANARY.BODY_READ_MSG,
    });
    const b = pubErr.assertStripeWebhookUnavailableBody({
      success: false,
      code: 'stripe_webhook_unavailable',
      retryable: true,
      details: 'STRIPE_WEBHOOK_SECRET missing',
    });
    const c = pubErr.assertInvalidStripeSignatureBody({
      success: false,
      code: 'invalid_stripe_signature',
      message: 'Invalid Stripe webhook signature',
      detail: CANARY.SIG_HEADER,
    });
    return a.ok === false && b.ok === false && c.ok === false;
  })());

  // ── GREEN real listener ───────────────────────────────────────────────────
  console.log('\n── Real-listener GREENs ──');

  const dbSpy = createDbSpyWithPgClient();
  const consoleCalls = [];
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;
  const wrapConsole = () => {
    const wrap = (orig) => (...args) => {
      consoleCalls.push(args.map((a) => String(a)).join(' '));
      return orig.apply(console, args);
    };
    console.log = wrap(origLog);
    console.info = wrap(origInfo);
    console.warn = wrap(origWarn);
    console.error = wrap(origError);
  };
  const unwrapConsole = () => {
    console.log = origLog;
    console.info = origInfo;
    console.warn = origWarn;
    console.error = origError;
  };

  const canaries = [
    CANARY.ERR_MSG,
    CANARY.SIG_HEADER,
    CANARY.WHSEC,
    CANARY.STRIPE_KEY,
    CANARY.BODY_MARKER,
    CANARY.EXC_CLASS,
    CANARY.BODY_READ_MSG,
    'Webhook signature verification failed:',
    'Stripe SDK load failed:',
    'Missing stripe-signature header',
    'Failed to read request body:',
    'body too large',
    'STRIPE_WEBHOOK_SECRET not configured',
    'Set it in env before enabling',
    'No signatures found',
    'Unable to extract timestamp',
  ];

  const auditBefore = auditLogSize();
  const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-11111111116e';
  const responseBodies = [];

  try {
    await withRealStaffApiServer({
      withPgClient: dbSpy.withPgClient,
      loadStripe: () => {
        const err = new Error(CANARY.ERR_MSG);
        err.name = CANARY.EXC_CLASS;
        err.stack = `${CANARY.EXC_CLASS}: ${CANARY.ERR_MSG}\n    at radar16o`;
        throw err;
      },
    }, async ({ port }) => {
      wrapConsole();
      const consoleBeforeSdk = consoleCalls.length;
      const sdkRes = await httpPost(port, '/staff/stripe/webhook', {
        headers: {
          'stripe-signature': CANARY.SIG_HEADER,
          'x-request-id': requestId,
        },
        body: JSON.stringify({
          id: 'evt_radar16o',
          type: 'checkout.session.completed',
          data: { object: { id: 'cs_radar16o', metadata: { canary: CANARY.BODY_MARKER } } },
        }),
      });
      unwrapConsole();
      responseBodies.push(sdkRes.body);

      const sdkAssert = pubErr.assertStripeWebhookUnavailableBody(sdkRes.json);
      green('real_listener_sdk_load_failure_generic_500',
        sdkRes.statusCode === 500
        && sdkAssert.ok === true
        && JSON.stringify(sdkRes.json)
          === JSON.stringify(contract.response_contract.sdk_unavailable.body),
        `status=${sdkRes.statusCode} body=${sdkRes.body.slice(0, 200)} assert=${sdkAssert.detail || 'ok'}`);

      green('request_id_retained',
        sdkRes.headers['x-request-id'] === requestId,
        `hdr=${sdkRes.headers['x-request-id']}`);

      void consoleCalls.slice(consoleBeforeSdk);
    });

    // Signature paths use real Stripe SDK constructEvent (no loadStripe seam).
    await withRealStaffApiServer({
      withPgClient: dbSpy.withPgClient,
    }, async ({ port }) => {
      wrapConsole();
      const consoleBefore = consoleCalls.length;

      const missing = await httpPost(port, '/staff/stripe/webhook', {
        headers: { 'x-request-id': requestId },
        body: JSON.stringify({ canary: CANARY.BODY_MARKER }),
      });
      const missingAssert = pubErr.assertInvalidStripeSignatureBody(missing.json);
      green('real_listener_missing_signature_generic_400',
        missing.statusCode === 400
        && missingAssert.ok === true
        && JSON.stringify(missing.json)
          === JSON.stringify(contract.response_contract.invalid_signature.body)
        && missing.headers['x-request-id'] === requestId,
        `status=${missing.statusCode} body=${missing.body.slice(0, 200)}`);
      responseBodies.push(missing.body);

      const malformed = await httpPost(port, '/staff/stripe/webhook', {
        headers: {
          'stripe-signature': 'not-a-valid-stripe-sig',
          'x-request-id': requestId,
        },
        body: JSON.stringify({
          id: 'evt_radar16o_malformed',
          type: 'checkout.session.completed',
          canary: CANARY.BODY_MARKER,
        }),
      });
      const malformedAssert = pubErr.assertInvalidStripeSignatureBody(malformed.json);
      green('real_listener_malformed_signature_generic_400',
        malformed.statusCode === 400
        && malformedAssert.ok === true
        && JSON.stringify(malformed.json)
          === JSON.stringify(contract.response_contract.invalid_signature.body),
        `status=${malformed.statusCode} body=${malformed.body.slice(0, 200)}`);
      responseBodies.push(malformed.body);

      // Parser-throw: stripe-signature shaped enough to enter constructEvent, which throws.
      const parserThrow = await httpPost(port, '/staff/stripe/webhook', {
        headers: {
          'stripe-signature': CANARY.SIG_HEADER,
          'x-request-id': requestId,
        },
        body: JSON.stringify({
          id: 'evt_radar16o_parser',
          type: 'checkout.session.completed',
          data: { object: { id: 'cs_test', metadata: { canary: CANARY.BODY_MARKER } } },
        }),
      });
      const parserAssert = pubErr.assertInvalidStripeSignatureBody(parserThrow.json);
      green('real_listener_parser_throw_signature_generic_400',
        parserThrow.statusCode === 400
        && parserAssert.ok === true
        && JSON.stringify(parserThrow.json)
          === JSON.stringify(contract.response_contract.invalid_signature.body),
        `status=${parserThrow.statusCode} body=${parserThrow.body.slice(0, 200)}`);
      responseBodies.push(parserThrow.body);

      void consoleBefore;
      unwrapConsole();
    });

    // Dedicated oversize listener: Content-Length header > max before any body bytes.
    await withRealStaffApiServer({
      withPgClient: dbSpy.withPgClient,
    }, async ({ port }) => {
      const oversize = await new Promise((resolve, reject) => {
        const tiny = Buffer.from(JSON.stringify({ canary: CANARY.BODY_MARKER }));
        const req = http.request({
          host: '127.0.0.1',
          port,
          path: '/staff/stripe/webhook',
          method: 'POST',
          timeout: 8000,
          headers: {
            'content-type': 'application/json',
            'content-length': String(102400 + 4096),
            'stripe-signature': CANARY.SIG_HEADER,
            'x-request-id': requestId,
          },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(text); } catch (_) { /* leave null */ }
            resolve({ statusCode: res.statusCode, headers: res.headers, body: text, json });
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        // Do not send the declared number of bytes — length check fires first.
        req.write(tiny);
        req.end();
      });
      const oversizeAssert = pubErr.assertInvalidWebhookRequestBody(oversize.json);
      green('real_listener_oversize_generic_400',
        oversize.statusCode === 400
        && oversizeAssert.ok === true
        && JSON.stringify(oversize.json)
          === JSON.stringify(contract.response_contract.invalid_webhook_request.body)
        && oversize.headers['x-request-id'] === requestId
        && !String(oversize.body).includes('body too large')
        && !String(oversize.body).includes('Failed to read'),
        `status=${oversize.statusCode} body=${String(oversize.body).slice(0, 200)} assert=${oversizeAssert.detail || 'ok'}`);
      responseBodies.push(oversize.body);
    });

    // Forced body-read rejection (stream/abort class) via offline seam — exact generic 400.
    await withRealStaffApiServer({
      withPgClient: dbSpy.withPgClient,
      forceBodyReadError: () => {
        const err = new Error(CANARY.BODY_READ_MSG);
        err.name = 'Radar16oBodyReadError';
        throw err;
      },
    }, async ({ port }) => {
      const rejected = await httpPost(port, '/staff/stripe/webhook', {
        headers: {
          'stripe-signature': CANARY.SIG_HEADER,
          'x-request-id': requestId,
        },
        body: JSON.stringify({ canary: CANARY.BODY_MARKER }),
      });
      const rejAssert = pubErr.assertInvalidWebhookRequestBody(rejected.json);
      green('real_listener_body_read_rejection_generic_400',
        rejected.statusCode === 400
        && rejAssert.ok === true
        && JSON.stringify(rejected.json)
          === JSON.stringify(contract.response_contract.invalid_webhook_request.body)
        && rejected.headers['x-request-id'] === requestId
        && !String(rejected.body).includes(CANARY.BODY_READ_MSG)
        && !String(rejected.body).includes('Failed to read'),
        `status=${rejected.statusCode} body=${String(rejected.body).slice(0, 200)}`);
      responseBodies.push(rejected.body);
    });

    // Missing webhook secret → generic retryable 500 (no env/config naming).
    await withRealStaffApiServer({
      withPgClient: dbSpy.withPgClient,
      env: { STRIPE_WEBHOOK_SECRET: undefined },
    }, async ({ port }) => {
      const missingSecret = await httpPost(port, '/staff/stripe/webhook', {
        headers: {
          'stripe-signature': CANARY.SIG_HEADER,
          'x-request-id': requestId,
        },
        body: JSON.stringify({ canary: CANARY.BODY_MARKER }),
      });
      const msAssert = pubErr.assertStripeWebhookUnavailableBody(missingSecret.json);
      green('real_listener_missing_secret_generic_500',
        missingSecret.statusCode === 500
        && msAssert.ok === true
        && JSON.stringify(missingSecret.json)
          === JSON.stringify(contract.response_contract.sdk_unavailable.body)
        && missingSecret.headers['x-request-id'] === requestId
        && !String(missingSecret.body).includes('STRIPE_WEBHOOK_SECRET')
        && !String(missingSecret.body).includes('not configured')
        && !/\benv\b/i.test(String(missingSecret.body)),
        `status=${missingSecret.statusCode} body=${missingSecret.body.slice(0, 200)}`);
      responseBodies.push(missingSecret.body);
    });

    const allBodies = responseBodies.join('\n');
    const hit = bodyContainsAny(allBodies, canaries);
    green('no_canaries_in_response_bodies', hit === null, hit ? `leaked=${hit}` : '');

    unwrapConsole();
    const consoleHit = bodyContainsAny(
      consoleCalls.join('\n'),
      [CANARY.ERR_MSG, CANARY.EXC_CLASS, CANARY.SIG_HEADER, CANARY.WHSEC, CANARY.BODY_MARKER, CANARY.BODY_READ_MSG],
    );
    green('no_console_canary_leak', consoleHit === null, consoleHit ? `leaked=${consoleHit}` : '');

    green('zero_db_calls_on_public_error_paths',
      dbSpy.shared.calls === 0
      && dbSpy.shared.claims === 0
      && dbSpy.shared.mutations === 0,
      JSON.stringify(dbSpy.shared));

    const audits = readAuditTail(auditBefore).filter((e) =>
      e && e.category === 'stripe_webhook'
      && pubErr.ALLOWED_AUDIT_REASONS.includes(e.reason));
    const neededReasons = new Set([
      'sdk_load_failed',
      'signature_verification_failed',
      'body_read_failed',
      'webhook_secret_unavailable',
    ]);
    const seenReasons = new Set(audits.map((e) => e.reason));
    const auditOk = audits.length >= 1
      && [...neededReasons].every((r) => seenReasons.has(r))
      && audits.every((e) =>
        pubErr.ALLOWED_AUDIT_REASONS.includes(e.reason)
        && e.no_db_write === true
        && !Object.prototype.hasOwnProperty.call(e, 'error')
        && !Object.prototype.hasOwnProperty.call(e, 'stack')
        && !Object.prototype.hasOwnProperty.call(e, 'signature')
        && !Object.prototype.hasOwnProperty.call(e, 'body')
        && !Object.prototype.hasOwnProperty.call(e, 'raw_body')
        && !Object.prototype.hasOwnProperty.call(e, 'detail')
        && !bodyContainsAny(JSON.stringify(e), [
          CANARY.ERR_MSG, CANARY.SIG_HEADER, CANARY.WHSEC, CANARY.BODY_MARKER,
          CANARY.EXC_CLASS, CANARY.BODY_READ_MSG, 'STRIPE_WEBHOOK_SECRET',
        ]));
    green('audit_allowlisted_reason_only', auditOk,
      `audits=${audits.length} seen=${[...seenReasons].join(',')} sample=${JSON.stringify(audits.slice(0, 3))}`);
  } catch (err) {
    for (const id of REQUIRED_GREEN) {
      if (!greenResults.some((r) => r.id === id)) {
        green(id, false, String(err && err.message));
      }
    }
  } finally {
    unwrapConsole();
  }

  ok('C8 lib forbids error/stack/detail keys on public bodies',
    pubErr.FORBIDDEN_PUBLIC_KEYS.includes('error')
    && pubErr.FORBIDDEN_PUBLIC_KEYS.includes('stack')
    && pubErr.FORBIDDEN_PUBLIC_KEYS.includes('detail')
    && pubErr.FORBIDDEN_PUBLIC_KEYS.includes('details')
    && pubErr.FORBIDDEN_PUBLIC_KEYS.includes('signature')
    && pubErr.FORBIDDEN_PUBLIC_KEYS.includes('webhook_secret')
    && pubErr.FORBIDDEN_PUBLIC_KEYS.includes('env')
    && pubErr.FORBIDDEN_PUBLIC_KEYS.includes('config'));

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: ROOT, encoding: 'utf8',
    }).trim();
    // Successor 16P/16R may own HEAD while 16O source remains frozen on master basis.
    const allowed = new Set([
      locks.BRANCH,
      'radar/slice-16p-live-drill-evidence',
      'radar/slice-16r-request-completion-log',
    ]);
    ok('C9 HEAD on 16O branch or successor 16P/16R', allowed.has(branch), branch);
  } catch (err) {
    ok('C9 HEAD on 16O branch or successor 16P/16R', false, String(err && err.message));
  }

  const redMissing = REQUIRED_RED.filter((id) => !redResults.some((r) => r.id === id && r.ok));
  const greenMissing = REQUIRED_GREEN.filter((id) => !greenResults.some((r) => r.id === id && r.ok));
  ok('R1 all required RED ids passed', redMissing.length === 0, redMissing.join(','));
  ok('G1 all required GREEN ids passed', greenMissing.length === 0, greenMissing.join(','));

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  console.log(`RED ${redResults.filter((r) => r.ok).length}/${REQUIRED_RED.length} `
    + `GREEN ${greenResults.filter((r) => r.ok).length}/${REQUIRED_GREEN.length}`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16O Stripe webhook error minimization (source-partial): PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
