'use strict';

/**
 * Booking composition + quote/create transport contract.
 *
 * Root-cause gates:
 *  1) Browser quote must forward course_equipment identity (mode/qty/offering_key).
 *  2) Absent course equipment (undefined/null/[]) must not block rental-only bookings.
 *  3) Non-empty course equipment still requires Group/Private course.
 *  4) Admin-owned unequal fixtures prove €35+€5=€40 and €35+€10=€45; prices editable.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuoteSync,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');
const { validateScheduleBookingBody } = require('./lib/sunset-schedule-booking-writes');
const { isPresentCourseEquipmentSelection } = require('./lib/sunset-course-equipment-options');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');

const ROOT = path.join(__dirname, '..');
const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
const GROUP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GROUP_TIER = '1_day';
const GROUP_ITEM = packPriceItemCode(GROUP_ID, GROUP_TIER);
const COURSE_UNIT = 3500; // €35
const DURING_UNIT = 500; // €5
const ALL_DAY_UNIT = 1000; // €10
const REF = new Date('2026-08-20T12:00:00Z');
const DATE = '2026-08-20';

let pass = 0;
function ok(name, cond, detail) {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    process.exit(1);
  }
  console.log(`PASS ${name}`);
  pass += 1;
}

function extractFn(src, name) {
  const n = `function ${name}(`;
  const s = src.indexOf(n);
  if (s < 0) return '';
  const b = src.indexOf('{', s);
  let d = 0;
  for (let i = b; i < src.length; i += 1) {
    if (src[i] === '{') d += 1;
    else if (src[i] === '}') {
      d -= 1;
      if (!d) return src.slice(s, i + 1);
    }
  }
  return '';
}

function adminCfg(opts = {}) {
  const during = opts.during != null ? opts.during : DURING_UNIT;
  const allDay = opts.allDay != null ? opts.allDay : ALL_DAY_UNIT;
  const courseUnit = opts.courseUnit != null ? opts.courseUnit : COURSE_UNIT;
  return {
    ok: true,
    source: 'db',
    currency: 'EUR',
    rental_offerings: [
      {
        offering_key: 'softboard',
        label: 'Softboard',
        active: true,
        client_slug: 'sunset',
        location_id: 'sunset-somo',
      },
      {
        offering_key: 'board_rental',
        label: 'Board rental',
        active: true,
        client_slug: 'sunset',
        location_id: 'sunset-somo',
      },
      {
        offering_key: 'foreign_loc',
        label: 'Foreign',
        active: true,
        client_slug: 'sunset',
        location_id: 'sunset-sardinero',
      },
    ],
    surf_packs: [{
      pack_id: GROUP_ID,
      label: 'Curso Medio Dia',
      active: true,
      group_size: 8,
      weekly: 'daily',
      schedules: ['0930_1130'],
      equipment_options: [{
        offering_key: 'softboard',
        during_course_price_cents: during,
        all_day_price_cents: allDay,
      }],
      price_tiers: [{ key: GROUP_TIER, label: '1 day', hours: 2, amount_cents: courseUnit }],
    }],
    prices: [
      {
        id: 'price-group',
        category: 'package',
        offering_key: GROUP_ITEM,
        item_code: GROUP_ITEM,
        amount_cents: courseUnit,
        unit: 'day',
        active: true,
        currency: 'EUR',
        location_id: 'sunset-somo',
      },
      {
        id: 'price-board',
        category: 'rental',
        offering_key: 'board_rental__1_day',
        item_code: 'board_rental__1_day',
        amount_cents: 1500,
        unit: 'day',
        active: true,
        currency: 'EUR',
        location_id: 'sunset-somo',
      },
    ],
    private_lesson: {
      enabled: true,
      label: 'Private Course',
      amount_cents: 6000,
      currency: 'EUR',
      price_basis: 'per_session',
      default_duration_minutes: 120,
      equipment_options: [{
        offering_key: 'softboard',
        during_course_price_cents: during,
        all_day_price_cents: allDay,
      }],
    },
  };
}

function quote(body, cfg) {
  const built = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.MANUAL_STAFF,
    transportBody: body,
    trustedLocationId: 'sunset-somo',
    now: REF,
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  return executeSunsetQuoteSync(built.command, { adminCfg: cfg || adminCfg() });
}

function classBody(equipment, quantity = 1) {
  return {
    guest_name: 'Compose Guest',
    guest_phone: '+34600111222',
    date_from: DATE,
    date_to: DATE,
    service_dates: [DATE],
    payment_status: 'unpaid',
    components: {
      course: { course_id: GROUP_ID, tier_key: GROUP_TIER, quantity },
    },
    ...(equipment === undefined ? {} : { course_equipment: equipment }),
  };
}

function rentalBody(equipment) {
  return {
    guest_name: 'Rental Only',
    guest_phone: '+34600111222',
    date_from: DATE,
    date_to: DATE,
    service_dates: [DATE],
    payment_status: 'unpaid',
    surfer_count: 1,
    components: { surfboard: { quantity: 1 } },
    rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
    ...(equipment === undefined ? {} : { course_equipment: equipment }),
  };
}

function validate(body) {
  return validateScheduleBookingBody(body, {
    refDate: REF,
    requireGuestPhone: true,
  });
}

async function runBrowserGates() {
  const fetchFn = extractFn(portalSrc, 'schedulePortalFetchQuote');
  ok(
    'schedulePortalFetchQuote forwards course_equipment',
    /course_equipment:\s*Array\.isArray\(createPayload\.course_equipment\)/.test(fetchFn)
      || /course_equipment:\s*createPayload\.course_equipment/.test(fetchFn)
      || /body\.course_equipment\s*=/.test(fetchFn),
    'course_equipment missing from quote body builder',
  );
  ok(
    'quote intent key includes course_equipment',
    /course_equipment/.test(extractFn(portalSrc, 'schedulePortalQuotePricingIntentKey')),
  );
  ok(
    'create intent key includes course_equipment',
    /course_equipment/.test(extractFn(portalSrc, 'schedulePortalCreateIntentKey')),
  );

  const log = [];
  const ctx = {
    console,
    JSON,
    Object,
    Array,
    Number,
    String,
    Math,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
    getClient: () => 'sunset',
    getSunsetLocation: () => 'sunset-somo',
    sunsetLocationQuerySuffix: () => '&location_id=sunset-somo',
    scheduleEnumerateDates: (a, b) => [String(a).slice(0, 10), String(b).slice(0, 10)],
    el: () => null,
    fetch(url, req) {
      const entry = { url: String(url), body: null };
      try { if (req && req.body) entry.body = JSON.parse(req.body); } catch (_e) { /* */ }
      log.push(entry);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          success: true,
          total_cents: 4000,
          quote_provenance: { source: 't', quote_fingerprint: 'fp1' },
        }),
      });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(portalSrc, ctx);

  const base = {
    guest_name: 'Ada',
    guest_phone: '+34600',
    date_from: DATE,
    date_to: DATE,
    payment_status: 'unpaid',
    components: {
      course: {
        course_id: GROUP_ID,
        course_label: 'Curso Medio Dia',
        tier_key: GROUP_TIER,
        quantity: 1,
      },
    },
    rentals: [],
    surfer_count: 1,
    course_equipment: [{
      offering_key: 'softboard',
      mode: 'during_course',
      quantity: 1,
    }],
  };

  const duringKey = ctx.schedulePortalQuotePricingIntentKey(base);
  const allDayKey = ctx.schedulePortalQuotePricingIntentKey({
    ...base,
    course_equipment: [{ offering_key: 'softboard', mode: 'all_day', quantity: 1 }],
  });
  const emptyKey = ctx.schedulePortalQuotePricingIntentKey({
    ...base,
    course_equipment: [],
  });
  const omitKey = ctx.schedulePortalQuotePricingIntentKey({
    ...base,
    course_equipment: undefined,
  });
  ok('intent changes during→all_day', duringKey !== allDayKey);
  ok('intent empty [] equals omit', emptyKey === omitKey);
  ok('intent equipment vs none differs', duringKey !== emptyKey);

  const createDuring = ctx.schedulePortalCreateIntentKey(base);
  const createAllDay = ctx.schedulePortalCreateIntentKey({
    ...base,
    course_equipment: [{ offering_key: 'softboard', mode: 'all_day', quantity: 1 }],
  });
  ok('create idempotency intent changes with equipment mode', createDuring !== createAllDay);

  ctx.schedulePortalQuoteGen = 1;
  const res = await ctx.schedulePortalFetchQuote(base, { applyState: false, gen: 1 });
  ok('runtime quote ok', res && res.ok === true, JSON.stringify(res));
  const q = log.find((e) => String(e.url).includes('/bookings/quote'));
  ok('runtime quote captured', !!q && !!q.body);
  ok(
    'runtime quote body has course_equipment identity only',
    Array.isArray(q.body.course_equipment)
      && q.body.course_equipment.length === 1
      && q.body.course_equipment[0].offering_key === 'softboard'
      && q.body.course_equipment[0].mode === 'during_course'
      && q.body.course_equipment[0].quantity === 1
      && !Object.prototype.hasOwnProperty.call(q.body.course_equipment[0], 'total_cents')
      && !Object.prototype.hasOwnProperty.call(q.body.course_equipment[0], 'label')
      && !Object.prototype.hasOwnProperty.call(q.body.course_equipment[0], 'during_course_price_cents'),
    JSON.stringify(q.body.course_equipment),
  );
  ok(
    'runtime quote body has no client money fields',
    !('total_cents' in (q.body.components && q.body.components.course || {}))
      && !JSON.stringify(q.body.course_equipment || []).includes('amount_cents'),
  );
}

function runServerGates() {
  ok('absent: undefined', isPresentCourseEquipmentSelection(undefined) === false);
  ok('absent: null', isPresentCourseEquipmentSelection(null) === false);
  ok('absent: []', isPresentCourseEquipmentSelection([]) === false);
  ok('present: non-empty', isPresentCourseEquipmentSelection([{ offering_key: 'x' }]) === true);
  ok('present: non-array object', isPresentCourseEquipmentSelection({ offering_key: 'x' }) === true);

  for (const [label, equipment] of [
    ['omit', undefined],
    ['null', null],
    ['[]', []],
  ]) {
    const body = rentalBody(equipment);
    if (equipment === undefined) delete body.course_equipment;
    if (equipment === null) body.course_equipment = null;
    const v = validate(body);
    ok(`rental-only validate ${label}`, v.ok === true, v.error || JSON.stringify(v));
    ok(
      `rental-only validate ${label} course_equipment null`,
      v.value.course_equipment == null,
      JSON.stringify(v.value.course_equipment),
    );
  }

  {
    const v = validate(rentalBody([
      { offering_key: 'softboard', mode: 'during_course', quantity: 1 },
    ]));
    ok('rental-only non-empty CE rejected', v.ok === false, JSON.stringify(v));
    ok(
      'rental-only error names course requirement',
      /course_equipment requires a group or private course/i.test(String(v.error || '')),
      String(v.error),
    );
  }

  {
    const v = validate(classBody([]));
    ok('class-only empty CE validate', v.ok === true, v.error);
    const q = quote(classBody([]));
    ok('class-only empty CE quote', q.ok === true, JSON.stringify(q.body));
    ok('class-only total is course only', q.body.total_cents === COURSE_UNIT, String(q.body.total_cents));
  }

  {
    const v = validate({
      guest_name: 'Empty',
      guest_phone: '+34600111222',
      date_from: DATE,
      date_to: DATE,
      service_dates: [DATE],
      payment_status: 'unpaid',
      components: {},
      rentals: [],
      course_equipment: [],
    });
    ok('empty booking rejected', v.ok === false, JSON.stringify(v));
  }

  {
    const during = quote(classBody([
      { offering_key: 'softboard', mode: 'during_course', quantity: 1 },
    ]));
    ok('during quote ok', during.ok === true, JSON.stringify(during.body));
    ok(
      '€35+€5=€40 during total',
      during.body.total_cents === COURSE_UNIT + DURING_UNIT,
      String(during.body.total_cents),
    );
    ok(
      'during provenance includes equipment',
      Array.isArray(during.body.course_equipment)
        && during.body.course_equipment[0].mode === 'during_course'
        && during.body.quote_provenance
        && Array.isArray(during.body.quote_provenance.course_equipment),
      JSON.stringify(during.body.course_equipment),
    );

    const allDay = quote(classBody([
      { offering_key: 'softboard', mode: 'all_day', quantity: 1 },
    ]));
    ok('all_day quote ok', allDay.ok === true, JSON.stringify(allDay.body));
    ok(
      '€35+€10=€45 all_day total',
      allDay.body.total_cents === COURSE_UNIT + ALL_DAY_UNIT,
      String(allDay.body.total_cents),
    );
    ok(
      'mode change changes provenance fingerprint',
      during.body.quote_provenance.quote_fingerprint
        !== allDay.body.quote_provenance.quote_fingerprint,
      `${during.body.quote_provenance.quote_fingerprint} vs ${allDay.body.quote_provenance.quote_fingerprint}`,
    );
  }

  {
    const cfg = adminCfg({ during: 700, allDay: 1300 });
    const during = quote(classBody([
      { offering_key: 'softboard', mode: 'during_course', quantity: 1 },
    ]), cfg);
    const allDay = quote(classBody([
      { offering_key: 'softboard', mode: 'all_day', quantity: 1 },
    ]), cfg);
    ok(
      'editable during €35+€7=€42',
      during.ok && during.body.total_cents === 3500 + 700,
      String(during.body && during.body.total_cents),
    );
    ok(
      'editable all_day €35+€13=€48',
      allDay.ok && allDay.body.total_cents === 3500 + 1300,
      String(allDay.body && allDay.body.total_cents),
    );
  }

  {
    const body = {
      ...classBody([{ offering_key: 'softboard', mode: 'during_course', quantity: 1 }]),
      surfer_count: 1,
      // Canonical rentals[] is the rental authority; legacy surfboard is optional mirror.
      components: {
        course: { course_id: GROUP_ID, tier_key: GROUP_TIER, quantity: 1 },
      },
      rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }],
    };
    const v = validate(body);
    ok('mixed validate ok', v.ok === true, v.error);
    ok(
      'mixed keeps course_equipment',
      Array.isArray(v.value.course_equipment) && v.value.course_equipment.length === 1,
    );
    const q = quote(body);
    ok('mixed quote ok', q.ok === true, JSON.stringify(q.body));
    ok(
      'mixed total course+equip+rental',
      q.body.total_cents === COURSE_UNIT + DURING_UNIT + 1500,
      String(q.body.total_cents),
    );
  }

  {
    const q = quote(rentalBody([]));
    const failedOnCe = q.body && (
      q.body.reason === 'course_equipment requires a group or private course'
      || q.body.error === 'course_equipment requires a group or private course'
      || q.body.reason === 'invalid_course_equipment'
    );
    ok(
      'rental-only quote with [] does not fail CE gate',
      q.ok === true || !failedOnCe,
      JSON.stringify(q.body || q),
    );
    if (q.ok) {
      ok(
        'rental-only quote total uses rental only',
        q.body.total_cents === 1500,
        String(q.body.total_cents),
      );
      ok(
        'rental-only quote CE echo absent',
        q.body.course_equipment == null
          || (Array.isArray(q.body.course_equipment) && q.body.course_equipment.length === 0),
      );
    }
  }

  {
    const q = quote(classBody([
      { offering_key: 'foreign_loc', mode: 'during_course', quantity: 1 },
    ]));
    ok('foreign location equipment rejected', q.ok === false);
    ok(
      'foreign location reason',
      q.body.reason === 'invalid_course_equipment',
      JSON.stringify(q.body),
    );
  }

  {
    const q = quote(classBody([{
      offering_key: 'softboard',
      mode: 'during_course',
      quantity: 1,
      total_cents: 1,
      label: 'Client Lie',
    }]));
    ok('client money on CE rejected', q.ok === false);
  }
}

(async function main() {
  console.log('\nverify:sunset-booking-composition-contract\n');
  await runBrowserGates();
  runServerGates();
  console.log(`\nverify:sunset-booking-composition-contract — ALL CHECKS PASSED (pass=${pass})\n`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
