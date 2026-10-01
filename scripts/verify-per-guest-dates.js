'use strict';
/** Offline real PostgreSQL (PGlite) tests. No mock SQL, providers, or live DB.
 * Uses actual migrations; two bootstrap-only adaptations are documented below.
 * PGlite proves transactions/readbacks, NOT multi-session lock interleavings.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { loadConfig, calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const root = path.resolve(__dirname, '..');
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C = id(1), B = id(2), G = id(3), S = id(4), R = id(5), BED = id(6), BED2 = id(7), A = id(8), A2 = id(9);
const config = loadConfig();
// Deliberately unlike disk defaults: injected Admin overlay wins, including deposits.
config.packages.find(p => p.code === 'malibu').seasonal_prices.summer.weekly_per_person_cents = 63000;
config.deposits.tiers.standard_package.amount_cents = 33333;
config.deposits.tiers.custom_or_short_stay.amount_cents = 7777;
const perPerson = [
  { guest_number: 1, guest_name: 'Selected', package_code: 'package_none', accommodation_cents: 21000, addons_cents: 1234, supplement_cents: 0, subtotal_cents: 22234, deposit_cents: 10000 },
  { guest_number: 2, guest_name: 'Sibling', package_code: 'waimea', accommodation_cents: 54900, addons_cents: 2345, supplement_cents: 0, subtotal_cents: 57245, deposit_cents: 20000, opaque: { untouched: true } },
];
const input = (extra = {}) => ({ client_slug: 'wolfhouse-somo', booking_id: B, booking_guest_id: G,
  check_in: '2026-07-01', check_out: '2026-07-10', expected_check_in: '2026-07-01', expected_check_out: '2026-07-06', idempotency_key: 'extend', ...extra });
let networkAttempts = 0;
const deny = () => { networkAttempts++; throw Error('Network forbidden in SQL verification'); };
global.fetch = deny;
require('node:http').request = deny;
require('node:https').request = deny;
require('node:net').Socket.prototype.connect = deny;
const evidence = { engine: 'PGlite', migrations: ['001', '003', '010', '024'], cases: [], readbacks: [], limitations: ['PGlite is single-session; no multi-session concurrency proof.', 'Bootstrap omits unavailable pgcrypto extension (gen_random_uuid is built in) and obsolete DROP TRIGGER ON hostels after table rename.'] };
let editGuestDates;
async function setup(db) {
  for (const file of ['001_init.sql', '003_rename_hostel_to_client.sql', '010_booking_service_records.sql', '024_booking_guests.sql']) {
    let sql = fs.readFileSync(path.join(root, 'database/migrations', file), 'utf8');
    sql = sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '').replace('DROP TRIGGER IF EXISTS hostels_updated_at ON hostels;', '');
    await db.exec(sql);
  }
}
async function seed(db) {
  await db.exec('TRUNCATE clients CASCADE; TRUNCATE booking_service_records');
  await db.query('INSERT INTO clients(id,slug,name) VALUES($1,$2,$3)', [C, 'wolfhouse-somo', 'Synthetic']);
  await db.query('INSERT INTO rooms(id,client_id,room_code,capacity) VALUES($1,$2,\'R1\',4)', [R,C]);
  for (const [bed, code] of [[BED,'R1-1'],[BED2,'R1-2']]) await db.query('INSERT INTO beds(id,client_id,room_id,bed_code) VALUES($1,$2,$3,$4)', [bed,C,R,code]);
  await db.query(`INSERT INTO bookings(id,client_id,booking_code,guest_name,status,check_in,check_out,guest_count,package_code,
    total_amount_cents,amount_paid_cents,balance_due_cents,deposit_required_cents,metadata)
    VALUES($1,$2,'GROUP','Selected','confirmed','2026-07-01','2026-07-08',2,'waimea',79479,15000,64479,30000,$3)`,
  [B,C,JSON.stringify({ untouched: 'booking', quote_snapshot: { per_person: perPerson, total_cents: 79479, deposit_required_cents: 30000,
    line_items: [{code:'accommodation_only',total_cents:75900}, {code:'meal',total_cents:3579}] } })]);
  for (const [guest,num,name,code,end,assignment,bed] of [[G,1,'Selected','R1-1','2026-07-06',A,BED],[S,2,'Sibling','R1-2','2026-07-08',A2,BED2]]) {
    await db.query(`INSERT INTO booking_guests(id,client_id,booking_id,guest_number,guest_name,assigned_room_code,assigned_bed_code,
      deposit_amount_cents,amount_paid_cents,payment_status,metadata) VALUES($1,$2,$3,$4,$5,'R1',$6,$7,$8,'paid',$9)`,
    [guest,C,B,num,name,code,num===1?10000:20000,num===1?5000:10000,JSON.stringify({package_code:perPerson[num-1].package_code,subtotal_cents:perPerson[num-1].subtotal_cents,opaque: { keep: name }})]);
    await db.query(`INSERT INTO booking_beds(id,client_id,booking_id,bed_id,bed_code,room_code,assignment_type,assignment_start_date,assignment_end_date)
      VALUES($1,$2,$3,$4,$5,'R1','guest','2026-07-01',$6)`,[assignment,C,B,bed,code,end]);
  }
  await db.query("INSERT INTO payments(client_id,booking_id,booking_guest_id,amount_cents,metadata) VALUES($1,$2,$3,5000,'{\"keep\":true}')",[C,B,G]);
  await db.query("INSERT INTO booking_service_records(client_slug,booking_id,booking_code,service_type,service_date,amount_due_cents) VALUES('wolfhouse-somo',$1,'GROUP','meal','2026-07-04',3579)",[B]);
}
async function state(db) {
  const out = {};
  for (const table of ['bookings','booking_guests','booking_beds','payments','booking_service_records']) {
    out[table] = (await db.query(`SELECT row_to_json(t)::text AS bytes FROM (SELECT * FROM ${table} ORDER BY id) t`)).rows.map(r=>r.bytes);
  }
  return out;
}
async function booking(db) { return (await db.query('SELECT *, check_in::text AS check_in,check_out::text AS check_out FROM bookings WHERE id=$1',[B])).rows[0]; }
async function guest(db, guestId=G) {return (await db.query('SELECT * FROM booking_guests WHERE id=$1',[guestId])).rows[0];}
async function assignment(db, a=A) { return (await db.query('SELECT *,assignment_start_date::text AS check_in,assignment_end_date::text AS check_out FROM booking_beds WHERE id=$1',[a])).rows[0]; }
async function run(db, name, fn) { await seed(db); await fn(); evidence.cases.push(name); console.log('PASS',name); }
async function rejectUnchanged(db, request, code, opts={quoteConfig:config}, pg=db) {
  const before=await state(db); const result=await editGuestDates(pg,request,opts);
  assert.equal(result.body.success,false,JSON.stringify(result)); assert.equal(result.body.updated,false); assert.equal(result.body.error,code,JSON.stringify(result));
  assert.deepEqual(await state(db),before,'Rejected operation must leave every byte unchanged'); return result;
}
async function conflict(db,{sameBooking=false,status='confirmed',start='2026-07-08',end='2026-07-12',bed=BED,type='guest',privateRoom=false,expires=null}={}) {
  const other = sameBooking ? B : id(20);
  if(!sameBooking) await db.query(`INSERT INTO bookings(id,client_id,booking_code,status,check_in,check_out,hold_expires_at,room_preference)
    VALUES($1,$2,'OTHER',$3,$4,$5,$6,$7)`,[other,C,status,start,end,expires,privateRoom?'couple_private':null]);
  await db.query(`INSERT INTO booking_beds(id,client_id,booking_id,bed_id,bed_code,room_code,assignment_type,assignment_start_date,assignment_end_date)
    VALUES($1,$2,$3,$4,$5,'R1',$6,$7,$8)`,[id(21),C,other,bed,bed===BED?'R1-1':'R1-2',type,start,end]);
}
(async()=>{
 const db=new PGlite();
 try {
  await setup(db);
  await run(db,'baseline-existing-booking-date-SQL-mass-updates-siblings',async()=>{
    const source=fs.readFileSync(path.join(__dirname,'staff-query-api.js'),'utf8');
    const sql=source.match(/const EDIT_WRITE_DATES_UPDATE_BEDS_SQL = `([\s\S]*?)`;/)[1];
    await db.query('BEGIN');
    const changed=await db.query(sql,['wolfhouse-somo',B,'2026-07-01','2026-07-10']);
    assert.equal(changed.rows.length,2); assert.equal((await assignment(db,A2)).check_out,'2026-07-10');
    await db.query('ROLLBACK'); assert.equal((await assignment(db,A2)).check_out,'2026-07-08');
  });
  // Intentionally loaded after the baseline: first RED proves the module is absent.
  ({editGuestDates}=require('./lib/booking-guest-dates'));
  await run(db,'extension-admin-price-selected-only-envelope-money-deposits-services',async()=>{
    const before=await state(db), sibling=await guest(db,S), siblingBed=await assignment(db,A2);
    const result=await editGuestDates(db,input(),{quoteConfig:config}); assert.equal(result.status,200,JSON.stringify(result)); assert.equal(result.body.updated,true);
    const after=await booking(db), selected=await guest(db), bed=await assignment(db);
    const q=calculateWolfhouseQuote({client_slug:'wolfhouse-somo',check_in:'2026-07-01',check_out:'2026-07-10',guest_count:1,package_code:'no_package',room_type:'shared',add_ons:[]},config);
    assert.equal(q.success,true); const acc=q.line_items.filter(l=>['package','package_proration','accommodation_only'].includes(l.code)).reduce((s,l)=>s+l.total_cents,0);
    assert.equal(selected.metadata.accommodation_cents,acc); assert.equal(selected.metadata.subtotal_cents,22234+acc-21000);
    assert.equal(selected.metadata.nights,9); assert.equal(selected.metadata.check_out,'2026-07-10');
    assert.equal(after.total_amount_cents,79479+acc-21000); assert.equal(after.balance_due_cents,after.total_amount_cents-15000);
    assert.equal(after.deposit_required_cents,30000); assert.equal(selected.deposit_amount_cents,10000); assert.equal(selected.amount_paid_cents,5000);
    assert.equal(bed.check_out,'2026-07-10'); assert.equal(after.check_out,'2026-07-10');
    assert.deepEqual(await guest(db,S),sibling); assert.deepEqual(await assignment(db,A2),siblingBed);
    assert.deepEqual(after.metadata.quote_snapshot.per_person[1],perPerson[1]);
    assert.equal(after.metadata.quote_snapshot.per_person[0].accommodation_cents,acc);
    assert.equal(result.body.per_person[0].subtotal_cents,selected.metadata.subtotal_cents);
    const all=await state(db); assert.deepEqual(all.payments,before.payments); assert.deepEqual(all.booking_service_records,before.booking_service_records);
    evidence.readbacks.push({case:'extension',selected,booking:after,assignment:bed});
    const replayBefore=await state(db); const replay=await editGuestDates(db,input(),{});
    assert.equal(replay.body.updated,false); assert.equal(replay.body.idempotent,true); assert.deepEqual(await state(db),replayBefore);
    await rejectUnchanged(db,input({check_out:'2026-07-11'}),'idempotency_conflict');
  });
  await run(db,'shortening-retains-sibling-envelope-and-historical-deposit',async()=>{
    const r=await editGuestDates(db,input({check_in:'2026-07-02',check_out:'2026-07-04',idempotency_key:'shorten'}),{quoteConfig:config});
    assert.equal(r.status,200,JSON.stringify(r)); const b=await booking(db), g=await guest(db);
    assert.equal(b.check_in,'2026-07-01');assert.equal(b.check_out,'2026-07-08');assert.equal(g.metadata.nights,2);
    assert.equal(g.metadata.accommodation_cents,18000);assert.equal(b.total_amount_cents,76479);assert.equal(b.deposit_required_cents,30000);assert.equal(g.deposit_amount_cents,10000);
    evidence.readbacks.push({case:'shorten',selected:g,booking:b});
  });
  await run(db,'stale-expected-dates-and-same-value-replay',async()=>{
    await rejectUnchanged(db,input({expected_check_out:'2026-07-08'}),'stale_guest_dates');
    const before=await state(db); const r=await editGuestDates(db,input({check_out:'2026-07-06',expected_check_out:'2026-07-03'}),{});
    assert.equal(r.body.idempotent,true);assert.equal(r.body.updated,false);assert.deepEqual(await state(db),before);
  });
  await run(db,'strict-calendar-input-and-required-freshness',async()=>{
    for(const change of [{check_in:'2026-02-30'},{check_in:'2026-07-10'},{expected_check_out:null},{check_out:'2026-7-10'}]) await rejectUnchanged(db,input(change),'invalid_request');
  });
  await run(db,'tenant-booking-and-durable-guest-scope',async()=>{
    for(const change of [{client_slug:'other'},{booking_id:id(99)},{booking_code:'WRONG'}]) await rejectUnchanged(db,input(change),'booking_not_found');
    await rejectUnchanged(db,input({booking_guest_id:id(98)}),'guest_not_found');
    const r=await editGuestDates(db,input({booking_id:undefined,booking_code:'GROUP'}),{quoteConfig:config});assert.equal(r.body.updated,true);
  });
  await run(db,'missing-and-ambiguous-assignment-fail-closed',async()=>{
    await db.query("UPDATE booking_guests SET assigned_bed_code=NULL WHERE id=$1",[G]);await rejectUnchanged(db,input(),'guest_assignment_ambiguous');
    await db.query("UPDATE booking_guests SET assigned_bed_code='R1-1' WHERE id=$1",[G]);
    await conflict(db,{sameBooking:true});await rejectUnchanged(db,input(),'guest_assignment_ambiguous');
  });
  await run(db,'duplicate-guest-bed-ownership-fail-closed',async()=>{
    await db.query("UPDATE booking_guests SET assigned_bed_code='R1-1' WHERE id=$1",[S]);await rejectUnchanged(db,input(),'guest_assignment_ambiguous');
  });
  for(const status of ['cancelled','expired','blocked']) await run(db,`source-${status}-rejected`,async()=>{
    await db.query('UPDATE bookings SET status=$1 WHERE id=$2',[status,B]);await rejectUnchanged(db,input(),'booking_not_editable');
  });
  await run(db,'unavailable-config-and-stored-price-basis-rejected',async()=>{
    await rejectUnchanged(db,input(),'pricing_unavailable',{});
    const bad=structuredClone(config);bad.packages=[];await rejectUnchanged(db,input(),'pricing_unavailable',{quoteConfig:bad});
    await db.query("UPDATE bookings SET metadata='{}' WHERE id=$1",[B]);await rejectUnchanged(db,input(),'pricing_basis_unavailable');
  });
  await run(db,'inactive-unsellable-bed-or-room-rejected',async()=>{
    await db.query('UPDATE beds SET sellable=false WHERE id=$1',[BED]);await rejectUnchanged(db,input(),'bed_not_sellable');
    await db.query('UPDATE beds SET sellable=true WHERE id=$1',[BED]);await db.query('UPDATE rooms SET active=false WHERE id=$1',[R]);await rejectUnchanged(db,input(),'bed_not_sellable');
  });
  for(const status of ['confirmed','hold','payment_pending','needs_review','checked_in','blocked']) await run(db,`conflict-${status}-blocks`,async()=>{
    await conflict(db,{status,expires:'2020-01-01'});await rejectUnchanged(db,input(),'date_conflict');
  });
  for(const status of ['cancelled','expired']) await run(db,`conflict-${status}-ignored`,async()=>{
    await conflict(db,{status});assert.equal((await editGuestDates(db,input(),{quoteConfig:config})).body.updated,true);
  });
  for(const range of [{start:'2026-07-10',end:'2026-07-12'},{start:'2026-06-28',end:'2026-07-01'}]) await run(db,`half-open-boundary-${range.start}`,async()=>{
    await conflict(db,range);assert.equal((await editGuestDates(db,input(),{quoteConfig:config})).body.updated,true);
  });
  await run(db,'private-room-on-other-bed-conflicts',async()=>{
    await conflict(db,{bed:BED2,privateRoom:true});await rejectUnchanged(db,input(),'date_conflict');
  });
  await run(db,'private-room-block-on-other-bed-conflicts',async()=>{
    await conflict(db,{bed:BED2,type:'private_room_block'});await rejectUnchanged(db,input(),'date_conflict');
  });
  await run(db,'operator-whole-room-without-assignment-conflicts',async()=>{
    await db.query(`INSERT INTO bookings(client_id,booking_code,status,check_in,check_out,block_type,room_to_block_id)
      VALUES($1,'ROOM-BLOCK','blocked','2026-07-08','2026-07-12','whole_room',$2)`,[C,R]);
    await rejectUnchanged(db,input(),'date_conflict');
  });
  await run(db,'sequential-edits-use-last-stored-guest-basis',async()=>{
    assert.equal((await editGuestDates(db,input(),{quoteConfig:config})).body.updated,true);
    const r=await editGuestDates(db,input({check_out:'2026-07-04',expected_check_out:'2026-07-10',idempotency_key:'second'}),{quoteConfig:config});
    assert.equal(r.body.updated,true,JSON.stringify(r)); const b=await booking(db),g=await guest(db);
    assert.equal(g.metadata.accommodation_cents,27000);assert.equal(g.metadata.subtotal_cents,28234);assert.equal(b.total_amount_cents,85479);
    assert.equal(b.check_out,'2026-07-08');assert.deepEqual(b.metadata.quote_snapshot.per_person[1],perPerson[1]);
    await rejectUnchanged(db,input(),'idempotency_conflict');
  });
  await run(db,'overpayment-is-not-lost-when-recalculating-balance',async()=>{
    await db.query('UPDATE bookings SET amount_paid_cents=100000,balance_due_cents=0 WHERE id=$1',[B]);
    const r=await editGuestDates(db,input(),{quoteConfig:config});assert.equal(r.body.updated,true);
    const b=await booking(db);assert.equal(b.amount_paid_cents,100000);assert.equal(b.balance_due_cents,Math.max(0,b.total_amount_cents-100000));
  });
  await run(db,'selected-named-package-not-booking-majority-is-requoted',async()=>{
    await db.query("UPDATE booking_guests SET metadata=jsonb_set(metadata,'{package_code}','\"uluwatu\"') WHERE id=$1",[G]);
    const r=await editGuestDates(db,input(),{quoteConfig:config});assert.equal(r.body.updated,true,JSON.stringify(r));
    const g=await guest(db); const quote=calculateWolfhouseQuote({client_slug:'wolfhouse-somo',check_in:'2026-07-01',check_out:'2026-07-10',guest_count:1,package_code:'uluwatu'},config);
    assert.equal(g.metadata.accommodation_cents,quote.line_items.find(l=>l.code==='package_proration').total_cents);
    assert.equal((await guest(db,S)).metadata.package_code,'waimea');
  });
  await run(db,'named-package-too-short-and-closed-season-rejected',async()=>{
    await db.query("UPDATE booking_guests SET metadata=jsonb_set(metadata,'{package_code}','\"uluwatu\"') WHERE id=$1",[G]);
    await rejectUnchanged(db,input({check_out:'2026-07-04'}),'pricing_unavailable');
    await rejectUnchanged(db,input({check_in:'2026-12-01',check_out:'2026-12-10'}),'pricing_unavailable');
  });
  await run(db,'durable-metadata-bed-id-and-mismatched-id-code',async()=>{
    await db.query("UPDATE booking_guests SET assigned_bed_code=NULL,metadata=metadata||jsonb_build_object('assigned_bed_id',$2::text) WHERE id=$1",[G,BED]);
    assert.equal((await editGuestDates(db,input(),{quoteConfig:config})).body.updated,true);
    await db.query("UPDATE booking_guests SET assigned_bed_code='R1-2' WHERE id=$1",[G]);
    await rejectUnchanged(db,input({check_out:'2026-07-11',expected_check_out:'2026-07-10',idempotency_key:'mismatch'}),'guest_assignment_ambiguous');
  });
  await run(db,'private-room-shortening-does-not-conflict-with-own-sibling',async()=>{
    await db.query("UPDATE bookings SET room_preference='couple_private' WHERE id=$1",[B]);
    const r=await editGuestDates(db,input({check_out:'2026-07-04'}),{quoteConfig:config});assert.equal(r.body.updated,true,JSON.stringify(r));
    assert.equal((await assignment(db,A2)).check_out,'2026-07-08');
  });
  await run(db,'private-room-extension-requires-explicit-room-reservation',async()=>{
    await db.query("UPDATE bookings SET room_preference='couple_private' WHERE id=$1",[B]);
    await rejectUnchanged(db,input(),'private_room_reservation_requires_review');
  });
  await run(db,'real-SQL-trigger-failure-rolls-back-partial-writes',async()=>{
    await db.exec(`CREATE FUNCTION fail_date_edit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected SQL failure'; END $$;
      CREATE TRIGGER fail_date_edit BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION fail_date_edit();`);
    try {await rejectUnchanged(db,input(),'guest_dates_update_failed');}
    finally {await db.exec('DROP TRIGGER fail_date_edit ON bookings; DROP FUNCTION fail_date_edit()');}
  });
  await run(db,'nondefault-Admin-package-price-and-minimum-override',async()=>{
    await db.query("UPDATE booking_guests SET metadata=jsonb_set(metadata,'{package_code}','\"malibu\"') WHERE id=$1",[G]);
    const r=await editGuestDates(db,input(),{quoteConfig:config});assert.equal(r.body.updated,true,JSON.stringify(r));
    assert.equal((await guest(db)).metadata.accommodation_cents,81000,'Admin 63000 weekly overrides seed 29900');
    const shortConfig=structuredClone(config);shortConfig.package_min_nights=3;
    const shortened=await editGuestDates(db,input({check_out:'2026-07-05',expected_check_out:'2026-07-10',idempotency_key:'minimum-override'}),{quoteConfig:shortConfig});
    assert.equal(shortened.body.updated,true,JSON.stringify(shortened));
    assert.equal((await guest(db)).metadata.nights,4);assert.equal((await guest(db)).deposit_amount_cents,10000);
  });
  await run(db,'same-night-count-season-move-reprices-selected-only',async()=>{
    await db.query("UPDATE booking_guests SET metadata=jsonb_set(metadata,'{package_code}','\"malibu\"') WHERE id=$1",[G]);
    await db.query("UPDATE booking_beds SET assignment_end_date='2026-07-08' WHERE id=$1",[A]);
    const sibling=await guest(db,S);
    const r=await editGuestDates(db,input({check_in:'2026-10-01',check_out:'2026-10-08',expected_check_out:'2026-07-08'}),{quoteConfig:config});
    assert.equal(r.body.updated,true,JSON.stringify(r));assert.equal(r.body.before.nights,r.body.after.nights);
    assert.equal((await guest(db)).metadata.accommodation_cents,24900);assert.deepEqual(await guest(db,S),sibling);
  });
  await run(db,'unassigned-legacy-sibling-keeps-original-window-after-envelope-change',async()=>{
    await db.query('DELETE FROM booking_beds WHERE id=$1',[A2]);
    await db.query('UPDATE booking_guests SET assigned_bed_code=NULL,assigned_room_code=NULL WHERE id=$1',[S]);
    const sibling=await guest(db,S);
    const r=await editGuestDates(db,input(),{quoteConfig:config});assert.equal(r.body.updated,true,JSON.stringify(r));
    const b=await booking(db);
    assert.deepEqual(b.metadata.guest_stay_windows[S],{check_in:'2026-07-01',check_out:'2026-07-08'},'freeze legacy sibling fallback before changing envelope');
    assert.deepEqual(await guest(db,S),sibling);
    const again=await editGuestDates(db,input({check_out:'2026-07-04',expected_check_out:'2026-07-10',idempotency_key:'shorten-again'}),{quoteConfig:config});
    assert.equal(again.body.updated,true,JSON.stringify(again));assert.equal((await booking(db)).check_out,'2026-07-08','unassigned sibling remains part of coverage envelope');
  });
  await run(db,'native-route-real-SQL-context-invoice-and-guest-checkout-readback',async()=>{
    const vm=require('node:vm');
    const source=fs.readFileSync(path.join(__dirname,'staff-query-api.js'),'utf8');
    const fn=name=>{const at=new RegExp('(?:async )?function '+name+'\\(').exec(source).index;return source.slice(at,source.indexOf('\n}',at)+2);};
    const audits=[];
    const sandbox={console,Date,JSON,Set,Map,STAFF_ACTIONS_ENABLED:true,STAFF_AUTH_REQUIRED:true,DEFAULT_CLIENT:'wolfhouse-somo',
      SQL_INJECT_RE:/[';]|--/,UUID_VALIDATE_RE:/^[0-9a-f-]{36}$/i,readBody:async req=>req.raw,
      sendJSON:(res,status,body)=>Object.assign(res,{status,body}),send400:(res,error)=>Object.assign(res,{status:400,body:{error}}),
      appendAuditLog:event=>audits.push(event),withPgClient:fn=>fn(db),staffClientAccessAllowed:(_user,slug)=>slug==='wolfhouse-somo',
      requireAuth:async()=>({ok:true,user:{role:'operator'}}),loadWolfhouseQuoteConfigWithOverlay:async()=>config,
      require,staffPackageDisplayLabel:x=>x,movePreviewNights:(a,b)=>(Date.parse(b)-Date.parse(a))/86400000};
    vm.createContext(sandbox);
    const at=source.indexOf("  if (pathname === '/staff/bookings/edit') {");
    const route=source.slice(at,source.indexOf('\n  }',at)+4);
    vm.runInContext(source.match(/^const EDIT_WRITE_SUPPORTED_TYPES = .*;$/m)[0]+'\n'+
      ['assertStaffClientAccess','handleBookingEditWriteGuestDates','handleBookingEditWrite','projectBookingGuestStays','buildGuestAccommodationLines'].map(fn).join('\n')+
      '\nasync function route(req,res){const pathname="/staff/bookings/edit",method="POST";'+route+'\n}',sandbox);
    const res={};await sandbox.route({raw:JSON.stringify({...input(),edit_type:'guest_dates'})},res);
    assert.equal(res.status,200,JSON.stringify(res));assert.equal(res.body.updated,true);assert(audits.some(a=>a.updated));
    const b=await booking(db);
    const guests=(await db.query(require('./lib/booking-guests').BOOKING_GUESTS_SELECT_SQL,['wolfhouse-somo','GROUP'])).rows;
    const roomSql=source.match(/const BOOKING_CONTEXT_ROOMING_SQL = `([\s\S]*?)`;/)[1];
    const rooming=(await db.query(roomSql,['wolfhouse-somo','GROUP'])).rows;
    const projected=sandbox.projectBookingGuestStays(b,guests,rooming);
    assert.equal(projected.find(g=>g.booking_guest_id===S).check_out,'2026-07-08','legacy sibling context uses own assignment, not extended envelope');
    const lines=sandbox.buildGuestAccommodationLines('wolfhouse-somo',b,b.metadata,projected);
    assert.equal(lines.find(g=>g.guest_number===1).nights,9);assert.equal(lines.find(g=>g.guest_number===2).nights,7);
    assert.equal(lines.find(g=>g.guest_number===1).accommodation_cents,81000);
    const invoice=require('./lib/booking-invoice-totals').bookingLedgerInvoicePaidBalance(b,3579,15000,0,0);
    assert.equal(invoice.invoice_total_cents,b.total_amount_cents,'embedded services counted once');
    const selected=await guest(db);
    const checkoutRow={...selected,guest_metadata:selected.metadata};
    const {amountFor}=require('./lib/per-guest-checkout');
    assert.equal(amountFor(checkoutRow,'deposit'),5000,'KEEP deposit less unchanged receipt');
    assert.equal(amountFor(checkoutRow,'remaining_share'),selected.metadata.subtotal_cents-5000);
    evidence.readbacks.push({case:'native-route-context-invoice',projected,lines,invoice});
  });
  assert.equal(networkAttempts,0);evidence.passed=true;evidence.networkAttempts=networkAttempts;
  console.log(JSON.stringify(evidence,null,2));
 } finally {await db.close();}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
