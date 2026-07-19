'use strict';

/**
 * Capture Sunset staging expected-product-schema.json from the live read-only
 * observer catalog (secret-safe staff-api path). Does not mutate the database.
 */

const fs = require('fs');
const path = require('path');
const {
  runStagedWorkerSource,
  SUNSET_STAGING_MI_CLIENT_ID,
} = require('./lib/sunset-schema-observer-role-container-pg');
const { TARGETS } = require('./lib/sunset-schema-observer-role-provision');
const {
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  CONTRACT_SCOPE,
  INCLUDED_SECTIONS,
  EXCLUDED_SECTIONS,
  OWNERSHIP_COVERAGE,
  ACL_COVERAGE,
  EXTENSION_COVERAGE,
  hashCanonicalManifest,
} = require('./lib/sunset-schema-observer');
const { loadManifest, MANIFEST_PATH } = require('./lib/migration-integrity');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'fixtures', 'sunset-schema-observer', 'expected-product-schema.json');
const OBSERVER_SECRET = 'sunset-schema-observer-database-url';

function buildCaptureWorker() {
  return `
const http=require('http'),https=require('https');
const {Client}=require('/app/node_modules/pg');
const {
  introspectProductSchema,fingerprintProductSchema,
  CONTRACT_SCOPE,INCLUDED_SECTIONS,EXCLUDED_SECTIONS,
  OWNERSHIP_COVERAGE,ACL_COVERAGE,EXTENSION_COVERAGE,
  hashCanonicalManifest,
}=require('/app/scripts/lib/sunset-schema-observer');
const {loadManifest}=require('/app/scripts/lib/migration-integrity');
const HOST=${JSON.stringify(EXPECTED_HOST)};
const DB=${JSON.stringify(EXPECTED_DATABASE)};
const KV=${JSON.stringify(TARGETS.keyVault)};
const SECRET=${JSON.stringify(OBSERVER_SECRET)};
const MI=${JSON.stringify(SUNSET_STAGING_MI_CLIENT_ID)};
function emit(o){process.stdout.write('WH_OBS_BEGIN'+JSON.stringify(o)+'WH_OBS_END');}
function getMiToken(resource){
  const endpoint=process.env.IDENTITY_ENDPOINT,header=process.env.IDENTITY_HEADER;
  if(!endpoint||!header) throw new Error('managed_identity_unavailable');
  const clientId=process.env.AZURE_CLIENT_ID||MI;
  const url=endpoint+'?api-version=2019-08-01&resource='+encodeURIComponent(resource)+'&client_id='+encodeURIComponent(clientId);
  return new Promise((resolve,reject)=>{
    http.get(url,{headers:{'X-IDENTITY-HEADER':header}},(res)=>{
      let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d).access_token);}catch(e){reject(e);}});
    }).on('error',reject);
  });
}
function kvGet(name,token){
  const p='/secrets/'+encodeURIComponent(name)+'?api-version=7.4';
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:KV+'.vault.azure.net',path:p,method:'GET',headers:{Authorization:'Bearer '+token}},(res)=>{
      let d='';res.on('data',c=>d+=c);res.on('end',()=>{
        if(res.statusCode===404) return resolve(null);
        if(res.statusCode>=300) return reject(new Error('kv_get_'+res.statusCode));
        try{resolve(JSON.parse(d).value);}catch(e){reject(e);}
      });
    });
    req.on('error',reject);req.end();
  });
}
(async()=>{
  const token=await getMiToken('https://vault.azure.net');
  const dsn=await kvGet(SECRET,token);
  if(!dsn) throw new Error('observer_secret_missing');
  const u=new URL(dsn);
  if(u.hostname!==HOST) throw new Error('wrong_host');
  if((u.pathname||'').replace(/^\\//,'')!==DB) throw new Error('wrong_db');
  const client=new Client({connectionString:dsn,ssl:{rejectUnauthorized:true,servername:HOST},connectionTimeoutMillis:20000,application_name:'wh-sunset-schema-observer'});
  await client.connect();
  try{
    const product=await introspectProductSchema(client);
    const manifest=loadManifest('/app/database/migrations/manifest.json');
    const {manifestHash,forward}=hashCanonicalManifest(manifest);
    const productFingerprint=fingerprintProductSchema(product.snapshot);
    emit({
      ok:true,
      contract:{
        kind:'sunset-expected-product-schema',
        scope:CONTRACT_SCOPE,
        includedSections:INCLUDED_SECTIONS.slice(),
        excludedSections:EXCLUDED_SECTIONS.slice(),
        ownershipCoverage:OWNERSHIP_COVERAGE.slice(),
        aclCoverage:ACL_COVERAGE.slice(),
        extensionCoverage:EXTENSION_COVERAGE.slice(),
        generatedAt:new Date().toISOString(),
        source:'live-sunset-staging-observer-catalog',
        forwardCount:forward.length,
        manifestHash,
        productFingerprint,
        snapshot:product.snapshot,
      },
    });
  } finally { try{await client.end();}catch(_){}}
})().catch((e)=>{emit({ok:false,error:String(e&&e.message||e).slice(0,300)});process.exit(1);});
`;
}

function main() {
  // Prefer local manifest hash for the committed fixture; worker also computes from image.
  const localManifest = loadManifest(MANIFEST_PATH);
  const { manifestHash: localHash, forward } = hashCanonicalManifest(localManifest);

  console.log('Capturing live product schema via secret-safe staff-api path…');
  const result = runStagedWorkerSource(buildCaptureWorker());
  if (!result || result.ok !== true || !result.contract) {
    console.error(JSON.stringify({ ok: false, error: 'capture_failed', detail: result && result.error }, null, 2));
    process.exit(2);
  }
  if (!result.tempWorkerSecretCleanup || result.tempWorkerSecretCleanup.ok !== true) {
    console.error(JSON.stringify({ ok: false, error: 'temp_worker_cleanup_failed' }));
    process.exit(2);
  }
  const contract = result.contract;
  if (contract.manifestHash !== localHash) {
    console.error(JSON.stringify({
      ok: false,
      error: 'manifest_hash_mismatch',
      image: contract.manifestHash,
      local: localHash,
    }));
    process.exit(2);
  }
  if (Number(contract.forwardCount) !== forward.length) {
    console.error(JSON.stringify({ ok: false, error: 'forward_count_mismatch' }));
    process.exit(2);
  }
  if (!contract.productFingerprint || !contract.snapshot) {
    console.error(JSON.stringify({ ok: false, error: 'incomplete_contract' }));
    process.exit(2);
  }
  fs.writeFileSync(OUT, `${JSON.stringify(contract, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    path: path.relative(ROOT, OUT).replace(/\\/g, '/'),
    productFingerprint: contract.productFingerprint,
    forwardCount: contract.forwardCount,
    source: contract.source,
  }, null, 2));
}

main();
