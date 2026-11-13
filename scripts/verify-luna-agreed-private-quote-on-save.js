'use strict';

/**
 * Case e2: a private-room quote (€299 package + €60 surcharge) must be what
 * the saved booking stores, even when the save request says package_none and
 * the room is private-optional. A price mismatch warns and still saves.
 * A taken bed still refuses.
 *
 * Run: node scripts/verify-luna-agreed-private-quote-on-save.js
 */

const assert = require('node:assert/strict');
const {
  buildWolfhouseOfferRevision,
} = require('./lib/luna-front-desk-accommodation-availability-service');
const {
  BOOKING_CREATE_CHANNELS,
  executeWolfhouseBookingCreate,
} = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { applyAgreedQuoteIdentity } = require('./lib/luna-agreed-quote-on-save');

const agreedQuote = {
  success: true,
  package_code: 'malibu',
  room_type: 'private',
  room_preference: 'private',
  currency: 'EUR',
  total_cents: 35900,
  deposit_required_cents: 20000,
  payment_link_amount_cents: 20000,
  balance_due_cents: 35900,
  line_items: [
    { code: 'package', label: 'Malibu (summer, 6 nights, 1 guest)', total_cents: 29900 },
    { code: 'room_supplement', label: 'private room supplement (10€/night × 6n, per booking)', total_cents: 6000, nights: 6 },
  ],
  per_person: [{
    guest_number: 1,
    package_code: 'malibu',
    accommodation_cents: 29900,
    supplement_cents: 6000,
    subtotal_cents: 35900,
    deposit_cents: 20000,
    payment_status: 'not_requested',
  }],
};

const accepted = buildWolfhouseOfferRevision({
  client_slug: 'wolfhouse-somo',
  check_in: '2027-09-27',
  check_out: '2027-10-03',
  guest_count: 1,
  guest_bed_assignments: [{ guest_index: 0, guest_name: 'Ale Test Sia', bed_code: 'R7-1' }],
  room_arrangement: [{ bed_code: 'R7-1', room_code: 'R7' }],
  room_type: 'private',
  room_preference: 'private',
  package_code: 'malibu',
  guest_packages: [],
  add_ons: [],
  total_cents: 35900,
  deposit_required_cents: 20000,
  payment_link_amount_cents: 20000,
  currency: 'EUR',
  payment_choice: 'deposit',
  availability_checked: true,
});

function capturingPg(opts) {
  const calls = [];
  const occupied = opts && opts.occupied;
  return {
    calls,
    query: async (sql, params) => {
      const text = String(sql);
      calls.push({ text, params: params || [] });
      if (/^BEGIN/i.test(text) || /^COMMIT/i.test(text) || /^ROLLBACK/i.test(text)) return { rows: [] };
      if (text.includes('offer_idempotency_lookup')) return { rows: [] };
      if (occupied && /offer_room_lock|bed_calendar_blocks|assignment_start_date/i.test(text)
        && !/inserted_booking/i.test(text)) {
        return { rows: [{ bed_code: 'R7-1' }] };
      }
      if (text.includes('selling_mode')) {
        return { rows: [{ id: 'room-7', selling_mode: 'private_optional' }] };
      }
      if (text.includes('FROM wh_pricing_seasons s')) {
        return { rows: [{
          code: 'summer', active: true, bookable: true, priority: 0, sort_order: 1,
          ranges: [{ start_month: 1, start_day: 1, end_month: 12, end_day: 31 }],
        }] };
      }
      if (text.includes('FROM rooms r') || text.includes('offer_commit_reread') || text.includes('offer_room_lock')) {
        return { rows: [{
          bed_code: 'R7-1', room_code: 'R7', gender_strategy: 'mixed', bed_active: true,
          bed_sellable: true, room_type: 'shared', selling_mode: 'private_optional', occupied: false,
        }] };
      }
      if (text.includes('wh_pricing_rules') || text.includes('wh_pricing_items') || text.includes('offer_price_lock')) {
        return { rows: [] };
      }
      if (/inserted_booking_beds|is_duplicate|is_blocked|beds_inserted/i.test(text)) {
        if (occupied) {
          return { rows: [{ is_blocked: true, block_reason: 'overlap_conflict', beds_inserted: 0 }] };
        }
        return { rows: [{
          is_duplicate: false, is_blocked: false,
          booking_id: 'saved-private-1', booking_code: 'WH-20270927-14029143',
          beds_inserted: 1, payments_inserted: 1,
        }] };
      }
      if (text.includes('UPDATE payments')) return { rows: [{ payment_id: 'pay-private-1' }] };
      return { rows: [] };
    },
  };
}

function saveCommand() {
  return {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    requireOfferIdentity: true,
    actor: { staff_user_id: 'luna-bot-internal', staff_role: 'operator' },
    pkgCtx: { isNoPackage: true, quotePackageCode: 'package_none', storagePackageCode: null },
    usesPerGuestModel: false,
    checkIn: '2027-09-27',
    checkOut: '2027-10-03',
    quoteGuestCount: 1,
    guestName: 'Ale Test Sia',
    assignedBedCodes: ['R7-1'],
    roomType: 'shared',
    roomPreference: 'mixed',
    effectivePackageCode: 'package_none',
    storagePackageCode: null,
    paymentChoice: 'deposit',
    paymentKind: 'deposit_only',
    perGuestPaymentLinks: false,
    paymentLinkAmountCents: 20000,
    depositCents: 20000,
    totalCents: 99900,
    quote: {
      success: true,
      package_code: 'package_none',
      room_type: 'shared',
      total_cents: 99900,
      deposit_required_cents: 30000,
      payment_link_amount_cents: 30000,
      balance_due_cents: 99900,
      currency: 'EUR',
      line_items: [{ code: 'accommodation_only', label: 'No package (Malibu 6-night ref)', total_cents: 29900 }],
    },
    notes: '',
    guestsNorm: { guests: [{ guest_name: 'Ale Test Sia' }] },
    authoritativeRoomRows: [
      { bed_code: 'R7-1', room_code: 'R7', room_type: 'shared', selling_mode: 'private_optional', gender_strategy: 'mixed' },
    ],
    allocationReason: 'explicit_selection',
    availabilityProvenance: true,
    availabilityChecked: true,
    transportBody: {
      always_save_accepted_booking: true,
      package_code: 'package_none',
      room_type: 'shared',
      accepted_quote: agreedQuote,
      accepted_offer: accepted,
      guests: [{ name: 'Ale Test Sia' }],
    },
  };
}

(async () => {
  const savePg = capturingPg();
  const saved = await executeWolfhouseBookingCreate(savePg, saveCommand(), {
    privateRoomHooks: {
      enabled: (type) => String(type || '').toLowerCase() === 'private',
      syncPrivateRoomBlocks: async () => ({ ok: true, blocked_beds: ['R7-2'] }),
    },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved && saved.body || saved));
  assert.equal(saved.status, 201);
  assert.notEqual(saved.body && saved.body.reason_code, 'offer_terms_changed');
  assert.notEqual(saved.body && saved.body._blocked, true);

  const insert = savePg.calls.find((row) => /inserted_booking_beds|beds_inserted/i.test(row.text));
  assert.ok(insert, 'create SQL must run');
  assert.equal(insert.params[13], 'malibu', 'saved package_code must be the agreed package, not package_none');
  assert.equal(insert.params[14], 'private', 'saved room type must be the agreed private sale');
  assert.equal(insert.params[18], 35900, 'saved total must be the agreed €299 + €60, not the re-check');
  assert.equal(insert.params[17], 20000, 'saved deposit must stay the agreed deposit');
  assert.equal(insert.params.includes(99900), false, 're-check total must not be stored');
  const note = insert.params.find((value) => typeof value === 'string' && /Agreed package kept/.test(value));
  assert.ok(note, 'staff notes must warn that the agreed package was kept');
  assert.match(note, /private/);

  const metaCall = savePg.calls.find((row) => /UPDATE bookings/i.test(row.text) && row.text.includes('quote snapshot') === false && row.text.includes('metadata ||'));
  assert.ok(metaCall, 'booking metadata must be written');
  const meta = JSON.parse(metaCall.params[4]);
  assert.equal(meta.package_code, 'malibu');
  assert.equal(meta.accommodation_only, false);
  const lines = meta.quote_snapshot.line_items || [];
  const supplement = lines.find((line) => line.code === 'room_supplement');
  const packageLine = lines.find((line) => line.code === 'package' || line.code === 'package_proration');
  assert.ok(packageLine, 'quote snapshot must keep the agreed package line');
  assert.equal(packageLine.total_cents, 29900);
  assert.equal(lines.some((line) => line.code === 'accommodation_only'), false);
  assert.ok(supplement, 'quote snapshot must keep the private surcharge');
  assert.equal(supplement.total_cents, 6000);
  assert.equal(meta.quote_snapshot.package_code, 'malibu');
  assert.equal(meta.quote_snapshot.room_type, 'private');
  assert.equal(meta.quote_snapshot.total_cents, 35900);
  assert.ok(meta.booking_check_warnings.includes('agreed_quote_package_kept'));
  assert.ok(meta.booking_check_warnings.includes('agreed_private_surcharge_kept'));
  assert.equal(metaCall.params[0], 35900);
  console.log('PASS save: private-optional room keeps agreed package, €60 surcharge, and warns');

  const takenPg = capturingPg({ occupied: true });
  const taken = await executeWolfhouseBookingCreate(takenPg, saveCommand(), {
    privateRoomHooks: {
      enabled: () => true,
      syncPrivateRoomBlocks: async () => ({ ok: true }),
    },
  });
  assert.equal(taken.ok, false, JSON.stringify(taken && taken.body || taken));
  assert.equal(taken.body && taken.body._blocked, true);
  assert.equal(taken.body && taken.body.block_reason, 'overlap_conflict');
  assert.ok(takenPg.calls.some((row) => /^ROLLBACK/i.test(row.text)), 'overlap must roll the save back');
  console.log('PASS save: taken bed still refuses');

  const offerOnly = {
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    clientSlug: 'wolfhouse-somo',
    roomType: 'shared',
    roomPreference: 'mixed',
    effectivePackageCode: 'package_none',
    storagePackageCode: null,
    totalCents: 29900,
    depositCents: 20000,
    paymentLinkAmountCents: 20000,
    quote: {
      package_code: 'package_none',
      room_type: 'shared',
      total_cents: 29900,
      deposit_required_cents: 20000,
      payment_link_amount_cents: 20000,
      balance_due_cents: 29900,
      line_items: [{ code: 'accommodation_only', total_cents: 29900 }],
    },
    transportBody: {
      accepted_quote: {
        package_code: 'package_none',
        room_type: 'shared',
        total_cents: 29900,
        deposit_required_cents: 20000,
        payment_link_amount_cents: 20000,
        balance_due_cents: 29900,
      },
      accepted_offer: { room_type: 'private', package_code: 'malibu', total_cents: 35900 },
    },
  };
  applyAgreedQuoteIdentity(offerOnly);
  assert.equal(offerOnly.roomType, 'shared', 'an offer-only private flag must not flip a shared save');
  assert.equal(offerOnly.agreedPrivateRestored, undefined);
  console.log('PASS identity: private type is copied only from the accepted quote');

  async function saveDespiteHook(label, syncPrivateRoomBlocks) {
    const pg = capturingPg();
    const savedDespite = await executeWolfhouseBookingCreate(pg, saveCommand(), {
      privateRoomHooks: {
        enabled: (type) => String(type || '').toLowerCase() === 'private',
        syncPrivateRoomBlocks,
      },
    });
    assert.equal(savedDespite.ok, true, `${label}: ${JSON.stringify(savedDespite && savedDespite.body || savedDespite)}`);
    assert.equal(savedDespite.status, 201, label);
    assert.notEqual(savedDespite.body && savedDespite.body._blocked, true, label);
    assert.notEqual(savedDespite.body && savedDespite.body.block_reason, 'private_room_room_not_empty', label);
    assert.equal(savedDespite.body && savedDespite.body.booking_id, 'saved-private-1', label);
    const warnings = savedDespite.body && savedDespite.body.booking_check_warnings || [];
    assert.ok(warnings.includes('agreed_private_room_block_warning'), `${label} must warn staff`);
    assert.ok(warnings.includes('agreed_quote_package_kept'), label);
    const conflictInsert = pg.calls.find((row) => /inserted_booking_beds|beds_inserted/i.test(row.text));
    assert.ok(conflictInsert, `${label} must still insert`);
    assert.equal(conflictInsert.params[13], 'malibu', label);
    assert.equal(conflictInsert.params[14], 'private', label);
    assert.equal(conflictInsert.params[18], 35900, label);
    assert.equal(pg.calls.some((row) => /^ROLLBACK\s*$/i.test(String(row.text).trim())), false, `${label} must not roll the booking back`);
    assert.ok(pg.calls.some((row) => /^COMMIT/i.test(row.text)), `${label} must commit`);
    console.log(`PASS save: shared/package_none with accepted-private mismatch still saves when hooks ${label}`);
  }

  await saveDespiteHook('conflict', async () => ({ error: 'private_room_room_not_empty' }));
  await saveDespiteHook('throw', async () => {
    throw new Error('private_room_room_not_empty');
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
