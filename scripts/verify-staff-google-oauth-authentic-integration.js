'use strict';
const assert = require('node:assert/strict');
const {
  createStaffGoogleOAuthProductionIntegration,
  GOOGLE_CALLBACK_PATH,
} = require('./lib/staff-google-oauth-production-integration');

async function main() {
  const calls = [];
  const env = Object.freeze({
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED: 'true',
  });
  const routes = Object.freeze({
    handleStart() { throw new Error('wrong owner'); },
    handleCallback(req, res) {
      calls.push(Object.freeze({ req, res, argc: arguments.length, raw: req.url }));
      return 'callback-owner-result';
    },
  });
  const adapter = createStaffGoogleOAuthProductionIntegration(Object.freeze({
    env,
    sendJSON() { throw new Error('wrong response owner'); },
    sendHTML() { throw new Error('wrong response owner'); },
    requireAdmin() { throw new Error('callback must be public'); },
    loadSession() { throw new Error('callback must not load an auth session'); },
    readBody() { throw new Error('callback must not read a body'); },
    withPgClient() { throw new Error('callback checkout belongs to route owner'); },
    assertStaffClientAccess() { throw new Error('callback must not run Staff ACL'); },
    authorizeAuthenticatedStaffRoute() { throw new Error('callback must not run Staff authz'); },
    createEndpointPrepare() { throw new Error('wrong owner'); },
    googleRoutes: routes,
  }));
  const req = Object.freeze({ method: 'GET', url: `${GOOGLE_CALLBACK_PATH}?state=${'a'.repeat(43)}&code=original%2Braw`, headers: Object.freeze({}) });
  const res = {};
  assert.equal(await adapter.dispatch(req, res, GOOGLE_CALLBACK_PATH), 'callback-owner-result');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { req, res, argc: 2, raw: req.url });
  console.log('PASS authentic Staff Google OAuth integration callback ownership');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
