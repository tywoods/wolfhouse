'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const {seedOfflineBookingDb}=require('./verify-luna-create-booking-occupants');
const {PGlite}=require('@electric-sql/pglite');
const {buildWolfhouseBookingCreateCommand,executeWolfhouseBookingCreate}=require('./lib/luna-front-desk-accommodation-booking-create-service');
const {getBedCalendarBlocksQuery}=require('./lib/staff-bed-calendar-queries');
const payload={confirm:true,client_slug:'wolfhouse-somo',check_in:'2026-10-16',check_out:'2026-10-19',guest_count:2,guest_name:'Offline A',guests:[{name:'Offline A'},{name:'Offline B'}],phone:'+999****001',package_code:'package_none',room_type:'double',room_preference:'private',payment_choice:'full',selected_bed_codes:['R1-B2','R1-B1']};
(async()=>{
 const out=path.resolve(process.argv[2]||'/tmp/selling-booking');fs.mkdirSync(out,{recursive:true});const dir=fs.mkdtempSync(path.join(out,'db-'));let db=new PGlite(dir);const calls=[];
 const pg={query:async(sql,args)=>{calls.push({sql,args});return db.query(sql,args);}};
 try{
  await seedOfflineBookingDb(db,payload);
  await db.exec("ALTER TYPE booking_status ADD VALUE 'blocked'; ALTER TABLE bookings ADD room_preference text; ALTER TABLE payments ADD created_at timestamptz DEFAULT now();");
  // Shared seedOfflineBookingDb applies migration 111 once.
  await db.query("UPDATE rooms SET selling_mode='private_optional' WHERE room_code='R1'");
  const built=await buildWolfhouseBookingCreateCommand({channel:'luna_whatsapp',trustedClientSlug:'wolfhouse-somo',transportBody:payload,pgClient:pg});
  assert.equal(built.ok,true,'private create builds: '+JSON.stringify(built.body));
  const result=await executeWolfhouseBookingCreate(pg,built.command,{stripeConfig:{stripeLinksEnabled:false}});
  assert.equal(result.ok,true,'private create commits: '+JSON.stringify(result.body));
  const companions=(await db.query("SELECT id,metadata,status FROM bookings WHERE metadata->>'private_room_parent_booking_id'=$1",[result.body.booking_id])).rows;
  assert.equal(companions.length,1,'Luna private booking must persist canonical companion-bed lock before commit');
  assert.equal(companions[0].status,'blocked');
  await db.close();db=new PGlite(dir);
  const blocks=(await db.query(getBedCalendarBlocksQuery(),['wolfhouse-somo','2026-10-17','2026-10-18'])).rows.filter(r=>r.room_code==='R1');
  const all=(await db.query("SELECT bd.bed_code FROM beds bd JOIN rooms r ON r.id=bd.room_id WHERE r.room_code='R1' AND bd.active")).rows;
  assert.deepEqual(blocks.map(r=>r.bed_code).sort(),all.map(r=>r.bed_code).sort(),'whole room reserved on middle night');
  assert.equal((await db.query(getBedCalendarBlocksQuery(),['wolfhouse-somo','2026-10-19','2026-10-20'])).rows.filter(r=>r.room_code==='R1').length,0,'adjacent nights remain free');
  const occupants=(await db.query('SELECT guest_name,assigned_bed_code FROM booking_guests ORDER BY guest_number')).rows;
  assert.deepEqual(occupants.map(r=>r.assigned_bed_code),payload.selected_bed_codes,'person-bound order retained');
  fs.writeFileSync(path.join(out,'booking.json'),JSON.stringify({passed:true,companions,blocks,occupants,calls},null,2));
  console.log('PASS ordinary Luna private create → canonical companion lock → commit → disk reopen → all-night blocks; ordered occupants; adjacent stay free');
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
