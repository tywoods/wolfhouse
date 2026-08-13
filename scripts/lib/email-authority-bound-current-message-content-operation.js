'use strict';
const {normalizeAuthoritativeMessageContent}=require('./email-authoritative-content-normalizer');
const EMAIL_AUTHORITY_BOUND_CURRENT_MESSAGE_CONTENT_RUNTIME_WIRED=false;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fail(){const e=new Error('authority_bound_current_message_content_failed');e.code='authority_bound_current_message_content_failed';return e;}
function exact(o,ks){return o&&Object.getPrototypeOf(o)===Object.prototype&&Reflect.ownKeys(o).length===ks.length&&ks.every(k=>Object.getOwnPropertyDescriptor(o,k)?.value!==undefined);}
function createAuthorityBoundCurrentMessageContentOperation(deps){
 if(!deps||typeof deps.resolveAuthority!=='function'||typeof deps.grantSession?.runWithAccessTokenOnce!=='function'||typeof deps.transport?.fetchMessageContent!=='function')throw fail();
 let used=false;
 async function getCurrentMessageContent(input){
  if(used)throw fail();used=true;let loanRef=null, raw=null;
  try{
   if(!exact(input,['clientId','locationId','eventId'])||![input.clientId,input.locationId,input.eventId].every(x=>typeof x==='string'&&UUID.test(x)))throw fail();
   const a=await deps.resolveAuthority(Object.freeze({...input}));
   if(!a||a.clientId!==input.clientId||a.locationId!==input.locationId||a.provider!=='microsoft_graph'||!UUID.test(a.endpointId)||!UUID.test(a.providerMailboxId)||typeof a.providerMessageId!=='string')throw fail();
   const session=await deps.grantSession.runWithAccessTokenOnce(Object.freeze({clientId:a.clientId,endpointId:a.endpointId}),async loan=>{loanRef=loan;if(!loan||typeof loan.accessToken!=='string')throw fail();raw=await deps.transport.fetchMessageContent({accessToken:loan.accessToken,providerMailboxId:a.providerMailboxId,providerMessageId:a.providerMessageId});return normalizeAuthoritativeMessageContent(raw);});
   if(!session||session.ok!==true||!session.value||!Object.isFrozen(session.value))throw fail();return session.value;
  }catch{throw fail();}finally{raw=null;if(loanRef)loanRef.accessToken=null;loanRef=null;}
 }
 return Object.freeze({getCurrentMessageContent});
}
module.exports=Object.freeze({EMAIL_AUTHORITY_BOUND_CURRENT_MESSAGE_CONTENT_RUNTIME_WIRED,createAuthorityBoundCurrentMessageContentOperation});
