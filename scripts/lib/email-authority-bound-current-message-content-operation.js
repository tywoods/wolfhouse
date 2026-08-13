'use strict';
const {normalizeAuthoritativeMessageContent}=require('./email-authoritative-content-normalizer');
const EMAIL_AUTHORITY_BOUND_CURRENT_MESSAGE_CONTENT_RUNTIME_WIRED=false;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEYS=['clientId','locationId','eventId','endpointId','provider','providerMailboxId','providerMessageId'];
const authentic=new WeakSet();
function fail(){const e=new Error('authority_bound_current_message_content_failed');e.code='authority_bound_current_message_content_failed';return e;}
function exactData(o,ks){if(!o||Object.getPrototypeOf(o)!==Object.prototype||Reflect.ownKeys(o).length!==ks.length)return false;return ks.every(k=>{const d=Object.getOwnPropertyDescriptor(o,k);return d&&'value'in d&&!d.get&&!d.set;});}
/** Narrow offline issuer: future authoritative resolver composition owns this factory. */
function createAuthorityCapabilityIssuer(){return Object.freeze({issue(value){try{if(!exactData(value,KEYS)||!KEYS.every(k=>typeof value[k]==='string')||!UUID.test(value.clientId)||!UUID.test(value.locationId)||!UUID.test(value.eventId)||!UUID.test(value.endpointId)||!UUID.test(value.providerMailboxId)||value.provider!=='microsoft_graph'||!value.providerMessageId)throw fail();const cap=Object.freeze(Object.fromEntries(KEYS.map(k=>[k,value[k]])));authentic.add(cap);return cap;}catch{throw fail();}}});}
function createAuthorityBoundCurrentMessageContentOperation(deps){
 if(!deps||typeof deps.resolveAuthority!=='function'||typeof deps.grantSession?.runWithAccessTokenOnce!=='function'||typeof deps.transport?.fetchMessageContent!=='function')throw fail();let used=false;
 async function getCurrentMessageContent(input){if(used)throw fail();used=true;let token=null,request=null,raw=null;try{
  if(!exactData(input,['clientId','locationId','eventId'])||![input.clientId,input.locationId,input.eventId].every(x=>typeof x==='string'&&UUID.test(x)))throw fail();
  const a=await deps.resolveAuthority(Object.freeze({...input}));if(!authentic.has(a)||!Object.isFrozen(a)||!exactData(a,KEYS)||a.clientId!==input.clientId||a.locationId!==input.locationId||a.eventId!==input.eventId)throw fail();
  const session=await deps.grantSession.runWithAccessTokenOnce(Object.freeze({clientId:a.clientId,endpointId:a.endpointId}),async loan=>{const d=loan&&Object.getOwnPropertyDescriptor(loan,'accessToken');if(!d||!('value'in d)||typeof d.value!=='string')throw fail();token=d.value;request={accessToken:token,providerMailboxId:a.providerMailboxId,providerMessageId:a.providerMessageId};raw=await deps.transport.fetchMessageContent(request);return normalizeAuthoritativeMessageContent(raw);});
  if(!session||session.ok!==true||!session.value||!Object.isFrozen(session.value))throw fail();return session.value;
 }catch{throw fail();}finally{raw=null;token=null;if(request)request.accessToken=null;request=null;}}
 return Object.freeze({getCurrentMessageContent});}
module.exports=Object.freeze({EMAIL_AUTHORITY_BOUND_CURRENT_MESSAGE_CONTENT_RUNTIME_WIRED,createAuthorityCapabilityIssuer,createAuthorityBoundCurrentMessageContentOperation});
