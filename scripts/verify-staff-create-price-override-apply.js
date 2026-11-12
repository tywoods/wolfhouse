'use strict';

/**
 * Staff Create Booking price override must be applied and saved.
 * Recalculate/save used to keep catalog Malibu €/night while storing
 * package_code=manual_override — silent drop. Fail closed if it cannot apply.
 *
 * Run: node scripts/verify-staff-create-price-override-apply.js
 */

const assert = require('node:assert/strict');
const { loadConfig } = require('./lib/wolfhouse-quote-calculator');
const { applyAuthoritativeSeasonsToConfig } = require('./lib/wolfhouse-pricing-resolve');
const {
  executeWolfhouseAccommodationQuote,
} = require('./lib/wolfhouse-accommodation-application');
const {
  BOOKING_CREATE_CHANNELS,
  buildWolfhouseBookingCreateCommand,
} = require('./lib/luna-front-desk-accommodation-booking-create-service');

const config = applyAuthoritativeSeasonsToConfig(loadConfig(), [
  { code: 'spring_autumn', bookable: true, active: true, priority: 0, sort_order: 0,
    ranges: [{ start_month: 4, start_day: 1, end_month: 6, end_day: 30 }, { start_month: 10, start_day: 1, end_month: 11, end_day: 30 }] },
  { code: 'summer', bookable: true, active: true, priority: 0, sort_order: 1,
    ranges: [{ start_month: 7, start_day: 1, end_month: 9, end_day: 30 }] },
  { code: 'august', bookable: true, active: true, priority: 10, sort_order: 2,
    ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }] },
  { code: 'closed', bookable: false, active: true, priority: 0, sort_order: 3,
    ranges: [{ start_month: 12, start_day: 1, end_month: 2, end_day: 29 }] },
]);
const nights = 3;
const overrideEuros = 45;
const overrideCents = 4500;
const expectedTotalCents = overrideCents * nights; // 1 guest, shared, no add-ons

const tyPayload = {
  client_slug: 'wolfhouse-somo',
  check_in: '2027-08-23',
  check_out: '2027-08-26',
  guest_count: 1,
  room_type: 'shared',
  payment_choice: 'deposit',
  package_code: 'manual_override',
  manual_price_per_night_euros: overrideEuros,
  guest_packages: [{ guest_number: 1, package_code: 'malibu' }],
};

function accommodationUnit(quote) {
  const items = (quote && quote.line_items) || [];
  return items.find((item) => item.code === 'manual_accommodation')
    || items.find((item) => item.code === 'package' || item.code === 'package_proration' || item.code === 'guest_package' || item.code === 'guest_package_proration')
    || items[0]
    || null;
}

const catalog = executeWolfhouseAccommodationQuote({
  ...tyPayload,
  package_code: 'malibu',
  manual_price_per_night_euros: undefined,
}, { config });
assert.equal(catalog.ok, true, 'catalog quote must succeed so we can prove override differs');
const catalogUnit = accommodationUnit(catalog.body.quote);
assert.ok(catalogUnit && catalogUnit.unit_cents === 5000, 'Ty report: catalog Malibu is 5000¢/night');
assert.notEqual(catalog.body.quote.total_cents, expectedTotalCents, 'override total must not equal catalog');

const preview = executeWolfhouseAccommodationQuote(tyPayload, { config });
assert.equal(preview.ok, true, `preview must succeed: ${JSON.stringify(preview.body)}`);
const previewQuote = preview.body.quote;
assert.equal(previewQuote.success, true, JSON.stringify(previewQuote.blockers || previewQuote));
const previewUnit = accommodationUnit(previewQuote);
assert.ok(previewUnit, 'preview has an accommodation line');
assert.equal(previewUnit.code, 'manual_accommodation', 'preview must use the override line, not catalog package');
assert.equal(previewUnit.unit_cents, overrideCents, `preview nightly must be ${overrideCents} not catalog ${catalogUnit.unit_cents}`);
assert.equal(previewQuote.total_cents, expectedTotalCents, 'preview total is override × nights');
assert.equal(previewQuote.package_code, 'manual_override');

const badPreview = executeWolfhouseAccommodationQuote({
  ...tyPayload,
  manual_price_per_night_euros: 'nope',
}, { config });
assert.equal(badPreview.ok, false, 'invalid override must not fall back to catalog');
assert.notEqual(
  badPreview.body && badPreview.body.quote && badPreview.body.quote.total_cents,
  catalog.body.quote.total_cents,
);

async function runCreate() {
  const built = await buildWolfhouseBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
    trustedClientSlug: 'wolfhouse-somo',
    quoteConfig: config,
    actorHints: { staff_user_id: 'staff-override-test', staff_role: 'operator' },
    transportBody: {
      ...tyPayload,
      payment_choice: 'no_payment_yet',
      guest_name: 'Override Guest',
      guests: [{ name: 'Override Guest' }],
      selected_bed_codes: ['R1-B1'],
      confirm: true,
    },
  });
  assert.equal(built.ok, true, `create command must not reject override: ${JSON.stringify(built.body)}`);
  assert.equal(built.command.effectivePackageCode, 'manual_override');
  assert.equal(built.command.storagePackageCode, 'manual_override');
  const createQuote = built.command.quote;
  const createUnit = accommodationUnit(createQuote);
  assert.ok(createUnit, 'create quote has an accommodation line');
  assert.equal(createUnit.code, 'manual_accommodation');
  assert.equal(createUnit.unit_cents, overrideCents, 'create quote_snapshot nightly must be the override');
  assert.equal(createQuote.total_cents, expectedTotalCents);
  assert.equal(createQuote.package_code, 'manual_override');

  const rejected = await buildWolfhouseBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
    trustedClientSlug: 'wolfhouse-somo',
    quoteConfig: config,
    actorHints: { staff_user_id: 'staff-override-test', staff_role: 'operator' },
    transportBody: {
      ...tyPayload,
      manual_price_per_night_euros: 'nope',
      payment_choice: 'no_payment_yet',
      guest_name: 'Override Guest',
      guests: [{ name: 'Override Guest' }],
      selected_bed_codes: ['R1-B1'],
      confirm: true,
    },
  });
  assert.equal(rejected.ok, false, 'invalid override on save must error, not silent catalog');
  assert.notEqual(rejected.body && rejected.body.reason_code, 'missing_package');
}

runCreate().then(() => {
  console.log('PASS staff create booking price override is applied');
}).catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
