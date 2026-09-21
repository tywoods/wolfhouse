'use strict';
const {createGoogleOAuthStart}=require('./email-google-oauth-start');
const {createWolfhouseGoogleOAuthTransactionRepository}=require('./email-google-oauth-transaction-repository-wolfhouse');
const {createGoogleStateFirstRuntimeComposition}=require('./email-google-state-first-runtime-composition');
const {createVerifiedGrantInstaller}=require('./email-verified-grant-installer');
const {validateEmailGrantEnvelopeProvider}=require('./email-grant-envelope-provider-contract');
const {createActiveWolfhouseStaffStagingEnvelopeComposition,parseWolfhouseStaffStagingEnvelopeConfig}=require('./email-grant-envelope-azure-kv-wolfhouse-staff-staging-runtime-composition');
const {createWolfhouseGoogleOAuthClientSecretProvider}=require('./wolfhouse-google-oauth-provider');
const {pinEmailOAuthStageTelemetry,createNoopEmailOAuthStageTelemetry}=require('./email-microsoft-oauth-stage-telemetry');
const DEPLOYMENT='staff-staging',REDIRECT='https://staff-staging.lunafrontdesk.com/staff/email/google/callback';
const APP=/^[A-Za-z0-9][A-Za-z0-9._-]*\.apps\.googleusercontent\.com$/;
const F=Object.freeze({start:'WOLFHOUSE_EMAIL_GOOGLE_OAUTH_START_ENABLED',callback:'WOLFHOUSE_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED',custody:'WOLFHOUSE_EMAIL_GOOGLE_OAUTH_GRANT_CUSTODY_ENABLED',clientId:'WOLFHOUSE_EMAIL_GOOGLE_OAUTH_CLIENT_ID'});
function own(o,k){try{const d=Object.getOwnPropertyDescriptor(o,k);return d&&Object.hasOwn(d,'value')?d.value:undefined;}catch{return undefined;}}
function fail(){const e=new Error('Google OAuth Wolfhouse staff-staging runtime composition failed.');e.code='GOOGLE_OAUTH_WOLFHOUSE_STAFF_STAGING_RUNTIME_COMPOSITION_INVALID';e.stack=undefined;throw Object.freeze(e);}
function bind(o,names){const x={};for(const n of names){if(typeof own(o,n)!=='function')fail();x[n]=(...a)=>Reflect.apply(own(o,n),o,a);}return Object.freeze(x);}
function createWolfhouseStaffStagingGoogleOAuthComposition(deps){
 try{
  if(!deps||!Object.isFrozen(deps)||Reflect.ownKeys(deps).join(',')!=='env,https,crypto,timers,clock')fail();
  const env=own(deps,'env'),clientId=own(env,F.clientId);if(own(env,'LUNA_DEPLOYMENT')!==DEPLOYMENT||!APP.test(clientId||''))fail();
  const https=bind(own(deps,'https'),['request']),crypto=bind(own(deps,'crypto'),['createPublicKey','verify','randomUUID','randomBytes','createHash']),timers=bind(own(deps,'timers'),['setTimeout','clearTimeout']),clock=bind(own(deps,'clock'),['now','nowEpochSeconds']);
  const cryptography=Object.freeze({randomUUID:crypto.randomUUID,randomBytes:crypto.randomBytes,sha256Ascii(v){const h=crypto.createHash('sha256');h.update(v,'ascii');return h.digest();}});
  function owners(pg){const queryOwner=bind(pg,['query']);return {queryOwner,repository:createWolfhouseGoogleOAuthTransactionRepository(Object.freeze({queryOwner}))};}
  function createStart(pg){if(own(env,F.start)!=='true')fail();const o=owners(pg);return createGoogleOAuthStart(Object.freeze({enabled:true,applicationClientId:clientId,redirectUri:REDIRECT}),Object.freeze({cryptography,clock:Object.freeze({now:clock.now}),repository:Object.freeze({create:o.repository.create})}));}
  function createCallbackRuntime(pg,rawTelemetry){
   if(own(env,F.callback)!=='true'||own(env,F.custody)!=='true'||parseWolfhouseStaffStagingEnvelopeConfig(env).composition_enabled!==true)fail();
   const o=owners(pg),envelope=createActiveWolfhouseStaffStagingEnvelopeComposition(env),validated=validateEmailGrantEnvelopeProvider(envelope.provider);if(!validated.ok)fail();
   const telemetry=rawTelemetry===undefined?createNoopEmailOAuthStageTelemetry():pinEmailOAuthStageTelemetry(rawTelemetry);if(!telemetry)fail();
   return createGoogleStateFirstRuntimeComposition(Object.freeze({tenantSlug:'wolfhouse-somo',locationKey:'wolfhouse-somo',applicationClientId:clientId,redirectUri:REDIRECT,callbackEnabled:true}),Object.freeze({db:o.queryOwner,cryptography:Object.freeze({sha256Ascii:cryptography.sha256Ascii}),clock,repository:Object.freeze({consume:o.repository.consume}),https,crypto:Object.freeze({createPublicKey:crypto.createPublicKey,verify:crypto.verify}),timers,envelopeProvider:validated.value,installer:createVerifiedGrantInstaller(Object.freeze({client:o.queryOwner})),secretProvider:createWolfhouseGoogleOAuthClientSecretProvider(Object.freeze({deployment:DEPLOYMENT,env})),stageTelemetry:telemetry}));
  }
  return Object.freeze({createStart,createCallbackRuntime});
 }catch{fail();}
}
module.exports=Object.freeze({DEPLOYMENT,FLAGS:F,createWolfhouseStaffStagingGoogleOAuthComposition});
