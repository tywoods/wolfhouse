'use strict';
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {normalizeAuthoritativeMessageContent}=require('./lib/email-authoritative-content-normalizer');
const {createMicrosoftGraphMessageContentTransport,RESPONSE_CAP_BYTES,DEADLINE_MS}=require('./lib/email-microsoft-graph-message-content-transport');
const authority=require('./lib/email-authority-bound-current-message-content-operation');
const U='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', V='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', T='tok-NEVER_LEAK', M='opaque/id+with=padding';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function harness(payload,{status=200,ct='Application/JSON; charset=utf-8',stall=false}={}){const state={requests:0,reqDestroyed:0,resDestroyed:0,options:null};return {state,httpsImpl:{request(o,cb){state.requests++;state.options=o;const req=new EventEmitter();req.destroy=()=>state.reqDestroyed++;req.end=()=>{const res=new EventEmitter();res.statusCode=status;res.headers={'content-type':ct};res.destroy=()=>state.resDestroyed++;cb(res);if(!stall)queueMicrotask(()=>{for(const b of payload)res.emit('data',b);res.emit('end');});};return req;}}};}
function input(){return {clientId:U,locationId:U,eventId:U};}
(async()=>{
 assert.deepEqual(normalizeAuthoritativeMessageContent({contentType:'text',content:' Hello\r\nworld '}),{latest_text:'Hello\nworld'});
 for(const content of ['<script>SECRET</style>LEAK','<p>hello</p>'])assert.throws(()=>normalizeAuthoritativeMessageContent({contentType:'html',content}),/authoritative_content_failed/);
 assert.throws(()=>normalizeAuthoritativeMessageContent({contentType:'text',content:'Now\nOn Tue, X wrote:\nold'}));
 const graph=JSON.stringify({'@odata.context':'https://graph.microsoft.com/v1.0/$metadata#users/messages(id,body)/$entity','@odata.etag':'W/"abc"',id:M,body:{contentType:'text',content:'Current'}});
 let h=harness([Buffer.from(graph)]);const timers={setTimeout,clearTimeout};const tr=createMicrosoftGraphMessageContentTransport({httpsImpl:h.httpsImpl,timers});
 assert.deepEqual(await tr.fetchMessageContent({accessToken:T,providerMailboxId:U,providerMessageId:M}),{contentType:'text',content:'Current'});
 assert.equal(h.state.options.path,`/v1.0/users/${U}/messages/${encodeURIComponent(M)}?$select=id,body`);assert.equal(h.state.options.headers.Prefer,'IdType="ImmutableId", outlook.body-content-type="text"');assert.equal(h.state.options.headers.Authorization,null);assert.equal(h.state.requests,1);
 for(const status of [404,410,429,500,503]){h=harness([Buffer.from(graph)],{status});await assert.rejects(()=>createMicrosoftGraphMessageContentTransport({httpsImpl:h.httpsImpl,timers}).fetchMessageContent({accessToken:T,providerMailboxId:U,providerMessageId:M}));assert.ok(h.state.reqDestroyed&&h.state.resDestroyed);}
 h=harness([Buffer.alloc(RESPONSE_CAP_BYTES+1)]);await assert.rejects(()=>createMicrosoftGraphMessageContentTransport({httpsImpl:h.httpsImpl,timers}).fetchMessageContent({accessToken:T,providerMailboxId:U,providerMessageId:M}));assert.ok(h.state.reqDestroyed&&h.state.resDestroyed);
 h=harness([Buffer.from([0xc3]),Buffer.from([0x28])]);await assert.rejects(()=>createMicrosoftGraphMessageContentTransport({httpsImpl:h.httpsImpl,timers}).fetchMessageContent({accessToken:T,providerMailboxId:U,providerMessageId:M}));
 const fastTimers={setTimeout(fn){queueMicrotask(fn);return 1;},clearTimeout(){}};h=harness([],{stall:true});await assert.rejects(()=>createMicrosoftGraphMessageContentTransport({httpsImpl:h.httpsImpl,timers:fastTimers}).fetchMessageContent({accessToken:T,providerMailboxId:U,providerMessageId:M}));assert.ok(h.state.reqDestroyed&&h.state.resDestroyed);
 const issuer=authority.createAuthorityCapabilityIssuer();const cap=issuer.issue(Object.freeze({clientId:U,locationId:U,eventId:U,endpointId:V,provider:'microsoft_graph',providerMailboxId:U,providerMessageId:M}));assert.ok(Object.isFrozen(cap));
 let network=0;const frozenLoan=Object.freeze({accessToken:T});const make=resolved=>authority.createAuthorityBoundCurrentMessageContentOperation({resolveAuthority:async()=>resolved,grantSession:{runWithAccessTokenOnce:async(_,cb)=>({ok:true,value:await cb(frozenLoan)})},transport:{fetchMessageContent:async()=>{network++;return {contentType:'text',content:'Now'};}}});
 assert.deepEqual(await make(cap).getCurrentMessageContent(input()),{latest_text:'Now'});assert.equal(network,1);
 for(const bad of [{...cap},Object.freeze({...cap,eventId:V}),Object.assign({...cap},{eventId:V}),Object.defineProperty({...cap},'eventId',{get(){return U;}}),Object.assign({...cap}, {[Symbol('x')]:1}),new Proxy({...cap},{})]){const before=network;await assert.rejects(()=>make(bad).getCurrentMessageContent(input()));assert.equal(network,before);}
 const mismatch=issuer.issue(Object.freeze({clientId:U,locationId:U,eventId:V,endpointId:V,provider:'microsoft_graph',providerMailboxId:U,providerMessageId:M}));await assert.rejects(()=>make(mismatch).getCurrentMessageContent(input()));
 assert.equal(authority.EMAIL_AUTHORITY_BOUND_CURRENT_MESSAGE_CONTENT_RUNTIME_WIRED,false);assert.ok(DEADLINE_MS>0);console.log('verify:email-authoritative-message-content ok');
})().catch(e=>{console.error(e);process.exitCode=1;});
