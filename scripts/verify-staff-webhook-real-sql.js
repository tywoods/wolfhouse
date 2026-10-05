'use strict';
// Offline production reconcile -> production SQL, real migrations. No live authority.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { reconcilePaidStripeSession } = require('./lib/stripe-payment-reconcile');
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const C=id(1), B=id(2), G=id(3), P=id(4);
const deny=()=>{throw Error('offline network forbidden');};
global.fetch=deny; require('node:https').request=deny; require('node:http').request=deny;
(async()=>{
 const db=new PGlite();
 const pg={async query(sql,args){const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};}};
 try {
  for(const file of ['001_init.sql','003_rename_hostel_to_client.sql','004_payment_schema_phase2.sql','006_confirmation_sent_at.sql','019_bookings_language.sql','024_booking_guests.sql']){
   let sql=fs.readFileSync(path.join(__dirname,'../database/migrations',file),'utf8');
   sql=sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;','').replace('DROP TRIGGER IF EXISTS hostels_updated_at ON hostels;','');
   await db.exec(sql);
  }
  await db.query('INSERT INTO clients(id,slug,name) VALUES($1,\'wolfhouse-somo\',\'Offline\')',[C]);
  await db.query(`INSERT INTO bookings(id,client_id,booking_code,guest_name,status,check_in,check_out,guest_count,total_amount_cents,balance_due_cents,deposit_required_cents)
   VALUES($1,$2,'OFFLINE','Ada','confirmed','2026-10-01','2026-10-06',2,20000,20000,20000)`,[B,C]);
  await db.query(`INSERT INTO booking_guests(id,client_id,booking_id,guest_number,guest_name,deposit_amount_cents,metadata)
   VALUES($1,$2,$3,1,'Ada',10000,'{"subtotal_cents":10000}')`,[G,C,B]);
  await db.query(`INSERT INTO payments(id,client_id,booking_id,booking_guest_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents,stripe_checkout_session_id)
   VALUES($1,$2,$3,$4,'checkout_created','deposit_only','EUR',4000,0,'cs_offline')`,[P,C,B,G]);
  const session={id:'cs_offline',payment_status:'paid',status:'complete',currency:'eur',amount_total:4000,payment_intent:'pi_offline',metadata:{client_slug:'wolfhouse-somo',payment_id:P}};
  const meta={expectedClientSlug:'wolfhouse-somo',eventId:'evt_offline'};
  const result=await reconcilePaidStripeSession(pg,session,meta);
  assert.equal(result.reconciled,true);
  let booking=(await db.query('SELECT * FROM bookings WHERE id=$1',[B])).rows[0];
  assert.equal(booking.amount_paid_cents,4000); assert.equal(booking.balance_due_cents,16000); assert.notEqual(booking.payment_status,'paid');
  assert.equal((await db.query('SELECT amount_paid_cents FROM booking_guests WHERE id=$1',[G])).rows[0].amount_paid_cents,4000);
  assert.equal((await reconcilePaidStripeSession(pg,session,meta)).reason,'already_paid');
  assert.equal((await db.query('SELECT amount_paid_cents FROM bookings WHERE id=$1',[B])).rows[0].amount_paid_cents,4000);
  console.log('PASS actual migration-backed first receipt + duplicate + partial booking/guest balances');
  const {loadConfig,calculateWolfhouseQuote}=require('./lib/wolfhouse-quote-calculator');
  const {buildManualBookingCreateSql}=require('./lib/staff-manual-booking-create-sql');
  const {buildPerPersonBreakdown,insertBookingGuestsForBooking}=require('./lib/booking-guests');
  // Run the actual link owner with only its provider transport replaced by an
  // explicitly synthetic SDK. Network remains denied; no real Checkout exists.
  const vm=require('node:vm');
  const sessions=[];
  const fakeStripe=()=>({checkout:{sessions:{async create(payload){
   assert(payload.line_items.every(item=>Number.isInteger(item.price_data.unit_amount)&&item.price_data.unit_amount>0));
   const session={id:'cs_synthetic_'+sessions.length,url:'https://offline.invalid/checkout/'+sessions.length,payload};
   sessions.push(session);return session;
  }}}});
  const linkModule={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'lib/staff-manual-booking-payment.js'),'utf8'),{
   module:linkModule,exports:linkModule.exports,require:name=>{assert.equal(name,'stripe');return fakeStripe;},Date,console,
  },{filename:'staff-manual-booking-payment.js'});
  const {manualBookingApplyStaffPaymentChoice}=linkModule.exports;
  const stripeConfig={stripeLinksEnabled:true,stripeSecretKey:'synthetic-offline-only',redirectUrlsConfigured:true,successUrl:'https://offline.invalid/success',cancelUrl:'https://offline.invalid/cancel'};
  const config=loadConfig();
  const quoteInput={client_slug:'wolfhouse-somo',check_in:'2026-10-14',check_out:'2026-10-17',guest_count:3,package_code:'package_none',room_type:'shared',payment_choice:'deposit'};
  const threeNight=calculateWolfhouseQuote(quoteInput,config);
  assert.equal(threeNight.success,true);assert.equal(threeNight.total_cents,36000);assert.equal(threeNight.deposit_required_cents,30000);
  assert(threeNight.per_guest_deposits.every(g=>g.deposit_cents===10000));
  const mixed=calculateWolfhouseQuote({...quoteInput,check_out:'2026-10-21',guest_packages:[{guest_number:1,package_code:'package_none'},{guest_number:2,package_code:'malibu'},{guest_number:3,package_code:'uluwatu'}]},config);
  assert.equal(mixed.success,true);assert.equal(mixed.deposit_required_cents,60000);
  for(const q of [threeNight,mixed,calculateWolfhouseQuote({...quoteInput,package_code:'manual_override',manual_price_per_night_cents:1},config)]){
   assert.equal(q.success,true);assert(q.deposit_required_cents<=q.total_cents);
   assert.equal(q.per_guest_deposits.reduce((s,g)=>s+g.deposit_cents,0),q.deposit_required_cents);
   assert(q.per_person.every(g=>g.deposit_cents>=0&&g.deposit_cents<=g.subtotal_cents));
   assert.equal(q.per_person.reduce((s,g)=>s+g.subtotal_cents,0),q.total_cents);
  }
  console.log('PASS unchanged three-night tier + mixed packages + cheap manual shares bounded');
  // Current configured autumn accommodation rate produces 80 EUR for two nights.
  const {buildWolfhouseBookingCreateCommand,BOOKING_CREATE_CHANNELS}=require('./lib/luna-front-desk-accommodation-booking-create-service');
  for(const count of [1,2,3]){
   const body={confirm:true,guest_name:'Offline',phone:'offline',check_in:'2026-10-14',check_out:'2026-10-16',guest_count:count,guests:Array.from({length:count},(_,i)=>({name:'Offline '+(i+1)})),package_code:'package_none',room_type:'shared',selected_bed_codes:Array.from({length:count},(_,i)=>'R'+count+'-'+(i+1)),payment_choice:'stripe_full'};
   const built=await buildWolfhouseBookingCreateCommand({channel:BOOKING_CREATE_CHANNELS.MANUAL_STAFF,trustedClientSlug:'wolfhouse-somo',actorHints:{staff_role:'owner',staff_user_id:'offline-staff'},transportBody:body,quoteConfig:config});
   assert.equal(built.ok,true,JSON.stringify(built));
   const quote=built.command.quote;
   assert.equal(quote.payment_link_amount_cents,8000*count);
   // Caller-supplied discounts are not commercial authority in this owner.
   const discounted=await buildWolfhouseBookingCreateCommand({channel:BOOKING_CREATE_CHANNELS.MANUAL_STAFF,trustedClientSlug:'wolfhouse-somo',transportBody:{...body,discount_cents:1},quoteConfig:config});
   assert.equal(discounted.ok,false);assert.equal(discounted.body.reason_code,'client_money_rejected');
   if(count>1){
    const bot=await buildWolfhouseBookingCreateCommand({channel:BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,trustedClientSlug:'wolfhouse-somo',transportBody:{...body,payment_choice:'full'},quoteConfig:config});
    assert.equal(bot.ok,true,JSON.stringify(bot));assert.equal(bot.command.sqlDepositCents,8000*count);assert.equal(bot.command.paymentLinkAmountCents,8000*count);
   }
   assert.equal(quote.success,true); assert.equal(quote.total_cents,8000*count);
   await db.query('INSERT INTO rooms(id,client_id,room_code,capacity) VALUES($1,$2,$3,$4)',[id(10+count),C,'R'+count,count]);
   const beds=[];
   for(let n=1;n<=count;n++){const code='R'+count+'-'+n;beds.push(code);await db.query('INSERT INTO beds(id,client_id,room_id,bed_code) VALUES($1,$2,$3,$4)',[id(100+count*10+n),C,id(10+count),code]);}
   if(count===1){
    const bot=await buildWolfhouseBookingCreateCommand({channel:BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,trustedClientSlug:'wolfhouse-somo',transportBody:{...body,payment_choice:'full'},quoteConfig:config,pgClient:pg});
    assert.equal(bot.ok,true,JSON.stringify(bot));assert.equal(bot.command.sqlDepositCents,8000);assert.equal(bot.command.paymentLinkAmountCents,8000);
   }
   await pg.query('BEGIN');
   try{
    const args=['wolfhouse-somo','offline-staff','owner','short-'+count,'SHORT'+count,'Offline','offline',null,'en','2026-10-14','2026-10-16',count,beds,'no_package','shared','confirmed','waiting_payment',quote.deposit_required_cents,quote.total_cents,'staff_manual','offline proof',null,true,true];
    // Hostile create amounts stay blocked; never relax the SQL overcharge guard.
    for(const deposit of [-1,quote.total_cents+1]){
     const hostile=args.slice();hostile[3]+='hostile'+deposit;hostile[17]=deposit;
     const rejected=(await pg.query(buildManualBookingCreateSql(),hostile)).rows[0];
     assert.equal(rejected.block_reason,'invalid_payment_amounts');assert.equal(rejected.booking_id,null);
    }
    const row=(await pg.query(buildManualBookingCreateSql(),args)).rows[0];
    assert.equal(row.is_blocked,false,JSON.stringify(row));
    assert.equal(quote.deposit_required_cents,quote.total_cents);
    // The shared create service writes commercial truth after the generic create
    // CTE. Exercise its literal SQL, not a hand-built substitute schema/path.
    const createSource=fs.readFileSync(path.join(__dirname,'lib/luna-front-desk-accommodation-booking-create-service.js'),'utf8');
    const moneySql=createSource.match(/`(UPDATE bookings\s+SET total_amount_cents[\s\S]*?)`/)[1];
    await pg.query(moneySql,[quote.total_cents,quote.deposit_required_cents,quote.balance_due_cents,'shared',JSON.stringify({quote}),row.booking_id,'wolfhouse-somo']);
    const breakdown=buildPerPersonBreakdown(quote,{payment_choice:'deposit'});
    assert(breakdown.every(g=>g.deposit_cents===8000));
    const guests=await insertBookingGuestsForBooking(pg,{clientId:C,bookingId:row.booking_id,guests:breakdown.map(g=>({guest_number:g.guest_number,guest_name:'Offline '+g.guest_number})),perPersonBreakdown:breakdown});
    await pg.query('SAVEPOINT full_link_proof');
    const full=await manualBookingApplyStaffPaymentChoice(pg,{staffPaymentChoice:'stripe_full',bookingGuests:guests,bookingId:row.booking_id,bookingCode:row.booking_code,clientSlug:'wolfhouse-somo',depositCents:quote.deposit_required_cents,totalCents:quote.total_cents,idempotencyKey:'full-'+count,stripeConfig});
    assert.equal(full.amount_due_cents,8000*count);
    await pg.query('ROLLBACK TO SAVEPOINT full_link_proof');
    const outcome=await manualBookingApplyStaffPaymentChoice(pg,{staffPaymentChoice:'stripe_deposit_per_guest',bookingGuests:guests,bookingId:row.booking_id,bookingCode:row.booking_code,clientSlug:'wolfhouse-somo',depositCents:quote.deposit_required_cents,totalCents:quote.total_cents,idempotencyKey:'short-'+count,stripeConfig});
    assert.equal(outcome.amount_due_cents,8000*count);
    assert(outcome.per_guest_links.every(g=>g.amount_due_cents===8000));
    await pg.query('COMMIT');
    console.log('PASS quote -> real create SQL -> guest persistence -> synthetic provider link',count);
    const pending=sessions.find(s=>s.payload.metadata.booking_id===row.booking_id && s.payload.metadata.booking_guest_id);
    const receipt={...pending,payment_status:'paid',status:'complete',currency:'eur',amount_total:8000,payment_intent:'pi_synthetic_'+count,metadata:pending.payload.metadata};
    const pendingSnapshot=async()=>({
     payments:(await pg.query('SELECT * FROM payments WHERE booking_id=$1 ORDER BY id',[row.booking_id])).rows,
     guests:(await pg.query('SELECT * FROM booking_guests WHERE booking_id=$1 ORDER BY id',[row.booking_id])).rows,
     booking:(await pg.query('SELECT * FROM bookings WHERE id=$1',[row.booking_id])).rows,
    });
    const before=await pendingSnapshot();
    for(const mutation of [{amount_total:0},{amount_total:-1},{amount_total:8001},{currency:'usd'},{payment_status:'unpaid'},{id:'cs_replaced',metadata:{payment_id:pending.payload.metadata.payment_id,client_slug:'wolfhouse-somo'}}]){
     const rejected=await reconcilePaidStripeSession(pg,{...receipt,...mutation},meta);
     assert.notEqual(rejected.reconciled,true);assert.deepEqual(await pendingSnapshot(),before);
    }
    const scoped=await reconcilePaidStripeSession(pg,receipt,{expectedClientSlug:'another-tenant'});
    assert.notEqual(scoped.reconciled,true);assert.deepEqual(await pendingSnapshot(),before);
    // Fail after payment and booking updates: the enclosing transaction must
    // roll back all projections rather than leave the receipt half applied.
    const failingPg={async query(sql,args){if(/^\s*UPDATE booking_guests/.test(sql))throw Error('offline injected projection failure');return pg.query(sql,args);}};
    await assert.rejects(reconcilePaidStripeSession(failingPg,receipt,meta),/offline injected projection failure/);
    assert.deepEqual(await pendingSnapshot(),before);
    assert.equal((await reconcilePaidStripeSession(pg,receipt,meta)).reconciled,true);
    const after=await pendingSnapshot();
    assert.equal(after.booking[0].amount_paid_cents,8000);assert.equal(after.booking[0].balance_due_cents,8000*(count-1));if(count>1)assert.notEqual(after.booking[0].payment_status,'paid');else assert.equal(after.booking[0].payment_status,'paid');
    assert.equal((await reconcilePaidStripeSession(pg,receipt,{...meta,eventId:'evt_distinct_duplicate'})).reason,'already_paid');
    assert.equal((await pendingSnapshot()).booking[0].amount_paid_cents,8000);
    // Duplicate receipt repairs a stale guest projection from the ledger, never
    // increments it. This executes the second formerly malformed SQL branch.
    await pg.query('UPDATE booking_guests SET amount_paid_cents=0 WHERE id=$1',[receipt.metadata.booking_guest_id]);
    assert.equal((await reconcilePaidStripeSession(pg,receipt,meta)).reason,'already_paid');
    const repaired=await pendingSnapshot();
    assert.deepEqual(repaired.payments,after.payments);assert.deepEqual(repaired.booking,after.booking);
    // Stored session binding is authoritative over redundant metadata; only
    // replaced sessions are hostile on this already-paid path.
    for(const mutation of [{id:'cs_replaced'}]){
     const rejected=await reconcilePaidStripeSession(pg,{...receipt,...mutation},meta);
     assert.notEqual(rejected.reason,'already_paid');assert.deepEqual(await pendingSnapshot(),repaired);
    }
    assert.equal((await pg.query('SELECT amount_paid_cents FROM booking_guests WHERE id=$1',[receipt.metadata.booking_guest_id])).rows[0].amount_paid_cents,8000);
    console.log('PASS hostile receipt amounts/currency/session/tenant + rollback + distinct duplicate + projection repair',count);
   }catch(e){await pg.query('ROLLBACK');throw e;}
  }
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
