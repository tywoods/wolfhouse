'use strict';

/**
 * Slice 3 — course-card equipment money matrix (Group + Private).
 *
 * Commercial contract:
 *   During Course and All Day are independent total unit prices (not base + surcharge).
 *   Total = mode_price × quantity × UNIQUE course dates.
 *
 * Legacy JSON pair equipment_price_cents / all_day_surcharge_cents is read as those
 * independent totals (€5 / €10), never summed to €15.
 *
 * Example: 3 dates × qty 2 → During €30; All Day €60.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  validateEquipmentOptions,
  normalizeEquipmentOptions,
  resolveEquipmentOptionMoney,
} = require('./lib/sunset-course-equipment-options');
const {
  quoteCourseEquipment,
  invoiceLines,
} = require('./lib/sunset-course-equipment-pricing');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuoteSync,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');

const GROUP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP_TIER = '3_days';
const GROUP_TIER_1 = '1_day';
const GROUP_ITEM = packPriceItemCode(GROUP_ID, GROUP_TIER);
const GROUP_ITEM_1 = packPriceItemCode(GROUP_ID, GROUP_TIER_1);
const GROUP_UNIT = 4000;
const PRIVATE_UNIT = 6000;
const FIXED_NOW = new Date('2026-07-28T12:00:00Z');
const DATES_3 = ['2026-09-01', '2026-09-02', '2026-09-03'];
const DATES_1 = ['2026-09-01'];

const RENTALS = [
  { offering_key: 'softboard', label: 'Softboard', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'carbon_fins', label: 'Carbon Fins', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'stale_item', label: 'Stale', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'foreign_location', label: 'Foreign Loc', active: true, client_slug: 'sunset', location_id: 'sunset-sardinero' },
];

/** Active legacy JSON pair: independent €5 During / €10 All Day (NOT €15). */
const LEGACY_SOFTBOARD = {
  offering_key: 'softboard',
  equipment_price_cents: 500,
  all_day_surcharge_cents: 1000,
};
const CANONICAL_SOFTBOARD = {
  offering_key: 'softboard',
  during_course_price_cents: 500,
  all_day_price_cents: 1000,
};
const CANONICAL_FINS = {
  offering_key: 'carbon_fins',
  during_course_price_cents: 200,
  all_day_price_cents: 0,
};

function adminCfg(opts = {}) {
  const groupOptions = opts.groupOptions || [CANONICAL_SOFTBOARD, CANONICAL_FINS];
  const privateOptions = opts.privateOptions || [CANONICAL_SOFTBOARD, CANONICAL_FINS];
  return {
    ok: true,
    source: 'db',
    currency: 'EUR',
    rental_offerings: RENTALS,
    surf_packs: [{
      pack_id: GROUP_ID,
      label: 'Money Matrix Group',
      active: true,
      group_size: 8,
      weekly: 'daily',
      schedules: ['0930_1130'],
      equipment_options: groupOptions,
      price_tiers: [
        { key: GROUP_TIER, label: '3 days', hours: 6, amount_cents: GROUP_UNIT },
        { key: GROUP_TIER_1, label: '1 day', hours: 2, amount_cents: GROUP_UNIT },
      ],
    }],
    prices: [{
      id: 'price-group',
      category: 'package',
      offering_key: GROUP_ITEM,
      item_code: GROUP_ITEM,
      amount_cents: GROUP_UNIT,
      unit: 'day',
      active: true,
      currency: 'EUR',
    }, {
      id: 'price-group-1',
      category: 'package',
      offering_key: GROUP_ITEM_1,
      item_code: GROUP_ITEM_1,
      amount_cents: GROUP_UNIT,
      unit: 'day',
      active: true,
      currency: 'EUR',
    }],
    private_lesson: {
      id: 'private-money',
      enabled: true,
      label: 'Private Course',
      amount_cents: PRIVATE_UNIT,
      currency: 'EUR',
      price_basis: 'per_session',
      default_duration_minutes: 120,
      equipment_options: privateOptions,
    },
  };
}

function quote(body, cfg) {
  const built = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.MANUAL_STAFF,
    transportBody: body,
    trustedLocationId: 'sunset-somo',
    now: FIXED_NOW,
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  return executeSunsetQuoteSync(built.command, { adminCfg: cfg || adminCfg() });
}

function groupBody(equipment, quantity, dates) {
  const tier = dates.length === 1 ? GROUP_TIER_1 : GROUP_TIER;
  return {
    guest_name: 'Money Guest',
    date_from: dates[0],
    date_to: dates[dates.length - 1],
    service_dates: dates,
    payment_status: 'unpaid',
    components: { course: { course_id: GROUP_ID, tier_key: tier, quantity } },
    course_equipment: equipment,
  };
}

function privateBody(equipment, surfers, dates) {
  return {
    guest_name: 'Private Money Guest',
    date_from: dates[0],
    date_to: dates[dates.length - 1],
    service_dates: dates,
    payment_status: 'unpaid',
    components: {
      private_lesson: {
        enabled: true,
        surfer_count: surfers,
        quantity: dates.length,
        sessions: dates.map((date) => ({ date, start: '10:00', end: '12:00' })),
      },
    },
    course_equipment: equipment,
  };
}

function gearLines(body) {
  return (body.line_items || []).filter((l) => l.course_equipment === true);
}

function gearTotal(body) {
  return gearLines(body).reduce((s, l) => s + Number(l.total_cents || 0), 0);
}

// ── Schema: legacy → independent totals; canonical writes; reject mixed ──
{
  const canonicalSoftboardWithPolicy = { ...CANONICAL_SOFTBOARD, during_course_policy: 'optional' };
  assert.deepStrictEqual(resolveEquipmentOptionMoney(LEGACY_SOFTBOARD), canonicalSoftboardWithPolicy);
  assert.deepStrictEqual(resolveEquipmentOptionMoney(CANONICAL_SOFTBOARD), canonicalSoftboardWithPolicy);
  assert.deepStrictEqual(normalizeEquipmentOptions([LEGACY_SOFTBOARD]), [canonicalSoftboardWithPolicy]);
  assert.deepStrictEqual(
    validateEquipmentOptions([{
      ...CANONICAL_SOFTBOARD,
      during_course_policy: 'optional',
    }]),
    [{ ...CANONICAL_SOFTBOARD, during_course_policy: 'optional' }],
  );
  assert.strictEqual(
    normalizeEquipmentOptions([CANONICAL_SOFTBOARD])[0].during_course_policy,
    'optional',
    'legacy canonical rows infer optional from a positive during-course price',
  );
  assert.strictEqual(
    normalizeEquipmentOptions([{
      offering_key: 'included_board',
      during_course_price_cents: 0,
      all_day_price_cents: 1000,
    }])[0].during_course_policy,
    'included',
    'legacy canonical €0 rows infer included',
  );
  assert.throws(() => validateEquipmentOptions([{
    ...CANONICAL_SOFTBOARD,
    during_course_policy: 'bogus',
  }]));
  assert.throws(() => validateEquipmentOptions([{
    ...CANONICAL_SOFTBOARD,
    during_course_policy: 'included',
  }]), /included.*zero|included.*0/i);
  const unavailableCourse = {
    course_id: GROUP_ID,
    equipment_options: [{
      offering_key: 'softboard',
      during_course_policy: 'unavailable',
      during_course_price_cents: 0,
      all_day_price_cents: 1000,
    }],
  };
  assert.throws(() => quoteCourseEquipment({
    course: unavailableCourse,
    selection: [{ offering_key: 'softboard', mode: 'during_course', quantity: 1 }],
    surfers: 1,
    offerings: RENTALS,
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDates: DATES_3,
  }), /during.course.*unavailable/i);
  assert.strictEqual(quoteCourseEquipment({
    course: unavailableCourse,
    selection: [{ offering_key: 'softboard', mode: 'all_day', quantity: 1 }],
    surfers: 1,
    offerings: RENTALS,
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    serviceDates: DATES_3,
  }).total_cents, 3000);
  // Admin/API writes reject legacy field names.
  assert.throws(() => validateEquipmentOptions([LEGACY_SOFTBOARD]));
  // Competing / mixed schema rejected.
  assert.throws(() => resolveEquipmentOptionMoney({
    offering_key: 'softboard',
    equipment_price_cents: 500,
    all_day_surcharge_cents: 1000,
    during_course_price_cents: 500,
    all_day_price_cents: 1000,
  }));
  assert.throws(() => validateEquipmentOptions([{
    offering_key: 'softboard',
    during_course_price_cents: 500,
    all_day_price_cents: 1000,
    equipment_price_cents: 1,
  }]));
  assert.deepStrictEqual(normalizeEquipmentOptions([{
    offering_key: 'softboard',
    equipment_price_cents: 500,
    all_day_surcharge_cents: 1000,
    during_course_price_cents: 500,
  }]), []);
}

// ── Pure pricing matrix: never surcharge-sum, always × unique dates ──
{
  const course = { course_id: GROUP_ID, equipment_options: [CANONICAL_SOFTBOARD, CANONICAL_FINS] };
  const offerings = RENTALS;
  const base = {
    course, offerings, clientSlug: 'sunset', locationId: 'sunset-somo', surfers: 4,
  };

  // 3 dates × qty 2: During €30; All Day €60 (NOT €90, NOT once-per-course €10/€20)
  const during3 = quoteCourseEquipment({
    ...base,
    selection: [{ offering_key: 'softboard', mode: 'during_course', quantity: 2 }],
    serviceDates: DATES_3,
  });
  assert.strictEqual(during3.total_cents, 3000, '3×2×€5 During');
  assert.strictEqual(during3.lines[0].unit_amount_cents, 500);
  assert.strictEqual(during3.lines[0].date_count, 3);
  assert.strictEqual(during3.lines[0].total_cents, 3000);

  const allDay3 = quoteCourseEquipment({
    ...base,
    selection: [{ offering_key: 'softboard', mode: 'all_day', quantity: 2 }],
    serviceDates: DATES_3,
  });
  assert.strictEqual(allDay3.total_cents, 6000, '3×2×€10 All Day independent total');
  assert.notEqual(allDay3.total_cents, 9000, 'must NOT be base+surcharge × dates');
  assert.notEqual(allDay3.total_cents, 3000, 'must NOT be once-per-course only');

  // Legacy pair prices identically (independent totals, not sum)
  const legacyCourse = { course_id: GROUP_ID, equipment_options: [LEGACY_SOFTBOARD] };
  const legacyAllDay = quoteCourseEquipment({
    course: legacyCourse,
    selection: [{ offering_key: 'softboard', mode: 'all_day', quantity: 2 }],
    serviceDates: DATES_3,
    surfers: 4,
  });
  assert.strictEqual(legacyAllDay.total_cents, 6000, 'legacy all_day_surcharge_cents is independent All Day total');

  // 1 date × qty 1
  const one = quoteCourseEquipment({
    ...base,
    selection: [{ offering_key: 'softboard', mode: 'during_course', quantity: 1 }],
    serviceDates: DATES_1,
  });
  assert.strictEqual(one.total_cents, 500);

  // qty 4 × 3 dates During
  const qty4 = quoteCourseEquipment({
    ...base,
    selection: [{ offering_key: 'softboard', mode: 'during_course', quantity: 4 }],
    serviceDates: DATES_3,
  });
  assert.strictEqual(qty4.total_cents, 6000);

  // Unique dates: duplicates collapse
  const dupDates = quoteCourseEquipment({
    ...base,
    selection: [{ offering_key: 'softboard', mode: 'during_course', quantity: 2 }],
    serviceDates: ['2026-09-01', '2026-09-01', '2026-09-02', '2026-09-02', '2026-09-03'],
  });
  assert.strictEqual(dupDates.total_cents, 3000);
  assert.strictEqual(dupDates.lines[0].date_count, 3);

  // All Day price 0 remains valid
  const freeAllDay = quoteCourseEquipment({
    ...base,
    selection: [{ offering_key: 'carbon_fins', mode: 'all_day', quantity: 2 }],
    serviceDates: DATES_3,
  });
  assert.strictEqual(freeAllDay.total_cents, 0);

  // Invoice aggregate without double-count
  const inv = invoiceLines(allDay3);
  assert.strictEqual(inv.reduce((s, r) => s + r.total_cents, 0), 6000);

  // Fail closed: missing dates / unconfigured / cross-scope
  assert.throws(() => quoteCourseEquipment({
    ...base,
    selection: [{ offering_key: 'softboard', mode: 'during_course', quantity: 1 }],
    serviceDates: [],
  }));
  assert.throws(() => quoteCourseEquipment({
    ...base,
    selection: [{ offering_key: 'missing', mode: 'during_course', quantity: 1 }],
    serviceDates: DATES_1,
  }));
  assert.throws(() => quoteCourseEquipment({
    ...base,
    selection: [{ offering_key: 'foreign_location', mode: 'during_course', quantity: 1 }],
    serviceDates: DATES_1,
  }));
  assert.throws(() => quoteCourseEquipment({
    course: { equipment_options: [{ offering_key: 'softboard' }] },
    selection: [{ offering_key: 'softboard', mode: 'during_course', quantity: 1 }],
    serviceDates: DATES_1,
    surfers: 1,
  }), /price|money|invalid/i);

  // Client money fields rejected at selection boundary
  assert.throws(() => quoteCourseEquipment({
    ...base,
    selection: [{
      offering_key: 'softboard',
      mode: 'during_course',
      quantity: 1,
      during_course_price_cents: 1,
    }],
    serviceDates: DATES_1,
  }));
}

// ── Group quote path (components) ──
{
  const sel = [{ offering_key: 'softboard', mode: 'during_course', quantity: 2 }];
  const result = quote(groupBody(sel, 4, DATES_3));
  assert.equal(result.ok, true, JSON.stringify(result.body));
  assert.strictEqual(gearTotal(result.body), 3000, 'group 3 dates × qty2 During');
  assert.strictEqual(result.body.total_cents, GROUP_UNIT * 4 + 3000);
  assert.deepStrictEqual(result.body.course_equipment, sel);
  const line = gearLines(result.body)[0];
  assert.strictEqual(line.unit_amount_cents, 500);
  assert.strictEqual(line.total_cents, 3000);
  assert.ok(!('equipment_price_cents' in line));
  assert.ok(!('all_day_surcharge_unit_cents' in line) || line.all_day_surcharge_unit_cents == null);

  const allDay = quote(groupBody(
    [{ offering_key: 'softboard', mode: 'all_day', quantity: 2 }],
    4,
    DATES_3,
  ));
  assert.equal(allDay.ok, true, JSON.stringify(allDay.body));
  assert.strictEqual(gearTotal(allDay.body), 6000, 'group All Day independent');
  assert.notEqual(gearTotal(allDay.body), 9000);

  // 1 date
  const oneDay = quote(groupBody(sel, 2, DATES_1));
  assert.equal(oneDay.ok, true);
  assert.strictEqual(gearTotal(oneDay.body), 1000);

  // Legacy config still quotes via historical normalizer
  const legacyCfg = adminCfg({ groupOptions: [LEGACY_SOFTBOARD] });
  const legacyQ = quote(
    groupBody([{ offering_key: 'softboard', mode: 'all_day', quantity: 2 }], 2, DATES_3),
    legacyCfg,
  );
  assert.equal(legacyQ.ok, true, JSON.stringify(legacyQ.body));
  assert.strictEqual(gearTotal(legacyQ.body), 6000);

  // Stale / not on course fails closed
  const staleCfg = adminCfg({
    groupOptions: [CANONICAL_SOFTBOARD], // carbon_fins removed
  });
  const stale = quote(
    groupBody([{ offering_key: 'carbon_fins', mode: 'during_course', quantity: 1 }], 1, DATES_1),
    staleCfg,
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.body.reason, 'invalid_course_equipment');

  // Cross-location
  const cross = quote(groupBody(
    [{ offering_key: 'foreign_location', mode: 'during_course', quantity: 1 }],
    1,
    DATES_1,
  ));
  assert.equal(cross.ok, false);
  assert.equal(cross.body.reason, 'invalid_course_equipment');
}

// ── Private quote path (unique session dates) ──
{
  const sel = [{ offering_key: 'softboard', mode: 'during_course', quantity: 2 }];
  const result = quote(privateBody(sel, 3, DATES_3));
  assert.equal(result.ok, true, JSON.stringify(result.body));
  assert.strictEqual(gearTotal(result.body), 3000, 'private 3 session dates × qty2');
  // private unit × 3 surfers × 3 sessions? Private is per_session × surfers × session dates
  // Equipment is independent: mode × qty × unique session dates only
  assert.strictEqual(gearTotal(result.body), 3000);
  assert.ok(result.body.total_cents >= 3000 + PRIVATE_UNIT * 3);

  const allDay = quote(privateBody(
    [{ offering_key: 'softboard', mode: 'all_day', quantity: 2 }],
    3,
    DATES_3,
  ));
  assert.equal(allDay.ok, true, JSON.stringify(allDay.body));
  assert.strictEqual(gearTotal(allDay.body), 6000);

  // Private 1 session
  const one = quote(privateBody(sel, 2, DATES_1));
  assert.equal(one.ok, true);
  assert.strictEqual(gearTotal(one.body), 1000);
}

// ── Luna offering_id path ──
{
  const sel = [{ offering_key: 'softboard', mode: 'all_day', quantity: 2 }];
  const built = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.LUNA_WHATSAPP,
    transportBody: {
      offering_id: GROUP_ITEM,
      course_id: GROUP_ID,
      quantity: 2,
      service_dates: DATES_3,
      course_equipment: sel,
    },
    trustedLocationId: 'sunset-somo',
    now: FIXED_NOW,
  });
  assert.equal(built.ok, true);
  const result = executeSunsetQuoteSync(built.command, { adminCfg: adminCfg() });
  assert.equal(result.ok, true, JSON.stringify(result.body));
  assert.strictEqual(gearTotal(result.body), 6000, 'Luna quote All Day 3×2×€10');
  assert.strictEqual(result.body.total_cents, GROUP_UNIT * 2 + 6000);
}

// ── Create/Edit persistence parity (insertCourseEquipmentRows) ──
{
  // Load writes module insert helper via real quote authority shape.
  // We only assert pure quote→row expansion contract here (no DB mutation).
  const q = quoteCourseEquipment({
    course: { course_id: GROUP_ID, equipment_options: [CANONICAL_SOFTBOARD] },
    selection: [{ offering_key: 'softboard', mode: 'all_day', quantity: 2 }],
    serviceDates: DATES_3,
    surfers: 4,
    offerings: RENTALS,
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
  });
  assert.strictEqual(q.total_cents, 6000);
  assert.strictEqual(q.lines[0].date_count, 3);
  assert.deepStrictEqual(q.lines[0].service_dates, DATES_3);
  // Per-date row amount = unit × qty (not re-multiplied by dates)
  const perDate = q.lines[0].unit_amount_cents * q.lines[0].quantity;
  assert.strictEqual(perDate, 2000);
  assert.strictEqual(perDate * 3, q.total_cents);

  // create/edit share the same quoteCourseEquipment authority
  const writesSrc = fs.readFileSync(
    path.join(__dirname, 'lib/sunset-schedule-booking-writes.js'),
    'utf8',
  );
  const drawerSrc = fs.readFileSync(
    path.join(__dirname, 'lib/sunset-schedule-booking-drawer.js'),
    'utf8',
  );
  assert.ok(writesSrc.includes('insertCourseEquipmentRows'));
  assert.ok(drawerSrc.includes('insertCourseEquipmentRows'));
  assert.ok(writesSrc.includes('quoteCourseEquipment'));
  // Must expand per unique course date (not once-per-course only).
  assert.ok(
    /for\s*\(.*serviceDate|service_dates|bookingDates/.test(
      writesSrc.slice(writesSrc.indexOf('async function insertCourseEquipmentRows')),
    ),
  );
}

// ── Admin UI labels never say surcharge/addition ──
{
  const ui = fs.readFileSync(path.join(__dirname, 'browser/sunset-admin-ui.js'), 'utf8');
  const en = fs.readFileSync(path.join(__dirname, 'lib/staff-portal-i18n.js'), 'utf8');
  assert.ok(ui.includes('during_course_price_cents'));
  assert.ok(ui.includes('all_day_price_cents'));
  assert.ok(!ui.includes("all_day_surcharge_cents:s.value") && !ui.includes('all_day_surcharge_cents: s.value'));
  assert.ok(en.includes('During Course price') || en.includes('During Course Price'));
  assert.ok(en.includes('All Day price') || en.includes('All Day Price'));
  assert.ok(!/All Day Price Surcharge/i.test(en));
}

console.log('verify:sunset-course-equipment-money-matrix — ALL CHECKS PASSED');
