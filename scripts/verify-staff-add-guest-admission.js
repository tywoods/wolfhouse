'use strict';
const assert = require('node:assert/strict');
const { actualApiFunction } = require('./verify-package-minimum-transport');
const tenant = require('./lib/staff-bot-request-tenant-bind');
const PHONE = '+999****1308';
const body = {booking_code:'WH-ADMISSION',guest_name:'Sam',idempotency_key:'admission-sam'};
function handler(pg, enabled = true, onScope = () => {}) {
  return actualApiFunction('handleBotBookingAddGuest', {
    ...tenant, DEFAULT_CLIENT:'wolfhouse-somo', BOT_BOOKING_ENABLED:true,
    STAFF_ACTIONS_ENABLED:enabled,
    readBody:async()=>JSON.stringify(body),
    withPgClient:fn=>{onScope();return fn(pg);},
    sendJSON:(_res,status,body)=>({status,body}),
  });
}
const call = fn => fn({_botBoundClientSlug:'wolfhouse-somo',headers:{'x-luna-guest-phone':PHONE}},{},null,'bot_token');
async function main() {
  process.env.OPEN_DEMO_BOOKING_WRITES_ENABLED = 'true';
  let scopes = 0;
  const denied = await call(handler({query:async()=>({rows:[]})},false,()=>scopes++));
  assert.equal(denied.status,403,'disabled staff actions must reject add guest');
  assert.equal(denied.body.error,'staff_actions_disabled');
  assert.equal(denied.body.write_performed,false);
  assert.equal(scopes,0,'disabled actions must not acquire a database client');
  console.log('PASS add-guest disabled staff actions: 403, zero database work');
  const { PGlite } = require('@electric-sql/pglite');
  const { seedOfflineBookingDb } = require('./verify-luna-create-booking-occupants');
  let networkAttempts = 0;
  const denyNetwork = () => { networkAttempts++; throw Error('network forbidden'); };
  require('node:net').Socket.prototype.connect = denyNetwork;
  require('node:tls').connect = denyNetwork;
  for (const mod of ['node:http','node:https']) { require(mod).request=denyNetwork; require(mod).get=denyNetwork; }
  globalThis.fetch=denyNetwork;
  const db = new PGlite();
  try {
    await seedOfflineBookingDb(db,{phone:PHONE,guest_name:'Alex'});
    await seedAdmissionPolicy(db);
    await db.exec(`ALTER TABLE bookings ADD COLUMN amount_paid_cents integer DEFAULT 0;
      ALTER TABLE payments ADD COLUMN amount_paid_cents integer DEFAULT 0;
      ALTER TABLE wh_pricing_rules ADD COLUMN IF NOT EXISTS per_night_cents integer;
      UPDATE rooms SET room_type='mixed',gender_strategy='Flexible',capacity=2,selling_mode='shared',
        can_be_matrimonial=false,often_used_by_operator=false WHERE room_code='R1';
      UPDATE beds SET active=(bed_number<=2 AND room_id=(SELECT id FROM rooms WHERE room_code='R1'));
      INSERT INTO bookings(client_id,booking_code,guest_name,phone,guest_count,check_in,check_out,
        status,payment_status,assignment_status,package_code,total_amount_cents,deposit_required_cents,balance_due_cents,metadata)
      SELECT id,'WH-ADMISSION','Alex','+999****1308',1,'2027-09-20','2027-09-26',
        'confirmed','not_requested','assigned','malibu',29900,20000,29900,
        '{"location_id":"wolfhouse-somo","quote_snapshot":{"total_cents":29900}}' FROM clients;
      INSERT INTO booking_guests(client_id,booking_id,guest_number,guest_name,assigned_bed_code,assigned_room_code,
        deposit_amount_cents,amount_paid_cents,payment_status,metadata)
      SELECT client_id,id,1,'Alex','R1-B1','R1',20000,0,'not_requested','{"subtotal_cents":29900}' FROM bookings;
      INSERT INTO booking_beds(client_id,booking_id,bed_id,bed_code,room_code,assignment_start_date,assignment_end_date,assignment_type)
      SELECT b.client_id,b.id,bd.id,bd.bed_code,'R1',b.check_in,b.check_out,'Auto Assigned' FROM bookings b
        JOIN beds bd ON bd.client_id=b.client_id AND bd.bed_code='R1-B1';
      INSERT INTO payments(client_id,booking_id,payment_kind,status,currency,amount_due_cents,metadata)
      SELECT client_id,id,'full_amount','draft','EUR',29900,'{"source":"bot_booking_stage854"}' FROM bookings;`);
    const tables = ['bookings','booking_guests','booking_beds','payments','customers','workflow_events'];
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table =>
      [table,(await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows])));
    const sql = [];
    const pg = {query:async(text,params)=>{sql.push(String(text));return db.query(text,params);}};
    const cases = [
      ['off', `UPDATE clients SET settings='{"inbox_channel_modes":{"whatsapp":"off"}}'`,403,'booking_channel_off'],
      ['draft', `UPDATE clients SET settings='{"inbox_channel_modes":{"whatsapp":"draft"}}'`,403,'booking_channel_draft'],
      ['staff pause', `INSERT INTO bot_pause_states SELECT 'wolfhouse-somo',id::text,phone,true,'staff' FROM conversations`,403,'booking_conversation_paused'],
      ['global pause', `INSERT INTO bot_pause_states VALUES('wolfhouse-somo','__luna_global_pause__',NULL,true,'staff')`,403,'booking_global_paused'],
      ['staff reply', `UPDATE conversations SET last_staff_reply_at=now()`,403,'booking_needs_human'],
      ['needs human', `UPDATE conversations SET needs_human=true`,403,'booking_needs_human'],
      ['unconfigured', `UPDATE clients SET settings='{}'`,503,'booking_channel_unconfigured'],
      ['unbound', `UPDATE conversations SET phone='+999****9999'`,403,'booking_context_unbound'],
      ['unavailable', `ALTER TABLE bot_pause_states RENAME TO offline_unavailable_pauses`,503,'booking_policy_unavailable'],
    ];
    for (const [name,setup,status,error] of cases) {
      await db.exec(`UPDATE clients SET settings='{"inbox_channel_modes":{"whatsapp":"auto"}}';
        UPDATE conversations SET phone='+999****1308',needs_human=false,last_staff_reply_at=NULL;
        DELETE FROM bot_pause_states;`);
      await db.exec(setup);
      // Conversation fixture updates fire real CRM triggers; baseline only
      // after setup so this comparison measures the handler's effects.
      const before = await snapshot();
      sql.length=0;
      // Body-supplied identity must not override the authenticated guest phone.
      body.conversation_id='00000000-0000-4000-8000-000000000099';
      body.guest_phone='+999****9999';
      const result = await call(handler(pg));
      assert.equal(result.status,status,`${name}: ${JSON.stringify(result)}`);
      assert.equal(result.body.error,error,name);
      assert.equal(result.body.write_performed,false,name);
      assert.equal(sql[0],'BEGIN',`${name}: admission is transaction scoped`);
      assert.equal(sql.at(-1),'ROLLBACK',`${name}: admission denial rolls back`);
      assert.ok(sql.some(q=>q==='LOCK TABLE bot_pause_states IN SHARE MODE'),`${name}: existing policy owner locks pauses`);
      assert.ok(!sql.some(q=>/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|bookings|booking_guests|booking_beds|payments|FROM)\b/i.test(q)),`${name}: zero mutation statements`);
      assert.ok(!sql.some(q=>/FROM rooms|FROM beds|FROM wh_pricing_/i.test(q)),`${name}: zero allocation/pricing work`);
      assert.deepEqual(await snapshot(),before,`${name}: guests, beds, invoice, original payment, CRM and events unchanged`);
      console.log(`PASS add-guest admission ${name}: ${status} ${error}, real SQL, zero writes/allocation`);
    }
    assert.equal(networkAttempts,0);
  } finally { await db.close(); }
}
async function seedAdmissionPolicy(db) {
  await db.exec(`ALTER TABLE clients ADD COLUMN settings jsonb NOT NULL DEFAULT '{"inbox_channel_modes":{"whatsapp":"auto"}}';
    ALTER TABLE conversations ADD COLUMN needs_human boolean NOT NULL DEFAULT false;
    ALTER TABLE conversations ADD COLUMN last_staff_reply_at timestamptz;
    CREATE TABLE bot_pause_states(client_slug text,conversation_id text,guest_phone text,paused boolean,paused_by text);`);
}
module.exports = { seedAdmissionPolicy };
if (require.main === module) main().catch(error=>{console.error(error);process.exitCode=1;});
