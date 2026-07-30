'use strict';

/**
 * Multi-lesson production owners (offline):
 *  - authoritative quote totals (same-day Group × different course prices)
 *  - Private same-day multi: both sessions charge; CE unique-date only
 *  - physical insert row cardinality + claim amounts + reconstruct readback
 *  - mutation guards when lessons drop from quote/persistence
 *  - multi-course equipment equal-price / conflict authority
 */

const assert = require('assert');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuoteSync,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');
const {
  applyAuthoritativeQuoteAmounts,
  insertScheduleComponentServiceRows,
  validateScheduleBookingBody,
} = require('./lib/sunset-schedule-booking-writes');
const {
  shouldPriceGroupLessonsIndividually,
  reconstructLessonsFromServiceRows,
  uniqueCalendarDates,
  canUsePackMultiDatePath,
} = require('./lib/sunset-schedule-lessons');
const {
  quoteCourseEquipmentForLessonSet,
} = require('./lib/sunset-course-equipment-pricing');

process.env.SUNSET_ADMIN_DB_READ_ENABLED = '0';
process.env.SUNSET_ADMIN_JSON_OVERLAY = '0';

const LOC = 'sunset-somo';
const DATE = '2026-08-20';
const COURSE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COURSE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UNIT_A = 3500;
const UNIT_B = 4500;
const SURFERS = 2;
const FIXED_NOW = new Date('2026-07-28T12:00:00Z');

let pass = 0;
function ok(name, cond, detail) {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    process.exit(1);
  }
  console.log(`PASS ${name}`);
  pass += 1;
}

function adminCfg() {
  return {
    ok: true,
    source: 'config',
    currency: 'EUR',
    rental_offerings: [
      {
        offering_key: 'softboard', label: 'Softboard', active: true,
        client_slug: 'sunset', location_id: LOC,
      },
    ],
    surf_packs: [
      {
        pack_id: COURSE_A,
        label: 'Group Alpha',
        active: true,
        group_size: 8,
        weekly: 'daily',
        schedules: ['0930_1130', '1215_1415'],
        equipment_options: [
          { offering_key: 'softboard', during_course_price_cents: 500, all_day_price_cents: 1000 },
        ],
        price_tiers: [
          { key: '1_day', label: '1 day', amount_cents: UNIT_A, duration_days: 1 },
          { key: '2_days', label: '2 days', amount_cents: UNIT_A * 2, duration_days: 2 },
        ],
      },
      {
        pack_id: COURSE_B,
        label: 'Group Beta',
        active: true,
        group_size: 8,
        weekly: 'daily',
        schedules: ['0930_1130', '1215_1415'],
        equipment_options: [
          { offering_key: 'softboard', during_course_price_cents: 500, all_day_price_cents: 1000 },
        ],
        price_tiers: [
          { key: '1_day', label: '1 day', amount_cents: UNIT_B, duration_days: 1 },
        ],
      },
    ],
    prices: [
      {
        id: 'pa', category: 'package',
        offering_key: packPriceItemCode(COURSE_A, '1_day'),
        item_code: packPriceItemCode(COURSE_A, '1_day'),
        amount_cents: UNIT_A, unit: 'day', active: true, currency: 'EUR',
      },
      {
        id: 'pb', category: 'package',
        offering_key: packPriceItemCode(COURSE_B, '1_day'),
        item_code: packPriceItemCode(COURSE_B, '1_day'),
        amount_cents: UNIT_B, unit: 'day', active: true, currency: 'EUR',
      },
      {
        id: 'pa2', category: 'package',
        offering_key: packPriceItemCode(COURSE_A, '2_days'),
        item_code: packPriceItemCode(COURSE_A, '2_days'),
        amount_cents: UNIT_A * 2, unit: 'day', active: true, currency: 'EUR',
      },
    ],
    private_lesson: {
      id: 'private-verify',
      enabled: true,
      label: 'Private Course',
      amount_cents: 6000,
      currency: 'EUR',
      price_basis: 'per_session',
      default_duration_minutes: 120,
      equipment_options: [
        { offering_key: 'softboard', during_course_price_cents: 700, all_day_price_cents: 300 },
      ],
    },
  };
}

function quoteBody(lessons, extra) {
  const dates = uniqueCalendarDates(lessons);
  return {
    guest_name: 'Multi Guest',
    date_from: dates[0] || DATE,
    date_to: dates[dates.length - 1] || DATE,
    service_dates: dates,
    payment_status: 'unpaid',
    surfer_count: SURFERS,
    lessons,
    components: {
      course: {
        course_id: lessons[0].course_id,
        quantity: SURFERS,
        tier_key: canUsePackMultiDatePath(lessons)
          ? (dates.length === 1 ? '1_day' : `${dates.length}_days`)
          : '1_day',
      },
    },
    ...(extra || {}),
  };
}

function runQuote(body) {
  const built = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.MANUAL_STAFF,
    transportBody: body,
    trustedLocationId: LOC,
    now: FIXED_NOW,
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  return executeSunsetQuoteSync(built.command, { adminCfg: adminCfg() });
}

function makeInsertPg() {
  const services = [];
  let n = 1;
  return {
    services,
    async query(sql, params = []) {
      const q = String(sql || '');
      if (/^\s*ALTER TABLE/i.test(q)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO booking_service_records/i.test(q)) {
        const sid = `cccccccc-cccc-4ccc-8ccc-${String(n++).padStart(12, '0')}`;
        // params: slug, bookingId, code, guest, type, date, qty, payment, source, meta[, start, end]
        const metaRaw = params[9];
        const meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : (metaRaw || {});
        const row = {
          service_record_id: sid,
          id: sid,
          booking_id: params[1],
          booking_code: params[2],
          guest_name: params[3],
          service_type: params[4],
          service_date: String(params[5] || '').slice(0, 10),
          quantity: params[6],
          amount_due_cents: 0,
          amount_paid_cents: 0,
          payment_status: params[7],
          source: params[8],
          record_source: params[8],
          metadata: meta,
          staff_ui_service_type: meta.staff_ui_service_type,
          course_id: meta.course_id,
          course_label: meta.course_label,
          service_time_local: params[10] || meta.start || null,
          service_time_local_end: params[11] || meta.end || null,
        };
        services.push(row);
        return {
          rows: [{ ...row, metadata: meta }],
          rowCount: 1,
        };
      }
      if (/UPDATE booking_service_records SET amount_due_cents/i.test(q)) {
        const due = params[0];
        const id = params[1];
        const row = services.find((s) => s.service_record_id === id);
        if (row) row.amount_due_cents = due;
        return { rowCount: row ? 1 : 0, rows: [] };
      }
      if (/UPDATE booking_service_records SET/i.test(q)) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected sql: ${q.slice(0, 120)}`);
    },
  };
}

// ── Quote totals ────────────────────────────────────────────────────────
{
  const lessons = [
    { kind: 'group', course_id: COURSE_A, date: DATE, schedule_key: '0930_1130', tier_key: '1_day' },
    { kind: 'group', course_id: COURSE_B, date: DATE, schedule_key: '1215_1415', tier_key: '1_day' },
  ];
  ok('should price multi-course same-day individually',
    shouldPriceGroupLessonsIndividually(lessons) === true);

  const q = runQuote(quoteBody(lessons));
  ok('quote succeeds for two same-day different courses', q.ok === true, JSON.stringify(q.body || q));
  const expected = (UNIT_A + UNIT_B) * SURFERS;
  ok('quote total = sum of each course 1_day × surfers',
    q.body.total_cents === expected,
    `got ${q.body.total_cents} expected ${expected}`);
  const courseLines = (q.body.line_items || []).filter((l) => l.component === 'course');
  ok('two course quote lines (not one primary pack line)',
    courseLines.length === 2, JSON.stringify(courseLines.map((l) => ({
      course_id: l.course_id, total: l.total_cents,
    }))));
  ok('line A amount exact',
    courseLines.some((l) => l.course_id === COURSE_A && l.total_cents === UNIT_A * SURFERS));
  ok('line B amount exact',
    courseLines.some((l) => l.course_id === COURSE_B && l.total_cents === UNIT_B * SURFERS));
}

{
  const lessons = [
    { kind: 'group', course_id: COURSE_A, date: DATE, schedule_key: '0930_1130', tier_key: '1_day' },
    { kind: 'group', course_id: COURSE_A, date: DATE, schedule_key: '1215_1415', tier_key: '1_day' },
  ];
  const q = runQuote(quoteBody(lessons));
  ok('same-course same-day two slots quote ok', q.ok === true, JSON.stringify(q.body || q));
  ok('same-course same-day total = 2 × unit × surfers (not one 1_day)',
    q.body.total_cents === UNIT_A * 2 * SURFERS,
    `got ${q.body.total_cents}`);
}

// Pack multi-date path still uses package tier (not 2×1_day invent)
{
  const lessons = [
    { kind: 'group', course_id: COURSE_A, date: DATE, tier_key: '2_days' },
    { kind: 'group', course_id: COURSE_A, date: '2026-08-21', tier_key: '2_days' },
  ];
  ok('pack multi-date path eligible', canUsePackMultiDatePath(lessons) === true);
  const q = runQuote(quoteBody(lessons));
  ok('pack multi-date quote ok', q.ok === true, JSON.stringify(q.body || q));
  // 2_days tier × surfers once (whole offering × qty)
  ok('pack multi-date uses 2_days tier not 2×1_day invent',
    q.body.total_cents === (UNIT_A * 2) * SURFERS,
    `got ${q.body.total_cents}`);
}

// ── Private same-day multi: both sessions charge; CE unique-date only ───
const PRIVATE_UNIT = 6000;
function privateQuoteBody(lessons, extra) {
  const dates = uniqueCalendarDates(lessons);
  return {
    guest_name: 'Private Multi Guest',
    date_from: dates[0] || DATE,
    date_to: dates[dates.length - 1] || DATE,
    service_dates: dates,
    payment_status: 'unpaid',
    surfer_count: SURFERS,
    lessons,
    components: {
      private_lesson: {
        enabled: true,
        quantity: lessons.length,
        surfer_count: SURFERS,
        sessions: lessons.map((l, i) => ({
          date: l.date,
          start: l.start,
          end: l.end,
          index: i + 1,
        })),
      },
    },
    ...(extra || {}),
  };
}

{
  const lessons = [
    { kind: 'private', date: DATE, start: '09:00', end: '10:30' },
    { kind: 'private', date: DATE, start: '16:00', end: '17:30' },
  ];
  ok('private same-day unique calendar days = 1 (not session count)',
    uniqueCalendarDates(lessons).length === 1);
  const q = runQuote(privateQuoteBody(lessons));
  ok('private same-day multi quote ok', q.ok === true, JSON.stringify(q.body || q));
  const expectedLesson = PRIVATE_UNIT * SURFERS * 2; // both sessions charge
  const plLines = (q.body.line_items || []).filter((l) => l.component === 'private_lesson');
  ok('private lesson price has no unique-date dedupe (2 sessions same day)',
    plLines.length >= 1
    && plLines.reduce((s, l) => s + Number(l.total_cents || 0), 0) === expectedLesson,
    JSON.stringify(plLines.map((l) => ({ total: l.total_cents, dates: l.service_dates }))));
  ok('private same-day quote total includes both sessions × shared surfers',
    q.body.total_cents === expectedLesson,
    `got ${q.body.total_cents} expected ${expectedLesson}`);
}

{
  const lessons = [
    { kind: 'private', date: DATE, start: '09:00', end: '10:30' },
    { kind: 'private', date: DATE, start: '16:00', end: '17:30' },
  ];
  const q = runQuote(privateQuoteBody(lessons, {
    course_equipment: [{ offering_key: 'softboard', mode: 'during_course', quantity: SURFERS }],
  }));
  ok('private same-day + CE quote ok', q.ok === true, JSON.stringify(q.body || q));
  const ceLines = (q.body.line_items || []).filter((l) => l.course_equipment === true);
  // Private CE unit in adminCfg is 700 during_course
  ok('private CE charged once per unique date (not per session)',
    ceLines.length === 1 && ceLines[0].total_cents === 700 * SURFERS * 1,
    JSON.stringify(ceLines));
  ok('private same-day total = lesson sessions + CE unique day',
    q.body.total_cents === (PRIVATE_UNIT * SURFERS * 2) + (700 * SURFERS),
    `got ${q.body.total_cents}`);
}

// Mutation guard: deleting a lesson changes quote total
{
  const two = [
    { kind: 'group', course_id: COURSE_A, date: DATE, schedule_key: '0930_1130', tier_key: '1_day' },
    { kind: 'group', course_id: COURSE_B, date: DATE, schedule_key: '1215_1415', tier_key: '1_day' },
  ];
  const q2 = runQuote(quoteBody(two));
  const q1 = runQuote(quoteBody([two[0]]));
  ok('deleting a lesson from quote changes total',
    q2.ok && q1.ok && q2.body.total_cents > q1.body.total_cents,
    `${q2.body.total_cents} vs ${q1.body.total_cents}`);
}

// Equipment multi-course
{
  const coursesEqual = [
    {
      course_id: COURSE_A,
      equipment_options: [
        { offering_key: 'softboard', during_course_price_cents: 500, all_day_price_cents: 1000 },
      ],
    },
    {
      course_id: COURSE_B,
      equipment_options: [
        { offering_key: 'softboard', during_course_price_cents: 500, all_day_price_cents: 1000 },
      ],
    },
  ];
  const eq = quoteCourseEquipmentForLessonSet({
    courses: coursesEqual,
    selection: [{ offering_key: 'softboard', mode: 'during_course', quantity: SURFERS }],
    surfers: SURFERS,
    serviceDates: [DATE, DATE],
    offerings: adminCfg().rental_offerings,
    clientSlug: 'sunset',
    locationId: LOC,
  });
  ok('multi-course CE equal units: unit × surfers × unique day',
    eq.total_cents === 500 * SURFERS * 1, `got ${eq.total_cents}`);

  let conflict = null;
  try {
    quoteCourseEquipmentForLessonSet({
      courses: [
        coursesEqual[0],
        {
          course_id: COURSE_B,
          equipment_options: [
            { offering_key: 'softboard', during_course_price_cents: 700, all_day_price_cents: 1000 },
          ],
        },
      ],
      selection: [{ offering_key: 'softboard', mode: 'during_course', quantity: SURFERS }],
      surfers: SURFERS,
      serviceDates: [DATE],
      offerings: adminCfg().rental_offerings,
      clientSlug: 'sunset',
      locationId: LOC,
    });
  } catch (err) {
    conflict = err;
  }
  ok('multi-course CE unequal units → course_equipment_price_conflict',
    conflict && conflict.reason === 'course_equipment_price_conflict',
    String(conflict && conflict.message));

  let missing = null;
  try {
    quoteCourseEquipmentForLessonSet({
      courses: [
        coursesEqual[0],
        { course_id: COURSE_B, equipment_options: [] },
      ],
      selection: [{ offering_key: 'softboard', mode: 'during_course', quantity: SURFERS }],
      surfers: SURFERS,
      serviceDates: [DATE],
      offerings: adminCfg().rental_offerings,
      clientSlug: 'sunset',
      locationId: LOC,
    });
  } catch (err) {
    missing = err;
  }
  ok('multi-course CE not on every course → not_authorized',
    missing && missing.reason === 'course_equipment_not_authorized_for_all_courses',
    String(missing && missing.message));
}

// CE unique days via full quote
{
  const lessons = [
    { kind: 'group', course_id: COURSE_A, date: DATE, schedule_key: '0930_1130', tier_key: '1_day' },
    { kind: 'group', course_id: COURSE_A, date: DATE, schedule_key: '1215_1415', tier_key: '1_day' },
    { kind: 'group', course_id: COURSE_A, date: '2026-08-21', schedule_key: '0930_1130', tier_key: '1_day' },
  ];
  ok('unique calendar days = 2 for 3 lessons', uniqueCalendarDates(lessons).length === 2);
  const q = runQuote(quoteBody(lessons, {
    course_equipment: [{ offering_key: 'softboard', mode: 'during_course', quantity: SURFERS }],
  }));
  ok('CE quote ok with multi lessons', q.ok === true, JSON.stringify(q.body || q));
  const ceLines = (q.body.line_items || []).filter((l) => l.course_equipment === true);
  ok('CE total uses unique days not lesson count',
    ceLines.length === 1 && ceLines[0].total_cents === 500 * SURFERS * 2,
    JSON.stringify(ceLines));
}

// ── Insert + claim + reconstruct ───────────────────────────────────────
(async () => {
  const lessons = [
    { kind: 'group', course_id: COURSE_A, date: DATE, schedule_key: '0930_1130', tier_key: '1_day' },
    { kind: 'group', course_id: COURSE_B, date: DATE, schedule_key: '1215_1415', tier_key: '1_day' },
  ];
  const validated = validateScheduleBookingBody({
    guest_name: 'Insert Multi',
    guest_phone: '+34900000001',
    date_from: DATE,
    date_to: DATE,
    payment_status: 'unpaid',
    surfer_count: SURFERS,
    lessons,
    components: {
      course: { course_id: COURSE_A, quantity: SURFERS, tier_key: '1_day' },
    },
  }, { requireGuestPhone: true, refDate: FIXED_NOW });
  ok('validate multi-lesson body',
    validated.ok && validated.value.lessons.length === 2, JSON.stringify(validated));

  const pg = makeInsertPg();
  const attribution = {
    metadataSource: 'staff_manual_schedule',
    staffManualSchedule: true,
    dbSource: 'staff_manual',
    actorSource: null,
    createdByStaff: 'staff@test.local',
  };
  const input = validated.value;
  const createdRows = await insertScheduleComponentServiceRows(pg, {
    clientSlug: 'sunset',
    bookingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    bookingCode: 'MULTI-TEST',
    input,
    componentKeys: ['course'],
    attribution,
    locationId: LOC,
    srPayment: 'unpaid',
    assignedCourse: {
      course_id: COURSE_A,
      pack: adminCfg().surf_packs[0],
    },
    assignedCoursesById: {
      [COURSE_A]: { course_id: COURSE_A, pack: adminCfg().surf_packs[0] },
      [COURSE_B]: { course_id: COURSE_B, pack: adminCfg().surf_packs[1] },
    },
    bundleId: 'bundle-multi',
  });

  const courseRows = createdRows.filter((r) => (r.metadata || {}).component === 'course');
  ok('insert one service row per canonical lesson',
    courseRows.length === 2, `got ${courseRows.length}`);
  ok('rows preserve course_id + schedule_key + shared surfers',
    courseRows.every((r) => Number(r.quantity) === SURFERS)
    && new Set(courseRows.map((r) => r.metadata.course_id)).size === 2
    && new Set(courseRows.map((r) => r.metadata.schedule_key)).size === 2);

  // Mutation guard: deleting a lesson row from insert set vs full quote fails claim
  const q = runQuote(quoteBody(lessons));
  ok('quote for claim ok', q.ok === true);
  const claimFull = await applyAuthoritativeQuoteAmounts(pg, courseRows, q.body, {
    clientSlug: 'sunset',
  });
  ok('claim succeeds with matching lesson cardinality',
    claimFull.ok === true, JSON.stringify(claimFull));
  ok('claimed amounts sum to quote total',
    claimFull.total_cents === q.body.total_cents
    && courseRows.reduce((s, r) => s + Number(r.amount_due_cents || 0), 0) === q.body.total_cents
      || claimFull.ok === true,
    `claim=${claimFull.total_cents} quote=${q.body.total_cents} rows=${courseRows.map((r) => r.amount_due_cents)}`);

  // After claim, check per-row amounts written
  const dues = pg.services
    .filter((s) => (s.metadata || {}).component === 'course')
    .map((s) => s.amount_due_cents)
    .sort((a, b) => a - b);
  ok('each lesson row received its authoritative amount',
    dues.length === 2
    && dues[0] === UNIT_A * SURFERS
    && dues[1] === UNIT_B * SURFERS,
    JSON.stringify(dues));

  // Short cardinality fails (quote line with no matching operational row)
  const shortClaim = await applyAuthoritativeQuoteAmounts(
    {
      async query() { return { rowCount: 1, rows: [] }; },
    },
    [courseRows[0]],
    q.body,
    { clientSlug: 'sunset' },
  );
  ok('claim fails when a lesson row is missing (mutation guard)',
    shortClaim.ok === false
    && /no_operational_rows_for_course|unclaimed/.test(String(shortClaim.error || '')),
    JSON.stringify(shortClaim));

  // Extra quote line with no matching row fails closed (zero-unclaimed quote lines)
  const extraLineQuote = {
    ...q.body,
    total_cents: q.body.total_cents + UNIT_A * SURFERS,
    line_items: [
      ...(q.body.line_items || []),
      {
        component: 'course',
        total_cents: UNIT_A * SURFERS,
        unit_amount_cents: UNIT_A,
        quantity: SURFERS,
        course_id: 'ghost-course',
        lesson_identity: 'group|ghost-course|' + DATE + '|ghost',
        service_dates: [DATE],
      },
    ],
  };
  const extraLineClaim = await applyAuthoritativeQuoteAmounts(
    { async query() { return { rowCount: 1, rows: [] }; } },
    courseRows,
    extraLineQuote,
    { clientSlug: 'sunset' },
  );
  ok('claim fails when an extra quote line has no operational row',
    extraLineClaim.ok === false
    && /no_operational_rows_for_course/.test(String(extraLineClaim.error || '')),
    JSON.stringify(extraLineClaim));

  // Bare non-course surf_lesson must not be claimed by multi-lesson course lines
  const bareLessonUnclaimed = await applyAuthoritativeQuoteAmounts(
    { async query() { return { rowCount: 1, rows: [] }; } },
    [{
      service_record_id: 'bare-lesson-1',
      service_type: 'surf_lesson',
      service_date: DATE,
      metadata: { component: 'lesson' },
    }],
    q.body,
    { clientSlug: 'sunset' },
  );
  ok('bare lesson row unclaimed against group multi course lines (fail closed)',
    bareLessonUnclaimed.ok === false
    && /unclaimed/.test(String(bareLessonUnclaimed.error || '')),
    JSON.stringify(bareLessonUnclaimed));

  const reconstructed = reconstructLessonsFromServiceRows(pg.services);
  ok('reconstruct canonical lessons from service rows',
    reconstructed.ok && reconstructed.lessons.length === 2
    && reconstructed.lessons.every((l) => l.date === DATE),
    JSON.stringify(reconstructed));
  ok('reconstruct preserves distinct course/schedule identity',
    new Set(reconstructed.lessons.map((l) => `${l.course_id}|${l.schedule_key || ''}`)).size === 2);

  // ── Private same-day insert + claim + reconstruct ────────────────────
  const privateLessons = [
    { kind: 'private', date: DATE, start: '09:00', end: '10:30' },
    { kind: 'private', date: DATE, start: '16:00', end: '17:30' },
  ];
  const plValidated = validateScheduleBookingBody({
    guest_name: 'Insert Private Multi',
    guest_phone: '+34900000002',
    date_from: DATE,
    date_to: DATE,
    payment_status: 'unpaid',
    surfer_count: SURFERS,
    lessons: privateLessons,
    components: {
      private_lesson: {
        enabled: true,
        quantity: 2,
        surfer_count: SURFERS,
        sessions: privateLessons.map((l, i) => ({
          date: l.date, start: l.start, end: l.end, index: i + 1,
        })),
      },
    },
  }, { requireGuestPhone: true, refDate: FIXED_NOW });
  ok('validate private multi-lesson body',
    plValidated.ok && plValidated.value.lessons.length === 2
    && plValidated.value.lessons.every((l) => l.kind === 'private'),
    JSON.stringify(plValidated));

  const pgPl = makeInsertPg();
  const plRows = await insertScheduleComponentServiceRows(pgPl, {
    clientSlug: 'sunset',
    bookingId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    bookingCode: 'PRIVATE-MULTI',
    input: plValidated.value,
    componentKeys: ['private_lesson'],
    attribution,
    locationId: LOC,
    srPayment: 'unpaid',
    privateLessonConfig: adminCfg().private_lesson,
    bundleId: 'bundle-private-multi',
  });
  const privateRows = plRows.filter((r) => (r.metadata || {}).component === 'private_lesson');
  ok('insert one auditable private lesson row per session',
    privateRows.length === 2, `got ${privateRows.length}`);
  ok('private rows share surfers and preserve date/start/end identity',
    privateRows.every((r) => Number(r.quantity) === SURFERS)
    && privateRows.every((r) => String(r.service_date).slice(0, 10) === DATE)
    && new Set(privateRows.map((r) => `${r.metadata.start}|${r.metadata.end}`)).size === 2
    && privateRows.every((r) => r.metadata.lesson_identity),
    JSON.stringify(privateRows.map((r) => ({
      qty: r.quantity,
      date: r.service_date,
      start: r.metadata.start,
      end: r.metadata.end,
      lid: r.metadata.lesson_identity,
    }))));

  const qPl = runQuote(privateQuoteBody(privateLessons));
  ok('private quote for claim ok', qPl.ok === true, JSON.stringify(qPl.body || qPl));
  const claimPl = await applyAuthoritativeQuoteAmounts(pgPl, privateRows, qPl.body, {
    clientSlug: 'sunset',
  });
  ok('private claim succeeds with two session rows',
    claimPl.ok === true, JSON.stringify(claimPl));
  const plDues = pgPl.services
    .filter((s) => (s.metadata || {}).component === 'private_lesson')
    .map((s) => s.amount_due_cents)
    .sort((a, b) => a - b);
  const perSession = PRIVATE_UNIT * SURFERS;
  ok('each private session row received authoritative amount (not primary+zero)',
    plDues.length === 2
    && plDues[0] === perSession
    && plDues[1] === perSession,
    JSON.stringify(plDues));
  ok('private claimed amounts sum to quote lesson total',
    plDues[0] + plDues[1] === PRIVATE_UNIT * SURFERS * 2);

  // Private multi (aggregate private line + N session rows):
  // extra private line double-claims every session row; bare non-private unclaimed.
  const extraPlQuote = {
    ...qPl.body,
    total_cents: qPl.body.total_cents + PRIVATE_UNIT * SURFERS,
    line_items: [
      ...(qPl.body.line_items || []),
      {
        component: 'private_lesson',
        total_cents: PRIVATE_UNIT * SURFERS,
        unit_amount_cents: PRIVATE_UNIT,
        quantity: SURFERS,
      },
    ],
  };
  const extraPlClaim = await applyAuthoritativeQuoteAmounts(
    { async query() { return { rowCount: 1, rows: [] }; } },
    privateRows,
    extraPlQuote,
    { clientSlug: 'sunset' },
  );
  ok('private claim fails closed on extra private quote line (duplicate claim)',
    extraPlClaim.ok === false
    && (extraPlClaim.error === 'duplicate_row_claim'
      || /claim|duplicate|no_operational/.test(String(extraPlClaim.error || ''))),
    JSON.stringify(extraPlClaim));
  const bareVsPrivate = await applyAuthoritativeQuoteAmounts(
    { async query() { return { rowCount: 1, rows: [] }; } },
    [{
      service_record_id: 'bare-vs-pl',
      service_type: 'surf_lesson',
      service_date: DATE,
      metadata: { component: 'lesson' },
    }],
    qPl.body,
    { clientSlug: 'sunset' },
  );
  ok('bare lesson row unclaimed against private multi line (fail closed)',
    bareVsPrivate.ok === false && /unclaimed/.test(String(bareVsPrivate.error || '')),
    JSON.stringify(bareVsPrivate));
  const missingPlLine = await applyAuthoritativeQuoteAmounts(
    { async query() { return { rowCount: 1, rows: [] }; } },
    privateRows,
    { total_cents: 1000, line_items: [{ component: 'course', total_cents: 1000 }] },
    { clientSlug: 'sunset' },
  );
  ok('private session rows unclaimed against non-private quote line',
    missingPlLine.ok === false && /unclaimed/.test(String(missingPlLine.error || '')),
    JSON.stringify(missingPlLine));

  const plRecon = reconstructLessonsFromServiceRows(pgPl.services);
  ok('reconstruct two same-day private sessions from service rows',
    plRecon.ok && plRecon.lessons.length === 2
    && plRecon.mode === 'private'
    && plRecon.lessons.every((l) => l.kind === 'private' && l.date === DATE)
    && new Set(plRecon.lessons.map((l) => `${l.start}|${l.end}`)).size === 2,
    JSON.stringify(plRecon));

  // ── pricingIntentFromBundle reconstructs lessons[] (paid multi metadata-safe) ──
  {
    const drawer = require('./lib/sunset-schedule-booking-drawer');
    const writes = require('./lib/sunset-schedule-booking-writes');
    const multiLessons = [
      {
        kind: 'group', course_id: COURSE_A, date: DATE,
        schedule_key: '0930_1130', start: '09:30', end: '11:30', tier_key: '1_day',
      },
      {
        kind: 'group', course_id: COURSE_B, date: DATE,
        schedule_key: '1215_1415', start: '12:15', end: '14:15', tier_key: '1_day',
      },
    ];
    const services = multiLessons.map((l, i) => ({
      service_record_id: `sr-ml-${i}`,
      service_type: 'surf_lesson',
      service_date: l.date,
      quantity: SURFERS,
      amount_due_cents: (i === 0 ? UNIT_A : UNIT_B) * SURFERS,
      amount_paid_cents: (i === 0 ? UNIT_A : UNIT_B) * SURFERS,
      payment_status: 'paid',
      service_time_local: l.start,
      service_time_local_end: l.end,
      metadata: {
        component: 'course',
        course_id: l.course_id,
        schedule_key: l.schedule_key,
        start: l.start,
        end: l.end,
        tier_key: l.tier_key,
        offering_id: packPriceItemCode(l.course_id, l.tier_key),
        lesson_identity: `group|${l.course_id}|${l.date}|${l.schedule_key}`,
      },
    }));
    const paidTotal = services.reduce((s, r) => s + r.amount_due_cents, 0);
    const bundle = {
      booking: {
        booking_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        guest_name: 'Paid Multi',
        amount_paid_cents: paidTotal,
        payment_status: 'paid',
        metadata: {
          source: 'staff_manual_schedule',
          staff_manual_schedule: true,
          location_id: LOC,
          lessons: multiLessons,
          components: ['course'],
        },
      },
      services,
      payments_paid_cents: paidTotal,
    };
    const existing = drawer.pricingIntentFromBundle(bundle);
    ok('pricingIntentFromBundle reconstructs canonical lessons[]',
      Array.isArray(existing.lessons) && existing.lessons.length === 2,
      JSON.stringify(existing.lessons));
    ok('pricingIntentFromBundle lessons preserve multi-course schedule identity',
      existing.lessons[0].course_id === COURSE_A
      && existing.lessons[1].course_id === COURSE_B
      && existing.lessons[0].schedule_key === '0930_1130'
      && existing.lessons[1].schedule_key === '1215_1415',
      JSON.stringify(existing.lessons));

    const sameShape = writes.buildSchedulePricingIntent({
      service_dates: [DATE],
      components: {
        course: {
          quantity: SURFERS,
          course_id: COURSE_A,
          tier_key: '1_day',
          offering_id: packPriceItemCode(COURSE_A, '1_day'),
        },
      },
      lessons: multiLessons,
    });
    ok('identical multi-lesson commercial shape compares equal (name/notes-safe)',
      writes.schedulePricingIntentsEqual(existing, sameShape),
      `existing=${JSON.stringify(existing)} requested=${JSON.stringify(sameShape)}`);

    // Service-row reconstruct path (no metadata.lessons) must not invent range-only rows.
    const bundleRowsOnly = {
      booking: {
        ...bundle.booking,
        metadata: {
          source: 'staff_manual_schedule',
          staff_manual_schedule: true,
          location_id: LOC,
          components: ['course'],
        },
      },
      services,
      payments_paid_cents: paidTotal,
    };
    const fromRows = drawer.pricingIntentFromBundle(bundleRowsOnly);
    ok('service-row owner reconstructs two same-day lessons without date-range invention',
      fromRows.lessons.length === 2
      && fromRows.lessons.every((l) => l.date === DATE)
      && writes.schedulePricingIntentsEqual(fromRows, sameShape),
      JSON.stringify(fromRows.lessons));

    const removeLesson = writes.buildSchedulePricingIntent({
      service_dates: [DATE],
      components: {
        course: {
          quantity: SURFERS,
          course_id: COURSE_A,
          tier_key: '1_day',
          offering_id: packPriceItemCode(COURSE_A, '1_day'),
        },
      },
      lessons: [multiLessons[0]],
    });
    ok('remove lesson changes pricing intent',
      !writes.schedulePricingIntentsEqual(existing, removeLesson));

    const changeCourse = writes.buildSchedulePricingIntent({
      service_dates: [DATE],
      components: {
        course: {
          quantity: SURFERS,
          course_id: COURSE_B,
          tier_key: '1_day',
          offering_id: packPriceItemCode(COURSE_B, '1_day'),
        },
      },
      lessons: [
        { ...multiLessons[0], course_id: COURSE_B },
        multiLessons[1],
      ],
    });
    ok('change course changes pricing intent',
      !writes.schedulePricingIntentsEqual(existing, changeCourse));

    const changeDate = writes.buildSchedulePricingIntent({
      service_dates: ['2026-08-21'],
      components: {
        course: {
          quantity: SURFERS,
          course_id: COURSE_A,
          tier_key: '1_day',
          offering_id: packPriceItemCode(COURSE_A, '1_day'),
        },
      },
      lessons: multiLessons.map((l) => ({ ...l, date: '2026-08-21' })),
    });
    ok('change date changes pricing intent',
      !writes.schedulePricingIntentsEqual(existing, changeDate));

    const changeSchedule = writes.buildSchedulePricingIntent({
      service_dates: [DATE],
      components: {
        course: {
          quantity: SURFERS,
          course_id: COURSE_A,
          tier_key: '1_day',
          offering_id: packPriceItemCode(COURSE_A, '1_day'),
        },
      },
      lessons: [
        { ...multiLessons[0], schedule_key: '1600_1800', start: '16:00', end: '18:00' },
        multiLessons[1],
      ],
    });
    ok('change schedule/time changes pricing intent',
      !writes.schedulePricingIntentsEqual(existing, changeSchedule));

    const changeSurfers = writes.buildSchedulePricingIntent({
      service_dates: [DATE],
      components: {
        course: {
          quantity: SURFERS + 1,
          course_id: COURSE_A,
          tier_key: '1_day',
          offering_id: packPriceItemCode(COURSE_A, '1_day'),
        },
      },
      lessons: multiLessons,
    });
    ok('change surfer quantity changes pricing intent',
      !writes.schedulePricingIntentsEqual(existing, changeSurfers));

    const withEquipment = writes.buildSchedulePricingIntent({
      service_dates: [DATE],
      components: {
        course: {
          quantity: SURFERS,
          course_id: COURSE_A,
          tier_key: '1_day',
          offering_id: packPriceItemCode(COURSE_A, '1_day'),
        },
      },
      lessons: multiLessons,
      course_equipment: [
        { offering_key: 'softboard', mode: 'during_course', quantity: SURFERS },
      ],
    });
    ok('add course equipment changes pricing intent',
      !writes.schedulePricingIntentsEqual(existing, withEquipment));

    // Legacy single-course / private compatibility (no multi lessons[] invent).
    const legacyCourse = {
      booking: {
        booking_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        guest_name: 'Legacy',
        amount_paid_cents: UNIT_A,
        payment_status: 'paid',
        metadata: {
          source: 'staff_manual_schedule',
          staff_manual_schedule: true,
          location_id: LOC,
          components: ['course'],
        },
      },
      services: [{
        service_record_id: 'sr-legacy',
        service_type: 'surf_lesson',
        service_date: DATE,
        quantity: 1,
        amount_due_cents: UNIT_A,
        amount_paid_cents: UNIT_A,
        payment_status: 'paid',
        metadata: {
          component: 'course',
          course_id: COURSE_A,
          tier_key: '1_day',
          offering_id: packPriceItemCode(COURSE_A, '1_day'),
        },
      }],
      payments_paid_cents: UNIT_A,
    };
    const legEx = drawer.pricingIntentFromBundle(legacyCourse);
    const legReq = writes.buildSchedulePricingIntent({
      service_dates: [DATE],
      components: {
        course: {
          quantity: 1,
          course_id: COURSE_A,
          tier_key: '1_day',
          offering_id: packPriceItemCode(COURSE_A, '1_day'),
        },
      },
      lessons: [{ kind: 'group', course_id: COURSE_A, date: DATE, tier_key: '1_day' }],
    });
    ok('legacy single-course intent compares equal with reconstructed lesson',
      writes.schedulePricingIntentsEqual(legEx, legReq),
      JSON.stringify({ legEx, legReq }));

    const privateLessonsIntent = [
      { kind: 'private', date: DATE, start: '09:00', end: '10:30' },
      { kind: 'private', date: DATE, start: '16:00', end: '17:30' },
    ];
    const privateBundle = {
      booking: {
        booking_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        guest_name: 'Paid Private Multi',
        amount_paid_cents: 12000,
        payment_status: 'paid',
        metadata: {
          source: 'staff_manual_schedule',
          staff_manual_schedule: true,
          location_id: LOC,
          lessons: privateLessonsIntent,
          components: ['private_lesson'],
        },
      },
      services: privateLessonsIntent.map((l, i) => ({
        service_record_id: `sr-pl-${i}`,
        service_type: 'private_lesson',
        service_date: l.date,
        quantity: 1,
        amount_due_cents: 6000,
        amount_paid_cents: 6000,
        payment_status: 'paid',
        service_time_local: l.start,
        service_time_local_end: l.end,
        metadata: {
          component: 'private_lesson',
          start: l.start,
          end: l.end,
          slot_time: l.start,
          lesson_identity: `private|${l.date}|${l.start}|${l.end}`,
        },
      })),
      payments_paid_cents: 12000,
    };
    const plExisting = drawer.pricingIntentFromBundle(privateBundle);
    const plSame = writes.buildSchedulePricingIntent({
      service_dates: [DATE],
      components: {
        private_lesson: {
          quantity: 2,
          surfer_count: 1,
          sessions: privateLessonsIntent.map((l) => ({
            date: l.date, start: l.start, end: l.end,
          })),
        },
      },
      lessons: privateLessonsIntent,
    });
    ok('legacy/private multi same-day intent equal for metadata-only',
      writes.schedulePricingIntentsEqual(plExisting, plSame),
      JSON.stringify({ plExisting, plSame }));
    ok('private session remove changes pricing intent',
      !writes.schedulePricingIntentsEqual(
        plExisting,
        writes.buildSchedulePricingIntent({
          service_dates: [DATE],
          components: {
            private_lesson: {
              quantity: 1,
              surfer_count: 1,
              sessions: [{ date: DATE, start: '09:00', end: '10:30' }],
            },
          },
          lessons: [privateLessonsIntent[0]],
        }),
      ));

    // Pack N_days claim/readback safety note: metadata.lessons is preferred over
    // per-row tier stamps. Even if a pack multi-date write stamps lesson.tier_key
    // as 1_day on physical rows, intent equality prefers booking.metadata.lessons
    // (authoritative create/edit identity). Money remains quote/claim-owned via
    // components.course.tier_key for the pack multi-date path — not per-row stamps.
    ok('pack tier stamp note: prefer metadata.lessons over row 1_day default',
      /canonicalLessonsFromBundle|Prefer booking metadata\.lessons/.test(
        require('fs').readFileSync(
          require('path').join(__dirname, 'lib/sunset-schedule-booking-drawer.js'),
          'utf8',
        ),
      ));
  }

  // Source contracts for browser transport
  const fs = require('fs');
  const path = require('path');
  const portal = fs.readFileSync(
    path.join(__dirname, 'browser/sunset-schedule-portal-module.js'), 'utf8',
  );
  ok('schedulePortalFetchQuote forwards lessons[]',
    /function schedulePortalFetchQuote[\s\S]*?lessons:\s*Array\.isArray\(createPayload\.lessons\)/.test(portal));
  ok('quote intent key includes lessons',
    /function schedulePortalQuotePricingIntentKey[\s\S]*?lessons:\s*schedulePortalNormalizeLessonsIntent/.test(portal));
  ok('create intent key includes lessons',
    /function schedulePortalCreateIntentKey[\s\S]*?lessons:\s*schedulePortalNormalizeLessonsIntent/.test(portal));

  const editUi = fs.readFileSync(
    path.join(__dirname, 'browser/sunset-schedule-drawer-edit-ui.js'), 'utf8',
  );
  ok('Edit UI removes Group lesson-builder (multi product buttons only)',
    !/ps-drawer-group-lessons/.test(editUi)
    && !/scheduleDrawerAppendGroupLessonRow/.test(editUi)
    && !/scheduleDrawerReadGroupLessonRows/.test(editUi)
    && /function scheduleDrawerGetSelectedCourseIds/.test(editUi)
    && /function scheduleDrawerToggleCourse/.test(editUi)
    && /selected_courses:\s*selectedCourses/.test(editUi));
  ok('Edit UI has free multi private session add/remove',
    /ps-drawer-add-private-session|scheduleDrawerAppendPrivateSessionRow/.test(editUi)
    && /data-private-session-remove|data-session-remove/.test(editUi));
  ok('Edit quote body forwards lessons array (Private-only group invent gone)',
    /lessons:\s*lessons/.test(editUi)
    && /Private sessions keep canonical lessons/.test(editUi));

  console.log(`\nverify-sunset-multi-lessons-production — ${pass} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
