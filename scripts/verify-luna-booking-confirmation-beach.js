'use strict';

const assert = require('assert');
const {
  resolveSunsetBookingBeach,
  buildScheduleBookingIntentFingerprint,
  buildCreateRequestIdempotencyIdentity,
  evaluateIdempotentReplay,
} = require('./lib/sunset-schedule-booking-writes');

function fakePg(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      assert.match(sql, /tenant_surf_beaches/);
      return { rows };
    },
  };
}

(async () => {
  console.log('\nverify: luna booking confirmation beach\n');

  const onePg = fakePg([{ beach_key: 'somo', display_name: 'Somo' }]);
  const one = await resolveSunsetBookingBeach(onePg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    assignedCourses: [{ pack: { beaches: ['somo'] } }],
  });
  assert.deepStrictEqual(one, { beach_key: 'somo', display_name: 'Somo' });
  assert.deepStrictEqual(onePg.calls[0].params, ['sunset', 'sunset-somo', ['somo']]);
  console.log('  PASS single course beach resolves its registry display name');

  const selectedPg = fakePg([
    { beach_key: 'somo', display_name: 'Somo' },
    { beach_key: 'liencres', display_name: 'Liencres' },
  ]);
  const selected = await resolveSunsetBookingBeach(selectedPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    requestedBeachKey: 'liencres',
    assignedCourses: [{ pack: { beaches: ['somo', 'liencres'] } }],
  });
  assert.deepStrictEqual(selected, { beach_key: 'liencres', display_name: 'Liencres' });
  console.log('  PASS multi-beach course uses the beach tied to the booking');

  const unknownPg = fakePg([
    { beach_key: 'somo', display_name: 'Somo' },
    { beach_key: 'liencres', display_name: 'Liencres' },
  ]);
  const unknown = await resolveSunsetBookingBeach(unknownPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    assignedCourses: [{ pack: { beaches: ['somo', 'liencres'] } }],
  });
  assert.deepStrictEqual(unknown, null);
  console.log('  PASS multi-beach course never invents a beach when booking has none');

  const mismatchPg = fakePg([{ beach_key: 'somo', display_name: 'Somo' }]);
  const mismatch = await resolveSunsetBookingBeach(mismatchPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    requestedBeachKey: 'liencres',
    assignedCourses: [{ pack: { beaches: ['somo'] } }],
  });
  assert.deepStrictEqual(mismatch, null);
  console.log('  PASS requested beach must belong to every assigned course');

  const baseIntent = {
    guest_name: 'Beach Guest',
    guest_phone: '+34000000000',
    payment_status: 'unpaid',
    service_dates: ['2026-09-24'],
    components: { course: { course_id: 'course-1', quantity: 1 } },
    beach_key: 'somo',
  };
  const somoFp = buildScheduleBookingIntentFingerprint(baseIntent, 'sunset-somo', {});
  const liencresFp = buildScheduleBookingIntentFingerprint(
    { ...baseIntent, beach_key: 'liencres' }, 'sunset-somo', {},
  );
  assert.notStrictEqual(somoFp, liencresFp);
  const transportIdentity = buildCreateRequestIdempotencyIdentity(
    baseIntent, 'sunset-somo', null,
  );
  assert.strictEqual(transportIdentity.ok, true);
  assert.strictEqual(transportIdentity.fingerprint, somoFp);
  console.log('  PASS selected beach is bound into transport and stored intent fingerprints');

  const replayRow = {
    booking_code: 'SUN-BEACH-1',
    booking_id: '00000000-0000-4000-8000-000000000001',
    booking_status: 'confirmed',
    location_id: 'sunset-somo',
    idempotency_intent_fp: somoFp,
    booking_beach: { beach_key: 'somo', display_name: 'Somo' },
  };
  const exactReplay = evaluateIdempotentReplay(
    [replayRow], baseIntent, 'sunset-somo', { intent_fingerprint: somoFp },
  );
  assert.strictEqual(exactReplay.ok, true);
  assert.deepStrictEqual(exactReplay.body.beach, replayRow.booking_beach);
  assert.strictEqual(exactReplay.body.guest_confirmation_text, 'Your lesson is booked at Somo.');
  const changedBeachReplay = evaluateIdempotentReplay(
    [replayRow], { ...baseIntent, beach_key: 'liencres' }, 'sunset-somo',
    { intent_fingerprint: liencresFp },
  );
  assert.strictEqual(changedBeachReplay.ok, false);
  assert.strictEqual(changedBeachReplay.body.reason_code, 'idempotency_key_intent_conflict');
  console.log('  PASS exact replay preserves beach and changed-beach replay conflicts');

  console.log('\n6 passed\n');
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
