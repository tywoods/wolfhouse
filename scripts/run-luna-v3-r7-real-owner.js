#!/usr/bin/env node
'use strict';
/** R7 disposable current-lineage DB + plain-process localhost Staff HTTP owner evidence. */
const fs=require('fs'), path=require('path'), crypto=require('crypto'), {spawn}=require('child_process');
const {Client}=require('pg');
const ROOT=path.resolve(__dirname,'..');
const ADMIN='postgresql://hermes@127.0.0.1:55427/postgres';
const DB='luna_v3_r7_disposable_test';
const URL=`postgresql://hermes@127.0.0.1:55427/${DB}`;
const OUT=path.join(ROOT,'artifacts','SKIP-V3-PR1426-ROOTFIX-R7-20261026T053500Z');
const PORT=43077, TOKEN='r7-local-owner-token-000000000000000000000000';
const migration=n=>fs.readFileSync(path.join(ROOT,'database/migrations',n),'utf8');
async function client(url=URL){const c=new Client({connectionString:url});await c.connect();return c;}
async function build(){
 const a=await client(ADMIN);await a.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);await a.query(`CREATE DATABASE ${DB}`);await a.end();
 const c=await client();
 const source=fs.readFileSync(path.join(ROOT,'scripts/lib/model-led-luna/test-v3-postgres.js'),'utf8');
 const match=source.match(/const base = `([\s\S]*?)`;\nfunction ctx/); if(!match) throw new Error('repository base schema not found');
 await c.query(match[1]);
 const lineage=['091_booking_occupancy_serialization.sql','114_luna_v3_staff_operations.sql','115_luna_v3_guest_operations.sql','117_cancel_unpaid_payment_race_guard.sql','119_luna_v3_guest_payment_history.sql','120_luna_v3_constraint_ownership_and_transfer_decline.sql','121_wolfhouse_confirmed_rental_prices.sql','122_luna_v3_group_payment_targets.sql','123_luna_v3_one_try_offers.sql','124_luna_v3_fix2_evidence_and_cancel_guard.sql','125_luna_v3_prepare_attempts.sql','126_luna_v3_runtime_event_capabilities.sql','127_luna_v3_prepare_execution_leases.sql','128_luna_v3_prepare_owner_release.sql','129_luna_v3_prepare_control_plane.sql'];
 for(const name of lineage) await c.query(migration(name));
 await c.query(`CREATE TABLE conversations(id uuid primary key default gen_random_uuid(),client_id uuid references clients,display_name text,phone text,language text,needs_human boolean,status text,bot_mode text,metadata jsonb default '{}');
 INSERT INTO clients(id,slug) VALUES('10000000-0000-0000-0000-000000000001','wolfhouse-somo');
 INSERT INTO rooms(id,client_id,name,room_code,room_type,selling_mode,capacity) VALUES('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','R7 Room','R7','shared','shared',8);
 INSERT INTO beds(id,client_id,room_id,bed_code,bed_number,active,sellable) SELECT gen_random_uuid(),'10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','R7-B'||g,g,true,true FROM generate_series(1,8) g;
 INSERT INTO wh_pricing_seasons(client_slug,code,label,priority,bookable,active,sort_order) VALUES('wolfhouse-somo','all','All',1,true,true,1);
 INSERT INTO wh_pricing_season_ranges(season_id,start_month,start_day,end_month,end_day,sort_order) SELECT id,1,1,12,31,1 FROM wh_pricing_seasons;
 INSERT INTO wh_pricing_items(client_slug,item_type,item_code,label,metadata,active,sort_order) VALUES
 ('wolfhouse-somo','package','malibu','Malibu','{"includes":["stay"],"min_days":1}',true,1),
 ('wolfhouse-somo','service','group_lesson','Group lesson','{}',true,2),('wolfhouse-somo','service','private_lesson','Private lesson','{}',true,3),('wolfhouse-somo','rental','board','Board','{}',true,4);
 INSERT INTO wh_pricing_rules(client_slug,item_type,item_code,season_code,unit,amount_cents,currency,active) VALUES
 ('wolfhouse-somo','package','malibu','all','per_person_per_week',50000,'EUR',true),
 ('wolfhouse-somo','service','group_lesson',NULL,'per_lesson',4000,'EUR',true),('wolfhouse-somo','service','private_lesson',NULL,'per_lesson',7000,'EUR',true),('wolfhouse-somo','rental','board',NULL,'per_day',1200,'EUR',true),
 ('wolfhouse-somo','deposit','standard_package',NULL,'per_person',20000,'EUR',true),('wolfhouse-somo','deposit','custom_or_short_stay',NULL,'per_person',20000,'EUR',true);`);
 await c.query(`CREATE TABLE guest_message_sends(id uuid primary key default gen_random_uuid(),client_slug text,to_phone text,status text,created_at timestamptz default now()); CREATE TABLE client_notification_events(id uuid primary key default gen_random_uuid(),client_slug text,conversation_id uuid references conversations,status text,created_at timestamptz default now());`);
 const marker=(await c.query("SELECT obj_description('luna_v3_hold_beds_reject_overlap()'::regprocedure,'pg_proc') marker")).rows[0].marker;
 await c.end(); return {lineage,skipped:['116_luna_v3_session_phone_and_hold_invariant.sql','118_luna_v3_private_optional_hold_eligibility.sql'],consolidated_114_marker:marker};
}
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
async function request(route,body,headers={}){const raw=JSON.stringify(body);const r=await fetch(`http://127.0.0.1:${PORT}${route}`,{method:'POST',headers:{'content-type':'application/json','x-luna-bot-token':TOKEN,...headers},body:raw});const text=await r.text();return {request:body,request_sha256:digest(raw),status:r.status,body:text,body_sha256:digest(text),json:JSON.parse(text)};}
async function main(){fs.mkdirSync(OUT,{recursive:true});const lineage=await build();
 const env={...process.env,NODE_ENV:'test',STAFF_RUNTIME_PROFILE:'test',STAFF_AUTH_REQUIRED:'true',STAFF_AUTH_HTTPS:'false',STAFF_QUERY_API_HOST:'127.0.0.1',STAFF_QUERY_API_PORT:String(PORT),LUNA_BOT_INTERNAL_TOKEN:TOKEN,LUNA_BOT_CLIENT_SLUG:'wolfhouse-somo',DEFAULT_CLIENT_SLUG:'wolfhouse-somo',WOLFHOUSE_DATABASE_URL:URL,DATABASE_URL:URL,LUNA_V3_TEST_WRITES:'true',META_WEBHOOK_SKIP_VERIFY:'true'};
 const child=spawn(process.execPath,['scripts/staff-query-api.js'],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
 try{
  for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));if(log.includes('running on'))break;if(child.exitCode!==null)throw new Error(`Staff exited ${child.exitCode}: ${log}`);} if(!log.includes('running on'))throw new Error('Staff startup timeout: '+log);
  const evidence=[];const sessions=[];
  const kinds={accommodation:{package:{code:'package_none'},add_ons:[]},package:{package:{code:'malibu'},add_ons:[]},rental:{package:{code:'malibu'},add_ons:[{code:'board',quantity:1,people:['Alex'],dates:['2027-06-02']}]},lesson_a:{package:{code:'malibu'},add_ons:[{code:'group_lesson',quantity:1,people:['Alex'],dates:['2027-06-03']}]},lesson_b:{package:{code:'malibu'},add_ons:[{code:'private_lesson',quantity:1,people:['Alex'],dates:['2027-06-04']}]},mixed:{package:{code:'malibu'},add_ons:[{code:'board',quantity:1,people:['Alex'],dates:['2027-06-02']},{code:'group_lesson',quantity:1,people:['Alex'],dates:['2027-06-03']}]},multi_guest:{package:{per_guest:[{guest:1,code:'malibu'},{guest:2,code:'package_none'}]},add_ons:[{code:'board',quantity:1,people:['Alex'],dates:['2027-06-02']},{code:'private_lesson',quantity:1,people:['Sam'],dates:['2027-06-04']}]}};
  let n=0;for(const [kind,spec] of Object.entries(kinds)){n++;const session=`luna-v3:${String(n).padStart(24,'0')}`,guest_phone=`+346999${String(10000+n)}`,message_digest=digest(`r7-${kind}`);
   const admitted=await request('/staff/bot/luna-v3/admit-simulator-session',{session_id:session,guest_phone,message_digest,external_send_allowed:false,staff_alert_allowed:false});evidence.push({kind,phase:'admit',...admitted});if(admitted.status!==200)throw new Error(`admit ${kind}: ${admitted.body}`);
   const guests=kind==='multi_guest'?[{name:'Alex'},{name:'Sam'}]:[{name:'Alex'}];const body={action:'prepare',purpose:'quote',check_in:'2027-06-01',check_out:'2027-06-08',guests,room:{kind:'shared'},...spec,session_id:session,external_send_allowed:false,staff_alert_allowed:false};
   const prepared=await request('/staff/bot/luna-v3/check-quote-book',body,{'x-luna-v3-turn-id':`r7-turn-${kind}`,'x-luna-v3-inbound-event':admitted.json.inbound_event_id});evidence.push({kind,phase:'prepare',...prepared});sessions.push({kind,session,inbound_event_id:admitted.json.inbound_event_id,status:prepared.status,ok:prepared.json.ok,code:prepared.json.code||null});
  }
  // Genuine refusal and corrected successor, each on a fresh authenticated owner event.
  for(const [label,packageCode] of [['refusal','not-in-staff-catalog'],['correction','malibu']]){const i=++n,session=`luna-v3:${String(i).padStart(24,'0')}`;const admitted=await request('/staff/bot/luna-v3/admit-simulator-session',{session_id:session,guest_phone:`+346999${String(10000+i)}`,message_digest:digest(`r7-${label}`),external_send_allowed:false,staff_alert_allowed:false});evidence.push({kind:label,phase:'admit',...admitted});const body={action:'prepare',purpose:'quote',check_in:'2027-06-01',check_out:'2027-06-08',guests:[{name:'Alex'}],room:{kind:'shared'},package:{code:packageCode},add_ons:[],session_id:session,external_send_allowed:false,staff_alert_allowed:false};evidence.push({kind:label,phase:'prepare',...await request('/staff/bot/luna-v3/check-quote-book',body,{'x-luna-v3-turn-id':`r7-turn-${label}`,'x-luna-v3-inbound-event':admitted.json.inbound_event_id})});}
  fs.writeFileSync(path.join(OUT,'http-exchanges.json'),JSON.stringify(evidence,null,2)+'\n');fs.writeFileSync(path.join(OUT,'migration-lineage.json'),JSON.stringify(lineage,null,2)+'\n');
  const summary={schema:'luna-v3-r7-real-owner/v1',localhost:`127.0.0.1:${PORT}`,plain_process:true,real_staff_http:true,external_hosts:false,model_keys:false,lineage,results:evidence.filter(x=>x.phase==='prepare').map(x=>({kind:x.kind,status:x.status,ok:x.json.ok,code:x.json.code||null,request_sha256:x.request_sha256,body_sha256:x.body_sha256}))};fs.writeFileSync(path.join(OUT,'owner-receipt.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
 }finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));fs.writeFileSync(path.join(OUT,'staff-process.log'),log);}
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
