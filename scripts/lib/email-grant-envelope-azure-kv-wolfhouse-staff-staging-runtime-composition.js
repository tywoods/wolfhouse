'use strict';
/** Dedicated Wolfhouse staff-staging grant custody. No local KEK or credential-chain fallback. */
const { createAzureKvEmailGrantEnvelopeProvider, parseVersionedKeyId, PROD_WRAP_ALG } = require('./email-grant-envelope-azure-kv-provider');
const HOST='wh-staging-kv.vault.azure.net';
const KEY='luna-email-grant-kek';
const MI='e3136eed-948b-4947-a26e-50a33b45a41a';
const VERSION=/^[0-9a-f]{32}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const E=Object.freeze({enabled:'WOLFHOUSE_EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED',activation:'WOLFHOUSE_EMAIL_GRANT_ENVELOPE_AZURE_KV_RUNTIME_ACTIVATION_ENABLED',host:'WOLFHOUSE_EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST',kid:'WOLFHOUSE_EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID',mi:'WOLFHOUSE_EMAIL_GRANT_ENVELOPE_AZURE_KV_MANAGED_IDENTITY_CLIENT_ID'});
function own(o,k){try{const d=Object.getOwnPropertyDescriptor(o,k);return d&&Object.hasOwn(d,'value')&&typeof d.value==='string'?d.value:null;}catch{return null;}}
function invalid(){return Object.freeze({ok:false,code:'wolfhouse_envelope_azure_kv_config_invalid'});}
function parseWolfhouseStaffStagingEnvelopeConfig(env){
 try{
  if(!env||typeof env!=='object'||Array.isArray(env)||own(env,'LUNA_DEPLOYMENT')!=='staff-staging')return invalid();
  if(own(env,E.enabled)!=='true')return Object.freeze({ok:true,composition_enabled:false});
  const host=own(env,E.host),kid=own(env,E.kid),mi=own(env,E.mi);
  if(host!==HOST||!UUID.test(mi||'')||mi!==MI)return invalid();
  const p=parseVersionedKeyId(kid,new Set([HOST]));
  if(!p||p.host!==HOST||p.name!==KEY||!VERSION.test(p.version)||p.keyId!==kid)return invalid();
  return Object.freeze({ok:true,composition_enabled:true,deployment_boundary:'wolfhouse-staff-staging-only',trusted_host:HOST,kek_key_name:KEY,kek_key_version:p.version,versioned_key_id:kid,managed_identity_client_id:mi,wrap_alg:PROD_WRAP_ALG});
 }catch{return invalid();}
}
function error(code){return Object.assign(new Error(code),{code});}
function createActiveWolfhouseStaffStagingEnvelopeComposition(env){
 const cfg=parseWolfhouseStaffStagingEnvelopeConfig(env);
 if(!cfg.ok||!cfg.composition_enabled||own(env,E.activation)!=='true')throw error('wolfhouse_envelope_azure_kv_disabled');
 let ManagedIdentityCredential,CryptographyClient;
 try{({ManagedIdentityCredential}=require('@azure/identity'));({CryptographyClient}=require('@azure/keyvault-keys'));}catch{throw error('wolfhouse_envelope_azure_kv_sdk_unavailable');}
 let credential,client;
 try{credential=new ManagedIdentityCredential(cfg.managed_identity_client_id);client=new CryptographyClient(cfg.versioned_key_id,credential,{retryOptions:{maxRetries:0}});}catch{throw error('wolfhouse_envelope_azure_kv_failed');}
 const cryptoClient=Object.freeze({wrapKey(...a){return client.wrapKey(...a);},unwrapKey(...a){return client.unwrapKey(...a);}});
 const provider=createAzureKvEmailGrantEnvelopeProvider(Object.freeze({trustedVaultHosts:[HOST],vaultHost:HOST,kekKeyName:KEY,kekKeyVersion:cfg.kek_key_version,getCryptographyClient(id){if(id!==cfg.versioned_key_id)throw error('wolfhouse_envelope_kv_client_invalid');return cryptoClient;}}));
 return Object.freeze({ok:true,composition_enabled:true,runtime_activation:true,deployment_boundary:'wolfhouse-staff-staging-only',provider});
}
module.exports=Object.freeze({HOST,KEY,MI,ENV:E,parseWolfhouseStaffStagingEnvelopeConfig,createActiveWolfhouseStaffStagingEnvelopeComposition});
