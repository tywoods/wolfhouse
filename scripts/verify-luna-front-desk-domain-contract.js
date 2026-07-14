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
  'luna-front-desk-business-vertical.js',
  'luna-front-desk-accommodation-booking-create-service.js',
  'luna-front-desk-accommodation-availability-service.js',
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
const botSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-bot-v2-routes.js'), 'utf8');
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
assert('routes use vertical resolver', /resolveBusinessVertical/.test(apiSrc));
assert('routes invoke vertical operations', /invokeVerticalOperation/.test(apiSrc));
assert('routes do not call executeSunsetBookingCreate directly', !/executeSunsetBookingCreate\s*\(/.test(apiSrc));
assert('routes do not call executeSunsetQuote directly', !/executeSunsetQuote\s*\(/.test(apiSrc));
assert('service exports executeSunsetBookingCreate', /executeSunsetBookingCreate/.test(serviceSrc));
assert('service channels manual_staff + luna_whatsapp', /manual_staff/.test(serviceSrc) && /luna_whatsapp/.test(serviceSrc));
assert('quote service exports executeSunsetQuote', /executeSunsetQuote/.test(quoteServiceSrc));
assert('quote service stale provenance', /validateQuoteProvenanceForCreate/.test(quoteServiceSrc));

console.log('\n[8] Accommodation vertical boundary (Slice 7)');
const accAdapterSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'verticals', 'accommodation-vertical-adapter.js'), 'utf8');
const accAppSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'wolfhouse-accommodation-application.js'), 'utf8');
const accCreateSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'luna-front-desk-accommodation-booking-create-service.js'), 'utf8');
const accAvailSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'luna-front-desk-accommodation-availability-service.js'), 'utf8');
const contractDoc = fs.readFileSync(CONTRACT, 'utf8');
assert('contract documents wolfhouse-somo tenant', /wolfhouse-somo/.test(contractDoc));
assert('accommodation adapter exists', /accommodationVerticalAdapter/.test(accAdapterSrc));
assert('application delegates to calculateWolfhouseQuote', /calculateWolfhouseQuote/.test(accAppSrc));
assert('application rejects surf-school fields', /surf_school_fields_not_supported/.test(accAppSrc));
assert('application uses accommodation booking create service', /buildWolfhouseBookingCreateCommand/.test(accAppSrc));
assert('quote-preview uses accommodation application', /executeWolfhouseAccommodationQuote/.test(apiSrc));
assert('staff-bot-v2 package preview uses vertical invoke', /invokeVerticalOperation/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-bot-v2-routes.js'), 'utf8')));
assert('no Sunset catalog import in accommodation app', !/luna-front-desk-catalog-service/.test(accAppSrc));
assert('no Sunset quote import in accommodation app', !/luna-front-desk-quote-service/.test(accAppSrc));
assert('accommodation create service exports executeWolfhouseBookingCreate', /executeWolfhouseBookingCreate/.test(accCreateSrc));
assert('accommodation create channels manual_staff + luna_whatsapp', /manual_staff/.test(accCreateSrc) && /luna_whatsapp/.test(accCreateSrc));
assert('routes use buildWolfhouseBookingCreateCommand', /buildWolfhouseBookingCreateCommand/.test(apiSrc));
assert('contract documents accommodation booking create service', /luna-front-desk-accommodation-booking-create-service/.test(contractDoc));
assert('application uses accommodation availability service', /executeWolfhouseAvailabilityCheck/.test(accAppSrc));
assert('application no direct dry-run availability', !/runAvailabilityCheckDryRun/.test(accAppSrc));
assert('availability service exports executeWolfhouseAvailabilityCheck', /executeWolfhouseAvailabilityCheck/.test(accAvailSrc));
assert('availability provenance versioning', /AVAILABILITY_PROVENANCE_VERSION/.test(accAvailSrc));
assert('availability write-time recheck', /validateAvailabilityProvenanceForCreate/.test(accAvailSrc));
assert('booking create uses availability recheck', /validateAvailabilityProvenanceForCreate/.test(accCreateSrc));
assert('bot availability route delegates to service', /executeWolfhouseAvailabilityCheck/.test(apiSrc));
assert('bot availability route HTTP mapper', /mapBotHttpAvailabilityResponse/.test(apiSrc));
assert('contract documents accommodation availability service', /luna-front-desk-accommodation-availability-service/.test(contractDoc));

const payLinkSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'luna-front-desk-payment-link-service.js'), 'utf8');
assert('payment-link service exports createPaymentLink', /createPaymentLink/.test(payLinkSrc));
assert('payment-link service exports getPaymentStatus', /getPaymentStatus/.test(payLinkSrc));
assert('payment-link service exports cancelOrInvalidatePaymentLink', /cancelOrInvalidatePaymentLink/.test(payLinkSrc));
assert('payment-link stale metadata guard', /resolveActionableCheckoutUrl/.test(payLinkSrc));
assert('staff routes delegate createPaymentLink', /createPaymentLink\(pg, built\.command/.test(apiSrc));
assert('staff routes delegate cancelOrInvalidatePaymentLink', /cancelOrInvalidatePaymentLink\(pg, built\.command/.test(apiSrc));
assert('bot routes delegate createPaymentLink', /createPaymentLink\(pg, built\.command/.test(botSrc));
assert('sunset getSunsetSchedulePaymentLink uses getPaymentStatus', /getPaymentStatus\(pg, built\.command/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'sunset-stripe-payment-links.js'), 'utf8')));
assert('contract documents payment-link service', /luna-front-desk-payment-link-service/.test(contractDoc));
assert('contract documents payment lifecycle', /PAYMENT_LINK_LIFECYCLE|payment-link application service/i.test(contractDoc));
assert('contract documents schedule portal module', /sunset-schedule-portal-module/.test(contractDoc));
assert('portal module inject marker', /INJECT:sunset-schedule-portal-module/.test(apiSrc));
assert('portal module defines schedulePortalFetchQuote', /schedulePortalFetchQuote/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js'), 'utf8')));
assert('contract documents drawer view module', /sunset-schedule-drawer-view-ui/.test(contractDoc));
assert('drawer view inject marker', /INJECT:sunset-schedule-drawer-view-ui/.test(apiSrc));
assert('drawer view module defines scheduleRenderViewDrawerHtml', /scheduleRenderViewDrawerHtml/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js'), 'utf8')));

console.log(`\n── verify:luna-front-desk-domain-contract ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
process.exit(fail ? 1 : 0);
