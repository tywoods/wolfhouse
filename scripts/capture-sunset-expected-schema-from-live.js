'use strict';

/**
 * Evidence-only live catalog snapshot collector (FOUNDATION Slice 11 correction).
 *
 * Writes ONLY under gitignored tmp/foundation-slice11/ as
 *   actual-live-state-evidence.json
 * labeled "actual live state — not canonical".
 *
 * NEVER overwrites fixtures/sunset-schema-observer/expected-product-schema.json.
 * Live state must not bless, refresh, or replace the canonical expected contract.
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
const CANONICAL_FIXTURE = path.join(
  ROOT,
  'fixtures',
  'sunset-schema-observer',
  'expected-product-schema.json',
);
const OUT_DIR = path.join(ROOT, 'tmp', 'foundation-slice11');
const OUT = path.join(OUT_DIR, 'actual-live-state-evidence.json');
const OBSERVER_SECRET = 'sunset-schema-observer-database-url';

function refuseCanonicalOverwrite() {
  // Hard guard: this module must never resolve an output path under fixtures/.
  const forbidden = path.normalize(CANONICAL_FIXTURE);
  const outNorm = path.normalize(OUT);
  if (outNorm === forbidden || outNorm.includes(`${path.sep}fixtures${path.sep}sunset-schema-observer${path.sep}expected-product-schema.json`)) {
    throw Object.assign(new Error('refused_canonical_fixture_overwrite'), { code: 'refused_canonical_fixture_overwrite' });
  }
  if (/[\\/]fixtures[\\/]/.test(outNorm) && /expected-product-schema\.json$/.test(outNorm)) {
    throw Object.assign(new Error('refused_canonical_fixture_overwrite'), { code: 'refused_canonical_fixture_overwrite' });
  }
}

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
      label:'actual live state — not canonical',
      notCanonical:true,
      observation:{
        kind:'sunset-schema-observer-actual-live-state',
        scope:CONTRACT_SCOPE,
        includedSections:INCLUDED_SECTIONS.slice(),
        excludedSections:EXCLUDED_SECTIONS.slice(),
        ownershipCoverage:OWNERSHIP_COVERAGE.slice(),
        aclCoverage:ACL_COVERAGE.slice(),
        extensionCoverage:EXTENSION_COVERAGE.slice(),
        generatedAt:new Date().toISOString(),
        source:'live-observation-only',
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
  refuseCanonicalOverwrite();
  const localManifest = loadManifest(MANIFEST_PATH);
  const { manifestHash: localHash, forward } = hashCanonicalManifest(localManifest);

  console.log('Capturing actual live state evidence (not canonical)…');
  const result = runStagedWorkerSource(buildCaptureWorker());
  if (!result || result.ok !== true || !result.observation) {
    console.error(JSON.stringify({ ok: false, error: 'capture_failed', detail: result && result.error }, null, 2));
    process.exit(2);
  }
  if (!result.tempWorkerSecretCleanup || result.tempWorkerSecretCleanup.ok !== true) {
    console.error(JSON.stringify({ ok: false, error: 'temp_worker_cleanup_failed' }));
    process.exit(2);
  }
  const observation = result.observation;
  if (observation.manifestHash !== localHash) {
    console.error(JSON.stringify({ ok: false, error: 'manifest_hash_mismatch' }));
    process.exit(2);
  }
  if (Number(observation.forwardCount) !== forward.length) {
    console.error(JSON.stringify({ ok: false, error: 'forward_count_mismatch' }));
    process.exit(2);
  }

  refuseCanonicalOverwrite();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const evidence = {
    kind: 'sunset-schema-observer-actual-live-state-evidence',
    label: 'actual live state — not canonical',
    notCanonical: true,
    mustNotOverwriteExpectedFixture: true,
    generatedAt: new Date().toISOString(),
    productFingerprint: observation.productFingerprint,
    forwardCount: observation.forwardCount,
    manifestHash: observation.manifestHash,
    snapshot: observation.snapshot,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(OUT, 0o600); } catch (_) { /* windows */ }

  // Prove we did not touch the canonical fixture path in this process.
  const canonicalStill = fs.existsSync(CANONICAL_FIXTURE)
    ? JSON.parse(fs.readFileSync(CANONICAL_FIXTURE, 'utf8'))
    : null;
  if (canonicalStill && canonicalStill.source === 'live-sunset-staging-observer-catalog') {
    console.error(JSON.stringify({ ok: false, error: 'canonical_fixture_was_live_derived' }));
    process.exit(2);
  }

  console.log(JSON.stringify({
    ok: true,
    path: path.relative(ROOT, OUT).replace(/\\/g, '/'),
    label: evidence.label,
    productFingerprint: evidence.productFingerprint,
    overwroteCanonicalFixture: false,
  }, null, 2));
}

module.exports = {
  CANONICAL_FIXTURE,
  OUT,
  refuseCanonicalOverwrite,
  buildCaptureWorker,
};

if (require.main === module) {
  main();
}
