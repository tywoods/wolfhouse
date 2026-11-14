'use strict';
// Offline real SQL + exact production handler. No HTTP/provider calls.
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { actualApiFunction } = require('./verify-package-minimum-transport');
const lookup = require('./lib/luna-guest-booking-disambiguation');
const tenant = require('./lib/staff-bot-request-tenant-bind');
const PHONE = '+999****1308';
(async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE clients(id uuid PRIMARY KEY, slug text);
      CREATE TABLE bookings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid, booking_code text,
        phone text, check_in date DEFAULT '2027-09-20', check_out date DEFAULT '2027-09-26',
        status text DEFAULT 'confirmed', payment_status text DEFAULT 'not_requested', guest_count int DEFAULT 1, guest_name text);
      CREATE TABLE conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),client_id uuid,current_hold_booking_id uuid);
      CREATE TABLE booking_conversation_links(client_id uuid,conversation_id uuid,booking_id uuid);
      INSERT INTO clients VALUES ('00000000-0000-4000-8000-000000000001','wolfhouse-somo'),
        ('00000000-0000-4000-8000-000000000002','sunset-somo');`);
    const add = async (code, phone, slug, status) => db.query(`INSERT INTO bookings(client_id,booking_code,phone,payment_status)
      SELECT id,$1,$2,$4 FROM clients WHERE slug=$3`, [code,phone,slug,status]);
    await add('MASKED',PHONE,'wolfhouse-somo','not_requested');
    await add('OTHER','+34612345678','wolfhouse-somo','not_requested');
    await add('FOREIGN',PHONE,'sunset-somo','not_requested');
    await add('SUFFIX','+19991308','wolfhouse-somo','not_requested');
    let body = {phone: PHONE};
    const route = actualApiFunction('handleBotListBookingsByPhone', {
      ...lookup, ...tenant, DEFAULT_CLIENT:'wolfhouse-somo', SQL_INJECT_RE: /$a/,
      readBody: async () => JSON.stringify(body), withPgClient: fn => fn(db),
      sendJSON: (_res,status,body) => ({status,body}), send400: (_res,error) => ({status:400,body:{error}}),
    });
    const call = phone => route({_botBoundClientSlug:'wolfhouse-somo',headers:phone ? {'x-luna-guest-phone':phone} : {}},{},null,'bot_token');
    let result = await call(PHONE);
    assert.equal(result.status,200);
    assert.deepEqual(result.body.bookings.map(b=>b.booking_code),['MASKED'], 'same-chat masked phone must resolve exactly, never suffix/foreign identity');
    console.log('PASS masked phone tenant-scoped SQL readback');
    body = {phone:'+34612345678',client_slug:'sunset-somo'};
    result = await call(PHONE);
    assert.deepEqual(result.body.bookings.map(b=>b.booking_code),['MASKED'], 'model body must not override authenticated sender or tenant');
    assert.equal((await call(null)).status,403,'bot discovery requires trusted phone');
    await db.query("UPDATE bookings SET payment_status='payment_link_sent' WHERE booking_code='MASKED'");
    result = await call(PHONE);
    assert.deepEqual(result.body.bookings.map(b=>b.booking_code),['MASKED'],'just-saved link-sent booking remains discoverable');
    await db.query("UPDATE bookings SET phone='+34 612-345-678' WHERE booking_code='OTHER'");
    result = await call('+34612345678');
        assert.deepEqual(result.body.bookings.map(b=>b.booking_code),['OTHER'],'ordinary E164 formatting remains supported');
        await db.query("UPDATE bookings SET status='cancelled' WHERE booking_code='OTHER'");
        assert.equal((await call('+34612345678')).body.count,0);
    console.log('PASS lookup: 6 SQL/handler cases (mask, tenant/sender spoof, missing identity, link-sent, formatted phone, cancelled)');
  } finally { await db.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
