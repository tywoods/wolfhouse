'use strict';

/**
 * verify:email-grant-envelope-azure-kv-sunset-staging-runtime-composition
 * Slice 2F-C2 offline gate — Sunset-staging canary only. No live Azure/network/DB.
 * SDK path: fresh child processes intercept Module._load BEFORE requiring composition.
 * No production DI/test-hook export. Verifier < 500 LOC.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const COMP_PATH = path.join(ROOT, 'scripts/lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition.js');
const CORE_PATH = path.join(ROOT, 'scripts/lib/email-grant-envelope-azure-kv-provider.js');
const DOC_PATH = path.join(ROOT, 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const STAFF_PATH = path.join(ROOT, 'scripts/staff-query-api.js');
const DOCKERFILES = ['Dockerfile', 'Dockerfile.luna-sunset-staff-api', 'Dockerfile.crowsnest'];

const M = require('./lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const {
  createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition: create,
  parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig: parseCfg,
  SUNSET_STAGING_EMAIL_GRANT_KEK: KEK,
  SUNSET_STAGING_TRUSTED_HOST: HOST,
  SUNSET_STAGING_KEK_KEY_NAME: KNAME,
  SUNSET_STAGING_KEK_KEY_VERSION: KVER,
  SUNSET_STAGING_VERSIONED_KEY_ID: KID,
  SUNSET_STAGING_MI_CLIENT_ID: MI,
  SUNSET_STAGING_MI_PRINCIPAL_ID: PRINCIPAL,
  ENV_COMPOSITION_ENABLED: E_EN,
  ENV_TRUSTED_HOST: E_HOST,
  ENV_VERSIONED_KEY_ID: E_KID,
  ENV_KEYS,
  CRYPTO_CLIENT_OPTIONS,
  PROD_WRAP_ALG,
} = M;

const PLANTED = 'password=LEAKED_SECRET_VALUE_DO_NOT_ECHO';
const HOSTILE_MI = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); return true; }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}
function netLoc(src) {
  return src.split('\n').filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('*') && !t.startsWith('//') && t !== '/**' && t !== '*/';
  }).length;
}
function exactEnv(o) {
  const e = Object.create(null);
  if (o && typeof o === 'object') for (const k of Object.keys(o)) e[k] = o[k];
  return e;
}
function enabledEnv(extra) {
  return exactEnv({ [E_EN]: 'true', [E_HOST]: HOST, [E_KID]: KID, ...(extra || {}) });
}
function runChild(body) {
  return spawnSync(process.execPath, ['-e', body], {
    encoding: 'utf8', cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '' },
    maxBuffer: 4 * 1024 * 1024,
  });
}
function parseChildJson(child) {
  try {
    const lines = String(child.stdout || '').trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1] || 'null');
  } catch { return null; }
}

/** Shared child bootstrap: constants + Module intercept helpers. */
const PRE = `
'use strict';
const Module=require('module'),crypto=require('crypto'),path=require('path');
const COMP=${JSON.stringify(COMP_PATH)},MI=${JSON.stringify(MI)},KID=${JSON.stringify(KID)};
const KNAME=${JSON.stringify(KNAME)},KVER=${JSON.stringify(KVER)},HOST=${JSON.stringify(HOST)};
const PLANTED=${JSON.stringify(PLANTED)},HOSTILE_MI=${JSON.stringify(HOSTILE_MI)};
const E_EN=${JSON.stringify(E_EN)},E_HOST=${JSON.stringify(E_HOST)},E_KID=${JSON.stringify(E_KID)};
const realLoad=Module._load; const hits=[];
function out(o){console.log(JSON.stringify(o));}
function enabled(x){return Object.assign({[E_EN]:'true',[E_HOST]:HOST,[E_KID]:KID},x||{});}
function noPlanted(v){let s;try{s=JSON.stringify(v);}catch{s=String(v);}
  return !s.includes(PLANTED)&&!s.includes('LEAKED_SECRET')&&!s.includes('BEGIN RSA')
    &&!s.includes('access_token')&&!s.includes('client_secret')&&!s.includes('secret_field');}
function blockAzure(){Module._load=function(r,p,m){
  if(typeof r==='string'&&(r==='@azure/identity'||r==='@azure/keyvault-keys'||r.startsWith('@azure/'))){
    hits.push(r);const e=new Error('blocked '+r);e.code='AZURE_IMPORT_BLOCKED';throw e;}
  return realLoad(r,p,m);};}
function installSpies(c,mode){
  const {publicKey,privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
  const w={key:publicKey,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'};
  const u={key:privateKey,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'};
  function makeClient(keyId){return{
    async wrapKey(algorithm,key){
      if(mode==='plantWrap')throw Object.assign(new Error(PLANTED),{statusCode:403,secret_field:PLANTED});
      return{result:crypto.publicEncrypt(w,Buffer.isBuffer(key)?key:Buffer.from(key)),algorithm,keyID:keyId};},
    async unwrapKey(algorithm,encryptedKey){
      if(mode==='plantWrap')throw Object.assign(new Error(PLANTED),{statusCode:403,secret_field:PLANTED});
      return{result:crypto.privateDecrypt(u,Buffer.isBuffer(encryptedKey)?encryptedKey:Buffer.from(encryptedKey)),algorithm,keyID:keyId};},
  };}
  function ManagedIdentityCredential(clientId){
    c.mic++;c.micClientId=clientId;
    if(mode==='throwGetter'){const h={};Object.defineProperty(h,'code',{enumerable:true,get(){throw new Error(PLANTED);}});
      Object.defineProperty(h,'message',{enumerable:true,get(){throw new Error(PLANTED);}});throw h;}
    if(mode==='throwProxy'){throw new Proxy({},{get(){throw new Error(PLANTED);},
      getOwnPropertyDescriptor(){throw new Error(PLANTED);},ownKeys(){throw new Error(PLANTED);},
      getPrototypeOf(){throw new Error(PLANTED);},has(){throw new Error(PLANTED);}});}
    return Object.freeze({kind:'spy-mic',clientId});}
  function CryptographyClient(keyId,credential,options){
    c.cc++;c.ccKeyId=keyId;c.ccCredential=credential;c.ccOptions=options;return makeClient(keyId);}
  function DefaultAzureCredential(){c.dac++;throw new Error('DAC forbidden');}
  function KeyClient(){c.keyClient++;throw new Error('KeyClient forbidden');}
  Module._load=function(r,p,m){
    if(r==='@azure/identity'){c.idLoad++;return{ManagedIdentityCredential,DefaultAzureCredential};}
    if(r==='@azure/keyvault-keys'){c.kvLoad++;return{CryptographyClient,KeyClient};}
    if(typeof r==='string'&&r.startsWith('@azure/'))throw new Error('unexpected '+r);
    return realLoad(r,p,m);};
}
`;

async function main() {
  console.log('verify:email-grant-envelope-azure-kv-sunset-staging-runtime-composition (2F-C2)');
  const src = fs.readFileSync(COMP_PATH, 'utf8');
  const coreSrc = fs.readFileSync(CORE_PATH, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const staff = fs.existsSync(STAFF_PATH) ? fs.readFileSync(STAFF_PATH, 'utf8') : '';
  const verifierSrc = fs.readFileSync(__filename, 'utf8');

  ok('package script present',
    !!(pkg.scripts && pkg.scripts['verify:email-grant-envelope-azure-kv-sunset-staging-runtime-composition']));
  ok('exact azure dep versions (no caret)',
    pkg.dependencies && pkg.dependencies['@azure/identity'] === '4.13.1'
    && pkg.dependencies['@azure/keyvault-keys'] === '4.10.2');
  ok('docs ManagedIdentityCredential + MI client ID + principal + canary',
    /ManagedIdentityCredential/.test(doc) && doc.includes(MI) && doc.includes(PRINCIPAL)
    && /sunset-staging|canary/i.test(doc) && /readback|mandatory before.*deploy/i.test(doc)
    && doc.includes('luna-sunset-staging-kv.vault.azure.net')
    && doc.includes('fde9704bd37b45fabe1f12a6a615b032'));
  ok('docs RSA-OAEP-256 + default-off / no activation',
    /RSA-OAEP-256/.test(doc) && /default-off|runtime_activation:\s*false|no.*activation/i.test(doc));
  ok('docs no production DI; child Module._load test path',
    /Module\._load|module loading/i.test(doc)
    && /no production DI|no.*second-arg|env only|one argument/i.test(doc)
    && !/Optional \*\*second factory argument\*\*/.test(doc));
  ok('pinned constants exact',
    HOST === 'luna-sunset-staging-kv.vault.azure.net' && KNAME === 'luna-email-grant-kek'
    && KVER === 'fde9704bd37b45fabe1f12a6a615b032'
    && KID === `https://${HOST}/keys/${KNAME}/${KVER}`
    && MI === '0e05fbe3-e8c5-48aa-a914-30aed284e6f7'
    && PRINCIPAL === '5338388f-1685-40cb-ae69-dc2e00f32ad6'
    && PROD_WRAP_ALG === 'RSA-OAEP-256'
    && KEK.deployment_boundary === 'sunset-staging-canary-only');
  ok('env allowlist exact 3',
    ENV_KEYS.length === 3
    && E_EN === 'EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED'
    && E_HOST === 'EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST'
    && E_KID === 'EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID');
  ok('retry maxRetries 0', CRYPTO_CLIENT_OPTIONS.retryOptions.maxRetries === 0);
  ok('lazy MIC only; no DAC/KeyClient/DI helpers/aliases',
    !/^(const|let|var).*=\s*require\s*\(\s*['"]@azure\//m.test(src)
    && /require\s*\(\s*['"]@azure\/identity['"]\s*\)/.test(src)
    && /require\s*\(\s*['"]@azure\/keyvault-keys['"]\s*\)/.test(src)
    && /ManagedIdentityCredential/.test(src) && /never DefaultAzureCredential/i.test(src)
    && !/\bnew\s+\w*DefaultAzureCredential\b|identity\.DefaultAzureCredential|\.DefaultAzureCredential\b/.test(src)
    && src.includes(MI) && !/\bKeyClient\b|\bSecretClient\b|\.listPropertiesOfKeys\b/.test(src)
    && /ignore AZURE_CLIENT_ID|never AZURE_CLIENT_ID/i.test(src)
    && /canary|never be deployed|separately reviewed/i.test(src)
    && !/\bparseTestDeps\b|\bcreateCredential\b|\bcreateCryptographyClient\b|\bloadAzureSdksDefault\b|\btestDeps\b|\bKNOWN_SANITIZED_CODES\b/.test(src)
    && !/createEmailGrantEnvelopeAzureKvRuntimeComposition|parseEmailGrantEnvelopeAzureKvRuntimeConfig/.test(src));
  ok('throwSanitized never reads exception properties',
    /function throwSanitized\s*\(\s*_?maybe\s*,\s*fallback\s*\)/.test(src)
    && !/throwSanitized[\s\S]{0,220}maybe\s*\.\s*code/.test(src)
    && !/throwSanitized[\s\S]{0,220}maybe\s*&&/.test(src));
  ok('2F-B free of @azure; staff does not require composition',
    !/@azure\/identity/.test(coreSrc) && !/DefaultAzureCredential/.test(coreSrc)
    && !/require\s*\(\s*['"]@azure\//.test(coreSrc)
    && !/email-grant-envelope-azure-kv-.*runtime-composition/.test(staff));
  ok('production net LOC < 250; verifier < 500',
    netLoc(src) < 250 && verifierSrc.split('\n').length < 500);
  ok('Dockerfiles Node 22', DOCKERFILES.every((f) => {
    const p = path.join(ROOT, f);
    return fs.existsSync(p) && /FROM\s+node:22\b/i.test(fs.readFileSync(p, 'utf8'));
  }));
  ok('one-arg factory; no generic aliases / sanitized Set / testDeps export',
    typeof create === 'function' && create.length === 1
    && typeof parseCfg === 'function'
    && !Object.prototype.hasOwnProperty.call(M, 'KNOWN_SANITIZED_CODES')
    && !Object.prototype.hasOwnProperty.call(M, 'createEmailGrantEnvelopeAzureKvRuntimeComposition')
    && !Object.prototype.hasOwnProperty.call(M, 'parseEmailGrantEnvelopeAzureKvRuntimeConfig')
    && !Object.prototype.hasOwnProperty.call(M, 'parseTestDeps')
    && !Object.prototype.hasOwnProperty.call(M, 'loadAzureSdks')
    && !Object.prototype.hasOwnProperty.call(M, 'createCredential')
    && !Object.prototype.hasOwnProperty.call(M, 'createCryptographyClient'));

  // import-inert
  {
    const ch = runChild(PRE + `
      blockAzure(); const mod=require(COMP);
      const p=mod.parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig({});
      out({ok:!hits.length&&p&&p.composition_enabled===false,hits:hits.length});
    `);
    const b = parseChildJson(ch);
    ok('fresh-process require: zero @azure imports/constructions',
      ch.status === 0 && b && b.ok, `st=${ch.status} ${JSON.stringify(b)}`);
  }

  // disabled paths
  for (const [label, envObj] of [
    ['omitted', {}], ['false', { [E_EN]: 'false' }], ['1', { [E_EN]: '1' }],
  ]) {
    const ch = runChild(PRE + `
      blockAzure(); const mod=require(COMP);
      const r=mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(${JSON.stringify(exactEnv(envObj))});
      out({ok:r.ok===false&&r.composition_enabled===false
        &&r.code==='envelope_azure_kv_composition_disabled'
        &&r.deployment_boundary==='sunset-staging-canary-only'&&!hits.length,hits:hits.length});
    `);
    const b = parseChildJson(ch);
    ok(`disabled (${label}) zero SDK import`, ch.status === 0 && b && b.ok, JSON.stringify(b));
  }

  // fail-closed before SDK
  for (const [label, envObj] of [
    ['foreign host', enabledEnv({ [E_HOST]: 'wh-staging-kv.vault.azure.net' })],
    ['unversioned', enabledEnv({ [E_KID]: `https://${HOST}/keys/${KNAME}` })],
    ['latest', enabledEnv({ [E_KID]: `https://${HOST}/keys/${KNAME}/latest` })],
    ['query', enabledEnv({ [E_KID]: `${KID}?api-version=7.4` })],
  ]) {
    const ch = runChild(PRE + `
      blockAzure(); const mod=require(COMP); let threw=false;
      try{mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(${JSON.stringify(envObj)});}
      catch(e){threw=e&&e.code==='envelope_azure_kv_composition_config_invalid'&&noPlanted(e);}
      out({ok:threw&&!hits.length,hits:hits.length,threw});
    `);
    const b = parseChildJson(ch);
    ok(`fail-closed ${label} + zero SDK import`, ch.status === 0 && b && b.ok, JSON.stringify(b));
  }

  // SDK Module._load spies + RSA + hostile AZURE + second-arg ignored
  {
    const ch = runChild(PRE + `
      const c={mic:0,cc:0,dac:0,keyClient:0,idLoad:0,kvLoad:0,micClientId:null,ccKeyId:null,ccOptions:null,ccCredential:null};
      installSpies(c,'ok'); const mod=require(COMP);
      const env=enabled({AZURE_CLIENT_ID:HOSTILE_MI,AZURE_TENANT_ID:'hostile-tenant',
        AZURE_CLIENT_SECRET:PLANTED,createCredential:'from-env',createCryptographyClient:'from-env',
        loadAzureSdks:'from-env',managed_identity_client_id:HOSTILE_MI});
      const fakeDeps={createCredential(){throw new Error('DI '+PLANTED);},
        createCryptographyClient(){throw new Error('DI '+PLANTED);},
        loadAzureSdks(){throw new Error('DI '+PLANTED);}};
      const composed=mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(env,fakeDeps);
      const envc=require(path.join(path.dirname(COMP),'email-grant-envelope-provider-contract.js'));
      const CLIENT='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ENDPOINT='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const aad=(g,o)=>envc.buildGrantEnvelopeAadV1({clientId:CLIENT,endpointId:ENDPOINT,grantGeneration:g,operationId:o});
      (async()=>{try{
        const pin=composed.ok&&composed.deployment_boundary==='sunset-staging-canary-only'
          &&c.idLoad===1&&c.kvLoad===1&&c.mic===1&&c.cc===1&&c.dac===0&&c.keyClient===0
          &&c.micClientId===MI&&c.micClientId!==HOSTILE_MI&&c.ccKeyId===KID
          &&c.ccCredential&&c.ccCredential.clientId===MI
          &&c.ccOptions&&c.ccOptions.retryOptions&&c.ccOptions.retryOptions.maxRetries===0;
        if(!pin){out({ok:false,stage:'pin',c});process.exit(2);return;}
        if(!envc.validateEmailGrantEnvelopeProvider(composed.provider).ok){out({ok:false,stage:'contract'});process.exit(3);return;}
        const op1=crypto.randomUUID(),aad1=aad(1,op1);
        const sealed=await composed.provider.sealGrantPayload({refresh_token:'rt-2fc2-round-trip',aad:aad1,operation_id:op1});
        const opened=await composed.provider.openGrantPayload({envelope:sealed,aad:aad1});
        const op2=crypto.randomUUID(),aad2=aad(2,op2);
        const rew=await composed.provider.rewrapGrantDek({envelope:sealed,aad:aad1,next_aad:aad2,operation_id:op2});
        const opened2=await composed.provider.openGrantPayload({envelope:rew,aad:aad2});
        const meta=composed.public_metadata;
        out({ok:sealed.kek_wrap_alg==='RSA-OAEP-256'&&sealed.kek_key_name===KNAME&&sealed.kek_key_version===KVER
          &&opened.refresh_token==='rt-2fc2-round-trip'&&opened2.refresh_token==='rt-2fc2-round-trip'
          &&!rew.wrapped_dek.equals(sealed.wrapped_dek)&&rew.operation_id===op2
          &&meta.deployment_boundary==='sunset-staging-canary-only'&&meta.runtime_activation===false&&noPlanted(meta),
          c:{mic:c.mic,cc:c.cc,idLoad:c.idLoad,kvLoad:c.kvLoad,micClientId:c.micClientId,ccKeyId:c.ccKeyId,
            maxRetries:c.ccOptions.retryOptions.maxRetries}});
        process.exit(0);
      }catch(e){out({ok:false,stage:'async',err:String(e&&e.message)});process.exit(4);}})();
    `);
    const b = parseChildJson(ch);
    ok('SDK Module._load spies: exact MIC client ID + CC key ID/options (one each)',
      ch.status === 0 && b && b.ok && b.c && b.c.mic === 1 && b.c.cc === 1
      && b.c.micClientId === MI && b.c.ccKeyId === KID && b.c.maxRetries === 0,
      `st=${ch.status} ${(ch.stderr || '').slice(0, 160)} ${JSON.stringify(b)}`);
    ok('SDK path seal/open/reseal + canary metadata; hostile AZURE env ignored',
      ch.status === 0 && b && b.ok);
    ok('second-arg fakeDeps ignored (no production DI bypass)',
      ch.status === 0 && b && b.ok);
  }

  // throwing code getter
  {
    const ch = runChild(PRE + `
      const c={mic:0,cc:0,dac:0,keyClient:0,idLoad:0,kvLoad:0};
      installSpies(c,'throwGetter'); const mod=require(COMP); let sanitized=false;
      try{mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(enabled());}
      catch(e){sanitized=e&&e.code==='envelope_kv_failed'&&e.message==='envelope_kv_failed'
        &&noPlanted(e)&&!Object.prototype.hasOwnProperty.call(e,'secret_field');}
      out({ok:sanitized});
    `);
    const b = parseChildJson(ch);
    ok('throwing code getter on construction → envelope_kv_failed (no plant)',
      ch.status === 0 && b && b.ok, JSON.stringify(b));
  }

  // proxy traps
  {
    const ch = runChild(PRE + `
      const c={mic:0,cc:0,dac:0,keyClient:0,idLoad:0,kvLoad:0};
      installSpies(c,'throwProxy'); const mod=require(COMP); let sanitized=false;
      try{mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(enabled());}
      catch(e){sanitized=e&&e.code==='envelope_kv_failed'&&e.message==='envelope_kv_failed'&&noPlanted(e);}
      out({ok:sanitized});
    `);
    const b = parseChildJson(ch);
    ok('proxy ownKeys/getOwnPropertyDescriptor/getPrototypeOf traps → sanitized',
      ch.status === 0 && b && b.ok, JSON.stringify(b));
  }

  // missing packages
  {
    const ch = runChild(PRE + `
      Module._load=function(r,p,m){
        if(r==='@azure/identity'||r==='@azure/keyvault-keys'){
          hits.push(r);const e=new Error("Cannot find module '"+r+"' "+PLANTED);e.code='MODULE_NOT_FOUND';throw e;}
        return realLoad(r,p,m);};
      const mod=require(COMP); let threw=false;
      try{mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(enabled());}
      catch(e){threw=e&&e.code==='envelope_azure_kv_sdk_unavailable'
        &&e.message==='envelope_azure_kv_sdk_unavailable'&&noPlanted(e);}
      out({ok:threw&&hits.length>=1,hits:hits.length});
    `);
    const b = parseChildJson(ch);
    ok('missing @azure → sanitized sdk_unavailable', ch.status === 0 && b && b.ok, JSON.stringify(b));
  }

  // planted wrap via provider
  {
    const ch = runChild(PRE + `
      const c={mic:0,cc:0,dac:0,keyClient:0,idLoad:0,kvLoad:0};
      installSpies(c,'plantWrap'); const mod=require(COMP);
      const envc=require(path.join(path.dirname(COMP),'email-grant-envelope-provider-contract.js'));
      const composed=mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(enabled());
      const op=crypto.randomUUID();
      const aad=envc.buildGrantEnvelopeAadV1({clientId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        endpointId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',grantGeneration:1,operationId:op});
      (async()=>{let sanitized=false;try{
        await composed.provider.sealGrantPayload({refresh_token:'rt-plant',aad,operation_id:op});
      }catch(e){sanitized=e&&typeof e.code==='string'&&e.code.startsWith('envelope_')
        &&noPlanted(e)&&!String(e.message||'').includes(PLANTED);}
        out({ok:sanitized});process.exit(sanitized?0:1);})();
    `);
    const b = parseChildJson(ch);
    ok('planted wrap exception sanitized at provider boundary',
      ch.status === 0 && b && b.ok, JSON.stringify(b));
  }

  ok('parse omitted → disabled', (() => {
    const p = parseCfg(exactEnv({}));
    return p.ok === true && p.composition_enabled === false
      && p.code === 'envelope_azure_kv_composition_disabled';
  })());
  ok('ordinary consumer: factory arity 1 (no testDeps param)', create.length === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('verifier crashed:', e && e.code ? e.code : 'error');
  process.exit(1);
});
