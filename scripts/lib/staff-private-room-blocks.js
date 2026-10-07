'use strict';
// Canonical companion-block protocol extracted from staff-query-api. Used by
// Staff edits and both create channels, inside the caller's existing transaction.
const crypto = require('crypto');
const { buildManualBookingCreateSql } = require('./staff-manual-booking-create-sql');
async function staffPortalCancelPrivateRoomCompanionBlocks(pg, clientSlug, parentBookingId) {
  const legacy = await pg.query(`DELETE FROM booking_beds bb USING clients c, bookings b
    WHERE bb.client_id=c.id AND bb.booking_id=b.id AND c.slug=$1 AND b.id::text=$2
      AND bb.assignment_type='private_room_block' RETURNING bb.bed_code`, [clientSlug, String(parentBookingId)]);
  const cancelled = await pg.query(`UPDATE bookings b SET status='cancelled'::booking_status, updated_at=NOW()
    FROM clients c WHERE b.client_id=c.id AND c.slug=$1
      AND b.metadata->>'private_room_parent_booking_id'=$2 AND b.status='blocked'::booking_status
    RETURNING b.booking_code`, [clientSlug, String(parentBookingId)]);
  return { legacy_bed_codes: legacy.rows.map(r=>r.bed_code), cancelled_block_bookings: cancelled.rows.map(r=>r.booking_code) };
}
async function staffPortalCreatePrivateRoomCompanionBlock(pg, {clientSlug,checkIn,checkOut,bedCodes,parentBookingId,parentBookingCode}) {
  const codes=(bedCodes||[]).map(String).filter(Boolean);
  if (!codes.length) return {ok:true,skipped:true,blocked_beds:[]};
  const idempotencyKey=`prvblk-${crypto.createHash('md5').update([clientSlug,String(parentBookingId),checkIn,checkOut,codes.slice().sort().join('_')].join('|')).digest('hex')}`;
  const bookingCode=`PRV-${String(checkIn||'').replace(/-/g,'')}-${crypto.randomBytes(3).toString('hex')}`.toUpperCase();
  const notes=`Private room companion block for ${parentBookingCode||parentBookingId}`;
  const result=(await pg.query(buildManualBookingCreateSql(),[clientSlug,'private-room-sync','operator',idempotencyKey,bookingCode,'Blocked','staff-block',null,'en',checkIn,checkOut,Math.max(1,codes.length),codes,null,null,'blocked','not_requested',0,0,'staff_block','private_room_companion_block',notes,true,true])).rows[0];
  if(!result) return {error:'private_room_bed_block_conflict'};
  if(result.is_duplicate===true) return {ok:true,duplicate:true,block_booking_id:result.duplicate_booking_id,block_booking_code:result.duplicate_booking_code,blocked_beds:codes};
  if(result.is_blocked===true) return result.block_reason==='overlap_conflict'
    ? {error:'private_room_room_not_empty',blocked_beds:codes,check_in:checkIn,check_out:checkOut}
    : {error:'private_room_bed_block_conflict',block_reason:result.block_reason||null};
  if(!result.booking_id||Number(result.beds_inserted)!==codes.length) return {error:'private_room_bed_block_conflict'};
  await pg.query(`UPDATE bookings SET assignment_status='assigned', metadata=COALESCE(metadata,'{}'::jsonb)||$1::jsonb
    WHERE id=$2::uuid AND client_id=(SELECT id FROM clients WHERE slug=$3 LIMIT 1)`,[JSON.stringify({staff_calendar_block:true,block_type:'private_room_companion',source:'private_room_companion_block',private_room_parent_booking_id:String(parentBookingId),private_room_parent_booking_code:parentBookingCode||null}),result.booking_id,clientSlug]);
  await pg.query(`UPDATE booking_beds SET assignment_type='staff_block',assignment_notes=$2 WHERE booking_id=$1::uuid`,[result.booking_id,notes]);
  return {ok:true,block_booking_id:result.booking_id,block_booking_code:result.booking_code,blocked_beds:codes};
}
async function editWriteSyncPrivateRoomBedBlocks(pg, clientSlug, bookingRow, enabled) {
  const bookingId=bookingRow.booking_id,checkIn=bookingRow.check_in,checkOut=bookingRow.check_out;
  const cleanup=await staffPortalCancelPrivateRoomCompanionBlocks(pg,clientSlug,bookingId);
  const base={removed_blocks:[...cleanup.legacy_bed_codes,...cleanup.cancelled_block_bookings],blocked_beds:[],check_in:checkIn,check_out:checkOut};
  if(!enabled) return base;
  if(!checkIn||!checkOut||String(checkOut)<=String(checkIn)) return {...base,error:'private_room_invalid_booking_dates'};
  const guestBeds=(await pg.query(`SELECT bb.bed_code,bb.room_code FROM booking_beds bb
    JOIN bookings b ON b.id=bb.booking_id JOIN clients c ON c.id=bb.client_id
    WHERE c.slug=$1 AND b.id::text=$2 AND COALESCE(bb.assignment_type,'') NOT IN ('private_room_block','operator_block')
    ORDER BY bb.assignment_start_date,bb.bed_code`,[clientSlug,String(bookingId)])).rows;
  if(!guestBeds.length) return {...base,error:'private_room_no_bed_assignment'};
  const roomCode=guestBeds[0].room_code||bookingRow.primary_room_code;
  if(!roomCode) return {...base,error:'private_room_no_room_code'};
  if(guestBeds.some(b=>b.room_code!==roomCode)) return {...base,error:'private_room_multiple_rooms'};
  base.room_code=roomCode;
  // All beds, not merely currently sellable ones, must be empty. Unsellable
  // companion beds cause the existing manual writer to fail closed, never bypass.
  const roomBeds=(await pg.query(`SELECT bd.id::text AS bed_id,bd.bed_code FROM beds bd
    JOIN rooms r ON r.id=bd.room_id JOIN clients c ON c.id=bd.client_id
    WHERE c.slug=$1 AND r.client_id=c.id AND upper(trim(r.room_code))=upper(trim($2)) ORDER BY bd.bed_code FOR UPDATE OF bd`,[clientSlug,roomCode])).rows;
  if (!roomBeds.length || guestBeds.some(guest => !roomBeds.some(bed => bed.bed_code === guest.bed_code))) {
    return {...base,error:'private_room_inventory_unresolved'};
  }
  const assigned=new Set(guestBeds.map(b=>b.bed_code));
  const companions=roomBeds.filter(b=>!assigned.has(b.bed_code));
  if(!companions.length) return base;
  const conflicts=[];
  for(const bed of companions){
    const rows=(await pg.query(`SELECT b.booking_code FROM booking_beds bb JOIN bookings b ON b.id=bb.booking_id
      JOIN clients c ON c.id=bb.client_id WHERE c.slug=$1 AND bb.bed_id=$2::uuid AND bb.booking_id<>$3::uuid
        AND bb.assignment_start_date<$5::date AND bb.assignment_end_date>$4::date
        AND b.status NOT IN ('cancelled','expired') LIMIT 1`,[clientSlug,bed.bed_id,bookingId,checkIn,checkOut])).rows;
    if(rows.length) conflicts.push({bed_code:bed.bed_code,booking_code:rows[0].booking_code});
  }
  if(conflicts.length) return {...base,error:'private_room_room_not_empty',conflicts};
  const created=await staffPortalCreatePrivateRoomCompanionBlock(pg,{clientSlug,checkIn,checkOut,bedCodes:companions.map(b=>b.bed_code),parentBookingId:bookingId,parentBookingCode:bookingRow.booking_code});
  return {...base,...created};
}
module.exports={staffPortalCancelPrivateRoomCompanionBlocks,staffPortalCreatePrivateRoomCompanionBlock,editWriteSyncPrivateRoomBedBlocks};
