'use strict';
const http = require('node:http');
const { types } = require('node:util');
const WeakMapConstructor=WeakMap;
const weakMapGet=WeakMap.prototype.get;
const weakMapSet=WeakMap.prototype.set;
const weakMapDelete=WeakMap.prototype.delete;
const reflectApply=Reflect.apply;
const reflectOwnKeys=Reflect.ownKeys;
const objectCreate=Object.create;
const objectFreeze=Object.freeze;
const objectDefineProperty=Object.defineProperty;
const objectGetOwnPropertyDescriptor=Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf=Object.getPrototypeOf;
const objectHasOwn=Object.hasOwn;
const authenticObjectPrototype=objectGetPrototypeOf({});
// Module-init pin: real IncomingMessage.headers is a non-enumerable prototype
// getter, not own data. Only Reflect.apply the pinned getter on exact genuine
// IncomingMessage. Identity is exact prototype equality plus pinned native
// prototype/constructor data descriptors — never an ordinary constructor
// property read. Own constructor descriptors are rejected unread. Proxies,
// subclasses, custom prototypes, and accessor fakes are rejected; plain
// own-data headers stay for deterministic test requests. Fail closed if
// those descriptors change after load.
const PINNED_INCOMING_MESSAGE = http.IncomingMessage;
const PINNED_INCOMING_MESSAGE_PROTOTYPE = http.IncomingMessage
  && http.IncomingMessage.prototype
  ? http.IncomingMessage.prototype
  : null;
const PINNED_HEADERS_DESCRIPTOR = PINNED_INCOMING_MESSAGE_PROTOTYPE
  ? objectGetOwnPropertyDescriptor(PINNED_INCOMING_MESSAGE_PROTOTYPE, 'headers')
  : null;
const PINNED_HEADERS_GET = PINNED_HEADERS_DESCRIPTOR
  && typeof PINNED_HEADERS_DESCRIPTOR.get === 'function'
  && !objectHasOwn(PINNED_HEADERS_DESCRIPTOR, 'value')
  ? PINNED_HEADERS_DESCRIPTOR.get
  : null;
function freezePinnedDataDescriptor(desc, expectedValue){
  if(!desc||!objectHasOwn(desc,'value')||desc.get||desc.set||desc.value!==expectedValue)return null;
  return objectFreeze({value:desc.value,writable:desc.writable,enumerable:desc.enumerable,configurable:desc.configurable});
}
const PINNED_CONSTRUCTOR_PROTOTYPE_DESCRIPTOR = PINNED_INCOMING_MESSAGE && PINNED_INCOMING_MESSAGE_PROTOTYPE
  ? freezePinnedDataDescriptor(objectGetOwnPropertyDescriptor(PINNED_INCOMING_MESSAGE,'prototype'), PINNED_INCOMING_MESSAGE_PROTOTYPE)
  : null;
const PINNED_PROTOTYPE_CONSTRUCTOR_DESCRIPTOR = PINNED_INCOMING_MESSAGE && PINNED_INCOMING_MESSAGE_PROTOTYPE
  ? freezePinnedDataDescriptor(objectGetOwnPropertyDescriptor(PINNED_INCOMING_MESSAGE_PROTOTYPE,'constructor'), PINNED_INCOMING_MESSAGE)
  : null;
const PINNED_UTIL_TYPES = types && typeof types === 'object' ? types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;
const GOOGLE_ENDPOINT_PATH='/staff/admin/email-settings/oauth/google/endpoint';
const GOOGLE_START_PATH='/staff/admin/email-settings/oauth/google/start';
const GOOGLE_CALLBACK_PATH='/staff/email/google/callback';
const FLAGS=objectFreeze({endpoint:'LUNA_EMAIL_GOOGLE_OAUTH_ENDPOINT_ENABLED',start:'LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED',callback:'LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED'});
const JSON_LIMIT=10240;
function own(o,k){try{const d=objectGetOwnPropertyDescriptor(o,k);return d&&objectHasOwn(d,'value')&&!d.get&&!d.set?d.value:undefined;}catch{return undefined;}}
function isProxySurface(value){
  try{
    if(typeof PINNED_IS_PROXY!=='function'||!PINNED_UTIL_TYPES)return true;
    return reflectApply(PINNED_IS_PROXY,PINNED_UTIL_TYPES,[value])===true;
  }catch{return true;}
}
function isSamePinnedDataDescriptor(live,pinned){
  try{
    if(!live||!pinned)return false;
    if(objectHasOwn(live,'get')||objectHasOwn(live,'set')||live.get||live.set)return false;
    if(objectHasOwn(pinned,'get')||objectHasOwn(pinned,'set')||pinned.get||pinned.set)return false;
    if(!objectHasOwn(live,'value')||!objectHasOwn(pinned,'value'))return false;
    return live.value===pinned.value&&live.writable===pinned.writable&&live.enumerable===pinned.enumerable&&live.configurable===pinned.configurable;
  }catch{return false;}
}
function hasOwnConstructorDescriptor(req){
  try{
    return !!objectGetOwnPropertyDescriptor(req,'constructor');
  }catch{return true;}
}
function isPinnedIncomingMessage(req){
  try{
    if(isProxySurface(req)||!PINNED_HEADERS_GET||!PINNED_INCOMING_MESSAGE||!PINNED_INCOMING_MESSAGE_PROTOTYPE)return false;
    if(!PINNED_CONSTRUCTOR_PROTOTYPE_DESCRIPTOR||!PINNED_PROTOTYPE_CONSTRUCTOR_DESCRIPTOR)return false;
    if(!req||typeof req!=='object')return false;
    if(objectGetPrototypeOf(req)!==PINNED_INCOMING_MESSAGE_PROTOTYPE)return false;
    if(hasOwnConstructorDescriptor(req))return false;
    if(!isSamePinnedDataDescriptor(objectGetOwnPropertyDescriptor(PINNED_INCOMING_MESSAGE,'prototype'),PINNED_CONSTRUCTOR_PROTOTYPE_DESCRIPTOR))return false;
    if(!isSamePinnedDataDescriptor(objectGetOwnPropertyDescriptor(PINNED_INCOMING_MESSAGE_PROTOTYPE,'constructor'),PINNED_PROTOTYPE_CONSTRUCTOR_DESCRIPTOR))return false;
    const live=objectGetOwnPropertyDescriptor(PINNED_INCOMING_MESSAGE_PROTOTYPE,'headers');
    return !!(live&&live.get===PINNED_HEADERS_GET);
  }catch{return false;}
}
function rejectExactPrototypeOwnConstructor(req){
  try{
    if(!req||typeof req!=='object'||!PINNED_INCOMING_MESSAGE_PROTOTYPE)return false;
    return objectGetPrototypeOf(req)===PINNED_INCOMING_MESSAGE_PROTOTYPE&&hasOwnConstructorDescriptor(req);
  }catch{return true;}
}
function readRequestHeaders(req){
  try{
    if(isProxySurface(req))return undefined;
    if(isPinnedIncomingMessage(req)){
      const headers=reflectApply(PINNED_HEADERS_GET,req,[]);
      if(headers&&typeof headers==='object'&&!Array.isArray(headers))return headers;
      return undefined;
    }
    return own(req,'headers');
  }catch{return undefined;}
}
function snapshotGate(env){return objectFreeze({LUNA_DEPLOYMENT:own(env,'LUNA_DEPLOYMENT'),LUNA_EMAIL_GOOGLE_OAUTH_ENDPOINT_ENABLED:own(env,FLAGS.endpoint),LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED:own(env,FLAGS.start),LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED:own(env,FLAGS.callback)});}
function isGoogleRouteEnabled(env,kind){return own(env,'LUNA_DEPLOYMENT')==='sunset-staging'&&own(env,FLAGS[kind])==='true';}
function frozenDto(entries){const dto={};for(const [key,value] of entries)objectDefineProperty(dto,key,{value,enumerable:true,writable:false,configurable:false});return objectFreeze(dto);}

function parseStrictGoogleJson(contentType,raw,keys){
  try{
    if(typeof contentType!=='string'||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)||typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>JSON_LIMIT)return null;
    const names=[];let inString=false,escaped=false,start=-1;
    for(let i=0;i<raw.length;i++){const c=raw[i];if(inString){if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c==='"'){const token=raw.slice(start,i+1);let j=i+1;while(/\s/.test(raw[j]||''))j++;if(raw[j]===':')names.push(JSON.parse(token));inString=false;}}else if(c==='"'){inString=true;start=i;}}
    if(inString||new Set(names).size!==names.length||names.length!==keys.length||names.some((x,i)=>x!==keys[i]))return null;
    const value=JSON.parse(raw);if(!value||Array.isArray(value)||types.isProxy(value)||objectGetPrototypeOf(value)!==authenticObjectPrototype||reflectOwnKeys(value).some((x,i)=>x!==keys[i])||keys.some(k=>{const d=objectGetOwnPropertyDescriptor(value,k);return !d||!objectHasOwn(d,'value');}))return null;
    return frozenDto(keys.map(k=>[k,own(value,k)]));
  }catch{return null;}
}
function createStaffGoogleOAuthProductionIntegration(deps){
  const env=own(deps,'env')||{};
  const bindings=new WeakMapConstructor();
  function mint(gate,req,user){const token=objectFreeze(objectCreate(null));reflectApply(weakMapSet,bindings,[token,{gate,req,user}]);return token;}
  function consumer(token){return function authorizeProductionStart(gate,req,user){const binding=reflectApply(weakMapGet,bindings,[token]);if(!binding||binding.gate!==gate||binding.req!==req||binding.user!==user)return false;return reflectApply(weakMapDelete,bindings,[token])===true;};}
  function json(res,status,body){return deps.sendJSON(res,status,body);}
  async function dispatch(req,res,pathname){
    const gate=snapshotGate(env);const method=own(req,'method');
    let kind=null;if(pathname===GOOGLE_ENDPOINT_PATH)kind='endpoint';else if(pathname===GOOGLE_START_PATH)kind='start';else if(pathname===GOOGLE_CALLBACK_PATH)kind='callback';else return false;
    if(!isGoogleRouteEnabled(gate,kind))return kind==='callback'?deps.sendHTML(res,404,'<!doctype html><title>Not found</title>'):json(res,404,{success:false,error:'not_found'});
    if((kind==='callback'&&method!=='GET')||(kind!=='callback'&&method!=='POST'))return false;
    if(kind==='callback'){
      try{const routes=typeof deps.createGoogleRoutes==='function'?deps.createGoogleRoutes(gate):deps.googleRoutes;return routes.handleCallback(req,res);}
      catch{return deps.sendHTML(res,400,'<!doctype html><title>Connection failed</title><p>Gmail connection could not be completed.</p>');}
    }
    const auth=await deps.requireAdmin(req,res);if(!auth||!auth.ok)return;
    const user=auth.user;if(!deps.assertStaffClientAccess(user,'sunset',res))return;
    const decision=deps.authorizeAuthenticatedStaffRoute({clientSlug:'sunset',method:'POST',pathname,env:gate});if(!decision.ok)return json(res,decision.status||403,decision.body||{success:false,error:'forbidden'});
    if(rejectExactPrototypeOwnConstructor(req))return json(res,400,{success:false,error:'invalid_request'});
    let raw;try{raw=await deps.readBody(req,JSON_LIMIT);}catch{return json(res,400,{success:false,error:'invalid_request'});}
    const keys=kind==='endpoint'?['location_id','public_address']:['location_id','endpoint_id'];
    const body=parseStrictGoogleJson(own(readRequestHeaders(req)||{},'content-type'),raw,keys);if(!body)return json(res,400,{success:false,error:'invalid_request'});
    if(kind==='start'){
      try{const token=mint(gate,req,user);const routes=typeof deps.createGoogleRoutes==='function'?deps.createGoogleRoutes(gate,consumer(token)):deps.googleRoutes;return await routes.handleStart(body,req,res,user);}
      catch{return json(res,503,{success:false,error:'oauth_start_unavailable'});}
    }
    try{return await deps.withPgClient(async pg=>{const service=deps.createEndpointPrepare(objectFreeze({query:pg.query.bind(pg)}));const input=frozenDto([['clientId',own(user,'client_id').toLowerCase()],['locationId',body.location_id],['publicAddress',body.public_address],['actorStaffUserId',own(user,'staff_user_id').toLowerCase()]]);const ack=await service.prepareDisabledDelegatedEndpoint(input);return json(res,200,frozenDto([['success',true],['endpoint_id',ack.endpointId]]));});}
    catch{return json(res,503,{success:false,error:'endpoint_prepare_unavailable'});}
  }
  return objectFreeze({dispatch});
}
module.exports=objectFreeze({GOOGLE_ENDPOINT_PATH,GOOGLE_START_PATH,GOOGLE_CALLBACK_PATH,FLAGS,JSON_LIMIT,snapshotGate,isGoogleRouteEnabled,parseStrictGoogleJson,createStaffGoogleOAuthProductionIntegration});
