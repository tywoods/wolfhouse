'use strict';
// Acceptance 2: real Staff create command/SQL on isolated PGlite, no live calls.
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const root=process.cwd(),req=(p)=>require(path.join(root,p));
const {PGlite}=req('node_modules/@electric-sql/pglite');
const {seedOfflineBookingDb}=req('scripts/verify-luna-create-booking-occupants');
const {buildWolfhouseBookingCreateCommand,executeWolfhouseBookingCreate}=req('scripts/lib/luna-front-desk-accommodation-booking-create-service');
const out=path.resolve(process.argv[2]||path.join(root,'artifacts/private-opt-saved-pricing')),results=[];
fs.mkdirSync(out,{recursive:true});
async function saved(type,count){
 const db=new PGlite();
 const body={confirm:true,client_slug:'wolfhouse-somo',check_in:'2026-10-16',check_out:'2026-10-19',guest_count:count,guest_name:'Offline Pricing 1',guests:Array.from({length:count},(_,i)=>({name:`Offline Pricing ${i+1}`})),phone:'+999000001',package_code:'package_none',room_type:type,room_preference:type==='shared'?'mixed':type,payment_choice:'deposit',selected_bed_codes:Array.from({length:count},(_,i)=>`R1-B${i+1}`),idempotency_key:`private-opt-price-${type}-${count}`};
 try{
 await seedOfflineBookingDb(db,body);
 await db.exec("ALTER TYPE booking_status ADD VALUE 'blocked'; ALTER TABLE bookings ADD room_preference text;");
 await db.query("UPDATE rooms SET selling_mode='private_optional' WHERE room_code='R1'");
 await db.query("INSERT INTO wh_pricing_rules (client_slug,item_type,item_code,season_code,unit,amount_cents,currency,active) VALUES ('wolfhouse-somo','supplement','private',NULL,'per_room_per_night',1700,'EUR',true), ('wolfhouse-somo','supplement','double',NULL,'per_room_per_night',9900,'EUR',true)");
 const built=await buildWolfhouseBookingCreateCommand({channel:'luna_whatsapp',trustedClientSlug:'wolfhouse-somo',transportBody:body,pgClient:db});
 assert.equal(built.ok,true,JSON.stringify(built));
 const created=await executeWolfhouseBookingCreate(db,built.command,{stripeConfig:{stripeLinksEnabled:false}});
 assert.equal(created.ok,true,JSON.stringify(created));
 const bookings=(await db.query('SELECT id,status,guest_count,total_amount_cents,deposit_required_cents,metadata FROM bookings ORDER BY booking_code')).rows;
 const guests=(await db.query('SELECT guest_number,deposit_amount_cents,metadata FROM booking_guests ORDER BY guest_number')).rows;
 const payments=(await db.query('SELECT booking_id,amount_due_cents FROM payments')).rows;
 const parent=bookings.find(x=>x.id===created.body.booking_id),blocks=bookings.filter(x=>x.id!==parent.id);
 assert.equal(parent.guest_count,count);assert.equal(guests.length,count);
 assert.ok(blocks.every(b=>Number(b.total_amount_cents)===0&&Number(b.deposit_required_cents)===0));
 assert.ok(payments.every(p=>p.booking_id===parent.id));
 const result={type,count,parent,blocks,guests,payments,quote:created.body.quote};results.push(result);return result;
 }finally{await db.close();}
}
(async()=>{
 for(const count of [1,3]){
  const shared=await saved('shared',count),privateRoom=await saved('private',count),doubleRoom=await saved('double',count);
  assert.equal(Number(privateRoom.parent.total_amount_cents)-Number(shared.parent.total_amount_cents),1700*3,'exactly one Staff private supplement per room/night across real create');
  assert.equal(privateRoom.parent.deposit_required_cents,shared.parent.deposit_required_cents,'same real-person deposit');
  assert.equal(privateRoom.parent.total_amount_cents,doubleRoom.parent.total_amount_cents,'double never uses divergent double tariff');
  assert.equal(privateRoom.parent.deposit_required_cents,doubleRoom.parent.deposit_required_cents);
  console.log(`PASS real Staff create saved totals/deposits/guests/zero blocks/payment owners: ${count} real guest(s), private=double, flat supplement 5100 cents`);
 }
 fs.writeFileSync(path.join(out,'saved-pricing.json'),JSON.stringify({passed:true,fixture:'isolated PGlite, no external APIs',results},null,2));
})().catch(error=>{fs.writeFileSync(path.join(out,'saved-pricing.json'),JSON.stringify({passed:false,error:error.stack,results},null,2));console.error(error);process.exitCode=1;});
