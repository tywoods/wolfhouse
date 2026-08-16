'use strict';
const assert = require('node:assert/strict');
const nativeCrypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const OWNER_PATH = require.resolve('./lib/email-google-state-first-runtime-composition');
const CHILD_PATH = require.resolve('./lib/email-google-state-first-callback-runtime');
const freeze = Object.freeze;
const CLIENT = 'a1111111-bbbb-4ccc-8ddd-eeeeeeeeeee1';
const LOCATION = '11111111-2222-4333-8444-555555555555';
const ENDPOINT = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const OPERATION = '99999999-8888-4777-8666-555555555555';
const STAFF = 'abcdef01-2345-4678-89ab-cdef01234567';
const SESSION = '12345678-90ab-4cde-8fab-1234567890ab';
const APP = '9876543210-web_client.v2.apps.googleusercontent.com';
const REDIRECT = 'https://sunset-staging.lunafrontdesk.com/staff/email/google/callback';
const REF = 'secret-ref:email/google/oauth-client';
const STATE = Buffer.alloc(32, 7).toString('base64url');
const CODE = '4/OFFLINE_STATE_FIRST_CODE';
const VERIFIER = `${'V'.repeat(41)}-._~`;
const NONCE = `${'N'.repeat(42)}_`;
const SECRET = 'offline-client-secret';
const ACCESS = 'offline-access-token';
const REFRESH = 'offline-refresh-token';
const EMAIL = 'Owner.Case+Google@Example.COM';
const SUBJECT = 'Google-Subject_123';
const NOW_ISO = '2026-08-11T12:05:00.000Z';
const NOW = 1900000000;
const KID = 'offline-state-first-key';
const KEYS = freeze(['tenantSlug','locationKey','applicationClientId','redirectUri','callbackEnabled']);
const pair = nativeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { createGoogleOAuthTransactionRepository } = require('./lib/email-google-oauth-transaction-repository');
const { createVerifiedGrantInstaller } = require('./lib/email-verified-grant-installer');
const publicJwk = pair.publicKey.export({ format: 'jwk' });
function config(enabled=true) { return freeze({tenantSlug:'sunset',locationKey:'sunset-somo',applicationClientId:APP,redirectUri:REDIRECT,callbackEnabled:enabled}); }
function input() { return freeze({query:`state=${STATE}&code=${encodeURIComponent(CODE)}`}); }
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function token() {
  const atHash = nativeCrypto.createHash('sha256').update(ACCESS,'ascii').digest().subarray(0,16).toString('base64url');
  const signing = `${b64({alg:'RS256',kid:KID,typ:'JWT'})}.${b64({iss:'https://accounts.google.com',aud:APP,sub:SUBJECT,email:EMAIL,email_verified:true,nonce:NONCE,name:'Google Owner',exp:NOW+600,iat:NOW-10,at_hash:atHash})}`;
  return `${signing}.${nativeCrypto.sign('RSA-SHA256',Buffer.from(signing),pair.privateKey).toString('base64url')}`;
}
function response(status, body) { const r=new EventEmitter(); r.statusCode=status;r.headers={'content-type':'application/json'};r.destroy=()=>{};r.deliver=cb=>{cb(r);r.emit('data',Buffer.from(body));r.emit('end');r.emit('close');};return r; }
function harness(spec={}) {
  const calls={query:[],consume:[],secret:[],requests:[],crypto:[],timers:[],seal:[],install:[],open:0,rewrap:0};
  const db=freeze({query(sql,values){calls.query.push({sql,values,receiver:this});
    if(/UPDATE tenant_email_google_oauth_transactions/.test(sql))return Promise.resolve(freeze({rows:freeze([freeze({client_id:CLIENT,auth_session_id:SESSION,operation_id:OPERATION,location_id:LOCATION,endpoint_id:ENDPOINT,staff_user_id:STAFF,code_verifier:VERIFIER,nonce:NONCE})])}));
    if(/SELECT id, client_id, location_id, channel/.test(sql))return Promise.resolve(freeze({rows:freeze([freeze({id:ENDPOINT,client_id:CLIENT,location_id:LOCATION,channel:'email',provider:'gmail_api',secret_ref:REF,active:true})])}));
    if(/^BEGIN|^COMMIT|^ROLLBACK/.test(sql))return Promise.resolve({rows:[]});
    if(/FOR UPDATE/.test(sql))return Promise.resolve({rows:[{id:ENDPOINT,client_id:CLIENT,provider:'gmail_api',auth_mode:'delegated_authorization_code',connector_mode:'google_delegated_oauth',binding_status:'unverified_offline',public_address:EMAIL}]});
    if(/UPDATE tenant_channel_endpoints/.test(sql))return Promise.resolve({rows:[{id:ENDPOINT,client_id:CLIENT,binding_status:'verified',provider_tenant_id:'https://accounts.google.com',provider_principal_oid:SUBJECT,provider_resource_id:SUBJECT,mailbox_kind:'user',mailbox_access_kind:'own_user',public_address:EMAIL}]});
    if(/INSERT INTO tenant_email_delegated_grants/.test(sql))return Promise.resolve({rows:[{client_id:CLIENT,endpoint_id:ENDPOINT,grant_generation:1,grant_status:'active',reconcile_state:'clean'}]});
    throw Error('unexpected authentic SQL');}});
  const cryptography=freeze({sha256Ascii(value){return nativeCrypto.createHash('sha256').update(value,'ascii').digest();}});
  const clock=freeze({now(){return NOW_ISO;},nowEpochSeconds(){return NOW;}});

  const realRepository=createGoogleOAuthTransactionRepository(freeze({queryOwner:db}));
  const repository=freeze({consume(dto){calls.consume.push({dto,receiver:this});return realRepository.consume(dto);}});
  const https=freeze({request(options,callback){const record={options,receiver:this};calls.requests.push(record);const req=new EventEmitter();req.destroy=()=>{};req.end=body=>{record.body=body;if(options.hostname==='oauth2.googleapis.com')response(200,JSON.stringify({access_token:ACCESS,expires_in:3600,refresh_token:REFRESH,scope:'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',token_type:'Bearer',id_token:token()})).deliver(callback);else if(options.path==='/oauth2/v3/certs')response(200,JSON.stringify({keys:[{...publicJwk,kid:KID,use:'sig',alg:'RS256'}]})).deliver(callback);else if(options.path==='/gmail/v1/users/me/profile')response(200,JSON.stringify({emailAddress:EMAIL,historyId:'123'})).deliver(callback);else throw Error('unexpected destination');};return req;}});
  const crypto=freeze({createPublicKey(value){calls.crypto.push('createPublicKey');return nativeCrypto.createPublicKey(value);},verify(...args){calls.crypto.push('verify');return nativeCrypto.verify(...args);}});
  const timers=freeze({setTimeout(callback,milliseconds){const h=freeze({callback,milliseconds});calls.timers.push(['set',milliseconds]);return h;},clearTimeout(handle){calls.timers.push(['clear',handle]);}});
  const envelope=freeze({envelope_version:'v1',aead_alg:'AES-256-GCM',kek_wrap_alg:'A256KW',kek_key_name:'offline-kek',kek_key_version:'v1-test-0001',nonce:Buffer.alloc(12,1),ciphertext:Buffer.alloc(32,2),auth_tag:Buffer.alloc(16,3),wrapped_dek:Buffer.alloc(40,4),operation_id:OPERATION});
  const envelopeProvider=freeze({async sealGrantPayload(value){calls.seal.push({value,receiver:this});return envelope;},async openGrantPayload(){calls.open++;throw Error('unused');},async rewrapGrantDek(){calls.rewrap++;throw Error('unused');}});
  const realInstaller=createVerifiedGrantInstaller(freeze({client:db}));
  const installer=freeze({async installVerifiedGrant(value){calls.install.push({value,receiver:this});return realInstaller.installVerifiedGrant(value);}});
  const secretProvider=freeze({resolveClientSecret(value){calls.secret.push({value,receiver:this});return Promise.resolve(freeze({clientSecret:SECRET}));}});
  return {calls,dependencies:freeze({db,cryptography,clock,repository,https,crypto,timers,envelopeProvider,installer,secretProvider}),owners:{db,repository,https,crypto,envelopeProvider,installer,secretProvider}};
}
function descriptors(value, keys) { for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);assert.ok(d);assert.equal(Object.hasOwn(d,'value'),true);assert.equal(d.enumerable,true);assert.equal(d.writable,false);assert.equal(d.configurable,false);} }
function clean(error){assert.equal(error.code,'GOOGLE_STATE_FIRST_RUNTIME_COMPOSITION_FAILED');assert.equal(error.stack,undefined);assert.equal(Object.isFrozen(error),true);return true;}
function freshWithChild(factory){delete require.cache[OWNER_PATH];const load=Module._load;Module._load=function(request,parent,isMain){if(parent&&parent.filename===OWNER_PATH&&require.resolve(request,{paths:[path.dirname(parent.filename)]})===CHILD_PATH)return freeze({createGoogleStateFirstCallbackRuntime:factory});return Reflect.apply(load,this,[request,parent,isMain]);};try{return require(OWNER_PATH);}finally{Module._load=load;delete require.cache[OWNER_PATH];}}
const tests=[];const test=(name,run)=>tests.push({name,run});
test('returns exact frozen public descriptors, configuration, and frozen wrapper function',()=>{const owner=require(OWNER_PATH),cfg=config(),h=harness(),r=owner.createGoogleStateFirstRuntimeComposition(cfg,h.dependencies);assert.deepEqual(Reflect.ownKeys(owner),['createGoogleStateFirstRuntimeComposition']);assert.equal(Object.isFrozen(owner),true);assert.deepEqual(Reflect.ownKeys(r),['configuration','completeCallback']);descriptors(r,['configuration','completeCallback']);assert.equal(Object.isFrozen(r),true);assert.equal(Object.isFrozen(r.completeCallback),true);assert.equal(Object.getPrototypeOf(r),Object.prototype);assert.deepEqual(Reflect.ownKeys(r.configuration),KEYS);descriptors(r.configuration,KEYS);assert.equal(Object.isFrozen(r.configuration),true);assert.deepEqual(r.configuration,cfg);assert.strictEqual(r.configuration,r.configuration);});
test('rejects hostile clientId in callback configuration before child construction',()=>{const h=harness();assert.throws(()=>require(OWNER_PATH).createGoogleStateFirstRuntimeComposition(freeze({...config(),clientId:CLIENT}),h.dependencies),clean);assert.equal(h.calls.query.length,0);});
test('rejects every hostile mixed child surface without getters or proxy traps',()=>{const cfg=config(),h=harness();let effects=0;const fn=freeze(function completeCallback(){effects++;});const goodConfig=cfg;const makers=[()=>({configuration:goodConfig,completeCallback:fn}),()=>freeze({configuration:goodConfig,completeCallback:fn,extra:1}),()=>freeze({completeCallback:fn,configuration:goodConfig}),()=>freeze(Object.assign(Object.create(null),{configuration:goodConfig,completeCallback:fn})),()=>{const x={completeCallback:fn};Object.defineProperty(x,'configuration',{enumerable:true,get(){effects++;throw Error('getter');}});return freeze(x);},()=>freeze({configuration:freeze({...goodConfig,extra:1}),completeCallback:fn}),()=>freeze({configuration:goodConfig,completeCallback:new Proxy(fn,{apply(){effects++;throw Error('trap');}})}),()=>new Proxy(freeze({configuration:goodConfig,completeCallback:fn}),{ownKeys(){effects++;throw Error('trap');},getPrototypeOf(){effects++;throw Error('trap');}}),()=>{const x=freeze({configuration:goodConfig,completeCallback:fn,[Symbol('x')]:1});return x;}];for(const make of makers){const child=make();const childFactory=freeze(function create(){return child;});const owner=freshWithChild(childFactory);assert.throws(()=>owner.createGoogleStateFirstRuntimeComposition(cfg,h.dependencies),clean);}assert.equal(effects,0);});
test('authentic consume, SQL authority, token/JWKS/profile, crypto, envelope and installer complete once',async()=>{const owner=require(OWNER_PATH),h=harness(),r=owner.createGoogleStateFirstRuntimeComposition(config(),h.dependencies);const out=await r.completeCallback(input());assert.deepEqual(out,{status:'received'});assert.equal(Object.isFrozen(out),true);assert.equal(h.calls.consume.length,1);assert.deepEqual(h.calls.consume[0].dto,{stateHash:nativeCrypto.createHash('sha256').update(STATE,'ascii').digest('hex'),consumedAt:NOW_ISO});assert.equal(h.calls.consume[0].receiver,h.owners.repository);assert.equal(h.calls.query.filter(x=>/SELECT id, client_id, location_id, channel/.test(x.sql)).length,1);assert.deepEqual(h.calls.query.find(x=>/SELECT id, client_id, location_id, channel/.test(x.sql)).values,[ENDPOINT,CLIENT,LOCATION]);assert.equal(h.calls.query[0].receiver,h.owners.db);assert.deepEqual(h.calls.secret.map(x=>x.value),[{secretRef:REF}]);assert.equal(h.calls.secret[0].receiver,h.owners.secretProvider);assert.equal(h.calls.requests.length,3);assert.deepEqual(h.calls.requests.map(x=>[x.options.hostname,x.options.path]),[['oauth2.googleapis.com','/token'],['www.googleapis.com','/oauth2/v3/certs'],['www.googleapis.com','/gmail/v1/users/me/profile']]);assert.deepEqual(h.calls.crypto,['createPublicKey','verify']);assert.equal(h.calls.seal.length,1);assert.equal(h.calls.install.length,1);assert.equal(h.calls.install[0].receiver,h.owners.installer);assert.equal(h.calls.open,0);assert.equal(h.calls.rewrap,0);const installed=h.calls.install[0].value;assert.deepEqual(Reflect.ownKeys(installed),['clientId','endpointId','operationId','actorStaffUserId','identity','envelope']);for(const leak of [SECRET,ACCESS,REFRESH,CODE,REF])assert.equal(JSON.stringify(installed).includes(leak),false);});
test('source stays unwired and composes exactly three authentic children',()=>{const s=fs.readFileSync(OWNER_PATH,'utf8');for(const x of ['email-google-state-first-callback-runtime','email-google-consumed-endpoint-authority-resolver','email-google-transaction-completion-factory'])assert.equal((s.match(new RegExp(x,'g'))||[]).length,1);for(const x of ['process.','express','locationId:','endpointId:','secretRef:'])assert.equal(s.includes(x),false);});
(async()=>{let n=0;for(const t of tests){await t.run();process.stdout.write(`ok ${++n} - ${t.name}\n`);}process.stdout.write(`1..${n}\nPASS verify:email-google-state-first-runtime-composition (${n} named offline tests)\n`);})().catch(e=>{process.stderr.write(`${e.stack||e}\n`);process.exitCode=1;});
