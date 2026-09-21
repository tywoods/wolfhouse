'use strict';
const {isProxy}=require('node:util').types;
const SECRET_REF='secret-ref:email/google/wolfhouse-staff-staging-oauth-client';
const SECRET_ENV='WOLFHOUSE_EMAIL_GOOGLE_OAUTH_CLIENT_SECRET';
const VISIBLE=/^[\x21-\x7e]{16,512}$/;
function fail(){const e=new Error('Wolfhouse Google OAuth client secret provider failed.');e.code='WOLFHOUSE_GOOGLE_OAUTH_CLIENT_SECRET_PROVIDER_INVALID';e.stack=undefined;throw Object.freeze(e);}
function own(o,k){try{const d=Object.getOwnPropertyDescriptor(o,k);return d&&Object.hasOwn(d,'value')&&typeof d.value==='string'?d.value:null;}catch{return null;}}
function createWolfhouseGoogleOAuthClientSecretProvider(configuration){
 try{if(!configuration||Reflect.ownKeys(configuration).join(',')!=='deployment,env'||own(configuration,'deployment')!=='staff-staging')fail();const d=Object.getOwnPropertyDescriptor(configuration,'env');const env=d&&d.value;const secret=env&&own(env,SECRET_ENV);if(!secret||!VISIBLE.test(secret))fail();let used=false;return Object.freeze({resolveClientSecret(request){if(used||!request||isProxy(request)||!Object.isFrozen(request)||own(request,'secretRef')!==SECRET_REF)fail();used=true;return Object.freeze({clientSecret:secret});}});}catch{fail();}
}
module.exports=Object.freeze({SECRET_REF,SECRET_ENV,createWolfhouseGoogleOAuthClientSecretProvider});
