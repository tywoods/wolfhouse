'use strict';
const assert=require('node:assert/strict');
const owner=require('./lib/staff-google-oauth-production-integration');
const {createStaffEmailGoogleOAuthRoutes,SQL_RESOLVE_GOOGLE_START_BINDING}=require('./lib/staff-email-google-oauth-routes');
const fixtureFreeze=Object.freeze;
const fixtureGetOwnPropertyDescriptor=Reflect.getOwnPropertyDescriptor;
const START=owner.GOOGLE_START_PATH;
const U=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
const enabled={LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_GOOGLE_OAUTH_ENDPOINT_ENABLED:'true',LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED:'true',LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED:'true'};
function harness(overrides={}){
 const effects=[],replies=[],gates=[];let reads=0,pgCalls=0,queryCalls=0,capturedRoutes,capturedReq;
 const env=new Proxy({...enabled},{getOwnPropertyDescriptor(t,k){if(String(k).startsWith('LUNA_EMAIL_GOOGLE_'))reads++;return fixtureGetOwnPropertyDescriptor(t,k);}});
 const user={client_slug:'sunset',client_id:U[0],staff_user_id:U[2],session_id:U[3]};
 const routeDeps={sendJSON(_r,s,b){replies.push([s,b]);},sendHTML(){throw Error('not callback');},assertStaffClientAccess(){effects.push('route-acl');return true;},authorizeAuthenticatedStaffRoute(){effects.push('route-authz');return {ok:true};},withPgClient(fn){effects.push('pg');pgCalls++;return fn({query(sql,args){effects.push('query');queryCalls++;assert.equal(sql,SQL_RESOLVE_GOOGLE_START_BINDING);assert.deepEqual(args,['sunset-somo',U[1]]);return {rows:[{client_id:U[0],location_id:U[1],endpoint_id:U[1]}]};}});},createStart(){effects.push('createStart');return {start(input){effects.push('start');assert.equal(input.staffUserId,U[2]);return {authorization_url:'https://accounts.google.com/auth'};}};},createCallbackRuntime(){throw Error('not callback');}};
 const deps={env,sendJSON:routeDeps.sendJSON,sendHTML:routeDeps.sendHTML,
  async requireAdmin(){effects.push('admin');return {ok:true,user};},
  assertStaffClientAccess(){effects.push('acl');return true;},authorizeAuthenticatedStaffRoute(x){effects.push('authz');gates.push(x.env);return {ok:true};},
  async readBody(){effects.push('body');return `{"location_id":"sunset-somo","endpoint_id":"${U[1]}"}`;},
  createGoogleRoutes(gate,authorizeProductionStart){effects.push('routes');gates.push(gate);capturedRoutes=createStaffEmailGoogleOAuthRoutes(fixtureFreeze({...routeDeps,trustedGateSnapshot:gate,authorizeProductionStart}));return capturedRoutes;},
  ...overrides};
 return {adapter:owner.createStaffGoogleOAuthProductionIntegration(Object.freeze(deps)),effects,replies,gates,user,get routes(){return capturedRoutes;},get req(){return capturedReq;},set req(v){capturedReq=v;},get reads(){return reads;},get pgCalls(){return pgCalls;},get queryCalls(){return queryCalls;}};
}
async function invoke(h){const req={method:'POST',url:START,headers:{'content-type':'application/json'}};h.req=req;return h.adapter.dispatch(req,{},START);}
(async()=>{
 let h=harness();
 const weakMapOriginals={get:WeakMap.prototype.get,set:WeakMap.prototype.set,has:WeakMap.prototype.has,delete:WeakMap.prototype.delete};
 const weakMapMethods=['get','set','has','delete'];
 const intrinsicOriginals={getOwnPropertyDescriptor:Object.getOwnPropertyDescriptor,hasOwn:Object.hasOwn,freeze:Object.freeze,defineProperty:Object.defineProperty,getPrototypeOf:Object.getPrototypeOf,ownKeys:Reflect.ownKeys,apply:Reflect.apply};
 const intrinsicTargets={getOwnPropertyDescriptor:Object,hasOwn:Object,freeze:Object,defineProperty:Object,getPrototypeOf:Object,ownKeys:Reflect,apply:Reflect};
 const intrinsicNames=['getOwnPropertyDescriptor','hasOwn','freeze','defineProperty','getPrototypeOf','ownKeys','apply'];
 const poisonCalls={weakMap:{get:0,set:0,has:0,delete:0},intrinsics:{getOwnPropertyDescriptor:0,hasOwn:0,freeze:0,defineProperty:0,getPrototypeOf:0,ownKeys:0,apply:0}};
 try {
  for(const method of weakMapMethods) WeakMap.prototype[method]=function(){poisonCalls.weakMap[method]++;throw Error(`poisoned WeakMap.${method}`);};
  for(const name of intrinsicNames) intrinsicTargets[name][name]=function(){poisonCalls.intrinsics[name]++;throw Error(`poisoned ${name}`);};
  await invoke(h);
  assert.deepEqual(h.effects,['admin','acl','authz','body','routes','pg','query','createStart','start']);
  assert.equal(h.gates[0],h.gates[1]);assert.equal(h.reads,3);assert.equal(h.pgCalls,1);assert.equal(h.queryCalls,1);
  const body={location_id:'sunset-somo',endpoint_id:U[1]};
  await h.routes.handleStart(body,h.req,{},h.user); // exact replay: rejected before effects
  await h.routes.handleStart(body,{method:'POST'}, {},h.user); // mismatched request: rejected before effects
  assert.equal(h.pgCalls,1);assert.equal(h.queryCalls,1);
 } finally {
  for(const name of intrinsicNames) intrinsicTargets[name][name]=intrinsicOriginals[name];
  for(const method of weakMapMethods) WeakMap.prototype[method]=weakMapOriginals[method];
 }
 assert(Object.isFrozen(h.gates[0]));
 assert.deepEqual(poisonCalls.weakMap,{get:0,set:0,has:0,delete:0});
 assert.deepEqual(poisonCalls.intrinsics,{getOwnPropertyDescriptor:0,hasOwn:0,freeze:0,defineProperty:0,getPrototypeOf:0,ownKeys:0,apply:0});
 for(const overrides of [
  {async requireAdmin(){h.effects.push('admin');return null;}},
  {assertStaffClientAccess(){h.effects.push('acl');return false;}},
  {authorizeAuthenticatedStaffRoute(){h.effects.push('authz');return {ok:false};}},
  {async readBody(){h.effects.push('body');return '{bad';}},
 ]){h=harness(overrides);await invoke(h);assert(!h.effects.includes('routes'));assert.equal(h.pgCalls,0);}
 console.log('PASS authentic adapter-to-real-route Google OAuth start integration');
})().catch(e=>{console.error(e);process.exitCode=1;});
