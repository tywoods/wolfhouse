'use strict';
const SECRET_REF='secret-ref:email/microsoft/wolfhouse-staff-staging-oauth-client';
const SECRET_ENV='WOLFHOUSE_EMAIL_MICROSOFT_OAUTH_CLIENT_SECRET';
const VISIBLE=/^[\x21-\x7e]{16,4096}$/;
function own(o,k){try{const d=Object.getOwnPropertyDescriptor(o,k);return d&&Object.hasOwn(d,'value')?d.value:undefined;}catch{return undefined;}}
function fail(){const e=new Error('Wolfhouse Microsoft OAuth provider unavailable.');e.code='WOLFHOUSE_MICROSOFT_OAUTH_PROVIDER_UNAVAILABLE';e.stack=undefined;throw Object.freeze(e);}
function createWolfhouseMicrosoftOAuthClientSecretProvider(deps){
 try{if(!deps||Reflect.ownKeys(deps).join(',')!=='deployment,env'||own(deps,'deployment')!=='staff-staging')fail();const secret=own(own(deps,'env'),SECRET_ENV);if(typeof secret!=='string'||!VISIBLE.test(secret))fail();let used=false;return Object.freeze({async getClientSecret(){if(used)fail();used=true;return secret;}});}catch{fail();}
}
module.exports=Object.freeze({SECRET_REF,SECRET_ENV,createWolfhouseMicrosoftOAuthClientSecretProvider});
