'use strict';

const assert = require('assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const create = require('./lib/luna-front-desk-accommodation-booking-create-service');
const owed = require('./lib/staff-booking-confirmation-owed');
const { markBookingConfirmationSent } = require('./lib/luna-booking-confirmation-send');
const { buildWolfhousePaidConfirmationCopy } = require('./lib/luna-guest-confirmation-copy-style');
const { persistCrowsnestSyntheticConfirmationThreadMessage, receiptCrowsnestSyntheticConfirmationThreadMessage } = require('./lib/luna-staff-inbox-thread-message');

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER_CLIENT = '11111111-1111-4111-8111-111111111112';
const BOOKING = '22222222-2222-4222-8222-222222222222';
const OTHER_BOOKING = '22222222-2222-4222-8222-222222222223';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const OTHER_CONVERSATION = '33333333-3333-4333-8333-333333333334';

async function setup() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE TABLE bookings (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), booking_code text,
      status text DEFAULT 'confirmed', check_in date, check_out date, guest_name text, guest_count int, package_code text,
      confirmation_sent_at timestamptz, metadata jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE booking_guests (booking_id uuid, guest_number int, guest_name text, assigned_room_code text, assigned_bed_code text);
    CREATE TABLE rooms (client_id uuid, room_code text, name text, room_type text);
    CREATE TABLE booking_beds (booking_id uuid, client_id uuid, bed_code text, room_code text, created_at timestamptz DEFAULT now());
    CREATE TABLE booking_confirmation_owed (booking_id uuid PRIMARY KEY REFERENCES bookings(id), client_id uuid NOT NULL REFERENCES clients(id), owed_at timestamptz NOT NULL DEFAULT now(), provider_message_id text, cleared_at timestamptz, clear_reason text);
    CREATE TABLE booking_confirmation_delivery_events (provider_message_id text PRIMARY KEY, delivered_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE conversations (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id));
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL, conversation_id uuid NOT NULL,
      direction text, message_text text, message_type text, source text, whatsapp_message_id text, route text, metadata jsonb NOT NULL DEFAULT '{}');
    INSERT INTO clients VALUES ('${CLIENT}','wolfhouse-somo'),('${OTHER_CLIENT}','other-tenant');
    INSERT INTO bookings (id,client_id,booking_code,check_in,check_out,guest_name,guest_count,metadata) VALUES
      ('${BOOKING}','${CLIENT}','WH-1','2027-06-10','2027-06-12','Ada',2,
       '{"quote_snapshot":{"balance_due_timing":"seven days before arrival"},"balance_due_timing":"stale fallback"}'),
      ('${OTHER_BOOKING}','${OTHER_CLIENT}','OT-1','2027-07-01','2027-07-02','Mallory',1,'{}');
    INSERT INTO booking_guests VALUES ('${BOOKING}',1,'Ada','R1','R1-B1'),('${BOOKING}',2,'Grace','R2','R2-B1');
    INSERT INTO rooms VALUES ('${CLIENT}','R1',NULL,'mixed dorm'),('${CLIENT}','R2','Ocean Room','private');
    INSERT INTO booking_beds VALUES ('${BOOKING}','${CLIENT}','R1-B1','R1',now()),('${BOOKING}','${CLIENT}','R2-B1','R2',now());
    INSERT INTO conversations VALUES ('${CONVERSATION}','${CLIENT}'),('${OTHER_CONVERSATION}','${OTHER_CLIENT}');
  `);
  return pg;
}
async function obligation(pg, id = BOOKING) { return (await pg.query('SELECT provider_message_id,cleared_at,clear_reason FROM booking_confirmation_owed WHERE booking_id=$1',[id])).rows[0]; }
async function reset(pg) { await pg.exec(`UPDATE bookings SET confirmation_sent_at=NULL, metadata=CASE WHEN id='${BOOKING}' THEN '{"quote_snapshot":{"balance_due_timing":"seven days before arrival"},"balance_due_timing":"stale fallback"}'::jsonb ELSE '{}'::jsonb END; DELETE FROM booking_confirmation_owed; DELETE FROM booking_confirmation_delivery_events;`); }
async function owe(pg,id=BOOKING,client=CLIENT) { await owed.recordConfirmationOwed(pg,{booking_id:id,client_id:client}); }

async function main() {
  const pg = await setup();

  // Authoritative persisted receipt retrieval, then the production receipt projector and confirmation copy owner.
  const saved = await create.lookupSavedWolfhouseCreateById(pg, 'wolfhouse-somo', BOOKING);
  const receipt = create.savedWolfhouseCreateResult(saved).body;
  assert.deepEqual(receipt.guest_rooms.map(x => ({ guest_name:x.guest_name, room_label:x.room_label, type:x.type, number:x.number })), [
    { guest_name:'Ada', room_label:'R1', type:'mixed dorm', number:'R1' },
    { guest_name:'Grace', room_label:'Ocean Room', type:'private', number:'R2' },
  ]);
  assert.equal(receipt.balance_due_timing, 'seven days before arrival'); // accepted Pricing snapshot outranks stale metadata fallback
  assert.equal(receipt.balance_due_at, '2027-06-03');
  const confirmationInput = { guest_name:'Ada', booking_code:receipt.booking_code, check_in:receipt.check_in,
    check_out:receipt.check_out, guest_rooms:receipt.guest_rooms, balance_due_timing:receipt.balance_due_timing,
    balance_due_at:receipt.balance_due_at, amount_paid_cents:1000, total_amount_cents:2000, language:'en' };
  buildWolfhousePaidConfirmationCopy(confirmationInput); // execute existing model-owned confirmation input owner
  assert.deepEqual(confirmationInput.guest_rooms, receipt.guest_rooms);
  assert.equal(confirmationInput.balance_due_at, receipt.balance_due_at);

  // Provider matrix: accepted/undelivered, failed, unrelated provider, delivered-after-accept, duplicate.
  await owe(pg); await markBookingConfirmationSent(pg,{client_slug:'wolfhouse-somo',booking_id:BOOKING,provider_message_id:'wamid.after'});
  assert.equal((await obligation(pg)).cleared_at,null);
  assert.equal((await owed.clearConfirmationOwedOnDelivery(pg,{provider_message_id:'wamid.after',delivery_status:'failed'})).cleared,false);
  assert.equal((await owed.clearConfirmationOwedOnDelivery(pg,{provider_message_id:'wamid.unrelated',delivery_status:'delivered'})).cleared,false);
  assert.equal((await owed.clearConfirmationOwedOnDelivery(pg,{provider_message_id:'wamid.after',delivery_status:'delivered'})).cleared,true);
  assert.equal((await owed.clearConfirmationOwedOnDelivery(pg,{provider_message_id:'wamid.after',delivery_status:'delivered'})).cleared,false);

  // Delivered-before-accept is stored and acceptance reconciles exactly once.
  await reset(pg); await owe(pg);
  assert.equal((await owed.clearConfirmationOwedOnDelivery(pg,{provider_message_id:'wamid.early',delivery_status:'delivered'})).cleared,false);
  const early = await owed.recordConfirmationAccepted(pg,{booking_id:BOOKING,provider_message_id:'wamid.early'});
  assert.equal(early.cleared,true); assert.equal((await obligation(pg)).clear_reason,'delivered');
  assert.equal((await owed.recordConfirmationAccepted(pg,{booking_id:BOOKING,provider_message_id:'wamid.early'})).cleared,false);

  // Real committed audit followed by an injected pg write failure; retry repairs linkage without formatting/sending.
  await reset(pg); await owe(pg); let failed=false; let queryCount=0;
  const flaky = { query: async (sql,args) => { queryCount++; if (!failed && String(sql).includes('SET provider_message_id')) { failed=true; const e=new Error('injected accepted-link write failure'); e.code='XX999'; throw e; } return pg.query(sql,args); } };
  await assert.rejects(markBookingConfirmationSent(flaky,{client_slug:'wolfhouse-somo',booking_id:BOOKING,provider_message_id:'wamid.retry'}),/injected/);
  assert.ok((await pg.query('SELECT confirmation_sent_at FROM bookings WHERE id=$1',[BOOKING])).rows[0].confirmation_sent_at);
  const beforeRetry=queryCount; const repaired=await markBookingConfirmationSent(flaky,{client_slug:'wolfhouse-somo',booking_id:BOOKING,provider_message_id:'wamid.retry'});
  assert.equal(repaired.already_sent,true); assert.equal((await obligation(pg)).provider_message_id,'wamid.retry'); assert.ok(queryCount>beforeRetry);

  // Simulator pending while disconnected; render receipt clears once and duplicate is a no-op.
  await reset(pg); await owe(pg);
  const mirrored=await persistCrowsnestSyntheticConfirmationThreadMessage(pg,{client_slug:'wolfhouse-somo',conversation_id:CONVERSATION,message_text:'model-owned copy',idempotency_key:'confirmation:auto:WH-1',booking_id:BOOKING});
  await markBookingConfirmationSent(pg,{client_slug:'wolfhouse-somo',booking_id:BOOKING,delivery_receipt_id:`simulator:${mirrored.message_id}`,confirmation_sent_via:'staff_inbox_simulator'});
  assert.equal((await obligation(pg)).cleared_at,null);
  const visible=await receiptCrowsnestSyntheticConfirmationThreadMessage(pg,{client_slug:'wolfhouse-somo',conversation_id:CONVERSATION,message_id:mirrored.message_id});
  assert.equal(visible.confirmation_owed_cleared,true);
  assert.equal((await receiptCrowsnestSyntheticConfirmationThreadMessage(pg,{client_slug:'wolfhouse-somo',conversation_id:CONVERSATION,message_id:mirrored.message_id})).changed,false);

  // A genuine other booking/tenant linkage cannot be cleared by this tenant receipt.
  await reset(pg); await owe(pg,OTHER_BOOKING,OTHER_CLIENT);
  const cross=await persistCrowsnestSyntheticConfirmationThreadMessage(pg,{client_slug:'wolfhouse-somo',conversation_id:CONVERSATION,message_text:'cross',idempotency_key:'cross',booking_id:OTHER_BOOKING});
  await owed.recordConfirmationAccepted(pg,{booking_id:OTHER_BOOKING,provider_message_id:`simulator:${cross.message_id}`});
  const denied=await receiptCrowsnestSyntheticConfirmationThreadMessage(pg,{client_slug:'wolfhouse-somo',conversation_id:CONVERSATION,message_id:cross.message_id});
  assert.equal(denied.confirmation_owed_cleared,false); assert.equal((await obligation(pg,OTHER_BOOKING)).cleared_at,null);

  // Wrong booking metadata, tenant, conversation, and source are denied/no-clear.
  await reset(pg); await owe(pg);
  const wrong=await persistCrowsnestSyntheticConfirmationThreadMessage(pg,{client_slug:'wolfhouse-somo',conversation_id:CONVERSATION,message_text:'wrong',idempotency_key:'wrong',booking_id:OTHER_BOOKING});
  await owed.recordConfirmationAccepted(pg,{booking_id:BOOKING,provider_message_id:`simulator:${wrong.message_id}`});
  assert.equal((await receiptCrowsnestSyntheticConfirmationThreadMessage(pg,{client_slug:'wolfhouse-somo',conversation_id:CONVERSATION,message_id:wrong.message_id})).confirmation_owed_cleared,false);
  for (const bad of [{client_slug:'other-tenant',conversation_id:CONVERSATION},{client_slug:'wolfhouse-somo',conversation_id:OTHER_CONVERSATION}]) {
    const r=await receiptCrowsnestSyntheticConfirmationThreadMessage(pg,{...bad,message_id:wrong.message_id}); assert.equal(r.ok,false);
  }
  const alien=(await pg.query(`INSERT INTO messages(client_id,conversation_id,direction,message_text,message_type,source,route,metadata) VALUES($1,$2,'outbound','alien','text','other_source','staff_portal',$3) RETURNING id::text AS id`,[CLIENT,CONVERSATION,JSON.stringify({booking_id:BOOKING})])).rows[0];
  assert.equal((await receiptCrowsnestSyntheticConfirmationThreadMessage(pg,{client_slug:'wolfhouse-somo',conversation_id:CONVERSATION,message_id:alien.id})).ok,false);
  assert.equal((await obligation(pg)).cleared_at,null);

  await pg.close(); console.log('verify-lunabot-fullpowers-slice1d: PASS');
}
main().catch(err=>{ console.error(err); process.exit(1); });
