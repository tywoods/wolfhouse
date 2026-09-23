#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
for(const key of Object.keys(process.env))if(/^(STAFF_|LUNA_|STRIPE_|BOT_|META_|WOLFHOUSE_|SUNSET_|DATABASE_URL)/.test(key))delete process.env[key];
Object.assign(process.env,{NODE_ENV:'test',STAFF_RUNTIME_PROFILE:'test',STAFF_AUTH_REQUIRED:'true',STAFF_AUTH_HTTPS:'false',STAFF_PORTAL_ORIGIN:'https://staff-staging.lunafrontdesk.com',STAFF_QUERY_API_HOST:'127.0.0.1',STAFF_API_FORTRESS_OFFLINE_LISTENER:'1',DEFAULT_CLIENT_SLUG:'sunset',LUNA_DEPLOYMENT:'sunset-staging',SUNSET_EMAIL_SETTINGS_UI_ENABLED:'true'});
require('dotenv').config=()=>({parsed:{}});
const pg=require('./lib/pg-connect');const api=require('./staff-query-api');
let writes=0,role='admin',tenant='sunset';
pg._setPoolForTests({async connect(){return {async query(sql,args){
 if(sql.includes('FROM auth_sessions s'))return {rows:[{staff_user_id:'33333333-3333-4333-8333-333333333333',session_id:'44444444-4444-4444-8444-444444444444',client_id:'11111111-1111-4111-8111-111111111111',client_slug:tenant,email:tenant==='sunset'?'hermes-ui-verifier@lunafrontdesk.invalid':'unauthorized@example.test',role,status:'active',metadata:{}}]};
 if(sql.startsWith('UPDATE auth_sessions SET last_seen_at'))return {rows:[]};
 assert.match(sql,/UPDATE tenant_channel_endpoints/);writes++; return {rows:[{endpoint_id:args[2],mail_flow_paused:args[3]}]};
 },release(){}};}});
function request(body,cookie=true,headers={}){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:api.server.address().port,path:'/staff/admin/email-settings/pause',method:'POST',headers:{'Content-Type':'application/json',Origin:process.env.STAFF_PORTAL_ORIGIN,...(cookie?{Cookie:api.COOKIE_NAME+'=offline-pause-test'}:{}),...headers}},res=>{let raw='';res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});req.on('error',reject);req.end(JSON.stringify(body));});}
(async()=>{await new Promise(r=>api.server.listen(0,'127.0.0.1',r));try{
 const input={client:'sunset',location_id:'sunset-somo',endpoint_id:'22222222-2222-4222-8222-222222222222',paused:true};
 let res=await request(input); assert.equal(res.status,200,JSON.stringify(res));assert.equal(res.body.mail_flow_paused,true);assert.equal(writes,1);
 for(const headers of [{Origin:'https://hostile.lunafrontdesk.com'},{Origin:'null'},{Origin:''},{'Content-Type':'text/plain'}]){
  res=await request(input,true,headers);assert.ok([403,415].includes(res.status),JSON.stringify(res));assert.equal(writes,1,'CSRF or non-JSON never mutates');
 }
 res=await request(input,false);assert.ok([401,404].includes(res.status));assert.equal(writes,1);
 role='viewer';res=await request(input);assert.equal(res.status,403);assert.equal(writes,1);
 role='admin';tenant='wolfhouse-somo';res=await request(input);assert.equal(res.status,403);assert.equal(writes,1);
 process.env.LUNA_DEPLOYMENT='production';res=await request(input);assert.equal(res.status,404);assert.equal(writes,1);
 console.log('PASS ordinary HTTP route: auth cookie, staging admin mutation, unauth/viewer/cross-tenant/prod denied');
}finally{await new Promise(r=>api.server.close(r));pg._setPoolForTests(null);}})().catch(e=>{console.error(e);process.exitCode=1;});
