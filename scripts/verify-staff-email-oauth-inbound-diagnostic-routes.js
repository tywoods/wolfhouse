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
  PUBLIC_STATUS_OK,
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
    ['success', 'status', 'input_count', 'unique_count', 'duplicate_count'],
  );
  assert.deepEqual([...INBOUND_DIAGNOSTIC_BODY_KEYS], ['location_id', 'endpoint_id']);
  assert.equal(INBOUND_DIAGNOSTIC_ERROR, 'inbound_diagnostic_unavailable');
  assert.equal(ENV_INBOUND_DIAGNOSTIC_ENABLED, 'LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED');
  assert.equal(PUBLIC_STATUS_OK, 'ok');

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

  // ── Success DTO ─────────────────────────────────────────────────────────
  const good = buildInboundDiagnosticSuccessJson({
    status: 'ok',
    input_count: 3,
    unique_count: 2,
    duplicate_count: 1,
  });
  assert.deepEqual(Reflect.ownKeys(good), [...INBOUND_DIAGNOSTIC_SUCCESS_KEYS]);
  assert.equal(good.success, true);
  assert.equal(good.status, 'ok');
  assert.equal(good.input_count, 3);
  assert.equal(good.unique_count, 2);
  assert.equal(good.duplicate_count, 1);
  const goodJson = JSON.stringify(good);
  assert.equal(goodJson.includes('processed'), false);
  assert.equal(goodJson.includes('delivered'), false);
  assert.equal(goodJson.includes('subject'), false);
  assert.equal(goodJson.includes('token'), false);
  assert.equal(goodJson.includes(PLANTED_SUBJECT), false);
  assert.equal(goodJson.includes(PLANTED_TOKEN), false);
  assert.equal(goodJson.includes('grant_generation'), false);
  assert.equal(goodJson.includes('graph_stage'), false);

  assert.equal(buildInboundDiagnosticSuccessJson({
    status: 'processed',
    input_count: 1,
    unique_count: 1,
    duplicate_count: 0,
  }), null, 'internal processed status rejected on public DTO');
  assert.equal(buildInboundDiagnosticSuccessJson({
    status: 'ok',
    input_count: 6,
    unique_count: 6,
    duplicate_count: 0,
  }), null, 'max5');
  assert.equal(buildInboundDiagnosticSuccessJson({
    status: 'ok',
    input_count: 2,
    unique_count: 1,
    duplicate_count: 0,
  }), null, 'count invariant');
  // Builder reads only known fields from result object (extras on input ignored).
  // Public output keys are exact ordered only — never stage/generation/PII.
  const withExtraInput = buildInboundDiagnosticSuccessJson({
    status: 'ok',
    input_count: 1,
    unique_count: 1,
    duplicate_count: 0,
    grant_generation: 2,
    graph_stage: 'success',
    subject: PLANTED_SUBJECT,
  });
  assert.ok(withExtraInput);
  assert.deepEqual(Reflect.ownKeys(withExtraInput), [...INBOUND_DIAGNOSTIC_SUCCESS_KEYS]);
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
  assert.equal(JSON.stringify(sendFail.calls[0].body).includes('processed'), false);
  assert.equal(JSON.stringify(sendFail.calls[0].body).includes('delivered'), false);

  // ── staff-query-api wiring (admin route only; no cron/poller) ───────────
  const apiSrc = fs.readFileSync(require.resolve('./staff-query-api.js'), 'utf8');
  assert.match(apiSrc, /OAUTH_INBOUND_DIAGNOSTIC_PATH/);
  assert.match(apiSrc, /handleInboundDiagnostic/);
  assert.match(
    apiSrc,
    /pathname === OAUTH_INBOUND_DIAGNOSTIC_PATH && method === 'POST'/,
  );
  assert.equal(/cron|setInterval|poller/i.test(
    apiSrc.slice(apiSrc.indexOf('OAUTH_INBOUND_DIAGNOSTIC_PATH'), apiSrc.indexOf('OAUTH_INBOUND_DIAGNOSTIC_PATH') + 800),
  ), false);

  // Route module must not duplicate refresh/custody.
  const routesSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/lib/staff-email-oauth-routes.js'),
    'utf8',
  );
  assert.match(routesSrc, /createSunsetStagingMicrosoftDelegatedInboundDiagnosticRuntime/);
  assert.match(routesSrc, /handleInboundDiagnostic/);
  // Read-health path/flag untouched in semantics.
  assert.match(routesSrc, /LUNA_EMAIL_OAUTH_READ_HEALTH_ENABLED|isReadHealthEnabled/);
  assert.match(routesSrc, /OAUTH_READ_HEALTH_PATH = '\/staff\/admin\/email-settings\/oauth\/microsoft\/read-health'/);

  // package script
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['verify:staff-email-oauth-inbound-diagnostic-routes'],
    'node scripts/verify-staff-email-oauth-inbound-diagnostic-routes.js',
  );

  console.log('verify:staff-email-oauth-inbound-diagnostic-routes: ok');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
