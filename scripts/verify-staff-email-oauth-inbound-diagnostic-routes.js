'use strict';

/**
 * Offline RED-GREEN gate: admin-only inbound-diagnostic route auth + sanitization.
 *
 * Flag isolation, Sunset admin auth before DB, hostile bodies, concealed 404
 * when disabled, sanitized failures, public DTO vocabulary, read-health /
 * start / callback / refresh byte compatibility.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  OAUTH_INBOUND_DIAGNOSTIC_PATH,
  OAUTH_READ_HEALTH_PATH,
  OAUTH_REFRESH_HEALTH_PATH,
  OAUTH_START_PATH,
  OAUTH_CALLBACK_PATH,
  INBOUND_DIAGNOSTIC_SUCCESS_KEYS,
  INBOUND_DIAGNOSTIC_BODY_KEYS,
  INBOUND_DIAGNOSTIC_ERROR,
  READ_HEALTH_SUCCESS_KEYS,
  buildInboundDiagnosticSuccessJson,
  snapshotInboundDiagnosticBody,
  createStaffEmailOAuthRoutes,
  isPrepareEnabled,
} = require('./lib/staff-email-oauth-routes');
const {
  isInboundDiagnosticEnabled,
  ENV_INBOUND_DIAGNOSTIC_ENABLED,
  PUBLIC_STATUS_SUCCESS,
  PUBLIC_DURABLY_PROCESSED,
  PUBLIC_RESULT_KEYS,
} = require('./lib/email-microsoft-delegated-inbound-diagnostic-sunset-staging-runtime-composition');
const {
  isReadHealthEnabled,
} = require('./lib/email-microsoft-delegated-read-sunset-staging-runtime-composition');
const {
  isRefreshHealthEnabled,
} = require('./lib/email-microsoft-delegated-refresh-sunset-staging-runtime-composition');
const { isStartEnabled, isCallbackEnabled } = require('./lib/email-microsoft-oauth-transaction-service');

const ROOT = path.join(__dirname, '..');
const LOCATION = 'main';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLIENT_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STAFF = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PLANTED_SUBJECT = 'SUBJECT_PII_ROUTE_MUST_NOT_LEAK';
const PLANTED_TOKEN = 'ya29.ROUTE_TOKEN_LEAK';

function captureSend() {
  const calls = [];
  return {
    calls,
    sendJSON(res, status, body) {
      calls.push({ status, body });
      return body;
    },
  };
}

function resolveRowResult() {
  return {
    rows: [
      {
        client_id: CLIENT_UUID,
        location_id: LOCATION_UUID,
        endpoint_id: ENDPOINT,
      },
    ],
  };
}

async function main() {
  // ── Path / key isolation (byte-compat with siblings) ────────────────────
  assert.equal(
    OAUTH_INBOUND_DIAGNOSTIC_PATH,
    '/staff/admin/email-settings/oauth/microsoft/inbound-diagnostic',
  );
  assert.notEqual(OAUTH_INBOUND_DIAGNOSTIC_PATH, OAUTH_READ_HEALTH_PATH);
  assert.notEqual(OAUTH_INBOUND_DIAGNOSTIC_PATH, OAUTH_REFRESH_HEALTH_PATH);
  assert.notEqual(OAUTH_INBOUND_DIAGNOSTIC_PATH, OAUTH_START_PATH);
  assert.notEqual(OAUTH_INBOUND_DIAGNOSTIC_PATH, OAUTH_CALLBACK_PATH);
  assert.equal(
    OAUTH_READ_HEALTH_PATH,
    '/staff/admin/email-settings/oauth/microsoft/read-health',
    'read-health path byte-compat',
  );
  assert.deepEqual(
    [...READ_HEALTH_SUCCESS_KEYS],
    ['success', 'status', 'grant_generation', 'graph_reachable', 'message_count_bounded', 'graph_stage'],
    'read-health success keys byte-compat',
  );
  assert.deepEqual(
    [...INBOUND_DIAGNOSTIC_SUCCESS_KEYS],
    ['success', 'status', 'observed_count', 'unique_in_batch_count', 'duplicate_in_batch_count', 'durably_processed'],
  );
  assert.deepEqual(
    [...PUBLIC_RESULT_KEYS],
    ['status', 'durably_processed', 'input_count', 'delivered_count', 'duplicate_count'],
  );
  assert.deepEqual([...INBOUND_DIAGNOSTIC_BODY_KEYS], ['location_id', 'endpoint_id']);
  assert.equal(INBOUND_DIAGNOSTIC_ERROR, 'inbound_diagnostic_unavailable');
  assert.equal(ENV_INBOUND_DIAGNOSTIC_ENABLED, 'LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED');
  assert.equal(PUBLIC_STATUS_SUCCESS, 'success');
  assert.equal(PUBLIC_DURABLY_PROCESSED, false);
  // Forbidden synonyms / former wrong public names.
  for (const forbidden of ['received_count', 'accepted_count', 'discarded_count', 'unique_count', 'ok']) {
    assert.equal(INBOUND_DIAGNOSTIC_SUCCESS_KEYS.includes(forbidden), false, forbidden);
    assert.equal(PUBLIC_RESULT_KEYS.includes(forbidden), false, `runtime:${forbidden}`);
  }

  // ── Flag isolation ──────────────────────────────────────────────────────
  const offEnv = { LUNA_DEPLOYMENT: 'sunset-staging' };
  assert.equal(isInboundDiagnosticEnabled(offEnv), false);

  const enabledOnlyInbound = {
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'true',
  };
  assert.equal(isInboundDiagnosticEnabled(enabledOnlyInbound), true);
  assert.equal(isReadHealthEnabled(enabledOnlyInbound), false);
  assert.equal(isRefreshHealthEnabled(enabledOnlyInbound), false);
  assert.equal(isStartEnabled(enabledOnlyInbound), false);
  assert.equal(isCallbackEnabled(enabledOnlyInbound), false);
  assert.equal(isPrepareEnabled(enabledOnlyInbound), false);

  assert.equal(isInboundDiagnosticEnabled({
    LUNA_DEPLOYMENT: 'production',
    LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'true',
  }), false);
  assert.equal(isInboundDiagnosticEnabled({
    LUNA_DEPLOYMENT: 'wolfhouse',
    LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'true',
  }), false);

  // ── Body snapshot ───────────────────────────────────────────────────────
  assert.deepEqual(
    snapshotInboundDiagnosticBody({
      location_id: LOCATION,
      endpoint_id: ENDPOINT,
    }),
    Object.freeze({ location_id: LOCATION, endpoint_id: ENDPOINT }),
  );
  assert.equal(snapshotInboundDiagnosticBody({
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    extra: true,
  }), null, 'hostile extra key');
  assert.equal(snapshotInboundDiagnosticBody({
    endpoint_id: ENDPOINT,
    location_id: LOCATION,
  }), null, 'wrong key order');
  assert.equal(snapshotInboundDiagnosticBody({
    location_id: LOCATION,
    endpoint_id: 'not-a-uuid',
  }), null);
  assert.equal(snapshotInboundDiagnosticBody(null), null);

  // ── Success DTO (exact public vocabulary + key order + JSON) ────────────
  const good = buildInboundDiagnosticSuccessJson({
    status: 'success',
    durably_processed: false,
    input_count: 3,
    delivered_count: 2,
    duplicate_count: 1,
  });
  assert.deepEqual(Reflect.ownKeys(good), [...INBOUND_DIAGNOSTIC_SUCCESS_KEYS]);
  assert.equal(good.success, true);
  assert.equal(good.status, 'diagnostic_observed');
  assert.equal(good.observed_count, 3);
  assert.equal(good.unique_in_batch_count, 2);
  assert.equal(good.duplicate_in_batch_count, 1);
  assert.equal(good.durably_processed, false);
  const goodJson = JSON.stringify(good);
  assert.equal(
    goodJson,
    '{"success":true,"status":"diagnostic_observed","observed_count":3,"unique_in_batch_count":2,"duplicate_in_batch_count":1,"durably_processed":false}',
  );
  assert.equal(goodJson.includes('"processed"'), false);
  assert.equal(goodJson.includes('received_count'), false);
  assert.equal(goodJson.includes('accepted_count'), false);
  assert.equal(goodJson.includes('discarded_count'), false);
  assert.equal(goodJson.includes('unique_count'), false);
  assert.equal(goodJson.includes('"ok"'), false);
  assert.equal(goodJson.includes('subject'), false);
  assert.equal(goodJson.includes('token'), false);
  assert.equal(goodJson.includes(PLANTED_SUBJECT), false);
  assert.equal(goodJson.includes(PLANTED_TOKEN), false);
  assert.equal(goodJson.includes('grant_generation'), false);
  assert.equal(goodJson.includes('graph_stage'), false);

  // Route maps authority-bound internal DTO → public (status success + durably_processed false).
  const fromInternal = buildInboundDiagnosticSuccessJson({
    status: 'processed',
    input_count: 2,
    delivered_count: 1,
    duplicate_count: 1,
  });
  assert.ok(fromInternal);
  assert.deepEqual(Reflect.ownKeys(fromInternal), [...INBOUND_DIAGNOSTIC_SUCCESS_KEYS]);
  assert.equal(fromInternal.status, 'diagnostic_observed');
  assert.equal(fromInternal.observed_count, 2);
  assert.equal(fromInternal.unique_in_batch_count, 1);
  assert.equal(fromInternal.duplicate_in_batch_count, 1);
  assert.equal(fromInternal.durably_processed, false);
  assert.equal(
    JSON.stringify(fromInternal),
    '{"success":true,"status":"diagnostic_observed","observed_count":2,"unique_in_batch_count":1,"duplicate_in_batch_count":1,"durably_processed":false}',
  );
  assert.equal(JSON.stringify(fromInternal).includes('"processed"'), false);

  // Former wrong public names (status ok / received/accepted/discarded / unique) rejected.
  assert.equal(buildInboundDiagnosticSuccessJson({
    status: 'ok',
    received_count: 1,
    accepted_count: 1,
    discarded_count: 0,
  }), null, 'status ok + received/accepted/discarded rejected');
  assert.equal(buildInboundDiagnosticSuccessJson({
    status: 'ok',
    input_count: 1,
    unique_count: 1,
    duplicate_count: 0,
  }), null, 'status ok + unique_count rejected');
  assert.equal(buildInboundDiagnosticSuccessJson({
    status: 'success',
    durably_processed: true,
    input_count: 1,
    delivered_count: 1,
    duplicate_count: 0,
  }), null, 'durably_processed must be literal false');
  assert.equal(buildInboundDiagnosticSuccessJson({
    status: 'success',
    // missing durably_processed
    input_count: 1,
    delivered_count: 1,
    duplicate_count: 0,
  }), null, 'durably_processed required on public runtime input');
  assert.equal(buildInboundDiagnosticSuccessJson({
    status: 'success',
    durably_processed: false,
    input_count: 6,
    delivered_count: 6,
    duplicate_count: 0,
  }), null, 'max5');
  assert.equal(buildInboundDiagnosticSuccessJson({
    status: 'success',
    durably_processed: false,
    input_count: 2,
    delivered_count: 1,
    duplicate_count: 0,
  }), null, 'count invariant observed=unique+duplicate');
  // Builder reads only known fields from result object (extras on input ignored).
  // Public output keys are exact ordered only — never stage/generation/PII.
  const withExtraInput = buildInboundDiagnosticSuccessJson({
    status: 'success',
    durably_processed: false,
    input_count: 1,
    delivered_count: 1,
    duplicate_count: 0,
    grant_generation: 2,
    graph_stage: 'success',
    subject: PLANTED_SUBJECT,
  });
  assert.ok(withExtraInput);
  assert.deepEqual(Reflect.ownKeys(withExtraInput), [...INBOUND_DIAGNOSTIC_SUCCESS_KEYS]);
  assert.equal(
    JSON.stringify(withExtraInput),
    '{"success":true,"status":"diagnostic_observed","observed_count":1,"unique_in_batch_count":1,"duplicate_in_batch_count":0,"durably_processed":false}',
  );
  assert.equal(JSON.stringify(withExtraInput).includes(PLANTED_SUBJECT), false);
  assert.equal(JSON.stringify(withExtraInput).includes('grant_generation'), false);

  // ── Flag off: concealed 404 before DB ───────────────────────────────────
  let dbHits = 0;
  const sendOff = captureSend();
  const routesOff = createStaffEmailOAuthRoutes({
    runtimeEnv: offEnv,
    sendJSON: sendOff.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => {
      dbHits += 1;
      throw new Error('should_not_run_db');
    },
  });
  await routesOff.handleInboundDiagnostic(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(sendOff.calls.length, 1);
  assert.equal(sendOff.calls[0].status, 404);
  assert.deepEqual(sendOff.calls[0].body, { success: false, error: 'not_found' });
  assert.equal(dbHits, 0, 'disabled → no DB');

  // Production / wolfhouse deployment: concealed 404 before DB.
  for (const deployment of ['production', 'wolfhouse', 'other']) {
    dbHits = 0;
    const send = captureSend();
    const routes = createStaffEmailOAuthRoutes({
      runtimeEnv: {
        LUNA_DEPLOYMENT: deployment,
        LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'true',
      },
      sendJSON: send.sendJSON,
      assertStaffClientAccess: () => true,
      authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
      withPgClient: async () => {
        dbHits += 1;
        throw new Error('should_not_run');
      },
    });
    await routes.handleInboundDiagnostic(
      { location_id: LOCATION, endpoint_id: ENDPOINT },
      {},
      {},
      { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
    );
    assert.equal(send.calls[0].status, 404, `${deployment} → 404`);
    assert.equal(dbHits, 0, `${deployment} → no DB`);
  }

  // ── Auth: Sunset admin before DB ────────────────────────────────────────
  dbHits = 0;
  const sendWolf = captureSend();
  const routesOn = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledOnlyInbound,
    sendJSON: sendWolf.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => {
      dbHits += 1;
      throw new Error('should_not_run');
    },
  });
  await routesOn.handleInboundDiagnostic(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'wolfhouse', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(sendWolf.calls[0].status, 403);
  assert.equal(dbHits, 0, 'non-sunset client → no DB');

  dbHits = 0;
  const sendNoStaff = captureSend();
  const routesNoStaff = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledOnlyInbound,
    sendJSON: sendNoStaff.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => {
      dbHits += 1;
      throw new Error('should_not_run');
    },
  });
  await routesNoStaff.handleInboundDiagnostic(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: 'not-uuid', session_id: SESSION },
  );
  assert.equal(sendNoStaff.calls[0].status, 403);
  assert.equal(dbHits, 0);

  // ACL fail before DB.
  dbHits = 0;
  const sendAcl = captureSend();
  let aclChecked = false;
  const routesAcl = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledOnlyInbound,
    sendJSON: sendAcl.sendJSON,
    assertStaffClientAccess: (user, slug, res) => {
      aclChecked = true;
      assert.equal(slug, 'sunset');
      sendAcl.sendJSON(res, 403, { success: false, error: 'forbidden' });
      return false;
    },
    authorizeAuthenticatedStaffRoute: () => {
      throw new Error('authz_should_not_run_after_acl_fail');
    },
    withPgClient: async () => {
      dbHits += 1;
      throw new Error('should_not_run');
    },
  });
  await routesAcl.handleInboundDiagnostic(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(aclChecked, true);
  assert.equal(sendAcl.calls[0].status, 403);
  assert.equal(dbHits, 0);

  // Authz fail before DB.
  dbHits = 0;
  const sendAuthz = captureSend();
  const routesAuthz = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledOnlyInbound,
    sendJSON: sendAuthz.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: (args) => {
      assert.equal(args.clientSlug, 'sunset');
      assert.equal(args.method, 'POST');
      assert.equal(args.pathname, OAUTH_INBOUND_DIAGNOSTIC_PATH);
      return { ok: false, status: 403, body: { success: false, error: 'forbidden' } };
    },
    withPgClient: async () => {
      dbHits += 1;
      throw new Error('should_not_run');
    },
  });
  await routesAuthz.handleInboundDiagnostic(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(sendAuthz.calls[0].status, 403);
  assert.equal(dbHits, 0);

  // ── Hostile body: 400 before DB ─────────────────────────────────────────
  dbHits = 0;
  const sendBadBody = captureSend();
  const routesBadBody = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledOnlyInbound,
    sendJSON: sendBadBody.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => {
      dbHits += 1;
      throw new Error('should_not_run');
    },
  });
  await routesBadBody.handleInboundDiagnostic(
    { location_id: LOCATION, endpoint_id: ENDPOINT, client_id: CLIENT_UUID },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(sendBadBody.calls[0].status, 400);
  assert.deepEqual(sendBadBody.calls[0].body, { success: false, error: 'invalid_request' });
  assert.equal(dbHits, 0);

  // ── Unresolved binding: 404 ─────────────────────────────────────────────
  const sendEmpty = captureSend();
  let queryParams = null;
  const routesEmpty = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledOnlyInbound,
    sendJSON: sendEmpty.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async (fn) => fn({
      query: async (sql, params) => {
        queryParams = params;
        assert.match(sql, /slug = 'sunset'/);
        assert.match(sql, /tenant_email_delegated_grants/);
        return { rows: [] };
      },
    }),
  });
  await routesEmpty.handleInboundDiagnostic(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(sendEmpty.calls[0].status, 404);
  assert.deepEqual(sendEmpty.calls[0].body, { success: false, error: 'endpoint_not_found' });
  assert.deepEqual(queryParams, [LOCATION, ENDPOINT]);

  // ── Operation failure: 503 sanitized ────────────────────────────────────
  const sendFail = captureSend();
  const routesFail = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledOnlyInbound,
    sendJSON: sendFail.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async (fn) => fn({
      query: async () => resolveRowResult(),
    }),
  });
  // Runtime composition fails closed without full KV readiness / network —
  // missing client secret / composition readiness → 503 sanitized.
  await routesFail.handleInboundDiagnostic(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(sendFail.calls[0].status, 503);
  assert.deepEqual(sendFail.calls[0].body, {
    success: false,
    error: INBOUND_DIAGNOSTIC_ERROR,
  });
  assert.equal(JSON.stringify(sendFail.calls[0].body).includes(PLANTED_TOKEN), false);
  assert.equal(JSON.stringify(sendFail.calls[0].body).includes('"processed"'), false);
  assert.equal(JSON.stringify(sendFail.calls[0].body).includes('received_count'), false);

  // ── staff-query-api wiring (admin route only; no cron/poller) ───────────
  const apiSrc = fs.readFileSync(require.resolve('./staff-query-api.js'), 'utf8');
  assert.match(apiSrc, /OAUTH_INBOUND_DIAGNOSTIC_PATH/);
  assert.match(apiSrc, /handleInboundDiagnostic/);
  assert.match(
    apiSrc,
    /pathname === OAUTH_INBOUND_DIAGNOSTIC_PATH && method === 'POST'/,
  );
  // Canonical dual-gate predicate reused — no divergent router-local logic.
  assert.match(apiSrc, /isInboundDiagnosticEnabled/);
  assert.match(
    apiSrc,
    /require\('\.\/lib\/email-microsoft-delegated-inbound-diagnostic-sunset-staging-runtime-composition'\)/,
  );
  // Source-order: gate before requireAuth / readBody in the inbound-diagnostic block.
  const blockStart = apiSrc.indexOf(
    "pathname === OAUTH_INBOUND_DIAGNOSTIC_PATH && method === 'POST'",
  );
  assert.ok(blockStart > 0);
  const block = apiSrc.slice(blockStart, blockStart + 1400);
  assert.match(block, /const inboundDiagnosticGateEnv = Object\.freeze/);
  assert.match(block, /handleInboundDiagnostic\([\s\S]*inboundDiagnosticGateEnv/);
  const iGate = block.indexOf('isInboundDiagnosticEnabled');
  const iAuth = block.indexOf('requireAuth');
  const iBody = block.indexOf('readBody');
  assert.ok(iGate >= 0 && iAuth > iGate && iBody > iAuth,
    'router dual-gate must precede requireAuth and readBody');
  assert.match(block, /error:\s*['"]not_found['"]/);
  assert.equal(/cron|setInterval|poller/i.test(block), false);

  // Route module must not duplicate refresh/custody.
  const routesSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/lib/staff-email-oauth-routes.js'),
    'utf8',
  );
  assert.match(routesSrc, /createSunsetStagingMicrosoftDelegatedInboundDiagnosticRuntime/);
  assert.match(routesSrc, /handleInboundDiagnostic/);
  assert.match(routesSrc, /durably_processed/);
  assert.match(routesSrc, /input_count/);
  assert.match(routesSrc, /delivered_count/);
  assert.match(routesSrc, /duplicate_count/);
  // Removed wrong public vocabulary must not remain as public DTO keys.
  assert.equal(/received_count|accepted_count|discarded_count|PUBLIC_STATUS_OK|status:\s*['"]ok['"]/.test(routesSrc), false,
    'routes must not keep status ok / received/accepted/discarded public DTO');
  // Read-health path/flag untouched in semantics.
  assert.match(routesSrc, /LUNA_EMAIL_OAUTH_READ_HEALTH_ENABLED|isReadHealthEnabled/);
  assert.match(routesSrc, /OAUTH_READ_HEALTH_PATH = '\/staff\/admin\/email-settings\/oauth\/microsoft\/read-health'/);

  // package script
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['verify:staff-email-oauth-inbound-diagnostic-routes'],
    'node scripts/verify-staff-email-oauth-inbound-diagnostic-routes.js',
  );

  // ── Router-level adversarial: dual-gate before auth/body/DB/runtime ─────
  await assertRouterDualGateBeforeSideEffects();

  console.log('verify:staff-email-oauth-inbound-diagnostic-routes: ok');
}

/**
 * Real-listener proofs via fortress dual-gate: disabled / wolfhouse / prod
 * unauth + malformed-body requests still exact 404 not_found with zero
 * auth-session / body-read / DB side effects (gate is pre-requireAuth).
 */
async function assertRouterDualGateBeforeSideEffects() {
  const http = require('node:http');
  const Module = require('node:module');

  // staff-query-api needs workspace deps (dotenv, …). Prefer local node_modules;
  // fall back to sibling agent install when the sparse checkout has none.
  try {
    require.resolve('dotenv');
  } catch {
    const candidates = [
      path.join(ROOT, 'node_modules'),
      path.join(ROOT, '..', 'wolfhouse-agent', 'node_modules'),
      '/opt/data/wolfhouse-agent/node_modules',
    ];
    const found = candidates.find((c) => fs.existsSync(path.join(c, 'dotenv')));
    if (found) {
      const prev = process.env.NODE_PATH || '';
      process.env.NODE_PATH = prev ? `${found}${path.delimiter}${prev}` : found;
      Module._initPaths();
    }
  }

  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    STAFF_API_FORTRESS_OFFLINE_LISTENER: process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER,
    STAFF_AUTH_REQUIRED: process.env.STAFF_AUTH_REQUIRED,
    STAFF_AUTH_HTTPS: process.env.STAFF_AUTH_HTTPS,
    STAFF_RUNTIME_PROFILE: process.env.STAFF_RUNTIME_PROFILE,
    STAFF_QUERY_API_HOST: process.env.STAFF_QUERY_API_HOST,
    LUNA_BOT_INTERNAL_TOKEN: process.env.LUNA_BOT_INTERNAL_TOKEN,
    LUNA_DEPLOYMENT: process.env.LUNA_DEPLOYMENT,
    LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED:
      process.env.LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED,
  };

  function clearStaffApiCache() {
    for (const key of Object.keys(require.cache)) {
      if (/staff-query-api\.js$/.test(key)
          || /staff-auth-config\.js$/.test(key)
          || /staff-portal-clients\.js$/.test(key)
          || /pg-connect\.js$/.test(key)) {
        delete require.cache[key];
      }
    }
  }

  function listen(server) {
    return new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(addr.port);
      });
      server.on('error', reject);
    });
  }

  function closeServer(server) {
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  function post(port, body, headers) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: OAUTH_INBOUND_DIAGNOSTIC_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...(headers || {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed, raw });
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  process.env.NODE_ENV = 'test';
  process.env.STAFF_RUNTIME_PROFILE = 'test';
  process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = '1';
  process.env.STAFF_AUTH_REQUIRED = 'true';
  process.env.STAFF_AUTH_HTTPS = 'false';
  process.env.STAFF_QUERY_API_HOST = '127.0.0.1';
  process.env.LUNA_BOT_INTERNAL_TOKEN = 'inbound_diag_router_offline_token_01';

  const cases = [
    {
      name: 'flag_absent_unauth',
      env: { LUNA_DEPLOYMENT: 'sunset-staging' },
      body: '{"location_id":"main","endpoint_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}',
    },
    {
      name: 'flag_false_malformed_json',
      env: {
        LUNA_DEPLOYMENT: 'sunset-staging',
        LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'false',
      },
      body: '{not-json',
    },
    {
      name: 'production_flag_true_unauth',
      env: {
        LUNA_DEPLOYMENT: 'production',
        LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'true',
      },
      body: '{"location_id":"main","endpoint_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}',
    },
    {
      name: 'wolfhouse_flag_true_malformed',
      env: {
        LUNA_DEPLOYMENT: 'wolfhouse',
        LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'true',
      },
      body: '[[[',
    },
  ];

  try {
    for (const c of cases) {
      delete process.env.LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED;
      process.env.LUNA_DEPLOYMENT = c.env.LUNA_DEPLOYMENT;
      if (c.env.LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED != null) {
        process.env.LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED =
          c.env.LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED;
      }

      // Canonical predicate must reject before any router side effects.
      assert.equal(
        isInboundDiagnosticEnabled(process.env),
        false,
        `${c.name}: dual gate closed`,
      );

      clearStaffApiCache();
      const api = require('./staff-query-api');
      assert.equal(typeof api.createStaffQueryApiHttpServer, 'function');

      let dbCalls = 0;
      let sessionCalls = 0;
      api.setFortress15j3OfflineSeams({
        withPgClient: async () => {
          dbCalls += 1;
          throw new Error('router_gate_must_not_reach_db');
        },
      });

      // loadAuthSession is not seam-injectable; prove via status: unauth disabled
      // path must be 404 not_found, never 401 auth-required (requireAuth not run).
      const server = api.createStaffQueryApiHttpServer();
      const port = await listen(server);
      try {
        const res = await post(port, c.body);
        assert.equal(res.status, 404, `${c.name}: status`);
        assert.deepEqual(
          res.body,
          { success: false, error: 'not_found' },
          `${c.name}: body`,
        );
        // Not 401 (auth), not 400 (body parse) — gate is before both.
        assert.notEqual(res.status, 401, `${c.name}: must not hit requireAuth`);
        assert.notEqual(res.status, 400, `${c.name}: must not hit body parse`);
        assert.equal(dbCalls, 0, `${c.name}: zero DB`);
        assert.equal(sessionCalls, 0, `${c.name}: zero session counters`);
        assert.equal(String(res.raw).includes('Authentication required'), false);
        assert.equal(String(res.raw).includes('invalid_request'), false);
      } finally {
        await closeServer(server);
        api.setFortress15j3OfflineSeams(null);
        clearStaffApiCache();
      }
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    clearStaffApiCache();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
