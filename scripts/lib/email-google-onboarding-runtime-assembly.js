'use strict';

const { isProxy } = require('node:util').types;
const { createGoogleOAuthStart } = require('./email-google-oauth-start');
const { createGoogleOAuthCallbackConsume } = require('./email-google-oauth-callback-consume');
const { createGoogleTransactionCompletionFactory } = require('./email-google-transaction-completion-factory');
const { createGoogleOAuthCallbackCompletion } = require('./email-google-oauth-callback-completion');
const { createGoogleMailboxAuthorityComposition } = require('./email-google-mailbox-authority-composition');

const freeze = Object.freeze;
const isFrozen = Object.isFrozen;
const ownKeys = Reflect.ownKeys;
const apply = Reflect.apply;
const descriptor = Object.getOwnPropertyDescriptor;
const prototype = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const create = Object.create;
const define = Object.defineProperty;
const setPrototypeOf = Object.setPrototypeOf;
const ErrorConstructor = Error;
const objectPrototype = Object.prototype;
const CONFIG_KEYS = freeze(['tenantSlug','clientId','locationId','endpointId','applicationClientId','redirectUri','secretRef','onboardingEnabled']);
const DEP_KEYS = freeze(['cryptography','clock','repository','https','crypto','timers','envelopeProvider','installer','secretProvider','signatureVerifier']);
const METHODS = freeze({cryptography:freeze(['randomUUID','randomBytes','sha256Ascii']),clock:freeze(['now','nowEpochSeconds']),repository:freeze(['create','consume']),https:freeze(['request']),crypto:freeze(['createPublicKey','verify']),timers:freeze(['setTimeout','clearTimeout']),envelopeProvider:freeze(['sealGrantPayload','openGrantPayload','rewrapGrantDek']),installer:freeze(['installVerifiedGrant']),secretProvider:freeze(['resolveClientSecret']),signatureVerifier:freeze(['verifySignature'])});
const START_INPUT = freeze(['tenantSlug','clientId','locationId','endpointId','staffUserId','authSessionId']);
const CALLBACK_INPUT = freeze(['tenantSlug','clientId','locationId','endpointId','authSessionId','query']);
const AUTHORITY_INPUT = freeze(['tenantSlug','clientId','locationId','endpointId','expectedNonce','idToken','accessToken','nowEpochSeconds']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENDPOINT='11111111-2222-4333-8444-555555555555';
const APP='9876543210-sunset.apps.googleusercontent.com';
const REDIRECT='https://staff-staging.lunafrontdesk.com/staff/email/google/callback';
const REF='secret-ref:email/google/sunset-staging-oauth-client';
const FAILURE_PROTOTYPE=create(ErrorConstructor.prototype);
define(FAILURE_PROTOTYPE,'name',{value:'GoogleOnboardingRuntimeError'});freeze(FAILURE_PROTOTYPE);
function fail(disabled=false){const error=new ErrorConstructor(disabled?'Google onboarding runtime is disabled.':'Google onboarding runtime failed.');setPrototypeOf(error,FAILURE_PROTOTYPE);define(error,'code',{value:disabled?'GOOGLE_ONBOARDING_RUNTIME_DISABLED':'GOOGLE_ONBOARDING_RUNTIME_FAILED',enumerable:true});define(error,'stack',{value:undefined});throw freeze(error);}
function exact(value,keys){try{if(!value||isProxy(value)||prototype(value)!==objectPrototype||!isFrozen(value))return null;const actual=ownKeys(value);if(actual.length!==keys.length)return null;const out=create(null);for(let i=0;i<keys.length;i++){if(actual[i]!==keys[i])return null;const d=descriptor(value,keys[i]);if(!d||!hasOwn(d,'value')||!d.enumerable||d.writable||d.configurable)return null;out[keys[i]]=d.value;}return out;}catch{return null;}}
function capability(value,keys){const r=exact(value,keys);if(!r)return null;for(const key of keys)if(typeof r[key]!=='function'||isProxy(r[key]))return null;return r;}
function surface(value,keys){return capability(value,keys);}
function binding(input,keys,config){const value=exact(input,keys);if(!value||value.tenantSlug!==config.tenantSlug||value.clientId!==config.clientId||value.locationId!==config.locationId||value.endpointId!==config.endpointId)fail();return value;}
function createGoogleOnboardingRuntimeAssembly(configuration,dependencies){
 const config=exact(configuration,CONFIG_KEYS),deps=exact(dependencies,DEP_KEYS);
 if(!config||!deps||config.tenantSlug!=='sunset'||!UUID.test(config.locationId)||!UUID.test(config.clientId)||config.endpointId!==ENDPOINT||config.applicationClientId!==APP||config.redirectUri!==REDIRECT||config.secretRef!==REF||typeof config.onboardingEnabled!=='boolean')fail();
 for(const key of DEP_KEYS)if(!capability(deps[key],METHODS[key]))fail();
 const snapshot=freeze({tenantSlug:config.tenantSlug,clientId:config.clientId,locationId:config.locationId,endpointId:config.endpointId,applicationClientId:config.applicationClientId,redirectUri:config.redirectUri,secretRef:config.secretRef,onboardingEnabled:config.onboardingEnabled});
 if(!config.onboardingEnabled){return freeze({configuration:snapshot,startOnboarding(){fail(true);},completeOnboardingCallback(){fail(true);},deriveMailboxAuthority(){fail(true);}});}
 const startClock=freeze({now(...args){return apply(descriptor(deps.clock,'now').value,deps.clock,args);}});
 const startRepository=freeze({create(...args){return apply(descriptor(deps.repository,'create').value,deps.repository,args);}});
 const consumeRepository=freeze({consume(...args){return apply(descriptor(deps.repository,'consume').value,deps.repository,args);}});
 const start=createGoogleOAuthStart(freeze({enabled:config.onboardingEnabled,applicationClientId:APP,redirectUri:REDIRECT}),freeze({cryptography:deps.cryptography,clock:startClock,repository:startRepository}));
 const consume=createGoogleOAuthCallbackConsume(freeze({cryptography:freeze({sha256Ascii(...args){return apply(descriptor(deps.cryptography,'sha256Ascii').value,deps.cryptography,args);}}),clock:startClock,repository:consumeRepository}));
 const transactionFactory=createGoogleTransactionCompletionFactory(freeze({https:deps.https,crypto:deps.crypto,timers:deps.timers,envelopeProvider:deps.envelopeProvider,clock:freeze({nowEpochSeconds:descriptor(deps.clock,'nowEpochSeconds').value}),installer:deps.installer}));
 const callback=createGoogleOAuthCallbackCompletion(freeze({applicationClientId:APP,redirectUri:REDIRECT,secretRef:REF}),freeze({callbackConsume:consume,secretProvider:deps.secretProvider,transactionCompletionFactory:transactionFactory}));
 const startMethod=surface(start,['start']), callbackMethod=surface(callback,['completeCallback']);
 if(!startMethod||!callbackMethod)fail();
 function startOnboarding(input){const v=binding(input,START_INPUT,config);return apply(startMethod.start,start,[freeze({clientId:v.clientId,locationId:v.locationId,endpointId:v.endpointId,staffUserId:v.staffUserId,authSessionId:v.authSessionId})]);}
 function completeOnboardingCallback(input){try{const v=binding(input,CALLBACK_INPUT,config);return apply(callbackMethod.completeCallback,callback,[freeze({clientId:v.clientId,authSessionId:v.authSessionId,query:v.query})]);}catch(error){if(error&&error.code==='GOOGLE_ONBOARDING_RUNTIME_FAILED')throw error;fail();}}
 function deriveMailboxAuthority(input){try{const v=binding(input,AUTHORITY_INPUT,config);const authority=createGoogleMailboxAuthorityComposition(freeze({expectedAudience:APP,expectedNonce:v.expectedNonce,requestTimeoutMs:5000,responseBytesMax:16384}),freeze({https:deps.https,timers:deps.timers,signatureVerifier:deps.signatureVerifier}));const operation=surface(authority,['deriveAuthority']);if(!operation)fail();return apply(operation.deriveAuthority,authority,[freeze({idToken:v.idToken,accessToken:v.accessToken,nowEpochSeconds:v.nowEpochSeconds})]);}catch(error){if(error&&error.code==='GOOGLE_ONBOARDING_RUNTIME_FAILED')throw error;fail();}}
 return freeze({configuration:snapshot,startOnboarding,completeOnboardingCallback,deriveMailboxAuthority});
}
module.exports=freeze({createGoogleOnboardingRuntimeAssembly});
