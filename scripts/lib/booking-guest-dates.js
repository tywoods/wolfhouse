'use strict';

const { calculateWolfhouseQuote } = require('./wolfhouse-quote-calculator');
const { EDIT_PREVIEW_ACCOMM_LINE_CODES } = require('./booking-invoice-totals');

/**
 * Guest-only stay edit. Caller owns authentication/ACL and supplies a RESERVED pg
 * client (no existing transaction) plus the current Admin-overlay quoteConfig.
 * Never loads disk defaults or calls external services. No schema migration.
 *
 * editGuestDates(pg, {
 *   client_slug, booking_id?, booking_code?, booking_guest_id,
 *   check_in, check_out, expected_check_in, expected_check_out, idempotency_key?
 * }, { quoteConfig }) -> Promise<{status, body}>.
 * If both booking identifiers are supplied, BOTH must match. Expected dates refer
 * to the selected assignment, not the booking envelope. Same-value retries are
 * no-ops even with old expected dates. A supplied idempotency key is durably bound
 * to the full command in booking metadata; reusing it for another command fails.
 *
 * Success body: {success:true, updated, idempotent, edit_type:'guest_dates',
 *   booking_guest_id, booking, guest, before, after, per_person, quote_context,
 *   invoice_impact}. Failure: {success:false,updated:false,error,...}.
 * Money is a delta against STORED guest accommodation and subtotal; add-ons,
 * supplement shares, deposits, paid amounts, payments and services never change.
 * Missing historic basis is a rejection, not a new quote of the old stay.
 *
 * Lock order: booking -> guests -> assignments -> inventory room/beds. Other
 * availability writers must participate in inventory locking for race freedom;
 * this module alone cannot retrofit legacy writers with exclusion constraints.
 * Holds block until status actually becomes expired/cancelled (even past expiry).
 * Existing private-room blocks are not silently extended: date changes outside
 * their current reservation envelope require a separate room-level operation.
 */
async function editGuestDates(pg, body = {}, options = {}) {
  let inTransaction = false;
  try {
    const cmd = normalize(body);
    await pg.query('BEGIN');
    inTransaction = true;
    const bookingRows = await pg.query(`SELECT b.*, b.id::text AS booking_id,
        b.check_in::text AS check_in, b.check_out::text AS check_out
      FROM bookings b JOIN clients c ON c.id=b.client_id
      WHERE c.slug=$1 AND ($2::text IS NULL OR b.id::text=$2)
        AND ($3::text IS NULL OR b.booking_code=$3) FOR UPDATE OF b`,
    [cmd.client_slug, cmd.booking_id, cmd.booking_code]);
    if (bookingRows.rows.length !== 1) fail(404, 'booking_not_found');
    const booking = bookingRows.rows[0];
    if (!['confirmed','hold','payment_pending','needs_review','checked_in'].includes(booking.status)) fail(409, 'booking_not_editable');
    const guests = (await pg.query(`SELECT bg.* FROM booking_guests bg
      WHERE bg.client_id=$1 AND bg.booking_id=$2 ORDER BY bg.id FOR UPDATE`, [booking.client_id, booking.id])).rows;
    const guest = guests.find(g => g.id === cmd.booking_guest_id);
    if (!guest) fail(404, 'guest_not_found');
    const assignments = (await pg.query(`SELECT bb.*, bb.assignment_start_date::text AS check_in,
      bb.assignment_end_date::text AS check_out FROM booking_beds bb
      WHERE bb.client_id=$1 AND bb.booking_id=$2 ORDER BY bb.id FOR UPDATE`, [booking.client_id, booking.id])).rows;
    const bedCode = guest.assigned_bed_code;
    // 024 has assigned_bed_code, not assigned_bed_id. SELECT bg.* also supports
    // installations with a later ID column, or a persisted metadata ID.
    const bedId = guest.assigned_bed_id || object(guest.metadata).assigned_bed_id;
    const matches = assignments.filter(a => !isBlock(a) && (bedCode || bedId)
      && (!bedCode || a.bed_code === bedCode) && (!bedId || a.bed_id === bedId));
    if (matches.length !== 1) fail(409, 'guest_assignment_ambiguous');
    const assignment = matches[0];
    if (guests.some(g => g.id !== guest.id && ((g.assigned_bed_code && g.assigned_bed_code === assignment.bed_code)
      || (g.assigned_bed_id || object(g.metadata).assigned_bed_id) === assignment.bed_id))) fail(409, 'guest_assignment_ambiguous');
    const md = object(booking.metadata), gm = object(guest.metadata);
    const before = stay(assignment.check_in, assignment.check_out);
    const after = stay(cmd.check_in, cmd.check_out);
    const unchanged = before.check_in === after.check_in && before.check_out === after.check_out;
    const fingerprint = JSON.stringify([cmd.booking_guest_id,cmd.check_in,cmd.check_out,cmd.expected_check_in,cmd.expected_check_out]);
    const edits = Array.isArray(md.guest_date_edits) ? md.guest_date_edits : [];
    const prior = cmd.idempotency_key && edits.find(e => e.key === cmd.idempotency_key);
    if (prior && (prior.fingerprint !== fingerprint || !unchanged)) fail(409, 'idempotency_conflict');
    if (unchanged) {
      await pg.query('COMMIT'); inTransaction = false;
      return success(booking, guest, before, after, false, storedPeople(md), 0, null);
    }
    if (before.check_in !== cmd.expected_check_in || before.check_out !== cmd.expected_check_out) {
      fail(409, 'stale_guest_dates', { current: before });
    }
    const inventory = await lockDateInventory(pg, booking.client_id, [assignment.bed_id]);
    const bed = inventory.find(b => b.id === assignment.bed_id);
    if (!bed || bed.active !== true || bed.sellable !== true || bed.room_active !== true) fail(409, 'bed_not_sellable');
    if ((bedCode && bed.bed_code !== bedCode) || (guest.assigned_room_code && guest.assigned_room_code !== bed.inventory_room_code)) fail(409, 'guest_assignment_ambiguous');
    const ownPrivate = dateRoomIsPrivate(booking, assignments, bed);
    if (ownPrivate && (after.check_in < booking.check_in || after.check_out > booking.check_out)) fail(409, 'private_room_reservation_requires_review');
    const conflicts = await dateInventoryConflicts(pg, booking.client_id, booking.id, bed,
      after.check_in, after.check_out, ownPrivate, assignment.id);
    if (conflicts.length) fail(409,'date_conflict',{conflicts});

    const people = storedPeople(md);
    const personMatches = people.filter(p => Number(p.guest_number) === Number(guest.guest_number));
    if (personMatches.length > 1) fail(409,'pricing_basis_unavailable');
    const person = personMatches[0] || {};
    const oldSubtotal = money(gm.subtotal_cents) ?? money(person.subtotal_cents);
    let oldAccommodation = money(gm.accommodation_cents) ?? money(person.accommodation_cents);
    if (oldAccommodation == null && oldSubtotal != null && money(person.addons_cents) != null && money(person.supplement_cents) != null) {
      oldAccommodation = oldSubtotal - person.addons_cents - person.supplement_cents;
    }
    if (oldSubtotal == null || oldAccommodation == null || oldAccommodation < 0 || oldAccommodation > oldSubtotal
      || money(booking.total_amount_cents) == null) fail(409,'pricing_basis_unavailable');
    const currentPackages = md.guest_packages;
    const currentMatches = Array.isArray(currentPackages)
      ? currentPackages.filter(p => p && Number(p.guest_number) === Number(guest.guest_number)) : [];
    // The drawer's saved identity wins; historical rows supply OLD money only.
    // An explicit but incomplete/ambiguous current map must not revive old identity.
    if (currentPackages != null && (!Array.isArray(currentPackages) || currentMatches.length !== 1
      || typeof currentMatches[0].package_code !== 'string' || !currentMatches[0].package_code.trim())) fail(409,'current_guest_package_unavailable');
    const rawPackage = currentMatches.length ? currentMatches[0].package_code
      : Object.hasOwn(gm,'package_code') ? gm.package_code
      : Object.hasOwn(person,'package_code') ? person.package_code : booking.package_code;
    const packageCode = String(rawPackage || 'no_package').trim().toLowerCase();
    const quoteConfig = options && options.quoteConfig;
    if (!quoteConfig || quoteConfig.client_slug !== cmd.client_slug || !Array.isArray(quoteConfig.packages)
      || !Array.isArray(quoteConfig.seasons)) fail(422,'pricing_unavailable');
    let quote;
    try {
      quote = calculateWolfhouseQuote({ client_slug:cmd.client_slug, check_in:after.check_in,check_out:after.check_out,
        guest_count:1,package_code:packageCode,room_type:'shared',payment_choice:'deposit',add_ons:[] }, quoteConfig);
    } catch (_) { fail(422,'pricing_unavailable'); }
    const accLines = quote && Array.isArray(quote.line_items) ? quote.line_items.filter(l => accommodationLine(l)) : [];
    if (!quote || !quote.success || !accLines.length || accLines.some(l => money(l.total_cents) == null)) {
      fail(422,'pricing_unavailable',{blockers:quote && quote.blockers || []});
    }
    const accommodation = accLines.reduce((sum,l)=>sum+l.total_cents,0);
    const delta = accommodation-oldAccommodation, subtotal=oldSubtotal+delta;
    const total=booking.total_amount_cents+delta;
    if (money(total) == null || money(subtotal) == null) fail(409,'pricing_basis_unavailable');
    // A clamped old balance loses overpayment credit; derive the new balance
    // from unchanged stored paid cents, not old balance + delta.
    const paid = money(booking.amount_paid_cents);
    const balance = paid != null ? Math.max(0,total-paid)
      : Math.max(0,(integer(booking.balance_due_cents) ?? booking.total_amount_cents)+delta);
    const guestMetadata = { ...gm,...after,subtotal_cents:subtotal,accommodation_cents:accommodation,
      guest_dates_price_basis:{old_accommodation_cents:oldAccommodation,old_subtotal_cents:oldSubtotal,delta_cents:delta,
        config_version:quoteConfig.config_version || null,package_code:rawPackage || null} };
    const updatedPerson = { ...person,guest_number:guest.guest_number,guest_name:guest.guest_name,package_code:rawPackage || null,
      ...after,accommodation_cents:accommodation,subtotal_cents:subtotal,deposit_cents:guest.deposit_amount_cents,
      amount_paid_cents:guest.amount_paid_cents,balance_cents:Math.max(0,subtotal-guest.amount_paid_cents),payment_status:guest.payment_status };
    // No averaging and no requoting siblings; use existing rows byte-for-byte.
    const projected = people.length ? people.map(p => Number(p.guest_number)===Number(guest.guest_number)?updatedPerson:p) : guests.map(g => {
      if(g.id===guest.id) return updatedPerson;
      const m=object(g.metadata);
      if(money(m.subtotal_cents)==null || money(m.accommodation_cents)==null) fail(409,'pricing_basis_unavailable');
      return { ...m,guest_number:g.guest_number,guest_name:g.guest_name,deposit_cents:g.deposit_amount_cents,amount_paid_cents:g.amount_paid_cents };
    });
    if (guests.some(g => projected.filter(p=>Number(p.guest_number)===Number(g.guest_number)).length!==1)) fail(409,'pricing_basis_unavailable');
    // Freeze implicit legacy stays before changing the group envelope. Keep sibling
    // rows and historical shares byte-identical, including guests not yet assigned.
    const guestWindows = {};
    for (const g of guests) {
      const meta = g.metadata || {};
      const matches = assignments.filter(a =>
        (g.assigned_bed_code && a.bed_code === g.assigned_bed_code) ||
        (meta.assigned_bed_id && String(a.bed_id) === String(meta.assigned_bed_id)));
      const stored = (md.guest_stay_windows || {})[g.id] || {};
      const window = g.id === guest.id ? after : matches.length === 1 ? matches[0] : {
        check_in: meta.check_in || stored.check_in || booking.check_in,
        check_out: meta.check_out || stored.check_out || booking.check_out,
      };
      if (!validDate(window.check_in) || !validDate(window.check_out) || window.check_out <= window.check_in) fail(409,'guest_stay_window_unavailable');
      guestWindows[g.id] = { check_in: window.check_in, check_out: window.check_out };
    }
    const envelope = assignments.map(a => a.id === assignment.id ? after : {check_in:a.check_in,check_out:a.check_out})
      .concat(Object.values(guestWindows));
    const envelopeIn=envelope.map(a=>a.check_in).sort()[0], envelopeOut=envelope.map(a=>a.check_out).sort().at(-1);
    const snapshot = object(md.quote_snapshot);
    // Retain non-accommodation lines, alter only the accommodation aggregate by
    // this guest's delta. Explicit per_person is the authoritative projection.
    const lineItems = Array.isArray(snapshot.line_items) ? snapshot.line_items : [];
    // Installing accommodation lines makes the snapshot authoritative to invoice
    // collectors. Without historical allocations we cannot distinguish embedded
    // services, supplements and discounts safely: reject before any writes.
    if (!lineItems.length || lineItems.some(l=>!l || typeof l.code!=='string' || money(l.total_cents)==null)) {
      fail(409,'invoice_allocation_unavailable');
    }
    const historicalAccLines = lineItems.filter(accommodationLine);
    const historicalAcc = historicalAccLines.reduce((s,l)=>s+l.total_cents,0);
    const allocatedTotal = lineItems.reduce((s,l)=>s+l.total_cents,0);
    const invoiceAccommodation = lineItems.filter(l=>Object.hasOwn(EDIT_PREVIEW_ACCOMM_LINE_CODES,l.code))
      .reduce((s,l)=>s+l.total_cents,0);
    const accommodationTotal = historicalAcc+delta;
    // Equality is also normal complete accommodation/package-only history. Prove
    // its existing guest allocation, rather than inventing shares or treating every
    // total-minus-services consumer branch as missing history. With no service rows
    // and positive old/new totals that branch preserves exactly the selected delta.
    let completeAccommodationOnly = false;
    if (historicalAcc===booking.total_amount_cents && invoiceAccommodation===historicalAcc
      && people.length===guests.length && people.every(p=>money(p.accommodation_cents)!=null
        && p.subtotal_cents===p.accommodation_cents && p.addons_cents===0 && p.supplement_cents===0)
      && people.reduce((s,p)=>s+p.accommodation_cents,0)===historicalAcc
      && person.accommodation_cents===oldAccommodation && person.subtotal_cents===oldSubtotal) {
      const services = await pg.query(`SELECT id FROM booking_service_records
        WHERE client_slug=$1 AND (booking_id=$2 OR booking_code=$3) LIMIT 1`,[cmd.client_slug,booking.id,booking.booking_code]);
      completeAccommodationOnly = services.rows.length===0;
    }
    // All other histories must remain strictly inside the explicit-line branch.
    // Missing/zero/unreconciled history and ambiguous embedded services fail closed.
    if (allocatedTotal!==booking.total_amount_cents || historicalAcc<=0
      || invoiceAccommodation<=0 || money(accommodationTotal)==null || invoiceAccommodation+delta<=0
      || (!completeAccommodationOnly && (invoiceAccommodation>=booking.total_amount_cents
        || invoiceAccommodation+delta>=total))) fail(409,'invoice_allocation_unavailable');
    const projectedSnapshot = { ...snapshot,...stay(envelopeIn,envelopeOut),guest_count:booking.guest_count,
      per_person:projected,total_cents:total,subtotal_cents:total+(money(snapshot.discount_cents)||0),
      amount_paid_cents:booking.amount_paid_cents,balance_due_cents:balance,deposit_required_cents:booking.deposit_required_cents,
      line_items:[...lineItems.filter(l=>!accommodationLine(l)),{code:'accommodation_only',total_cents:accommodationTotal,
        description:'Stored per-guest accommodation projection',source:'guest_dates_projection'}],
      source:'guest_dates_projection',per_guest_dates:true };
    const context={booking_guest_id:guest.id,...after,package_code:rawPackage || null,old_accommodation_cents:oldAccommodation,
      accommodation_cents:accommodation,old_subtotal_cents:oldSubtotal,subtotal_cents:subtotal,delta_cents:delta,
      deposit_amount_cents:guest.deposit_amount_cents,deposit_required_cents:booking.deposit_required_cents,
      quote_config_version:quoteConfig.config_version || null,season_code:quote.season_code,line_items:accLines,per_person:projected};
    const metadata={...md,guest_stay_windows:guestWindows,quote_snapshot:projectedSnapshot,per_person:projected,guest_dates_quote_context:context,
      guest_date_edits:cmd.idempotency_key?[...edits,{key:cmd.idempotency_key,fingerprint}]:edits};
    const bedUpdate=await pg.query(`UPDATE booking_beds SET assignment_start_date=$4::date,assignment_end_date=$5::date,updated_at=NOW()
      WHERE client_id=$1 AND booking_id=$2 AND id=$3 RETURNING id`,[booking.client_id,booking.id,assignment.id,after.check_in,after.check_out]);
    const guestUpdate=await pg.query(`UPDATE booking_guests SET metadata=$4::jsonb,updated_at=NOW()
      WHERE client_id=$1 AND booking_id=$2 AND id=$3 RETURNING *`,[booking.client_id,booking.id,guest.id,JSON.stringify(guestMetadata)]);
    const bookingUpdate=await pg.query(`UPDATE bookings SET check_in=$3::date,check_out=$4::date,total_amount_cents=$5,
      balance_due_cents=$6,metadata=$7::jsonb,updated_at=NOW() WHERE client_id=$1 AND id=$2
      RETURNING *,id::text AS booking_id,check_in::text AS check_in,check_out::text AS check_out`,
    [booking.client_id,booking.id,envelopeIn,envelopeOut,total,balance,JSON.stringify(metadata)]);
    if(bedUpdate.rows.length!==1 || guestUpdate.rows.length!==1 || bookingUpdate.rows.length!==1) throw Error('Unexpected update cardinality');
    await pg.query('COMMIT'); inTransaction=false;
    return success(bookingUpdate.rows[0],guestUpdate.rows[0],before,after,true,projected,delta,context);
  } catch (err) {
    if(inTransaction) { try {await pg.query('ROLLBACK');} catch (_) { /* Return failure, never successful mutation. */ } }
    return {status:err.guestDatesStatus || 500,body:{success:false,updated:false,error:err.guestDatesCode || 'guest_dates_update_failed',...(err.guestDatesDetails || {})}};
  }
}

function fail(status,code,details) {const e=new Error(code);e.guestDatesStatus=status;e.guestDatesCode=code;e.guestDatesDetails=details;throw e;}
function object(value) {return value && typeof value==='object' && !Array.isArray(value)?value:{};}
function integer(value) {return Number.isSafeInteger(value)?value:null;}
function money(value) {return integer(value)!=null && value>=0?value:null;}
function validDate(s) {return typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && s>='0001-01-01' && Number.isFinite(Date.parse(s+'T00:00:00Z')) && new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;}
function stay(check_in,check_out) {return {check_in,check_out,nights:Math.round((Date.parse(check_out+'T00:00:00Z')-Date.parse(check_in+'T00:00:00Z'))/86400000)};}
function isBlock(a) {return ['private_room_block','operator_block'].includes(a.assignment_type);}
function accommodationLine(l) {return ['package','package_proration','accommodation_only','manual_accommodation','guest_package','guest_package_proration','guest_accommodation_only'].includes(l.code);}
function storedPeople(md) {return Array.isArray(object(md.quote_snapshot).per_person)?md.quote_snapshot.per_person:Array.isArray(md.per_person)?md.per_person:[];}
function isPrivate(b) {
  const m=object(b.metadata),s=object(m.quote_snapshot);
  return /(?:couple_private|private_room|private|double|matrimonial)/i.test(`${b.room_preference || ''} ${b.requested_room_type || ''}`)
    || m.private_room_enabled===true || (Array.isArray(s.line_items) && s.line_items.some(l=>l && l.code==='room_supplement' && l.total_cents>0));
}
function privateSql(alias) {
  return `(LOWER(CONCAT_WS(' ',${alias}.room_preference,${alias}.requested_room_type)) ~ '(couple_private|private_room|private|double|matrimonial)'
    OR ${alias}.metadata->>'private_room_enabled'='true'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${alias}.metadata->'quote_snapshot'->'line_items')='array'
      THEN ${alias}.metadata->'quote_snapshot'->'line_items' ELSE '[]'::jsonb END) li
      WHERE li->>'code'='room_supplement' AND li->>'total_cents' ~ '^[0-9]+$' AND (li->>'total_cents')::numeric>0))`;
}
function normalize(body) {
  if(!body || typeof body!=='object') fail(400,'invalid_request');
  const cmd={};
  for(const key of ['client_slug','booking_id','booking_code','booking_guest_id','check_in','check_out','expected_check_in','expected_check_out','idempotency_key']) {
    if(body[key]!=null && typeof body[key]!=='string') fail(400,'invalid_request');
    cmd[key]=typeof body[key]==='string'?body[key].trim():null;
  }
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!cmd.client_slug || cmd.client_slug.length>100 || (!cmd.booking_id && !cmd.booking_code) || !uuid.test(cmd.booking_guest_id || '')
    || (cmd.booking_id && !uuid.test(cmd.booking_id)) || (cmd.booking_code && cmd.booking_code.length>200)
    || (cmd.idempotency_key && cmd.idempotency_key.length>200)
    || !['check_in','check_out','expected_check_in','expected_check_out'].every(k=>validDate(cmd[k]))
    || cmd.check_in>=cmd.check_out || cmd.expected_check_in>=cmd.expected_check_out) fail(400,'invalid_request');
  cmd.booking_id=cmd.booking_id?cmd.booking_id.toLowerCase():null;cmd.booking_code=cmd.booking_code || null;
  cmd.booking_guest_id=cmd.booking_guest_id.toLowerCase();return cmd;
}
function success(booking,guest,before,after,updated,per_person,delta,context) {
  return {status:200,body:{success:true,updated,idempotent:!updated,edit_type:'guest_dates',booking_guest_id:guest.id,
    booking,guest,before,after,per_person,quote_context:context || object(booking.metadata).guest_dates_quote_context || null,
    invoice_impact:{delta_cents:delta,total_amount_cents:booking.total_amount_cents,balance_due_cents:booking.balance_due_cents,
      deposit_required_cents:booking.deposit_required_cents,deposit_amount_cents:guest.deposit_amount_cents}}};
}
// Shared by both date writers. Call only after booking -> guests -> assignments
// locks. Lock rooms by ID first, then ALL their beds by ID, including empty beds.
// Availability MUST be read in a subsequent statement after these locks return.
async function lockDateInventory(pg, clientId, bedIds) {
  const rooms = (await pg.query(`SELECT r.id FROM rooms r
    WHERE r.client_id=$1 AND r.id IN (SELECT room_id FROM beds WHERE client_id=$1 AND id=ANY($2::uuid[]))
    ORDER BY r.id FOR UPDATE`, [clientId,bedIds])).rows;
  return (await pg.query(`SELECT bed.*,r.active AS room_active,r.room_code AS inventory_room_code
    FROM beds bed JOIN rooms r ON r.id=bed.room_id AND r.client_id=bed.client_id
    WHERE bed.client_id=$1 AND bed.room_id=ANY($2::uuid[])
    ORDER BY bed.id FOR UPDATE OF bed`, [clientId,rooms.map(r=>r.id)])).rows;
}
function dateRoomIsPrivate(booking, assignments, bed) {
  return isPrivate(booking) || assignments.some(a => a.assignment_type === 'private_room_block' && a.room_code === bed.inventory_room_code);
}
// Bounded shared occupancy predicate for the two date writers only. Call after
// lockDateInventory returns, in a fresh statement. A guest edit also checks its
// same-booking siblings; a whole-booking legacy move excludes its own assignments.
async function dateInventoryConflicts(pg, clientId, bookingId, bed, checkIn, checkOut, ownPrivate, assignmentId=null) {
  const conflicts = (await pg.query(`SELECT bb.id::text AS booking_bed_id,b.booking_code,bb.bed_code,
      bb.assignment_start_date::text AS check_in,bb.assignment_end_date::text AS check_out
    FROM booking_beds bb JOIN bookings b ON b.id=bb.booking_id AND b.client_id=bb.client_id
    JOIN beds other_bed ON other_bed.id=bb.bed_id AND other_bed.client_id=bb.client_id
    WHERE bb.client_id=$1 AND (bb.booking_id<>$7 OR ($2::uuid IS NOT NULL AND bb.id<>$2))
      AND b.status::text NOT IN ('cancelled','expired','canceled')
      AND bb.assignment_start_date<$4::date AND bb.assignment_end_date>$3::date
      AND (bb.bed_id=$5 OR (other_bed.room_id=$6 AND bb.booking_id<>$7 AND
        (bb.assignment_type='private_room_block' OR ${privateSql('b')} OR $8::boolean)))
      AND NOT (bb.booking_id=$7 AND bb.assignment_type='private_room_block')`,
  [clientId,assignmentId,checkIn,checkOut,bed.id,bed.room_id,bookingId,ownPrivate])).rows;
  // Whole-room/operator blocks need not have a booking_beds row at all.
  const roomConflicts = (await pg.query(`SELECT b.booking_code,b.check_in::text,b.check_out::text
    FROM bookings b WHERE b.client_id=$1 AND b.id<>$2
      AND b.status::text NOT IN ('cancelled','expired','canceled')
      AND b.check_in<$4::date AND b.check_out>$3::date
      AND ((b.room_to_block_id=$5 AND b.block_type::text='whole_room')
        OR (b.primary_room_code=$6 AND ${privateSql('b')}))`,
  [clientId,bookingId,checkIn,checkOut,bed.room_id,bed.inventory_room_code])).rows;
  return [...conflicts,...roomConflicts];
}
module.exports={editGuestDates,lockDateInventory,dateRoomIsPrivate,dateInventoryConflicts};
