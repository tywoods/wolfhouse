'use strict';
const crypto = require('node:crypto');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function digest(value, length = 32) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('base64url').slice(0, length);
}
function operationKey(context, action, input) {
  return `one-try:${action}:${digest({ session: context.sessionId, turn: context.turnId, input }, 40)}`;
}
function publicFailure(result) {
  const code = result && (result.code || result.reason) || 'unknown';
  const inputCodes = new Set(['needs_clarification', 'room_eligibility_unknown', 'missing_dates_or_guest_count']);
  const ownerCodes = new Set(['STAFF_PRICING_UNAVAILABLE', 'staff_pricing_season_missing', 'staff_deposit_tier_unavailable']);
  return {
    ok: false,
    state: inputCodes.has(code) ? 'needs_input' : ownerCodes.has(code) ? 'owner_data_missing' : code.includes('unavailable') ? 'unavailable' : 'unknown',
    reason: code,
    message: 'I could not safely complete that booking action.',
    next_step: inputCodes.has(code) ? 'ask_guest' : ownerCodes.has(code) ? 'human_review' : 'wait_for_verified_result',
    retry_allowed: false,
    operation_reference: result && result.operationReference || null,
  };
}
function guestRows(input) {
  return input.guests.map((guest) => ({ name: guest.name, explicit_gender: guest.gender || null }));
}
function availabilityPreferences(input) {
  const room = input.room || {};
  return {
    room_type: room.kind === 'private' ? 'double' : room.kind === 'women_only' ? 'female' : room.kind === 'shared' ? 'dorm' : undefined,
    room_preference: room.kind === 'private' ? 'private' : room.name || undefined,
    keep_together: room.together === 'required' ? true : room.together === 'split_ok' ? false : undefined,
    group_gender: room.kind === 'women_only' ? 'female' : undefined,
    guests: guestRows(input),
  };
}
function chooseBeds(input, rooms) {
  const exact = input.room && Array.isArray(input.room.beds) ? input.room.beds : [];
  if (exact.length) return exact;
  if (rooms.splitSelection && Array.isArray(rooms.splitSelection.selectedBedCodes)) return rooms.splitSelection.selectedBedCodes;
  const wantedName = String(input.room && input.room.name || '').toLowerCase();
  const candidate = (rooms.rooms || []).find((room) => !wantedName || String(room.roomId).toLowerCase() === wantedName)
    || (rooms.rooms || [])[0];
  return candidate ? candidate.bedOptions.slice(0, input.guests.length).map((bed) => bed.code) : [];
}
function packageSelection(input, catalog) {
  const packages = catalog.packages || (catalog.items || []).filter((item) => item.item_type === 'package').map((item) => ({ name: item.label, code: item.item_code }));
  const byName = new Map(packages.flatMap((pkg) => [[String(pkg.name || '').toLowerCase(), pkg.code], [String(pkg.code || '').toLowerCase(), pkg.code]]));
  const resolve = (name) => name === 'none' ? 'package_none' : byName.get(String(name || '').toLowerCase());
  if (input.package && Array.isArray(input.package.per_guest)) {
    const rows = input.package.per_guest.map((row) => ({ guest_number: row.guest, package_code: resolve(row.name) }));
    return rows.every((row) => row.package_code) ? { guest_packages: rows } : null;
  }
  const code = resolve(input.package && input.package.name);
  return code ? { package_id: code } : null;
}
function addOns(input, catalog) {
  const all = catalog.items
    ? catalog.items.filter((item) => item.item_type === 'service').map((item) => ({ name: item.label, code: item.item_code }))
    : [...(catalog.services || []), ...(catalog.rentals || [])];
  const byName = new Map(all.flatMap((item) => [[String(item.name || '').toLowerCase(), item.code], [String(item.code || '').toLowerCase(), item.code]]));
  return (input.add_ons || []).map((item) => ({
    code: byName.get(String(item.name || '').toLowerCase()),
    dates: item.dates || item.requested_dates,
    days: (item.dates || item.requested_dates || []).length || undefined,
    quantity: item.quantity ? item.quantity.count : item.people ? item.people.length : 1,
  }));
}
function publicOffer(held, quote, input, reference) {
  return {
    ok: true, state: 'offer', reason: 'held_offer_ready', message: 'This option is temporarily held.', next_step: 'present_offer',
    retry_allowed: false, operation_reference: reference, offer_reference: reference, held: true, booked: false,
    expires_at: held.expiresAt, check_in: input.check_in, check_out: input.check_out,
    guests: input.guests.map((guest, index) => ({ position: index + 1, name: guest.name, bed: held.assignments[index].bedCode, package: held.assignments[index].packageCode })),
    quote: quote.quote, payment_arrangement: input.payment && input.payment.arrangement,
  };
}

function createCheckQuoteBook(deps) {
  return async function checkQuoteBook(pg, input, context) {
    if (!context || !context.turnId) return publicFailure({ code: 'trusted_turn_required' });
    if (input.action === '_record_presented') {
      if (!String(input.assistant_reply || '').trim()) return publicFailure({ code: 'presentation_evidence_required' });
      const recorded = await pg.query(`UPDATE luna_v3_offer_turns ot SET presented_turn_id=$4,presented_at=now()
        FROM clients c,luna_v3_sessions s,luna_v3_holds h
        WHERE c.slug='wolfhouse-somo' AND s.client_id=c.id AND s.session_key=$1 AND s.principal_id=$2
          AND h.id=ot.hold_id AND ot.session_id=s.id AND h.offer_reference=$3 RETURNING h.id`,
      [context.sessionId, context.principalId, input.offer_reference, context.turnId]);
      return recorded.rows[0] ? { ok: true, recorded: true } : publicFailure({ code: 'offer_not_found' });
    }
    if (input.action === 'prepare') {
      const count = input.guests.length;
      const rooms = await deps.findRooms(pg, { check_in: input.check_in, check_out: input.check_out, party_size: count, preferences: availabilityPreferences(input) }, context);
      if (!rooms.ok) return publicFailure(rooms);
      const beds = chooseBeds(input, rooms);
      if (beds.length !== count) return publicFailure({ code: 'requested_room_unavailable' });
      const catalog = await deps.getPricingCatalog(pg, { check_in: input.check_in, check_out: input.check_out }, context);
      if (!catalog.ok) return publicFailure(catalog);
      const packages = packageSelection(input, catalog);
      if (!packages) return { ...publicFailure({ code: 'package_choice_required' }), state: 'needs_choice', next_step: 'ask_guest' };
      const extras = addOns(input, catalog);
      if (extras.some((row) => !row.code)) return publicFailure({ code: 'staff_service_unavailable' });
      const quoteInput = {
        operation_key: operationKey(context, 'prepare-quote', input), check_in: input.check_in, check_out: input.check_out,
        guests: guestRows(input), selection: { selected_bed_codes: beds, bed_ids: beds, room_type: availabilityPreferences(input).room_type, room_preference: availabilityPreferences(input).room_preference, keep_together: availabilityPreferences(input).keep_together },
        ...packages, add_ons: extras,
      };
      const quote = await deps.quote(pg, quoteInput, context);
      if (!quote.ok) return publicFailure(quote);
      const hold = await deps.holdBeds(pg, { operation_key: operationKey(context, 'prepare-hold', input), ...quote.holdInput }, context);
      if (!hold.ok) return publicFailure(hold);
      const reference = `offer_${digest({ session: context.sessionId, hold: hold.holdId }, 36)}`;
      await pg.query('BEGIN');
      try {
        const session = (await pg.query(`SELECT s.id,s.client_id FROM luna_v3_sessions s JOIN clients c ON c.id=s.client_id WHERE c.slug='wolfhouse-somo' AND s.session_key=$1 AND s.principal_id=$2 FOR UPDATE`, [context.sessionId, context.principalId])).rows[0];
        const updated = await pg.query(`UPDATE luna_v3_holds SET offer_reference=$1 WHERE id=$2 AND client_id=$3 AND session_id=$4 AND state='active' RETURNING id`, [reference, hold.holdId, session.client_id, session.id]);
        if (!updated.rows[0]) throw new Error('offer_scope_changed');
        await pg.query(`INSERT INTO luna_v3_offer_turns(client_id,session_id,hold_id,offer_reference,prepared_turn_id) VALUES($1,$2,$3,$4,$5)`, [session.client_id, session.id, hold.holdId, reference, context.turnId]);
        await pg.query('COMMIT');
      } catch (error) { await pg.query('ROLLBACK'); throw error; }
      return publicOffer(hold, quote, input, reference);
    }
    const row = (await pg.query(`SELECT h.id,h.state,h.expires_at,ot.presented_at,ot.presented_turn_id,ot.accepted_at FROM luna_v3_holds h JOIN luna_v3_offer_turns ot ON ot.hold_id=h.id JOIN luna_v3_sessions s ON s.id=h.session_id JOIN clients c ON c.id=h.client_id WHERE c.slug='wolfhouse-somo' AND s.session_key=$1 AND s.principal_id=$2 AND h.offer_reference=$3`, [context.sessionId, context.principalId, input.offer_reference])).rows[0];
    if (!row) return publicFailure({ code: 'offer_not_found' });
    if (input.action === 'decline') {
      const released = await deps.releaseHold(pg, { operation_key: operationKey(context, 'decline', input), hold_id: row.id }, context);
      return released.ok ? { ok: true, state: 'released', reason: 'offer_released', message: 'The temporary hold was released.', next_step: 'report_release', retry_allowed: false, operation_reference: input.offer_reference } : publicFailure(released);
    }
    if (!row.presented_at || !row.presented_turn_id || row.presented_turn_id === context.turnId || row.accepted_at) return publicFailure({ code: 'acceptance_required' });
    const accepted = await pg.query(`UPDATE luna_v3_offer_turns SET accepted_turn_id=$2,accepted_at=now() WHERE offer_reference=$1 AND accepted_at IS NULL AND presented_at IS NOT NULL RETURNING hold_id`, [input.offer_reference, context.turnId]);
    if (!accepted.rows[0]) return publicFailure({ code: 'acceptance_required' });
    const booked = await deps.book(pg, { operation_key: operationKey(context, 'confirm', input), hold_id: row.id }, context);
    if (!booked.ok) return publicFailure(booked);
    return { ok: true, state: 'booked', reason: 'accepted_offer_confirmed', message: 'The booking is confirmed.', next_step: 'report_booking', retry_allowed: false, operation_reference: input.offer_reference, booking_reference: booked.bookingCode, status: 'confirmed', payment_state: 'unpaid' };
  };
}
module.exports = { createCheckQuoteBook, publicFailure, operationKey };
