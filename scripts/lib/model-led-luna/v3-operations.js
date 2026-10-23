'use strict';
const crypto = require('node:crypto');
const { buildWolfhouseBookingCreateCommand, executeWolfhouseBookingCreate, BOOKING_CREATE_CHANNELS } = require('../luna-front-desk-accommodation-booking-create-service');
const TENANT = 'wolfhouse-somo';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function fingerprint(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function fail(code, status=409, extra={}) { return { ok:false, outcome:'rejected', code, status, ...extra }; }
async function session(pg, context, write=false) {
  if (!context || context.tenantId !== TENANT || !context.authenticated || !context.sessionId || !context.principalId) throw Object.assign(new Error('trusted session context required'), { status:403 });
  const r=await pg.query(`SELECT s.*,c.slug FROM luna_v3_sessions s JOIN clients c ON c.id=s.client_id WHERE c.slug=$1 AND s.session_key=$2 AND s.principal_id=$3`,[TENANT,context.sessionId,context.principalId]);
  if (!r.rows[0]) throw Object.assign(new Error('session ownership denied'),{status:403});
  if (write && (context.writeAllowed!==true || r.rows[0].write_admitted!==true)) throw Object.assign(new Error('write admission denied'),{status:403});
  return r.rows[0];
}
async function beginOperation(pg,s,tool,key,input) {
  const fp=fingerprint(input);
  const r=await pg.query(`INSERT INTO luna_v3_operations(client_id,session_id,tool,operation_key,request_fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT(client_id,session_id,tool,operation_key) DO NOTHING RETURNING *`,[s.client_id,s.id,tool,key,fp]);
  const row=r.rows[0]||(await pg.query(`SELECT * FROM luna_v3_operations WHERE client_id=$1 AND session_id=$2 AND tool=$3 AND operation_key=$4 FOR UPDATE`,[s.client_id,s.id,tool,key])).rows[0];
  if(row.request_fingerprint!==fp) return { conflict:fail('operation_key_payload_mismatch') };
  if(row.receipt) return { replay:row.receipt };
  return { row, fp };
}
async function finish(pg,id,receipt,ids={}) { await pg.query(`UPDATE luna_v3_operations SET receipt=$2::jsonb,outcome=$3,booking_id=COALESCE($4,booking_id),hold_id=COALESCE($5,hold_id),completed_at=now() WHERE id=$1`,[id,JSON.stringify(receipt),receipt.outcome||'applied',ids.bookingId||null,ids.holdId||null]); return receipt; }

async function revalidateSelection(pg, selection, context) {
  const quoteInput=selection.quote&&selection.quote.quoteInput;
  if(!quoteInput)return fail('fresh_agreement_required',409);
  const fresh=await require('./index').quote(pg,quoteInput,context);
  if(!fresh||fresh.ok!==true)return fail(fresh&&fresh.code||'selection_no_longer_available',fresh&&fresh.status||409);
  if(fresh.quoteRevision!==selection.quote_revision)return fail('fresh_agreement_required',409,{currentQuoteRevision:fresh.quoteRevision});
  return {ok:true};
}

async function holdBeds(pg,input,context) {
  const s=await session(pg,context,true); await pg.query('BEGIN');
  try {
    const op=await beginOperation(pg,s,'hold_beds',input.operation_key,input); if(op.conflict){await pg.query('ROLLBACK');return op.conflict;} if(op.replay){await pg.query('COMMIT');return op.replay;}
    const assignments=input.assignments||[]; if(!assignments.length) {await pg.query('ROLLBACK');return fail('assignments_required',400);}
    const sel=(await pg.query(`SELECT * FROM luna_v3_selections WHERE client_id=$1 AND session_id=$2 AND quote_revision=$3 FOR UPDATE`,
      [s.client_id,s.id,input.quoted_selection])).rows[0];
    if(!sel){await pg.query('ROLLBACK');return fail('quoted_selection_not_found',404);}
    const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
    const dateOnly=(v)=>v instanceof Date?v.toISOString().slice(0,10):String(v);
    if(dateOnly(sel.check_in)!==dateOnly(input.check_in)||dateOnly(sel.check_out)!==dateOnly(input.check_out)
      ||!same(sel.guests,input.guests)||!same(sel.assignments,assignments)){
      await pg.query('ROLLBACK');return fail('quoted_selection_mismatch');
    }
    const current=await revalidateSelection(pg,sel,context);if(!current.ok){await pg.query('ROLLBACK');return current;}
    const codes=assignments.map(a=>a.bed_code); if(new Set(codes).size!==codes.length){await pg.query('ROLLBACK');return fail('duplicate_bed');}
    const beds=(await pg.query(`SELECT b.id,b.bed_code FROM beds b JOIN clients c ON c.id=b.client_id WHERE c.slug=$1 AND b.active=true AND COALESCE(b.sellable,true)=true AND b.bed_code=ANY($2::text[]) ORDER BY b.id`,[TENANT,codes])).rows;
    if(beds.length!==codes.length){await pg.query('ROLLBACK');return fail('exact_beds_unavailable');}
    for(const b of beds) await pg.query(`SELECT pg_advisory_xact_lock(booking_occupancy_lock_key('bed',$1))`,[b.id]);
    const conflicts=await pg.query(`SELECT b.bed_code FROM beds b WHERE b.id=ANY($1::uuid[]) AND (EXISTS(SELECT 1 FROM booking_beds bb JOIN bookings bk ON bk.id=bb.booking_id WHERE bb.client_id=$2 AND bb.bed_id=b.id AND bb.assignment_start_date<$4::date AND bb.assignment_end_date>$3::date AND bk.status::text NOT IN ('cancelled','expired')) OR EXISTS(SELECT 1 FROM luna_v3_hold_beds hb JOIN luna_v3_holds h ON h.id=hb.hold_id WHERE hb.client_id=$2 AND hb.bed_id=b.id AND h.state='active' AND h.expires_at>clock_timestamp() AND h.check_in<$4::date AND h.check_out>$3::date))`,[beds.map(b=>b.id),s.client_id,sel.check_in,sel.check_out]);
    if(conflicts.rows.length){await pg.query('ROLLBACK');return fail('exact_beds_unavailable',409,{conflicts:conflicts.rows.map(x=>x.bed_code)});}
    const h=(await pg.query(`INSERT INTO luna_v3_holds(client_id,session_id,selection_id,check_in,check_out,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes') RETURNING id,expires_at`,[s.client_id,s.id,sel.id,sel.check_in,sel.check_out])).rows[0];
    const byCode=new Map(beds.map(b=>[b.bed_code,b])); for(let i=0;i<assignments.length;i++){const a=assignments[i],b=byCode.get(a.bed_code);await pg.query(`INSERT INTO luna_v3_hold_beds(hold_id,client_id,bed_id,guest_ordinal,bed_code,package_code) VALUES($1,$2,$3,$4,$5,$6)`,[h.id,s.client_id,b.id,i+1,a.bed_code,a.package_code||null]);}
    const receipt={ok:true,outcome:'applied',operationKey:input.operation_key,held:true,holdId:h.id,expiresAt:h.expires_at,assignments,quoteRevision:sel.quote_revision}; await finish(pg,op.row.id,receipt,{holdId:h.id}); await pg.query('COMMIT'); return receipt;
  } catch(e){await pg.query('ROLLBACK');throw e;}
}

async function defaultBookingAuthority(pg,selection,key) {
 const guests=selection.guests, assignments=selection.assignments, q=selection.quote;
 const built=await buildWolfhouseBookingCreateCommand({channel:BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,trustedClientSlug:TENANT,pgClient:pg,transportBody:{confirm:true,check_in:selection.check_in,check_out:selection.check_out,guest_count:guests.length,guests:guests.map(g=>({guest_name:g.name||g.guest_name,explicit_gender:g.explicit_gender})),guest_name:guests[0].name||guests[0].guest_name,phone:q.phone,selected_bed_codes:assignments.map(a=>a.bed_code),guest_packages:assignments.map((a,i)=>({guest_number:i+1,package_code:a.package_code||'package_none'})),package_code:q.packageCode||'package_none',payment_choice:'deposit',room_type:q.roomType||'shared',keep_together:q.keepTogether===true,idempotency_key:key}});
 if(!built.ok||!built.command) return built; return executeWolfhouseBookingCreate(pg,built.command,{callerManagedTransaction:true,authorizeAutomaticBooking:async()=>({allowed:true,source:'luna_v3_session'})});
}
async function book(pg,input,context) {
 const s=await session(pg,context,true); await pg.query('BEGIN'); try {
  const op=await beginOperation(pg,s,'book',input.operation_key,input); if(op.conflict){await pg.query('ROLLBACK');return op.conflict;} if(op.replay){await pg.query('COMMIT');return op.replay;}
  const h=(await pg.query(`SELECT h.*,row_to_json(sel.*) selection FROM luna_v3_holds h JOIN luna_v3_selections sel ON sel.id=h.selection_id WHERE h.id=$1 AND h.client_id=$2 AND h.session_id=$3 FOR UPDATE OF h`,[input.hold_id,s.client_id,s.id])).rows[0];
  if(!h||h.state!=='active'||new Date(h.expires_at)<=new Date()){await pg.query('ROLLBACK');return fail('hold_not_active');}
  await pg.query(`UPDATE luna_v3_holds SET state='released',updated_at=now() WHERE id=$1`,[h.id]);
  const current=await revalidateSelection(pg,h.selection,context);if(!current.ok){await pg.query('ROLLBACK');return current;}
  const created=await defaultBookingAuthority(pg,h.selection,input.operation_key);
  if(!created||created.ok!==true){throw Object.assign(new Error('booking authority refused'),{result:created});}
  const body=created.body||created; const bookingId=body.booking_id||body.bookingId;
  await pg.query(`UPDATE luna_v3_holds SET state='converted',booking_id=$2,updated_at=now() WHERE id=$1`,[h.id,bookingId]); await pg.query(`UPDATE luna_v3_sessions SET selected_booking_id=$2,updated_at=now() WHERE id=$1`,[s.id,bookingId]);
  const b=(await pg.query(`SELECT id,booking_code,status::text,payment_status::text,total_amount_cents,deposit_required_cents,amount_paid_cents,balance_due_cents FROM bookings WHERE id=$1`,[bookingId])).rows[0];
  const receipt={ok:true,outcome:'applied',operationKey:input.operation_key,bookingId:b.id,bookingCode:b.booking_code,consumedHoldId:h.id,status:b.status,paymentStatus:['not_requested','waiting_payment'].includes(b.payment_status)?'unpaid':b.payment_status,totalCents:b.total_amount_cents,depositCents:b.deposit_required_cents,paidCents:b.amount_paid_cents||0,owedCents:b.balance_due_cents,assignments:h.selection.assignments,guests:h.selection.guests};
  if(receipt.status!=='confirmed') throw new Error('booking authority did not persist confirmed booking'); await finish(pg,op.row.id,receipt,{bookingId,holdId:h.id}); await pg.query('COMMIT'); return receipt;
 }catch(e){await pg.query('ROLLBACK');if(e.result)return fail(e.result.body?.reason_code||'booking_refused',e.result.status||409);throw e;}
}
async function getBooking(pg,input,context){const s=await session(pg,context,false);if(!s.selected_booking_id)return fail('booking_not_selected',404);if(input.booking_id&&input.booking_id!==s.selected_booking_id)return fail('booking_selector_forbidden',403);const r=await pg.query(`SELECT b.id,b.booking_code,b.check_in,b.check_out,b.status::text,payment_status::text,b.total_amount_cents,b.deposit_required_cents,COALESCE(b.amount_paid_cents,0) paid_cents,b.balance_due_cents,b.updated_at,COALESCE(jsonb_agg(jsonb_build_object('bedCode',bb.bed_code,'guestName',bb.guest_name) ORDER BY bb.created_at) FILTER(WHERE bb.id IS NOT NULL),'[]') assignments FROM bookings b LEFT JOIN booking_beds bb ON bb.booking_id=b.id WHERE b.id=$1 AND b.client_id=$2 GROUP BY b.id`,[s.selected_booking_id,s.client_id]);if(!r.rows[0])return fail('selected_booking_missing',404);const row=r.rows[0];return {ok:true,bookingId:row.id,...row,paymentStatus:['not_requested','waiting_payment'].includes(row.payment_status)?'unpaid':row.payment_status};}
async function recoverOperation(pg,input,context){const s=await session(pg,context,false);const r=await pg.query(`SELECT tool,operation_key,outcome,receipt,booking_id,hold_id FROM luna_v3_operations WHERE client_id=$1 AND session_id=$2 AND operation_key=$3`,[s.client_id,s.id,input.operation_key]);if(r.rows.length!==1)return {ok:false,status:'unknown',outcome:'unknown',readBack:true};const o=r.rows[0];if(o.receipt)return {ok:true,status:'saved',outcome:o.outcome,readBack:true,tool:o.tool,operationKey:o.operation_key,receipt:o.receipt};return {ok:false,status:'unknown',outcome:'unknown',readBack:true,tool:o.tool,operationKey:o.operation_key};}
async function releaseHold(pg,input,context){const s=await session(pg,context,true);await pg.query('BEGIN');try{const op=await beginOperation(pg,s,'release_hold',input.operation_key,input);if(op.conflict){await pg.query('ROLLBACK');return op.conflict;}if(op.replay){await pg.query('COMMIT');return op.replay;}const h=(await pg.query(`SELECT h.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('bed_code',hb.bed_code,'guest_ordinal',hb.guest_ordinal) ORDER BY hb.guest_ordinal) FROM luna_v3_hold_beds hb WHERE hb.hold_id=h.id),'[]') assignments FROM luna_v3_holds h WHERE h.id=$1 AND h.client_id=$2 AND h.session_id=$3 FOR UPDATE OF h`,[input.hold_id,s.client_id,s.id])).rows[0];if(!h||h.state==='converted'){await pg.query('ROLLBACK');return fail('hold_not_releasable');}const already=h.state==='released';if(!already)await pg.query(`UPDATE luna_v3_holds SET state='released',updated_at=now() WHERE id=$1`,[h.id]);const receipt={ok:true,outcome:'applied',holdId:h.id,released:!already,alreadyReleased:already,assignments:h.assignments};await finish(pg,op.row.id,receipt,{holdId:h.id});await pg.query('COMMIT');return receipt;}catch(e){await pg.query('ROLLBACK');throw e;}}
async function handoffToHuman(pg,input,context){const s=await session(pg,context,true);await pg.query('BEGIN');try{const op=await beginOperation(pg,s,'handoff_to_human',input.operation_key,input);if(op.conflict){await pg.query('ROLLBACK');return op.conflict;}if(op.replay){await pg.query('COMMIT');return op.replay;}if(input.booking_id&&input.booking_id!==s.selected_booking_id){await pg.query('ROLLBACK');return fail('booking_selector_forbidden',403);}const h=(await pg.query(`INSERT INTO luna_v3_handoffs(client_id,session_id,booking_id,reason,context) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id`,[s.client_id,s.id,s.selected_booking_id,input.reason,JSON.stringify(input.context||{})])).rows[0];const receipt={ok:true,outcome:'applied',handoffId:h.id,reason:input.reason,bookingId:s.selected_booking_id,sent:false,externalSendAllowed:false,staffAlertAllowed:false};await finish(pg,op.row.id,receipt,{bookingId:s.selected_booking_id});await pg.query('COMMIT');return receipt;}catch(e){await pg.query('ROLLBACK');throw e;}}
module.exports={holdBeds,book,getBooking,recoverOperation,releaseHold,handoffToHuman};
