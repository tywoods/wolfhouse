'use strict';

/**
 * Wolfhouse offer identity — extend the availability provenance contract.
 *
 * Create-from-plan must refuse an unchecked id, and must refuse a create
 * whose dates, person-to-bed allocation, room eligibility, services, price,
 * or payment terms no longer match the accepted server revision.
 *
 * Run: node scripts/verify-wolfhouse-offer-identity.js
 */

const {
  computeWolfhouseOfferFingerprint,
  buildWolfhouseOfferRevision,
  compareAcceptedWolfhouseOffer,
  buildCheckedWolfhousePreviewOffer,
  rereadWolfhouseOfferForCommit,
} = require('./lib/luna-front-desk-accommodation-availability-service');
const {
  BOOKING_CREATE_CHANNELS,
  executeWolfhouseBookingCreate,
} = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { mapBotBookingCreateBlockedHttp } = require('./lib/booking-guests');
const {
  shouldRequireWolfhouseOfferIdentity,
  mapCreateFromPlanOfferBridge,
} = require('./lib/staff-bot-v2-routes');

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

const base = {
  client_slug: 'wolfhouse-somo',
  check_in: '2026-10-10',
  check_out: '2026-10-13',
  guest_count: 2,
  guest_bed_assignments: [
    { guest_index: 0, bed_code: 'R1-1' },
    { guest_index: 1, bed_code: 'R1-2' },
  ],
  room_type: 'shared',
  room_preference: 'mixed',
  group_gender: 'mixed',
  gender_preference: null,
  allocation_reason: 'explicit_selection',
  package_code: 'malibu',
  guest_packages: [],
  add_ons: [],
  total_cents: 42000,
  deposit_required_cents: 20000,
  payment_link_amount_cents: 20000,
  currency: 'EUR',
  payment_choice: 'deposit',
  availability_checked: true,
};

function changed(patch) {
  return { ...base, ...patch };
}

const accepted = buildWolfhouseOfferRevision(base);

assert('server revision is a fingerprint, not a caller id',
  typeof accepted.offer_fingerprint === 'string' && accepted.offer_fingerprint.length === 64);
assert('payment terms change the revision',
  computeWolfhouseOfferFingerprint(base) !== computeWolfhouseOfferFingerprint(changed({
    payment_choice: 'full',
    payment_link_amount_cents: 42000,
  })));
assert('person-to-bed change is not the same revision',
  computeWolfhouseOfferFingerprint(base) !== computeWolfhouseOfferFingerprint(changed({
    guest_bed_assignments: [
      { guest_index: 0, bed_code: 'R2-1' },
      { guest_index: 1, bed_code: 'R1-2' },
    ],
  })));
assert('services change the revision',
  computeWolfhouseOfferFingerprint(base) !== computeWolfhouseOfferFingerprint(changed({
    add_ons: [{ code: 'board', quantity: 1 }],
  })));
assert('null deposit is not zero',
  computeWolfhouseOfferFingerprint(changed({ deposit_required_cents: null }))
    !== computeWolfhouseOfferFingerprint(changed({ deposit_required_cents: 0 })));
assert('unchecked preview does not count as checked',
  computeWolfhouseOfferFingerprint(changed({ availability_checked: false }))
    !== computeWolfhouseOfferFingerprint(base));

const missing = compareAcceptedWolfhouseOffer(null, accepted);
assert('missing offer is required',
  missing.ok === false && missing.reason_code === 'offer_identity_required');

const bareId = compareAcceptedWolfhouseOffer({ offer_id: 'preview-1' }, accepted);
assert('an id on an unchecked preview is not enough',
  bareId.ok === false && bareId.reason_code === 'offer_unchecked' && bareId.write_performed === false);

const bedsMoved = compareAcceptedWolfhouseOffer(accepted, buildWolfhouseOfferRevision(changed({
  guest_bed_assignments: [
    { guest_index: 0, bed_code: 'R9-1' },
    { guest_index: 1, bed_code: 'R9-2' },
  ],
  allocation_reason: 'auto_assign',
})));
assert('changed beds do not silently substitute',
  bedsMoved.ok === false
  && bedsMoved.reason_code === 'offer_terms_changed'
  && bedsMoved.detail === 'bed_allocation_changed'
  && bedsMoved.write_performed === false
  && bedsMoved.creates_booking === false);

const payMoved = compareAcceptedWolfhouseOffer(accepted, buildWolfhouseOfferRevision(changed({
  payment_choice: 'full',
  payment_link_amount_cents: 42000,
})));
assert('changed payment terms are not recalculated into the booking',
  payMoved.ok === false
  && payMoved.reason_code === 'offer_terms_changed'
  && payMoved.detail === 'payment_terms_changed'
  && payMoved.write_performed === false);

const same = compareAcceptedWolfhouseOffer(accepted, buildWolfhouseOfferRevision(base));
assert('matching current state accepts the offer', same.ok === true);

const luciaCarmen = changed({
  guest_bed_assignments: [
    { guest_index: 0, guest_name: 'Lucia', bed_code: 'R1-1' },
    { guest_index: 1, guest_name: 'Carmen', bed_code: 'R1-2' },
  ],
});
const swappedNames = changed({
  guest_bed_assignments: [
    { guest_index: 0, guest_name: 'Carmen', bed_code: 'R1-1' },
    { guest_index: 1, guest_name: 'Lucia', bed_code: 'R1-2' },
  ],
});
assert('reversed guest names are not the same person-to-bed revision',
  computeWolfhouseOfferFingerprint(luciaCarmen) !== computeWolfhouseOfferFingerprint(swappedNames));

const femaleRoom = changed({
  room_arrangement: [{ bed_code: 'R5-1', room_code: 'R5', gender_strategy: 'female_only' }],
});
const mixedRoom = changed({
  room_arrangement: [{ bed_code: 'R5-1', room_code: 'R5', gender_strategy: 'mixed' }],
});
assert('female-only room becoming mixed changes the revision',
  computeWolfhouseOfferFingerprint(femaleRoom) !== computeWolfhouseOfferFingerprint(mixedRoom));

const wholeBooking = changed({
  payment_choice: 'deposit',
  per_guest_payment_links: false,
  payment_distribution: [{ guest_name: 'Lucia', amount_cents: 20000 }],
});
const perGuest = changed({
  payment_choice: 'deposit',
  per_guest_payment_links: true,
  payment_distribution: [
    { guest_name: 'Lucia', amount_cents: 10000 },
    { guest_name: 'Carmen', amount_cents: 10000 },
  ],
});
assert('whole-booking payment is not the same as per-guest distribution',
  computeWolfhouseOfferFingerprint(wholeBooking) !== computeWolfhouseOfferFingerprint(perGuest));

(async () => {
  const queries = [];
  const pg = {
    query: async (sql) => {
      queries.push(String(sql));
      throw new Error('create must not query when the offer is unchecked');
    },
  };
  const blocked = await executeWolfhouseBookingCreate(pg, {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    requireOfferIdentity: true,
    transportBody: { accepted_offer: { offer_id: 'preview-1' } },
  });
  assert('create-from-plan does not write an unchecked id',
    blocked && blocked.ok === false
    && blocked.body.reason_code === 'offer_unchecked'
    && blocked.body.write_performed === false
    && queries.length === 0);

  const mismatched = await executeWolfhouseBookingCreate(pg, {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    requireOfferIdentity: true,
    assignedBedCodes: ['R9-1'],
    quoteGuestCount: 1,
    checkIn: '2026-10-10',
    checkOut: '2026-10-13',
    roomType: 'shared',
    paymentChoice: 'full',
    paymentLinkAmountCents: 42000,
    quote: { total_cents: 42000, deposit_required_cents: 20000, currency: 'EUR' },
    availabilityProvenance: { availability_fingerprint: 'fresh' },
    transportBody: { accepted_offer: accepted },
  });
  assert('create does not substitute beds or recalculate payment',
    mismatched && mismatched.ok === false
    && mismatched.body.reason_code === 'offer_terms_changed'
    && mismatched.body.creates_booking === false
    && queries.length === 0);

  const preview = buildCheckedWolfhousePreviewOffer({
    quote: {
      success: true,
      total_cents: 42000,
      deposit_required_cents: 20000,
      payment_link_amount_cents: 20000,
      currency: 'EUR',
    },
    availability: {
      availability_checked: true,
      check_in: '2026-10-10',
      check_out: '2026-10-13',
      guest_count: 2,
      selected_bed_codes: ['R1-1', 'R1-2'],
      room_type: 'shared',
    },
    guests: [{ name: 'Lucia' }, { name: 'Carmen' }],
    payment_choice: 'deposit',
    per_guest_payment_links: false,
    room_rows: [
      { bed_code: 'R1-1', room_code: 'R1', gender_strategy: 'mixed' },
      { bed_code: 'R1-2', room_code: 'R1', gender_strategy: 'mixed' },
    ],
    client_slug: 'wolfhouse-somo',
  });
  assert('preview returns a checked revision before acceptance',
    preview.availability.status === 'checked'
    && preview.availability.status !== 'not_checked'
    && preview.offer_revision
    && preview.offer_revision.availability_checked === true
    && typeof preview.offer_revision.offer_fingerprint === 'string');
  const acceptedPreview = preview.offer_revision;
  const recheck = buildCheckedWolfhousePreviewOffer({
    quote: {
      success: true,
      total_cents: 42000,
      deposit_required_cents: 20000,
      payment_link_amount_cents: 20000,
      currency: 'EUR',
    },
    availability: preview.availability,
    guests: [{ name: 'Lucia' }, { name: 'Carmen' }],
    payment_choice: 'deposit',
    per_guest_payment_links: false,
    room_rows: [
      { bed_code: 'R1-1', room_code: 'R1', gender_strategy: 'mixed' },
      { bed_code: 'R1-2', room_code: 'R1', gender_strategy: 'mixed' },
    ],
    client_slug: 'wolfhouse-somo',
  });
  const unchanged = compareAcceptedWolfhouseOffer(acceptedPreview, recheck.offer_revision);
  assert('unchanged recheck matches the accepted preview revision', unchanged.ok === true);

  const http = mapBotBookingCreateBlockedHttp({
    _blocked: true,
    reason_code: 'offer_identity_required',
    detail: 'missing_accepted_offer',
    error: 'A checked offer revision is required before this booking can be created.',
    write_performed: false,
    creates_booking: false,
    no_write_performed: true,
  }, 409);
  assert('typed 409 is not rewritten as Booking blocked undefined',
    http.status === 409
    && http.body.reason_code === 'offer_identity_required'
    && http.body.detail === 'missing_accepted_offer'
    && http.body.write_performed === false
    && !String(http.body.error || '').includes('undefined')
    && http.body.staff_review_needed === false
    && http.body.next_action === 'clarify_offer');

  const bridged = mapCreateFromPlanOfferBridge({
    success: false,
    reason_code: 'offer_terms_changed',
    detail: 'payment_terms_changed',
    error: 'The accepted offer no longer matches current dates, beds, or price. Nothing was booked.',
    status: 409,
  });
  assert('bridge keeps the typed result and does not hand off',
    bridged.reason_code === 'offer_terms_changed'
    && bridged.blocked_reasons[0] === 'offer_terms_changed'
    && bridged.staff_review_needed === false
    && bridged.do_not_escalate === true
    && bridged.next_action === 're_quote');

  assert('ordinary WhatsApp does not require an offer revision',
    shouldRequireWolfhouseOfferIdentity({ claimed: false, ok: true }) === false);
  assert('trusted simulator requires an offer revision',
    shouldRequireWolfhouseOfferIdentity({ claimed: true, ok: true }) === true);
  assert('denied simulator does not force the offer gate',
    shouldRequireWolfhouseOfferIdentity({ claimed: true, ok: false }) === false);

  const saved = {
    booking_id: 'saved-1',
    booking_code: 'WH-SAVED',
    status: 'confirmed',
    metadata: { idempotency_key: 'retry-1', response_delivered: false },
  };
  const retryPg = {
    query: async (sql) => {
      const text = String(sql);
      if (text.includes('offer_idempotency_lookup')) return { rows: [saved] };
      throw new Error('retry must not create: ' + text.slice(0, 80));
    },
  };
  const retry = await executeWolfhouseBookingCreate(retryPg, {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    requireOfferIdentity: true,
    idempotencyKey: 'retry-1',
    transportBody: { accepted_offer: { offer_id: 'stale-preview' } },
  });
  assert('lost-response retry returns the saved booking before offer rejection',
    retry.ok === true
    && retry.body.duplicate === true
    && retry.body.booking_id === 'saved-1'
    && retry.body.reason_code !== 'offer_unchecked');

  const completed = await executeWolfhouseBookingCreate({
    query: async (sql) => {
      if (String(sql).includes('offer_idempotency_lookup')) {
        return { rows: [{ booking_id: 'done-1', booking_code: 'WH-DONE', status: 'confirmed', metadata: { response_delivered: true } }] };
      }
      throw new Error('completed retry must not create');
    },
  }, {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    requireOfferIdentity: true,
    idempotencyKey: 'done-1',
    transportBody: { accepted_offer: { offer_id: 'stale' } },
  });
  assert('completed create retry returns the saved outcome',
    completed.ok === true && completed.body.booking_id === 'done-1' && completed.body.response_delivered === true);

  const priceChanged = await executeWolfhouseBookingCreate({
    query: async (sql) => {
      if (String(sql).includes('offer_idempotency_lookup')) {
        return { rows: [{ booking_id: 'price-1', booking_code: 'WH-PRICE', status: 'confirmed', metadata: {} }] };
      }
      throw new Error('price-change retry must not create');
    },
  }, {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    requireOfferIdentity: true,
    idempotencyKey: 'price-1',
    quote: { total_cents: 99999 },
    transportBody: { accepted_offer: accepted },
  });
  assert('retry after a price change still returns the saved booking',
    priceChanged.ok === true
    && priceChanged.body.booking_id === 'price-1'
    && priceChanged.body.reason_code !== 'offer_terms_changed');

  const ambiguousPg = {
    query: async (sql) => {
      if (String(sql).includes('offer_idempotency_lookup')) {
        return { rows: [{ booking_id: 'amb-1', booking_code: 'WH-AMB', status: 'pending', metadata: { write_state: 'ambiguous' } }] };
      }
      throw new Error('ambiguous retry must not create');
    },
  };
  const ambiguous = await executeWolfhouseBookingCreate(ambiguousPg, {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    requireOfferIdentity: true,
    idempotencyKey: 'amb-1',
    transportBody: { accepted_offer: accepted },
  });
  assert('ambiguous write is recovered without a second create or a terms rejection',
    ambiguous.ok === false
    && ambiguous.body.reason_code === 'write_recovery_required'
    && ambiguous.body.write_performed === false
    && ambiguous.body.reason_code !== 'offer_terms_changed');

  const changedRooms = await rereadWolfhouseOfferForCommit({
    query: async (sql) => {
      if (String(sql).includes('offer_commit_reread')) {
        return { rows: [{ bed_code: 'R5-1', room_code: 'R5', gender_strategy: 'mixed', occupied: false }] };
      }
      return { rows: [] };
    },
  }, {
    clientSlug: 'wolfhouse-somo',
    checkIn: '2026-10-10',
    checkOut: '2026-10-13',
    quoteGuestCount: 1,
    assignedBedCodes: ['R5-1'],
    roomType: 'shared',
    paymentChoice: 'deposit',
    paymentLinkAmountCents: 20000,
    quote: { total_cents: 42000, deposit_required_cents: 20000, currency: 'EUR' },
    availabilityProvenance: { availability_fingerprint: 'preflight' },
    transportBody: {
      accepted_offer: buildWolfhouseOfferRevision({
        ...base,
        guest_count: 1,
        guest_bed_assignments: [{ guest_index: 0, guest_name: 'Lucia', bed_code: 'R5-1' }],
        room_arrangement: [{ bed_code: 'R5-1', room_code: 'R5', gender_strategy: 'female_only' }],
        availability_checked: true,
      }),
    },
  });
  assert('commit reread sees a room-rule change the cached quote missed',
    changedRooms.ok === false
    && changedRooms.reason_code === 'offer_terms_changed'
    && changedRooms.detail === 'room_eligibility_changed'
    && changedRooms.write_performed === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
