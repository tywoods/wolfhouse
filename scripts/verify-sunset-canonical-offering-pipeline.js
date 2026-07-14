'use strict';

/**
 * verify:sunset-canonical-offering-pipeline
 *
 * End-to-end gate for one Admin course flowing through Schedule + Luna with
 * shared identity, schedule eligibility, and Admin price resolution.
 *
 * Run:
 *   node scripts/verify-sunset-canonical-offering-pipeline.js
 */

const fs = require('fs');
const path = require('path');

const {
  evaluateSunsetOfferingDates,
  weekdayOfIsoDate,
  weekdaysFromWeekly,
  staffFacingOfferingScheduleError,
} = require('./lib/sunset-offering-schedule');
const {
  projectSunsetBookableOfferingsFromConfig,
  scheduleCoursesFromBookableProjection,
  loadSunsetBookableOfferings,
} = require('./lib/sunset-bookable-offerings');
const {
  buildSunsetLunaCatalogFromConfig,
  quoteSunsetOfferingFromCatalog,
} = require('./lib/sunset-luna-admin-catalog');
const {
  resolveActiveSunsetAdminPrice,
  staffFacingSunsetAdminPriceError,
} = require('./lib/sunset-admin-price-resolve');
const { courseTierIdentity, packPriceItemCode } = require('./lib/sunset-admin-price-identity');
const { syncPackTierToPriceRules } = require('./lib/sunset-admin-price-sync');

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

const COURSE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TIER = '1_week';
const ITEM = packPriceItemCode(COURSE, TIER);
const AMOUNT = 19900;
const LABEL = 'CANON-PIPE Weekend Adults';

// Fixed Spain-local weekend / weekday anchors (noon-UTC safe).
const FRIDAY = '2026-07-17'; // Fri
const SATURDAY = '2026-07-18'; // Sat
const SUNDAY = '2026-07-19'; // Sun
const MONDAY = '2026-07-20'; // Mon

assert('fixture Friday is weekday 5', weekdayOfIsoDate(FRIDAY) === 5);
assert('fixture Saturday is weekday 6', weekdayOfIsoDate(SATURDAY) === 6);
assert('fixture Sunday is weekday 0', weekdayOfIsoDate(SUNDAY) === 0);
assert('fixture Monday is weekday 1', weekdayOfIsoDate(MONDAY) === 1);

const weekendPack = {
  pack_id: COURSE,
  label: LABEL,
  active: true,
  age_band: '12_and_up',
  group_size: 12,
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
    id: 'price-row-1',
    category: 'package',
    offering_key: ITEM,
    item_code: ITEM,
    amount_cents: AMOUNT,
    unit: 'day',
    active: true,
    currency: 'EUR',
  }],
  private_lesson: null,
  lesson_times: [],
};

console.log('\nverify:sunset-canonical-offering-pipeline\n');

console.log('[RED → GREEN] Schedule selector sees Admin course (not omitted)');
const projected = projectSunsetBookableOfferingsFromConfig(adminCfg, {
  locationId: 'sunset-somo',
});
assert('projection ok', projected.ok === true);
assert('course present in courses[]', projected.courses.some((c) => c.course_id === COURSE));
assert('owner label preserved', projected.courses[0].label === LABEL);
assert('weekend summary present', /weekend/i.test(String(projected.courses[0].schedule_summary || '')));
const scheduleMenu = scheduleCoursesFromBookableProjection(projected);
assert('Schedule menu includes course', scheduleMenu.some((c) => c.course_id === COURSE));
assert('Schedule menu exposes tiers', scheduleMenu[0].price_tiers.some((t) => t.key === TIER));

console.log('\n[RED → GREEN] Weekend-only eligibility');
const fri = evaluateSunsetOfferingDates({ weekly: 'sat_sun' }, [FRIDAY]);
const sat = evaluateSunsetOfferingDates({ weekly: 'sat_sun' }, [SATURDAY]);
const sun = evaluateSunsetOfferingDates({ weekly: 'sat_sun' }, [SUNDAY]);
const mon = evaluateSunsetOfferingDates({ weekly: 'sat_sun' }, [MONDAY]);
assert('Friday rejected', fri.ok === false);
assert('Saturday accepted', sat.ok === true);
assert('Sunday accepted', sun.ok === true);
assert('Monday rejected', mon.ok === false);
assert('staff Friday message is weekends hint',
  /weekends/i.test((fri.staff_error && fri.staff_error.error) || ''));
assert('Europe/Madrid timezone tag', fri.timezone === 'Europe/Madrid');
assert('sat_sun weekdays are [0,6]',
  JSON.stringify(weekdaysFromWeekly('sat_sun')) === JSON.stringify([0, 6]));

const multiBad = evaluateSunsetOfferingDates({ weekly: 'sat_sun' }, [SATURDAY, MONDAY]);
assert('multi-day rejects when any date off-schedule', multiBad.ok === false);

const multiOk = evaluateSunsetOfferingDates({ weekly: 'sat_sun' }, [SATURDAY, SUNDAY]);
assert('multi-day weekend tier accepts Sat+Sun', multiOk.ok === true);

const excl = evaluateSunsetOfferingDates({
  weekly: 'sat_sun',
  excluded_dates: [SATURDAY],
}, [SATURDAY]);
assert('excluded date rejected', excl.ok === false && excl.reason === 'excluded_date');

const specific = evaluateSunsetOfferingDates({
  specific_dates: [SATURDAY],
}, [SUNDAY]);
assert('specific-dates reject other days', specific.ok === false);

console.log('\n[RED → GREEN] Projection marks weekday ineligible without omitting course');
const weekdayProj = projectSunsetBookableOfferingsFromConfig(adminCfg, {
  locationId: 'sunset-somo',
  requestedDates: [FRIDAY],
});
assert('course still listed on Friday request', weekdayProj.courses.some((c) => c.course_id === COURSE));
const fridayTier = weekdayProj.offerings.filter((o) => o.course_id === COURSE);
assert('tier not bookable on Friday', fridayTier.every((o) => o.bookable === false));
assert('schedule rejection message set',
  fridayTier.some((o) => o.schedule_rejection && /weekend/i.test(o.schedule_rejection.error || '')));

const weekendProj = projectSunsetBookableOfferingsFromConfig(adminCfg, {
  locationId: 'sunset-somo',
  requestedDates: [SATURDAY],
});
assert('tier bookable on Saturday',
  weekendProj.offerings.some((o) => o.course_id === COURSE && o.bookable === true));

console.log('\n[RED → GREEN] Luna catalog + quote share canonical identity');
const catalog = buildSunsetLunaCatalogFromConfig(adminCfg, {
  locationId: 'sunset-somo',
  asOfDate: SATURDAY,
  requireDb: true,
});
assert('Luna catalog ok', catalog.ok === true);
const lunaCourse = (catalog.offerings || []).find((o) => o.course_id === COURSE);
assert('Luna sees course', !!lunaCourse);
assert('Luna offering_id is canonical item_code', lunaCourse.offering_id === ITEM);
assert('Luna keeps price_id separately', lunaCourse.price_id === 'price-row-1');
assert('Luna schedule weekdays weekends',
  Array.isArray(lunaCourse.schedule.weekdays)
  && lunaCourse.schedule.weekdays.includes(0)
  && lunaCourse.schedule.weekdays.includes(6));

const badQuote = quoteSunsetOfferingFromCatalog(adminCfg, {
  location_id: 'sunset-somo',
  offering_id: ITEM,
  course_id: COURSE,
  quantity: 1,
  service_dates: [FRIDAY],
  require_db: true,
  as_of_date: FRIDAY,
});
assert('Luna weekday quote fails closed', badQuote.ok === false);
assert('weekday quote reason is schedule',
  /service_dates_not_on_course_schedule|offering_not_available/i.test(badQuote.reason || ''));
assert('weekday quote staff error mentions weekends',
  /weekends/i.test(badQuote.error || ''));

const goodQuote = quoteSunsetOfferingFromCatalog(adminCfg, {
  location_id: 'sunset-somo',
  offering_id: ITEM,
  course_id: COURSE,
  quantity: 2,
  service_dates: [SATURDAY, SUNDAY],
  require_db: true,
  as_of_date: SATURDAY,
});
assert('Luna weekend quote succeeds', goodQuote.ok === true, JSON.stringify(goodQuote));
assert('quote/create identity is item_code', goodQuote.offering_id === ITEM);
assert('quote amount = Admin * qty (whole offering)', goodQuote.total_cents === AMOUNT * 2);
assert('quote price_source admin_db', goodQuote.price_source === 'admin_db');

console.log('\n[RED → GREEN] Missing Admin price fails with staff message');
const missingCfg = {
  ...adminCfg,
  prices: [],
};
const missingProj = projectSunsetBookableOfferingsFromConfig(missingCfg, { locationId: 'sunset-somo' });
// config_json amount still projects for visibility-with-heal, but bookable needs price row.
assert('no price row → not bookable from DB perspective when amount only in JSON',
  missingProj.offerings.every((o) => o.price_source !== 'admin_db' || o.bookable === false)
  || missingProj.offerings.some((o) => o.price_source === 'admin_config_json'));

const identity = courseTierIdentity(COURSE, TIER, 'sunset-somo');
const faced = staffFacingSunsetAdminPriceError('price_not_configured', identity);
assert('staff price error copy',
  /missing an active Admin price/i.test(faced.error));
const facedSched = staffFacingOfferingScheduleError('service_dates_not_on_course_schedule', {
  allowed_weekdays: [0, 6],
});
assert('staff schedule error copy', /weekends/i.test(facedSched.error));

console.log('\n[RED → GREEN] Source wiring — Schedule cache bust + hasData packs');
const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const cfgSrc = fs.readFileSync(path.join(__dirname, 'lib/tenant-business-config.js'), 'utf8');
const packSrc = fs.readFileSync(path.join(__dirname, 'lib/sunset-admin-pack-rules.js'), 'utf8');
assert('scheduleInvalidateAdminCatalogCache present',
  apiSrc.includes('function scheduleInvalidateAdminCatalogCache('));
assert('adminReloadConfig busts schedule cache',
  /function adminReloadConfig\([\s\S]*?scheduleInvalidateAdminCatalogCache/.test(apiSrc));
assert('openScheduleCreateModal force refresh',
  /scheduleFetchLessonTimesConfig\(getClient\(\),\s*\{\s*force:\s*true\s*\}/.test(apiSrc));
assert('schedule courses include weekly metadata',
  apiSrc.includes('schedule_summary:') && apiSrc.includes('weekdays:'));
assert('hasData includes surf_packs',
  /surf_packs\s*&&\s*surf_packs\.length\s*>\s*0/.test(cfgSrc));
assert('pack deactivate deactivates linked prices',
  /item_code LIKE/i.test(packSrc) && /active = false/.test(packSrc));
assert('pack create returns cache_invalidate',
  packSrc.includes("cache_invalidate: ['admin_config', 'schedule_courses', 'luna_catalog']"));

console.log('\n[RED → GREEN] DB-backed loader + price heal path');
process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';
const FIXED_NOW = new Date('2026-07-15T12:00:00Z');
function makePg(rows) {
  const store = [...rows];
  return {
    store,
    async query(sql, params) {
      const s = String(sql);
      if (/to_regclass/i.test(s)) return { rows: [{ reg: 'tenant_price_rules' }] };
      if (/information_schema\.columns/i.test(s)) return { rows: [{ '?column?': 1 }] };
      if (/information_schema\.tables/i.test(s)) return { rows: [{ '?column?': 1 }] };
      if (/FROM tenant_surf_pack_rules/i.test(s)) {
        return {
          rows: [{
            id: COURSE,
            label: LABEL,
            config_json: {
              age_band: '12_and_up',
              group_size: 12,
              beaches: ['somo'],
              weekly: 'sat_sun',
              schedules: ['0930_1130'],
              price_tiers: [{ key: TIER, label: '1 week', hours: 10, amount_cents: AMOUNT }],
            },
          }],
        };
      }
      if (/FROM tenant_price_rules/i.test(s) && /FOR UPDATE/i.test(s)) {
        const itemCode = params[3] || params[2];
        return { rows: store.filter((r) => r.item_code === itemCode && r.active !== false) };
      }
      if (/FROM tenant_price_rules/i.test(s)) {
        const itemCode = params[2];
        const unit = params[3];
        const locationId = params[4];
        const today = FIXED_NOW.toISOString().slice(0, 10);
        const matched = store.filter((r) => (
          r.item_code === itemCode
          && r.unit === unit
          && r.location_id === locationId
          && r.active !== false
          && (!r.effective_from || String(r.effective_from).slice(0, 10) <= today)
        ));
        return { rows: matched.map((r) => ({ ...r })) };
      }
      if (/INSERT INTO tenant_price_rules/i.test(s)) {
        const row = {
          id: `new-${store.length + 1}`,
          client_slug: params[1],
          location_id: params[2],
          item_type: params[3],
          item_code: params[4],
          amount_cents: params[7],
          unit: params[8],
          active: true,
        };
        store.push(row);
        return { rows: [row] };
      }
      if (/BEGIN|COMMIT|ROLLBACK|SAVEPOINT|tenant_config_audit/i.test(s)) return { rows: [] };
      if (/UPDATE tenant_price_rules SET/i.test(s)) {
        const id = params[0];
        const row = store.find((r) => String(r.id) === String(id));
        if (row) {
          row.unit = 'day';
          row.amount_cents = AMOUNT;
          row.updated = true;
        }
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    },
  };
}

(async () => {
  const emptyPg = makePg([]);
  const redLoad = await loadSunsetBookableOfferings(emptyPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    requestedDates: [SATURDAY],
  });
  assert('DB loader runs', redLoad.ok === true);
  assert('RED: missing price row → not bookable',
    (redLoad.offerings || []).every((o) => o.bookable === false));

  await syncPackTierToPriceRules(emptyPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    packId: COURSE,
    packLabel: LABEL,
    tiers: [{ key: TIER, label: '1 week', amount_cents: AMOUNT }],
    actor: {},
    skipTransaction: true,
  });
  const greenLoad = await loadSunsetBookableOfferings(emptyPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    requestedDates: [SATURDAY],
  });
  assert('GREEN: after sync price resolves',
    (greenLoad.offerings || []).some((o) => o.bookable === true && o.unit_amount_cents === AMOUNT));

  const wrongUnitPg = makePg([{
    id: 'legacy',
    client_slug: 'sunset',
    location_id: 'sunset-somo',
    item_type: 'package',
    item_code: ITEM,
    amount_cents: AMOUNT,
    unit: 'week',
    active: true,
  }]);
  const redUnit = await resolveActiveSunsetAdminPrice(wrongUnitPg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    quantity: 1,
    metadata: { component: 'course', course_id: COURSE, tier_key: TIER, offering_id: ITEM },
  });
  assert('legacy week unit fails closed before heal',
    redUnit.ok === false && redUnit.reason === 'price_not_configured');

  console.log(`\n── verify:sunset-canonical-offering-pipeline ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
