'use strict';

const {
  INSTALL_KEYS, INSTALLER_METHOD, SEALED_ACK, ownData, exactFrozenData,
  createVerifiedGrantCustodyAdapter,
} = require('./email-verified-grant-custody');

const ERROR_CODE = 'GOOGLE_VERIFIED_GRANT_CUSTODY_INVALID';
const ERROR_MESSAGE = 'Google verified grant custody failed.';
const GOOGLE_API_ORIGIN = `https://www.${'google'}${'apis'}.com/auth/`;
const GOOGLE_PHASE_A_SCOPES = Object.freeze([
  'openid', 'email', `${GOOGLE_API_ORIGIN}gmail.readonly`,
  `${GOOGLE_API_ORIGIN}gmail.compose`,
]);
const SELECTED_KEYS = Object.freeze(['accessToken','refreshToken','tokenType','expiresIn','scope','idToken']);
const CONFIG_KEYS = Object.freeze(['clientId','endpointId','operationId','actorStaffUserId','expectedNonce','expectedClientId']);
const IDENTITY_KEYS = Object.freeze(['providerTenantId','providerPrincipalId','mailboxAddress','displayName']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ASCII = /^[\x21-\x7e]+$/;
const GMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
function failure(){const error=new Error(ERROR_MESSAGE);Object.defineProperty(error,'name',{value:'GoogleVerifiedGrantCustodyError'});Object.defineProperty(error,'code',{value:ERROR_CODE,enumerable:true});return Object.freeze(error);}
function bounded(value,max){return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)&&!/[\ud800-\udfff]/.test(value);}
function printable(value,max){return typeof value==='string'&&value.length>0&&value.length<=max&&ASCII.test(value);}
function snapshotConfig(input){
  if(!exactFrozenData(input,CONFIG_KEYS))return null;
  const clientId=ownData(input,'clientId'),endpointId=ownData(input,'endpointId'),operationId=ownData(input,'operationId'),actorStaffUserId=ownData(input,'actorStaffUserId'),expectedNonce=ownData(input,'expectedNonce'),expectedClientId=ownData(input,'expectedClientId');
  if(!UUID.test(clientId)||!UUID.test(endpointId)||!UUID.test(operationId)||(actorStaffUserId!==null&&!UUID.test(actorStaffUserId))||!bounded(expectedNonce,512)||!bounded(expectedClientId,256))return null;
  return Object.freeze({clientId,endpointId,operationId,actorStaffUserId,expectedNonce,expectedClientId});
}
function normalizeScope(value){
  if(typeof value!=='string'||value.length<1||value!==value.trim()||value.includes('  '))return null;
  const pieces=value.split(' ');if(pieces.length!==GOOGLE_PHASE_A_SCOPES.length||new Set(pieces).size!==pieces.length)return null;
  if(pieces.some(s=>!GOOGLE_PHASE_A_SCOPES.includes(s)))return null;
  return GOOGLE_PHASE_A_SCOPES.join(' ');
}
function snapshotSelected(input){
  if(!exactFrozenData(input,SELECTED_KEYS))return null;
  const accessToken=ownData(input,'accessToken'),refreshToken=ownData(input,'refreshToken'),tokenType=ownData(input,'tokenType'),expiresIn=ownData(input,'expiresIn'),scope=normalizeScope(ownData(input,'scope')),idToken=ownData(input,'idToken');
  if(!printable(accessToken,8192)||!printable(refreshToken,8192)||tokenType!=='Bearer'||!Number.isInteger(expiresIn)||expiresIn<1||expiresIn>86400||scope===null||!printable(idToken,32768))return null;
  return Object.freeze({accessToken,refreshToken,tokenType,expiresIn,scope,idToken});
}
function readIdentity(input){
  if(!exactFrozenData(input,IDENTITY_KEYS))return null;
  const providerTenantId=ownData(input,'providerTenantId'),providerPrincipalId=ownData(input,'providerPrincipalId'),mailboxAddress=ownData(input,'mailboxAddress'),displayName=ownData(input,'displayName');
  if(providerTenantId!=='https://accounts.google.com'||!printable(providerPrincipalId,255)||typeof mailboxAddress!=='string'||mailboxAddress.length<3||mailboxAddress.length>254||mailboxAddress!==mailboxAddress.trim()||!GMAIL.test(mailboxAddress)||mailboxAddress.includes('..'))return null;
  if(displayName!==null&&(typeof displayName!=='string'||displayName.length<1||displayName.length>256||/[\u0000-\u001f\u007f]/.test(displayName)))return null;
  return Object.freeze({providerTenantId,providerPrincipalId,mailboxAddress,displayName});
}
const POLICY=Object.freeze({failure,snapshotConfig,snapshotSelected,readIdentity});
function createGoogleVerifiedGrantCustodyAdapter(config,dependencies){return createVerifiedGrantCustodyAdapter(config,dependencies,POLICY);}
module.exports=Object.freeze({ERROR_CODE,ERROR_MESSAGE,GOOGLE_PHASE_A_SCOPES,SELECTED_KEYS,CONFIG_KEYS,INSTALL_KEYS,INSTALLER_METHOD,SEALED_ACK,createGoogleVerifiedGrantCustodyAdapter});
