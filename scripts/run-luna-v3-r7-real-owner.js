#!/usr/bin/env node
'use strict';
/** Isolated TEST-only owner receipt issuer. Starts Staff, NEVER PostgreSQL.
 * Required env: NODE_ENV=test LUNA_OWNER_TEST_RUN=true LUNA_OWNER_ADMIN_URL
 * LUNA_OWNER_DB=luna_owner_test_<unique> LUNA_OWNER_PORT LUNA_OWNER_OUTPUT
 * LUNA_OWNER_RECEIPT_ISSUER_KEY (>=32 bytes; separate from Staff bot auth).
 * Existing databases/directories are refused, never replaced. Parent owns PG.
 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {config,recipes}=require('./lib/model-led-luna/staff-owner-run-plan');
const {SCHEMA,ADMIT,PREPARE,canonical,sha256,choicesForMatrix,publicPrepare,deriveExecution,deriveRecord,verify}=require('./lib/model-led-luna/staff-owner-http-receipt');
const ROOT=path.resolve(__dirname,'..');
async function client(url){const {Client}=require('pg');const c=new Client({connectionString:url});await c.connect();return c;}
async function build(cfg){
 const a=await client(cfg.admin);
 try {await a.query(`CREATE DATABASE ${cfg.db}`);} finally {await a.end();}
 const c=await client(cfg.database);
 try {
  const source=fs.readFileSync(path.join(ROOT,'scripts/lib/model-led-luna/test-v3-postgres.js'),'utf8');
  const match=source.match(/const base = `([\s\S]*?)`;\nfunction ctx/);if(!match)throw new Error('repository base schema not found');
  await c.query(match[1]);
  const lineage=['091_booking_occupancy_serialization.sql','114_luna_v3_staff_operations.sql','115_luna_v3_guest_operations.sql','117_cancel_unpaid_payment_race_guard.sql','119_luna_v3_guest_payment_history.sql','120_luna_v3_constraint_ownership_and_transfer_decline.sql','121_wolfhouse_confirmed_rental_prices.sql','122_luna_v3_group_payment_targets.sql','123_luna_v3_one_try_offers.sql','124_luna_v3_fix2_evidence_and_cancel_guard.sql','125_luna_v3_prepare_attempts.sql','126_luna_v3_runtime_event_capabilities.sql','127_luna_v3_prepare_execution_leases.sql','128_luna_v3_prepare_owner_release.sql','129_luna_v3_prepare_control_plane.sql'];
  for(const name of lineage)await c.query(fs.readFileSync(path.join(ROOT,'database/migrations',name),'utf8'));
  await c.query(`CREATE TABLE conversations(id uuid primary key default gen_random_uuid(),client_id uuid references clients,display_name text,phone text,language text,needs_human boolean,status text,bot_mode text,metadata jsonb default '{}');
   INSERT INTO clients(id,slug) VALUES('10000000-0000-0000-0000-000000000001','wolfhouse-somo');
   INSERT INTO rooms(id,client_id,name,room_code,room_type,selling_mode,capacity) VALUES('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','Owner TEST Room','R7','shared','shared',8);
   INSERT INTO beds(id,client_id,room_id,bed_code,bed_number,active,sellable) SELECT gen_random_uuid(),'10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','R7-B'||g,g,true,true FROM generate_series(1,8) g;
   INSERT INTO wh_pricing_seasons(client_slug,code,label,priority,bookable,active,sort_order) VALUES('wolfhouse-somo','all','All',1,true,true,1);
   INSERT INTO wh_pricing_season_ranges(season_id,start_month,start_day,end_month,end_day,sort_order) SELECT id,1,1,12,31,1 FROM wh_pricing_seasons;
   INSERT INTO wh_pricing_items(client_slug,item_type,item_code,label,metadata,active,sort_order) VALUES
   ('wolfhouse-somo','package','malibu','Malibu','{"includes":["stay"],"min_days":1}',true,1),
   ('wolfhouse-somo','service','group_lesson','Group lesson','{}',true,2),('wolfhouse-somo','service','private_lesson','Private lesson','{}',true,3),('wolfhouse-somo','rental','board','Board','{}',true,4);
   INSERT INTO wh_pricing_rules(client_slug,item_type,item_code,season_code,unit,amount_cents,currency,active) VALUES
   ('wolfhouse-somo','package','malibu','all','per_person_per_week',50000,'EUR',true),
   ('wolfhouse-somo','service','group_lesson',NULL,'per_lesson',4000,'EUR',true),('wolfhouse-somo','service','private_lesson',NULL,'per_lesson',7000,'EUR',true),('wolfhouse-somo','rental','board',NULL,'per_day',1200,'EUR',true),
   ('wolfhouse-somo','deposit','standard_package',NULL,'per_person',20000,'EUR',true),('wolfhouse-somo','deposit','custom_or_short_stay',NULL,'per_person',20000,'EUR',true);
   CREATE TABLE guest_message_sends(id uuid primary key default gen_random_uuid(),client_slug text,to_phone text,status text,created_at timestamptz default now());
   CREATE TABLE client_notification_events(id uuid primary key default gen_random_uuid(),client_slug text,conversation_id uuid references conversations,status text,created_at timestamptz default now());`);
  const marker=(await c.query("SELECT obj_description('luna_v3_hold_beds_reject_overlap()'::regprocedure,'pg_proc') marker")).rows[0].marker;
  return {lineage,skipped:['116_luna_v3_session_phone_and_hold_invariant.sql','118_luna_v3_private_optional_hold_eligibility.sql'],consolidated_114_marker:marker};
 }finally{await c.end();}
}
async function main(){
 const cfg=config();
 fs.mkdirSync(path.dirname(cfg.out),{recursive:true});fs.mkdirSync(cfg.out); // EEXIST is intentional.
 const save=(name,value)=>fs.writeFileSync(path.join(cfg.out,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
 // Staff must not repopulate the isolated environment from operational .env files.
 // Preload before Staff (and before its first pg import), without changing main-module semantics.
 save('staff-test-preload.cjs',"'use strict';const dotenv=require('dotenv');const disabled=()=>({parsed:{}});dotenv.config=disabled;dotenv.configDotenv=disabled;\n");
 const lineage=await build(cfg);save('migration-lineage.json',lineage);
 const token=crypto.randomBytes(32).toString('hex');
 // Do not inherit model keys, operational URLs, providers or notification flags.
 const env=Object.fromEntries(['PATH','HOME','NODE_PATH','TMPDIR','LANG'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
 Object.assign(env,{NODE_ENV:'test',STAFF_RUNTIME_PROFILE:'test',STAFF_AUTH_REQUIRED:'true',STAFF_AUTH_HTTPS:'false',STAFF_QUERY_API_HOST:'127.0.0.1',STAFF_QUERY_API_PORT:String(cfg.port),LUNA_BOT_INTERNAL_TOKEN:token,LUNA_BOT_CLIENT_SLUG:'wolfhouse-somo',DEFAULT_CLIENT_SLUG:'wolfhouse-somo',WOLFHOUSE_DATABASE_URL:cfg.database,DATABASE_URL:cfg.database,LUNA_V3_TEST_WRITES:'true',META_WEBHOOK_SKIP_VERIFY:'true'});
 const child=spawn(process.execPath,['--require',path.join(cfg.out,'staff-test-preload.cjs'),'scripts/staff-query-api.js'],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});
 let log='',startupError=null;const closed=new Promise(resolve=>child.once('close',resolve));
 child.on('error',e=>{startupError=e;});child.stdout.on('data',d=>{log+=d;});child.stderr.on('data',d=>{log+=d;});
 const exchanges=[];
 async function request(route,body,headers={}) {
  const raw=JSON.stringify(body);
  const r=await fetch(`http://127.0.0.1:${cfg.port}${route}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json','x-luna-bot-token':token,...headers},body:raw});
  const text=await r.text();
  const captured={route,method:'POST',request_body:raw,request_sha256:sha256(raw),status:r.status,body:text,body_sha256:sha256(text),headers};
  exchanges.push(captured);return captured;
 }
 async function execute(row,session,phone,corrected=false) {
  const prompt=corrected?row.correction_prompt:row.prompt,control=corrected?row.corrected_control:row.control;
  const admission=await request(ADMIT,{session_id:session,guest_phone:phone,message_digest:sha256(prompt),external_send_allowed:false,staff_alert_allowed:false});
  const admitted=JSON.parse(admission.body);
  if(admission.status!==200 || admitted.admitted!==true)throw new Error('Staff admission failed: '+admission.body);
  const prepare=await request(PREPARE,{...publicPrepare(control),session_id:session,external_send_allowed:false,staff_alert_allowed:false},{'x-luna-v3-turn-id':'owner-'+crypto.randomBytes(16).toString('hex'),'x-luna-v3-inbound-event':admitted.inbound_event_id});
  return {admission,prepare};
 }
 try {
  const deadline=Date.now()+30000;
  while(!log.includes('running on')) {
   if(startupError)throw startupError;if(child.exitCode!==null || child.signalCode!==null)throw new Error('Staff exited before readiness: '+log);
   if(Date.now()>deadline)throw new Error('Staff readiness timeout: '+log);
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  // A real auth-negative health probe protects against accidentally using a
  // different process already listening on the selected port.
  const unauth=await fetch(`http://127.0.0.1:${cfg.port}${ADMIT}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json'},body:'{}'});
  if(![401,403].includes(unauth.status))throw new Error('Staff authentication fence not enforced');
  const cases=[];let snapshot=null,rawSnapshot=null;
  for(const [i,row] of recipes().entries()) {
   const session=require('./lib/model-led-luna/staff-owner-run-plan').newSession(),phone='+346999'+String(10000+i);
   const evidence=await execute(row,session,phone),correction=row.corrected_control?await execute(row,session,phone,true):null;
   const record={schema:SCHEMA,source:'test-staff-http',executed_at:new Date().toISOString(),binding:{case_id:row.id,prompt:row.prompt,category:row.category,fault:row.fault||null,correction_prompt:row.correction_prompt||null},evidence,correction};
   const derived=deriveRecord(record),current=derived.execution.snapshot;
   if(rawSnapshot && canonical(rawSnapshot)!==canonical(current))throw new Error('Staff snapshot changed during fixture run');
   rawSnapshot=current;snapshot={...current,choices:choicesForMatrix(current.choices)};
   if(row.category==='continuation' && derived.execution.response.code!=='invalid_quantity')throw new Error('Expected genuine invalid_quantity refusal, got '+derived.execution.response.code);
   if(!['continuation','clarification'].includes(row.category) && derived.execution.outcome.expect!=='quote')throw new Error('Required positive owner baseline refused: '+row.id);
   // The ONLY production signer lives inside this live request loop. There is
   // no callable arbitrary-outcome/capture-file issuance route or exported signer.
   const receipt={...record,signature:crypto.createHmac('sha256',cfg.key).update(canonical(record)).digest('hex')};
   const c={...row,intended_owner_outcome:derived.outcome,owner_execution_receipt:receipt,
    ...(derived.corrected?{corrected_owner_outcome:derived.corrected.outcome}:{}),
    owner_evidence_provenance:{source:'authenticated-localhost-staff-http',baseline_outcome:derived.execution.outcome,baseline_response_sha256:evidence.prepare.body_sha256,
     ...(row.category==='fault'?{injected_uncertainty:{fault:row.fault,source:'matrix-fault-injection-over-real-owner-baseline',observed_owner_failure:false}}:{})}};
   c.owner_canary={receipt_id:sha256(canonical(receipt)),executed_at:record.executed_at,capability_revision:snapshot.revision,prompt_sha256:sha256(row.prompt),correction_prompt_sha256:sha256(row.correction_prompt||''),control_sha256:sha256(canonical(row.control)),outcome_sha256:sha256(canonical(c.intended_owner_outcome)),corrected_control_sha256:sha256(canonical(row.corrected_control||null)),corrected_outcome_sha256:sha256(canonical(c.corrected_owner_outcome||null))};
   const checked=verify({receipt,revision:snapshot.revision,choices:snapshot.choices,input:publicPrepare(row.control),control:row.control,outcome:c.intended_owner_outcome,corrected_control:row.corrected_control,corrected_outcome:c.corrected_owner_outcome,...record.binding},cfg.key);
   if(!checked.ok)throw new Error('self-verification failed '+row.id+': '+checked.code);
   cases.push(c);
  }
  const fixture={schema:'luna-matrix-fixture/v2',tenant:'wolfhouse-somo',capability_revision:snapshot.revision,
   owner_provenance:{authority:'staff-owner',fixture_id:cfg.db,approved_by:'CAP-PR1426-GRADER-BUILD-20261026T0750',approved_at:new Date().toISOString(),owner_revision_or_receipt_id:SCHEMA,scope:'isolated TEST fixture; not operational approval'},
   unsupported_declaration:{standalone:true,policy:'Standalone rentals and lessons without accommodation are not supported by this stay-only fixture.'},cases};
  save('capability-snapshot.raw.json',rawSnapshot);save('capability-snapshot.json',snapshot);save('matrix-fixture.json',fixture);
  const summary={schema:'luna-v3-real-owner/v2',database:cfg.db,localhost:`127.0.0.1:${cfg.port}`,plain_process:true,real_staff_http:true,external_hosts:false,model_keys:false,receipt_schema:SCHEMA,capability_revision:snapshot.revision,
   results:cases.map(c=>({id:c.id,category:c.category,expect:c.intended_owner_outcome.expect,status:c.owner_execution_receipt.evidence.prepare.status,body_sha256:c.owner_execution_receipt.evidence.prepare.body_sha256,session_id:JSON.parse(c.owner_execution_receipt.evidence.prepare.request_body).session_id,correction:!!c.corrected_control}))};
  save('owner-receipt.json',summary);console.log(JSON.stringify(summary,null,2));
 }finally {
  if(child.exitCode===null && child.signalCode===null)child.kill('SIGTERM');
  const killTimer=setTimeout(()=>child.kill('SIGKILL'),5000);killTimer.unref();await closed;clearTimeout(killTimer);
  save('http-exchanges.json',exchanges);save('staff-process.log',log.replaceAll(token,'[REDACTED]'));
 }
}
if(require.main===module)main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
