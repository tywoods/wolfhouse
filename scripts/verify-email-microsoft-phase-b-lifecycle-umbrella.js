'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, 'lib');
const umbrellaPath = path.resolve(process.env.PHASE_B_UMBRELLA_PATH || path.join(LIB, 'email-microsoft-reauthorization-lifecycle.js'));
const txPath = path.join(path.dirname(umbrellaPath), 'email-microsoft-phase-b-reauthorization-transaction-service.js');
const callbackPath = path.join(path.dirname(umbrellaPath), 'email-microsoft-phase-b-oauth-callback-completion.js');
if (process.env.PHASE_B_EXPECT_UMBRELLA_PATH) assert.strictEqual(umbrellaPath, path.resolve(process.env.PHASE_B_EXPECT_UMBRELLA_PATH));
const before = new Set(Object.keys(require.cache));
const tx = require(txPath);
const callback = require(callbackPath);
assert(require.cache[umbrellaPath], `umbrella not loaded: ${umbrellaPath}`);
assert(before.has(umbrellaPath) || Object.keys(require.cache).includes(umbrellaPath));

const TX_KEYS = ['AUTHORITY','REDIRECT_URI','PHASE_B_SCOPES','TTL_SECONDS','INPUT_KEYS','AUTHORIZATION_INTENT','SCOPE_VERSION','START_ENABLED_ENV','SQL_CREATE_PHASE_B_REAUTH','asCanonGen','isStartEnabled','validateRuntime','createPostgresPhaseBReauthTransactionRepository','createMicrosoftPhaseBReauthorizationTransactionService'];
const CB_KEYS = ['ERROR_CODE','ERROR_MESSAGE','ACCEPT_METHOD','COMPLETION_METHOD','COMPLETION_ACK_STATUS','OUTCOME_UNKNOWN','CALLBACK_ENABLED_ENV','SUNSET_DEPLOYMENT','PUBLIC_STATUS_INVALID','PUBLIC_STATUS_DECLINED','PUBLIC_STATUS_RECEIVED','PUBLIC_STATUS_UNAVAILABLE','PUBLIC_STATUS_OUTCOME_UNKNOWN','DEPENDENCY_KEYS','CONSUME_ROW_KEYS','COMPLETION_KEYS','OWNER_KEYS','CALLBACK_CODE_KEYS','CALLBACK_ERROR_KEYS','SQL_CONSUME_PHASE_B_TRANSACTION','AUTHORIZATION_INTENT','SCOPE_VERSION','isCallbackEnabled','createPostgresPhaseBOauthTransactionConsumer','createMicrosoftPhaseBOauthCallbackCompletionService'];
assert.deepStrictEqual(Reflect.ownKeys(tx), TX_KEYS);
assert.deepStrictEqual(Reflect.ownKeys(callback), CB_KEYS);
assert.deepStrictEqual(TX_KEYS.map(k => typeof tx[k]), ['string','string','string','number','object','string','string','string','string','function','function','function','function','function']);
assert.deepStrictEqual(CB_KEYS.map(k => typeof callback[k]), ['string','string','string','string','string','string','string','string','object','object','object','object','object','object','object','object','object','object','object','string','string','string','function','function','function']);
assert.strictEqual(crypto.createHash('sha256').update(JSON.stringify({tx:[tx.AUTHORITY,tx.REDIRECT_URI,tx.PHASE_B_SCOPES,tx.TTL_SECONDS,tx.INPUT_KEYS,tx.AUTHORIZATION_INTENT,tx.SCOPE_VERSION,tx.START_ENABLED_ENV],cb:[callback.ERROR_CODE,callback.ERROR_MESSAGE,callback.ACCEPT_METHOD,callback.COMPLETION_METHOD,callback.COMPLETION_ACK_STATUS,callback.OUTCOME_UNKNOWN,callback.CALLBACK_ENABLED_ENV,callback.SUNSET_DEPLOYMENT,callback.DEPENDENCY_KEYS,callback.CONSUME_ROW_KEYS,callback.COMPLETION_KEYS,callback.OWNER_KEYS,callback.CALLBACK_CODE_KEYS,callback.CALLBACK_ERROR_KEYS,callback.AUTHORIZATION_INTENT,callback.SCOPE_VERSION]})).digest('hex'), '9d31d9a16cb2fd314eac9ed510a3112c15e73243ff4a2e4f396c07e0bbd65b23');

const ids = {clientId:'11111111-1111-4111-8111-111111111111',locationId:'22222222-2222-4222-8222-222222222222',endpointId:'33333333-3333-4333-8333-333333333333',staffUserId:'44444444-4444-4444-8444-444444444444',authSessionId:'55555555-5555-4555-8555-555555555555'};
const input = {...ids, expectedPriorGrantGeneration:'7'};
const now = new Date('2026-08-13T12:00:00.000Z');

async function main() {
  // Public transaction repository façade: exact static SQL and positional bytes.
  const txDbCalls=[];
  const txRepo=tx.createPostgresPhaseBReauthTransactionRepository({query:async (...a)=>{txDbCalls.push(a);return {rows:[{expires_at:new Date(now.getTime()+600000),prior_grant_generation:'7',authorization_intent:tx.AUTHORIZATION_INTENT,scope_version:tx.SCOPE_VERSION}]};}});
  const stateHash=Buffer.alloc(32,9), issuedAt=now, expiresAt=new Date(now.getTime()+600000);
  await txRepo.create({...ids,stateHash,codeVerifier:'v'.repeat(43),nonce:'n'.repeat(43),issuedAt,expiresAt,expectedPriorGrantGeneration:'7'});
  assert.strictEqual(txDbCalls.length,1); assert.strictEqual(txDbCalls[0][0],tx.SQL_CREATE_PHASE_B_REAUTH);
  assert.deepStrictEqual(txDbCalls[0][1],[ids.clientId,ids.locationId,ids.staffUserId,ids.authSessionId,ids.endpointId,stateHash,'v'.repeat(43),'n'.repeat(43),issuedAt,expiresAt,'7']);
  assert(!/\$\{/.test(tx.SQL_CREATE_PHASE_B_REAUTH));

  // Public transaction service façade: deterministic random/clock and ownership witness.
  const rows=[]; let randomCall=0;
  const repository={create:async row=>{rows.push(row);}};
  const service=tx.createMicrosoftPhaseBReauthorizationTransactionService({repository,env:{LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED:'true',LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_OAUTH_CLIENT_ID:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'},randomBytes:n=>Buffer.alloc(n,++randomCall),now:()=>now});
  const dto=await service.start(input);
  assert.strictEqual(rows.length,1); assert.strictEqual(randomCall,3); assert.strictEqual(rows[0].expiresAt.getTime()-rows[0].issuedAt.getTime(),600000);
  assert.strictEqual(rows[0].expectedPriorGrantGeneration,'7'); assert(Buffer.isBuffer(rows[0].stateHash));
  assert.deepStrictEqual(Reflect.ownKeys(dto),['authorization_url','expires_at','authorization_intent','scope_version','prior_grant_generation']);
  const u=new URL(dto.authorization_url); const state=Buffer.alloc(32,1).toString('base64url'), nonce=Buffer.alloc(32,2).toString('base64url'), verifier=Buffer.alloc(32,3).toString('base64url');
  assert.strictEqual(u.origin+u.pathname,tx.AUTHORITY); assert.strictEqual(u.searchParams.get('client_id'),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); assert.strictEqual(u.searchParams.get('redirect_uri'),tx.REDIRECT_URI); assert.strictEqual(u.searchParams.get('scope'),tx.PHASE_B_SCOPES); assert.strictEqual(u.searchParams.get('state'),state); assert.strictEqual(u.searchParams.get('nonce'),nonce); assert.strictEqual(u.searchParams.get('code_challenge'),crypto.createHash('sha256').update(verifier,'ascii').digest('base64url')); assert.strictEqual(u.searchParams.get('code_challenge_method'),'S256'); assert.strictEqual(u.searchParams.get('prompt'),'consent'); assert(!JSON.stringify(dto).includes(verifier));
  for (const [env,bad] of [[{...service.env},input],[{LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED:'false',LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_OAUTH_CLIENT_ID:ids.clientId},input],[{LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED:'true',LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_OAUTH_CLIENT_ID:ids.clientId},{...input,extra:true}]]) { let calls=0; const s=tx.createMicrosoftPhaseBReauthorizationTransactionService({repository:{create:async()=>{calls++;}},env,randomBytes:n=>Buffer.alloc(n,1),now:()=>now}); await assert.rejects(()=>s.start(bad)); assert.strictEqual(calls,0); }

  // Public callback consumer façade: exact static SQL and params.
  const cbDbCalls=[]; const returnedRow={id:ids.clientId,location_id:ids.locationId,staff_user_id:ids.staffUserId,code_verifier:'v'.repeat(43),nonce:'n'.repeat(43),endpoint_id:ids.endpointId,authorization_intent:callback.AUTHORIZATION_INTENT,scope_version:callback.SCOPE_VERSION,prior_grant_generation:'7'};
  const consumer=callback.createPostgresPhaseBOauthTransactionConsumer({query:async(...a)=>{cbDbCalls.push(a);return {rows:[returnedRow]};}});
  assert.strictEqual(await consumer.consume({stateHash,clientId:ids.clientId,authSessionId:ids.authSessionId,now}),returnedRow);
  assert.deepStrictEqual(cbDbCalls,[[callback.SQL_CONSUME_PHASE_B_TRANSACTION,[stateHash,ids.clientId,ids.authSessionId,now]]]); assert(!/\$\{/.test(callback.SQL_CONSUME_PHASE_B_TRANSACTION));

  // Public callback completion façade: consume precedes the sole operation; telemetry order is exact.
  const order=[]; const repo=Object.freeze({consume:async row=>{order.push(['consume',row]); return returnedRow;}}); const completion=Object.freeze({completeAuthorization:async row=>{order.push(['operation',row]); return Object.freeze({status:'completed'});}}); const clock=Object.freeze({now:()=>now});
  const env=Object.freeze({LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_OAUTH_CLIENT_ID:ids.clientId,LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED:'true'});
  const svc=callback.createMicrosoftPhaseBOauthCallbackCompletionService(Object.freeze({repository:repo,completion,env,clock}));
  const result=await svc.accept({state,code:'secret-code'},{clientId:ids.clientId,authSessionId:ids.authSessionId});
  assert.deepStrictEqual(result,{status:'authorization_received'}); assert.deepStrictEqual(order.map(x=>x[0]),['consume','operation']); assert.strictEqual(order[0][1].clientId,ids.clientId); assert.strictEqual(order[0][1].authSessionId,ids.authSessionId); assert.deepStrictEqual(Reflect.ownKeys(order[1][1]),callback.COMPLETION_KEYS); assert.strictEqual(order[1][1].expectedPriorGrantGeneration,'7'); assert(!JSON.stringify(result).includes('secret-code')); await assert.rejects(()=>svc.accept({state,code:'secret-code'},{clientId:ids.clientId,authSessionId:ids.authSessionId})); assert.strictEqual(order.length,2);

  // A consumed no-match is the exact frozen invalid singleton and never reaches completion.
  const noRowOrder=[]; let noRowConsumes=0, noRowOps=0;
  const noRowSvc=callback.createMicrosoftPhaseBOauthCallbackCompletionService(Object.freeze({
    repository:Object.freeze({consume:async()=>{noRowConsumes++; noRowOrder.push('consume'); return null;}}),
    completion:Object.freeze({completeAuthorization:async()=>{noRowOps++; noRowOrder.push('operation'); return Object.freeze({status:'completed'});}}),
    env, clock,
    stageTelemetry:Object.freeze({emit:event=>{noRowOrder.push(event);}}),
  }));
  const noRowResult=await noRowSvc.accept({state,code:'no-row-secret-code'},{clientId:ids.clientId,authSessionId:ids.authSessionId});
  assert.strictEqual(noRowResult,callback.PUBLIC_STATUS_INVALID);
  assert.deepStrictEqual(noRowResult,{status:'invalid_or_expired'}); assert(Object.isFrozen(noRowResult));
  assert.deepStrictEqual([noRowConsumes,noRowOps],[1,0]);
  assert.deepStrictEqual(noRowOrder,['phase_b_owner_validated','phase_b_input_validated','phase_b_state_hashed','phase_b_clock_validated','phase_b_consume_started','consume','phase_b_consume_returned','callback_failed']);
  assert(!JSON.stringify(noRowResult).includes('no-row-secret-code'));
  let replayError; try { await noRowSvc.accept({state,code:'no-row-secret-code'},{clientId:ids.clientId,authSessionId:ids.authSessionId}); } catch (e) { replayError=e; }
  assert(replayError); assert(!String(replayError && (replayError.stack || replayError.message || replayError)).includes('no-row-secret-code'));
  assert.deepStrictEqual([noRowConsumes,noRowOps],[1,0]);
  for (const mutation of [{authorization_intent:'wrong'},{scope_version:'phase_a_v2'},{prior_grant_generation:null}]) { let ops=0; const r=Object.freeze({consume:async()=>({...returnedRow,...mutation})}); const c=Object.freeze({completeAuthorization:async()=>{ops++; return Object.freeze({status:'completed'});}}); const s=callback.createMicrosoftPhaseBOauthCallbackCompletionService(Object.freeze({repository:r,completion:c,env,clock})); await assert.rejects(()=>s.accept({state,code:'secret-code'},{clientId:ids.clientId,authSessionId:ids.authSessionId})); assert.strictEqual(ops,0); }
  let disabledConsumes=0, disabledOps=0; const disabled=callback.createMicrosoftPhaseBOauthCallbackCompletionService(Object.freeze({repository:Object.freeze({consume:async()=>{disabledConsumes++;}}),completion:Object.freeze({completeAuthorization:async()=>{disabledOps++;}}),env:Object.freeze({...env,LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED:'false'}),clock})); assert.deepStrictEqual(await disabled.accept({state,code:'secret-code'},{clientId:ids.clientId,authSessionId:ids.authSessionId}),{status:'authorization_unavailable'}); assert.deepStrictEqual([disabledConsumes,disabledOps],[0,0]);

  const umbrellaSource=fs.readFileSync(umbrellaPath,'utf8'), txSource=fs.readFileSync(txPath,'utf8'), callbackSource=fs.readFileSync(callbackPath,'utf8');
  assert(!txSource.includes('transition-policy')); assert(!callbackSource.includes('transition-policy')); assert(umbrellaSource.includes('Symbol(')); assert.deepStrictEqual(Reflect.ownKeys(require(umbrellaPath)),['phaseBReauthorizationTransactionService','phaseBOauthCallbackCompletion']); for(const mod of [tx,callback]) assert(!Reflect.ownKeys(mod).some(k=>/registry|policy|operation|selector|engine|validator|predicate/i.test(String(k))));
  assert.strictEqual((umbrellaSource.match(/completeAuthorization/g)||[]).length>=1,true); assert(!/message.?content/i.test(umbrellaSource));
  console.log(`LOAD: ${umbrellaPath} sha256=${crypto.createHash('sha256').update(fs.readFileSync(umbrellaPath)).digest('hex')}`);
  console.log('PASS: behavioral Phase-B transaction/callback façades enter one private umbrella lifecycle authority');
}
main().catch(e=>{console.error(e && e.stack || e);process.exitCode=1;});
