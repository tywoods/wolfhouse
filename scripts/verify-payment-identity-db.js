'use strict';
// Actual production PostgreSQL SQL, ephemeral PGlite DB, synthetic identities only.
const assert = require('assert/strict');
const {PGlite} = require('@electric-sql/pglite');
const s = require('./lib/luna-payment-short-link');
(async()=>{
 const booking={id:'b',client_id:'c',booking_code:'WH-SYNTHETIC',status:'confirmed',balance_due_cents:100};
 const guest={id:'g',booking_id:'b',client_id:'c',guest_number:1};
 const payment={id:'p',booking_id:'b',client_id:'c',booking_guest_id:'g',status:'checkout_created',amount_due_cents:100,checkout_url:'https://checkout.stripe.com/test/identity',metadata:'{}',created_at:'2026-01-01'};
 const pg=new PGlite();
 try {
 await pg.exec('CREATE TABLE clients(id TEXT,slug TEXT); CREATE TABLE bookings(id TEXT,client_id TEXT,booking_code TEXT,status TEXT,payment_status TEXT,total_amount_cents INTEGER,amount_paid_cents INTEGER,balance_due_cents INTEGER); CREATE TABLE booking_guests(id TEXT,booking_id TEXT,client_id TEXT,guest_number INTEGER); CREATE TABLE payments(id TEXT,booking_id TEXT,client_id TEXT,booking_guest_id TEXT,status TEXT,amount_due_cents INTEGER,amount_paid_cents INTEGER,checkout_url TEXT,stripe_checkout_session_id TEXT,expires_at TEXT,metadata TEXT,created_at TEXT);');
 async function resolve(change={},input={},guestChange={}) {
  await pg.exec('TRUNCATE clients,bookings,booking_guests,payments');
  const tables={clients:[{id:'c',slug:'wolfhouse-somo'},{id:'other',slug:'other-tenant'}],bookings:[booking,{...booking,id:'other-b',client_id:'other',booking_code:'WH-OTHER'}],booking_guests:[{...guest,...guestChange}],payments:[{...payment,...change}]};
  for(const [table,rows] of Object.entries(tables)) for(const row of rows) {
   await pg.query(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
  }
  return s.resolvePaymentShortLinkRedirectFromDb(pg,{token:'WH-SYNTHETIC/g1',...input});
 }
 assert.equal((await resolve()).status,'redirect');
 assert.equal((await resolve({metadata:'{"guest_number":"1"}'})).status,'redirect');
 const hostile=[{metadata:'{"guest_number":2}'},{metadata:'{"guest_number":"1x"}'},{metadata:'{"guest_number":"01"}'},{metadata:'broken'},{booking_guest_id:null},{booking_guest_id:'missing'},{client_id:'other'},{booking_id:'other-b'}];
 for(const row of hostile) assert.notEqual((await resolve(row)).status,'redirect',JSON.stringify(row));
 for(const row of [{booking_id:'other-b'},{client_id:'other'},{guest_number:2}]) assert.notEqual((await resolve({}, {},row)).status,'redirect',JSON.stringify(row));
 assert.notEqual((await resolve({}, {client_slug:'other-tenant'})).status,'redirect');
 // Booking-wide collection must not require a guest allocation or metadata.
 assert.equal((await resolve({booking_guest_id:null},{token:'WH-SYNTHETIC'})).status,'redirect');
 booking.booking_code='MB-WOLFHO-20261005-aabbcc';
 assert.equal((await resolve({}, {token:'WH-20261005-aabbcc/g1'})).status,'redirect');
 assert.equal((await resolve({booking_guest_id:null}, {token:'WH-20261005-aabbcc'})).status,'redirect');
 booking.booking_code='WH-20261005-aabbcc';
 assert.equal((await resolve({}, {token:'MB-WOLFHO-20261005-aabbcc/g1'})).status,'redirect');
 console.log('PASS: production PostgreSQL SQL in PGlite: authoritative identity, redundant metadata, 12 hostile/mismatched rows/tenant inputs, booking-wide unallocated checkout, bidirectional booking-code aliases');
 } finally {await pg.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
