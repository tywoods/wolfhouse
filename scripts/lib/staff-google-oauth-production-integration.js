'use strict';
const { types } = require('node:util');
const GOOGLE_ENDPOINT_PATH='/staff/admin/email-settings/oauth/google/endpoint';
const GOOGLE_START_PATH='/staff/admin/email-settings/oauth/google/start';
const GOOGLE_CALLBACK_PATH='/staff/email/google/callback';
const FLAGS=Object.freeze({endpoint:'LUNA_EMAIL_GOOGLE_OAUTH_ENDPOINT_ENABLED',start:'LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED',callback:'LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED'});
const JSON_LIMIT=10240;
function own(o,k){try{const d=Object.getOwnPropertyDescriptor(o,k);return d&&Object.hasOwn(d,'value')&&!d.get&&!d.set?d.value:undefined;}catch{return undefined;}}
function snapshotGate(env){return Object.freeze({LUNA_DEPLOYMENT:own(env,'LUNA_DEPLOYMENT'),LUNA_EMAIL_GOOGLE_OAUTH_ENDPOINT_ENABLED:own(env,FLAGS.endpoint),LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED:own(env,FLAGS.start),LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED:own(env,FLAGS.callback)});}
function isGoogleRouteEnabled(env,kind){return own(env,'LUNA_DEPLOYMENT')==='sunset-staging'&&own(env,FLAGS[kind])==='true';}
function frozenDto(entries){const dto={};for(const [key,value] of entries)Object.defineProperty(dto,key,{value,enumerable:true,writable:false,configurable:false});return Object.freeze(dto);}
function parseStrictGoogleJson(contentType,raw,keys){
  try{
    if(typeof contentType!=='string'||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)||typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>JSON_LIMIT)return null;
    const names=[];let inString=false,escaped=false,start=-1;
    for(let i=0;i<raw.length;i++){const c=raw[i];if(inString){if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c==='"'){const token=raw.slice(start,i+1);let j=i+1;while(/\s/.test(raw[j]||''))j++;if(raw[j]===':')names.push(JSON.parse(token));inString=false;}}else if(c==='"'){inString=true;start=i;}}
    if(inString||new Set(names).size!==names.length||names.length!==keys.length||names.some((x,i)=>x!==keys[i]))return null;
    const value=JSON.parse(raw);if(!value||Array.isArray(value)||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).some((x,i)=>x!==keys[i])||keys.some(k=>{const d=Object.getOwnPropertyDescriptor(value,k);return !d||!Object.hasOwn(d,'value');}))return null;
    return frozenDto(keys.map(k=>[k,own(value,k)]));
  }catch{return null;}
}
function createStaffGoogleOAuthProductionIntegration(deps){
  const env=own(deps,'env')||{};
  function json(res,status,body){return deps.sendJSON(res,status,body);}
  async function dispatch(req,res,pathname){
    const gate=snapshotGate(env);const method=own(req,'method');
    let kind=null;if(pathname===GOOGLE_ENDPOINT_PATH)kind='endpoint';else if(pathname===GOOGLE_START_PATH)kind='start';else if(pathname===GOOGLE_CALLBACK_PATH)kind='callback';else return false;
    if(!isGoogleRouteEnabled(gate,kind))return kind==='callback'?deps.sendHTML(res,404,'<!doctype html><title>Not found</title>'):json(res,404,{success:false,error:'not_found'});
    if((kind==='callback'&&method!=='GET')||(kind!=='callback'&&method!=='POST'))return false;
    if(kind==='callback')return deps.googleRoutes.handleCallback(req,res);
    const auth=await deps.requireAdmin(req,res);if(!auth||!auth.ok)return;
    const user=auth.user;if(!deps.assertStaffClientAccess(user,'sunset',res))return;
    const decision=deps.authorizeAuthenticatedStaffRoute({clientSlug:'sunset',method:'POST',pathname,env:gate});if(!decision.ok)return json(res,decision.status||403,decision.body||{success:false,error:'forbidden'});
    let raw;try{raw=await deps.readBody(req,JSON_LIMIT);}catch{return json(res,400,{success:false,error:'invalid_request'});}
    const keys=kind==='endpoint'?['location_id','public_address']:['location_id','endpoint_id'];
    const body=parseStrictGoogleJson(own(own(req,'headers')||{},'content-type'),raw,keys);if(!body)return json(res,400,{success:false,error:'invalid_request'});
    if(kind==='start')return deps.googleRoutes.handleStart(body,req,res,user);
    try{return await deps.withPgClient(async pg=>{const service=deps.createEndpointPrepare(pg);const input=frozenDto([['clientId',own(user,'client_id').toLowerCase()],['locationId',body.location_id],['publicAddress',body.public_address],['actorStaffUserId',own(user,'staff_user_id').toLowerCase()]]);const ack=await service.prepareDisabledDelegatedEndpoint(input);return json(res,200,frozenDto([['success',true],['endpoint_id',ack.endpointId]]));});}
    catch{return json(res,503,{success:false,error:'endpoint_prepare_unavailable'});}
  }
  return Object.freeze({dispatch});
}
module.exports=Object.freeze({GOOGLE_ENDPOINT_PATH,GOOGLE_START_PATH,GOOGLE_CALLBACK_PATH,FLAGS,JSON_LIMIT,snapshotGate,isGoogleRouteEnabled,parseStrictGoogleJson,createStaffGoogleOAuthProductionIntegration});
