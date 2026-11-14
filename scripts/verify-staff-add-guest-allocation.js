'use strict';
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { seedOfflineBookingDb } = require('./verify-luna-create-booking-occupants');
const { actualApiFunction } = require('./verify-package-minimum-transport');
const tenant = require('./lib/staff-bot-request-tenant-bind');
const { addGuestWithAllocation } = require('./lib/staff-bot-add-guest');
const { bookingLedgerInvoicePaidBalance } = require('./lib/booking-invoice-totals');
const checkout = require('./lib/per-guest-checkout');
const { amountFor } = checkout;
const fs = require('node:fs'), path = require('node:path');
const paymentTarget = process.argv.includes('--full-share') ? 'full_share' : 'deposit';
const pricingFault = process.argv.find(arg => arg.startsWith('--pricing-fault='))?.split('=')[1] || null;
assert.ok([null, 'missing-seasons', 'overlay-42703'].includes(pricingFault), 'known pricing fault only');
let networkAttempts = 0;
const deny = () => { networkAttempts++; throw new Error('network forbidden'); };
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
for (const mod of ['node:http','node:https']) { require(mod).request=deny; require(mod).get=deny; }
globalThis.fetch=deny;
const PHONE = '+99900001308';
const CODE = 'WH-OFFLINE-ADD';
process.env.OPEN_DEMO_BOOKING_WRITES_ENABLED = 'true';
(async () => {
 const db = new PGlite();
 try {
  await seedOfflineBookingDb(db,{phone:PHONE,guest_name:'Alex'});
  await require('./verify-staff-add-guest-admission').seedAdmissionPolicy(db);
  await db.exec(`ALTER TABLE payments ADD COLUMN amount_paid_cents integer DEFAULT 0;
   ALTER TABLE bookings ADD COLUMN amount_paid_cents integer DEFAULT 0;
   ALTER TABLE wh_pricing_rules ADD COLUMN IF NOT EXISTS per_night_cents integer;
   UPDATE rooms SET room_type='mixed',gender_strategy='Flexible',capacity=2,selling_mode='shared',
    can_be_matrimonial=false,often_used_by_operator=false WHERE room_code='R1';
   UPDATE beds SET active=(bed_number<=2 AND room_id=(SELECT id FROM rooms WHERE room_code='R1'));`);
  await db.query(`INSERT INTO bookings(client_id,booking_code,guest_name,phone,guest_count,check_in,check_out,
   status,payment_status,assignment_status,package_code,total_amount_cents,deposit_required_cents,balance_due_cents,metadata)
   SELECT id,$1,'Alex',$2,1,'2027-09-20','2027-09-26','confirmed','not_requested','assigned','malibu',29900,20000,29900,
   '{"location_id":"wolfhouse-somo","quote_snapshot":{"total_cents":29900,"line_items":[{"code":"guest_package","total_cents":29900}]}}'::jsonb
   FROM clients WHERE slug='wolfhouse-somo'`,[CODE,PHONE]);
  await db.exec(`INSERT INTO booking_guests(client_id,booking_id,guest_number,guest_name,assigned_bed_code,assigned_room_code,
    deposit_amount_cents,amount_paid_cents,payment_status,metadata)
   SELECT client_id,id,1,'Alex','R1-B1','R1',20000,0,'not_requested','{"subtotal_cents":29900}' FROM bookings;
   INSERT INTO booking_beds(client_id,booking_id,bed_id,bed_code,room_code,assignment_start_date,assignment_end_date,assignment_type)
   SELECT b.client_id,b.id,bd.id,bd.bed_code,'R1',b.check_in,b.check_out,'Auto Assigned' FROM bookings b
    JOIN beds bd ON bd.client_id=b.client_id AND bd.bed_code='R1-B1';
   INSERT INTO payments(client_id,booking_id,payment_kind,status,currency,amount_due_cents,amount_paid_cents,metadata)
   SELECT client_id,id,'full_amount','draft','EUR',29900,0,'{"source":"bot_booking_stage854","quote_total_cents":29900}' FROM bookings;`);
  await db.exec(`ALTER TYPE payment_record_status ADD VALUE IF NOT EXISTS 'checkout_created';
   ALTER TYPE payment_record_status ADD VALUE IF NOT EXISTS 'paid';
   ALTER TYPE payment_record_status ADD VALUE IF NOT EXISTS 'expired';
   ALTER TABLE payments ADD COLUMN stripe_checkout_session_id text;
   ALTER TABLE payments ADD COLUMN checkout_url text;
   ALTER TABLE payments ADD COLUMN expires_at timestamptz;`);
  await db.exec(fs.readFileSync(path.join(__dirname,'../database/migrations/107_per_guest_checkout_authoritative_intent.sql'),'utf8'));
  const initialPayment = (await db.query('SELECT * FROM payments')).rows;
  const initialGuest = (await db.query('SELECT * FROM booking_guests')).rows[0];
  const initialBed = (await db.query('SELECT * FROM booking_beds')).rows[0];
  // Real missing authority / PostgreSQL schema error, not a thrown SQL double.
  if (pricingFault === 'missing-seasons') await db.exec('UPDATE wh_pricing_seasons SET active=false');
  if (pricingFault === 'overlay-42703') await db.exec('ALTER TABLE wh_pricing_rules DROP COLUMN per_night_cents');
  const calls = [], sqlErrors = [];
  const pg = {async query(sql, params) {
    calls.push(String(sql).trim());
    try {const out = await db.query(sql, params);return {...out,rowCount:out.affectedRows??out.rows.length};}
    catch(error) {sqlErrors.push(error.code);throw error;}
  }};
  let body = {booking_code:CODE,guest_name:'Sam',idempotency_key:'add-sam-1'};
  const handler = actualApiFunction('handleBotBookingAddGuest',{
   ...tenant, addGuestWithAllocation, DEFAULT_CLIENT:'wolfhouse-somo',BOT_BOOKING_ENABLED:true,STAFF_ACTIONS_ENABLED:true,
   readBody: async()=>JSON.stringify(body),withPgClient:fn=>fn(pg),
   sendJSON:(_res,status,body)=>({status,body}),send400:(_res,error)=>({status:400,body:{error}}),
  });
  const call = (phone=PHONE,slug='wolfhouse-somo') => handler({_botBoundClientSlug:slug,headers:phone?{'x-luna-guest-phone':phone}:{}},{},null,'bot_token');
  assert.equal((await call(null)).status,403);
  assert.equal((await call('+99900001309')).status,404);
  assert.equal((await call(PHONE,'sunset-somo')).status,404);
  calls.length = 0;
  const result = await call();
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.body.success,true);
  assert.equal(calls.at(-1),'COMMIT', 'guest addition committed before receipt assertions');
  assert.equal(calls.includes('ROLLBACK'),false);
  assert.equal(result.body.next_action,pricingFault ? 'review_guest_price' : 'ask_deposit_or_full');
  assert.equal(result.body.guest_number,2);
  assert.equal(result.body.assigned_bed_code,'R1-B2');
  const saved = (await db.query('SELECT * FROM bookings WHERE booking_code=$1',[CODE])).rows[0];
  const guests = (await db.query('SELECT * FROM booking_guests ORDER BY guest_number')).rows;
  const beds = (await db.query('SELECT * FROM booking_beds ORDER BY bed_code')).rows;
  assert.equal(saved.guest_count,2); assert.equal(guests.length,2); assert.equal(beds.length,2);
  assert.equal(guests[1].id,result.body.booking_guest_id);
  assert.equal(guests[1].assigned_bed_code,'R1-B2');
  assert.deepEqual(guests[0],initialGuest,'original guest is untouched');
  assert.deepEqual(beds[0],initialBed,'original bed is untouched');
  if (pricingFault) {
    assert.equal(saved.total_amount_cents,29900,'unknown addition cannot invent a new total');
    assert.equal(saved.balance_due_cents,29900);
    assert.equal(result.body.added_guest_total_cents,null);
    assert.equal(result.body.price_needs_staff_review,true);
    assert.equal(saved.metadata.add_guest_price_needs_staff_review,true);
    assert.equal(guests[1].metadata.add_guest_price_needs_staff_review,true);
    assert.ok(saved.metadata.add_guest_price_review_reason);
    assert.equal(Object.hasOwn(guests[1].metadata,'subtotal_cents'),false,'unknown share is not free/zero');
    assert.equal(result.body.payment_link_created,false);
    assert.equal(result.body.payment_choice,null);
    if (pricingFault === 'overlay-42703') {
      assert.ok(sqlErrors.includes('42703'),'real overlay SQL produced undefined_column');
      assert.ok(calls.some(sql => sql.startsWith('ROLLBACK TO SAVEPOINT')),'aborted SQL state isolated');
    }
    const snapshot = async () => ({
      booking:(await db.query('SELECT * FROM bookings ORDER BY id')).rows,
      guests:(await db.query('SELECT * FROM booking_guests ORDER BY id')).rows,
      beds:(await db.query('SELECT * FROM booking_beds ORDER BY id')).rows,
      payments:(await db.query('SELECT * FROM payments ORDER BY id')).rows,
    });
    const beforeRetry = await snapshot();
    const replay = await call();
    assert.equal(replay.body.idempotent,true);
    assert.equal(replay.body.booking_guest_id,guests[1].id);
    assert.deepEqual(await snapshot(),beforeRetry,'unknown-price retry changes no saved rows');
    let providerCalls = 0;
    const denyProvider = async () => {providerCalls++;throw Error('unknown price must not reach Stripe');};
    for (const target of ['deposit','full_share']) {
      await assert.rejects(checkout.run({
        stripe:{checkout:{sessions:{create:denyProvider,retrieve:denyProvider,expire:denyProvider}}},
        guestId:guests[1].id,clientSlug:'wolfhouse-somo',paymentTarget:target,
        withPgClient:fn=>fn(pg),actorId:'OFFLINE',trustedGuestPhone:PHONE,
        successUrl:'https://invalid.test/ok',cancelUrl:'https://invalid.test/cancel',
      }), /authoritative_guest_money_unavailable/);
    }
    assert.equal(providerCalls,0);
    assert.deepEqual((await db.query('SELECT * FROM payments')).rows,initialPayment,'no draft, link or guessed charge');
    assert.deepEqual(await snapshot(),beforeRetry,'refused checkout leaves committed guests/beds intact');
    assert.equal(networkAttempts,0);
    console.log(`PASS add-guest ${pricingFault}: committed guest + bed, unknown price flagged, original rows intact, idempotent replay, both checkouts refused (0 provider/network calls)`);
    return;
  }
  assert.ok(guests[1].metadata.subtotal_cents>0,'invoice price for added guest persisted');
  assert.equal(saved.total_amount_cents,29900+guests[1].metadata.subtotal_cents);
  const invoice=bookingLedgerInvoicePaidBalance(saved,0,29900,0,0);
  assert.equal(invoice.invoice_total_cents,saved.total_amount_cents,'existing invoice owner includes new guest');
  assert.deepEqual((await db.query('SELECT * FROM payments')).rows,initialPayment,'no draft/link or group-charge refresh before amount choice');
  const guestMoney={...guests[1],guest_metadata:guests[1].metadata};
  assert.equal(amountFor(guestMoney,'deposit'),guests[1].deposit_amount_cents);
  assert.equal(amountFor(guestMoney,'full'),guests[1].metadata.subtotal_cents);
  const retry=await call();
  assert.equal(retry.body.booking_guest_id,result.body.booking_guest_id);
  assert.equal(retry.body.idempotent,true);
  body={...body,guest_name:'Other'};
  assert.equal((await call()).status,409,'different guest cannot replay the same operation');
  body={booking_code:CODE,guest_name:'No Room',idempotency_key:'add-no-room'};
  assert.equal((await call()).status,409,'no free bed must fail closed');
  assert.equal((await db.query('SELECT count(*)::int n FROM booking_guests')).rows[0].n,2);
  assert.equal((await db.query('SELECT count(*)::int n FROM booking_beds')).rows[0].n,2);
  // Real SQL checkout owner; only the external Stripe SDK is an explicit offline fixture.
  let providerCreates=0;
  const session={id:'cs_offline_added_guest',url:'https://checkout.stripe.com/c/pay/cs_offline_added_guest',
    status:'open',payment_status:'unpaid',expires_at:Math.floor(Date.now()/1000)+3600};
  const stripe={checkout:{sessions:{
    async create(params){providerCreates++;assert.equal(params.line_items[0].price_data.unit_amount,
      amountFor(guestMoney,paymentTarget));return session;},
    async retrieve(id){assert.equal(id,session.id);return session;},
    async expire(){throw Error('unexpected provider expiry');}
  }}};
  const options={stripe,guestId:guests[1].id,clientSlug:'wolfhouse-somo',paymentTarget,
    withPgClient:fn=>fn(pg),actorId:'OFFLINE',trustedGuestPhone:PHONE,
    successUrl:'https://invalid.test/ok',cancelUrl:'https://invalid.test/cancel'};
  const linked=await checkout.run(options),linkedAgain=await checkout.run(options);
  assert.equal(linked.amount,amountFor(guestMoney,paymentTarget));
  assert.equal(linked.paymentId,linkedAgain.paymentId);
  assert.equal(providerCreates,1,'one provider creation despite retry');
  assert.equal((await db.query('SELECT count(*)::int n FROM payments WHERE booking_guest_id=$1',[guests[1].id])).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM payments WHERE booking_guest_id=$1',[guests[0].id])).rows[0].n,0);
  assert.deepEqual((await db.query('SELECT * FROM payments WHERE booking_guest_id IS NULL')).rows,initialPayment,
    'adding a personal checkout never grows the existing original-guest draft');
  assert.equal(networkAttempts,0);
  console.log('PASS added guest personal checkout '+paymentTarget+': real SQL, one provider fixture create, retry same payment');
  console.log('PASS Staff add guest: real allocator + guest/bed/invoice SQL, identity/tenant denial, idempotency, capacity, isolated payment choice (0 network calls)');
 } finally {await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
