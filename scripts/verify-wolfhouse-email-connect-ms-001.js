'use strict';
const assert = require('node:assert/strict');
const tenant = require('./lib/email-wolfhouse-tenant');
const disconnectOwnerSource = require('fs').readFileSync(
  require('path').join(__dirname, 'lib/email-wolfhouse-microsoft-disconnect.js'),
  'utf8',
);
const { createMicrosoftOAuthTransactionService } = require('./lib/email-microsoft-oauth-transaction-service');
const { createMicrosoftAuthorizationCodeRequestService } = require('./lib/email-microsoft-authorization-code-request');
const { createStaffEmailOAuthRoutes } = require('./lib/staff-email-oauth-routes');

const ids = Object.freeze({
  clientId: '11111111-1111-4111-8111-111111111111',
  locationId: '22222222-2222-4222-8222-222222222222',
  endpointId: '33333333-3333-4333-8333-333333333333',
  staffUserId: '44444444-4444-4444-8444-444444444444',
  authSessionId: '55555555-5555-4555-8555-555555555555',
  appId: '66666666-6666-4666-8666-666666666666',
});
const env = Object.freeze({
  LUNA_DEPLOYMENT: 'staff-staging', WOLFHOUSE_EMAIL_SETTINGS_UI_ENABLED: 'true',
  WOLFHOUSE_EMAIL_MICROSOFT_OAUTH_START_ENABLED: 'true',
  WOLFHOUSE_EMAIL_MICROSOFT_OAUTH_CALLBACK_ENABLED: 'true',
  WOLFHOUSE_EMAIL_MICROSOFT_OAUTH_GRANT_CUSTODY_ENABLED: 'true',
  WOLFHOUSE_EMAIL_MICROSOFT_OAUTH_CLIENT_ID: ids.appId,
  WOLFHOUSE_EMAIL_OAUTH_DISCONNECT_ENABLED: 'true',
});
const user = Object.freeze({ client_slug: 'wolfhouse-somo', client_id: ids.clientId,
  staff_user_id: ids.staffUserId, session_id: ids.authSessionId });
function response() { return { headers: {}, setHeader(k,v){this.headers[k]=v;}, end(body){this.body=body;} }; }
function deps(extra = {}) { return {
  runtimeEnv: env, sendJSON(res,status,body){res.statusCode=status;res.body=body;return body;},
  assertStaffClientAccess(){return true;}, authorizeAuthenticatedStaffRoute(){return {ok:true};},
  withPgClient: async (fn) => fn({query: async () => ({rows:[]})}), ...extra,
}; }

(async () => {
  assert.equal(tenant.WOLFHOUSE_MS_REDIRECT_URI,
    'https://staff-staging.lunafrontdesk.com/staff/email/microsoft/callback');
  assert.equal(tenant.isWolfhouseEmailMicrosoftOAuthStartEnabled({}), false);
  assert.equal(tenant.isWolfhouseEmailMicrosoftOAuthCallbackEnabled({}), false);
  assert.match(disconnectOwnerSource, /WOLFHOUSE_EMAIL_OAUTH_DISCONNECT_ENABLED/);
  assert.doesNotMatch(disconnectOwnerSource, /WOLFHOUSE_EMAIL_DISCONNECT_ENABLED/);
  assert.equal(tenant.isWolfhouseEmailMicrosoftOAuthStartEnabled({ ...env, LUNA_DEPLOYMENT:'sunset-staging' }), false);

  let created;
  const start = createMicrosoftOAuthTransactionService({
    repository: { async create(v){ created=v; } }, env,
    randomBytes: () => Buffer.alloc(32, 7), now: () => new Date('2026-01-01T00:00:00Z'),
  });
  const started = await start.start(Object.freeze({
    clientId: ids.clientId,
    locationId: ids.locationId,
    endpointId: ids.endpointId,
    staffUserId: ids.staffUserId,
    authSessionId: ids.authSessionId,
  }));
  const url = new URL(started.authorization_url);
  assert.equal(url.searchParams.get('client_id'), ids.appId);
  assert.equal(url.searchParams.get('redirect_uri'), tenant.WOLFHOUSE_MS_REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(created.clientId, ids.clientId);
  assert.equal(created.endpointId, ids.endpointId);
  assert.equal(created.staffUserId, ids.staffUserId);
  assert.equal(created.authSessionId, ids.authSessionId);

  let tokenBody;
  const exchange = createMicrosoftAuthorizationCodeRequestService(Object.freeze({
    deployment: 'staff-staging', applicationClientId: ids.appId,
    secretProvider: Object.freeze({ async getClientSecret(){ return 'wolfhouse-secret-123'; } }),
    responseCustody: Object.freeze({ async exchangeAndCustody({body}) { tokenBody=body; return Object.freeze({status:'custodied'}); } }),
  }));
  await exchange.exchangeAuthorizationCode(Object.freeze({ authorizationCode:'code', codeVerifier:'v'.repeat(43), clientId:ids.appId }));
  const form = new URLSearchParams(tokenBody);
  assert.equal(form.get('redirect_uri'), tenant.WOLFHOUSE_MS_REDIRECT_URI);
  assert.equal(form.get('client_id'), ids.appId);
  assert.equal(form.get('client_secret'), 'wolfhouse-secret-123');

  let callbackOwner; let callbackQuery;
  const routes = createStaffEmailOAuthRoutes(deps({
    createWolfhouseCallbackFactory({env: actualEnv}) {
      assert.equal(actualEnv.WOLFHOUSE_EMAIL_MICROSOFT_OAUTH_CLIENT_ID, ids.appId);
      assert.equal(actualEnv.LUNA_EMAIL_OAUTH_CLIENT_ID, undefined);
      return Object.freeze({ async accept(q,o){ callbackQuery=q;callbackOwner=o;return Object.freeze({status:'authorization_received'}); } });
    },
  }));
  const cbRes=response();
  await routes.handleCallback({state:'s',code:'c'}, {}, cbRes, user, true);
  assert.equal(cbRes.statusCode, 200);
  assert.deepEqual(callbackQuery,{state:'s',code:'c'});
  assert.deepEqual(callbackOwner,{clientId:ids.clientId,authSessionId:ids.authSessionId});
  const wrongRes=response();
  await routes.handleCallback({state:'s',code:'c'}, {}, wrongRes, {...user,client_slug:'sunset'}, true);
  assert.equal(wrongRes.statusCode,400);

  let revokeInput;
  const disconnectRoutes=createStaffEmailOAuthRoutes(deps({
    withPgClient: async fn => fn({ query: async () => ({rows:[]}) }),
    createWolfhouseDisconnectRuntime({env:actualEnv}) { assert.equal(actualEnv.LUNA_DEPLOYMENT,'staff-staging'); return Object.freeze({
      async runRevoke(input){revokeInput=input;return Object.freeze({status:'disconnected',grant_generation:2,grant_status:'revoked',reconcile_state:'clean'});},
    });},
  }));
  // The endpoint-removal owner sees a connected endpoint as not_applicable via its SQL row shape.
  const dRes=response();
  await disconnectRoutes.handleDisconnect({location_id:'wolfhouse-somo',endpoint_id:ids.endpointId},{},dRes,user);
  assert.equal(dRes.statusCode,200);
  assert.deepEqual(revokeInput,{clientId:ids.clientId,endpointId:ids.endpointId});
  assert.equal(dRes.body.status,'disconnected');

  console.log('PASS BUILD-WOLFHOUSE-EMAIL-CONNECT-MS-001 behavioral');
})().catch((error)=>{console.error(error);process.exitCode=1;});
