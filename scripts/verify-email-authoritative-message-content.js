'use strict';
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {normalizeAuthoritativeMessageContent}=require('./lib/email-authoritative-content-normalizer');
const {createMicrosoftGraphMessageContentTransport,RESPONSE_CAP_BYTES,DEADLINE_MS}=require('./lib/email-microsoft-graph-message-content-transport');
const authority=require('./lib/email-authority-bound-current-message-content-operation');
const U='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', V='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', W='cccccccc-cccc-4ccc-8ccc-cccccccccccc', T='tok-NEVER_LEAK', M='opaque/id+with=padding';
function harness(payload,{status=200,ct='Application/JSON; charset=utf-8',stall=false}={}){const state={requests:0,reqDestroyed:0,resDestroyed:0,options:null};return {state,httpsImpl:{request(o,cb){state.requests++;state.options=o;const req=new EventEmitter();req.destroy=()=>state.reqDestroyed++;req.end=()=>{const res=new EventEmitter();res.statusCode=status;res.headers={'content-type':ct};res.destroy=()=>state.resDestroyed++;cb(res);if(!stall)queueMicrotask(()=>{for(const b of payload)res.emit('data',b);res.emit('end');});};return req;}}};}
const input=()=>({clientId:U,locationId:U,eventId:U});
const row=()=>({clientId:U,locationId:U,eventId:U,endpointId:V,provider:'microsoft_graph',providerMailboxId:U,providerMessageId:M});
(async()=>{
 assert.deepEqual(normalizeAuthoritativeMessageContent({contentType:'text',content:' Hello\r\nworld '}),{latest_text:'Hello\nworld'});
 for(const content of ['<script>SECRET</style>LEAK','<p>hello</p>'])assert.throws(()=>normalizeAuthoritativeMessageContent({contentType:'html',content}),/authoritative_content_failed/);
 assert.throws(()=>normalizeAuthoritativeMessageContent({contentType:'text',content:'Now\nOn Tue, X wrote:\nold'}));
 const graph=JSON.stringify({'@odata.context':'https://graph.microsoft.com/v1.0/$metadata#users/messages(id,body)/$entity','@odata.etag':'W/"abc"',id:M,body:{contentType:'text',content:'Current'}});
 let h=harness([Buffer.from(graph)]), timers={setTimeout,clearTimeout};const tr=createMicrosoftGraphMessageContentTransport({httpsImpl:h.httpsImpl,timers});
 assert.deepEqual(await tr.fetchMessageContent({accessToken:T,providerMailboxId:U,providerMessageId:M}),{contentType:'text',content:'Current'});
 assert.equal(h.state.options.path,`/v1.0/users/${U}/messages/${encodeURIComponent(M)}?$select=id,body`);assert.equal(h.state.options.headers.Authorization,null);assert.equal(h.state.requests,1);
 for(const status of [404,410,429,500,503]){h=harness([Buffer.from(graph)],{status});await assert.rejects(()=>createMicrosoftGraphMessageContentTransport({httpsImpl:h.httpsImpl,timers}).fetchMessageContent({accessToken:T,providerMailboxId:U,providerMessageId:M}));assert.ok(h.state.reqDestroyed&&h.state.resDestroyed);}
 h=harness([Buffer.alloc(RESPONSE_CAP_BYTES),Buffer.alloc(1)]);await assert.rejects(()=>createMicrosoftGraphMessageContentTransport({httpsImpl:h.httpsImpl,timers}).fetchMessageContent({accessToken:T,providerMailboxId:U,providerMessageId:M}));
 h=harness([Buffer.from([0xc3]),Buffer.from([0x28])]);await assert.rejects(()=>createMicrosoftGraphMessageContentTransport({httpsImpl:h.httpsImpl,timers}).fetchMessageContent({accessToken:T,providerMailboxId:U,providerMessageId:M}));
 const fastTimers={setTimeout(fn){queueMicrotask(fn);return 1;},clearTimeout(){}};h=harness([],{stall:true});await assert.rejects(()=>createMicrosoftGraphMessageContentTransport({httpsImpl:h.httpsImpl,timers:fastTimers}).fetchMessageContent({accessToken:T,providerMailboxId:U,providerMessageId:M}));assert.ok(h.state.reqDestroyed&&h.state.resDestroyed);
 // Private provenance: there is no public mint/brand/introspection surface.
 assert.deepEqual(Reflect.ownKeys(authority).sort(),['EMAIL_AUTHORITY_BOUND_CURRENT_MESSAGE_CONTENT_RUNTIME_WIRED','createAuthorityBoundCurrentMessageContentOperation']);
 let grants=0,network=0,builderCalls=0;const frozenLoan=Object.freeze({accessToken:T});
 function make(value=row()) { return authority.createAuthorityBoundCurrentMessageContentOperation({
   buildAuthorityResolver(issue){builderCalls++;return async()=>issue(value);},
   grantSession:{runWithAccessTokenOnce:async(binding,cb)=>{grants++;assert.deepEqual(binding,{clientId:U,endpointId:V});return {ok:true,value:await cb(frozenLoan)};}},
   transport:{fetchMessageContent:async request=>{network++;assert.deepEqual(request,{accessToken:T,providerMailboxId:U,providerMessageId:M});return {contentType:'text',content:'Now'};}}
 });}
 const op=make();assert.deepEqual(Reflect.ownKeys(op),['getCurrentMessageContent']);assert.deepEqual(await op.getCurrentMessageContent(input()),{latest_text:'Now'});assert.equal(builderCalls,1);assert.equal(grants,1);assert.equal(network,1);
 // Every bound dimension fails before grant/network (malformed endpoint included).
 const mutations=[['clientId',V],['locationId',V],['eventId',V],['endpointId','bad'],['provider','google'],['providerMailboxId','bad'],['providerMessageId','bad\nmessage']];
 for(const [key,value] of mutations){const before=[grants,network];const x=row();x[key]=value;const bad=make(x);await assert.rejects(()=>bad.getCurrentMessageContent(input()));assert.deepEqual([grants,network],before,key);}
 // Forged lookalikes and malformed issuance never reach custody/network; mutable source is safely snapshotted.
 {const before=[grants,network],forged=authority.createAuthorityBoundCurrentMessageContentOperation({buildAuthorityResolver:()=>async()=>Object.freeze(row()),grantSession:{runWithAccessTokenOnce(){grants++;}},transport:{fetchMessageContent(){network++;}}});await assert.rejects(()=>forged.getCurrentMessageContent(input()));assert.deepEqual([grants,network],before);}
 for(const value of [Object.assign(row(),{eventId:V}),Object.defineProperty(row(),'eventId',{get(){return U;}}),Object.assign(row(),{[Symbol('x')]:1}),new Proxy(row(),{})]){const before=[grants,network];await assert.rejects(()=>make(value).getCurrentMessageContent(input()));assert.deepEqual([grants,network],before);}
 // Issuance rejects proxies before any trap, including changing-read races.
 let traps=0;const hostile=new Proxy(row(),{get(){traps++;return traps%2?U:V;},ownKeys(){traps++;throw Error('trap');}});await assert.rejects(()=>make(hostile).getCurrentMessageContent(input()));assert.equal(traps,0);
 // Exotic/accessor/symbol dependency bags and async/thenable builders are rejected synchronously.
 const good={buildAuthorityResolver:issue=>async()=>issue(row()),grantSession:{runWithAccessTokenOnce(){}},transport:{fetchMessageContent(){}}};
 for(const deps of [new Proxy(good,{}),Object.assign({},good,{[Symbol('x')]:1}),Object.defineProperty({...good},'transport',{get(){return good.transport;}}),{...good,buildAuthorityResolver:()=>Promise.resolve(()=>{})},{...good,buildAuthorityResolver:()=>({then(){}})}])assert.throws(()=>authority.createAuthorityBoundCurrentMessageContentOperation(deps));
 // Pinned security intrinsics survive post-import monkeypatches.
 const old={WeakSet:global.WeakSet,Object:global.Object,Reflect:global.Reflect};let pinned;try{global.WeakSet=function(){throw Error('patched');};global.Object={};global.Reflect={};pinned=make();}finally{old.Object.assign(global,old);}assert.deepEqual(await pinned.getCurrentMessageContent(input()),{latest_text:'Now'});
 assert.equal(authority.EMAIL_AUTHORITY_BOUND_CURRENT_MESSAGE_CONTENT_RUNTIME_WIRED,false);assert.ok(DEADLINE_MS>0);console.log('verify:email-authoritative-message-content ok');
})().catch(e=>{console.error(e);process.exitCode=1;});
