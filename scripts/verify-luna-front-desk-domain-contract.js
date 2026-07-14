'use strict';

/**
 * verify:luna-front-desk-domain-contract
 *
 * Locks docs/LUNA-FRONT-DESK-DOMAIN-CONTRACT.md to the current Sunset
 * canonical modules and API shapes. Behavior-first: exercises the same
 * projection / schedule / quote / write gates the contract documents.
 *
 * Run:
 *   node scripts/verify-luna-front-desk-domain-contract.js
 */

const fs = require('fs');
const path = require('path');

const {
  evaluateSunsetOfferingDates,
  weekdayOfIsoDate,
  staffFacingOfferingScheduleError,
} = require('./lib/sunset-offering-schedule');
const {
  projectSunsetBookableOfferingsFromConfig,
  scheduleCoursesFromBookableProjection,
} = require('./lib/sunset-bookable-offerings');
const {
  buildSunsetLunaCatalogFromConfig,
  quoteSunsetOfferingFromCatalog,
} = require('./lib/sunset-luna-admin-catalog');
const {
  resolveActiveSunsetAdminPrice,
  staffFacingSunsetAdminPriceError,
} = require('./lib/sunset-admin-price-resolve');
const {
  validateScheduleBookingBody,
  normalizeComponents,
} = require('./lib/sunset-schedule-booking-writes');
const {
  courseTierIdentity,
  packPriceItemCode,
} = require('./lib/sunset-admin-price-identity');
const { datesBelongToPackSchedule } = require('./lib/sunset-offering-schedule');

const ROOT = path.join(__dirname, '..');
const CONTRACT = path.join(ROOT, 'docs', 'LUNA-FRONT-DESK-DOMAIN-CONTRACT.md');

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

const COURSE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TIER = '1_week';
const ITEM = packPriceItemCode(COURSE, TIER);
const AMOUNT = 19900;
const FRIDAY = '2026-07-17';
const SATURDAY = '2026-07-18';
const LOC = 'sunset-somo';

const weekendPack = {
  pack_id: COURSE,
  label: 'Contract Weekend Course',
  active: true,
  age_band: '12_and_up',
  group_size: 8,
  beaches: ['somo'],
  weekly: 'sat_sun',
  schedules: ['0930_1130'],
  price_tiers: [{ key: TIER, label: '1 week', hours: 10, amount_cents: AMOUNT }],
};

const adminCfg = {
  ok: true,
  source: 'db',
  currency: 'EUR',
  surf_packs: [weekendPack],
  prices: [{
    id: 'price-contract-1',
    category: 'package',
    offering_key: ITEM,
    item_code: ITEM,
    amount_cents: AMOUNT,
    unit: 'day',
    active: true,
    currency: 'EUR',
  }],
};

console.log('\nverify:luna-front-desk-domain-contract\n');

console.log('[0] Contract doc exists and references canonical modules');
assert('contract markdown present', fs.existsSync(CONTRACT));
const doc = fs.readFileSync(CONTRACT, 'utf8');
for (const mod of [
  'sunset-bookable-offerings.js',
  'sunset-offering-schedule.js',
  'luna-front-desk-catalog-service.js',
  'sunset-luna-admin-catalog.js',
  'sunset-admin-price-resolve.js',
  'sunset-schedule-booking-writes.js',
  'sunset-admin-course-join.js',
  'luna-front-desk-quote-service.js',
]) {
  assert(`doc references ${mod}`, doc.includes(mod));
}

console.log('\n[1] Entity identity — OfferingTier item_code');
const identity = courseTierIdentity(COURSE, TIER, LOC);
assert('courseTierIdentity ok', identity && identity.item_code === ITEM);
assert('billing unit day for 1_week', identity && identity.billing_unit === 'day');
assert('item_type package', identity && identity.item_type === 'package');

console.log('\n[2] Admin offering → schedule projection');
const projected = projectSunsetBookableOfferingsFromConfig(adminCfg, {
  locationId: LOC,
  requestedDates: [FRIDAY],
});
assert('projection ok', projected.ok === true);
const offering = (projected.offerings || []).find((o) => o.course_id === COURSE && o.tier_key === TIER);
assert('offering present', !!offering);
assert('offering_id equals item_code', offering && offering.offering_id === ITEM);
assert('weekday ineligible flag', offering && offering.eligible_on_requested_dates === false);
assert('schedule rejection on weekday', offering && offering.schedule_rejection);
const menu = scheduleCoursesFromBookableProjection(projected);
assert('schedule menu includes course', menu.some((c) => c.course_id === COURSE));

console.log('\n[3] ScheduleRule — weekend-only eligibility');
const friSched = evaluateSunsetOfferingDates({ weekly: 'sat_sun' }, [FRIDAY]);
const satSched = evaluateSunsetOfferingDates({ weekly: 'sat_sun' }, [SATURDAY]);
assert('Friday rejected', friSched.ok === false);
assert('Saturday accepted', satSched.ok === true);
const staffMsg = staffFacingOfferingScheduleError('service_dates_not_on_course_schedule', { allowed_weekdays: [0, 6] });
assert('staff weekend message', /weekend/i.test(staffMsg.error || ''));

console.log('\n[4] Catalog + Quote application operations (Luna read path)');
const catalogFri = buildSunsetLunaCatalogFromConfig(adminCfg, {
  locationId: LOC,
  requestedDates: [FRIDAY],
});
assert('catalog ok', catalogFri.ok === true);
const catOff = (catalogFri.offerings || []).find((o) => o.offering_id === ITEM);
assert('catalog offering', !!catOff);
assert('catalog weekday ineligible', catOff && catOff.eligible_on_requested_dates === false);

const badQuote = quoteSunsetOfferingFromCatalog(adminCfg, {
  location_id: LOC,
  offering_id: ITEM,
  course_id: COURSE,
  tier_key: TIER,
  service_dates: [FRIDAY],
  quantity: 1,
});
assert('weekday quote fails closed', badQuote.ok === false);
assert('weekday quote mentions weekends', /weekend/i.test(badQuote.error || ''));

const goodQuote = quoteSunsetOfferingFromCatalog(adminCfg, {
  location_id: LOC,
  offering_id: ITEM,
  course_id: COURSE,
  tier_key: TIER,
  service_dates: [SATURDAY],
  quantity: 1,
});
assert('weekend quote ok', goodQuote.ok === true);
assert('quote total = admin price', goodQuote.total_cents === AMOUNT);
assert('quote price_source admin_db', goodQuote.price_source === 'admin_db');
assert('quote offering_item_code', goodQuote.offering_item_code === ITEM);

console.log('\n[5] Write validation order — client money fields rejected');
const normBad = normalizeComponents({
  course: {
    course_id: COURSE,
    tier_key: TIER,
    quantity: 1,
    unit_amount_cents: 100,
  },
});
assert('normalize rejects client unit_amount_cents', normBad.ok === false);

const bodyCheck = validateScheduleBookingBody({
  guest_name: 'Contract Guest',
  service_dates: [FRIDAY],
  payment_status: 'unpaid',
  components: {
    course: {
      course_id: COURSE,
      tier_key: TIER,
      quantity: 1,
    },
  },
});
assert('validate body shape ok pre-write', bodyCheck.ok === true);

const packSched = datesBelongToPackSchedule(weekendPack, [FRIDAY]);
assert('pack schedule rejects Friday', packSched.ok === false);

console.log('\n[6] PriceRule staff messages');
const priceErr = staffFacingSunsetAdminPriceError('no_price_for_surf_lesson');
assert('staff price error is guest-safe', priceErr && priceErr.error && !/tenant_price_rules|sql/i.test(priceErr.error));

console.log('\n[7] HTTP surface documented in staff-query-api');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const serviceSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'luna-front-desk-booking-create-service.js'), 'utf8');
const quoteServiceSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'luna-front-desk-quote-service.js'), 'utf8');
for (const route of [
  '/staff/bot/sunset/catalog',
  '/staff/bot/sunset/offering-quote',
  '/staff/bot/sunset/booking-create',
  '/staff/schedule/bookings',
]) {
  assert(`route ${route}`, apiSrc.includes(route));
}
assert('bot booking requires guest_confirmed_booking', /guest_confirmed_booking_required/.test(apiSrc));
assert('routes call executeSunsetBookingCreate', /executeSunsetBookingCreate/.test(apiSrc));
assert('routes call executeSunsetQuote', /executeSunsetQuote/.test(apiSrc));
assert('service exports executeSunsetBookingCreate', /executeSunsetBookingCreate/.test(serviceSrc));
assert('service channels manual_staff + luna_whatsapp', /manual_staff/.test(serviceSrc) && /luna_whatsapp/.test(serviceSrc));
assert('quote service exports executeSunsetQuote', /executeSunsetQuote/.test(quoteServiceSrc));
assert('quote service stale provenance', /validateQuoteProvenanceForCreate/.test(quoteServiceSrc));

console.log(`\n── verify:luna-front-desk-domain-contract ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
process.exit(fail ? 1 : 0);
