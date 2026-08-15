'use strict';
/** Sunset-only active inbound delta composition. Import performs no I/O. */
const { createEmailDeltaSunsetStagingWorker } = require('./email-delta-sunset-staging-worker');
const { createSunsetMicrosoftOAuthClientSecretProvider } = require('./sunset-microsoft-oauth-provider');
const { createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition } = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const{validateEmailGrantEnvelopeProvider}=require('./email-grant-envelope-provider-contract');
const { createMicrosoftTokenHttpTransport } = require('./email-microsoft-token-http-transport');
const { createDelegatedGrantAccessSession } = require('./email-delegated-grant-access-session');
const { createMicrosoftGraphMessagesDeltaPageTransport } = require('./email-microsoft-graph-messages-delta-page-transport');
const { createAuthorityBoundMessagesDeltaPageOperation } = require('./email-authority-bound-messages-delta-page-operation');
const { createEmailInboundInboxBridge } = require('./email-inbound-inbox-bridge');
const {
  createDeltaRuntimeDiagnosticSink,
  brandDeltaRuntimeDiagnostic,
} = require('./email-delta-sunset-staging-runtime-diagnostics');
const config = require('./email-delta-runtime-config');

const { SUNSET_DEPLOYMENT,SUNSET_TENANT,WORKER_ID,QUERY_VERSION,ENV_COMPOSITION_ENABLED,ENV_WORKER_ENABLED,ENV_ADMIN_ENABLED,parseEmailDeltaRuntimeConfig }=config;
const MIGRATION_080_ID='080_tenant_email_delta_from_now_v2';
const REQUIRED_KEYS=Object.freeze(['env','withPgClient','https','timers','intervalMs']);
const SCHEMA_VERIFY_SQL=`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='tenant_email_delta_activation_boundaries') AS boundary_table, EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tenant_email_inbound_delta_states_query_version_exact' AND pg_get_constraintdef(oid) LIKE '%ms_messages_delta_from_now_v2%') AS query_constraint`;
function resolveEmailDeltaSunsetStagingRuntimeReadiness(env){return parseEmailDeltaRuntimeConfig(env===undefined?process.env:env);}
function fail(){const e=new Error('Email delta sunset-staging runtime composition failed.');Object.defineProperty(e,'code',{value:'EMAIL_DELTA_SUNSET_STAGING_RUNTIME_COMPOSITION_INVALID',enumerable:true});return Object.freeze(e);}
function exactDeps(d){return d&&Object.getPrototypeOf(d)===Object.prototype&&Reflect.ownKeys(d).length===REQUIRED_KEYS.length&&REQUIRED_KEYS.every(k=>Object.prototype.hasOwnProperty.call(d,k));}
function observeHttps(httpsImpl,sink){
 if(!httpsImpl)return httpsImpl;
 const requestFn=typeof httpsImpl==='function'?httpsImpl:(httpsImpl&&typeof httpsImpl.request==='function'?httpsImpl.request.bind(httpsImpl):null);
 if(typeof requestFn!=='function')return httpsImpl;
 return Object.freeze({request(options,cb){return requestFn(options,(res)=>{try{const status=res&&typeof res.statusCode==='number'?res.statusCode:NaN;sink.recordFromHttpStatus(status);}catch(_err){/* never throw */}if(typeof cb==='function')cb(res);});}});
}
function observeGrantSessionFactory(createGrantSession,sink){
 if(typeof createGrantSession!=='function')return createGrantSession;
 return function createObservedGrantSession(){
  const session=createGrantSession();
  const run=session&&session.runWithAccessTokenOnce;
  if(typeof run!=='function')return session;
  return Object.freeze({runWithAccessTokenOnce:async(input,cb)=>{const out=await run.call(session,input,cb);try{if(out&&out.ok!==true)sink.recordFromGrantStatus(out.status);}catch(_err){/* never throw */}return out;}});
 };
}
function observeTransport(transport,sink){
 if(!transport||typeof transport!=='object')return transport;
 const fetchInitial=transport.fetchInitialPage;
 const fetchContinuation=transport.fetchContinuationPage;
 if(typeof fetchInitial!=='function'||typeof fetchContinuation!=='function')return transport;
 const wrap=fn=>async function observedFetch(...args){try{return await fn.apply(transport,args);}catch(err){try{sink.recordFromTransportError(err);sink.recordFromTransportBoundaryFailure();}catch(_err){/* never throw */}throw err;}};
 return Object.freeze({fetchInitialPage:wrap(fetchInitial),fetchContinuationPage:wrap(fetchContinuation)});
}
function createEmailDeltaSunsetStagingRuntimeComposition(deps){
 try{
  if(!exactDeps(deps)||typeof deps.withPgClient!=='function'||!deps.https||!deps.timers||typeof deps.timers.setTimeout!=='function'||typeof deps.timers.clearTimeout!=='function'||!Number.isInteger(deps.intervalMs))throw fail();
  const readiness=parseEmailDeltaRuntimeConfig(deps.env);
  if(!readiness||readiness.runtime_activation!==true||readiness.ok!==true)throw fail();
  const kv=createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(deps.env), validated=kv&&validateEmailGrantEnvelopeProvider(kv.provider), validatedCursor=kv&&validateEmailGrantEnvelopeProvider(kv.cursorProvider);
  if(!kv||kv.ok!==true||!validated||validated.ok!==true||!validatedCursor||validatedCursor.ok!==true)throw fail();
  const sink=createDeltaRuntimeDiagnosticSink();
  const observedHttps=observeHttps(deps.https,sink);
  const tokenTransport=createMicrosoftTokenHttpTransport(Object.freeze({httpsImpl:observedHttps,timers:deps.timers}));
  let currentClient=null;
  const worker=createEmailDeltaSunsetStagingWorker({timers:deps.timers,intervalMs:deps.intervalMs,
   query:async(sql,args)=>{try{return await currentClient.query(sql,args);}catch(err){sink.recordFromQueryFailure();throw brandDeltaRuntimeDiagnostic(err,'query','query');}},
   runPage:async authority=>{
    const client=currentClient;
    const graphTransport=observeTransport(createMicrosoftGraphMessagesDeltaPageTransport(Object.freeze({httpsImpl:observedHttps,timers:deps.timers}),authority.activationWatermark),sink);
    const createGrantSession=observeGrantSessionFactory(()=>createDelegatedGrantAccessSession(Object.freeze({deployment:SUNSET_DEPLOYMENT,applicationClientId:deps.env[config.ENV_OAUTH_CLIENT_ID].toLowerCase(),client,envelopeProvider:validated.value,secretProvider:createSunsetMicrosoftOAuthClientSecretProvider(Object.freeze({deployment:SUNSET_DEPLOYMENT,env:deps.env})),transport:tokenTransport,workerId:WORKER_ID})),sink);
    const operation=createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({db:client,createGrantSession,messagesDeltaPageTransport:graphTransport,withTransactionClient:async work=>work(client),envelopeProvider:validatedCursor.value}));
    const cleanAuthority=Object.freeze({clientId:authority.clientId,locationId:authority.locationId,endpointId:authority.endpointId});
    const result=await operation.runAuthorityBoundMessagesDeltaPage(cleanAuthority);
    if(!result||result.ok!==true){sink.recordFromPageFailure();throw fail();} return result.value;
   },
   projectEvent:async event=>createEmailInboundInboxBridge({withTransactionClient:async work=>work(currentClient)}).projectInboundEvent({clientId:event.clientId,locationId:event.locationId,endpointId:event.endpointId,provider:event.provider,providerMailboxId:event.providerMailboxId,providerMessageId:event.providerMessageId}),
  });
  let tickPromise=null,timer=null,stopped=true,schemaVerified=false;
  async function verifySchema(){if(schemaVerified)return;try{await deps.withPgClient(async client=>{const r=await client.query(SCHEMA_VERIFY_SQL,[]);if(!r||!r.rows||r.rows.length!==1||r.rows[0].boundary_table!==true||r.rows[0].query_constraint!==true)throw fail();});}catch(err){sink.recordFromSchemaFailure();throw err;}schemaVerified=true;}
  async function tick(){if(tickPromise)return Object.freeze({status:'overlap_skipped'});sink.reset();tickPromise=(async()=>{await verifySchema();return deps.withPgClient(async client=>{currentClient=client;try{return await worker.tick();}finally{currentClient=null;}});})();try{return await tickPromise;}finally{tickPromise=null;}}
  function arm(){if(stopped)return;timer=deps.timers.setTimeout(async()=>{try{await tick();}catch(err){try{sink.recordFromThrown(err);sink.emitFailure();}catch(_err){/* never throw */}}finally{arm();}},deps.intervalMs);}
  async function start(){if(!stopped)return;await verifySchema();stopped=false;arm();}
  async function stop(){stopped=true;if(timer!==null){deps.timers.clearTimeout(timer);timer=null;}if(tickPromise)await tickPromise;}
  return Object.freeze({start,stop,tick,getReadiness:()=>readiness});
 }catch(err){if(err&&err.code==='EMAIL_DELTA_SUNSET_STAGING_RUNTIME_COMPOSITION_INVALID')throw err;throw fail();}
}
module.exports=Object.freeze({SUNSET_DEPLOYMENT,SUNSET_TENANT,WORKER_ID,QUERY_VERSION,MIGRATION_080_ID,ENV_COMPOSITION_ENABLED,ENV_WORKER_ENABLED,ENV_ADMIN_ENABLED,SCHEMA_VERIFY_SQL,resolveEmailDeltaSunsetStagingRuntimeReadiness,createEmailDeltaSunsetStagingRuntimeComposition});
