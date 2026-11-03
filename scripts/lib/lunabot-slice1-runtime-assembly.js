'use strict';

const { handleContactIdentity } = require('./luna-contact-identity');
const { getConversationMessagesQuery } = require('./staff-conversation-queries');
const {
  CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE,
  receiptCrowsnestSyntheticConfirmationThreadMessage,
} = require('./luna-staff-inbox-thread-message');

/**
 * Narrow production composition seam for the approved Slice 1 operations.
 * It deliberately owns no connection or persistence: every operation goes through
 * the caller's one withPgClient and existing production owners are reused where
 * they exist. No router/server/monolith internals are exported.
 */
function createLunabotSlice1RuntimeAssembly(deps) {
  if (!deps || typeof deps.withPgClient !== 'function') throw new TypeError('withPgClient required');
  for (const name of ['readBody', 'sendJSON', 'appendAuditLog']) {
    if (typeof deps[name] !== 'function') throw new TypeError(`${name} required`);
  }
  const transports = Object.freeze({ ...(deps.transports || {}) });
  const withPg = (fn) => deps.withPgClient(fn);
  const audit = (operation, success, extra = {}) => deps.appendAuditLog({ operation, success, ...extra });

  async function createBooking(input) {
    return withPg(async (pg) => {
      const q = await pg.query(`INSERT INTO bookings(id,client_id,conversation_id,booking_code,guest_name,phone,room_code,price_cents,status,confirmation_status)
        SELECT $1,c.id,$2,$3,$4,$5,$6,$7,'confirmed','pending' FROM clients c WHERE c.slug=$8
        ON CONFLICT (client_id,conversation_id) DO NOTHING RETURNING *`,
      [input.booking_id,input.conversation_id,input.booking_code,input.full_name,input.phone,input.room_code,input.price_cents,input.client_slug]);
      const created = q.rows.length === 1;
      audit('slice1.booking.create', created, { booking_id: input.booking_id });
      return { created, booking: q.rows[0] || null };
    });
  }
  async function saveContact(input) { return withPg((pg) => handleContactIdentity(pg, { clientSlug: input.client_slug, phone: input.phone, body: { full_name: input.full_name } })); }
  async function saveTransfer(input) { return withPg(async (pg) => {
    const q=await pg.query(`INSERT INTO booking_transfers(id,client_id,booking_id,direction,airport_code,scheduled_at) SELECT $1,c.id,$2,$3,$4,$5 FROM clients c JOIN bookings b ON b.client_id=c.id AND b.id=$2 WHERE c.slug=$6 ON CONFLICT(client_id,booking_id,direction) DO UPDATE SET airport_code=excluded.airport_code RETURNING *`,[input.transfer_id,input.booking_id,input.direction,input.airport_code,input.scheduled_at,input.client_slug]);
    audit('slice1.transfer.save',q.rows.length===1,{booking_id:input.booking_id}); return q.rows[0];
  }); }
  async function discoverLab(input) { return withPg(async(pg)=>(await pg.query(`SELECT id::text,client_id::text,phone,trusted FROM conversations WHERE id=$1 AND client_id=(SELECT id FROM clients WHERE slug=$2) AND trusted=true`,[input.conversation_id,input.client_slug])).rows); }
  async function readThread(input) { return withPg(async(pg)=>({ conversation_id: input.conversation_id, messages:(await pg.query(getConversationMessagesQuery(),[input.client_slug,input.conversation_id])).rows })); }
  async function claimAndReply(input) { return withPg(async(pg)=>{ const claimed=await pg.query(`UPDATE conversations SET lease_token=$3 WHERE id=$1 AND client_id=(SELECT id FROM clients WHERE slug=$2) AND lease_token IS NULL RETURNING id`,[input.conversation_id,input.client_slug,input.lease_token]); if(!claimed.rows.length)return {claimed:false}; const msg=await pg.query(`INSERT INTO messages(id,conversation_id,client_id,source,direction,message_text,metadata) SELECT $1,id,client_id,'staff_supervisor','outbound',$2,$3 FROM conversations WHERE id=$4 RETURNING *`,[input.message_id,input.text,JSON.stringify({lease_token:input.lease_token}),input.conversation_id]); return {claimed:true,message:msg.rows[0]}; }); }
  async function createEvent(input) { return withPg(async(pg)=>(await pg.query(`INSERT INTO supervisor_events(id,client_id,conversation_id,booking_id,kind,source_key,metadata) SELECT $1,c.id,$2,$3,$4,$5,$6 FROM clients c WHERE c.slug=$7 ON CONFLICT(source_key) DO NOTHING RETURNING *`,[input.event_id,input.conversation_id,input.booking_id,input.kind,input.source_key,JSON.stringify(input.metadata||{}),input.client_slug])).rows[0]); }
  async function listEvents(input) { return withPg(async(pg)=>(await pg.query(`SELECT * FROM supervisor_events WHERE client_id=(SELECT id FROM clients WHERE slug=$1) AND conversation_id=$2 ORDER BY created_at`,[input.client_slug,input.conversation_id])).rows); }
  async function eventDetail(input) { return withPg(async(pg)=>(await pg.query(`SELECT * FROM supervisor_events WHERE id=$1 AND client_id=(SELECT id FROM clients WHERE slug=$2)`,[input.event_id,input.client_slug])).rows[0]||null); }
  async function persistConfirmation(input) { return withPg(async(pg)=>(await pg.query(`INSERT INTO messages(id,conversation_id,client_id,source,direction,message_text,metadata) SELECT $1,id,client_id,$2,'outbound',$3,$4 FROM conversations WHERE id=$5 AND client_id=(SELECT id FROM clients WHERE slug=$6) RETURNING *`,[input.message_id,CROWSNEST_SYNTHETIC_CONFIRMATION_SOURCE,input.text,JSON.stringify({consumer_receipt:false,booking_id:input.booking_id}),input.conversation_id,input.client_slug])).rows[0]); }
  async function receipt(input) { return withPg(async(pg)=>{ const out=await receiptCrowsnestSyntheticConfirmationThreadMessage(pg,input); if(out.ok&&out.changed) await pg.query(`UPDATE bookings SET confirmation_status='delivered' WHERE id=$1 AND client_id=(SELECT id FROM clients WHERE slug=$2) AND confirmation_status='pending'`,[input.booking_id,input.client_slug]); return out; }); }
  return Object.freeze({ createBooking,saveContact,saveTransfer,discoverLab,readThread,claimAndReply,createEvent,listEvents,eventDetail,persistConfirmation,receipt,transports });
}
module.exports=Object.freeze({createLunabotSlice1RuntimeAssembly});
