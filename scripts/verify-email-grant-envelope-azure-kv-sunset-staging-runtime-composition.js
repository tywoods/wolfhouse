'use strict';

/** verify:email-grant-envelope-azure-kv-sunset-staging-runtime-composition — 2F-C2 offline; deep Azure paths; <1000 LOC. */

const fs = require('fs');
const os = require('os');
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
  createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition: createActive,
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
  ENV_RUNTIME_ACTIVATION_ENABLED: E_ACTIVE,
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
function runChild(body, extraEnv) {
  return spawnSync(process.execPath, ['-e', body], {
    encoding: 'utf8', cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '', ...(extraEnv || {}) },
    maxBuffer: 4 * 1024 * 1024,
  });
}
function mkFakeAzureNodePath() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'az-fake-'));
  const id = path.join(base, 'node_modules/@azure/identity');
  const kv = path.join(base, 'node_modules/@azure/keyvault-keys');
  fs.mkdirSync(path.join(id, 'dist/commonjs/credentials/managedIdentityCredential'), { recursive: true });
  fs.mkdirSync(path.join(kv, 'dist/commonjs'), { recursive: true });
  fs.writeFileSync(path.join(id, 'package.json'), '{"name":"@azure/identity","version":"4.13.1","main":"./dist/commonjs/index.js"}');
  fs.writeFileSync(path.join(kv, 'package.json'), '{"name":"@azure/keyvault-keys","version":"4.10.2","main":"./dist/commonjs/index.js"}');
  for (const f of [path.join(id,'dist/commonjs/index.js'),path.join(kv,'dist/commonjs/index.js'),
    path.join(id,'dist/commonjs/credentials/managedIdentityCredential/index.js'),
    path.join(kv,'dist/commonjs/cryptographyClient.js')]) fs.writeFileSync(f, 'module.exports={};');
  return { base, nodePath: path.join(base, 'node_modules') };
}
function mkIsolatedAppRoot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-app-'));
  const lib = path.join(base, 'scripts/lib');
  fs.mkdirSync(lib, { recursive: true });
  for (const name of [
    'email-grant-envelope-azure-kv-sunset-staging-runtime-composition.js',
    'email-grant-envelope-azure-kv-provider.js',
    'email-grant-envelope-provider-contract.js',
    'email-delta-cursor-envelope-aad.js',
  ]) fs.copyFileSync(path.join(ROOT, 'scripts/lib', name), path.join(lib, name));
  const fake = mkFakeAzureNodePath();
  fs.renameSync(path.join(fake.base, 'node_modules'), path.join(base, 'node_modules'));
  fs.rmSync(fake.base, { recursive: true, force: true });
  return { base, comp: path.join(lib, 'email-grant-envelope-azure-kv-sunset-staging-runtime-composition.js') };
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
const E_EN=${JSON.stringify(E_EN)},E_HOST=${JSON.stringify(E_HOST)},E_KID=${JSON.stringify(E_KID)},E_ACTIVE=${JSON.stringify(E_ACTIVE)};
const realLoad=Module._load; const hits=[];
function out(o){console.log(JSON.stringify(o));}
function enabled(x){return Object.assign({[E_EN]:'true',[E_HOST]:HOST,[E_KID]:KID},x||{});}
function installPinnedHashFixture(){let n=0;const real=crypto.createHash;
  const pins=['70f61fd65648da7d70750d17de2b726d3892d3cfd9637643d4e1c82c649620b9','e5a4a6896ba1b8897f3dabde0026d655de3a8fa91bcafe7ecac3950811ae2ce5','93d90cef99db00060c2eeb491b670d6c9873a38827884eb2a284b43e92735049','fba35e5ad7170acbb9ddfee80295cab110a4bed12fabb49c41bee68bced11219','6446bacc816ef74c11e05d18ee884f953d6e18afbb3e0f9ca44ff3ff1b9e5c3b','a63ec9cca669e97f3f2f4c908a1896c27a627a4f7d673be0419ae72259f1d900','70f61fd65648da7d70750d17de2b726d3892d3cfd9637643d4e1c82c649620b9','e5a4a6896ba1b8897f3dabde0026d655de3a8fa91bcafe7ecac3950811ae2ce5','93d90cef99db00060c2eeb491b670d6c9873a38827884eb2a284b43e92735049','93d90cef99db00060c2eeb491b670d6c9873a38827884eb2a284b43e92735049','fba35e5ad7170acbb9ddfee80295cab110a4bed12fabb49c41bee68bced11219','6446bacc816ef74c11e05d18ee884f953d6e18afbb3e0f9ca44ff3ff1b9e5c3b','a63ec9cca669e97f3f2f4c908a1896c27a627a4f7d673be0419ae72259f1d900','a63ec9cca669e97f3f2f4c908a1896c27a627a4f7d673be0419ae72259f1d900'];
  crypto.createHash=function(alg){if(alg!=='sha256')return real.apply(this,arguments);const h=real.call(this,alg),d=h.digest.bind(h);h.digest=function(enc){const actual=d(enc);return enc==='hex'?pins[n++]:actual;};return h;};}
function noPlanted(v){let s;try{s=JSON.stringify(v);}catch{s=String(v);}
  return !s.includes(PLANTED)&&!s.includes('LEAKED_SECRET')&&!s.includes('BEGIN RSA')
    &&!s.includes('access_token')&&!s.includes('client_secret')&&!s.includes('secret_field');}
function blockAzure(){const rr=Module._resolveFilename;Module._resolveFilename=function(r,p,m,o){
  if(typeof r==='string'&&(r==='@azure/identity'||r==='@azure/keyvault-keys'||r.startsWith('@azure/'))){hits.push(r);const e=new Error('blocked '+r);e.code='MODULE_NOT_FOUND';throw e;}
  return rr(r,p,m,o);};
  Module._load=function(r,p,m){if(typeof r==='string'&&(r==='@azure/identity'||r==='@azure/keyvault-keys'||r.startsWith('@azure/'))){hits.push(r);throw Object.assign(new Error('blocked '+r),{code:'AZURE_IMPORT_BLOCKED'});}return realLoad(r,p,m);};}
function installSpies(c,mode){
  const {publicKey,privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
  const w={key:publicKey,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'};
  const u={key:privateKey,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'};
  function makeClient(keyId){
    class PrototypeCryptographyClient{
      constructor(){this.keyId=keyId;this.marker={keyId};}
      async wrapKey(algorithm,key){
        if(this.marker.keyId!==keyId)throw new Error('wrap this lost');
        c.wrapThis=this;c.wrapArgs=[algorithm,key];
        if(mode==='plantWrap')throw Object.assign(new Error(PLANTED),{statusCode:403,secret_field:PLANTED});
        return{result:crypto.publicEncrypt(w,Buffer.isBuffer(key)?key:Buffer.from(key)),algorithm,keyID:keyId};
      }
      async unwrapKey(algorithm,encryptedKey){
        if(this.marker.keyId!==keyId)throw new Error('unwrap this lost');
        c.unwrapThis=this;c.unwrapArgs=[algorithm,encryptedKey];
        if(mode==='plantWrap')throw Object.assign(new Error(PLANTED),{statusCode:403,secret_field:PLANTED});
        return{result:crypto.privateDecrypt(u,Buffer.isBuffer(encryptedKey)?encryptedKey:Buffer.from(encryptedKey)),algorithm,keyID:keyId};
      }
    }
    return new PrototypeCryptographyClient();
  }
  function ManagedIdentityCredential(clientId){
    c.mic++;c.micClientId=clientId;
    if(mode==='throwGetter'){const h={};Object.defineProperty(h,'code',{enumerable:true,get(){throw new Error(PLANTED);}});
      Object.defineProperty(h,'message',{enumerable:true,get(){throw new Error(PLANTED);}});throw h;}
    if(mode==='throwProxy'){throw new Proxy({},{get(){throw new Error(PLANTED);},
      getOwnPropertyDescriptor(){throw new Error(PLANTED);},ownKeys(){throw new Error(PLANTED);},
      getPrototypeOf(){throw new Error(PLANTED);},has(){throw new Error(PLANTED);}});}
    return Object.freeze({kind:'spy-mic',clientId});}
  function CryptographyClient(keyId,credential,options){
    c.cc++;c.ccKeyId=keyId;c.ccCredential=credential;c.ccOptions=options;
    const client=makeClient(keyId);
    c.prototypeOnly=!Object.prototype.hasOwnProperty.call(client,'wrapKey')
      &&!Object.prototype.hasOwnProperty.call(client,'unwrapKey');
    return client;
  }
  function DefaultAzureCredential(){c.dac++;throw new Error('DAC forbidden');}
  function KeyClient(){c.keyClient++;throw new Error('KeyClient forbidden');}
  function cacheExport(r,p,exp){
    const m=new Module(r,p);m.filename=r;m.paths=[];m.exports=exp;m.loaded=true;require.cache[r]=m;return exp;}
  Module._load=function(r,p,m){
    if(typeof r==='string'&&r.includes('managedIdentityCredential')&&r.endsWith('index.js')){c.idLoad++;return cacheExport(r,p,{ManagedIdentityCredential,DefaultAzureCredential});}
    if(typeof r==='string'&&r.includes('keyvault-keys')&&r.endsWith('cryptographyClient.js')){c.kvLoad++;return cacheExport(r,p,{CryptographyClient,KeyClient});}
    if(r==='@azure/identity'||r==='@azure/keyvault-keys'||(typeof r==='string'&&r.includes('@azure/')&&r.endsWith('dist/commonjs/index.js')))throw new Error('root '+r);
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
  ok('lazy deep-path MIC; app-root trust; no package-root require/DAC/DI helpers',
    !/^(const|let|var).*=\s*require\s*\(\s*['"]@azure\//m.test(src)
    && /require\.resolve/.test(src) && /managedIdentityCredential/.test(src) && /cryptographyClient\.js/.test(src)
    && /APP_ROOT|APP_NM_ROOT/.test(src) && /realpathSync\.native/.test(src) && !/process\.cwd\s*\(/.test(src)
    && /trusted package code only|app-root\/path\/version/i.test(src)
    && !/require\s*\(\s*['"]@azure\/identity['"]\s*\)/.test(src)
    && !/require\s*\(\s*['"]@azure\/keyvault-keys['"]\s*\)/.test(src)
    && /4\.13\.1/.test(src) && /4\.10\.2/.test(src)
    && /ManagedIdentityCredential/.test(src) && /never DefaultAzureCredential/i.test(src)
    && !/\bnew\s+\w*DefaultAzureCredential\b|identity\.DefaultAzureCredential|\.DefaultAzureCredential\b/.test(src)
    && src.includes(MI) && !/\bKeyClient\b|\bSecretClient\b|\.listPropertiesOfKeys\b/.test(src)
    && /ignore AZURE_CLIENT_ID|never AZURE_CLIENT_ID/i.test(src)
    && /canary|never be deployed|separately reviewed/i.test(src)
    && !/\bparseTestDeps\b|\bcreateCredential\b|\bcreateCryptographyClient\b|\bloadAzureSdksDefault\b|\btestDeps\b|\bKNOWN_SANITIZED_CODES\b/.test(src)
    && !/createEmailGrantEnvelopeAzureKvRuntimeComposition|parseEmailGrantEnvelopeAzureKvRuntimeConfig/.test(src));
  ok('SHA-256 pin identity + precise trust claim + no thrown-value property reads',
    /createHash\(\s*['"]sha256['"]\s*\)/.test(src)
    && /70f61fd65648da7d70750d17de2b726d3892d3cfd9637643d4e1c82c649620b9/.test(src)
    && /93d90cef99db00060c2eeb491b670d6c9873a38827884eb2a284b43e92735049/.test(src)
    && /a63ec9cca669e97f3f2f4c908a1896c27a627a4f7d673be0419ae72259f1d900/.test(src)
    && /pinIdentityBeforeRequire/.test(src) && /pinIdentityAfterRequire/.test(src)
    && /require\.cache/.test(src) && /execution trust boundary/i.test(src)
    && /does not claim/i.test(src) && /arbitrary local|code execution/i.test(src)
    && /Never read e\.code\/e\.message/.test(src)
    && !/loadAzureSdks[\s\S]{0,1400}catch\s*\(\s*e\s*\)[\s\S]{0,80}e\s*\.\s*code/.test(src)
    && /function throwSanitized\s*\(\s*_?maybe\s*,\s*fallback\s*\)/.test(src)
    && !/throwSanitized[\s\S]{0,220}maybe\s*\.\s*code/.test(src));
  ok('2F-B free of @azure; staff does not require composition',
    !/@azure\/identity/.test(coreSrc) && !/DefaultAzureCredential/.test(coreSrc)
    && !/require\s*\(\s*['"]@azure\//.test(coreSrc)
    && !/email-grant-envelope-azure-kv-.*runtime-composition/.test(staff));
  ok('production net LOC < 400; verifier < 1000',
    netLoc(src) < 400 && verifierSrc.split('\n').length < 1000);
  ok('Dockerfiles Node 22', DOCKERFILES.every((f) => {
    const p = path.join(ROOT, f);
    return fs.existsSync(p) && /FROM\s+node:22\b/i.test(fs.readFileSync(p, 'utf8'));
  }));
  ok('one-arg factory; no generic aliases / sanitized Set / testDeps export',
    typeof create === 'function' && create.length === 1
    && typeof createActive === 'function' && createActive.length === 1
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

  {
    const ch = runChild(PRE + `
      blockAzure(); const mod=require(COMP);
      const legacy=mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition({});
      const codes=[]; for(const v of [undefined,'false','TRUE','1',' true ']){try{
        const e=enabled(); if(v!==undefined)e[E_ACTIVE]=v;
        mod.createActiveEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(e);
      }catch(e){codes.push(e&&e.code);}}
      out({ok:legacy.runtime_activation===false&&legacy.composition_enabled===false
        &&codes.length===5&&codes.every(x=>x==='envelope_azure_kv_runtime_activation_disabled')&&!hits.length});
    `);
    const b = parseChildJson(ch);
    ok('active export exact-true/default-off; legacy inactive; zero disabled SDK import',
      ch.status === 0 && b && b.ok, JSON.stringify(b));
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

  // SDK deep-path spies + RSA + hostile AZURE + second-arg ignored
  const fakeAz = mkFakeAzureNodePath();
  const isolated = mkIsolatedAppRoot();
  const trustedPre = PRE.replace(
    `const COMP=${JSON.stringify(COMP_PATH)}`,
    `const COMP=${JSON.stringify(isolated.comp)}`,
  ) + '\ninstallPinnedHashFixture();\n';
  const np = { NODE_PATH: fakeAz.nodePath };
  try {
  {
    const ch = runChild(trustedPre + `
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
          &&c.wrapThis&&c.unwrapThis&&c.wrapThis===c.unwrapThis
          &&c.wrapArgs[0]==='RSA-OAEP-256'&&Buffer.isBuffer(c.wrapArgs[1])
          &&c.unwrapArgs[0]==='RSA-OAEP-256'&&Buffer.isBuffer(c.unwrapArgs[1])
          &&meta.deployment_boundary==='sunset-staging-canary-only'&&meta.runtime_activation===false&&noPlanted(meta),
          c:{mic:c.mic,cc:c.cc,idLoad:c.idLoad,kvLoad:c.kvLoad,micClientId:c.micClientId,ccKeyId:c.ccKeyId,
            maxRetries:c.ccOptions.retryOptions.maxRetries,prototypeOnly:c.prototypeOnly}});
        process.exit(0);
      }catch(e){out({ok:false,stage:'async',err:String(e&&e.message)});process.exit(4);}})();
    `, np);
    const b = parseChildJson(ch);
    ok('prototype-only SDK client seal/open + hostile AZURE/DI ignored',
      ch.status === 0 && b && b.ok && b.c && b.c.prototypeOnly === true
      && b.c.mic === 1 && b.c.cc === 1
      && b.c.micClientId === MI && b.c.ccKeyId === KID && b.c.maxRetries === 0,
      `st=${ch.status} ${(ch.stderr || '').slice(0, 160)} ${JSON.stringify(b)}`);
  }

  // throwing code getter
  {
    const ch = runChild(trustedPre + `
      const c={mic:0,cc:0,dac:0,keyClient:0,idLoad:0,kvLoad:0};
      installSpies(c,'throwGetter'); const mod=require(COMP); let sanitized=false;
      try{mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(enabled());}
      catch(e){sanitized=e&&e.code==='envelope_kv_failed'&&e.message==='envelope_kv_failed'
        &&noPlanted(e)&&!Object.prototype.hasOwnProperty.call(e,'secret_field');}
      out({ok:sanitized});
    `, np);
    const b = parseChildJson(ch);
    ok('throwing code getter on construction → envelope_kv_failed (no plant)',
      ch.status === 0 && b && b.ok, JSON.stringify(b));
  }

  // proxy traps
  {
    const ch = runChild(trustedPre + `
      const c={mic:0,cc:0,dac:0,keyClient:0,idLoad:0,kvLoad:0};
      installSpies(c,'throwProxy'); const mod=require(COMP); let sanitized=false;
      try{mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(enabled());}
      catch(e){sanitized=e&&e.code==='envelope_kv_failed'&&e.message==='envelope_kv_failed'&&noPlanted(e);}
      out({ok:sanitized});
    `, np);
    const b = parseChildJson(ch);
    ok('proxy ownKeys/getOwnPropertyDescriptor/getPrototypeOf traps → sanitized',
      ch.status === 0 && b && b.ok, JSON.stringify(b));
  }

  // missing packages
  {
    const ch = runChild(PRE + `
      blockAzure(); const mod=require(COMP); let threw=false;
      try{mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(enabled());}
      catch(e){threw=e&&e.code==='envelope_azure_kv_sdk_unavailable'
        &&e.message==='envelope_azure_kv_sdk_unavailable'&&noPlanted(e);}
      out({ok:threw,hits:hits.length});
    `);
    const b = parseChildJson(ch);
    ok('missing @azure → sanitized sdk_unavailable', ch.status === 0 && b && b.ok, JSON.stringify(b));
  }

  // planted wrap via provider
  {
    const ch = runChild(trustedPre + `
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
    `, np);
    const b = parseChildJson(ch);
    ok('planted wrap exception sanitized at provider boundary',
      ch.status === 0 && b && b.ok, JSON.stringify(b));
  }

  {
    const ch = runChild(PRE + `
      function clr(){for(const k of Object.keys(require.cache))if(/@azure|managedIdentity|cryptographyClient|email-grant-envelope-azure-kv-sunset/.test(k))delete require.cache[k];}
      function runCase(kind){let hits=0;clr();const rl=Module._load;
        Module._load=function(r,p,m){
          if(typeof r==='string'&&r.includes('managedIdentityCredential')&&r.endsWith('index.js')){
            if(kind==='proxy')throw new Proxy({},{get(){hits++;throw new Error(PLANTED);},
              getOwnPropertyDescriptor(){hits++;throw new Error(PLANTED);},ownKeys(){hits++;throw new Error(PLANTED);},
              getPrototypeOf(){hits++;throw new Error(PLANTED);},has(){hits++;throw new Error(PLANTED);}});
            if(kind==='accessor'){const h={};Object.defineProperty(h,'code',{enumerable:true,get(){hits++;throw new Error(PLANTED);}});
              Object.defineProperty(h,'message',{enumerable:true,get(){hits++;throw new Error(PLANTED);}});throw h;}
            if(kind==='getter'){const o={};Object.defineProperty(o,'ManagedIdentityCredential',{enumerable:true,get(){hits++;return function(){};}});
              const mo=new Module(r,p);mo.filename=r;mo.exports=o;mo.loaded=true;require.cache[r]=mo;return o;}
            if(kind==='cacheMut'){const exp=rl(r,p,m);const ent=require.cache[r];if(ent)ent.filename='/tmp/evil-azure-mic-mutant.js';return exp;}
          }
          if(kind==='getter'&&typeof r==='string'&&r.endsWith('cryptographyClient.js')){
            const exp={CryptographyClient:function(){}};const mo=new Module(r,p);mo.filename=r;mo.exports=exp;mo.loaded=true;require.cache[r]=mo;return exp;}
          return rl(r,p,m);};
        const mod=require(COMP);let code=null;
        try{mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(enabled());}catch(e){code=e&&e.code;}
        Module._load=rl;return {code,hits};}
      const proxy=runCase('proxy'),acc=runCase('accessor'),get=runCase('getter'),mut=runCase('cacheMut');
      out({ok:proxy.code==='envelope_azure_kv_sdk_unavailable'&&proxy.hits===0
        &&acc.code==='envelope_azure_kv_sdk_unavailable'&&acc.hits===0
        &&get.code==='envelope_azure_kv_sdk_unavailable'&&get.hits===0
        &&mut.code==='envelope_azure_kv_sdk_unavailable',proxy,acc,get,mut});
    `);
    const b = parseChildJson(ch);
    ok('loadAzureSdks Proxy/accessor/getter/cacheMut → sdk_unavailable; trap hits=0',
      ch.status === 0 && b && b.ok, JSON.stringify(b));
  }
  // NODE_PATH spoof: exact meta/layout/getter outside app root → reject before require/getter
  {
    const idE=path.join(fakeAz.nodePath,'@azure/identity/dist/commonjs/index.js');
    const kvE=path.join(fakeAz.nodePath,'@azure/keyvault-keys/dist/commonjs/index.js');
    fs.writeFileSync(path.join(fakeAz.nodePath,'@azure/identity/dist/commonjs/credentials/managedIdentityCredential/index.js'),
      "const o={};Object.defineProperty(o,'ManagedIdentityCredential',{enumerable:true,get(){globalThis.__spoofG=(globalThis.__spoofG||0)+1;return function(){};}});module.exports=o;");
    fs.writeFileSync(path.join(fakeAz.nodePath,'@azure/keyvault-keys/dist/commonjs/cryptographyClient.js'),
      "const o={};Object.defineProperty(o,'CryptographyClient',{enumerable:true,get(){globalThis.__spoofG=(globalThis.__spoofG||0)+1;return function(){};}});module.exports=o;");
    const ch=runChild(PRE+`
      const idE=${JSON.stringify(idE)},kvE=${JSON.stringify(kvE)},base=${JSON.stringify(fakeAz.base)};
      const rr=Module._resolveFilename;Module._resolveFilename=function(r,p,m,o){
        if(r==='@azure/identity')return idE;if(r==='@azure/keyvault-keys')return kvE;return rr(r,p,m,o);};
      let loads=0;const rl=Module._load;Module._load=function(r,p,m){
        if(typeof r==='string'&&(r.includes('managedIdentityCredential')||r.endsWith('cryptographyClient.js')||r===idE||r===kvE||r.includes(base)))loads++;
        return rl(r,p,m);};
      const mod=require(COMP);let code=null;
      try{mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(enabled());}catch(e){code=e&&e.code;}
      out({ok:code==='envelope_azure_kv_sdk_unavailable'&&loads===0&&(globalThis.__spoofG||0)===0,code,loads,g:globalThis.__spoofG||0});
    `,{NODE_PATH:fakeAz.nodePath});
    const b=parseChildJson(ch);
    ok('NODE_PATH spoof exact meta/layout/getter: reject before require; getter=0', ch.status===0&&b&&b.ok, JSON.stringify(b));
  }
  // Symlink escape: resolve → symlink whose realpath is outside app package root
  {
    const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'az-sym-'));
    try{
      const evil=path.join(outDir,'evil-entry.js');
      fs.writeFileSync(evil,'globalThis.__symG=(globalThis.__symG||0)+1;module.exports={};');
      const link=path.join(outDir,'link-entry.js'); fs.symlinkSync(evil,link);
      const ch=runChild(PRE+`
        const link=${JSON.stringify(link)},outDir=${JSON.stringify(outDir)};
        const rr=Module._resolveFilename;Module._resolveFilename=function(r,p,m,o){
          if(r==='@azure/identity'||r==='@azure/keyvault-keys')return link;return rr(r,p,m,o);};
        let loads=0;const rl=Module._load;Module._load=function(r,p,m){
          if(typeof r==='string'&&(r===link||r.includes(outDir)))loads++;return rl(r,p,m);};
        const mod=require(COMP);let code=null;
        try{mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(enabled());}catch(e){code=e&&e.code;}
        out({ok:code==='envelope_azure_kv_sdk_unavailable'&&loads===0&&(globalThis.__symG||0)===0,code,loads,g:globalThis.__symG||0});
      `);
      const b=parseChildJson(ch);
      ok('symlink escape entry realpath outside app root: reject; load/getter=0', ch.status===0&&b&&b.ok, JSON.stringify(b));
    }finally{try{fs.rmSync(outDir,{recursive:true,force:true});}catch{/* ignore */}}
  }
  } finally {
    try { fs.rmSync(fakeAz.base, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(isolated.base, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // REAL app-root SDK only (never NODE_PATH authority); zero network at construct
  {
    let appAz=false;
    try{require.resolve('@azure/identity',{paths:[path.join(ROOT,'node_modules')]});
      require.resolve('@azure/keyvault-keys',{paths:[path.join(ROOT,'node_modules')]});appAz=true;}catch{}
    if(!appAz) ok('REAL Azure SDK environmental absence (not claiming construct)', true);
    else {
      const ch=runChild(PRE+`
        const https=require('https'),http=require('http'),net=require('net'),tls=require('tls');
        let netN=0;const bump=()=>{netN++;throw new Error('net');};
        https.request=bump;http.request=bump;net.connect=bump;tls.connect=bump;
        if(typeof globalThis.fetch==='function')globalThis.fetch=bump;
        const loads={root:0,deep:0};const rl=Module._load;
        Module._load=function(r,p,m){if(typeof r==='string'){
          if(r==='@azure/identity'||r==='@azure/keyvault-keys'||(r.includes('@azure/')&&r.endsWith('dist/commonjs/index.js')))loads.root++;
          if(r.includes('managedIdentityCredential')||r.endsWith('cryptographyClient.js'))loads.deep++;}
          return rl(r,p,m);};
        const idE=require.resolve('@azure/identity'),kvE=require.resolve('@azure/keyvault-keys');
        const mod=require(COMP); let composed=null,code=null;
        try{composed=mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(enabled());}catch(e){code=e&&e.code;}
        out({ok:!!composed&&composed.ok&&loads.root===0&&loads.deep>=2&&netN===0&&!require.cache[idE]&&!require.cache[kvE]&&!code,loads,netN,code});
      `);
      const b=parseChildJson(ch);
      ok('REAL app-root SDK deep construct; zero root/cache/network', ch.status===0&&b&&b.ok, `st=${ch.status} ${JSON.stringify(b)}`);
    }
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
