'use strict';

/**
 * Offline gate: admin-only Microsoft delegated read-health route auth + sanitization.
 */

const assert = require('node:assert/strict');
const {
  OAUTH_READ_HEALTH_PATH,
  OAUTH_REFRESH_HEALTH_PATH,
  OAUTH_START_PATH,
  READ_HEALTH_SUCCESS_KEYS,
  buildReadHealthSuccessJson,
  snapshotReadHealthBody,
  createStaffEmailOAuthRoutes,
  isPrepareEnabled,
} = require('./lib/staff-email-oauth-routes');
const {
  isReadHealthEnabled,
} = require('./lib/email-microsoft-delegated-read-sunset-staging-runtime-composition');
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
    OAUTH_READ_HEALTH_PATH,
    '/staff/admin/email-settings/oauth/microsoft/read-health',
  );
  assert.notEqual(OAUTH_READ_HEALTH_PATH, OAUTH_REFRESH_HEALTH_PATH);
  assert.notEqual(OAUTH_READ_HEALTH_PATH, OAUTH_START_PATH);

  const offEnv = { LUNA_DEPLOYMENT: 'sunset-staging' };
  assert.equal(isReadHealthEnabled(offEnv), false);

  const enabledOnlyRead = {
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_OAUTH_READ_HEALTH_ENABLED: 'true',
  };
  assert.equal(isReadHealthEnabled(enabledOnlyRead), true);
  assert.equal(isRefreshHealthEnabled(enabledOnlyRead), false, 'read-health must not enable refresh-health');
  assert.equal(isStartEnabled(enabledOnlyRead), false);
  assert.equal(isCallbackEnabled(enabledOnlyRead), false);
  assert.equal(isPrepareEnabled(enabledOnlyRead), false);

  assert.deepEqual(snapshotReadHealthBody({
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
  }), Object.freeze({ location_id: LOCATION, endpoint_id: ENDPOINT }));

  const good = buildReadHealthSuccessJson({
    status: 'healthy',
    grant_generation: 2,
    graph_reachable: true,
    message_count_bounded: 3,
    graph_stage: 'success',
  });
  assert.deepEqual(Reflect.ownKeys(good), [...READ_HEALTH_SUCCESS_KEYS]);
  assert.equal(good.success, true);
  assert.equal(good.graph_stage, 'success');
  assert.equal(JSON.stringify(good).includes('subject'), false);
  assert.equal(JSON.stringify(good).includes('token'), false);
  assert.equal(JSON.stringify(good).includes('address'), false);

  const uncertainDto = buildReadHealthSuccessJson({
    status: 'uncertain',
    grant_generation: 2,
    graph_reachable: false,
    message_count_bounded: null,
    graph_stage: 'json_invalid',
  });
  assert.equal(uncertainDto.graph_stage, 'json_invalid');
  assert.equal(uncertainDto.message_count_bounded, null);

  assert.equal(buildReadHealthSuccessJson({
    status: 'healthy',
    grant_generation: 2,
    graph_reachable: true,
    message_count_bounded: 6,
    graph_stage: 'success',
  }), null, 'count above hard max rejected');

  assert.equal(buildReadHealthSuccessJson({
    status: 'uncertain',
    grant_generation: 2,
    graph_reachable: false,
    message_count_bounded: null,
    graph_stage: 'planted-not-allowlisted',
  }), null, 'non-allowlisted graph_stage rejected');

  const earlyNull = buildReadHealthSuccessJson({
    status: 'unavailable',
    grant_generation: null,
    graph_reachable: false,
    message_count_bounded: null,
    graph_stage: null,
  });
  assert.equal(earlyNull.graph_stage, null);

  const send = captureSend();
  const routes = createStaffEmailOAuthRoutes({
    runtimeEnv: offEnv,
    sendJSON: send.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => { throw new Error('should_not_run'); },
  });
  await routes.handleReadHealth(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(send.calls[0].status, 404);

  const forbid = captureSend();
  const routesOn = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledOnlyRead,
    sendJSON: forbid.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => { throw new Error('should_not_run'); },
  });
  await routesOn.handleReadHealth(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'wolfhouse', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(forbid.calls[0].status, 403);

  const apiSrc = require('fs').readFileSync(require.resolve('./staff-query-api.js'), 'utf8');
  assert.match(apiSrc, /OAUTH_READ_HEALTH_PATH/);
  assert.match(apiSrc, /handleReadHealth/);

  console.log('verify:staff-email-oauth-read-health-routes: ok');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
