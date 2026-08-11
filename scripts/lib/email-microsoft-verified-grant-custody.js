'use strict';

const {
  TOKEN_RESPONSE_REQUIRED_RESOURCE_SCOPES,
  TOKEN_RESPONSE_ALLOWED_OIDC_SCOPES,
  TOKEN_RESPONSE_SCOPE_ORDER,
  validateAndNormalizeTokenResponseScope,
} = require('./email-microsoft-token-response-scope');
const {
  GRANT_GENERATION_INITIAL, INSTALL_KEYS, INSTALLER_METHOD, SEALED_ACK,
  ownData, exactFrozenData, createVerifiedGrantCustodyAdapter,
} = require('./email-verified-grant-custody');

const ERROR_CODE = 'MICROSOFT_VERIFIED_GRANT_CUSTODY_INVALID';
const ERROR_MESSAGE = 'Microsoft verified grant custody failed.';
const TOKEN_LIMIT_CHARS = 8192;
const ID_TOKEN_LIMIT_CHARS = 32768;
const MAX_EXPIRES_IN_SECONDS = 86_400;
const NONCE_LIMIT = 512;
const CLIENT_ID_LIMIT = 256;
const PRINCIPAL_LIMIT = 256;
const PHASE_A_SCOPES = Object.freeze(['openid','profile','offline_access','User.Read','Mail.ReadBasic']);
const SELECTED_KEYS = Object.freeze(['accessToken','refreshToken','tokenType','expiresIn','scope','idToken']);
const CONFIG_KEYS = Object.freeze(['clientId','endpointId','operationId','actorStaffUserId','expectedNonce','expectedClientId']);
const IDENTITY_KEYS = Object.freeze(['providerTenantId','providerPrincipalId','mailboxAddress','displayName']);
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAILBOX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'MicrosoftVerifiedGrantCustodyError' });
  Object.defineProperty(error, 'code', { value: ERROR_CODE, enumerable: true });
  return Object.freeze(error);
}
function hasUnpairedSurrogate(value) {
  for (let i=0;i<value.length;i+=1) { const c=value.charCodeAt(i); if(c>=0xd800&&c<=0xdbff){const n=value.charCodeAt(i+1);if(!(n>=0xdc00&&n<=0xdfff))return true;i+=1;}else if(c>=0xdc00&&c<=0xdfff)return true; }
  return false;
}
function bounded(value,max){return typeof value==='string'&&value.length>0&&value.length<=max&&!hasUnpairedSurrogate(value)&&!/[\u0000-\u001f\u007f]/.test(value);}
function printable(value,max){return typeof value==='string'&&value.length>0&&value.length<=max&&PRINTABLE_ASCII.test(value);}
function uuid(value){return typeof value==='string'&&UUID_CANON.test(value);}
function mailbox(value){return typeof value==='string'&&value.length>=3&&value.length<=254&&!/[\u0000-\u001f\u007f]/.test(value)&&value===value.trim()&&value===value.toLowerCase()&&MAILBOX.test(value)&&!value.includes('..');}
function snapshotSelected(input){
  if(!exactFrozenData(input,SELECTED_KEYS))return null;
  const accessToken=ownData(input,'accessToken'),refreshToken=ownData(input,'refreshToken'),tokenType=ownData(input,'tokenType'),expiresIn=ownData(input,'expiresIn'),scope=ownData(input,'scope'),idToken=ownData(input,'idToken');
  const normalized=validateAndNormalizeTokenResponseScope(scope);
  if(!printable(accessToken,TOKEN_LIMIT_CHARS)||!printable(refreshToken,TOKEN_LIMIT_CHARS)||tokenType!=='Bearer'||!Number.isInteger(expiresIn)||expiresIn<1||expiresIn>MAX_EXPIRES_IN_SECONDS||normalized===null||!printable(idToken,ID_TOKEN_LIMIT_CHARS))return null;
  return Object.freeze({accessToken,refreshToken,tokenType,expiresIn,scope:normalized,idToken});
}
function snapshotConfig(input){
  if(!exactFrozenData(input,CONFIG_KEYS))return null;
  const clientId=ownData(input,'clientId'),endpointId=ownData(input,'endpointId'),operationId=ownData(input,'operationId'),actorStaffUserId=ownData(input,'actorStaffUserId'),expectedNonce=ownData(input,'expectedNonce'),expectedClientId=ownData(input,'expectedClientId');
  if(!uuid(clientId)||!uuid(endpointId)||!uuid(operationId)||(actorStaffUserId!==null&&!uuid(actorStaffUserId))||!bounded(expectedNonce,NONCE_LIMIT)||!bounded(expectedClientId,CLIENT_ID_LIMIT))return null;
  return Object.freeze({clientId,endpointId,operationId,actorStaffUserId,expectedNonce,expectedClientId});
}
function readIdentity(input){
  if(!exactFrozenData(input,IDENTITY_KEYS))return null;
  const providerTenantId=ownData(input,'providerTenantId'),providerPrincipalId=ownData(input,'providerPrincipalId'),mailboxAddress=ownData(input,'mailboxAddress'),displayName=ownData(input,'displayName');
  if(!bounded(providerTenantId,PRINCIPAL_LIMIT)||!UUID_CANON.test(providerTenantId)||!bounded(providerPrincipalId,PRINCIPAL_LIMIT)||!mailbox(mailboxAddress))return null;
  if(displayName!==null&&(typeof displayName!=='string'||displayName.length<1||displayName.length>PRINCIPAL_LIMIT||/[\u0000-\u001f\u007f]/.test(displayName)))return null;
  return Object.freeze({providerTenantId,providerPrincipalId,mailboxAddress,displayName});
}
const POLICY=Object.freeze({failure,snapshotConfig,snapshotSelected,readIdentity});
function createMicrosoftVerifiedGrantCustodyAdapter(config,dependencies){return createVerifiedGrantCustodyAdapter(config,dependencies,POLICY);}
module.exports=Object.freeze({
  ERROR_CODE,ERROR_MESSAGE,TOKEN_LIMIT_CHARS,ID_TOKEN_LIMIT_CHARS,MAX_EXPIRES_IN_SECONDS,
  PHASE_A_SCOPES,TOKEN_RESPONSE_REQUIRED_RESOURCE_SCOPES,TOKEN_RESPONSE_ALLOWED_OIDC_SCOPES,
  TOKEN_RESPONSE_SCOPE_ORDER,GRANT_GENERATION_INITIAL,SELECTED_KEYS,CONFIG_KEYS,INSTALL_KEYS,
  INSTALLER_METHOD,SEALED_ACK,createMicrosoftVerifiedGrantCustodyAdapter,
});
