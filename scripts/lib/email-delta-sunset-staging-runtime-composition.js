'use strict';
/** EMAIL-M1-020 Sunset-only active runtime composition. Import is inert. */
const { createEmailDeltaSunsetStagingWorker } = require('./email-delta-sunset-staging-worker');
const { createSunsetMicrosoftOAuthClientSecretProvider } = require('./sunset-microsoft-oauth-provider');
const { createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition } = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const { validateEmailGrantEnvelopeProvider } = require('./email-grant-envelope-provider-contract');
const { createMicrosoftTokenHttpTransport } = require('./email-microsoft-token-http-transport');
const { createDelegatedGrantAccessSession } = require('./email-delegated-grant-access-session');
const { createMicrosoftGraphMessagesDeltaPageTransport } = require('./email-microsoft-graph-messages-delta-page-transport');
const { createAuthorityBoundMessagesDeltaPageOperation } = require('./email-authority-bound-messages-delta-page-operation');
const { createEmailInboundInboxBridge } = require('./email-inbound-inbox-bridge');
const { QUERY_VERSION, WORKER_ID } = require('./email-delta-runtime-config');

const SUNSET_DEPLOYMENT='sunset-staging', SUNSET_TENANT='sunset';
const ENV_COMPOSITION_ENABLED='LUNA_EMAIL_DELTA_RUNTIME_COMPOSITION_ENABLED';
const ENV_WORKER_ENABLED='LUNA_EMAIL_DELTA_WORKER_ENABLED';
const ENV_ADMIN_ENABLED='LUNA_EMAIL_DELTA_ADMIN_ENABLED';
const MIGRATION_080_ID='080_tenant_email_delta_from_now_v2';
const REQUIRED_KEYS=Object.freeze(['env','withPgClient','https','timers','intervalMs','activationWatermark']);
function enabled(env){return !!env&&env.LUNA_DEPLOYMENT===SUNSET_DEPLOYMENT&&env.DEFAULT_CLIENT_SLUG===SUNSET_TENANT&&env[ENV_COMPOSITION_ENABLED]==='true'&&env[ENV_WORKER_ENABLED]==='true'&&env[ENV_ADMIN_ENABLED]!=='true'&&env.LUNA_AUTO_SEND_ENABLED!=='true'&&env.LUNA_EMAIL_OAUTH_CLIENT_ID&&env.EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED==='true';}
function resolveEmailDeltaSunsetStagingRuntimeReadiness(env){const active=enabled(env);return Object.freeze({ok:active||!(env&&env[ENV_WORKER_ENABLED]==='true'),status:active?'ready':(env&&env[ENV_WORKER_ENABLED]==='true'?'config_invalid':'disabled'),runtime_activation:active,scheduler_present:active,worker_enabled:active,deployment_boundary:SUNSET_DEPLOYMENT,tenant_bound:active,worker_id:WORKER_ID,migration_id:MIGRATION_080_ID,query_version:QUERY_VERSION});}
function createEmailDeltaSunsetStagingRuntimeComposition(deps){
 if(!deps||Object.getPrototypeOf(deps)!==Object.prototype||Reflect.ownKeys(deps).length!==REQUIRED_KEYS.length||!REQUIRED_KEYS.every(k=>Object.prototype.hasOwnProperty.call(deps,k))||!enabled(deps.env)||typeof deps.withPgClient!=='function')throw new Error('email_delta_runtime_invalid');
 const watermark=deps.activationWatermark;
 if(typeof watermark!=='string'||new Date(watermark).toISOString()!==watermark)throw new Error('email_delta_activation_watermark_invalid');
 const kv=createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(deps.env), validated=kv&&validateEmailGrantEnvelopeProvider(kv.provider);
 if(!kv||kv.ok!==true||!validated||validated.ok!==true)throw new Error('email_delta_runtime_invalid');
 const secretProvider=createSunsetMicrosoftOAuthClientSecretProvider(Object.freeze({deployment:SUNSET_DEPLOYMENT,env:deps.env}));
 const tokenTransport=createMicrosoftTokenHttpTransport(Object.freeze({httpsImpl:deps.https,timers:deps.timers}));
 const graphTransport=createMicrosoftGraphMessagesDeltaPageTransport(Object.freeze({httpsImpl:deps.https,timers:deps.timers}),watermark);
 let currentClient=null;
 const worker=createEmailDeltaSunsetStagingWorker({
  timers:deps.timers,intervalMs:deps.intervalMs,
  query:(sql,args)=>currentClient.query(sql,args),
  runPage:async(authority)=>{
   const client=currentClient;
   const withTransactionClient=async work=>work(client);
   const createGrantSession=()=>createDelegatedGrantAccessSession(Object.freeze({deployment:SUNSET_DEPLOYMENT,applicationClientId:deps.env.LUNA_EMAIL_OAUTH_CLIENT_ID.toLowerCase(),client,envelopeProvider:validated.value,secretProvider,transport:tokenTransport,workerId:WORKER_ID}));
   const operation=createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({db:client,createGrantSession,messagesDeltaPageTransport:graphTransport,withTransactionClient,envelopeProvider:validated.value}));
   const result=await operation.runAuthorityBoundMessagesDeltaPage(authority);
   if(!result||result.ok!==true)throw new Error('email_delta_page_failed');
   return result.value;
  },
  projectEvent:async event=>{
   const bridge=createEmailInboundInboxBridge({withTransactionClient:async work=>work(currentClient)});
   return bridge.projectInboundEvent({clientId:event.clientId,locationId:event.locationId,endpointId:event.endpointId,provider:event.provider,providerMailboxId:event.providerMailboxId,providerMessageId:event.providerMessageId});
  },
 });
 const rawTick=worker.tick;
 let tickRunning=false;
 async function tick(){
  if(tickRunning)return Object.freeze({status:'overlap_skipped'});
  tickRunning=true;
  try{return await deps.withPgClient(async client=>{currentClient=client;try{return await rawTick();}finally{currentClient=null;}});}
  finally{tickRunning=false;}
 }
 // Scheduler invokes the same exclusive-loan tick, never a naked pool/query.
 let timer=null,stopped=true,running=false;
 function arm(){if(stopped)return;timer=deps.timers.setTimeout(async()=>{if(!running){running=true;try{await tick();}finally{running=false;}}arm();},deps.intervalMs);}
 function start(){if(!stopped)return;stopped=false;arm();}
 function stop(){stopped=true;if(timer!==null){deps.timers.clearTimeout(timer);timer=null;}}
 return Object.freeze({start,stop,tick,getReadiness:()=>resolveEmailDeltaSunsetStagingRuntimeReadiness(deps.env)});
}
module.exports=Object.freeze({SUNSET_DEPLOYMENT,SUNSET_TENANT,WORKER_ID,QUERY_VERSION,MIGRATION_080_ID,ENV_COMPOSITION_ENABLED,ENV_WORKER_ENABLED,ENV_ADMIN_ENABLED,resolveEmailDeltaSunsetStagingRuntimeReadiness,createEmailDeltaSunsetStagingRuntimeComposition});
