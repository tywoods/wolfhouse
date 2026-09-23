'use strict';
// Actual broadcast helper + SQL; only credential/token/provider boundaries are fake.
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const Module=require('node:module');
const client='11111111-1111-4111-8111-111111111111';
const endpoint='22222222-2222-4222-8222-222222222222';
async function main(){const db=new PGlite();const sends=[];let pauseAfterSend=false;
const oldLoad=Module._load;
const factories={
 './email-microsoft-graph-reply-draft-transport':{createMicrosoftGraphReplyDraftTransport:()=>({sendMail:async r=>{sends.push(r);if(pauseAfterSend)await db.query('UPDATE tenant_channel_endpoints SET mail_flow_paused=true WHERE id=$1',[endpoint]);return {outcome:'send_accepted'};}})},
 './email-delegated-grant-access-session':{createDelegatedGrantAccessSession:()=>({runWithAccessTokenOnce:async(_,fn)=>{await fn({accessToken:'fake-offline-token'});return {ok:true};}})},
 './sunset-microsoft-oauth-provider':{SUNSET_DEPLOYMENT:'sunset-staging',createSunsetMicrosoftOAuthClientSecretProvider:()=>({})},
 './email-grant-envelope-azure-kv-sunset-staging-runtime-composition':{createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition:()=>({ok:true,composition_enabled:true,provider:{}}),parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig:()=>({ok:true,composition_enabled:true})},
 './email-grant-envelope-provider-contract':{validateEmailGrantEnvelopeProvider:()=>({ok:true,value:{}})},
 './email-microsoft-token-http-transport':{createMicrosoftTokenHttpTransport:()=>({})},
 './email-outbound-sunset-staging-runtime-composition':{SUNSET_DEPLOYMENT:'sunset-staging',WORKER_ID:'offline-test',isEmailOutboundRuntimeCompositionEnabled:()=>true},
};
let owner;try{Module._load=function(id,parent,...rest){if(parent&&parent.filename.endsWith('/staff-broadcast-email-send.js')&&factories[id])return factories[id];return oldLoad.call(this,id,parent,...rest);};owner=require('./lib/staff-broadcast-email-send');}finally{Module._load=oldLoad;}
try{
 await db.exec(`CREATE TABLE clients(id uuid); INSERT INTO clients VALUES('${client}');
 CREATE TABLE tenant_channel_endpoints(id uuid,client_id uuid,provider_resource_id text,provider text,channel text,auth_mode text,connector_mode text,mailbox_access_kind text,binding_status text,outbound_enabled boolean,updated_at timestamptz,mail_flow_paused boolean);
 INSERT INTO tenant_channel_endpoints VALUES('${endpoint}','${client}','${endpoint}','microsoft_graph','email','delegated_authorization_code','microsoft_delegated_oauth','own_user','verified',true,'2026-09-22',false);`);
 const send=owner.createBroadcastEmailSendMail({pgClient:db,env:{LUNA_EMAIL_OAUTH_CLIENT_ID:client},https:{request(){}},timers:{setTimeout,clearTimeout}});
 assert.equal(typeof send,'function');
 const batch={clientId:client,subject:'Offline test',body:'Offline test',recipients:[{phone:'test1',email:'one@example.test'},{phone:'test2',email:'two@example.test'}]};
 pauseAfterSend=true;await send(batch);
 assert.equal(sends.length,1,'pause between recipients must prevent the next provider dispatch');
 pauseAfterSend=false;
 await db.exec(`INSERT INTO tenant_channel_endpoints SELECT '33333333-3333-4333-8333-333333333333',client_id,'33333333-3333-4333-8333-333333333333',provider,channel,auth_mode,connector_mode,mailbox_access_kind,binding_status,outbound_enabled,'2026-09-21',false FROM tenant_channel_endpoints LIMIT 1;`);
 assert.equal(await owner.resolveBroadcastMailbox(db,client),null,'paused chosen sender must not silently fall back to another mailbox');
 await db.query('UPDATE tenant_channel_endpoints SET mail_flow_paused=false WHERE id=$1',[endpoint]);
 await send(batch);assert.equal(sends.length,3,'resume uses same sender without changing capabilities');
 console.log('PASS broadcast real helper/SQL: pause between recipients, no sender substitution, resume');
}finally{await db.close();}}
main().catch(e=>{console.error(e);process.exitCode=1;});
