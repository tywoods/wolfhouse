'use strict';
// Narrow bot adapter: same canonical free-bed allocator and existing add-guest
// money/invoice owner, in one transaction. No checkout or delivery ownership here.
const { addGuestToBooking } = require('./luna-guest-addguest-attach');
const { resolveWolfhouseAutomaticBookingAdmission } = require('./staff-booking-portal-policy');
const { loadBookingQuoteConfigWithOverlay } = require('./luna-front-desk-accommodation-booking-create-service');
const { buildWolfhouseAvailabilityCommand, executeWolfhouseInventoryCheck } = require('./luna-front-desk-accommodation-availability-service');
const fail = (status, error) => ({status, body:{success:false,error,write_performed:false}});

async function addGuestWithAllocation(pg, {clientSlug, trustedPhone, body, env = process.env}) {
  const phone = String(trustedPhone || '').replace(/\D/g, '');
  if (!phone) return fail(403, 'trusted_guest_phone_required');
  const code = String(body.booking_code || '').trim();
  const name = String(body.guest_name || '').trim();
  const key = String(body.idempotency_key || '').trim();
  if (!code || !name || !key || key.length > 160 || name.length > 200) return fail(400,'booking_code_guest_name_idempotency_key_required');
  await pg.query('BEGIN');
  try {
    const reject = async (status,error) => { await pg.query('ROLLBACK'); return fail(status,error); };
    const booking = (await pg.query(`SELECT b.id::text, b.client_id::text, b.booking_code,
      b.check_in::text,b.check_out::text,b.guest_count,b.package_code,b.requested_room_type,
      b.status::text,b.metadata FROM bookings b JOIN clients c ON c.id=b.client_id
      WHERE c.slug=$1 AND b.booking_code=$2
       AND regexp_replace(COALESCE(b.phone,''),'[^0-9]','','g')=$3 FOR UPDATE OF b`,
    [clientSlug,code,phone])).rows[0];
    if (!booking) return await reject(404,'booking_not_found');
    if (!['confirmed','hold','payment_pending'].includes(booking.status)) return await reject(409,'booking_not_active');
    // Use the portal policy owner on this transaction's client, before replay,
    // allocation or mutation. Only the authenticated phone binds the context;
    // body-supplied conversation/phone fields are not admission authority.
    const admission = await resolveWolfhouseAutomaticBookingAdmission(pg, {
      client_slug: clientSlug, guest_phone: phone,
    });
    if (admission?.allowed !== true) {
      return await reject(admission?.unavailable ? 503 : 403,
        admission?.reason || 'booking_policy_unavailable');
    }
    const operations = booking.metadata?.bot_add_guest_operations || {};
    const previous = Object.prototype.hasOwnProperty.call(operations,key) ? operations[key] : null;
    if (previous) {
      if (previous.guest_name !== name) return await reject(409,'idempotency_conflict');
      await pg.query('COMMIT');
      return {status:200,body:{...previous,idempotent:true}};
    }
    // The create owner also locks selected rooms before its occupancy recheck.
    // Lock in stable order before allocator read, preserving existing guest beds.
    await pg.query('SELECT id FROM rooms WHERE client_id=$1 ORDER BY id FOR UPDATE',[booking.client_id]);
    const built = buildWolfhouseAvailabilityCommand({channel:'bot_http',trustedClientSlug:clientSlug,
      demoCalendarEnrichment:false,transportBody:{
        check_in:booking.check_in,check_out:booking.check_out,guest_count:1,
        guest_name:name,guests:[{name}],package_code:booking.package_code,
        room_type:booking.requested_room_type || 'shared',
      }});
    if (!built.ok) return await reject(built.status || 409,built.body?.error || 'availability_unavailable');
    const availability = await executeWolfhouseInventoryCheck(pg,built.command);
    const codes = availability.body?.selected_bed_codes || [];
    if (!availability.ok || codes.length !== 1) return await reject(409,'no_availability_for_added_guest');
    const bed = (await pg.query(`SELECT bd.id::text,bd.bed_code,r.room_code FROM beds bd
      JOIN rooms r ON r.id=bd.room_id AND r.client_id=bd.client_id
      WHERE bd.client_id=$1 AND bd.bed_code=$2 AND bd.active=true FOR UPDATE OF bd`,
    [booking.client_id,codes[0]])).rows[0];
    if (!bed) return await reject(409,'no_availability_for_added_guest');
    const overlap = (await pg.query(`SELECT bb.id FROM booking_beds bb JOIN bookings b
      ON b.id=bb.booking_id AND b.client_id=bb.client_id WHERE bb.client_id=$1 AND bb.bed_id=$2
      AND bb.assignment_start_date<$4::date AND bb.assignment_end_date>$3::date
      AND b.status::text NOT IN ('cancelled','expired') LIMIT 1`,
    [booking.client_id,bed.id,booking.check_in,booking.check_out])).rows.length;
    if (overlap) return await reject(409,'no_availability_for_added_guest');
    // Pricing is optional enrichment. Roll back its SQL error state, not the
    // agreed guest addition; never substitute bundled/guessed prices.
    let quoteConfig = null, pricingUnavailableReason = null;
    await pg.query('SAVEPOINT add_guest_price_read');
    try {
      quoteConfig = await loadBookingQuoteConfigWithOverlay(pg);
    } catch (error) {
      await pg.query('ROLLBACK TO SAVEPOINT add_guest_price_read');
      pricingUnavailableReason = error.code || 'pricing_unavailable';
    } finally {
      await pg.query('RELEASE SAVEPOINT add_guest_price_read');
    }
    const attached = await addGuestToBooking(pg,{
      clientSlug,bookingId:booking.id,newGuestNames:[name],env,
      locationId:clientSlug,roomType:booking.requested_room_type || 'shared',pricingConfig:quoteConfig,
      pricingUnavailableReason,
      // Real canonical allocation above is authoritative for the one new guest;
      // legacy default rechecks the entire party against only the remaining beds.
      availabilityChecker:async()=>({available:true,status:'available'}),
      deferPayment:true,
    });
    if (attached.status !== 'ok') return await reject(409,attached.reason || attached.status);
    const guest = attached.inserted_booking_guests[0];
    await pg.query(`INSERT INTO booking_beds(client_id,booking_id,bed_id,bed_code,room_code,
      assignment_start_date,assignment_end_date,assignment_type)
      VALUES($1,$2,$3,$4,$5,$6::date,$7::date,'Auto Assigned')`,
    [booking.client_id,booking.id,bed.id,bed.bed_code,bed.room_code,booking.check_in,booking.check_out]);
    await pg.query(`UPDATE booking_guests SET assigned_bed_code=$4,assigned_room_code=$5,
      metadata=COALESCE(metadata,'{}'::jsonb)||$6::jsonb
      WHERE client_id=$1 AND booking_id=$2 AND id=$3`,
    [booking.client_id,booking.id,guest.booking_guest_id,bed.bed_code,bed.room_code,
      JSON.stringify({assigned_bed_id:bed.id,check_in:booking.check_in,check_out:booking.check_out})]);
    const response = {success:true,write_performed:true,booking_id:booking.id,booking_code:code,
      booking_guest_id:guest.booking_guest_id,guest_number:guest.guest_number,guest_name:name,
      assigned_bed_code:bed.bed_code,assigned_room_code:bed.room_code,
      total_amount_cents:attached.new_total_amount_cents,added_guest_total_cents:attached.accommodation_delta_cents,
      price_needs_staff_review:attached.price_needs_staff_review,
      next_action:attached.price_needs_staff_review ? 'review_guest_price' : 'ask_deposit_or_full',
      payment_scope:'guest',payment_choice:null,payment_link_created:false};
    await pg.query(`UPDATE bookings SET metadata=COALESCE(metadata,'{}'::jsonb)||$3::jsonb
      WHERE client_id=$1 AND id=$2`,[booking.client_id,booking.id,
      JSON.stringify({bot_add_guest_operations:{...operations,[key]:response}})]);
    await pg.query('COMMIT');
    return {status:200,body:response};
  } catch(error) {
    await pg.query('ROLLBACK');
    throw error;
  }
}
module.exports={addGuestWithAllocation};
