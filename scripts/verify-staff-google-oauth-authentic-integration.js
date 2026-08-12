'use strict';
const assert=require('node:assert/strict');
const owner=require('./lib/staff-google-oauth-production-integration');
const {GOOGLE_ENDPOINT_PATH:ENDPOINT,GOOGLE_START_PATH:START,GOOGLE_CALLBACK_PATH:CALLBACK}=owner;
const U=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
const enabled={LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_GOOGLE_OAUTH_ENDPOINT_ENABLED:'true',LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED:'true',LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED:'true'};
function harness(overrides={}){
 const effects=[],replies=[],seen=[];let reads=0;const backing={...enabled};
 const env=new Proxy(backing,{getOwnPropertyDescriptor(t,k){if(k==='LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED'||k==='LUNA_EMAIL_GOOGLE_OAUTH_ENDPOINT_ENABLED'||k==='LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED')reads++;return Reflect.getOwnPropertyDescriptor(t,k);}});
 const deps={env,sendJSON(_r,s,b){replies.push(['json',s,b]);},sendHTML(_r,s,b){replies.push(['html',s,b]);},
  async requireAdmin(){effects.push('admin');return {ok:true,user:{client_id:U[0],staff_user_id:U[1]}};},
  assertStaffClientAccess(){effects.push('acl');return true;},authorizeAuthenticatedStaffRoute(x){effects.push('authz');seen.push(x.env);return {ok:true};},
  async readBody(){effects.push('body');return '{"location_id":"sunset-somo","endpoint_id":"'+U[1]+'"}';},
  createGoogleRoutes(g){effects.push('routes');seen.push(g);return {handleStart(){effects.push('start');},handleCallback(){effects.push('callback');}};},
  withPgClient(fn){effects.push('pg');return fn({});},createEndpointPrepare(){effects.push('prepare');return {prepareDisabledDelegatedEndpoint(){effects.push('prepare-call');return {endpointId:U[1]};}};},...overrides};
 return {adapter:owner.createStaffGoogleOAuthProductionIntegration(Object.freeze(deps)),effects,replies,seen,get reads(){return reads;}};
}
async function invoke(h,path,method='POST',headers={'content-type':'application/json'}){return h.adapter.dispatch({method,url:path,headers},{},path);}
async function main(){
 let h=harness();await invoke(h,START);assert.deepEqual(h.effects,['admin','acl','authz','body','routes','start']);assert.equal(h.seen[0],h.seen[1]);assert(Object.isFrozen(h.seen[0]));assert.equal(h.reads,3);
 h=harness({async readBody(){h.effects.push('body');return '{"location_id":"sunset-somo","public_address":"staff@example.com"}';},createGoogleRoutes(){throw Error('must never compose endpoint');}});await invoke(h,ENDPOINT);assert.deepEqual(h.effects,['admin','acl','authz','body','pg','prepare','prepare-call']);assert.equal(h.replies[0][1],200);
 for(const overrides of [
  {async requireAdmin(){h.effects.push('admin');return null;}},
  {assertStaffClientAccess(){h.effects.push('acl');return false;}},
  {authorizeAuthenticatedStaffRoute(){h.effects.push('authz');return {ok:false};}},
  {async readBody(){h.effects.push('body');return '{bad';}},
  {async readBody(){h.effects.push('body');throw Error('aborted');}},
  {async readBody(){h.effects.push('body');return 'x'.repeat(owner.JSON_LIMIT+1);}}
 ]){h=harness(overrides);await invoke(h,START);assert(!h.effects.includes('routes'),h.effects.join(','));assert(!h.effects.includes('pg'));}
 for(const [path,method] of [[START,'GET'],[ENDPOINT,'GET'],[CALLBACK,'POST']]){h=harness();assert.equal(await invoke(h,path,method),false);assert.deepEqual(h.effects,[]);}
 h=harness({createGoogleRoutes(){throw Error('secret-route-factory-value');}});await invoke(h,START);assert.deepEqual(h.replies,[['json',503,{success:false,error:'oauth_start_unavailable'}]]);assert(!JSON.stringify(h.replies).includes('secret'));
 h=harness({createGoogleRoutes(){throw Error('secret-route-factory-value');}});await invoke(h,CALLBACK,'GET',{});assert.equal(h.replies[0][0],'html');assert.equal(h.replies[0][1],400);assert(!h.replies[0][2].includes('secret'));
 h=harness({createGoogleRoutes(){throw Error('endpoint must be independent');},async readBody(){h.effects.push('body');return '{bad';}});await invoke(h,ENDPOINT);assert.deepEqual(h.effects,['admin','acl','authz','body']);assert.equal(h.replies[0][1],400);
 console.log('PASS authentic Staff Google OAuth safe effect ordering integration');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
