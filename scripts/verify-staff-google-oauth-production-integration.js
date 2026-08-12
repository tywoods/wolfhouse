'use strict';
const assert = require('node:assert/strict');

// Behavioral integration owner: intentionally absent for the RED commit.
const owner = require('./lib/staff-google-oauth-production-integration');

assert.equal(owner.GOOGLE_ENDPOINT_PATH, '/staff/admin/email-settings/oauth/google/endpoint');
assert.equal(owner.GOOGLE_START_PATH, '/staff/admin/email-settings/oauth/google/start');
assert.equal(owner.GOOGLE_CALLBACK_PATH, '/staff/email/google/callback');
assert.equal(owner.isGoogleRouteEnabled(Object.freeze({}),'endpoint'), false);
assert.equal(owner.isGoogleRouteEnabled(Object.freeze({LUNA_DEPLOYMENT:'production',LUNA_EMAIL_GOOGLE_OAUTH_ENDPOINT_ENABLED:'true'}),'endpoint'), false);
assert.equal(owner.isGoogleRouteEnabled(Object.freeze({LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_GOOGLE_OAUTH_ENDPOINT_ENABLED:'true'}),'endpoint'), true);

const valid = owner.parseStrictGoogleJson('application/json', '{"location_id":"sunset-somo","public_address":"staff@example.com"}', ['location_id','public_address']);
assert(Object.isFrozen(valid));
assert.deepEqual(Reflect.ownKeys(valid), ['location_id','public_address']);
for (const [type, raw] of [
  ['text/plain','{"location_id":"sunset-somo","public_address":"staff@example.com"}'],
  ['application/json','{"location_id":"sunset-somo","location_id":"sunset-somo","public_address":"staff@example.com"}'],
  ['application/json','{"location_id":"sunset-somo","public_address":"staff@example.com","extra":true}'],
  ['application/json','{"location_id":"sunset-somo",}'],
]) assert.equal(owner.parseStrictGoogleJson(type, raw, ['location_id','public_address']), null);

async function main() {
let effects = 0; const replies=[];
const adapter = owner.createStaffGoogleOAuthProductionIntegration(Object.freeze({
  env:Object.freeze({}), sendJSON(_r,s,b){replies.push([s,b]);}, sendHTML(_r,s,b){replies.push([s,b]);},
  requireAdmin(){effects++;}, loadSession(){effects++;}, withPgClient(){effects++;},
  assertStaffClientAccess(){effects++;}, authorizeAuthenticatedStaffRoute(){effects++;},
  createEndpointPrepare(){effects++;}, createStart(){effects++;}, createCallbackRuntime(){effects++;}, readBody(){effects++;},
}));
await adapter.dispatch({method:'POST',url:owner.GOOGLE_ENDPOINT_PATH,headers:{}}, {}, owner.GOOGLE_ENDPOINT_PATH);
assert.deepEqual(replies, [[404,{success:false,error:'not_found'}]]);
assert.equal(effects,0,'concealment must precede auth/body/DB/runtime');
console.log('staff Google OAuth production integration verifier: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
