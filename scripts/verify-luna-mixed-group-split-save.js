'use strict';

/**
 * Mixed group (2 women in female-only + 1 man in mixed) must validate and
 * not refuse the save. keep_together across two rooms is a staff warning,
 * not a blocker. Occupancy still refuses a taken bed.
 *
 * Run: node scripts/verify-luna-mixed-group-split-save.js
 */
const assert = require('node:assert/strict');
const { validateExplicitBedSelection } = require('./lib/luna-bed-allocator');

function beds() {
  const female = [1, 2, 3].map((i) => ({
    bed_code: `R7-B${i}`,
    room_code: 'R7',
    room_type: 'female_only',
    gender_strategy: 'Female only',
    capacity: 3,
    can_be_matrimonial: false,
    bed_active: true,
    bed_sellable: true,
    selling_mode: 'shared',
  }));
  const mixed = [1, 2, 3].map((i) => ({
    bed_code: `R1-B${i}`,
    room_code: 'R1',
    room_type: 'mixed',
    gender_strategy: 'mixed',
    capacity: 3,
    can_be_matrimonial: false,
    bed_active: true,
    bed_sellable: true,
    selling_mode: 'shared',
  }));
  return female.concat(mixed);
}

const body = {
  keep_together: true,
  guests: [
    { name: 'Ada', explicit_gender: 'female' },
    { name: 'Bea', explicit_gender: 'female' },
    { name: 'Cal', explicit_gender: 'male' },
  ],
};

const ok = validateExplicitBedSelection({
  selectedBedCodes: ['R7-B1', 'R7-B2', 'R1-B1'],
  bedRows: beds(),
  blockRows: [],
  guestCount: 3,
  body,
});
assert.equal(ok.ok, true, JSON.stringify(ok));
assert.notEqual(ok.reason, 'same_room_unavailable');
assert.notEqual(ok.reason, 'incompatible_preselected_beds');
console.log('PASS mixed-group person-bound split is allowed (keep_together does not 409)');

const threeWomen = validateExplicitBedSelection({
  selectedBedCodes: ['R7-B1', 'R7-B2', 'R1-B1'],
  bedRows: beds(),
  blockRows: [],
  guestCount: 3,
  body: {
    keep_together: true,
    guests: [
      { name: 'Ada', explicit_gender: 'female' },
      { name: 'Bea', explicit_gender: 'female' },
      { name: 'Cara', explicit_gender: 'female' },
    ],
  },
});
assert.equal(threeWomen.ok, true, JSON.stringify(threeWomen));
assert.notEqual(threeWomen.reason, 'same_room_unavailable');
console.log('PASS keep_together split of 3 women is a warning, not a 409');

const taken = validateExplicitBedSelection({
  selectedBedCodes: ['R7-B1', 'R7-B2', 'R1-B1'],
  bedRows: beds(),
  blockRows: [{ bed_code: 'R1-B1', room_code: 'R1' }],
  guestCount: 3,
  body,
});
assert.equal(taken.ok, false);
assert.equal(taken.reason, 'availability_changed');
console.log('PASS taken bed still refuses');

const {
  executeWolfhouseBookingCreate,
  BOOKING_CREATE_CHANNELS,
} = require('./lib/luna-front-desk-accommodation-booking-create-service');

function mixedRoomRows() {
  return [
    { bed_code: 'R7-B1', room_code: 'R7', room_type: 'female_only', gender_strategy: 'Female only', bed_active: true, bed_sellable: true, selling_mode: 'shared' },
    { bed_code: 'R7-B2', room_code: 'R7', room_type: 'female_only', gender_strategy: 'Female only', bed_active: true, bed_sellable: true, selling_mode: 'shared' },
    { bed_code: 'R7-B3', room_code: 'R7', room_type: 'female_only', gender_strategy: 'Female only', bed_active: true, bed_sellable: true, selling_mode: 'shared' },
    { bed_code: 'R1-B1', room_code: 'R1', room_type: 'mixed', gender_strategy: 'mixed', bed_active: true, bed_sellable: true, selling_mode: 'shared' },
    { bed_code: 'R1-B2', room_code: 'R1', room_type: 'mixed', gender_strategy: 'mixed', bed_active: true, bed_sellable: true, selling_mode: 'shared' },
    { bed_code: 'R1-B3', room_code: 'R1', room_type: 'mixed', gender_strategy: 'mixed', bed_active: true, bed_sellable: true, selling_mode: 'shared' },
  ];
}

function capturingPg() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const text = typeof sql === 'string' ? sql : String((sql && sql.text) || '');
      calls.push({ text, params: params || (sql && sql.values) || [] });
      if (/^BEGIN/i.test(text) || /^COMMIT/i.test(text) || /^ROLLBACK/i.test(text)) return { rows: [] };
      if (/INSERT INTO/i.test(text) || /inserted_booking_beds|is_duplicate|beds_inserted|manual booking creation/i.test(text)) {
        return { rows: [{
          is_duplicate: false, is_blocked: false,
          booking_id: 'saved-mixed-1', booking_code: 'WH-MIXED-001',
          beds_inserted: 3, payments_inserted: 1,
        }] };
      }
      if (text.includes('FROM rooms r')) {
        return { rows: mixedRoomRows() };
      }
      if (text.includes('FROM booking_beds') || text.includes('assignment_start_date')) {
        return { rows: [] };
      }
      if (text.includes('UPDATE payments')) return { rows: [{ payment_id: 'pay-mixed-1' }] };
      return { rows: [] };
    },
  };
}

(async () => {
  const pg = capturingPg();
  const saved = await executeWolfhouseBookingCreate(pg, {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    requireOfferIdentity: false,
    actor: { staff_user_id: 'luna-bot-internal', staff_role: 'operator' },
    pkgCtx: { isNoPackage: false },
    usesPerGuestModel: false,
    checkIn: '2027-09-06',
    checkOut: '2027-09-12',
    quoteGuestCount: 3,
    assignedBedCodes: ['R7-B1', 'R7-B2', 'R1-B1'],
    roomType: 'shared',
    effectivePackageCode: 'malibu',
    paymentChoice: 'deposit',
    perGuestPaymentLinks: false,
    paymentLinkAmountCents: 30000,
    depositCents: 30000,
    totalCents: 90000,
    quote: {
      success: true, total_cents: 90000, deposit_required_cents: 30000,
      payment_link_amount_cents: 30000, currency: 'EUR',
    },
    notes: '',
    guestsNorm: { guests: [
      { guest_name: 'Ada', explicit_gender: 'female' },
      { guest_name: 'Bea', explicit_gender: 'female' },
      { guest_name: 'Cal', explicit_gender: 'male' },
    ] },
    authoritativeRoomRows: mixedRoomRows().filter((r) => ['R7-B1', 'R7-B2', 'R1-B1'].includes(r.bed_code)),
    allocationReason: 'explicit_selection',
    availabilityProvenance: true,
    availabilityChecked: true,
    transportBody: {
      keep_together: true,
      guests: [
        { name: 'Ada', explicit_gender: 'female' },
        { name: 'Bea', explicit_gender: 'female' },
        { name: 'Cal', explicit_gender: 'male' },
      ],
    },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved && saved.body || saved));
  assert.ok(saved.body && saved.body.booking_id, 'save must return a booking_id');
  assert.equal(saved.body.booking_id, 'saved-mixed-1');
  assert.equal(saved.body.booking_code, 'WH-MIXED-001');
  const insert = pg.calls.find((row) => /inserted_booking_beds|beds_inserted/i.test(row.text));
  assert.ok(insert, 'create SQL must insert a booking row');
  assert.notEqual(saved.body.reason_code, 'same_room_unavailable');
  console.log('PASS save: mixed-group keep_together split writes booking_id', saved.body.booking_id);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

