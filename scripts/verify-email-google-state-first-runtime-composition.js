'use strict';
const assert = require('node:assert/strict');
const cryptoNode = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const owner = require('./lib/email-google-state-first-runtime-composition');
const { createGoogleStateFirstRuntimeComposition } = owner;
const freeze = Object.freeze;
const CLIENT = 'a1111111-bbbb-4ccc-8ddd-eeeeeeeeeee1';
const LOCATION = '11111111-2222-4333-8444-555555555555';
const ENDPOINT = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const OPERATION = '99999999-8888-4777-8666-555555555555';
const STAFF = 'abcdef01-2345-4678-89ab-cdef01234567';
const SESSION = '12345678-90ab-4cde-8fab-1234567890ab';
const STATE = Buffer.from(Array.from({length: 32}, (_, i) => i)).toString('base64url');
const CODE = 'private-code'; const VERIFIER = `${'V'.repeat(41)}-._~`; const NONCE = `${'N'.repeat(42)}_`;
const NOW = '2026-08-11T12:05:00.000Z';
const APP = '9876543210-web_client.v2.apps.googleusercontent.com';
const REDIRECT = 'https://staff-staging.lunafrontdesk.com/staff/email/google/callback';
const REF = 'secret-ref:email/google/oauth-client';
function config(enabled = true) { return freeze({ tenantSlug: 'sunset', clientId: CLIENT, locationKey: 'sunset-somo', applicationClientId: APP, redirectUri: REDIRECT, callbackEnabled: enabled }); }
function harness(spec = {}) {
  const calls = { query: [], sha: 0, now: 0, epoch: 0, consume: 0, https: 0, crypto: 0, timers: 0, envelope: 0, install: 0, secret: 0 };
  const db = freeze({ query(sql, values) { calls.query.push({sql, values, receiver: this}); const row = freeze({id: ENDPOINT, client_id: CLIENT, location_id: LOCATION, channel:'email', provider:'gmail_api', secret_ref:REF, active:true}); return Promise.resolve(freeze({rows: freeze([spec.badRow ? freeze({...row, location_id: STAFF}) : row])})); } });
  const cryptography = freeze({ sha256Ascii(value) { calls.sha++; return cryptoNode.createHash('sha256').update(value, 'ascii').digest(); } });
  const clock = freeze({ now() { calls.now++; return NOW; }, nowEpochSeconds() { calls.epoch++; throw Error('inert'); } });
  const repository = freeze({ consume() { calls.consume++; return freeze({operationId:OPERATION, locationId:LOCATION, endpointId:ENDPOINT, staffUserId:STAFF, codeVerifier:VERIFIER, nonce:NONCE}); } });
  const https = freeze({request(){calls.https++; throw Error('inert');}});
  const crypto = freeze({createPublicKey(){calls.crypto++; throw Error('inert');},verify(){calls.crypto++; throw Error('inert');}});
  const timers = freeze({setTimeout(){calls.timers++; throw Error('inert');},clearTimeout(){calls.timers++; throw Error('inert');}});
  const envelopeProvider = freeze({sealGrantPayload(){calls.envelope++; throw Error('inert');},openGrantPayload(){calls.envelope++; throw Error('inert');},rewrapGrantDek(){calls.envelope++; throw Error('inert');}});
  const installer = freeze({installVerifiedGrant(){calls.install++; throw Error('inert');}});
  const secretProvider = freeze({resolveClientSecret(){calls.secret++; throw Error('stop-after-secret-handoff');}});
  return { calls, dependencies: freeze({db,cryptography,clock,repository,https,crypto,timers,envelopeProvider,installer,secretProvider}) };
}
function clean(error) { assert.equal(error.code, 'GOOGLE_STATE_FIRST_RUNTIME_COMPOSITION_FAILED'); assert.equal(error.stack, undefined); assert.equal(Object.isFrozen(error), true); return true; }
const tests=[]; function test(name, run){tests.push({name,run});}
test('exports exact frozen owner and constructs exact inert surface/configuration',()=>{const h=harness(); const runtime=createGoogleStateFirstRuntimeComposition(config(),h.dependencies); assert.deepEqual(Reflect.ownKeys(owner),['createGoogleStateFirstRuntimeComposition']); assert.equal(Object.isFrozen(owner),true); assert.deepEqual(Reflect.ownKeys(runtime),['configuration','completeCallback']); assert.strictEqual(runtime.configuration, runtime.configuration); assert.deepEqual(Reflect.ownKeys(runtime.configuration),['tenantSlug','clientId','locationKey','applicationClientId','redirectUri','callbackEnabled']); assert.equal(Object.isFrozen(runtime),true); assert.deepEqual(h.calls,{query:[],sha:0,now:0,epoch:0,consume:0,https:0,crypto:0,timers:0,envelope:0,install:0,secret:0});});
test('rejects nonexact, reordered, accessor, proxy and weak dependency owners cleanly',()=>{const h=harness(); const d=h.dependencies; const bad=[{}, {...d}, freeze({...d,extra:1}), freeze({cryptography:d.cryptography,db:d.db,clock:d.clock,repository:d.repository,https:d.https,crypto:d.crypto,timers:d.timers,envelopeProvider:d.envelopeProvider,installer:d.installer,secretProvider:d.secretProvider}), freeze({...d,db:freeze({query(){},extra(){}})})]; for(const x of bad) assert.throws(()=>createGoogleStateFirstRuntimeComposition(config(),x),clean); let traps=0; assert.throws(()=>createGoogleStateFirstRuntimeComposition(new Proxy(config(),{ownKeys(){traps++;throw Error('x')}}),d),clean); assert.equal(traps,0); const a={...config()}; Object.defineProperty(a,'clientId',{enumerable:true,get(){traps++;throw Error('x')}}); freeze(a); assert.throws(()=>createGoogleStateFirstRuntimeComposition(a,d),clean); assert.equal(traps,0);});
test('disabled dispatch fails authentically before every capability',()=>{const h=harness(); const r=createGoogleStateFirstRuntimeComposition(config(false),h.dependencies); assert.throws(()=>r.completeCallback(freeze({tenantSlug:'sunset',clientId:CLIENT,authSessionId:SESSION,query:`code=${CODE}&state=${STATE}`})),e=>e.code==='GOOGLE_STATE_FIRST_CALLBACK_DISABLED'); assert.deepEqual(h.calls.query,[]); assert.equal(h.calls.consume,0);});
test('real consume and SQL resolver use only consumed tuple then hand resolver secret to real factory',async()=>{const h=harness(); const r=createGoogleStateFirstRuntimeComposition(config(),h.dependencies); await assert.rejects(Promise.resolve(r.completeCallback(freeze({tenantSlug:'sunset',clientId:CLIENT,authSessionId:SESSION,query:`code=${CODE}&state=${STATE}`}))),e=>e.code==='GOOGLE_STATE_FIRST_CALLBACK_FAILED'); assert.equal(h.calls.consume,1); assert.equal(h.calls.query.length,1); assert.deepEqual(h.calls.query[0].values,[ENDPOINT,CLIENT,LOCATION]); assert.equal(h.calls.secret,1); assert.equal(h.calls.https,0);});
test('resolver mismatch fails before secret/provider and external effects',async()=>{const h=harness({badRow:true}); const r=createGoogleStateFirstRuntimeComposition(config(),h.dependencies); await assert.rejects(Promise.resolve(r.completeCallback(freeze({tenantSlug:'sunset',clientId:CLIENT,authSessionId:SESSION,query:`code=${CODE}&state=${STATE}`}))),e=>e.code==='GOOGLE_STATE_FIRST_CALLBACK_FAILED'); assert.equal(h.calls.query.length,1); assert.equal(h.calls.secret,0); assert.equal(h.calls.https,0);});
test('source is unwired and composes exactly authentic three children',()=>{const s=fs.readFileSync(path.join(__dirname,'lib/email-google-state-first-runtime-composition.js'),'utf8'); for(const x of ['email-google-state-first-callback-runtime','email-google-consumed-endpoint-authority-resolver','email-google-transaction-completion-factory']) assert.equal((s.match(new RegExp(x,'g'))||[]).length,1); for(const x of ['process.','pg','express','locationId:','endpointId:','secretRef:']) assert.equal(s.includes(x),false);});
(async()=>{let passed=0;for(const t of tests){await t.run();passed++;console.log(`ok ${passed} - ${t.name}`);}console.log(`1..${passed}`);console.log(`email google state-first runtime composition verification passed (${passed} tests)`);})().catch(e=>{console.error(e);process.exitCode=1;});
