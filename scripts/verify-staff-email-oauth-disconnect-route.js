'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  OAUTH_DISCONNECT_PATH,
  DISCONNECT_SUCCESS_KEYS,
  DISCONNECT_ERROR,
  SQL_RESOLVE_REFRESH_HEALTH_BINDING,
  SQL_RESOLVE_DISCONNECT_BINDING,
  isDisconnectEnabled,
  buildDisconnectSuccessJson,
} = require('./lib/staff-email-oauth-routes');
const { ENV_DISCONNECT_ENABLED } = require('./lib/email-disconnect');

function main() {
  assert.equal(OAUTH_DISCONNECT_PATH, '/staff/admin/email-settings/oauth/microsoft/disconnect');
  assert.equal(ENV_DISCONNECT_ENABLED, 'LUNA_EMAIL_OAUTH_DISCONNECT_ENABLED');
  assert.equal(isDisconnectEnabled({ LUNA_DEPLOYMENT: 'sunset-staging', LUNA_EMAIL_OAUTH_DISCONNECT_ENABLED: 'true' }), true);
  assert.equal(isDisconnectEnabled({ LUNA_DEPLOYMENT: 'sunset-staging' }), false);
  const json = buildDisconnectSuccessJson({
    status: 'disconnected',
    grant_generation: 1,
    grant_status: 'revoked',
    reconcile_state: 'needs_operator',
  });
  assert.deepEqual(Object.keys(json), DISCONNECT_SUCCESS_KEYS);
  assert.equal(json.success, true);
  assert.equal(DISCONNECT_ERROR, 'oauth_disconnect_unavailable');
  assert.doesNotMatch(SQL_RESOLVE_REFRESH_HEALTH_BINDING, /'revoked'/);
  assert.match(SQL_RESOLVE_DISCONNECT_BINDING, /binding_status IN \('verified', 'reauthorization_required', 'revoked'\)/);
  const routes = fs.readFileSync(path.join(__dirname, 'lib/staff-email-oauth-routes.js'), 'utf8');
  assert.match(routes, /handleDisconnect/);
  assert.match(routes, /createSunsetStagingEmailDisconnectRuntime/);
  assert.match(routes, /tryRemoveRegisteredNotConnectedEndpoint/);
  assert.match(routes, /registered-not-connected/);
  const removeSrc = fs.readFileSync(path.join(__dirname, 'lib/email-registered-endpoint-remove.js'), 'utf8');
  assert.match(removeSrc, /DELETE FROM tenant_channel_endpoints/);
  assert.match(removeSrc, /gmail_api/);
  assert.match(removeSrc, /microsoft_graph/);
  console.log('verify:staff-email-oauth-disconnect-route: ok');
}

main();
