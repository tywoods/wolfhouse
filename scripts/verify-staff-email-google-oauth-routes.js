'use strict';
const assert = require('node:assert/strict');
const {
  createStaffEmailGoogleOAuthRoutes, GOOGLE_OAUTH_START_PATH, GOOGLE_OAUTH_CALLBACK_PATH,
  isGoogleOAuthStartEnabled, isGoogleOAuthCallbackEnabled, SQL_RESOLVE_GOOGLE_START_BINDING,
} = require('./lib/staff-email-google-oauth-routes');
const U = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555'];
const STATE = Buffer.alloc(32, 1).toString('base64url');
const CALLBACK_ORIGIN = 'https://staff-staging.lunafrontdesk.com';
assert.equal(GOOGLE_OAUTH_START_PATH, '/staff/admin/email-settings/oauth/google/start');
assert.equal(GOOGLE_OAUTH_CALLBACK_PATH, '/staff/email/google/callback');
assert.equal(isGoogleOAuthStartEnabled({LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED:'true'}), true);
assert.equal(isGoogleOAuthStartEnabled({LUNA_DEPLOYMENT:'production',LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED:'true'}), false);
assert.equal(isGoogleOAuthCallbackEnabled({LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED:'true'}), true);
assert.match(SQL_RESOLVE_GOOGLE_START_BINDING, /c\.slug = 'sunset'/);
assert.match(SQL_RESOLVE_GOOGLE_START_BINDING, /e\.provider = 'gmail_api'/);
assert.match(SQL_RESOLVE_GOOGLE_START_BINDING, /e\.auth_mode = 'delegated_authorization_code'/);
assert.match(SQL_RESOLVE_GOOGLE_START_BINDING, /e\.connector_mode = 'google_delegated_oauth'/);
function target(query) { return `${GOOGLE_OAUTH_CALLBACK_PATH}?${query}`; }
function parsed(query, pathname = GOOGLE_OAUTH_CALLBACK_PATH) { return new URL(`${CALLBACK_ORIGIN}${pathname}?${query}`); }
(async () => {
  let effects = 0; const replies = [];
  const hidden = {runtimeEnv:{},sendJSON(_r,s,b){replies.push([s,b]);},sendHTML(_r,s,b){replies.push([s,b]);},assertStaffClientAccess(){effects++;return true;},authorizeAuthenticatedStaffRoute(){effects++;return {ok:true};},withPgClient(){effects++;},createStart(){effects++;},createCallbackRuntime(){effects++;}};
  const concealed = createStaffEmailGoogleOAuthRoutes(Object.freeze(hidden));
  assert.equal(concealed.handleCallback.length, 2,
    'callback route must expose the exact public (req, res) boundary');
  await concealed.handleStart(Object.defineProperty({},'location_id',{get(){effects++;}}),Object.defineProperty({},'method',{get(){effects++;}}),{},null);
  await concealed.handleCallback(Object.defineProperty({},'url',{get(){effects++;}}),{});
  assert.equal(effects, 0); assert.deepEqual(replies.map(x=>x[0]), [404,404]);

  const env={LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED:'true',LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED:'true'};
  const received = () => Object.freeze(Object.defineProperty({}, 'status', {value:'received', enumerable:true, writable:false, configurable:false}));
  let queryArgs; let startInput; const callbackCalls=[]; let nextOutput=received(); let runtimeClientId;
  const deps={runtimeEnv:env,sendJSON(_r,s,b){replies.push([s,b]);},sendHTML(_r,s,b){replies.push([s,b]);},assertStaffClientAccess(){return true;},authorizeAuthenticatedStaffRoute(x){assert.equal(x.clientSlug,'sunset');return {ok:true};},withPgClient(fn){return fn({query(sql,p){queryArgs=[sql,p];return {rows:[{client_id:U[0],location_id:U[1],endpoint_id:U[2]}]};}});},createStart(pg){assert.equal(typeof pg.query,'function');return {start(v){startInput=v;return {authorizationUrl:'https://accounts.google.com/auth',expiresAt:'2026-08-12T00:10:00.000Z'};}};},createCallbackRuntime(pg){assert.equal(typeof pg.query,'function');assert.equal(arguments.length,1,'runtime authority must come from consumed state');runtimeClientId='state-first';return {completeCallback(v){callbackCalls.push(v);return typeof nextOutput === 'function' ? nextOutput() : nextOutput;}};}};
  const routes=createStaffEmailGoogleOAuthRoutes(Object.freeze(deps));
  const user={client_slug:'sunset',client_id:U[0],staff_user_id:U[3],session_id:U[4]};

  await routes.handleStart(Object.freeze({location_id:'sunset-somo',endpoint_id:U[2]}),{method:'GET'}, {},user);
  assert.equal(replies.at(-1)[0],400); assert.equal(queryArgs,undefined);
  await routes.handleStart(Object.freeze({location_id:'sunset-somo',endpoint_id:U[2]}),{method:'POST'}, {},user);
  assert.deepEqual(queryArgs[1],['sunset-somo',U[2]]); assert.ok(Object.isFrozen(startInput));
  assert.deepEqual(Object.keys(startInput),['clientId','locationId','endpointId','staffUserId','authSessionId']);

  // A reconstructible authorization DTO must never confer authority, even when
  // its descriptors and gate/user references exactly match production's shape.
  // Reusing it across two requests is the reviewer-reproduced bypass.
  const forgedGate=Object.freeze({LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_GOOGLE_OAUTH_ENDPOINT_ENABLED:'true',LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED:'true',LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED:'true'});
  const forgedAuthorization=Object.freeze(Object.defineProperties({}, {
    gate:{value:forgedGate,enumerable:true,writable:false,configurable:false},
    user:{value:user,enumerable:true,writable:false,configurable:false},
  }));
  let forgedAcl=0,forgedAuthz=0,forgedPg=0,forgedStart=0;
  const forgedRoutes=createStaffEmailGoogleOAuthRoutes(Object.freeze({
    ...deps,trustedGateSnapshot:forgedGate,trustedStartAuthorization:forgedAuthorization,
    assertStaffClientAccess(){forgedAcl++;return false;},
    authorizeAuthenticatedStaffRoute(){forgedAuthz++;return {ok:false};},
    withPgClient(){forgedPg++;throw Error('forged authorization reached PG');},
    createStart(){forgedStart++;throw Error('forged authorization reached start');},
  }));
  const forgedBody=Object.freeze({location_id:'sunset-somo',endpoint_id:U[2]});
  await forgedRoutes.handleStart(forgedBody,{method:'POST'}, {},user);
  await forgedRoutes.handleStart(forgedBody,{method:'POST'}, {},user);
  assert.equal(forgedPg,0);assert.equal(forgedStart,0);
  assert.equal(forgedAcl,0);assert.equal(forgedAuthz,0);

  async function callback(query, output, options={}) {
    nextOutput=arguments.length >= 2 ? output : received(); const before=callbackCalls.length;
    const req={method:options.method || 'GET',url:options.rawTarget || `${options.pathname || GOOGLE_OAUTH_CALLBACK_PATH}?${query}`};
    await routes.handleCallback(req,{});
    return {reply:replies.at(-1), called:callbackCalls.length-before};
  }
  for (const query of [
    `state=${STATE}&code=provider-code`,
    `code=provider-code&state=${STATE}`,
    `scope=openid%20email&authuser=0&prompt=consent&code=provider-code&state=${STATE}`,
    `state=${STATE}&iss=https%3A%2F%2Faccounts.google.com&code=provider-code&scope=openid%20email&authuser=0&prompt=consent`,
  ]) {
    const result=await callback(query);
    assert.equal(result.reply[0],200); assert.equal(result.called,1);
    const input=callbackCalls.at(-1);
    assert.ok(Object.isFrozen(input));
    assert.deepEqual(Object.keys(input),['query']);
    assert.deepEqual(input,{query:`state=${STATE}&code=provider-code`});
    assert.equal(runtimeClientId,'state-first');
    assert.doesNotMatch(result.reply[1],/provider-code|state|token|secret/i);
  }
  for (const query of [`state=${STATE}&error=access_denied`,`error=access_denied&state=${STATE}`]) {
    const result=await callback(query,Object.freeze({status:'declined'}));
    assert.equal(result.called,1); assert.notEqual(result.reply[0],200);
    assert.equal(callbackCalls.at(-1).query,`state=${STATE}&error=access_denied`);
    assert.doesNotMatch(result.reply[1],/access_denied|state|code|token|secret/i);
  }
  for (const status of ['declined','invalid','replayed','connected','mystery']) {
    const result=await callback(`state=${STATE}&code=provider-code`,Object.freeze({status}));
    const want=400;
    assert.equal(result.reply[0],want); assert.doesNotMatch(result.reply[1],/provider-code|state|token|secret/i);
  }
  let observations=0;
  const inherited=Object.create({status:'received'}); Object.freeze(inherited);
  const accessor={}; Object.defineProperty(accessor,'status',{enumerable:true,configurable:false,get(){observations++;return 'received';}}); Object.freeze(accessor);
  const symbolBearing={}; Object.defineProperties(symbolBearing,{status:{value:'received',enumerable:true},[Symbol('private')]:{value:true}}); Object.freeze(symbolBearing);
  const reordered={private:true,status:'received'}; Object.freeze(reordered);
  const custom=Object.create(Object.freeze({})); Object.defineProperty(custom,'status',{value:'received',enumerable:true}); Object.freeze(custom);
  const functionOutput=Object.freeze(Object.defineProperty(function(){},'status',{value:'received',enumerable:true}));
  const transparent=new Proxy(received(),{});
  const trapping=new Proxy(received(),{getPrototypeOf(){observations++;throw Error('prototype trap');},ownKeys(){observations++;throw Error('keys trap');},getOwnPropertyDescriptor(){observations++;throw Error('descriptor trap');},isExtensible(){observations++;throw Error('extensible trap');}});
  const invalidOutputs=[null,undefined,{status:'received'},Object.freeze({status:'received',private:true}),inherited,accessor,symbolBearing,reordered,[],functionOutput,custom,transparent,trapping];
  observations=0;
  for (const output of invalidOutputs) {
    const result=await callback(`state=${STATE}&code=provider-code`,output);
    assert.equal(result.reply[0],400); assert.doesNotMatch(result.reply[1],/provider-code|state|token|secret/i);
  }
  assert.equal(observations,0,'callback output validation must execute no getters or proxy traps');
  const authenticObject = global.Object;
  let replacedObjectResult;
  try {
    nextOutput = () => {
      function ReplacementObject() {}
      ReplacementObject.prototype = Object.freeze({ hostile: 'replacement-prototype' });
      ReplacementObject.hasOwn = authenticObject.hasOwn;
      global.Object = ReplacementObject;
      const forged = authenticObject.create(ReplacementObject.prototype);
      authenticObject.defineProperty(forged, 'status', {value:'received', enumerable:true, writable:false, configurable:false});
      return authenticObject.freeze(forged);
    };
    replacedObjectResult = await callback(`state=${STATE}&code=provider-code`, nextOutput);
  } finally {
    global.Object = authenticObject;
  }
  assert.equal(global.Object, authenticObject, 'global.Object must be restored after hostile callback probe');
  assert.equal(replacedObjectResult.reply[0], 400);
  assert.doesNotMatch(replacedObjectResult.reply[1], /provider-code|state|token|secret|replacement-prototype/i);
  let hasOwnGetterHits = 0;
  const replacementCases = [
    { label: 'throwing getter', get hasOwn() { hasOwnGetterHits += 1; throw Error('hostile hasOwn getter'); } },
    { label: 'always false', hasOwn() { return false; } },
    { label: 'always true', hasOwn() { return true; } },
  ];
  for (const replacement of replacementCases) {
    let authenticResult; let hostileResult;
    try {
      nextOutput = () => {
        const authentic = authenticObject.freeze(authenticObject.defineProperty({}, 'status',
          {value:'received', enumerable:true, writable:false, configurable:false}));
        global.Object = replacement;
        return authentic;
      };
      authenticResult = await callback(`state=${STATE}&code=provider-code`, nextOutput);
      global.Object = authenticObject;
      nextOutput = () => {
        global.Object = replacement;
        const hostile = {};
        authenticObject.defineProperty(hostile, 'status', {enumerable:true, configurable:false, get(){throw Error('hostile status getter');}});
        return authenticObject.freeze(hostile);
      };
      hostileResult = await callback(`state=${STATE}&code=provider-code`, nextOutput);
    } finally {
      global.Object = authenticObject;
    }
    assert.equal(authenticResult.reply[0], 200, `${replacement.label} cannot reject an authentic result`);
    assert.equal(hostileResult.reply[0], 400, `${replacement.label} cannot accept a hostile result`);
  }
  assert.equal(hasOwnGetterHits, 0, 'callback result validation must never read replacement Object.hasOwn');
  for (const [query,options] of [
    [`state=${STATE}&code=x&code=y`,{}], [`state=${STATE}&code=x&unknown=y`,{}],
    [`state=${STATE}&iss=https%3A%2F%2Fevil.example&code=x`,{}],
    [`state=${STATE}&iss=%ZZ&code=x`,{}],
    [`state=${STATE}&iss=https%3A%2F%2Faccounts.google.com&iss=https%3A%2F%2Faccounts.google.com&code=x`,{}],
    [`state=${STATE}&iss&code=x`,{}], [`state=${STATE}&iss=&code=x`,{}],
    [`state=${STATE}&iss=https%3A%2F%2Faccounts.google.com&error=access_denied`,{}],
    [`state=${STATE}&error=access_denied&error_description=LEAK`,{}], [`state=${STATE}&code=x&error=access_denied`,{}],
    [`state=${STATE}&code=x&scope=%ZZ`,{}], [`state=${STATE}&code=x`,{method:'POST'}],
    [`state=${STATE}&code=x`,{pathname:'/staff/email/google/callback/'}],
    [`state=${STATE}&code=x`,{rawTarget:`/staff/email/google/%63allback?state=${STATE}&code=x`}],
    [`state=${STATE}&code=x`,{rawTarget:`${target(`state=${STATE}&code=x`)}#fragment`}],
    [`state=${STATE}&code=x`,{rawTarget:`https://evil.example${target(`state=${STATE}&code=x`)}`}],
  ]) {
    const result=await callback(query,received(),options);
    assert.equal(result.called,0); assert.equal(result.reply[0],400); assert.doesNotMatch(result.reply[1],/LEAK|access_denied|provider-code|state|token|secret/i);
  }
  console.log('staff email Google OAuth routes verifier: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
