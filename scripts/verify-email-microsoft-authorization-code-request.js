'use strict';
const assert = require('node:assert/strict');
const { REDIRECT_URI } = require('./lib/email-microsoft-oauth-transaction-service');
const { FAILURE_CODE, SUNSET_DEPLOYMENT, createMicrosoftAuthorizationCodeRequestService } = require('./lib/email-microsoft-authorization-code-request');
const CLIENT_ID = '12345678-1234-4234-8234-123456789abc';
const CODE = 'code+/%?=&NEVER_LEAK';
const VERIFIER = 'A'.repeat(42) + '~';
const SECRET = 'secret+/%?=&NEVER_LEAK';
const ACK = Object.freeze({ status: 'custodied' });
function frozenMethod(name, fn) { return Object.freeze({ [name]: fn }); }
function deps(provider, custody, patch = {}) { return { deployment:SUNSET_DEPLOYMENT, applicationClientId:CLIENT_ID, secretProvider:provider, responseCustody:custody, ...patch }; }
function input(patch = {}) { return { authorizationCode:CODE, codeVerifier:VERIFIER, clientId:CLIENT_ID, ...patch }; }
async function mustFail(action) {
  await assert.rejects(action, (error) => error.code === FAILURE_CODE && error.message === FAILURE_CODE
    && !String(error).includes('NEVER_LEAK') && !JSON.stringify(error).includes('NEVER_LEAK'));
}
async function main() {
  const logged=[]; const log=console.log; const error=console.error; console.log=console.error=(...v)=>logged.push(v);
  try {
    let providerThis=false; let downstreamThis=false; let providerCalls=0; let captured;
    const provider={ getClientSecret: async function(){ providerCalls++; providerThis=this===provider; return SECRET; } };
    const custody=frozenMethod('exchangeAndCustody', async function(arg){ downstreamThis=this===custody; captured=arg; return ACK; });
    const result=await createMicrosoftAuthorizationCodeRequestService(deps(provider,custody)).exchangeAuthorizationCode(input());
    assert.deepEqual(result,{status:'custodied'}); assert.equal(Object.isFrozen(result),true);
    assert.equal(providerThis,true); assert.equal(downstreamThis,true); assert.deepEqual(Reflect.ownKeys(captured),['body']);
    assert.equal(typeof captured.body,'string');
    assert.equal(captured.body,`client_id=${CLIENT_ID}&client_secret=secret%2B%2F%25%3F%3D%26NEVER_LEAK&grant_type=authorization_code&code=code%2B%2F%25%3F%3D%26NEVER_LEAK&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_verifier=${VERIFIER.slice(0, -1)}%7E`);
    assert.deepEqual([...new URLSearchParams(captured.body)], [['client_id',CLIENT_ID],['client_secret',SECRET],['grant_type','authorization_code'],['code',CODE],['redirect_uri',REDIRECT_URI],['code_verifier',VERIFIER]]);
    assert.equal(new URLSearchParams(captured.body).has('scope'),false);

    for (const bad of [null, [], {}, {...input(), extra:true}, {...input(), clientId:'22345678-1234-4234-8234-123456789abc'}, {...input(), authorizationCode:''}, {...input(), authorizationCode:'bad\n'}, {...input(), codeVerifier:'short'}, Object.create(null)]) {
      providerCalls=0; await mustFail(()=>createMicrosoftAuthorizationCodeRequestService(deps(provider,custody)).exchangeAuthorizationCode(bad)); assert.equal(providerCalls,0);
    }
    const accessor={ codeVerifier:VERIFIER, clientId:CLIENT_ID }; Object.defineProperty(accessor,'authorizationCode',{enumerable:true,get(){throw new Error(CODE);}});
    await mustFail(()=>createMicrosoftAuthorizationCodeRequestService(deps(provider,custody)).exchangeAuthorizationCode(accessor));
    await mustFail(()=>createMicrosoftAuthorizationCodeRequestService(deps(provider,custody)).exchangeAuthorizationCode(new Proxy(input(),{getPrototypeOf(){throw new Error(CODE);}})));
    for(const secret of ['', 'bad\nsecret', 'x'.repeat(4097), 7]) await mustFail(()=>createMicrosoftAuthorizationCodeRequestService(deps(frozenMethod('getClientSecret',async()=>secret),custody)).exchangeAuthorizationCode(input()));
    await mustFail(()=>createMicrosoftAuthorizationCodeRequestService(deps(frozenMethod('getClientSecret',async()=>{throw new Error(SECRET);}),custody)).exchangeAuthorizationCode(input()));
    await mustFail(()=>createMicrosoftAuthorizationCodeRequestService(deps(provider,frozenMethod('exchangeAndCustody',async()=>{throw new Error(CODE+SECRET);}))).exchangeAuthorizationCode(input()));
    await mustFail(()=>createMicrosoftAuthorizationCodeRequestService(deps(provider,frozenMethod('exchangeAndCustody',async()=>({status:'custodied'})))).exchangeAuthorizationCode(input()));

    for(const hostile of [null, {}, deps(provider,custody,{deployment:'production'}), deps(provider,custody,{applicationClientId:'bad'}), deps(provider,{exchangeAndCustody:async()=>ACK}), new Proxy({}, {getPrototypeOf(){throw new Error(SECRET);}})]) {
      assert.throws(()=>createMicrosoftAuthorizationCodeRequestService(hostile),(e)=>e.code===FAILURE_CODE&&!String(e).includes('NEVER_LEAK'));
    }
    let release; const waiting=new Promise(resolve=>{release=resolve;});
    const concurrent=createMicrosoftAuthorizationCodeRequestService(deps(frozenMethod('getClientSecret',async()=>{await waiting; return SECRET;}),custody));
    const first=concurrent.exchangeAuthorizationCode(input()); await mustFail(()=>concurrent.exchangeAuthorizationCode(input())); release(); await first;
    assert.deepEqual(logged,[]);
  } finally { console.log=log; console.error=error; }
  log('verify:email-microsoft-authorization-code-request: ok');
}
main().catch((e)=>{console.error(e);process.exitCode=1;});
