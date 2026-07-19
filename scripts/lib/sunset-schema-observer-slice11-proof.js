'use strict';

/**
 * FOUNDATION Slice 11 — secret-safe staff-api worker for read-only + drift proofs.
 * Uses MI to read observer DSN inside the container only; never returns secret values.
 */

const {
  runStagedWorkerSource,
  SUNSET_STAGING_MI_CLIENT_ID,
} = require('./sunset-schema-observer-role-container-pg');
const { TARGETS } = require('./sunset-schema-observer-role-provision');
const { EXPECTED_HOST, EXPECTED_DATABASE } = require('./sunset-schema-observer');

const OBSERVER_SECRET = 'sunset-schema-observer-database-url';
const ROLE = 'sunset_schema_observer';
const DRIFT_MARKER = 'slice11_synthetic_enum_mismatch_label';

function buildSlice11ProofWorker() {
  const mi = SUNSET_STAGING_MI_CLIENT_ID;
  const host = EXPECTED_HOST;
  const db = EXPECTED_DATABASE;
  const kv = TARGETS.keyVault;
  const secret = OBSERVER_SECRET;
  const role = ROLE;
  const driftLabel = DRIFT_MARKER;

  return `
const http=require('http'),https=require('https'),fs=require('fs'),{spawnSync}=require('child_process');
const {Client}=require('/app/node_modules/pg');
const {fingerprintProductSchema}=require('/app/scripts/lib/sunset-schema-observer');
const HOST=${JSON.stringify(host)};
const DB=${JSON.stringify(db)};
const ROLE=${JSON.stringify(role)};
const KV=${JSON.stringify(kv)};
const SECRET=${JSON.stringify(secret)};
const DRIFT_LABEL=${JSON.stringify(driftLabel)};
const MI=${JSON.stringify(mi)};

function emit(o){process.stdout.write('WH_OBS_BEGIN'+JSON.stringify(o)+'WH_OBS_END');}

function getMiToken(resource){
  const endpoint=process.env.IDENTITY_ENDPOINT,header=process.env.IDENTITY_HEADER;
  if(!endpoint||!header) throw new Error('managed_identity_unavailable');
  const clientId=process.env.AZURE_CLIENT_ID||MI;
  const url=endpoint+'?api-version=2019-08-01&resource='+encodeURIComponent(resource)+'&client_id='+encodeURIComponent(clientId);
  return new Promise((resolve,reject)=>{
    http.get(url,{headers:{'X-IDENTITY-HEADER':header}},(res)=>{
      let d='';res.on('data',c=>d+=c);res.on('end',()=>{
        try{resolve(JSON.parse(d).access_token);}catch(e){reject(e);}
      });
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

function denyOk(err){
  const m=String(err&&err.message||err);
  return /permission denied|insufficient privilege|must be owner|cannot execute .* in a read-only transaction|read-only transaction/i.test(m);
}

function denyDetail(err){return String(err&&err.message||err).replace(/:[^:@/]+@/g,':***@').slice(0,160);}

async function withObserver(opts,fn){
  const token=await getMiToken('https://vault.azure.net');
  const dsn=await kvGet(SECRET,token);
  if(!dsn||typeof dsn!=='string') throw new Error('observer_secret_missing');
  let u; try{u=new URL(dsn);}catch(e){throw new Error('observer_dsn_parse_failed');}
  if(u.hostname!==HOST) throw new Error('wrong_observer_host');
  if((u.pathname||'').replace(/^\\//,'')!==DB) throw new Error('wrong_observer_database');
  const client=new Client({
    connectionString:dsn,
    ssl:{rejectUnauthorized:true,servername:HOST},
    connectionTimeoutMillis:20000,
    application_name:'wh-sunset-schema-observer',
    options:opts||undefined,
  });
  await client.connect();
  try{return await fn(client);} finally{try{await client.end();}catch(_){}}
}

async function probeReadOnly(client){
  const out={};
  const id=await client.query('SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr');
  out.current_database=id.rows[0].db;
  out.current_user=id.rows[0].usr;
  const tro=await client.query('SHOW transaction_read_only');
  out.transaction_read_only=String(tro.rows[0].transaction_read_only).toLowerCase();
  const cat=await client.query("SELECT COUNT(*)::int AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'");
  out.catalog_public_table_count=cat.rows[0].n;
  out.host=HOST;
  out.database=DB;
  out.green_host_db=out.current_database===DB && out.current_user===ROLE;
  out.green_read_only=out.transaction_read_only==='on';
  out.green_catalog=Number(out.catalog_public_table_count)>0;

  const attrs=(await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user')).rows[0];
  out.attributes={
    rolsuper:attrs.rolsuper===true,rolcreatedb:attrs.rolcreatedb===true,rolcreaterole:attrs.rolcreaterole===true,
    rolinherit:attrs.rolinherit===true,rolreplication:attrs.rolreplication===true,rolbypassrls:attrs.rolbypassrls===true,
    rolcanlogin:attrs.rolcanlogin===true,
  };
  out.memberships=(await client.query('SELECT r.rolname AS member_of FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE u.rolname=current_user ORDER BY 1')).rows.map(r=>r.member_of);
  out.ownedObjects=(await client.query("SELECT n.nspname||'.'||c.relname AS obj FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname=current_user ORDER BY 1 LIMIT 20")).rows.map(r=>r.obj);
  out.hasConnect=(await client.query('SELECT has_database_privilege(current_user, current_database(), \\'CONNECT\\') AS c')).rows[0].c===true;
  out.hasSelectBookings=false;
  try{
    out.hasSelectBookings=(await client.query("SELECT has_table_privilege(current_user, 'public.bookings', 'SELECT') AS s")).rows[0].s===true;
  }catch(_){ out.hasSelectBookings=null; }
  out.green_authority=
    out.attributes.rolsuper===false && out.attributes.rolcreatedb===false && out.attributes.rolcreaterole===false
    && out.attributes.rolinherit===false && out.attributes.rolreplication===false && out.attributes.rolbypassrls===false
    && out.memberships.length===0 && out.ownedObjects.length===0 && out.hasConnect===true && out.hasSelectBookings===false;
  return out;
}

async function probeDenied(client){
  const red={};
  try{await client.query('INSERT INTO bookings DEFAULT VALUES');red.insert={ok:false,detail:'unexpected_success'};}
  catch(e){red.insert={ok:denyOk(e),detail:denyDetail(e)};}
  try{await client.query('UPDATE bookings SET id = id WHERE false');red.update={ok:false,detail:'unexpected_success'};}
  catch(e){red.update={ok:denyOk(e),detail:denyDetail(e)};}
  try{await client.query('CREATE TABLE wh_slice11_should_fail (id int)');red.createTable={ok:false,detail:'unexpected_success'};}
  catch(e){red.createTable={ok:denyOk(e),detail:denyDetail(e)};}
  try{await client.query('CREATE ROLE wh_slice11_escalation_probe');red.createRole={ok:false,detail:'unexpected_success'};}
  catch(e){red.createRole={ok:denyOk(e),detail:denyDetail(e)};}
  return red;
}

function runObserver(contractPath,envDsn){
  const r=spawnSync(process.execPath,['/app/scripts/observe-sunset-schema-drift.js','--contract',contractPath],{
    encoding:'utf8',env:{...process.env,SUNSET_SCHEMA_OBSERVER_DATABASE_URL:envDsn},timeout:90000,
  });
  const out=String(r.stdout||'')+String(r.stderr||'');
  const b=out.indexOf('WH_SCHEMA_OBSERVER_BEGIN');
  const e=out.indexOf('WH_SCHEMA_OBSERVER_END');
  let report=null;
  if(b>=0&&e>b){try{report=JSON.parse(out.slice(b+'WH_SCHEMA_OBSERVER_BEGIN'.length,e).trim());}catch(_){}}
  return {status:r.status,report,leaked:/postgres(ql)?:\\/\\/[^\\s"']+:[^\\s"']+@/i.test(out)};
}

async function main(){
  const token=await getMiToken('https://vault.azure.net');
  const dsn=await kvGet(SECRET,token);
  if(!dsn) throw new Error('observer_secret_missing');

  const session=await withObserver(undefined, probeReadOnly);
  const denied=await withObserver('-c default_transaction_read_only=off', probeDenied);

  const contractPath='/app/fixtures/sunset-schema-observer/expected-product-schema.json';
  const match=runObserver(contractPath,dsn);

  const contract=JSON.parse(fs.readFileSync(contractPath,'utf8'));
  if(!Array.isArray(contract.snapshot&&contract.snapshot.enums)||!contract.snapshot.enums.length){
    throw new Error('contract_enums_missing');
  }
  const mutated=JSON.parse(JSON.stringify(contract));
  const first=mutated.snapshot.enums[0];
  const labels=Array.isArray(first.labels)?first.labels.slice():[];
  labels.push(DRIFT_LABEL);
  first.labels=labels;
  mutated.productFingerprint=fingerprintProductSchema(mutated.snapshot);
  const driftPath='/tmp/wh-slice11-drift-contract.json';
  fs.writeFileSync(driftPath,JSON.stringify(mutated));
  const drift=runObserver(driftPath,dsn);
  try{fs.unlinkSync(driftPath);}catch(_){}

  const recover=runObserver(contractPath,dsn);

  const sample=(drift.report&&drift.report.drift&&drift.report.drift.sample)||[];
  const hasMarker=JSON.stringify(sample).includes(DRIFT_LABEL)||JSON.stringify(drift.report||{}).includes('definition_mismatch');

  emit({
    ok:true,
    kind:'sunset-schema-observer-slice11-staff-api-proof',
    session,
    denied,
    match:{
      status:match.status,
      ok:!!(match.report&&match.report.ok),
      match:!!(match.report&&match.report.match),
      productFingerprintExpected:match.report&&match.report.productFingerprintExpected||null,
      productFingerprintLive:match.report&&match.report.productFingerprintLive||null,
      mismatchCount:match.report&&match.report.drift&&match.report.drift.counts
        ?(match.report.drift.counts.expected_only+match.report.drift.counts.live_only+match.report.drift.counts.definition_mismatch):null,
      leaked:match.leaked,
    },
    drift:{
      method:'isolated_staff_api_observer_with_temp_synthetic_contract',
      status:drift.status,
      ok:!!(drift.report&&drift.report.ok),
      match:!!(drift.report&&drift.report.match),
      code:drift.report&&drift.report.code||null,
      mismatchCount:drift.report&&drift.report.drift&&drift.report.drift.counts
        ?(drift.report.drift.counts.expected_only+drift.report.drift.counts.live_only+drift.report.drift.counts.definition_mismatch):null,
      counts:drift.report&&drift.report.drift&&drift.report.drift.counts||null,
      hasDefinitionMismatch:!!(drift.report&&drift.report.drift&&drift.report.drift.counts&&drift.report.drift.counts.definition_mismatch>0),
      hasMarker,
      driftLabel:DRIFT_LABEL,
      leaked:drift.leaked,
      distinctFromLiveJob:true,
    },
    recover:{
      status:recover.status,
      ok:!!(recover.report&&recover.report.ok),
      match:!!(recover.report&&recover.report.match),
      mismatchCount:recover.report&&recover.report.drift&&recover.report.drift.counts
        ?(recover.report.drift.counts.expected_only+recover.report.drift.counts.live_only+recover.report.drift.counts.definition_mismatch):null,
      leaked:recover.leaked,
    },
  });
}
main().catch((e)=>{emit({ok:false,error:String(e&&e.message||e).slice(0,300)});process.exit(1);});
`;
}

function runSlice11StaffApiProof() {
  return runStagedWorkerSource(buildSlice11ProofWorker());
}

module.exports = {
  DRIFT_MARKER,
  OBSERVER_SECRET,
  buildSlice11ProofWorker,
  runSlice11StaffApiProof,
};
