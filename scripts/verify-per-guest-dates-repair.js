'use strict';
// Actual migration-backed service/handlers; deterministic schedules, NOT concurrent PostgreSQL proof.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const file = path.join(__dirname, 'verify-per-guest-dates.js');
const fixture = new Module(file, module);
fixture.filename = file; fixture.paths = module.paths;
fixture._compile(fs.readFileSync(file, 'utf8').split('(async()=>{')[0] + '\nmodule.exports={PGlite,setup,seed,state,booking,guest,assignment,conflict,input,config,perPerson,id,C,B,G,S,A,A2,BED, networkAttempts:()=>networkAttempts};', file);
const f = fixture.exports;
const { editGuestDates } = require('./lib/booking-guest-dates');
const { bookingLedgerInvoicePaidBalance } = require('./lib/booking-invoice-totals');
const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
function fn(name) { const at = new RegExp('(?:async )?function '+name+'\\(').exec(source).index; return source.slice(at, source.indexOf('\n}',at)+2); }
const cases = {};
cases.invoice = async db => {
  const rows = structuredClone(f.perPerson);
  rows.forEach(p => { p.supplement_cents=5000; p.subtotal_cents+=5000; });
  await db.query("UPDATE bookings SET metadata=$2,room_preference='couple_private',total_amount_cents=total_amount_cents+10000,balance_due_cents=balance_due_cents+10000 WHERE id=$1",[f.B,JSON.stringify({per_person:rows})]);
  await db.query("UPDATE booking_guests SET metadata=jsonb_set(metadata,'{subtotal_cents}',to_jsonb((metadata->>'subtotal_cents')::int+5000))");
  const before = await f.state(db);
  const invoice = bookingLedgerInvoicePaidBalance(await f.booking(db),3579,15000,0,0);
  const result = await editGuestDates(db,f.input({check_out:'2026-07-04'}),{quoteConfig:f.config});
  assert.equal(result.status,409,JSON.stringify(result));
  assert.equal(result.body.error,'invoice_allocation_unavailable');
  assert.deepEqual(await f.state(db),before);
  assert.deepEqual(bookingLedgerInvoicePaidBalance(await f.booking(db),3579,15000,0,0),invoice);
  assert.equal(invoice.invoice_total_cents,89479);
};
// Residual invoice invariant: successful edits must change the REAL collectible
// invoice by exactly the guest delta; unusable/ambiguous allocations fail atomically.
cases.invoiceResidual = async db => {
 const variants = ['absent','empty','service-only','zero-accommodation','invalid-accommodation','missing-amount','negative-amount','null-line','insufficient','missing-supplement','embedded-equal','embedded-excess','complete','split-complete'];
 for (const supplement of [0,1,5000,17001]) for (const history of variants) {
  await f.seed(db);
  const pp=structuredClone(f.perPerson);pp.forEach(p=>{p.supplement_cents=supplement;p.subtotal_cents+=supplement;});
  const total=79479+2*supplement;
  let lines=[{code:'accommodation_only',total_cents:75900},{code:'room_supplement',total_cents:2*supplement},{code:'meal',total_cents:3579}];
  if(history==='empty') lines=[];
  if(history==='service-only') lines=[{code:'meal',total_cents:3579}];
  if(history==='zero-accommodation') lines=[{code:'accommodation_only',total_cents:0},{code:'meal',total_cents:3579}];
  if(history==='invalid-accommodation') lines[0].total_cents='invalid';
  if(history==='missing-amount') delete lines[0].total_cents;
  if(history==='negative-amount') lines[0].total_cents=-1;
  if(history==='null-line') lines.push(null);
  if(history==='insufficient') lines[0].total_cents-=1000;
  if(history==='missing-supplement') lines=lines.filter(l=>l.code!=='room_supplement');
  if(history==='embedded-equal' || history==='embedded-excess') lines=[{code:'package',total_cents:total+(history==='embedded-excess'?1000:0)}];
  if(history==='split-complete') lines=[{code:'guest_package',total_cents:21000},{code:'guest_accommodation_only',total_cents:54900},...lines.slice(1)];
  const md={per_person:pp};if(history!=='absent')md.quote_snapshot={per_person:pp,line_items:lines};
  await db.query("UPDATE bookings SET metadata=$2,room_preference='couple_private',total_amount_cents=$3,balance_due_cents=$3-15000 WHERE id=$1",[f.B,JSON.stringify(md),total]);
  await db.query("UPDATE booking_guests SET metadata=jsonb_set(metadata,'{subtotal_cents}',to_jsonb((metadata->>'subtotal_cents')::int+$1::int))",[supplement]);
  const before=await f.state(db), b=await f.booking(db), sibling=await f.guest(db,f.S);
  const result=await editGuestDates(db,f.input({check_in:'2026-07-02',check_out:'2026-07-04'}),{quoteConfig:f.config});
  const usable=['complete','split-complete'].includes(history) || (history==='missing-supplement' && supplement===0);
  if(!usable) {
   assert.equal(result.status,409,history+': '+JSON.stringify(result));assert.equal(result.body.error,'invoice_allocation_unavailable',history);
   assert.deepEqual(await f.state(db),before,history+' rejection atomic');
  } else {
   assert.equal(result.body.updated,true,history+': '+JSON.stringify(result));
   const after=await f.booking(db);assert.equal(after.total_amount_cents,b.total_amount_cents+result.body.invoice_impact.delta_cents);
   assert.deepEqual(after.metadata.quote_snapshot.per_person.map(p=>p.supplement_cents),[supplement,supplement]);
   assert.deepEqual(await f.guest(db,f.S),sibling);assert.equal(after.deposit_required_cents,30000);
   for(const [svc,paid,transfers,additional] of [[3579,15000,0,0],[5579,200000,1700,2000]]) {
    const oldInvoice=bookingLedgerInvoicePaidBalance(b,svc,paid,transfers,additional);
    const newInvoice=bookingLedgerInvoicePaidBalance(after,svc,paid,transfers,additional);
    assert.equal(newInvoice.invoice_total_cents,oldInvoice.invoice_total_cents+result.body.invoice_impact.delta_cents,history+' real consumer delta');
   }
   const afterState=await f.state(db);assert.deepEqual(afterState.payments,before.payments);assert.deepEqual(afterState.booking_service_records,before.booking_service_records);
  }
  console.log('PASS invoice residual',supplement,history,usable?'updated':'atomic rejection');
 }
};
// Complete equality is normal calculator output, not evidence of missing history.
// Keep embedded-equal residual cases above: their guest shares do NOT reconcile.
cases.completeAllocation = async db => {
 const {calculateWolfhouseQuote}=require('./lib/wolfhouse-quote-calculator');
 const acc=q=>q.line_items.filter(l=>['package','package_proration','accommodation_only'].includes(l.code)).reduce((s,l)=>s+l.total_cents,0);
 const quote=(pkg,end,count)=>calculateWolfhouseQuote({client_slug:'wolfhouse-somo',check_in:'2026-07-01',check_out:end,guest_count:count,package_code:pkg,room_type:'shared',payment_choice:'deposit',add_ons:[]},f.config);
 for(const pkg of ['no_package','uluwatu']) for(const [oldEnd,end] of [['2026-07-08','2026-07-09'],['2026-07-08','2026-07-11'],['2026-07-09','2026-07-08']]) {
  for(const history of ['complete','missing-share','invalid-share','unreconciled-share','selected-basis-mismatch','service-row','service-code-only']) {
   await f.seed(db);
   const q=quote(pkg,oldEnd,2),next=quote(pkg,end,1);assert.equal(q.success,true);assert.equal(next.success,true);
   assert.equal(acc(q),q.total_cents);
   const pp=[1,2].map(n=>({guest_number:n,guest_name:n===1?'Selected':'Sibling',package_code:pkg,accommodation_cents:acc(q)/2,addons_cents:0,supplement_cents:0,subtotal_cents:acc(q)/2,deposit_cents:n===1?10000:20000}));
   if(history==='missing-share')delete pp[1].accommodation_cents;
   if(history==='invalid-share')pp[1].accommodation_cents='invalid';
   if(history==='unreconciled-share'){pp[1].accommodation_cents--;pp[1].subtotal_cents--;}
   const md={per_person:pp,guest_packages:pp.map(p=>({guest_number:p.guest_number,package_code:pkg})).reverse(),quote_snapshot:{...q,per_person:pp}};
   const hasService=history.startsWith('service-');
   if(!hasService)await db.query('DELETE FROM booking_service_records WHERE booking_id=$1',[f.B]);
   if(history==='service-code-only')await db.query('UPDATE booking_service_records SET booking_id=NULL WHERE booking_id=$1',[f.B]);
   await db.query('UPDATE bookings SET check_out=$2,package_code=$3,total_amount_cents=$4,balance_due_cents=$4-amount_paid_cents,metadata=$5 WHERE id=$1',[f.B,oldEnd,pkg,q.total_cents,JSON.stringify(md)]);
   for(const [id,p] of [[f.G,pp[0]],[f.S,pp[1]]])await db.query('UPDATE booking_guests SET metadata=$2 WHERE id=$1',[id,JSON.stringify(history==='selected-basis-mismatch'&&id===f.G?{...p,accommodation_cents:p.accommodation_cents-1}:p)]);
   await db.query('UPDATE booking_beds SET assignment_end_date=$2 WHERE booking_id=$1',[f.B,oldEnd]);
   const before=await f.state(db),b=await f.booking(db),sibling=await f.guest(db,f.S),siblingBed=await f.assignment(db,f.A2),selected=await f.guest(db);
   const svc=hasService?3579:0,bi=bookingLedgerInvoicePaidBalance(b,svc,15000,0,0);
   const request=f.input({check_out:end,expected_check_out:oldEnd});
   const r=await editGuestDates(db,request,{quoteConfig:f.config});
   if(history!=='complete'){
    assert.equal(r.status,409,history+JSON.stringify(r));assert.equal(r.body.error,'invoice_allocation_unavailable');assert.deepEqual(await f.state(db),before);
    assert.deepEqual(bookingLedgerInvoicePaidBalance(await f.booking(db),svc,15000,0,0),bi);
   } else {
    assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.updated,true);
    const after=await f.booking(db),g=await f.guest(db),delta=acc(next)-acc(q)/2;
    assert.equal(r.body.invoice_impact.delta_cents,delta);assert.equal(after.total_amount_cents,b.total_amount_cents+delta);
    assert.equal(bookingLedgerInvoicePaidBalance(after,0,15000,0,0).invoice_total_cents,bi.invoice_total_cents+delta);
    assert.equal(g.metadata.accommodation_cents,acc(next));assert.equal(g.metadata.subtotal_cents,acc(next));
    assert.equal((await f.assignment(db)).check_out,end);assert.deepEqual(await f.assignment(db,f.A2),siblingBed);
    assert.deepEqual(await f.guest(db,f.S),sibling);assert.deepEqual(after.metadata.quote_snapshot.per_person[1],pp[1]);
    assert.equal(after.deposit_required_cents,b.deposit_required_cents);assert.equal(after.amount_paid_cents,b.amount_paid_cents);
    assert.equal(g.deposit_amount_cents,selected.deposit_amount_cents);assert.equal(g.amount_paid_cents,selected.amount_paid_cents);
    const committed=await f.state(db);assert.deepEqual(committed.payments,before.payments);assert.deepEqual(committed.booking_service_records,before.booking_service_records);
    const replay=await editGuestDates(db,request,{quoteConfig:f.config});assert.equal(replay.status,200);assert.equal(replay.body.updated,false);assert.deepEqual(await f.state(db),committed);
   }
   console.log('PASS complete allocation',pkg,oldEnd,end,history,history==='complete'?'updated':'atomic rejection');
  }
 }
};
cases.admin = async db => {
  const before = await f.state(db);
  for (const failed of ['loadRules','loadItems']) {
    const calls=[];
    const sandbox={require, console, Date, loadConfig:require('./lib/wolfhouse-quote-calculator').loadConfig,
      STAFF_ACTIONS_ENABLED:true,assertStaffClientAccess:()=>true,appendAuditLog:()=>{},
      sendJSON:(res,status,body)=>Object.assign(res,{status,body}),
      withPgClient:cb=>cb(db),
      wolfhousePricingStore:Object.fromEntries(['loadRules','loadItems'].map(name=>[name,async(_pg,_slug,options)=>{
        calls.push({name,options}); if(name===failed) throw Error('injected Admin read failure'); return [];
      }])), applyOverlayRentalPricesToConfig:c=>c,applyOverlayPackageItemsToConfig:c=>c};
    vm.createContext(sandbox);
    vm.runInContext(fn('loadWolfhouseQuoteConfigWithOverlay')+'\n'+fn('handleBookingEditWriteGuestDates'),sandbox);
    const res={};
    await sandbox.handleBookingEditWriteGuestDates(res,f.input(),{},Date.now(),'wolfhouse-somo',{});
    assert.equal(res.body.updated,false,JSON.stringify(res));
    assert.equal(res.status,500);
    assert.deepEqual(await f.state(db),before);
    assert(calls.every(c=>!c.options || c.options.initializeSchema!==true));
    const fallback=await sandbox.loadWolfhouseQuoteConfigWithOverlay();
    assert.equal(fallback.package_min_nights,null,'preview retains fallback');
  }
  // The actual store used by the strict loader is SELECT-only, not schema initialization.
  const queries=[]; const store=require('./lib/wolfhouse-pricing-store');
  const pg={query:async sql=>{queries.push(sql);return {rows:[]};}};
  await store.loadRules(pg,'wolfhouse-somo'); await store.loadItems(pg,'wolfhouse-somo');
  assert(queries.every(sql=>/^\s*SELECT\b/i.test(sql)));
};
const packages=[{guest_number:2,package_code:'waimea'},{guest_number:1,package_code:'uluwatu'}];
async function savePackages(db) {
 const sql=fn('handleBookingGuestPackagesWrite').match(/`UPDATE bookings b[\s\S]*?`/)[0].slice(1,-1);
 await db.query(sql,['wolfhouse-somo','GROUP',JSON.stringify(packages),'uluwatu']);
}
async function assertPackageReadback(db,sibling) {
 const b=await f.booking(db), g=await f.guest(db);
 const quote=require('./lib/wolfhouse-quote-calculator').calculateWolfhouseQuote({client_slug:'wolfhouse-somo',check_in:'2026-07-01',check_out:'2026-07-10',guest_count:1,package_code:'uluwatu'},f.config);
 assert.equal(g.metadata.accommodation_cents,quote.line_items.find(l=>l.code==='package_proration').total_cents);
 assert.equal(b.metadata.guest_dates_quote_context.package_code,'uluwatu');
 assert.deepEqual(await f.guest(db,f.S),sibling);
 assert.deepEqual(b.metadata.quote_snapshot.per_person[1],f.perPerson[1]);
 assert.equal(b.deposit_required_cents,30000); assert.equal(g.deposit_amount_cents,10000);
 assert.equal(bookingLedgerInvoicePaidBalance(b,3579,15000,0,0).invoice_total_cents,b.total_amount_cents);
 const context={movePreviewNights:(a,b)=>(Date.parse(b)-Date.parse(a))/86400000};vm.createContext(context);
 vm.runInContext(fn('projectBookingGuestStays'),context);
 const projected=context.projectBookingGuestStays(b,[{...g,booking_guest_id:g.id}, {...sibling,booking_guest_id:sibling.id}],[(await f.assignment(db)),(await f.assignment(db,f.A2))]);
 assert.equal(projected[0].check_out,'2026-07-10');assert.equal(projected[1].check_out,'2026-07-08');
}
cases.package = async db => {
 const sibling=await f.guest(db,f.S); await savePackages(db);
 const result=await editGuestDates(db,f.input(),{quoteConfig:f.config});assert.equal(result.status,200,JSON.stringify(result));
 await assertPackageReadback(db,sibling);
};
cases.inline = async db => {
 const sibling=await f.guest(db,f.S), calls=[];
 const mount={isConnected:true};
 const elements={'bc-drawer-card-booking':mount,'bc-field-dates-check-in':{value:'2026-07-01'},'bc-field-dates-check-out':{value:'2026-07-10'},'bc-inline-save':{}};
 let finish;const done=new Promise(resolve=>finish=resolve);
 const sandbox={Promise, document:{querySelectorAll:()=>[]},el:id=>elements[id],getBcClient:()=> 'wolfhouse-somo',
 bcFieldEditState:{inlineSession:1,clientSlug:'wolfhouse-somo',bookingId:f.B,bookingCode:'GROUP',snapshot:{}},
 bcFieldEditDatesChanged:()=>true,bcFieldEditBuildDatesWritePayload:()=>f.input(),
 bcFieldEditReadPackageGuestSelects:()=>packages,bcFieldEditPackageChanged:()=>true,
 bcFieldEditPostEdit:async body=>{calls.push('dates');const r=await editGuestDates(db,body,{quoteConfig:f.config});assert.equal(r.status,200);},
 bcFieldEditPostGuestPackages:async()=>{calls.push('package');await savePackages(db);},bcFieldEditCloseAll:()=>{},loadBlockDetail:()=>finish(),alert:e=>finish(Error(e))};
 vm.createContext(sandbox);vm.runInContext(fn('bcFieldEditSaveInlineAll'),sandbox);
 sandbox.bcFieldEditSaveInlineAll();const error=await done;if(error) throw error;
 assert.deepEqual(calls,['package','dates']);await assertPackageReadback(db,sibling);
};
function legacyHarness(db, afterPrecheck) {
 const trace=[]; let connections=0;
 const sandbox={require,console,Date,JSON,Set,Map,Math,
  DATE_RE:/^\d{4}-\d{2}-\d{2}$/,
  EDIT_WRITE_PACKAGE_MIN_NIGHTS:6,
  ...require('./lib/booking-invoice-totals'),
  ...require('./lib/staff-booking-services-schedule'),
  EDIT_PREVIEW_ACCOMM_LINE_CODES:require('./lib/booking-invoice-totals').EDIT_PREVIEW_ACCOMM_LINE_CODES,
  calculateWolfhouseQuote:require('./lib/wolfhouse-quote-calculator').calculateWolfhouseQuote,
  appendAuditLog:()=>{},sendJSON:(res,status,body)=>Object.assign(res,{status,body}),send400:(res,error)=>Object.assign(res,{status:400,body:{error}}),
  loadBookingServiceRecords:async(pg,slug,code)=>({rows:(await pg.query('SELECT * FROM booking_service_records WHERE client_slug=$1 AND booking_code=$2',[slug,code])).rows}),
  withPgClient:async cb=>{
   connections++;
   const pg={query:async(sql,args)=>{trace.push(sql);return db.query(sql,args);}};
   const result=await cb(pg);
   // Pause the actual legacy handler immediately AFTER its successful precheck,
   // then let the actual guest-date service commit before legacy BEGIN.
   if(connections===2 && afterPrecheck) {assert.equal(result.conflicts.length,0);await afterPrecheck();}
   return result;
  }};
 vm.createContext(sandbox);
 const loaded=new Set(Object.keys(sandbox));
 function load(name) {
  if(loaded.has(name)) return;
  loaded.add(name);
  const match=new RegExp('^(?:async )?function '+name+'\\(', 'm').exec(source);
  if(!match) return;
  const text=fn(name);
  for(const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) load(m[1]);
  for(const m of text.matchAll(/\b[A-Z][A-Z_]+_SQL\b/g)) {
   const constant=source.match(new RegExp('const '+m[0]+' = `([\\s\\S]*?)`;'));
   if(constant && !Object.hasOwn(sandbox,m[0])) {sandbox[m[0]]=constant[1];}
  }
  vm.runInContext(text,sandbox);
 }
 vm.runInContext(source.match(/^const MOVE_PREVIEW_NON_BLOCKING_STATUSES = .*;$/m)[0],sandbox);
 load('handleBookingEditWriteDates');
 return {trace,async run(id=f.id(20),body={check_in:'2026-07-08',check_out:'2026-07-12'}){
  const res={};await sandbox.handleBookingEditWriteDates(res,body,{},Date.now(),'offline','wolfhouse-somo',id,null);return res;
 }};
}
cases.legacy = async db => {
 await f.conflict(db,{start:'2026-07-12',end:'2026-07-16'});
 // Ordinary same-length legacy moves must still work.
 const normal=legacyHarness(db);const ok=await normal.run(f.id(20),{check_in:'2026-07-13',check_out:'2026-07-17'});
 assert.equal(ok.body.updated,true,JSON.stringify(ok));
 await f.seed(db);await f.conflict(db,{start:'2026-07-12',end:'2026-07-16'});
 const race=legacyHarness(db,async()=>{
  const r=await editGuestDates(db,f.input(),{quoteConfig:f.config});assert.equal(r.status,200,JSON.stringify(r));
 });
 const result=await race.run();
 assert.equal(result.body.updated,false,JSON.stringify(result));assert.equal(result.status,409,JSON.stringify(result));
 const overlaps=(await db.query(`SELECT a.id FROM booking_beds a JOIN booking_beds b ON a.bed_id=b.bed_id AND a.id<b.id
 WHERE a.assignment_start_date<b.assignment_end_date AND a.assignment_end_date>b.assignment_start_date`)).rows;
 assert.equal(overlaps.length,0);
 assert.equal((await f.assignment(db)).check_out,'2026-07-10');
 assert.equal((await db.query('SELECT assignment_start_date::text AS start FROM booking_beds WHERE id=$1',[f.id(21)])).rows[0].start,'2026-07-12');
 assert(race.trace.some(sql=>/FOR UPDATE/.test(sql)),'real handler acquires locks');
 const begin=race.trace.indexOf('BEGIN');
 const lockQueries=race.trace.slice(begin).filter(sql=>/FOR UPDATE/.test(sql));
 assert.match(lockQueries[0],/FROM bookings/);assert.match(lockQueries[1],/FROM booking_guests/);
 assert.match(lockQueries[2],/FROM booking_beds/);assert.match(lockQueries[3],/FROM rooms/);assert.match(lockQueries[4],/FROM beds/);
 const freshCheck=race.trace.slice(begin).findIndex(sql=>/assignment_start_date < \$3/.test(sql));
 const inventoryLock=race.trace.slice(begin).findIndex(sql=>/FOR UPDATE OF bed/.test(sql));
 assert(freshCheck>inventoryLock,'availability is a fresh statement after inventory locks return');
 assert(race.trace.slice(begin).filter(sql=>/FROM booking_beds/.test(sql)).length>=3,'locked fresh assignment read and availability recheck');
 // Same-booking mutation between the advisory read and BEGIN cannot be overwritten.
 await f.seed(db);let committed;
 const stale=legacyHarness(db,async()=>{
  const r=await editGuestDates(db,f.input(),{quoteConfig:f.config});assert.equal(r.status,200);
  committed=await f.state(db);
 });
 const staleResult=await stale.run(f.B,{check_in:'2026-07-02',check_out:'2026-07-09'});
 assert.equal(staleResult.status,409,JSON.stringify(staleResult));assert.equal(staleResult.body.error,'stale_booking_dates');
 assert.deepEqual(await f.state(db),committed,'no stale totals, quote, stays or deposits overwritten');
 // Fresh assignments are checked too, even if booking envelope/totals did not change.
 await f.seed(db);await f.conflict(db,{start:'2026-07-12',end:'2026-07-16'});
 const moved=legacyHarness(db,async()=>{
  await db.query("UPDATE booking_beds SET assignment_end_date='2026-07-17' WHERE id=$1",[f.id(21)]);
  committed=await f.state(db);
 });
 const movedResult=await moved.run();assert.equal(movedResult.body.error,'stale_booking_dates');
 assert.deepEqual(await f.state(db),committed);
 // Reverse serial order: a legitimate legacy commit is visible to guest_dates.
 await f.seed(db);await f.conflict(db,{start:'2026-07-12',end:'2026-07-16'});
 const first=await legacyHarness(db).run();assert.equal(first.body.updated,true);
 committed=await f.state(db);
 const second=await editGuestDates(db,f.input(),{quoteConfig:f.config});
 assert.equal(second.body.error,'date_conflict');assert.deepEqual(await f.state(db),committed);
 // Legacy shorter/longer ordinary financial edits still execute, not just no-op moves.
 await f.seed(db);await f.conflict(db,{start:'2026-07-12',end:'2026-07-16'});
 await db.query('UPDATE bookings SET total_amount_cents=36000,balance_due_cents=31000,amount_paid_cents=5000,deposit_required_cents=10000 WHERE id=$1',[f.id(20)]);
 const moneyResult=await legacyHarness(db).run(f.id(20),{check_in:'2026-07-12',check_out:'2026-07-17'});
 assert.equal(moneyResult.body.updated,true,JSON.stringify(moneyResult));
 const other=(await db.query('SELECT * FROM bookings WHERE id=$1',[f.id(20)])).rows[0];
 assert.equal(other.deposit_required_cents,10000);assert.equal(other.amount_paid_cents,5000);
 assert.notEqual(other.total_amount_cents,36000);assert.equal(other.balance_due_cents,other.total_amount_cents-5000);
};
cases.occupancyResidual = async db => {
 // Legacy private rooms may have only one assignment; never require a row per bed.
 for(const kind of ['couple_private','requested-private','metadata-private','supplement-private','private-block','other-private','shared']) {
  await f.seed(db);await f.conflict(db,{start:'2026-07-12',end:'2026-07-16',bed:f.id(7),privateRoom:kind==='couple_private',type:kind==='private-block'?'private_room_block':'guest'});
  if(kind==='requested-private')await db.query("UPDATE bookings SET requested_room_type='double' WHERE id=$1",[f.id(20)]);
  if(kind==='metadata-private')await db.query("UPDATE bookings SET metadata='{\"private_room_enabled\":true}' WHERE id=$1",[f.id(20)]);
  if(kind==='supplement-private')await db.query("UPDATE bookings SET metadata='{\"quote_snapshot\":{\"line_items\":[{\"code\":\"room_supplement\",\"total_cents\":1000}]}}' WHERE id=$1",[f.id(20)]);
  if(kind==='other-private')await db.query("UPDATE bookings SET room_preference='couple_private',check_out='2026-07-10' WHERE id=$1",[f.B]);
  let committed;
  const race=legacyHarness(db,async()=>{
   const guest=await editGuestDates(db,f.input(),{quoteConfig:f.config});assert.equal(guest.body.updated,true,JSON.stringify(guest));committed=await f.state(db);
  });
  const result=await race.run();
  if(kind==='shared')assert.equal(result.body.updated,true,JSON.stringify(result));
  else {assert.equal(result.status,409,kind+': '+JSON.stringify(result));assert.equal(result.body.error,'date_conflict');assert.deepEqual(await f.state(db),committed);}
  assert(race.trace.some(sql=>sql.includes('FOR UPDATE OF bed')));
  console.log('PASS occupancy residual',kind);
 }
 // Fresh whole-room and primary-room private bookings with NO assignment rows.
 for(const kind of ['whole-room','primary-private','expired-whole-room','adjacent-whole-room']) {
  await f.seed(db);await f.conflict(db,{start:'2026-07-12',end:'2026-07-16',bed:f.id(7)});
  let committed;
  const race=legacyHarness(db,async()=>{
   await db.query(`INSERT INTO bookings(client_id,booking_code,status,check_in,check_out,block_type,room_to_block_id,primary_room_code,room_preference)
    VALUES($1,'ROOM-BLOCK',$2,$3,'2026-07-14',$4,$5,$6,$7)`,[f.C,kind==='expired-whole-room'?'expired':'blocked',kind==='adjacent-whole-room'?'2026-07-12':'2026-07-09',kind==='primary-private'?'none':'whole_room',kind==='primary-private'?null:f.id(5),kind==='primary-private'?'R1':null,kind==='primary-private'?'private':null]);
   committed=await f.state(db);
  });
  const result=await race.run();
  if(kind.startsWith('expired') || kind.startsWith('adjacent'))assert.equal(result.body.updated,true,JSON.stringify(result));
  else {assert.equal(result.body.error,'date_conflict',JSON.stringify(result));assert.deepEqual(await f.state(db),committed);}
  console.log('PASS occupancy residual',kind);
 }
 // Reverse order and nonconflicting private move remain usable.
 await f.seed(db);await f.conflict(db,{start:'2026-07-12',end:'2026-07-16',bed:f.id(7),privateRoom:true});
 assert.equal((await legacyHarness(db).run()).body.updated,true);
 const committed=await f.state(db),second=await editGuestDates(db,f.input(),{quoteConfig:f.config});
 assert.equal(second.body.error,'date_conflict');assert.deepEqual(await f.state(db),committed);
 await f.seed(db);await f.conflict(db,{start:'2026-07-12',end:'2026-07-16',bed:f.id(7),privateRoom:true});
 assert.equal((await legacyHarness(db).run(f.id(20),{check_in:'2026-07-13',check_out:'2026-07-17'})).body.updated,true);
 console.log('PASS occupancy residual reverse-order and legitimate-private-move');
};
(async()=>{
 const db = new f.PGlite();
 try {
  await f.setup(db);
  for (const [name,test] of Object.entries(cases)) {
   if(process.argv[2] && process.argv[2]!==name) continue;
   await f.seed(db); await test(db); console.log('PASS repair '+name);
  }
  assert.equal(f.networkAttempts(),0); console.log('networkAttempts=0; single-session PGlite only');
 } finally {await db.close();}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
