'use strict';

/**
 * Luna quoted price must survive Staff re-check on save (Ty 20:40).
 * Mismatch → save quoted total/deposit/link + staff flag.
 * Taken bed → still refuse.
 *
 * Run: node scripts/verify-luna-quoted-price-keep-on-save.js
 */
const assert = require('node:assert/strict');
const {
  buildWolfhouseOfferRevision,
  buildCheckedWolfhousePreviewOffer,
  compareAcceptedWolfhouseOffer,
} = require('./lib/luna-front-desk-accommodation-availability-service');
const {
  BOOKING_CREATE_CHANNELS,
  executeWolfhouseBookingCreate,
} = require('./lib/luna-front-desk-accommodation-booking-create-service');

const quoted = {
  client_slug: 'wolfhouse-somo',
  check_in: '2026-10-10',
  check_out: '2026-10-13',
  guest_count: 2,
  guest_bed_assignments: [
    { guest_index: 0, bed_code: 'R1-1' },
    { guest_index: 1, bed_code: 'R1-2' },
  ],
  room_arrangement: [
    { bed_code: 'R1-1', room_code: 'R1' },
    { bed_code: 'R1-2', room_code: 'R1' },
  ],
  room_type: 'shared',
  room_preference: 'mixed',
  allocation_reason: 'explicit_selection',
  package_code: 'malibu',
  guest_packages: [],
  add_ons: [],
  total_cents: 42000,
  deposit_required_cents: 20000,
  payment_link_amount_cents: 20000,
  currency: 'EUR',
  payment_choice: 'deposit',
  payment_distribution: [
    { guest_name: 'Lucia', amount_cents: 10000 },
    { guest_name: 'Carmen', amount_cents: 10000 },
  ],
  availability_checked: true,
};

const accepted = buildWolfhouseOfferRevision(quoted);

const priceOnly = compareAcceptedWolfhouseOffer(
  accepted,
  buildWolfhouseOfferRevision({
    ...quoted,
    total_cents: 99900,
    deposit_required_cents: 30000,
    payment_link_amount_cents: 30000,
  }),
);
assert.equal(priceOnly.ok, true, 'price mismatch must not refuse the save');
assert.equal(priceOnly.price_mismatch, true);
assert.notEqual(priceOnly.reason_code, 'offer_terms_changed');
console.log('PASS compare: price-only re-check is a flag, not a 409');

const bedsTakenCompare = compareAcceptedWolfhouseOffer(
  accepted,
  buildWolfhouseOfferRevision({
    ...quoted,
    guest_bed_assignments: [
      { guest_index: 0, bed_code: 'R9-1' },
      { guest_index: 1, bed_code: 'R9-2' },
    ],
  }),
);
assert.equal(bedsTakenCompare.ok, false);
assert.equal(bedsTakenCompare.reason_code, 'offer_terms_changed');
assert.equal(bedsTakenCompare.write_performed, false);
console.log('PASS compare: bed allocation change still refuses');

const issued = buildCheckedWolfhousePreviewOffer({
  client_slug: 'wolfhouse-somo',
  quote: {
    success: true,
    total_cents: 42000,
    deposit_required_cents: 20000,
    payment_link_amount_cents: 20000,
    currency: 'EUR',
    per_guest_deposits: quoted.payment_distribution,
  },
  availability: {
    availability_checked: true,
    status: 'checked',
    check_in: '2026-10-10',
    check_out: '2026-10-13',
    guest_count: 2,
    selected_bed_codes: ['R1-1', 'R1-2'],
    room_type: 'shared',
    allocation_reason: 'explicit_selection',
  },
  guests: [{ name: 'Lucia' }, { name: 'Carmen' }],
  payment_choice: 'deposit',
  per_guest_payment_links: false,
  payment_distribution: quoted.payment_distribution,
  room_rows: [
    { bed_code: 'R1-1', room_code: 'R1', gender_strategy: 'mixed' },
    { bed_code: 'R1-2', room_code: 'R1', gender_strategy: 'mixed' },
  ],
  package_code: 'malibu',
});
assert.ok(issued.offer_revision && issued.offer_revision.offer_fingerprint);

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
      if (occupied && (text.includes('FROM booking_beds') || text.includes('assignment_start_date'))) {
        return { rows: [
          { bed_code: 'R1-1' },
          { bed_code: 'R1-2' },
        ] };
      }
      if (text.includes('FROM wh_pricing_seasons s')) {
        return { rows: [{
          code: 'autumn', active: true, bookable: true, priority: 0, sort_order: 1,
          ranges: [{ start_month: 1, start_day: 1, end_month: 12, end_day: 31 }],
        }] };
      }
      if (text.includes('FROM rooms r') || text.includes('offer_commit_reread') || text.includes('offer_room_lock')) {
        return { rows: [
          { bed_code: 'R1-1', room_code: 'R1', gender_strategy: 'mixed', bed_active: true, bed_sellable: true, room_type: 'shared', occupied: false },
          { bed_code: 'R1-2', room_code: 'R1', gender_strategy: 'mixed', bed_active: true, bed_sellable: true, room_type: 'shared', occupied: false },
        ] };
      }
      if (text.includes('wh_pricing_rules') || text.includes('wh_pricing_items') || text.includes('offer_price_lock')) {
        return { rows: [] };
      }
      if (/inserted_booking_beds|is_duplicate|is_blocked|beds_inserted/i.test(text)) {
        return { rows: [{
          is_duplicate: false, is_blocked: false,
          booking_id: 'saved-quoted-1', booking_code: 'WH-KEEP',
          beds_inserted: 2, payments_inserted: 1,
        }] };
      }
      if (text.includes('UPDATE payments')) {
        return { rows: [{ payment_id: 'pay-quoted-1' }] };
      }
      return { rows: [] };
    },
  };
}

(async () => {
  const recheckQuote = {
    success: true,
    total_cents: 99900,
    deposit_required_cents: 30000,
    payment_link_amount_cents: 30000,
    currency: 'EUR',
    per_person: [{ guest_number: 1, deposit_cents: 15000 }, { guest_number: 2, deposit_cents: 15000 }],
    per_guest_deposits: [{ guest_name: 'Lucia', amount_cents: 15000 }, { guest_name: 'Carmen', amount_cents: 15000 }],
  };

  const savePg = capturingPg();
  const saved = await executeWolfhouseBookingCreate(savePg, {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    requireOfferIdentity: true,
    actor: { staff_user_id: 'luna-bot-internal', staff_role: 'operator' },
    pkgCtx: { isNoPackage: false },
    usesPerGuestModel: false,
    checkIn: '2026-10-10',
    checkOut: '2026-10-13',
    quoteGuestCount: 2,
    assignedBedCodes: ['R1-1', 'R1-2'],
    roomType: 'shared',
    effectivePackageCode: 'malibu',
    paymentChoice: 'deposit',
    perGuestPaymentLinks: false,
    paymentLinkAmountCents: 30000,
    depositCents: 30000,
    totalCents: 99900,
    quote: recheckQuote,
    notes: '',
    guestsNorm: { guests: [{ guest_name: 'Lucia' }, { guest_name: 'Carmen' }] },
    authoritativeRoomRows: [
      { bed_code: 'R1-1', room_code: 'R1', gender_strategy: 'mixed' },
      { bed_code: 'R1-2', room_code: 'R1', gender_strategy: 'mixed' },
    ],
    allocationReason: 'explicit_selection',
    availabilityProvenance: true,
    availabilityChecked: true,
    transportBody: {
      accepted_offer: issued.offer_revision,
      guests: [{ name: 'Lucia' }, { name: 'Carmen' }],
    },
  });

  assert.equal(saved.ok, true, JSON.stringify(saved && saved.body || saved));
  assert.equal(saved.body && saved.body.booking_id, 'saved-quoted-1');
  assert.notEqual(saved.body && saved.body.reason_code, 'offer_terms_changed');

  const insert = savePg.calls.find((row) => /inserted_booking_beds|beds_inserted/i.test(row.text));
  assert.ok(insert, 'create SQL must run');
  assert.equal(insert.params.includes(42000), true, 'INSERT must keep quoted total 42000, not re-check 99900');
  assert.equal(insert.params.includes(20000), true, 'INSERT must keep quoted deposit 20000');
  assert.equal(insert.params.includes(99900), false, 're-check total must not be stored');

  const pay = savePg.calls.find((row) => row.text.includes('UPDATE payments'));
  assert.ok(pay, 'payment row must be updated');
  assert.equal(pay.params[1], 20000, 'payment link amount must be the quoted 20000');

  const noteSql = savePg.calls.find((row) => Array.isArray(row.params)
    && row.params.some((p) => typeof p === 'string' && /quoted price kept|re-check differed/i.test(p)));
  assert.ok(noteSql, 'staff notes must flag the quoted-vs-recheck mismatch');
  console.log('PASS save: price mismatch keeps quoted total/deposit/link and flags staff');

  const takenPg = capturingPg({ occupied: true });
  const taken = await executeWolfhouseBookingCreate(takenPg, {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    requireOfferIdentity: true,
    actor: { staff_user_id: 'luna-bot-internal', staff_role: 'operator' },
    pkgCtx: { isNoPackage: false },
    checkIn: '2026-10-10',
    checkOut: '2026-10-13',
    quoteGuestCount: 2,
    assignedBedCodes: ['R1-1', 'R1-2'],
    roomType: 'shared',
    effectivePackageCode: 'malibu',
    paymentChoice: 'deposit',
    paymentLinkAmountCents: 20000,
    depositCents: 20000,
    totalCents: 42000,
    quote: {
      success: true, total_cents: 42000, deposit_required_cents: 20000,
      payment_link_amount_cents: 20000, currency: 'EUR',
    },
    guestsNorm: { guests: [{ guest_name: 'Lucia' }, { guest_name: 'Carmen' }] },
    authoritativeRoomRows: [
      { bed_code: 'R1-1', room_code: 'R1', gender_strategy: 'mixed' },
      { bed_code: 'R1-2', room_code: 'R1', gender_strategy: 'mixed' },
    ],
    allocationReason: 'explicit_selection',
    availabilityProvenance: true,
    availabilityChecked: true,
    transportBody: { accepted_offer: issued.offer_revision, guests: [{ name: 'Lucia' }, { name: 'Carmen' }] },
  });
  assert.equal(taken.ok, false);
  assert.equal(taken.body && taken.body.write_performed, false);
  assert.ok(
    taken.body && (taken.body.reason_code === 'availability_changed'
      || taken.body.detail === 'assigned_beds_occupied'
      || taken.body.reason_code === 'offer_terms_changed'),
    'taken bed must still refuse',
  );
  const takenInsert = takenPg.calls.find((row) => /inserted_booking_beds|beds_inserted/i.test(row.text));
  assert.equal(!takenInsert, true, 'taken bed must not insert a booking');
  console.log('PASS save: taken bed still refuses');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
