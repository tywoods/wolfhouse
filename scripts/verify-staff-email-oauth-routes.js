'use strict';
const assert=require('assert');
const {validBody,createStaffEmailOAuthRoutes,OAUTH_START_PATH,OAUTH_CALLBACK_PATH}=require('./lib/staff-email-oauth-routes');
const ids={staff_user_id:'33333333-3333-3333-3333-333333333333',session_id:'44444444-4444-4444-4444-444444444444',client_id:'11111111-1111-1111-1111-111111111111',client_slug:'sunset'};
function res(){return {status:null,body:null};} function sendJSON(r,s,b){r.status=s;r.body=b;return b;}
(async()=>{
 assert.strictEqual(OAUTH_START_PATH,'/staff/admin/email-settings/oauth/microsoft/start');
 assert.strictEqual(OAUTH_CALLBACK_PATH,'/staff/email/oauth/microsoft/callback');
 assert.strictEqual(validBody({location_id:'sunset-somo'}),true);
 for(const body of [{},{location_id:'x',scope:'evil'},Object.create({location_id:'x'}),[],null]) assert.strictEqual(validBody(body),false);
 let touched=false; let r=res(); let routes=createStaffEmailOAuthRoutes({runtimeEnv:{},sendJSON,assertStaffClientAccess(){touched=true;},withPgClient(){touched=true;}}); await routes.handleStart({location_id:'sunset-somo'},null,r,ids); assert.strictEqual(r.status,404);assert.strictEqual(touched,false);
 const env={LUNA_EMAIL_OAUTH_START_ENABLED:'true',LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_OAUTH_CLIENT_ID:'55555555-5555-5555-5555-555555555555'};
 r=res();routes=createStaffEmailOAuthRoutes({runtimeEnv:env,sendJSON,assertStaffClientAccess(){return true;},authorizeAuthenticatedStaffRoute(){return {ok:true};},withPgClient:fn=>fn({query:async(sql)=>sql.startsWith('SELECT')?{rows:[]}:{rows:[{}]}})});await routes.handleStart({location_id:'foreign'},null,r,ids);assert.strictEqual(r.status,404);
 // Stage 6 endpoint-binding prerequisite: service start requires endpointId.
 // Routes are not yet wired to select an endpoint — enabled start fails sanitized (503).
 r=res();routes=createStaffEmailOAuthRoutes({runtimeEnv:env,sendJSON,assertStaffClientAccess(){return true;},authorizeAuthenticatedStaffRoute(){return {ok:true};},withPgClient:fn=>fn({query:async(sql)=>{if(sql.startsWith('SELECT'))return {rows:[{client_id:'11111111-1111-1111-1111-111111111111',location_id:'22222222-2222-2222-2222-222222222222'}]};return {rows:[]};}})});await routes.handleStart({location_id:'sunset-somo'},null,r,ids);assert.strictEqual(r.status,503);assert.deepStrictEqual(r.body,{success:false,error:'oauth_start_unavailable'});
 r=res();await routes.handleStart({location_id:'sunset-somo'},null,r,{...ids,client_slug:'wolfhouse'});assert.strictEqual(r.status,403);
 let consumed=0; r={headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.body=v;}}; routes=createStaffEmailOAuthRoutes({runtimeEnv:{LUNA_EMAIL_OAUTH_CALLBACK_ENABLED:'true',LUNA_DEPLOYMENT:'sunset-staging'},sendJSON,assertStaffClientAccess(){return true;},withPgClient:fn=>fn({query:async()=>{consumed++;return {rows:[{id:'tx'}]};}})}); await routes.handleCallback({state:Buffer.alloc(32,4).toString('base64url'),code:'opaque-code'},null,r,ids); assert.strictEqual(r.statusCode,200); assert.match(r.headers['Content-Type'],/^text\/html/); assert.match(r.headers['Content-Security-Policy'],/default-src 'none'/); assert.match(r.body,/Authorization response received/); assert.ok(!r.body.includes('opaque-code')); assert.strictEqual(consumed,1);
 r={headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.body=v;}}; await routes.handleCallback({state:Buffer.alloc(32,4).toString('base64url'),code:'x',extra:'evil'},null,r,ids); assert.strictEqual(r.statusCode,400); assert.match(r.body,/could not be accepted/i); assert.ok(!r.body.includes('evil'));
 console.log('PASS staff email OAuth routes hostile gates');
})().catch(e=>{console.error(e);process.exit(1);});
