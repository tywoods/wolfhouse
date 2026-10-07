'use strict';
const assert=require('node:assert/strict'),path=require('path');
const {fixture}=require('./verify-room-selling-mode');
const {getBedCalendarRoomsQuery}=require('./lib/staff-bed-calendar-queries');
const {computeWolfhouseAvailabilityInventory}=require('./lib/luna-front-desk-accommodation-availability-service');
(async()=>{const f=await fixture(path.resolve(process.argv[2]||'/tmp/selling-consumers'));
try{
 await f.query("ALTER TABLE rooms ADD fill_priority int DEFAULT 1, ADD sort_order int DEFAULT 1"); await f.query("ALTER TABLE beds ADD bed_label text, ADD planning_row_label text");
 const before=await f.get();assert.equal((await f.put({sellingMode:'private_optional',expectedCatalogRevision:before.catalogRevision})).status,200);
 const rows=(await f.query(getBedCalendarRoomsQuery(),['wolfhouse-somo'])).rows;
 assert.equal(rows[0].selling_mode,'private_optional','canonical DB availability catalogue must carry saved selling mode');
 const command={guestCount:1,roomType:'double',roomPreference:'private',assignmentMode:true,transportBody:{}};
 let result=computeWolfhouseAvailabilityInventory(rows,[],command);
 assert.equal(result.selectedBedCodes.length,1);assert.equal(result.roomOptionFlags.private_room_available,true,'private option derived from full authoritative room inventory');
 result=computeWolfhouseAvailabilityInventory(rows,[{room_code:'R1',bed_code:rows[0].bed_code}],command);
 assert.equal(result.selectedBedCodes.length,0);assert.equal(result.roomOptionFlags.private_room_available,false);
 console.log('PASS persisted room → canonical bed catalogue → automatic assignment/private offer; occupied option rejected');
 // Preserve the parent private-offer RED in the repository suite, now through
 // the saved route and canonical SQL projection rather than an invented DTO.
 await f.query("UPDATE rooms SET room_code='R5'");
 await f.query("UPDATE beds SET bed_code='R5-B1'");
 for (const mode of ['private','shared','private_optional']) {
  const current=await f.get();
  assert.equal((await f.put({sellingMode:mode,expectedCatalogRevision:current.catalogRevision})).status,200);
  const inventory=(await f.query(getBedCalendarRoomsQuery(),['wolfhouse-somo'])).rows;
  const offer=computeWolfhouseAvailabilityInventory(inventory,[],command).roomOptionFlags;
  assert.equal(offer.girls_room_available,mode!=='private','Private must not advertise girls shared; Shared/optional retain the offer');
  assert.equal(offer.private_room_available,mode!=='shared','ordinary Private/optional offer requires explicit private inventory eligibility');
  const retained=(await f.query('SELECT room_type,gender_strategy FROM rooms')).rows[0];
  assert.deepEqual(retained,{room_type:'female_only',gender_strategy:'Female preferred'});
 }
 console.log('PASS saved Private R5 is not a girls-shared offer; Shared/optional preserve gender and shared offer');
}finally{await f.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
