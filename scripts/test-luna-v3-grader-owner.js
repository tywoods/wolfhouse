#!/usr/bin/env node
'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const CLI=path.join(__dirname,'lib/model-led-luna/staff-request-normalize-cli.js');
function cli(payload) {
 const p=spawnSync(process.execPath,[CLI,'--server'],{input:JSON.stringify(payload)+'\n',encoding:'utf8',env:{...process.env,LUNA_OWNER_RECEIPT_ISSUER_KEY:'test-only-not-an-owner-issuer-key-000000',LUNA_OWNER_RECEIPT_VERIFIER_KEY:'test-only-not-an-owner-issuer-key-000000'}});
 assert.equal(p.status,0,p.stderr); return JSON.parse(p.stdout);
}
test('normalization CLI cannot issue even a fabricated refusal with issuer key',()=>{
 const result=cli({command:'generate',outcome:{expect:'refusal'},input:{},choices:[]});
 assert.equal(result.ok,false); assert.equal(result.signature,undefined);
});
const fs=require('node:fs'), crypto=require('node:crypto');
const CAPTURE=process.env.LUNA_OWNER_CAPTURE_FILE || path.resolve(__dirname,'../../../artifacts/review-1426-5c3c575c/parent-real-owner/http-exchanges.json');
const captured=fs.existsSync(CAPTURE)?JSON.parse(fs.readFileSync(CAPTURE,'utf8')):null;
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v && typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const sign=record=>({...record,signature:crypto.createHmac('sha256','test-only-not-an-owner-issuer-key-000000').update(canonical(record)).digest('hex')});
// Historical raw Staff HTTP bytes, not a new live run. The envelope/signature here
// is a unit-test issuer fixture; never export it as live owner evidence.
function historical(kind) {
 const a=captured.find(x=>x.kind===kind && x.phase==='admit'), p=captured.find(x=>x.kind===kind && x.phase==='prepare');
 const wrap=(x,route,headers={})=>({route,method:'POST',request_body:JSON.stringify(x.request),request_sha256:x.request_sha256,status:x.status,body:x.body,body_sha256:x.body_sha256,headers});
 const evidence={admission:wrap(a,'/staff/bot/luna-v3/admit-simulator-session'),prepare:wrap(p,'/staff/bot/luna-v3/check-quote-book',{'x-luna-v3-turn-id':'unit-history-'+kind,'x-luna-v3-inbound-event':a.json.inbound_event_id})};
 const record={schema:'staff-owner-http/v5',source:'test-staff-http',executed_at:'2026-10-26T00:00:00.000Z',binding:{case_id:'history-'+kind,prompt:'Historical request '+kind,category:kind==='mixed'?'mixed':'package',fault:null,correction_prompt:null},evidence,correction:null};
 const input={...p.request};for(const k of ['session_id','external_send_allowed','staff_alert_allowed'])delete input[k];
 const control={...input};delete control.action;delete control.purpose;if(control.package.code)control.package=control.package.code;
 const r=p.json, details=Array.isArray(r.package_details)?r.package_details:[r.package_details];
 const outcome=r.ok?{expect:kind==='mixed'?'mixed':'quote',...(kind==='mixed'?{compatibility_proven:true}:{}),facts:{currency:r.quote.currency,total_cents:r.quote.totalCents,deposit_cents:r.quote.depositCents,remaining_cents:r.quote.remainingCents,check_in:r.check_in,check_out:r.check_out,package:r.guests.length===1?{code:r.guests[0].package}:{per_guest:r.guests.map(g=>({guest:g.position,guest_name:g.name,code:g.package}))},add_ons:r.add_ons,inclusions:details.flatMap(d=>d.includes||[]),terms:details.flatMap(d=>d.terms||[])}}:{expect:'refusal',classification:r.classification,allowed_reasons:[r.code],next_step:r.next_step};
 return {command:'verify',receipt:sign(record),revision:a.json.capability_snapshot.revision,choices:a.json.capability_snapshot.choices,input,control,outcome,...record.binding,turn_id:'fixture-admission'};
}
test('captured real Staff HTTP quote admits without trusting asserted money', {skip:!captured},()=>{
 const p=historical('package');const result=cli(p);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.owner_response.quote.totalCents,50000);
 p.outcome.facts.total_cents++;assert.equal(cli(p).ok,false);
});
test('normalized add-on ordering is equivalent, allocation swapping is not', {skip:!captured},()=>{
 const p=historical('multi_guest');const normalized=x=>{const r=cli({command:'normalize',choices:p.choices,input:x});delete r.value.operation_key;return r;};
 const reordered=structuredClone(p.input);reordered.add_ons.reverse();
 assert.deepEqual(normalized(reordered),normalized(p.input));
 reordered.add_ons[0].people=['Alex'];assert.notDeepEqual(normalized(reordered),normalized(p.input));
});
for(const kind of ['accommodation','package','rental','lesson_a','lesson_b','mixed','multi_guest'])test('historical '+kind+' HTTP positive plus money, terms, inclusions, request and catalog negatives',{skip:!captured},()=>{
 const p=historical(kind);assert.equal(cli(p).ok,true);
 for(const mutate of [p=>p.outcome.facts.total_cents++,p=>p.outcome.facts.deposit_cents++,p=>p.outcome.facts.remaining_cents++,p=>p.outcome.facts.currency='USD',p=>p.outcome.facts.terms.push('free cancellation'),p=>p.outcome.facts.inclusions.push('breakfast'),p=>p.input.check_out='2027-06-09',p=>p.choices[0].label='Forged catalog',p=>p.revision='other',p=>p.outcome={expect:'refusal',classification:'availability',allowed_reasons:['full']}]) {
  const changed=structuredClone(p);mutate(changed);assert.equal(cli(changed).ok,false);
 }
});
test('real-owner runner has isolated non-destructive configuration and all coverage recipes',()=>{
 const filename=path.join(__dirname,'lib/model-led-luna/staff-owner-run-plan.js');
 assert.ok(fs.existsSync(filename),'real-owner runner needs isolated run plan');
 const {config,recipes}=require(filename);
 assert.throws(()=>config({}),/TEST/);
 const env={NODE_ENV:'test',LUNA_OWNER_TEST_RUN:'true',LUNA_OWNER_ADMIN_URL:'postgresql://hermes@127.0.0.1:55427/postgres',LUNA_OWNER_DB:'luna_owner_test_unique',LUNA_OWNER_PORT:'43101',LUNA_OWNER_OUTPUT:'/tmp/owner-test-new',LUNA_OWNER_RECEIPT_ISSUER_KEY:'unit-test-private-key-at-least-32-bytes'};
 assert.equal(config(env).port,43101);assert.equal(config(env).db,'luna_owner_test_unique');
 assert.throws(()=>config({...env,LUNA_OWNER_ADMIN_URL:'postgresql://hermes@example.com/postgres'}),/loopback/);
 assert.throws(()=>config({...env,LUNA_OWNER_DB:'postgres'}),/luna_owner_test_/);
 const rows=recipes(), by=k=>rows.find(x=>x.category===k);
 assert.equal(rows.length,14);
 for(const k of ['rental','service:lesson_a','service:lesson_b'])assert.equal(by(k).control.package,'package_none');
 assert.notEqual(by('service:lesson_a').control.add_ons[0].code,by('service:lesson_b').control.add_ons[0].code);
 assert.equal(by('continuation').control.add_ons[0].quantity,0);assert.equal(by('continuation').corrected_control.add_ons[0].quantity,1);
 assert.equal(rows.filter(x=>x.category==='fault').length,5);assert.equal(by('clarification').control.room,undefined);
});
test('runner cannot drop/reuse old evidence and signing is private to live execution',()=>{
 const source=fs.readFileSync(path.join(__dirname,'run-luna-v3-r7-real-owner.js'),'utf8');
 assert.doesNotMatch(source,/DROP DATABASE/i);
 assert.match(source,/require\.main===module/);
 assert.doesNotMatch(source,/module\.exports.*(?:sign|issue|generate)/);
 assert.match(source,/flag:'wx'/);
});
test('catalog active flag cannot disagree with the captured configuration',{skip:!captured},()=>{
 const p=historical('package');p.choices[1].active=false;assert.equal(cli(p).ok,false);
});
test('historical real refusal is not minted from a normalizer error',{skip:!captured},()=>{
 const p=historical('refusal');assert.equal(cli(p).ok,true);
 p.outcome.allowed_reasons=['invalid_quantity'];assert.equal(cli(p).ok,false);
});
test('same-session correction cannot be laundered from unrelated captured sessions',{skip:!captured},()=>{
 const p=historical('refusal'), corrected=historical('correction');
 const {signature,...record}=p.receipt;record.binding.category='continuation';record.binding.correction_prompt='Please use Malibu instead.';record.correction=corrected.receipt.evidence;
 Object.assign(p,{category:'continuation',correction_prompt:record.binding.correction_prompt,corrected_control:corrected.control,corrected_outcome:corrected.outcome,receipt:sign(record)});
 assert.equal(cli(p).code,'correction_must_use_same_session_new_event');
});
test('captured guest allocations cannot be swapped, even if package multiset is unchanged',{skip:!captured},()=>{
 const p=historical('multi_guest');[p.outcome.facts.package.per_guest[0].code,p.outcome.facts.package.per_guest[1].code]=[p.outcome.facts.package.per_guest[1].code,p.outcome.facts.package.per_guest[0].code];
 assert.equal(cli(p).ok,false);
 const q=historical('multi_guest');q.input.package.per_guest.reverse();assert.equal(cli(q).ok,true);
 [q.input.package.per_guest[0].code,q.input.package.per_guest[1].code]=[q.input.package.per_guest[1].code,q.input.package.per_guest[0].code];assert.equal(cli(q).ok,false);
});
for(const fault of ['non-json','malformed','http-422','exception','timeout'])test('fault '+fault+' has real successful baseline and explicit injected uncertainty',{skip:!captured},()=>{
 const p=historical('mixed'), {signature,...record}=p.receipt;record.binding.category='fault';record.binding.fault=fault;
 Object.assign(p,{category:'fault',fault,outcome:{expect:'uncertain'},receipt:sign(record)});
 const checked=cli(p);assert.equal(checked.ok,true);assert.equal(checked.baseline_outcome.expect,'quote');assert.equal(checked.provenance.injected_uncertainty.fault,fault);
 p.outcome={expect:'refusal',classification:'http',allowed_reasons:['422']};assert.equal(cli(p).ok,false);
});
function fenceEnv() {
 return {NODE_ENV:'test',LUNA_OWNER_TEST_RUN:'true',LUNA_OWNER_ADMIN_URL:'postgresql://offline@127.0.0.1:5432/postgres',LUNA_OWNER_DB:'luna_owner_test_fence',LUNA_OWNER_PORT:'15432',LUNA_OWNER_OUTPUT:path.resolve(__dirname,'../artifacts/cap-grader-fence-v2/UNUSED'),LUNA_OWNER_RECEIPT_ISSUER_KEY:'offline-unit-test-placeholder-00000000'};
}
test('PostgreSQL fence rejects the actual driver query-host override',()=>{
 const {config}=require('./lib/model-led-luna/staff-owner-run-plan'),{Client}=require('pg');
 const env=fenceEnv();env.LUNA_OWNER_ADMIN_URL+='?host=example.invalid';
 // Parser only: no connect(), DNS, server, credentials or DB lifecycle.
 assert.equal(new Client({connectionString:env.LUNA_OWNER_ADMIN_URL}).connectionParameters.host,'example.invalid');
 assert.throws(()=>config(env),/PostgreSQL.*loopback/);
});
test('PostgreSQL fence checks actual driver defaults, not merely URL syntax',()=>{
 const {config}=require('./lib/model-led-luna/staff-owner-run-plan'),{defaults}=require('pg');
 for(const name of ['options','replication']) {
  const previous=defaults[name];
  try {defaults[name]='unsafe-test-setting';assert.throws(()=>config(fenceEnv()),/PostgreSQL.*loopback/);}
  finally {defaults[name]=previous;}
 }
});
test('PostgreSQL fence rejects supplied and ambient PG environment without exposing values',()=>{
 const {config}=require('./lib/model-led-luna/staff-owner-run-plan');
 for(const name of ['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGOPTIONS','PGSERVICE','PGSERVICEFILE','PGSYSCONFDIR','PGPASSFILE','PGSSLMODE','PGSSLKEY','PGSSLCERT','PGSSLROOTCERT','PGREPLICATION','PG_FORCE_NATIVE','NODE_PG_FORCE_NATIVE','NODE_PG_FUTURE_OPTION','PG_FUTURE_OPTION']) {
  assert.throws(()=>config({...fenceEnv(),[name]:'private-value'}),/PostgreSQL.*loopback/);
  const previous=process.env[name];
  try {process.env[name]='private-value';assert.throws(()=>config(fenceEnv()),/PostgreSQL.*loopback/);}
  finally {if(previous===undefined)delete process.env[name];else process.env[name]=previous;}
 }
});
test('PostgreSQL fence emits numeric driver hosts for both admin and fresh target',()=>{
 const {config}=require('./lib/model-led-luna/staff-owner-run-plan'),{Client}=require('pg'),net=require('node:net');
 for(const host of ['127.0.0.1','127.0.0.2','[::1]']) {
  const env=fenceEnv();env.LUNA_OWNER_ADMIN_URL=`postgresql://offline@${host}:5544/postgres`;
  const cfg=config(env);
  for(const [name,database] of [['admin','postgres'],['database',env.LUNA_OWNER_DB]]) {
   const cp=new Client({connectionString:cfg[name]}).connectionParameters;
   assert.ok(net.isIP(cp.host),'effective host must never require DNS');
   assert.equal(cp.host,host==='[::1]'?'::1':host);assert.equal(cp.port,5544);
   assert.equal(cp.database,database);assert.equal(cp.user,'offline');assert.equal(cp.isDomainSocket,false);assert.equal(cp.ssl,false);
   assert.ok(!cp.options);assert.ok(!cp.replication);
  }
 }
});
test('PostgreSQL fence rejects localhost, ambiguous numeric forms, sockets and missing identity',()=>{
 const {config}=require('./lib/model-led-luna/staff-owner-run-plan');
 for(const authority of ['localhost','localhost.','LOCALHOST','127.1','2130706433','0x7f000001','0177.0.0.1','127.0.0.1.example.invalid','0.0.0.0','[::]','[::ffff:127.0.0.1]','example.invalid','%2Ftmp','127.0.0.1,example.invalid']) {
  assert.throws(()=>config({...fenceEnv(),LUNA_OWNER_ADMIN_URL:`postgresql://offline@${authority}:5432/postgres`}),/PostgreSQL.*loopback/);
 }
 for(const value of ['postgresql://127.0.0.1/postgres','postgresql://offline@127.0.0.1/','postgresql://offline@127.0.0.1:0/postgres','postgresql://offline@127.0.0.1:65536/postgres','not a URL','socket:/tmp','postgresql://offline@127.0.0.1/postgres#fragment']) {
  assert.throws(()=>config({...fenceEnv(),LUNA_OWNER_ADMIN_URL:value}),/PostgreSQL.*loopback/);
 }
});
test('PostgreSQL fence rejects every caller URI option before driver file loading',()=>{
 const {config}=require('./lib/model-led-luna/staff-owner-run-plan');
 const queries=[
  'host=example.invalid','host=127.0.0.1&host=example.invalid','host=example.invalid&host=127.0.0.1',
  '%68ost=example.invalid','h%6fst=example.invalid','HOST=example.invalid','host=%65xample.invalid',
  'host=%2Ftmp','host=127.0.0.1%2Cexample.invalid','host=','host=127.0.0.1',
  'hostaddr=203.0.113.1','%68ostaddr=203.0.113.1','options=-c%20host%3Dexample.invalid',
  'options=-c%20search_path%3Dpublic','service=remote','servicefile=%2Foffline-fence-forbidden-file',
  'port=6432','database=existing_application','dbname=existing_application','user=other','password=private-value',
  'sslkey=%2Foffline-fence-forbidden-file','sslcert=%2Foffline-fence-forbidden-file','sslrootcert=%2Foffline-fence-forbidden-file',
  'sslmode=disable','ssl=true','uselibpqcompat=true','connectionString=remote','stream=remote','lookup=remote',
  '__proto__=remote','constructor=remote','arbitrary_future_setting=remote','application_name=harmless','',
 ];
 const read=fs.readFileSync;let forbiddenReads=0;
 fs.readFileSync=function(filename,...args){if(String(filename).includes('offline-fence-forbidden-file')){forbiddenReads++;throw new Error('FORBIDDEN FILE');}return read.call(this,filename,...args);};
 try {
  for(const query of queries)assert.throws(()=>config({...fenceEnv(),LUNA_OWNER_ADMIN_URL:fenceEnv().LUNA_OWNER_ADMIN_URL+'?'+query}),/PostgreSQL.*loopback/);
 } finally {fs.readFileSync=read;}
 assert.equal(forbiddenReads,0,'reject dangerous URI parameters before pg can read any file');
});
test('PostgreSQL fence regression uses driver duplicate and encoded parameter semantics',()=>{
 const {Client}=require('pg');
 for(const query of ['host=127.0.0.1&host=example.invalid','%68ost=example.invalid','host=%65xample.invalid']) {
  const cp=new Client({connectionString:fenceEnv().LUNA_OWNER_ADMIN_URL+'?'+query}).connectionParameters;
  assert.equal(cp.host,'example.invalid');
 }
 const cp=new Client({connectionString:fenceEnv().LUNA_OWNER_ADMIN_URL+'?database=existing_application'}).connectionParameters;
 assert.equal(cp.database,'postgres','retained negative control: pathname wins in installed pg');
});
test('PostgreSQL fence errors are generic and fresh target cannot be changed',()=>{
 const {config}=require('./lib/model-led-luna/staff-owner-run-plan');
 for(const value of ['postgresql://offline:private-value@127.0.0.1:bad/postgres','postgresql://offline:%ZZ@127.0.0.1/postgres']) {
  let failure;try {config({...fenceEnv(),LUNA_OWNER_ADMIN_URL:value});}catch(e){failure=e;}
  assert.ok(failure);assert.match(failure.message,/PostgreSQL.*loopback/);
  assert.doesNotMatch(JSON.stringify(failure)+failure.stack,/private-value|postgresql:\/\/|%ZZ/);
 }
 const cfg=config(fenceEnv());assert.ok(Object.isFrozen(cfg));assert.throws(()=>{cfg.database='invalid';},TypeError);
 for(const db of ['postgres','existing_application','luna_owner_test_','luna_owner_test_x;CREATE DATABASE x','luna_owner_test_'+ 'x'.repeat(43)]) {
  assert.throws(()=>config({...fenceEnv(),LUNA_OWNER_DB:db}),/luna_owner_test_/);
 }
});
test('runner session IDs meet the real Staff simulator admission contract',()=>{
 const plan=require('./lib/model-led-luna/staff-owner-run-plan');assert.equal(typeof plan.newSession,'function');
 const ids=Array.from({length:10},()=>plan.newSession());assert.equal(new Set(ids).size,10);
 for(const id of ids)assert.match(id,/^luna-v3:[a-f0-9]{24}$/);
});
test('captured bytes and authenticated event linkage cannot be substituted',{skip:!captured},()=>{
 for(const mutate of [r=>r.evidence.prepare.body+=' ',r=>r.evidence.prepare.request_body+=' ',r=>r.evidence.prepare.headers['x-luna-v3-inbound-event']='another-event']) {
  const p=historical('package'),{signature,...record}=p.receipt;mutate(record);p.receipt=sign(record);assert.equal(cli(p).ok,false);
 }
});
test('synthetic linkage unit control: correction requires a different event in the same session',{skip:!captured},()=>{
 // This changes historical transport metadata ONLY for a unit positive/negative
 // control, and is NOT evidence of a live corrected conversation.
 const p=historical('refusal'),corrected=historical('correction'),{signature,...record}=p.receipt;
 record.binding.category='continuation';record.binding.correction_prompt='Use Malibu instead.';record.correction=corrected.receipt.evidence;
 const session=JSON.parse(record.evidence.admission.request_body).session_id;
 for(const phase of ['admission','prepare']) {const x=record.correction[phase],request=JSON.parse(x.request_body);request.session_id=session;x.request_body=JSON.stringify(request);x.request_sha256=sha(x.request_body);}
 Object.assign(p,{category:'continuation',correction_prompt:record.binding.correction_prompt,corrected_control:corrected.control,corrected_outcome:corrected.outcome,receipt:sign(record)});
 const checked=cli(p);assert.equal(checked.ok,true,JSON.stringify(checked));assert.equal(checked.result.ok,false);assert.equal(checked.corrected_result.ok,true);
 record.correction.prepare.headers['x-luna-v3-inbound-event']=record.evidence.prepare.headers['x-luna-v3-inbound-event'];
 const a=record.correction.admission,body=JSON.parse(a.body);body.inbound_event_id=record.correction.prepare.headers['x-luna-v3-inbound-event'];a.body=JSON.stringify(body);a.body_sha256=sha(a.body);p.receipt=sign(record);
 assert.equal(cli(p).code,'correction_must_use_same_session_new_event');
});
test('live fixture replay: all seven categories, refusal/correction, clarification and all faults',{skip:!process.env.LUNA_OWNER_LIVE_FIXTURE},()=>{
 const fixture=JSON.parse(fs.readFileSync(process.env.LUNA_OWNER_LIVE_FIXTURE,'utf8'));
 const snapshot=JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.LUNA_OWNER_LIVE_FIXTURE),'capability-snapshot.json'),'utf8'));
 const {verify,publicPrepare}=require('./lib/model-led-luna/staff-owner-http-receipt');
 const key=process.env.LUNA_OWNER_RECEIPT_VERIFIER_KEY;assert.ok(key && key.length>=32);
 assert.equal(fixture.cases.length,14);
 for(const c of fixture.cases) {
  const payload={receipt:c.owner_execution_receipt,revision:snapshot.revision,choices:snapshot.choices,case_id:c.id,category:c.category,fault:c.fault||null,prompt:c.prompt,control:c.control,input:publicPrepare(c.control),outcome:c.intended_owner_outcome,correction_prompt:c.correction_prompt||null,corrected_control:c.corrected_control,corrected_outcome:c.corrected_owner_outcome};
  const result=verify(payload,key);assert.equal(result.ok,true,c.id+': '+result.code);
  if(c.category==='continuation'){assert.equal(result.result.ok,false);assert.equal(result.owner_response.code,'invalid_quantity');assert.equal(result.corrected_result.ok,true);assert.notEqual(result.provenance.event_id,result.provenance.corrected_event_id);}
  if(c.intended_owner_outcome.facts) {
   for(const field of ['total_cents','deposit_cents','remaining_cents']) {const bad=structuredClone(payload);bad.outcome.facts[field]++;assert.equal(verify(bad,key).ok,false,c.category+': '+field);}
   for(const field of ['terms','inclusions']) {const bad=structuredClone(payload);bad.outcome.facts[field].push('invented');assert.equal(verify(bad,key).ok,false,c.category+': '+field);}
   const bad=structuredClone(payload);bad.input.guests[0].name='Another person';assert.equal(verify(bad,key).ok,false,c.category+': guest');
  }
 }
});
test('legacy HMAC assertions are never owner receipts',()=>{
 assert.equal(cli({command:'verify',receipt:{schema:'staff-owner-execution/v4',signature:'0'.repeat(64)}}).ok,false);
});
