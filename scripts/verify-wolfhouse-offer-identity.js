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
} = require('./lib/luna-front-desk-accommodation-availability-service');
const {
  BOOKING_CREATE_CHANNELS,
  executeWolfhouseBookingCreate,
} = require('./lib/luna-front-desk-accommodation-booking-create-service');

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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
