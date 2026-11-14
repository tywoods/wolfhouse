'use strict';

const assert = require('node:assert/strict');
const {
  BOOKING_CREATE_CHANNELS,
  executeWolfhouseBookingCreate,
} = require('./lib/luna-front-desk-accommodation-booking-create-service');
const {
  MALIBU_ACCEPTED_STALE_BODY,
  PLAIN_ACCEPTED_STALE_OFFER,
  makeCapturingPg,
} = require('./fixtures/dup-state-skip-sql');

function commandFor(testCase) {
  const acceptedMalibu = testCase.expectedPackageCode === 'malibu';
  return {
    clientSlug: 'wolfhouse-somo',
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    actor: { staff_user_id: 'luna-bot-internal', staff_role: 'operator' },
    checkIn: '2026-12-01',
    checkOut: '2026-12-08',
    quoteGuestCount: 1,
    assignedBedCodes: ['R1-B1'],
    roomType: testCase.expectedRoomType || 'shared',
    roomPreference: testCase.expectedRoomType || 'shared',
    storagePackageCode: testCase.transportPackageCode === 'package_none'
      ? null : testCase.transportPackageCode,
    effectivePackageCode: testCase.expectedPackageCode,
    pkgCtx: { isNoPackage: testCase.expectedAccommodationOnly },
    guestPackagesForQuote: [{ guest_number: 1, package_code: testCase.expectedPackageCode }],
    paymentChoice: 'deposit',
    paymentLinkAmountCents: 20000,
    depositCents: 20000,
    totalCents: 42000,
    quote: {
      success: true,
      total_cents: 42000,
      deposit_required_cents: 20000,
      balance_due_cents: 22000,
      payment_link_amount_cents: 20000,
      currency: 'EUR',
      package_code: testCase.expectedPackageCode,
      per_person: [{ guest_number: 1, package_code: testCase.expectedPackageCode }],
    },
    guestsNorm: { guests: [{ guest_name: 'Camila', package_code: testCase.expectedPackageCode }] },
    authoritativeRoomRows: [{ bed_code: 'R1-B1', room_code: 'R1', gender_strategy: 'mixed' }],
    allocationReason: 'explicit_selection',
    availabilityProvenance: true,
    availabilityChecked: true,
    notes: 'Camila note retained',
    transportBody: {
      package_code: testCase.transportPackageCode,
      room_type: testCase.transportRoomType || 'shared',
      accepted_offer: {
        package_code: testCase.acceptedPackageCode,
        room_type: testCase.acceptedRoomType || 'shared',
        total_cents: 42000,
        deposit_required_cents: 20000,
        availability_checked: true,
      },
    },
    acceptedCommercialIdentity: {
      package_code: testCase.expectedPackageCode,
      accommodation_only: testCase.expectedAccommodationOnly,
      room_type: testCase.expectedRoomType || 'shared',
      guest_packages: [{ guest_number: 1, package_code: testCase.expectedPackageCode }],
      source: acceptedMalibu ? 'accepted_package' : 'accepted_plain_shared',
    },
  };
}

function bookingInsert(calls) {
  return calls.find((row) => /inserted_booking_beds|beds_inserted/i.test(row.text));
}

function metadataUpdate(calls) {
  return calls.find((row) => row.text.includes('SET total_amount_cents')
    && row.params.some((value) => typeof value === 'string' && value.startsWith('{')));
}

async function runCase(testCase) {
  const pg = makeCapturingPg();
  const result = await executeWolfhouseBookingCreate(pg, commandFor(testCase));
  assert.equal(result.ok, true, `${testCase.name}: booking save must not be blocked`);

  const insert = bookingInsert(pg.calls);
  assert.ok(insert, `${testCase.name}: booking INSERT must execute`);
  const scalarPackage = insert.params.find((value) => value === 'malibu' || value === 'package_none') ?? null;
  assert.equal(scalarPackage, testCase.expectedPackageCode,
    `${testCase.name}: booking scalar must use accepted commercial identity`);

  const update = metadataUpdate(pg.calls);
  assert.ok(update, `${testCase.name}: current metadata update must execute`);
  const metadata = JSON.parse(update.params.find((value) => typeof value === 'string' && value.startsWith('{')));
  assert.equal(metadata.package_code, testCase.expectedPackageCode,
    `${testCase.name}: metadata package must match booking scalar`);
  assert.equal(metadata.accommodation_only, testCase.expectedAccommodationOnly,
    `${testCase.name}: accommodation-only flag must match accepted identity`);
  assert.equal(metadata.quote_snapshot.package_code, testCase.expectedPackageCode,
    `${testCase.name}: quote snapshot must match accepted identity`);
}

(async () => {
  await runCase(MALIBU_ACCEPTED_STALE_BODY);
  await runCase(PLAIN_ACCEPTED_STALE_OFFER);
  console.log('PASS BC-SKIP C17 coherent accepted commercial identity');
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
