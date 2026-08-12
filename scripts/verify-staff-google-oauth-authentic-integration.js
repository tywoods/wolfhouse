'use strict';
const assert = require('node:assert/strict');
const { createStaffGoogleOAuthProductionIntegration, GOOGLE_START_PATH, GOOGLE_CALLBACK_PATH } = require('./lib/staff-google-oauth-production-integration');
const { createStaffEmailGoogleOAuthRoutes } = require('./lib/staff-email-google-oauth-routes');
const U=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
function response(log){return {json(_r,s,b){log.push(['json',s,b]);},html(_r,s,b){log.push(['html',s,b]);}};}
function env(values, reads){return new Proxy(values,{getOwnPropertyDescriptor(target,key){if(typeof key==='string')reads.push(key);return Reflect.getOwnPropertyDescriptor(target,key);}});}
function assertSnapshot(gate, expected, seen){
  assert.equal(Object.isFrozen(gate),true); assert.equal(Reflect.ownKeys(gate).join(','),'LUNA_DEPLOYMENT,LUNA_EMAIL_GOOGLE_OAUTH_ENDPOINT_ENABLED,LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED,LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED');
  for(const key of Reflect.ownKeys(gate)){const d=Object.getOwnPropertyDescriptor(gate,key);assert.deepEqual({enumerable:d.enumerable,writable:d.writable,configurable:d.configurable},{enumerable:true,writable:false,configurable:false});}
  assert.equal(gate[expected],'true'); if(seen.value)assert.equal(gate,seen.value);else seen.value=gate;
}
function make(values, mutate, kind){
  const reads=[], calls=[], replies=[], seen={}; const backing={...values}; const send=response(replies);
  const adapter=createStaffGoogleOAuthProductionIntegration(Object.freeze({
    env:env(backing,reads), sendJSON:send.json, sendHTML:send.html,
    async requireAdmin(){mutate(backing);return {ok:true,user:{client_slug:'sunset',client_id:U[0],staff_user_id:U[1],session_id:U[2]}};},
    readBody(){return JSON.stringify({location_id:'sunset-somo',endpoint_id:U[2]});},
    assertStaffClientAccess(){return true;}, authorizeAuthenticatedStaffRoute(x){assert.equal(x.env,seen.value);return {ok:true};},
    createEndpointPrepare(){throw Error('wrong owner');},
    createGoogleRoutes(gate){
      assertSnapshot(gate,kind==='start'?'LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED':'LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED',seen);
      mutate(backing);
      return createStaffEmailGoogleOAuthRoutes(Object.freeze({trustedGateSnapshot:gate,sendJSON:send.json,sendHTML:send.html,assertStaffClientAccess(){return true;},authorizeAuthenticatedStaffRoute(x){assert.equal(x.env,gate);return {ok:true};},withPgClient(fn){calls.push('pg');return fn({query(){return {rows:[{client_id:U[0],location_id:U[1],endpoint_id:U[2]}]};}});},createStart(){calls.push('composition:start');return {start(){calls.push('start');return {authorizationUrl:'ok'};}};},createCallbackRuntime(){calls.push('composition:callback');return {completeCallback(){calls.push('callback');return Object.freeze({status:'received'});}};}}));
    }
  })); return {adapter,reads,calls,replies,seen};
}
async function main(){
  const on={LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED:'true',LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED:'true'};
  const start=make(on,b=>{b.LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED='false';},'start');
  const req={method:'POST',url:GOOGLE_START_PATH,headers:{'content-type':'application/json'}};
  await start.adapter.dispatch(req,{},GOOGLE_START_PATH); assert.deepEqual(start.calls,['pg','composition:start','start']);
  assert.equal(start.reads.filter(x=>x==='LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED').length,1);
  const callback=make(on,b=>{b.LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED='false';},'callback'); const raw=`${GOOGLE_CALLBACK_PATH}?state=${'a'.repeat(43)}&code=raw%2Bcode`;
  await callback.adapter.dispatch({method:'GET',url:raw,headers:{}},{},GOOGLE_CALLBACK_PATH); assert.deepEqual(callback.calls,['pg','composition:callback','callback']); assert.equal(callback.reads.filter(x=>x==='LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED').length,1);
  const off=make({LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED:'false'},b=>{b.LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED='true';},'callback'); await off.adapter.dispatch({method:'GET',url:raw,headers:{}},{},GOOGLE_CALLBACK_PATH); assert.deepEqual(off.calls,[]);assert.equal(off.replies[0][1],404);
  assert.equal(await callback.adapter.dispatch({method:'POST',url:raw,headers:{}},{},GOOGLE_CALLBACK_PATH),undefined);
  console.log('PASS authentic Staff Google OAuth frozen gate snapshot integration');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
