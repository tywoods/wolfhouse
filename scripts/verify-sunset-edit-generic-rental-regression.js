'use strict';

/**
 * Regression: Edit Save must accept generic Admin catalog rentals the same way
 * Quote/Create do (prepareGeneric first, then canonical allowlist).
 * Pure offline — no staging DB / live bookings.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  prepareCanonicalRentalsForCreate,
  prepareGenericRentalsForCreate,
  inclusiveIsoDatesFromRange,
  rentalDurationKeyFromDateRange,
} = require('./lib/sunset-schedule-booking-writes');

let pass = 0;
function ok(name, cond, detail) {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    process.exit(1);
  }
  console.log(`PASS ${name}`);
  pass += 1;
}

process.env.GENERIC_RENTAL_CREATE_ENABLED = 'true';

const DATE = '2026-08-20';
const offeringKey = 'towel_rental_' + Math.random().toString(36).slice(2, 8);
const durationKey = '1_day';
const catalog = [{
  offering_key: offeringKey,
  label: 'Towel Test',
  active: true,
  location_id: 'sunset-somo',
  excludes: [],
}];
const loadCatalog = async () => catalog;
const loadRule = async ({ duration }) => ({
  status: 'found',
  amount_cents: 2200,
  currency: 'EUR',
  item_code: `${offeringKey}__${duration}`,
  unit: 'day',
  location_id: 'sunset-somo',
});

(async () => {
  const body = {
    guest_name: 'Edit Gear Guest',
    date_from: DATE,
    date_to: DATE,
    payment_status: 'unpaid',
    components: {},
    surfer_count: 1,
    rentals: [{ offering_key: offeringKey, duration_key: durationKey, quantity: 1 }],
  };

  const bare = prepareCanonicalRentalsForCreate(body);
  ok('canonical alone still rejects arbitrary generic offering_key (fail-closed allowlist)',
    bare.ok === false && /offering_key is not allowed/.test(String(bare.error || '')),
    JSON.stringify(bare));

  const genericPrep = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    pgClient: {},
    rentals: body.rentals,
    serviceDate: DATE,
    source: 'staff_manual',
    calendarDayCount: inclusiveIsoDatesFromRange(DATE, DATE).length,
    bookingDurationKey: rentalDurationKeyFromDateRange(DATE, DATE),
    listOfferings: loadCatalog,
    loadRule,
  });
  ok('generic prep accepts active scoped offering + duration',
    genericPrep.ok === true
    && genericPrep.genericRentals.length === 1
    && genericPrep.records[0].amount_due_cents === 2200
    && genericPrep.records[0].metadata.offering_key === offeringKey
    && genericPrep.records[0].metadata.offering_label === 'Towel Test',
    JSON.stringify(genericPrep));

  // Mirror updateSunsetScheduleBooking split: strip generics before canonical.
  const CANONICAL = new Set(['board_rental', 'wetsuit_rental', 'board_and_suit_rental']);
  const canonicalRequested = body.rentals.filter((r) => CANONICAL.has(String(r.offering_key || '').trim()));
  let prepBody = { ...body, rentals: canonicalRequested, components: body.components || {} };
  if (genericPrep.genericRentals.length && !canonicalRequested.length) delete prepBody.rentals;
  const rentalPrep = prepareCanonicalRentalsForCreate(prepBody);
  ok('update-style split: canonical prep ok after generic strip (empty rentals)',
    rentalPrep.ok === true && rentalPrep.present === false,
    JSON.stringify(rentalPrep));

  // Duration mismatch still fails closed for multi-day without exact package.
  const badDur = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    pgClient: {},
    rentals: [{ offering_key: offeringKey, duration_key: '4_hours', quantity: 1 }],
    serviceDate: DATE,
    source: 'staff_manual',
    calendarDayCount: 3,
    bookingDurationKey: '3_days',
    listOfferings: loadCatalog,
    loadRule: async ({ duration }) => {
      if (duration === '3_days') return { status: 'not_found' };
      return {
        status: 'found', amount_cents: 500, currency: 'EUR',
        item_code: `${offeringKey}__${duration}`, unit: 'session', location_id: 'sunset-somo',
      };
    },
  });
  ok('hour duration on multi-day range fails closed',
    badDur.ok === false && badDur.reason === 'rental_duration_not_compatible',
    JSON.stringify(badDur));

  // Foreign location catalog entry rejected.
  const foreign = await prepareGenericRentalsForCreate({
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    pgClient: {},
    rentals: [{ offering_key: 'foreign_only', duration_key: '1_day', quantity: 1 }],
    serviceDate: DATE,
    listOfferings: async () => [{
      offering_key: 'foreign_only', label: 'Foreign', active: true,
      location_id: 'sunset-sardinero', excludes: [],
    }],
    loadRule,
  });
  ok('inactive/foreign offering fail-closed (not active at location)',
    foreign.ok === false
    && (
      foreign.reason === 'rental_offering_not_active'
      || foreign.reason === 'invalid_rental_offering'
      || foreign.reason === 'price_scope_mismatch'
      || foreign.reason === 'price_not_found'
    ),
    JSON.stringify(foreign));

  const drawerSrc = fs.readFileSync(
    path.join(__dirname, 'lib/sunset-schedule-booking-drawer.js'),
    'utf8',
  );
  ok('updateSunsetScheduleBooking wires prepareGenericRentalsForCreate',
    /async function updateSunsetScheduleBooking[\s\S]*prepareGenericRentalsForCreate/.test(drawerSrc));
  ok('update inserts genericPrep.records into service rows',
    /for \(const descriptor of genericPrep\.records/.test(drawerSrc));

  console.log(`\nverify-sunset-edit-generic-rental-regression — ${pass} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
