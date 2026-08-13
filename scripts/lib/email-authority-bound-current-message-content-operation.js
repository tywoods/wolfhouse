'use strict';
const {types:{isProxy:IS_PROXY}}=require('node:util');
const {normalizeAuthoritativeMessageContent}=require('./email-authoritative-content-normalizer');
const EMAIL_AUTHORITY_BOUND_CURRENT_MESSAGE_CONTENT_RUNTIME_WIRED=false;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEYS=Object.freeze(['clientId','locationId','eventId','endpointId','provider','providerMailboxId','providerMessageId']);
const INPUT_KEYS=Object.freeze(['clientId','locationId','eventId']);
const DEP_KEYS=Object.freeze(['buildAuthorityResolver','grantSession','transport']);
const O=Object, R=Reflect, objectProto=O.prototype, getProto=O.getPrototypeOf, getDesc=O.getOwnPropertyDescriptor,
  freeze=O.freeze, isFrozen=O.isFrozen, ownKeys=R.ownKeys, weakHas=WeakSet.prototype.has,
  weakAdd=WeakSet.prototype.add, authentic=new WeakSet();
function fail(){const e=new Error('authority_bound_current_message_content_failed');e.code='authority_bound_current_message_content_failed';return e;}
function descriptors(value,keys){
 if(value===null||typeof value!=='object'||IS_PROXY(value)||getProto(value)!==objectProto)return null;
 const own=ownKeys(value);if(own.length!==keys.length||!own.every((k,i)=>k===keys[i]))return null;
 const out=[];for(const key of keys){const d=getDesc(value,key);if(!d||!('value'in d)||d.get||d.set) return null;out.push(d.value);}return out;
}
function uuid(x){return typeof x==='string'&&UUID.test(x);}
function opaqueId(x){return typeof x==='string'&&x.length>0&&Buffer.byteLength(x,'utf8')<=2048&&!/[\x00-\x1f\x7f]/.test(x)&&!/[\uD800-\uDFFF]/.test(x)&&x!=='.'&&x!=='..';}
function validAuthority(v){return uuid(v[0])&&uuid(v[1])&&uuid(v[2])&&uuid(v[3])&&v[4]==='microsoft_graph'&&uuid(v[5])&&opaqueId(v[6]);}
function plainFunctionBag(value,keys){const v=descriptors(value,keys);return v&&v.every(x=>typeof x==='function')?v:null;}
function createAuthorityBoundCurrentMessageContentOperation(deps){
 try{
  const dv=descriptors(deps,DEP_KEYS);if(!dv||typeof dv[0]!=='function')throw fail();
  const grant=plainFunctionBag(dv[1],['runWithAccessTokenOnce']), transport=plainFunctionBag(dv[2],['fetchMessageContent']);if(!grant||!transport)throw fail();
  const issue=value=>{const values=descriptors(value,KEYS);if(!values||!validAuthority(values))throw fail();const cap={};for(let i=0;i<KEYS.length;i++)O.defineProperty(cap,KEYS[i],{value:values[i],enumerable:true,writable:false,configurable:false});freeze(cap);weakAdd.call(authentic,cap);return cap;};
  const resolveAuthority=dv[0](issue);if(typeof resolveAuthority!=='function'||IS_PROXY(resolveAuthority))throw fail();
  let used=false;
  async function getCurrentMessageContent(input){if(used)throw fail();used=true;let token=null,request=null,raw=null;try{
   const iv=descriptors(input,INPUT_KEYS);if(!iv||!iv.every(uuid))throw fail();const safeInput=freeze({clientId:iv[0],locationId:iv[1],eventId:iv[2]});
   const a=await resolveAuthority(safeInput), av=descriptors(a,KEYS);
   if(!weakHas.call(authentic,a)||!isFrozen(a)||!av||!validAuthority(av)||av[0]!==iv[0]||av[1]!==iv[1]||av[2]!==iv[2])throw fail();
   const binding=freeze({clientId:av[0],endpointId:av[3]});
   const session=await grant[0].call(dv[1],binding,async loan=>{const lv=descriptors(loan,['accessToken']);if(!lv||typeof lv[0]!=='string')throw fail();token=lv[0];request={accessToken:token,providerMailboxId:av[5],providerMessageId:av[6]};raw=await transport[0].call(dv[2],request);return normalizeAuthoritativeMessageContent(raw);});
   if(!session||session.ok!==true||!session.value||!isFrozen(session.value))throw fail();return session.value;
  }catch{throw fail();}finally{raw=null;token=null;if(request)request.accessToken=null;request=null;}}
  return freeze({getCurrentMessageContent});
 }catch{throw fail();}
}
module.exports=freeze({EMAIL_AUTHORITY_BOUND_CURRENT_MESSAGE_CONTENT_RUNTIME_WIRED,createAuthorityBoundCurrentMessageContentOperation});