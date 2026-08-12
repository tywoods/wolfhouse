'use strict';

const { isProxy, isPromise } = require('node:util').types;
const { createGoogleOAuthStart } = require('./email-google-oauth-start');
const { createGoogleOAuthCallbackConsume } = require('./email-google-oauth-callback-consume');
const { createGoogleTransactionCompletionFactory } = require('./email-google-transaction-completion-factory');
const { createGoogleOAuthCallbackCompletion } = require('./email-google-oauth-callback-completion');
const { createGoogleMailboxAuthorityComposition } = require('./email-google-mailbox-authority-composition');
const freeze=Object.freeze,isFrozen=Object.isFrozen,ownKeys=Reflect.ownKeys,apply=Reflect.apply,descriptor=Object.getOwnPropertyDescriptor,prototype=Object.getPrototypeOf,hasOwn=Object.hasOwn,create=Object.create,define=Object.defineProperty,setPrototypeOf=Object.setPrototypeOf;
const promisePrototype=Promise.prototype,promiseThen=Promise.prototype.then;
const CONFIG_KEYS=freeze(['tenantSlug','clientId','locationKey','locationId','endpointId','applicationClientId','redirectUri','secretRef','authorityNonce','onboardingEnabled']);
const DEP_KEYS=freeze(['cryptography','clock','repository','https','crypto','timers','envelopeProvider','installer','secretProvider','signatureVerifier']);
const METHODS=freeze({cryptography:freeze(['randomUUID','randomBytes','sha256Ascii']),clock:freeze(['now','nowEpochSeconds']),repository:freeze(['create','consume']),https:freeze(['request']),crypto:freeze(['createPublicKey','verify']),timers:freeze(['setTimeout','clearTimeout']),envelopeProvider:freeze(['sealGrantPayload','openGrantPayload','rewrapGrantDek']),installer:freeze(['installVerifiedGrant']),secretProvider:freeze(['resolveClientSecret']),signatureVerifier:freeze(['verifySignature'])});
const START_INPUT=freeze(['tenantSlug','clientId','locationKey','endpointId','staffUserId','authSessionId']);
const CALLBACK_INPUT=freeze(['tenantSlug','clientId','locationKey','endpointId','authSessionId','query']);
const AUTHORITY_INPUT=freeze(['tenantSlug','clientId','locationKey','endpointId','idToken','accessToken','nowEpochSeconds']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,APP=/^[A-Za-z0-9][A-Za-z0-9._-]*\.apps\.googleusercontent\.com$/,NONCE=/^[A-Za-z0-9_-]{43,128}$/;
const FAILURE_PROTOTYPE=create(Error.prototype);define(FAILURE_PROTOTYPE,'name',{value:'GoogleOnboardingRuntimeError'});freeze(FAILURE_PROTOTYPE);
function fail(disabled=false){const e=new Error(disabled?'Google onboarding runtime is disabled.':'Google onboarding runtime failed.');setPrototypeOf(e,FAILURE_PROTOTYPE);define(e,'code',{value:disabled?'GOOGLE_ONBOARDING_RUNTIME_DISABLED':'GOOGLE_ONBOARDING_RUNTIME_FAILED',enumerable:true});define(e,'stack',{value:undefined});throw freeze(e);}
function exact(value,keys){try{if(!value||isProxy(value)||prototype(value)!==Object.prototype||!isFrozen(value))return null;const actual=ownKeys(value);if(actual.length!==keys.length)return null;const out=create(null);for(let i=0;i<keys.length;i++){if(actual[i]!==keys[i])return null;const d=descriptor(value,keys[i]);if(!d||!hasOwn(d,'value')||!d.enumerable||d.writable||d.configurable)return null;out[keys[i]]=d.value;}return out;}catch{return null;}}
function capability(value,keys){const r=exact(value,keys);if(!r)return null;for(const key of keys)if(typeof r[key]!=='function'||isProxy(r[key]))return null;return r;}
function settle(value,accept){if(value&&prototype(value)===promisePrototype&&isPromise(value))return apply(promiseThen,value,[accept,()=>fail()]);return accept(value);}
function binding(input,keys,config){const v=exact(input,keys);if(!v||v.tenantSlug!==config.tenantSlug||v.clientId!==config.clientId||v.locationKey!==config.locationKey||v.endpointId!==config.endpointId)fail();return v;}
function createGoogleOnboardingRuntimeAssembly(configuration,dependencies){
 const config=exact(configuration,CONFIG_KEYS),deps=exact(dependencies,DEP_KEYS);
 if(!config||!deps||config.tenantSlug!=='sunset'||config.locationKey!=='sunset-somo'||!UUID.test(config.clientId)||!UUID.test(config.locationId)||!UUID.test(config.endpointId)||!APP.test(config.applicationClientId)||typeof config.redirectUri!=='string'||!config.redirectUri.startsWith('https://')||typeof config.secretRef!=='string'||!NONCE.test(config.authorityNonce)||typeof config.onboardingEnabled!=='boolean')fail();
 for(const key of DEP_KEYS)if(!capability(deps[key],METHODS[key]))fail();
 const snapshot=freeze({...configuration});
 if(!config.onboardingEnabled)return freeze({configuration:snapshot,startOnboarding(){fail(true);},completeOnboardingCallback(){fail(true);},deriveMailboxAuthority(){fail(true);}});
 const now=descriptor(deps.clock,'now').value,nowEpochSeconds=descriptor(deps.clock,'nowEpochSeconds').value,createTx=descriptor(deps.repository,'create').value,consumeTx=descriptor(deps.repository,'consume').value,sha=descriptor(deps.cryptography,'sha256Ascii').value;
 const clock=freeze({now(...a){return apply(now,deps.clock,a);}}),repository=freeze({create(...a){return apply(createTx,deps.repository,a);}});
 const start=createGoogleOAuthStart(freeze({enabled:true,applicationClientId:config.applicationClientId,redirectUri:config.redirectUri}),freeze({cryptography:deps.cryptography,clock,repository}));
 const rawConsume=createGoogleOAuthCallbackConsume(freeze({cryptography:freeze({sha256Ascii(...a){return apply(sha,deps.cryptography,a);}}),clock,repository:freeze({consume(...a){return apply(consumeTx,deps.repository,a);}})}));
 const consumeMethod=capability(rawConsume,['consumeCallback']).consumeCallback;
 const boundConsume=freeze({consumeCallback(value){return settle(apply(consumeMethod,rawConsume,[value]),out=>{const r=exact(out,['status','authorizationCode','clientId','operationId','locationId','endpointId','staffUserId','codeVerifier','nonce']);if(r&&(r.locationId!==config.locationId||r.endpointId!==config.endpointId))fail();return out;});}});
 const factory=createGoogleTransactionCompletionFactory(freeze({https:deps.https,crypto:deps.crypto,timers:deps.timers,envelopeProvider:deps.envelopeProvider,clock:freeze({nowEpochSeconds(...a){return apply(nowEpochSeconds,deps.clock,a);}}),installer:deps.installer}));
 const callback=createGoogleOAuthCallbackCompletion(freeze({applicationClientId:config.applicationClientId,redirectUri:config.redirectUri,secretRef:config.secretRef}),freeze({callbackConsume:boundConsume,secretProvider:deps.secretProvider,transactionCompletionFactory:factory}));
 const startMethod=capability(start,['start']).start,callbackMethod=capability(callback,['completeCallback']).completeCallback;
 let authorityConsumed=false;
 function startOnboarding(input){const v=binding(input,START_INPUT,config);return apply(startMethod,start,[freeze({clientId:v.clientId,locationId:config.locationId,endpointId:v.endpointId,staffUserId:v.staffUserId,authSessionId:v.authSessionId})]);}
 function completeOnboardingCallback(input){try{const v=binding(input,CALLBACK_INPUT,config);return settle(apply(callbackMethod,callback,[freeze({clientId:v.clientId,authSessionId:v.authSessionId,query:v.query})]),x=>x);}catch(_){fail();}}
 function deriveMailboxAuthority(input){try{const v=binding(input,AUTHORITY_INPUT,config);if(authorityConsumed)fail();authorityConsumed=true;const authority=createGoogleMailboxAuthorityComposition(freeze({expectedAudience:config.applicationClientId,expectedNonce:config.authorityNonce,requestTimeoutMs:5000,responseBytesMax:16384}),freeze({https:deps.https,timers:deps.timers,signatureVerifier:deps.signatureVerifier}));const method=capability(authority,['deriveAuthority']).deriveAuthority;return settle(apply(method,authority,[freeze({idToken:v.idToken,accessToken:v.accessToken,nowEpochSeconds:v.nowEpochSeconds})]),x=>x);}catch(_){fail();}}
 return freeze({configuration:snapshot,startOnboarding,completeOnboardingCallback,deriveMailboxAuthority});
}
module.exports=freeze({createGoogleOnboardingRuntimeAssembly});
