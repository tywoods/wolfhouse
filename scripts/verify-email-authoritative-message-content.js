'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const scope = require('./lib/email-microsoft-content-read-scope');
const { normalizeAuthoritativeMessageContent } = require('./lib/email-authoritative-content-normalizer');
const { createMicrosoftGraphMessageContentTransport } = require('./lib/email-microsoft-graph-message-content-transport');
const { createAuthorityBoundCurrentMessageContentOperation, EMAIL_AUTHORITY_BOUND_CURRENT_MESSAGE_CONTENT_RUNTIME_WIRED } = require('./lib/email-authority-bound-current-message-content-operation');
const U='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', T='tok-NEVER_LEAK', M='AAMkImmutable_1';
function response(body,status=200,ct='application/json'){ const r=new EventEmitter(); r.statusCode=status; Object.defineProperty(r,'headers',{value:{'content-type':ct}}); r.destroy=()=>{}; queueMicrotask(()=>{r.emit('data',Buffer.from(body));r.emit('end');}); return r; }
function https(body, inspect, status, ct){return {request(o,cb){inspect(o);const q=new EventEmitter();q.destroy=()=>{};q.end=()=>cb(response(body,status,ct));return q;}};}
(async()=>{
 assert.equal(scope.CONTENT_SCOPE_VERSION,'message_content_v1');
 assert.equal(scope.validateContentReadTokenScope('openid User.Read Mail.Read'), 'openid User.Read Mail.Read');
 for(const s of ['User.Read Mail.ReadBasic','User.Read Mail.Read Mail.ReadWrite','User.Read Mail.Read Calendars.Read','User.Read Mail.Read.Shared']) assert.equal(scope.validateContentReadTokenScope(s),null);
 assert.equal(scope.classifyContentGrantScopeVersion('phase_a_v2'),'reauthorization_required');
 assert.equal(scope.classifyContentGrantScopeVersion('message_content_v1'),'accepted');
 const text=normalizeAuthoritativeMessageContent({contentType:'text',content:'Hello\r\n world  \n\n'}); assert.deepEqual(text,{latest_text:'Hello\nworld'}); assert.ok(Object.isFrozen(text));
 const html=normalizeAuthoritativeMessageContent({contentType:'html',content:'<html><head><style>x</style></head><body><p>Hello&nbsp; world</p><script>fetch("https://evil")</script><form>bad</form><img src="https://evil/x"><p>Thanks</p></body></html>'}); assert.deepEqual(html,{latest_text:'Hello world\nThanks'});
 assert.throws(()=>normalizeAuthoritativeMessageContent({contentType:'html',content:'Hi<div>On Tue, someone wrote:</div><blockquote>old</blockquote>'}),/authoritative_content_failed/);
 assert.throws(()=>normalizeAuthoritativeMessageContent({contentType:'html',content:'<svg><text>evil</text></svg>'}),/authoritative_content_failed/);
 let calls=0, retained;
 const body=JSON.stringify({id:M,body:{contentType:'text',content:'Current only'}});
 const tr=createMicrosoftGraphMessageContentTransport({httpsImpl:https(body,o=>{calls++;retained=o;assert.equal(o.path,`/v1.0/users/${U}/messages/${encodeURIComponent(M)}?$select=id,body`);assert.equal(o.headers.Prefer,'IdType="ImmutableId"');assert.equal(o.timeout,10000);}),timers:{setTimeout,clearTimeout}});
 const raw=await tr.fetchMessageContent({accessToken:T,providerMailboxId:U,providerMessageId:M}); assert.deepEqual(raw,{contentType:'text',content:'Current only'}); assert.equal(calls,1); assert.equal(retained.headers.Authorization,null);
 for(const bad of [{id:'wrong',body:{contentType:'text',content:'x'}},{id:M,body:{contentType:'rtf',content:'x'}},{id:M,body:{contentType:'text',content:'x'},subject:'leak'}]) {const x=createMicrosoftGraphMessageContentTransport({httpsImpl:https(JSON.stringify(bad),()=>{}),timers:{setTimeout,clearTimeout}});await assert.rejects(()=>x.fetchMessageContent({accessToken:T,providerMailboxId:U,providerMessageId:M}),e=>e.code==='microsoft_graph_message_content_failed'&&!JSON.stringify(e).includes('leak'));}
 let fetched=0, loan={accessToken:T};
 const op=createAuthorityBoundCurrentMessageContentOperation({resolveAuthority:async()=>Object.freeze({clientId:U,locationId:U,endpointId:U,provider:'microsoft_graph',providerMailboxId:U,providerMessageId:M}),grantSession:Object.freeze({runWithAccessTokenOnce:async(i,cb)=>({ok:true,value:await cb(loan)})}),transport:Object.freeze({fetchMessageContent:async i=>{fetched++;assert.equal(i.providerMailboxId,U);assert.equal(i.providerMessageId,M);return {contentType:'text',content:'Now'};}})});
 const got=await op.getCurrentMessageContent({clientId:U,locationId:U,eventId:U}); assert.deepEqual(got,{latest_text:'Now'}); assert.ok(Object.isFrozen(got)); assert.equal(fetched,1); assert.equal(loan.accessToken,null); assert.equal(EMAIL_AUTHORITY_BOUND_CURRENT_MESSAGE_CONTENT_RUNTIME_WIRED,false);
 const before=createAuthorityBoundCurrentMessageContentOperation({resolveAuthority:async()=>{throw Error('no');},grantSession:Object.freeze({runWithAccessTokenOnce:async()=>{throw Error('network');}}),transport:Object.freeze({fetchMessageContent:async()=>{throw Error('network');}})}); await assert.rejects(()=>before.getCurrentMessageContent({clientId:U,locationId:U,eventId:U}),/authority_bound_current_message_content_failed/);
 console.log('verify:email-authoritative-message-content ok');
})().catch(e=>{console.error(e);process.exitCode=1;});
