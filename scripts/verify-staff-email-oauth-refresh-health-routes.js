'use strict';

/**
 * Offline gate: admin-only Microsoft refresh-health route auth + sanitization.
 */

const assert = require('node:assert/strict');
const {
  OAUTH_REFRESH_HEALTH_PATH,
  OAUTH_START_PATH,
  OAUTH_CALLBACK_PATH,
  REFRESH_HEALTH_SUCCESS_KEYS,
  buildRefreshHealthSuccessJson,
  snapshotRefreshHealthBody,
  createStaffEmailOAuthRoutes,
  isPrepareEnabled,
} = require('./lib/staff-email-oauth-routes');
const {
  isRefreshHealthEnabled,
} = require('./lib/email-microsoft-delegated-refresh-sunset-staging-runtime-composition');
const { isStartEnabled, isCallbackEnabled } = require('./lib/email-microsoft-oauth-transaction-service');

const LOCATION = 'main';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STAFF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SESSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

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

async function main() {
  assert.equal(
    OAUTH_REFRESH_HEALTH_PATH,
    '/staff/admin/email-settings/oauth/microsoft/refresh-health',
  );
  assert.notEqual(OAUTH_REFRESH_HEALTH_PATH, OAUTH_START_PATH);
  assert.notEqual(OAUTH_REFRESH_HEALTH_PATH, OAUTH_CALLBACK_PATH);

  const offEnv = { LUNA_DEPLOYMENT: 'sunset-staging' };
  assert.equal(isRefreshHealthEnabled(offEnv), false);
  assert.equal(isStartEnabled(offEnv), false);
  assert.equal(isCallbackEnabled(offEnv), false);

  const enabledOnlyRefresh = {
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_OAUTH_REFRESH_HEALTH_ENABLED: 'true',
  };
  assert.equal(isRefreshHealthEnabled(enabledOnlyRefresh), true);
  assert.equal(isStartEnabled(enabledOnlyRefresh), false, 'refresh-health must not enable start');
  assert.equal(isCallbackEnabled(enabledOnlyRefresh), false, 'refresh-health must not enable callback');
  assert.equal(isPrepareEnabled(enabledOnlyRefresh), false);

  assert.deepEqual(snapshotRefreshHealthBody({
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
  }), Object.freeze({ location_id: LOCATION, endpoint_id: ENDPOINT }));
  assert.equal(snapshotRefreshHealthBody({ endpoint_id: ENDPOINT, location_id: LOCATION }), null);
  assert.equal(snapshotRefreshHealthBody({ location_id: LOCATION, endpoint_id: ENDPOINT, x: 1 }), null);

  const good = buildRefreshHealthSuccessJson({
    status: 'healthy',
    grant_generation: 2,
    grant_status: 'active',
    reconcile_state: 'clean',
    reauthorization_required: false,
  });
  assert.deepEqual(Reflect.ownKeys(good), [...REFRESH_HEALTH_SUCCESS_KEYS]);
  assert.equal(good.success, true);
  assert.equal(JSON.stringify(good).includes('token'), false);

  const send = captureSend();
  const routes = createStaffEmailOAuthRoutes({
    runtimeEnv: offEnv,
    sendJSON: send.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => { throw new Error('should_not_run'); },
  });
  await routes.handleRefreshHealth(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].status, 404);
  assert.deepEqual(send.calls[0].body, { success: false, error: 'not_found' });

  const forbid = captureSend();
  const routesOn = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledOnlyRefresh,
    sendJSON: forbid.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => { throw new Error('should_not_run'); },
  });
  await routesOn.handleRefreshHealth(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'wolfhouse', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(forbid.calls[0].status, 403);

  const badBody = captureSend();
  const routesBadBody = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledOnlyRefresh,
    sendJSON: badBody.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => { throw new Error('should_not_run'); },
  });
  await routesBadBody.handleRefreshHealth(
    { endpoint_id: ENDPOINT, location_id: LOCATION },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(badBody.calls[0].status, 400);

  // staff-query-api wiring present (path constant + handler dispatch)
  const apiSrc = require('fs').readFileSync(require.resolve('./staff-query-api.js'), 'utf8');
  assert.match(apiSrc, /OAUTH_REFRESH_HEALTH_PATH/);
  assert.match(apiSrc, /handleRefreshHealth/);
  assert.doesNotMatch(apiSrc, /LUNA_EMAIL_OAUTH_START_ENABLED\s*=\s*'true'/);

  console.log('verify:staff-email-oauth-refresh-health-routes: ok');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
