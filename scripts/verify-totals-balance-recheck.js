'use strict';
// Focused real-SQL balance-target interleaving proof; no live provider/DB/network.
// Simplified supporting schema. PGlite is not a multi-session PostgreSQL lock proof.
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const service = require('./lib/luna-front-desk-payment-link-service');
let attempts = 0;
function deny(){ attempts++; throw Error('Offline only'); }
global.fetch=deny;require('node:http').request=deny;require('node:https').request=deny;require('node:net').Socket.prototype.connect=deny;
const B='10000000-0000-4000-8000-000000000001';
(async()=>{
 const db=new PGlite();
 try {
  await db.exec(`
   CREATE TYPE payment_record_status AS ENUM ('draft','checkout_created','paid','failed','expired','cancelled','pending');
   CREATE TYPE payment_kind AS ENUM ('deposit_only','full_amount');
   CREATE TABLE clients(id text PRIMARY KEY,slug text UNIQUE);
   CREATE TABLE bookings(id uuid PRIMARY KEY,client_id text,booking_code text,guest_name text,status text,payment_status text,
    check_in date,check_out date,guest_count int,total_amount_cents int,amount_paid_cents int,balance_due_cents int,deposit_required_cents int,metadata jsonb DEFAULT '{}');
   CREATE TABLE payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),client_id text,booking_id uuid,booking_guest_id uuid,
    status payment_record_status,payment_kind payment_kind,currency text,amount_due_cents int,amount_paid_cents int DEFAULT 0,
    checkout_url text,stripe_checkout_session_id text,expires_at timestamptz,metadata jsonb DEFAULT '{}',created_at timestamptz DEFAULT now());
   INSERT INTO clients VALUES('wh','wolfhouse-somo');
   INSERT INTO bookings(id,client_id,booking_code,guest_name,status,total_amount_cents,amount_paid_cents,balance_due_cents,deposit_required_cents)
    VALUES('${B}','wh','BALANCE-SAFETY','Synthetic','confirmed',60000,0,60000,18000);
  `);
  const command=service.buildPaymentLinkCommand({operation:service.PAYMENT_LINK_OPERATIONS.CREATE,channel:service.PAYMENT_LINK_CHANNELS.STAFF_PORTAL,
   trustedClientSlug:'wolfhouse-somo',authoritativeBalanceDueCents:60000,transportBody:{booking_id:B,payment_target:'balance',idempotency_key:'balance-race'}}).command;
  let providerCalls=0;
  const options={staffActionsEnabled:true,stripeLinksEnabled:true,secretKey:'synthetic',successUrl:'https://example.invalid/ok',cancelUrl:'https://example.invalid/cancel',
   loadBookingPaymentLedger:async(pg,booking)=>{
    const r=await pg.query("SELECT COALESCE(sum(amount_paid_cents),0)::int AS paid FROM payments WHERE booking_id=$1 AND status='paid'",[booking.booking_id]);
    return {invoice_total_cents:Number(booking.total_amount_cents),paid_total_cents:r.rows[0].paid,balance_due_cents:Math.max(0,Number(booking.total_amount_cents)-r.rows[0].paid),needs_refund:r.rows[0].paid>Number(booking.total_amount_cents)};
   },
   createStripeCheckoutSession:async()=>{
    providerCalls++;
    await db.query("INSERT INTO payments(client_id,booking_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents) VALUES('wh',$1,'paid','full_amount','EUR',10000,10000)",[B]);
    return {id:'cs_synthetic',url:'https://example.invalid/stale-balance',livemode:false};
   }
  };
  const result=await service.createPaymentLink(db,command,options);
  assert.equal(result.ok,false,'Balance must not return a stale full-amount URL after an intervening receipt');
  assert.equal(result.status,409);
  assert.equal(result.body.reason_code,'checkout_state_changed');
  assert.equal(result.body.checkout_url,undefined);
  assert.equal(result.body.payment_link_url,undefined);
  assert.equal(providerCalls,1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM payments WHERE status='checkout_created'")).rows[0].n,0);
  assert.equal((await db.query("SELECT sum(amount_paid_cents)::int AS paid FROM payments WHERE status='paid'")).rows[0].paid,10000);
  await db.exec('DELETE FROM payments; UPDATE bookings SET deposit_required_cents=NULL');
  const successOptions={...options,createStripeCheckoutSession:async()=>{providerCalls++;return {id:'cs_synthetic_balance',url:'https://example.invalid/current-balance',livemode:false};}};
  const success=await service.createPaymentLink(db,command,successOptions);
  assert.equal(success.ok,true,'Balance does not require deposit configuration');
  assert.equal(success.body.amount_due_cents,60000);
  assert.equal(success.body.payment_target,'balance');
  const persisted=(await db.query("SELECT payment_kind::text AS kind,metadata->>'payment_target' AS target FROM payments WHERE status='checkout_created'")).rows;
  assert.deepEqual(persisted,[{kind:'full_amount',target:'balance'}]);
  await db.query("INSERT INTO payments(client_id,booking_id,status,payment_kind,currency,amount_due_cents,amount_paid_cents) VALUES('wh',$1,'paid','full_amount','EUR',10000,10000)",[B]);
  const retry=await service.createPaymentLink(db,command,successOptions);
  assert.equal(retry.status,409);assert.equal(retry.body.reason_code,'idempotency_conflict');
  assert.equal(retry.body.checkout_url,undefined);assert.equal(retry.body.payment_link_url,undefined);
  assert.equal(providerCalls,2,'Stale same-key balance retry must not create another checkout');
  assert.equal(attempts,0);
  console.log(JSON.stringify({passed:true,cases:['balance-finalize-rechecks-intervening-receipt','balance-without-deposit-configuration','balance-reuse-rechecks-current-amount'],providerCalls,networkAttempts:attempts}));
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
