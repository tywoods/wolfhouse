'use strict';

const { isProxy } = require('node:util').types;
const { createGoogleOAuthStart } = require('./email-google-oauth-start');
const { createGoogleOAuthCallbackConsume } = require('./email-google-oauth-callback-consume');
const { createGoogleTransactionCompletionFactory } = require('./email-google-transaction-completion-factory');
const { createGoogleOAuthCallbackCompletion } = require('./email-google-oauth-callback-completion');
const { createGoogleMailboxAuthorityComposition } = require('./email-google-mailbox-authority-composition');

const freeze = Object.freeze;
const ownKeys = Reflect.ownKeys;
const descriptor = Object.getOwnPropertyDescriptor;
const prototype = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const CONFIG_KEYS = freeze(['tenantSlug','clientId','locationId','endpointId','applicationClientId','redirectUri','secretRef','startEnabled','callbackEnabled','authorityEnabled']);
const DEP_KEYS = freeze(['cryptography','clock','repository','https','crypto','timers','envelopeProvider','installer','secretProvider','signatureVerifier']);
const METHODS = freeze({cryptography:freeze(['randomUUID','randomBytes','sha256Ascii']),clock:freeze(['now','nowEpochSeconds']),repository:freeze(['create','consume']),https:freeze(['request']),crypto:freeze(['createPublicKey','verify']),timers:freeze(['setTimeout','clearTimeout']),envelopeProvider:freeze(['sealGrantPayload','openGrantPayload','rewrapGrantDek']),installer:freeze(['installVerifiedGrant']),secretProvider:freeze(['resolveClientSecret']),signatureVerifier:freeze(['verifySignature'])});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENDPOINT='11111111-2222-4333-8444-555555555555';
const APP='9876543210-sunset.apps.googleusercontent.com';
const REDIRECT='https://staff-staging.lunafrontdesk.com/staff/email/google/callback';
const REF='secret-ref:email/google/sunset-staging-oauth-client';
const failure=freeze(Object.defineProperty(Object.defineProperty(new Error('Google onboarding runtime is disabled.'),'name',{value:'GoogleOnboardingRuntimeDisabledError'}),'code',{value:'GOOGLE_ONBOARDING_RUNTIME_DISABLED',enumerable:true}));
function fail(){throw failure;}
function exact(value,keys){try{if(!value||isProxy(value)||prototype(value)!==Object.prototype||!Object.isFrozen(value))return null;const actual=ownKeys(value);if(actual.length!==keys.length)return null;const out=Object.create(null);for(let i=0;i<keys.length;i++){if(actual[i]!==keys[i])return null;const d=descriptor(value,keys[i]);if(!d||!hasOwn(d,'value')||!d.enumerable||d.writable||d.configurable)return null;out[keys[i]]=d.value;}return out;}catch{return null;}}
function capability(value,keys){const r=exact(value,keys);if(!r)return null;for(const key of keys)if(typeof r[key]!=='function'||isProxy(r[key]))return null;return r;}
function createGoogleOnboardingRuntimeAssembly(configuration,dependencies){
 const config=exact(configuration,CONFIG_KEYS),deps=exact(dependencies,DEP_KEYS);
 if(!config||!deps||config.tenantSlug!=='sunset'||config.locationId!=='sunset-somo'||!UUID.test(config.clientId)||config.endpointId!==ENDPOINT||config.applicationClientId!==APP||config.redirectUri!==REDIRECT||config.secretRef!==REF||config.startEnabled!==false||config.callbackEnabled!==false||config.authorityEnabled!==false)fail();
 for(const key of DEP_KEYS)if(!capability(deps[key],METHODS[key]))fail();
 // Construct the merged owners now, but invoke none. Internal owner readiness is
 // separate from this assembly's immutable activation flags.
 const startClock=freeze({now(...args){return Reflect.apply(deps.clock.now,deps.clock,args);}});
 const startRepository=freeze({create(...args){return Reflect.apply(deps.repository.create,deps.repository,args);}});
 const consumeRepository=freeze({consume(...args){return Reflect.apply(deps.repository.consume,deps.repository,args);}});
 const start=createGoogleOAuthStart(freeze({enabled:true,applicationClientId:APP,redirectUri:REDIRECT}),freeze({cryptography:deps.cryptography,clock:startClock,repository:startRepository}));
 const consume=createGoogleOAuthCallbackConsume(freeze({cryptography:freeze({sha256Ascii(...args){return Reflect.apply(deps.cryptography.sha256Ascii,deps.cryptography,args);}}),clock:startClock,repository:consumeRepository}));
 const transactionFactory=createGoogleTransactionCompletionFactory(freeze({https:deps.https,crypto:deps.crypto,timers:deps.timers,envelopeProvider:deps.envelopeProvider,clock:freeze({nowEpochSeconds:deps.clock.nowEpochSeconds}),installer:deps.installer}));
 const callback=createGoogleOAuthCallbackCompletion(freeze({applicationClientId:APP,redirectUri:REDIRECT,secretRef:REF}),freeze({callbackConsume:consume,secretProvider:deps.secretProvider,transactionCompletionFactory:transactionFactory}));
 // Keep authority operation-scoped because nonce is transaction-owned. Merely
 // pin its authentic factory/dependencies here; default-off prevents construction.
 const authorityDependencies=freeze({https:deps.https,timers:deps.timers,signatureVerifier:deps.signatureVerifier});
 if(!start||!callback||!authorityDependencies||typeof createGoogleMailboxAuthorityComposition!=='function')fail();
 const snapshot=freeze({tenantSlug:config.tenantSlug,clientId:config.clientId,locationId:config.locationId,endpointId:config.endpointId,applicationClientId:config.applicationClientId,redirectUri:config.redirectUri,secretRef:config.secretRef,startEnabled:false,callbackEnabled:false,authorityEnabled:false});
 function startOnboarding(){fail();} function completeOnboardingCallback(){fail();} function deriveMailboxAuthority(){fail();}
 return freeze({configuration:snapshot,startOnboarding,completeOnboardingCallback,deriveMailboxAuthority});
}
module.exports=freeze({createGoogleOnboardingRuntimeAssembly});
