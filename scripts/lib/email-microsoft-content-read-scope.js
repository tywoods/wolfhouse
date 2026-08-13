'use strict';
/** Reviewed, exact delegated grant prerequisite for JIT message body read. Unwired. */
const CONTENT_SCOPE_VERSION='message_content_v1';
const REQUIRED=Object.freeze(['User.Read','Mail.Read']);
const ALLOWED=new Set(['openid','profile','offline_access','email',...REQUIRED]);
const ORDER=Object.freeze(['openid','profile','offline_access','email',...REQUIRED]);
function validateContentReadTokenScope(value){
 if(typeof value!=='string'||value.length<1||value.length>512)return null;
 const parts=value.split(' '), seen=new Set();
 for(const part of parts)if(!part||!ALLOWED.has(part)||seen.has(part))return null;else seen.add(part);
 if(!REQUIRED.every(x=>seen.has(x)))return null;
 return ORDER.filter(x=>seen.has(x)).join(' ');
}
function classifyContentGrantScopeVersion(value){return value===CONTENT_SCOPE_VERSION?'accepted':'reauthorization_required';}
module.exports=Object.freeze({CONTENT_SCOPE_VERSION,CONTENT_REQUIRED_DELEGATED_SCOPES:REQUIRED,validateContentReadTokenScope,classifyContentGrantScopeVersion});
