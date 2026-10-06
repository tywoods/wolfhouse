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
  currentWolfhouseOfferFromCreateCommand,
  rereadWolfhouseOfferForCommit,
  buildWolfhouseAvailabilityCommand,
  executeWolfhouseAvailabilityCheck,
  AVAILABILITY_CHANNELS,
} = require('./lib/luna-front-desk-accommodation-availability-service');
const {
  BOOKING_CREATE_CHANNELS,
  executeWolfhouseBookingCreate,
  buildWolfhouseBookingCreateCommand,
  wolfhouseOperationFingerprint,
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
    metadata: {
      idempotency_key: 'retry-1',
      response_delivered: false,
      operation_fingerprint: wolfhouseOperationFingerprint({
        clientSlug: 'wolfhouse-somo',
        channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
        idempotencyKey: 'retry-1',
        transportBody: { accepted_offer: { offer_id: 'stale-preview' } },
      }),
    },
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
        return { rows: [{
          booking_id: 'done-1',
          booking_code: 'WH-DONE',
          status: 'confirmed',
          metadata: {
            response_delivered: true,
            operation_fingerprint: wolfhouseOperationFingerprint({
              clientSlug: 'wolfhouse-somo',
              channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
              transportBody: { accepted_offer: { offer_id: 'stale' } },
            }),
          },
        }] };
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
        return { rows: [{
          booking_id: 'price-1',
          booking_code: 'WH-PRICE',
          status: 'confirmed',
          metadata: {
            operation_fingerprint: wolfhouseOperationFingerprint({
              clientSlug: 'wolfhouse-somo',
              channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
              quote: { total_cents: 99999 },
              transportBody: { accepted_offer: accepted },
            }),
          },
        }] };
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
    allocationReason: 'explicit_selection',
    guestsNorm: { guests: [{ guest_name: 'Lucia' }] },
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

  const { calculateWolfhouseQuote, loadConfig } = require('./lib/wolfhouse-quote-calculator');
  const liveQuote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-10-10',
    check_out: '2026-10-17',
    guest_count: 2,
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'deposit',
  }, loadConfig());
  const issued = buildCheckedWolfhousePreviewOffer({
    client_slug: 'wolfhouse-somo',
    quote: liveQuote,
    availability: {
      availability_checked: true,
      status: 'checked',
      check_in: '2026-10-10',
      check_out: '2026-10-17',
      guest_count: 2,
      selected_bed_codes: ['R8-B1', 'R8-B2'],
      room_type: 'shared',
      allocation_reason: 'explicit_selection',
    },
    guests: [{ name: 'Lucia' }, { name: 'Carmen' }],
    payment_choice: 'deposit',
    per_guest_payment_links: false,
    room_rows: [
      { bed_code: 'R8-B1', room_code: 'R8', gender_strategy: 'mixed' },
      { bed_code: 'R8-B2', room_code: 'R8', gender_strategy: 'mixed' },
    ],
    package_code: 'malibu',
  });
  const unchangedCreate = await executeWolfhouseBookingCreate({
    query: async (sql) => {
      const text = String(sql);
      if (/^BEGIN/i.test(text) || /^COMMIT/i.test(text) || /^ROLLBACK/i.test(text)) return { rows: [] };
      if (text.includes('offer_idempotency_lookup')) return { rows: [] };
      if (text.includes('FROM rooms r') || text.includes('offer_commit_reread') || text.includes('offer_room_lock')) {
        return { rows: [
          { bed_code: 'R8-B1', room_code: 'R8', gender_strategy: 'mixed', bed_active: true, bed_sellable: true, room_type: 'shared' },
          { bed_code: 'R8-B2', room_code: 'R8', gender_strategy: 'mixed', bed_active: true, bed_sellable: true, room_type: 'shared' },
        ] };
      }
      if (text.includes('wh_pricing_rules') || text.includes('wh_pricing_items') || text.includes('offer_price_lock')) return { rows: [] };
      if (/inserted_booking_beds|is_duplicate|is_blocked|beds_inserted/i.test(text)) {
        return { rows: [{ is_duplicate: false, is_blocked: false, booking_id: 'created-1', booking_code: 'WH-OK', beds_inserted: 2, payments_inserted: 1 }] };
      }
      return { rows: [] };
    },
  }, {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    requireOfferIdentity: true,
    actor: { staff_user_id: 'luna-bot-internal', staff_role: 'operator' },
    pkgCtx: { isNoPackage: false },
    usesPerGuestModel: false,
    checkIn: '2026-10-10',
    checkOut: '2026-10-17',
    quoteGuestCount: 2,
    assignedBedCodes: ['R8-B1', 'R8-B2'],
    roomType: 'shared',
    effectivePackageCode: 'malibu',
    paymentChoice: 'deposit',
    perGuestPaymentLinks: false,
    paymentLinkAmountCents: liveQuote.payment_link_amount_cents,
    quote: liveQuote,
    guestsNorm: { guests: [{ guest_name: 'Lucia' }, { guest_name: 'Carmen' }] },
    authoritativeRoomRows: [
      { bed_code: 'R8-B1', room_code: 'R8', gender_strategy: 'mixed' },
      { bed_code: 'R8-B2', room_code: 'R8', gender_strategy: 'mixed' },
    ],
    allocationReason: 'explicit_selection',
    availabilityProvenance: true,
    availabilityChecked: true,
    transportBody: {
      accepted_offer: issued.offer_revision,
      guests: [{ name: 'Lucia' }, { name: 'Carmen' }],
    },
  });
  assert('issued Lucia/Carmen revision is accepted unchanged by create',
    unchangedCreate.ok === true
    && unchangedCreate.body
    && unchangedCreate.body.booking_id === 'created-1'
    && unchangedCreate.body.reason_code !== 'offer_terms_changed'
    && unchangedCreate.body.detail !== 'bed_allocation_changed');

  const explicitBeds = [
    { bed_code: 'R6-B1', room_code: 'R6', room_type: 'private', bed_active: true, bed_sellable: true, gender_strategy: 'mixed', fill_priority: 1, capacity: 2 },
    { bed_code: 'R6-B2', room_code: 'R6', room_type: 'private', bed_active: true, bed_sellable: true, gender_strategy: 'mixed', fill_priority: 1, capacity: 2 },
    { bed_code: 'R8-B1', room_code: 'R8', room_type: 'shared', bed_active: true, bed_sellable: true, gender_strategy: 'Flexible', fill_priority: 9, capacity: 4 },
    { bed_code: 'R8-B2', room_code: 'R8', room_type: 'shared', bed_active: true, bed_sellable: true, gender_strategy: 'Flexible', fill_priority: 9, capacity: 4 },
  ];
  const explicitPg = {
    query: async (sql) => {
      const text = String(sql);
      if (text.includes('FROM rooms r')) return { rows: explicitBeds };
      if (text.includes('booking_beds') || text.includes('assignment_start_date')) return { rows: [] };
      return { rows: [] };
    },
  };
  const explicitCheck = await executeWolfhouseAvailabilityCheck(explicitPg, buildWolfhouseAvailabilityCommand({
    channel: AVAILABILITY_CHANNELS.BOT_HTTP,
    trustedClientSlug: 'wolfhouse-somo',
    assignmentMode: false,
    demoCalendarEnrichment: false,
    transportBody: {
      check_in: '2026-10-10',
      check_out: '2026-10-17',
      guest_count: 2,
      guests: [{ name: 'Lucia' }, { name: 'Carmen' }],
      room_type: 'shared',
      selected_bed_codes: ['R8-B1', 'R8-B2'],
    },
  }).command);
  assert('recheck keeps the offered beds instead of picking a different room',
    explicitCheck.ok === true
    && explicitCheck.body.selected_bed_codes.join(',') === 'R8-B1,R8-B2'
    && !explicitCheck.body.selected_bed_codes.includes('R6-B1'));

  const manualQueries = [];
  await executeWolfhouseBookingCreate({
    query: async (sql) => {
      manualQueries.push(String(sql));
      if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(String(sql))) return { rows: [] };
      if (/inserted_booking_beds|is_duplicate|beds_inserted/i.test(String(sql))) {
        return { rows: [{ is_duplicate: false, is_blocked: false, booking_id: 'man-1', beds_inserted: 1 }] };
      }
      return { rows: [] };
    },
  }, {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
    actor: { staff_user_id: 'staff-1', staff_role: 'operator' },
    assignedBedCodes: ['R1-B1'],
    availabilityProvenance: true,
    pkgCtx: { isNoPackage: true },
    quote: { balance_due_cents: 0 },
  }).catch(() => null);
  assert('manual create does not run the simulator reread SQL',
    !manualQueries.some((sql) => sql.includes('offer_commit_reread') || sql.includes('gender_strategy, occupied FROM beds')));

  const priced = await rereadWolfhouseOfferForCommit({
    query: async (sql) => {
      const text = String(sql);
      if (text.includes('offer_commit_reread') || text.includes('FROM rooms r')) {
        return { rows: [
          { bed_code: 'R8-B1', room_code: 'R8', gender_strategy: 'mixed', room_type: 'shared' },
          { bed_code: 'R8-B2', room_code: 'R8', gender_strategy: 'mixed', room_type: 'shared' },
        ] };
      }
      if (text.includes('FROM wh_pricing_rules')) {
        return { rows: [{ item_type: 'deposit', item_code: 'standard_package', amount_cents: 1, unit: 'per_person', active: true }] };
      }
      return { rows: [] };
    },
  }, {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    requireOfferIdentity: true,
    checkIn: '2026-10-10',
    checkOut: '2026-10-17',
    quoteGuestCount: 2,
    assignedBedCodes: ['R8-B1', 'R8-B2'],
    roomType: 'shared',
    effectivePackageCode: 'malibu',
    paymentChoice: 'deposit',
    allocationReason: 'explicit_selection',
    guestsNorm: { guests: [{ guest_name: 'Lucia' }, { guest_name: 'Carmen' }] },
    transportBody: { accepted_offer: issued.offer_revision },
  });
  assert('a database price change after preview rejects the write',
    priced.ok === false
    && priced.reason_code === 'offer_terms_changed'
    && priced.detail === 'payment_terms_changed'
    && priced.write_performed === false);

  const retryBody = {
    confirm: true,
    check_in: '2026-10-10',
    check_out: '2026-10-17',
    guest_count: 2,
    guest_name: 'Lucia',
    phone: '+346****0000',
    guests: [{ name: 'Lucia' }, { name: 'Carmen' }],
    selected_bed_codes: ['R8-B1', 'R8-B2'],
    package_code: 'malibu',
    payment_choice: 'deposit',
    idempotency_key: 'same-op',
  };
  const sameFingerprint = wolfhouseOperationFingerprint({
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    checkIn: retryBody.check_in,
    checkOut: retryBody.check_out,
    phone: retryBody.phone,
    paymentChoice: 'deposit',
    effectivePackageCode: 'malibu',
    assignedBedCodes: ['R8-B1', 'R8-B2'],
    guestsNorm: { guests: [{ guest_name: 'Lucia' }, { guest_name: 'Carmen' }] },
    transportBody: retryBody,
  });
  const retryBuild = await buildWolfhouseBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    trustedClientSlug: 'wolfhouse-somo',
    quoteConfig: loadConfig(),
    transportBody: retryBody,
    pgClient: {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes('offer_idempotency_lookup')) {
          return { rows: [{
            booking_id: 'saved-occ',
            booking_code: 'WH-OCC',
            status: 'confirmed',
            payment_id: 'pay-saved',
            metadata: {
              operation_fingerprint: sameFingerprint,
              quote_snapshot: { total_cents: liveQuote.total_cents },
              booking_guests: [{ guest_name: 'Lucia' }, { guest_name: 'Carmen' }],
            },
          }] };
        }
        throw new Error('occupied-bed retry must not revalidate: ' + text.slice(0, 60));
      },
    },
  });
  assert('same-operation retry returns the saved booking before bed revalidation',
    retryBuild.recovered === true
    && retryBuild.body._duplicate === true
    && retryBuild.body.write_performed === false
    && retryBuild.body.created === false
    && retryBuild.body.payment_id === 'pay-saved'
    && retryBuild.body.booking_id === 'saved-occ');

  const mismatchedKey = await executeWolfhouseBookingCreate({
    query: async (sql) => {
      if (String(sql).includes('offer_idempotency_lookup')) {
        return { rows: [{
          booking_id: 'other-1',
          booking_code: 'WH-OTHER',
          status: 'confirmed',
          metadata: { operation_fingerprint: 'not-this-operation' },
        }] };
      }
      throw new Error('different operation must not create');
    },
  }, {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    requireOfferIdentity: true,
    idempotencyKey: 'reused',
    checkIn: '2026-11-01',
    checkOut: '2026-11-08',
    transportBody: { accepted_offer: { offer_id: 'different' } },
  });
  assert('reused key for a different operation is rejected',
    mismatchedKey.ok === false
    && mismatchedKey.body.reason_code === 'idempotency_payload_mismatch'
    && mismatchedKey.body.booking_id !== 'other-1'
    && mismatchedKey.body.write_performed === false);

  const booked = buildWolfhouseOfferRevision({
    ...base,
    allocation_reason: 'legacy_capacity_smallest_room',
    group_gender: 'mixed',
    availability_checked: true,
  });
  const rechecked = buildWolfhouseOfferRevision({
    ...base,
    allocation_reason: 'explicit_selection',
    group_gender: null,
    availability_checked: true,
  });
  assert('unchanged recheck keeps the offer identity when only allocator bookkeeping changes',
    booked.offer_fingerprint === rechecked.offer_fingerprint
    && compareAcceptedWolfhouseOffer(booked, rechecked).ok === true);

  const withEmail = wolfhouseOperationFingerprint({
    clientSlug: 'wolfhouse-somo',
    checkIn: '2026-10-10',
    checkOut: '2026-10-17',
    guestName: 'Lucia',
    email: 'lucia@example.com',
    phone: '+34600000000',
    assignedBedCodes: ['R8-B1'],
    paymentChoice: 'deposit',
    effectivePackageCode: 'malibu',
    quoteGuestCount: 2,
    transportBody: { accepted_offer: { offer_fingerprint: 'offer-a' } },
  });
  const otherEmail = wolfhouseOperationFingerprint({
    clientSlug: 'wolfhouse-somo',
    checkIn: '2026-10-10',
    checkOut: '2026-10-17',
    guestName: 'Lucia',
    email: 'other@example.com',
    phone: '+34600000000',
    assignedBedCodes: ['R8-B1'],
    paymentChoice: 'deposit',
    effectivePackageCode: 'malibu',
    quoteGuestCount: 2,
    transportBody: { accepted_offer: { offer_fingerprint: 'offer-a' } },
  });
  const otherOffer = wolfhouseOperationFingerprint({
    clientSlug: 'wolfhouse-somo',
    checkIn: '2026-10-10',
    checkOut: '2026-10-17',
    guestName: 'Lucia',
    email: 'lucia@example.com',
    phone: '+34600000000',
    assignedBedCodes: ['R8-B1'],
    paymentChoice: 'deposit',
    effectivePackageCode: 'malibu',
    quoteGuestCount: 2,
    addOns: [{ code: 'breakfast', quantity: 1 }],
    transportBody: { accepted_offer: { offer_fingerprint: 'offer-b' } },
  });
  assert('retry fingerprint changes when email, add-ons, or the accepted offer change',
    withEmail !== otherEmail && withEmail !== otherOffer);

  const looseRetry = await executeWolfhouseBookingCreate({
    query: async (sql) => {
      if (String(sql).includes('offer_idempotency_lookup')) {
        return { rows: [{
          booking_id: 'loose-1',
          booking_code: 'WH-LOOSE',
          status: 'confirmed',
          check_in: '2026-10-10',
          check_out: '2026-10-17',
          guest_name: 'Lucia',
          guest_count: 2,
          metadata: {},
        }] };
      }
      throw new Error('different guest must not reuse the saved booking');
    },
  }, {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    idempotencyKey: 'loose-1',
    checkIn: '2026-10-10',
    checkOut: '2026-10-17',
    guestName: 'Carmen',
    quoteGuestCount: 2,
    transportBody: { guest_name: 'Carmen' },
  });
  assert('same key with a different guest is not the saved booking',
    looseRetry.ok === false
    && looseRetry.body.reason_code === 'idempotency_payload_mismatch'
    && looseRetry.body.booking_id !== 'loose-1');

  const realIssued = buildCheckedWolfhousePreviewOffer({
    client_slug: 'wolfhouse-somo',
    quote: liveQuote,
    availability: {
      availability_checked: true,
      status: 'checked',
      check_in: '2026-10-10',
      check_out: '2026-10-17',
      guest_count: 2,
      selected_bed_codes: ['R8-B1', 'R8-B2'],
      room_type: 'shared',
      allocation_reason: 'legacy_capacity_smallest_room',
      group_gender: 'mixed',
    },
    guests: [{ name: 'Lucia' }, { name: 'Carmen' }],
    payment_choice: 'deposit',
    room_rows: [
      { bed_code: 'R8-B1', room_code: 'R8', gender_strategy: 'Flexible' },
      { bed_code: 'R8-B2', room_code: 'R8', gender_strategy: 'Flexible' },
    ],
    package_code: 'malibu',
  });
  const realBuilt = await buildWolfhouseBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    trustedClientSlug: 'wolfhouse-somo',
    quoteConfig: loadConfig(),
    transportBody: {
      confirm: true,
      require_offer_identity: true,
      check_in: '2026-10-10',
      check_out: '2026-10-17',
      guest_count: 2,
      guest_name: 'Lucia',
      phone: '+34600000000',
      guests: [{ name: 'Lucia' }, { name: 'Carmen' }],
      selected_bed_codes: ['R8-B1', 'R8-B2'],
      package_code: 'malibu',
      payment_choice: 'deposit',
      room_type: 'shared',
      accepted_offer: realIssued.offer_revision,
    },
    pgClient: {
      query: async (sql) => {
        const text = String(sql);
        if (text.includes('FROM rooms r')) {
          return { rows: [
            { bed_code: 'R8-B1', room_code: 'R8', room_type: 'shared', gender_strategy: 'Flexible', bed_active: true, bed_sellable: true },
            { bed_code: 'R8-B2', room_code: 'R8', room_type: 'shared', gender_strategy: 'Flexible', bed_active: true, bed_sellable: true },
          ] };
        }
        return { rows: [] };
      },
    },
  });
  assert('real command builder loads room rows for the offered beds',
    realBuilt.ok === true
    && Array.isArray(realBuilt.command.authoritativeRoomRows)
    && realBuilt.command.authoritativeRoomRows.map((row) => row.bed_code).sort().join(',') === 'R8-B1,R8-B2');
  const realCurrent = currentWolfhouseOfferFromCreateCommand(realBuilt.command);
  const realDecision = compareAcceptedWolfhouseOffer(realIssued.offer_revision, realCurrent);
  assert('real command accepts the issued offer without a room-rule rejection',
    realDecision.ok === true && realDecision.detail !== 'room_eligibility_changed');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
