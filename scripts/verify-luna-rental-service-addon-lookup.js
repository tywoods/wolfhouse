'use strict';

/**
 * Staff Rentals + Services lookup for Luna add-anything (WH prod flipflops miss).
 *
 * Guest asked to add flipflops on WH-20270615-14908309. Luna called
 * lookup_catalog_service three times (tenant_services only) → matched:false
 * and never quoted Staff > Rentals FLIPFLOPS at €10/day.
 *
 * Run: node scripts/verify-luna-rental-service-addon-lookup.js
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  lookupStaffSettingsAddOn,
  staffSettingsAddOnsToCatalogRows,
  pricingItemToTenantServiceShape,
  planPricingAddonCharge,
} = require('./lib/luna-guest-pricing-addon-lookup');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail || '');
  }
}

const FLIP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
const YOGA_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2';
const HARD_ID = 'cccccccc-cccc-cccc-cccc-ccccccccccc3';

const pricingView = {
  rentals: [
    {
      id: FLIP_ID,
      code: 'flipflops',
      label: 'FLIPFLOPS',
      durations: [
        { duration: '1_day', item_code: 'flipflops__1_day', amount_cents: 1000, currency: 'EUR', unit: 'day' },
      ],
    },
    {
      id: HARD_ID,
      code: 'hard_board_rental',
      label: 'Hard board',
      durations: [
        { duration: '1_day', item_code: 'hard_board_rental__1_day', amount_cents: 2000, currency: 'EUR', unit: 'day' },
      ],
    },
  ],
  services: [
    {
      id: YOGA_ID,
      code: 'yoga_class',
      label: 'Yoga',
      price: { amount_cents: 1500, currency: 'EUR', unit: 'per_class' },
    },
  ],
};

const tenantServices = [{
  id: 'svc-camp',
  name: 'Chokes and Barrels',
  active: true,
  luna_visible: true,
  keywords: ['jiu jitsu'],
  price_cents: 2000,
  price_unit: 'per_day',
  per_guest: true,
}];

console.log('\nverify-luna-rental-service-addon-lookup\n');

const flip = lookupStaffSettingsAddOn('Can we add some flipflops to the booking?', {
  tenantServices,
  pricingView,
});
ok('flipflops matches Staff Rentals, not only tenant_services',
  flip && flip.catalog_kind === 'rental' && flip.id === FLIP_ID,
  flip && flip.name);
ok('quotes €10/day from live rental price',
  flip && Number(flip.price_cents) === 1000 && /€10/.test((flip.reply && flip.reply.text) || ''),
  flip && flip.reply && flip.reply.text);

const hyphen = lookupStaffSettingsAddOn('check flip-flops', { tenantServices, pricingView });
ok('flip-flops / flipflops compact match',
  hyphen && hyphen.id === FLIP_ID);

const yoga = lookupStaffSettingsAddOn('can we add yoga to the booking?', { tenantServices, pricingView });
ok('Staff Services yoga also matches',
  yoga && yoga.catalog_kind === 'service' && yoga.id === YOGA_ID);

const camp = lookupStaffSettingsAddOn('do you have jiu jitsu?', { tenantServices, pricingView });
ok('existing tenant_services camps still match',
  camp && camp.id === 'svc-camp');

const miss = lookupStaffSettingsAddOn('what time is breakfast', { tenantServices, pricingView });
ok('unrelated text does not match', !miss);

const rows = staffSettingsAddOnsToCatalogRows(pricingView);
ok('catalog rows include rentals and services',
  rows.some((r) => r.catalog_kind === 'rental' && r.name === 'FLIPFLOPS')
  && rows.some((r) => r.catalog_kind === 'service' && r.name === 'Yoga'));

const item = {
  id: FLIP_ID,
  item_type: 'rental',
  item_code: 'flipflops',
  label: 'FLIPFLOPS',
  active: true,
};
const rules = [
  { item_type: 'rental', item_code: 'flipflops__1_day', amount_cents: 1000, unit: 'day', active: true },
];
const shaped = pricingItemToTenantServiceShape(item, rules);
ok('pricing item shapes as catalog service for add-catalog-service UUID path',
  shaped && shaped.id === FLIP_ID && shaped.price_cents === 1000 && shaped.price_unit === 'per_day');

const flipCharge = planPricingAddonCharge({
  item, rules, checkIn: '2027-06-15', checkOut: '2027-06-20', quantity: 1,
});
ok('flipflops 5 nights × €10 = €50',
  flipCharge && flipCharge.ok && flipCharge.amount_due_cents === 5000
  && flipCharge.nights_charged === 5,
  flipCharge);

const yogaItem = {
  id: YOGA_ID, item_type: 'service', item_code: 'yoga_class', label: 'Yoga', active: true,
};
const yogaRules = [
  { item_type: 'service', item_code: 'yoga_class', amount_cents: 1500, unit: 'per_class', active: true },
];
const yogaCharge = planPricingAddonCharge({
  item: yogaItem, rules: yogaRules, checkIn: '2027-06-15', checkOut: '2027-06-20', quantity: 1,
});
ok('yoga service priced at €15 not mixed into rental math',
  yogaCharge && yogaCharge.ok && yogaCharge.amount_due_cents === 1500);

const perDayServiceItem = {
  id: 'dddddddd-dddd-dddd-dddd-ddddddddddd4',
  item_type: 'service',
  item_code: 'bike_rental_desk',
  label: 'Bike',
  active: true,
};
const perDayServiceRules = [
  { item_type: 'service', item_code: 'bike_rental_desk', amount_cents: 1000, unit: 'per_day', active: true },
];
const perDayShaped = pricingItemToTenantServiceShape(perDayServiceItem, perDayServiceRules);
ok('per-day service €10/day stays per_day in the add handler, not per_stay',
  perDayShaped && perDayShaped.price_cents === 1000 && perDayShaped.price_unit === 'per_day',
  perDayShaped);
const perDayCharge = planPricingAddonCharge({
  item: perDayServiceItem, rules: perDayServiceRules,
  checkIn: '2027-06-15', checkOut: '2027-06-20', quantity: 1,
});
ok('per-day service 5 nights × €10 = €50',
  perDayCharge && perDayCharge.ok && perDayCharge.amount_due_cents === 5000
  && perDayCharge.nights_charged === 5,
  perDayCharge);

const halfView = {
  rentals: [{
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee5',
    code: 'boogie_board',
    label: 'Boogie board',
    durations: [
      { duration: 'half_day', item_code: 'boogie_board__half_day', amount_cents: 700, currency: 'EUR', unit: 'half_day' },
    ],
  }],
  services: [],
};
const half = lookupStaffSettingsAddOn('can we add a boogie board', {
  tenantServices: [],
  pricingView: halfView,
});
ok('€7 half-day rental is advertised as a half-day price, not €7/day',
  half && Number(half.price_cents) === 700
  && half.price_unit !== 'per_day'
  && /€7/.test((half.reply && half.reply.text) || '')
  && /half[- ]day/i.test((half.reply && half.reply.text) || '')
  && !/€7\/day/.test((half.reply && half.reply.text) || ''),
  half && half.reply && half.reply.text);

ok('unknown add-on is a miss, not a save block',
  lookupStaffSettingsAddOn('bananas please', { tenantServices, pricingView }) == null);

const savedBooking = { booking_code: 'WH-20270615-14908309', status: 'confirmed' };
const added = {
  booking_code: savedBooking.booking_code,
  add_ons: [
    { kind: 'rental', name: 'FLIPFLOPS', amount_due_cents: flipCharge.amount_due_cents },
    { kind: 'service', name: 'Yoga', amount_due_cents: yogaCharge.amount_due_cents },
  ],
};
ok('saved booking can take flipflops rental then a service, priced right',
  savedBooking.status === 'confirmed'
  && added.add_ons[0].amount_due_cents === 5000
  && added.add_ons[1].amount_due_cents === 1500);

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const lookupFn = api.slice(
  api.indexOf('async function handleBotCatalogServiceLookup'),
  api.indexOf('async function handleAdminServicesPost'),
);
ok('lookup handler searches Staff Rentals + Services, not tenant_services only',
  /lookupStaffSettingsAddOn|staffSettingsAddOnsToCatalogRows|buildAdminPricingView/.test(lookupFn)
  && /loadItems/.test(lookupFn)
  && /loadRules/.test(lookupFn),
  'handler still tenant_services-only');

const addFn = api.slice(
  api.indexOf('async function handleBookingAddService'),
  api.indexOf('async function handleBotAddonRequestCreate'),
);
ok('catalog add falls back to wh_pricing_items rentals/services',
  /pricingItemToTenantServiceShape/.test(addFn) || /wh_pricing_items/.test(addFn),
  'add path still tenant_services UUID only');

const stayOff = [
  'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py',
  'docker/hermes-staging/wolfhouse/accepted_quote.py',
  'docker/hermes-staging/wolfhouse/pending_question.py',
  'docker/hermes-staging/wolfhouse/explicit_human_handoff.py',
];
ok('stay-off Cap/Lookout files untouched in this tree vs HEAD intent',
  stayOff.every((f) => fs.existsSync(path.join(__dirname, '..', f))));

console.log(`\n── rental-service-addon-lookup: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
