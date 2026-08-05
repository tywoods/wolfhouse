'use strict';
const assert=require('assert');
const {validBody,createStaffEmailOAuthRoutes,OAUTH_START_PATH}=require('./lib/staff-email-oauth-routes');
const ids={staff_user_id:'33333333-3333-3333-3333-333333333333',session_id:'44444444-4444-4444-4444-444444444444',client_slug:'sunset'};
function res(){return {status:null,body:null};} function sendJSON(r,s,b){r.status=s;r.body=b;return b;}
(async()=>{
 assert.strictEqual(OAUTH_START_PATH,'/staff/admin/email-settings/oauth/microsoft/start');
 assert.strictEqual(validBody({location_id:'sunset-somo'}),true);
 for(const body of [{},{location_id:'x',scope:'evil'},Object.create({location_id:'x'}),[],null]) assert.strictEqual(validBody(body),false);
 let touched=false; let r=res(); let routes=createStaffEmailOAuthRoutes({runtimeEnv:{},sendJSON,assertStaffClientAccess(){touched=true;},withPgClient(){touched=true;}}); await routes.handleStart({location_id:'sunset-somo'},null,r,ids); assert.strictEqual(r.status,404);assert.strictEqual(touched,false);
 const env={LUNA_EMAIL_OAUTH_START_ENABLED:'true',LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_OAUTH_CLIENT_ID:'55555555-5555-5555-5555-555555555555'};
 r=res();routes=createStaffEmailOAuthRoutes({runtimeEnv:env,sendJSON,assertStaffClientAccess(){return true;},authorizeAuthenticatedStaffRoute(){return {ok:true};},withPgClient:fn=>fn({query:async(sql)=>sql.startsWith('SELECT')?{rows:[]}:{rows:[{}]}})});await routes.handleStart({location_id:'foreign'},null,r,ids);assert.strictEqual(r.status,404);
 let inserted; r=res();routes=createStaffEmailOAuthRoutes({runtimeEnv:env,sendJSON,assertStaffClientAccess(){return true;},authorizeAuthenticatedStaffRoute(){return {ok:true};},withPgClient:fn=>fn({query:async(sql,p)=>{if(sql.startsWith('SELECT'))return {rows:[{client_id:'11111111-1111-1111-1111-111111111111',location_id:'22222222-2222-2222-2222-222222222222'}]};inserted=p;return {rows:[{expires_at:p[8]}]};}})});await routes.handleStart({location_id:'sunset-somo'},null,r,ids);assert.strictEqual(r.status,200);assert.deepStrictEqual(Object.keys(r.body),['authorization_url','expires_at']);assert.strictEqual(inserted[2],ids.staff_user_id);assert.strictEqual(inserted[3],ids.session_id);assert.ok(!JSON.stringify(r.body).includes(inserted[5]));
 r=res();await routes.handleStart({location_id:'sunset-somo'},null,r,{...ids,client_slug:'wolfhouse'});assert.strictEqual(r.status,403);
 console.log('PASS staff email OAuth routes hostile gates');
})().catch(e=>{console.error(e);process.exit(1);});
