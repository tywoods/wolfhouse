'use strict';
const assert=require('assert');
const exchange=require('./lib/email-microsoft-authorization-code-exchange');
const tx=require('./lib/email-microsoft-oauth-transaction-service');
const {createStaffEmailOAuthRoutes}=require('./lib/staff-email-oauth-routes');
const env={LUNA_EMAIL_OAUTH_TOKEN_EXCHANGE_ENABLED:'true',LUNA_EMAIL_OAUTH_CALLBACK_ENABLED:'true',LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_OAUTH_CLIENT_ID:'55555555-5555-5555-5555-555555555555'};
const code='opaque-provider-code';
const verifier='v'.repeat(43);
const credential='credential-value-never-return';
const access='access-value-never-return';
const refresh='refresh-value-never-return';
const ok=()=>({statusCode:200,headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify({token_type:'Bearer',expires_in:3600,access_token:access,refresh_token:refresh,scope:'openid offline_access'})});
function service(handler=async()=>ok(), overrides={}) {
  return exchange.createMicrosoftAuthorizationCodeExchange({
    httpClient:{request:handler}, clientSecretProvider:{getClientSecret:async()=>credential}, env:{...env,...overrides},
  });
}
(async()=>{
  for(const value of [undefined,'TRUE','1',true]) assert.strictEqual(exchange.isTokenExchangeEnabled({LUNA_EMAIL_OAUTH_TOKEN_EXCHANGE_ENABLED:value}),false);
  let request;
  const result=await service(async r=>{request=r;return ok();}).exchange({code,codeVerifier:verifier});
  assert.deepStrictEqual(result,{status:'exchanged'});
  assert.deepStrictEqual(Object.keys(result),['status']);
  assert.strictEqual(request.url,'https://login.microsoftonline.com/organizations/oauth2/v2.0/token');
  assert.strictEqual(request.method,'POST');
  assert.deepStrictEqual(request.headers,{'content-type':'application/x-www-form-urlencoded',accept:'application/json'});
  assert.strictEqual(request.timeoutMs,5000); assert.strictEqual(request.maxResponseBytes,65536);
  const form=new URLSearchParams(request.body);
  assert.deepStrictEqual(Array.from(form.keys()),['client_id','client_secret','grant_type','code','redirect_uri','code_verifier']);
  assert.strictEqual(form.get('client_id'),env.LUNA_EMAIL_OAUTH_CLIENT_ID);
  assert.strictEqual(form.get('client_secret'),credential); assert.strictEqual(form.get('grant_type'),'authorization_code');
  assert.strictEqual(form.get('code'),code); assert.strictEqual(form.get('redirect_uri'),'https://sunset-staging.lunafrontdesk.com/staff/email/oauth/microsoft/callback'); assert.strictEqual(form.get('code_verifier'),verifier);
  assert.ok(!JSON.stringify(result).includes(access) && !JSON.stringify(result).includes(refresh) && !JSON.stringify(result).includes(credential));
  for(const hostile of [
    {code,codeVerifier:verifier,url:'http://attacker'}, {code:'bad\ncode',codeVerifier:verifier},
    {code,codeVerifier:'short'}, Object.assign(Object.create({code}),{codeVerifier:verifier}), null,
  ]) await assert.rejects(()=>service().exchange(hostile),/^Error: oauth_token_exchange_failed$/);
  const failures=[
    async()=>{throw new Error(`timeout ${credential}`);},
    async()=>({...ok(),body:'x'.repeat(65537)}),
    async()=>({...ok(),body:'{' }),
    async()=>({...ok(),headers:{'content-type':'text/html'}}),
    async()=>({statusCode:400,headers:{'content-type':'application/json'},body:JSON.stringify({error:'invalid_grant',error_description:`provider ${access}`})}),
    async()=>({statusCode:200,headers:{'content-type':'application/json'},body:JSON.stringify({token_type:'bearer',expires_in:3600,access_token:access,refresh_token:refresh})}),
    async()=>({statusCode:200,headers:{'content-type':'application/json'},body:JSON.stringify({token_type:'Bearer',expires_in:3600,access_token:access})}),
  ];
  for(const handler of failures) await assert.rejects(()=>service(handler).exchange({code,codeVerifier:verifier}),e=>e.message==='oauth_token_exchange_failed'&&!String(e).includes(access)&&!String(e).includes(credential));
  await assert.rejects(()=>service(async()=>ok(),{LUNA_EMAIL_OAUTH_TOKEN_EXCHANGE_ENABLED:'TRUE'}).exchange({code,codeVerifier:verifier}),/disabled/);

  let consumed=0, exchanged=0, seen;
  const callback=tx.createMicrosoftOAuthCallbackService({env,repository:{consume:async()=>{consumed++;return consumed===1?{code_verifier:verifier}:null;}},tokenExchange:{exchange:async input=>{exchanged++;seen=input;return {status:'exchanged'};}}});
  const state=Buffer.alloc(32,3).toString('base64url');
  assert.deepStrictEqual(await callback.accept({state,code},{clientId:'11111111-1111-1111-1111-111111111111',authSessionId:'44444444-4444-4444-4444-444444444444'}),{status:'authorization_exchanged'});
  assert.deepStrictEqual(seen,{code,codeVerifier:verifier});
  assert.deepStrictEqual(await callback.accept({state,code},{clientId:'11111111-1111-1111-1111-111111111111',authSessionId:'44444444-4444-4444-4444-444444444444'}),{status:'invalid_or_expired'});
  assert.strictEqual(exchanged,1);
  let terminalConsumes=0;
  const failed=tx.createMicrosoftOAuthCallbackService({env,repository:{consume:async()=>{terminalConsumes++;return terminalConsumes===1?{code_verifier:verifier}:null;}},tokenExchange:{exchange:async()=>{throw new Error(`remote ${refresh}`);}}});
  await assert.rejects(()=>failed.accept({state,code},{clientId:'11111111-1111-1111-1111-111111111111',authSessionId:'44444444-4444-4444-4444-444444444444'}));
  assert.deepStrictEqual(await failed.accept({state,code},{clientId:'11111111-1111-1111-1111-111111111111',authSessionId:'44444444-4444-4444-4444-444444444444'}),{status:'invalid_or_expired'});

  // Full callback seam: consume happens before exchange; any provider detail is
  // reduced to the same terminal page, and no second exchange is possible.
  let dbCalls=0, httpCalls=0;
  const route=createStaffEmailOAuthRoutes({runtimeEnv:env,sendJSON(){throw new Error('not used');},
    oauthClientSecretProvider:{getClientSecret:async()=>credential},
    oauthTokenHttpClient:{request:async()=>{httpCalls++;throw new Error(`provider ${access}`);}},
    withPgClient:fn=>fn({query:async()=>{dbCalls++;return {rows:dbCalls===1?[{id:'tx',code_verifier:verifier}]:[]};}})});
  function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.body=v;}};}
  const user={client_slug:'sunset',client_id:'11111111-1111-1111-1111-111111111111',session_id:'44444444-4444-4444-4444-444444444444'};
  let page=response(); await route.handleCallback({state,code},null,page,user);
  assert.strictEqual(page.statusCode,400); assert.match(page.body,/could not be accepted/i);
  assert.ok(!page.body.includes(access)&&!page.body.includes(credential)&&!page.body.includes(code)&&!page.body.includes(verifier));
  page=response(); await route.handleCallback({state,code},null,page,user);
  assert.strictEqual(page.statusCode,400); assert.strictEqual(httpCalls,1); assert.strictEqual(dbCalls,2);

  const source=require('fs').readFileSync(require.resolve('./lib/email-microsoft-authorization-code-exchange'),'utf8');
  assert.ok(!/graph\.microsoft|\/sendMail|console\.|require\(['"]https?['"]\)/i.test(source));
  console.log('PASS Microsoft authorization-code exchange hostile offline gates');
})().catch(e=>{console.error(e);process.exit(1);});