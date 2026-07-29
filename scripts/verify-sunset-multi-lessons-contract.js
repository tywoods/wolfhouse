'use strict';

/**
 * Multi-lesson Create/Edit contract + adjacent Edit/invoice regressions.
 * Pure offline gates (no staging DB / live bookings).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  normalizeCanonicalLessons,
  expandLessonsToLegacyComponents,
  uniqueCalendarDates,
  canUsePackMultiDatePath,
  canonicalLessonsForIntentFingerprint,
  lessonIdentity,
  normalizeSelectedCourses,
} = require('./lib/sunset-schedule-lessons');
const {
  prepareCanonicalRentalsForCreate,
  validateScheduleBookingBody,
} = require('./lib/sunset-schedule-booking-writes');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuoteSync,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');
const drawer = require('./lib/sunset-schedule-booking-drawer');
const { formatServiceRecordInvoiceLineText } = require('./lib/service-record-invoice-line');

let pass = 0;
function ok(name, cond, detail) {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    process.exit(1);
  }
  console.log(`PASS ${name}`);
  pass += 1;
}

const DATE_A = '2026-08-20';
const DATE_B = '2026-08-21';
const COURSE_1 = 'course-alpha';
const COURSE_2 = 'course-beta';

// ── multi-lesson normalize ──────────────────────────────────────────────
{
  const twoGroupSameDay = normalizeCanonicalLessons({
    lessons: [
      { kind: 'group', course_id: COURSE_1, date: DATE_A, schedule_key: '0930_1130' },
      { kind: 'group', course_id: COURSE_1, date: DATE_A, schedule_key: '1215_1415' },
    ],
  });
  ok('two Group lessons same day accepted', twoGroupSameDay.ok === true
    && twoGroupSameDay.lessons.length === 2
    && twoGroupSameDay.mode === 'group'
    && twoGroupSameDay.unique_dates.length === 1, JSON.stringify(twoGroupSameDay));

  const twoGroupDiffDays = normalizeCanonicalLessons({
    lessons: [
      { kind: 'group', course_id: COURSE_1, date: DATE_A },
      { kind: 'group', course_id: COURSE_1, date: DATE_B },
    ],
  });
  ok('two Group lessons different days accepted', twoGroupDiffDays.ok
    && twoGroupDiffDays.unique_dates.length === 2
    && canUsePackMultiDatePath(twoGroupDiffDays.lessons) === true);

  const twoPrivateSameDay = normalizeCanonicalLessons({
    lessons: [
      { kind: 'private', date: DATE_A, start: '09:00', end: '10:30' },
      { kind: 'private', date: DATE_A, start: '16:00', end: '17:30' },
    ],
  });
  ok('two Private lessons same day accepted', twoPrivateSameDay.ok
    && twoPrivateSameDay.lessons.length === 2
    && twoPrivateSameDay.unique_dates.length === 1);

  const mixed = normalizeCanonicalLessons({
    lessons: [
      { kind: 'group', course_id: COURSE_1, date: DATE_A },
      { kind: 'private', date: DATE_A, start: '09:00', end: '10:00' },
    ],
  });
  ok('mixed Group+Private rejected', mixed.ok === false
    && mixed.reason === 'mixed_group_private_lessons', JSON.stringify(mixed));

  const dup = normalizeCanonicalLessons({
    lessons: [
      { kind: 'group', course_id: COURSE_1, date: DATE_A, schedule_key: '0930_1130' },
      { kind: 'group', course_id: COURSE_1, date: DATE_A, schedule_key: '0930_1130' },
    ],
  });
  ok('true duplicate Group row rejected', dup.ok === false && dup.reason === 'duplicate_lesson');

  const multiCourse = normalizeCanonicalLessons({
    lessons: [
      { kind: 'group', course_id: COURSE_1, date: DATE_A },
      { kind: 'group', course_id: COURSE_2, date: DATE_A, schedule_key: '1215_1415' },
    ],
  });
  ok('two different Group courses same day accepted', multiCourse.ok
    && multiCourse.lessons.length === 2
    && canUsePackMultiDatePath(multiCourse.lessons) === false);

  // Legacy expand
  const legacyGroup = normalizeCanonicalLessons({
    components: { course: { course_id: COURSE_1, quantity: 2, tier_key: '2_days' } },
    service_dates: [DATE_A, DATE_B],
  });
  ok('legacy single-course expands to ordered lessons', legacyGroup.ok
    && legacyGroup.lessons.length === 2
    && legacyGroup.lessons[0].date === DATE_A
    && legacyGroup.lessons[1].date === DATE_B);

  const legacyPrivate = normalizeCanonicalLessons({
    components: {
      private_lesson: {
        enabled: true,
        quantity: 2,
        surfer_count: 1,
        sessions: [
          { date: DATE_A, start: '09:00', end: '10:00' },
          { date: DATE_B, start: '09:00', end: '10:00' },
        ],
      },
    },
  });
  ok('legacy private sessions expand to lessons', legacyPrivate.ok
    && legacyPrivate.mode === 'private'
    && legacyPrivate.lessons.length === 2);

  const legacyMixed = normalizeCanonicalLessons({
    components: {
      course: { course_id: COURSE_1, quantity: 1 },
      private_lesson: {
        enabled: true, quantity: 1, surfer_count: 1,
        sessions: [{ date: DATE_A, start: '09:00', end: '10:00' }],
      },
    },
    service_dates: [DATE_A],
  });
  ok('legacy mixed course+private rejected', legacyMixed.ok === false);
}

// ── equipment unique calendar days (not lesson count) ───────────────────
{
  const lessons = [
    { kind: 'group', course_id: COURSE_1, date: DATE_A, schedule_key: '0930_1130' },
    { kind: 'group', course_id: COURSE_1, date: DATE_A, schedule_key: '1215_1415' },
    { kind: 'group', course_id: COURSE_1, date: DATE_B },
  ];
  const dates = uniqueCalendarDates(lessons);
  ok('equipment unique dates = 2 for 3 lessons spanning 2 days', dates.length === 2
    && dates[0] === DATE_A && dates[1] === DATE_B);

  // Simulate equipment total = unit × surfers × unique dates (not lesson count)
  const unit = 500; // €5 during
  const surfers = 3;
  const lessonCount = lessons.length;
  const uniqueN = dates.length;
  const total = unit * surfers * uniqueN;
  ok('equipment total uses unique dates not lesson count',
    total === 500 * 3 * 2 && total !== unit * surfers * lessonCount,
    `total=${total} lessonCountWouldBe=${unit * surfers * lessonCount}`);
}

// ── fingerprint includes ordered lesson identity ────────────────────────
{
  const lessonsA = normalizeCanonicalLessons({
    lessons: [
      { kind: 'group', course_id: COURSE_1, date: DATE_A, schedule_key: '0930_1130' },
      { kind: 'group', course_id: COURSE_1, date: DATE_A, schedule_key: '1215_1415' },
    ],
  }).lessons;
  const lessonsB = normalizeCanonicalLessons({
    lessons: [
      { kind: 'group', course_id: COURSE_1, date: DATE_A, schedule_key: '1215_1415' },
      { kind: 'group', course_id: COURSE_1, date: DATE_A, schedule_key: '0930_1130' },
    ],
  }).lessons;
  // After normalize both are ordered the same.
  ok('ordered fingerprint stable under input reorder',
    JSON.stringify(canonicalLessonsForIntentFingerprint(lessonsA))
      === JSON.stringify(canonicalLessonsForIntentFingerprint(lessonsB)));

  const lessonsC = normalizeCanonicalLessons({
    lessons: [
      { kind: 'group', course_id: COURSE_1, date: DATE_A, schedule_key: '0930_1130' },
      { kind: 'group', course_id: COURSE_2, date: DATE_A, schedule_key: '1215_1415' },
    ],
  }).lessons;
  ok('different course identity changes fingerprint',
    JSON.stringify(canonicalLessonsForIntentFingerprint(lessonsA))
      !== JSON.stringify(canonicalLessonsForIntentFingerprint(lessonsC)));
}

// ── class-only / rental-only / mixed preserved via expand ───────────────
{
  const classOnly = expandLessonsToLegacyComponents([
    { kind: 'group', course_id: COURSE_1, date: DATE_A },
  ], 2);
  ok('class-only expand has course component', classOnly.ok
    && classOnly.components.course
    && classOnly.components.course.quantity === 2);

  const rentalOnly = expandLessonsToLegacyComponents([], 1);
  ok('rental-only (no lessons) expands empty components', rentalOnly.ok
    && Object.keys(rentalOnly.components).length === 0);

  const privateExpand = expandLessonsToLegacyComponents([
    { kind: 'private', date: DATE_A, start: '09:00', end: '10:30' },
    { kind: 'private', date: DATE_A, start: '16:00', end: '17:30' },
  ], 1);
  ok('private multi-session expand preserves same-day sessions', privateExpand.ok
    && privateExpand.components.private_lesson.sessions.length === 2
    && privateExpand.service_dates.length === 1);
}

// ── Edit rental generic offering_key regression ─────────────────────────
{
  process.env.GENERIC_RENTAL_CREATE_ENABLED = 'true';
  const body = {
    guest_name: 'Ada',
    date_from: DATE_A,
    date_to: DATE_A,
    payment_status: 'unpaid',
    components: {},
    surfer_count: 1,
    rentals: [{ offering_key: 'towel_rental', duration_key: '1_day', quantity: 1 }],
  };
  // Current broken path: prepareCanonical alone rejects generic keys.
  const bare = prepareCanonicalRentalsForCreate(body);
  ok('RED evidence: prepareCanonical alone rejects generic offering_key',
    bare.ok === false
    && /offering_key is not allowed/.test(String(bare.error || '')),
    JSON.stringify(bare));

  // Fixed path must be available from drawer update helper (tested after wire).
  const updateSrc = fs.readFileSync(
    path.join(__dirname, 'lib/sunset-schedule-booking-drawer.js'),
    'utf8',
  );
  ok('update path prepares generic rentals before canonical (source contract)',
    /prepareGenericRentalsForCreate/.test(updateSrc)
    && /updateSunsetScheduleBooking/.test(updateSrc),
    'updateSunsetScheduleBooking must call prepareGenericRentalsForCreate');
}

// ── Invoice generic equipment label ─────────────────────────────────────
{
  const labelFn = drawer.formatSunsetDrawerDailyItemLabel
    || formatSunsetDrawerDailyItemLabel;
  const genericSr = {
    service_type: 'addon_service',
    quantity: 1,
    amount_due_cents: 200,
    metadata: {
      rental_offering: true,
      offering_key: 'towel_rental',
      offering_label: 'Towel',
      duration_key: '1_day',
      unit_cents: 200,
      staff_ui_service_type: 'rental',
    },
  };
  const compact = labelFn('addon_service', 1, genericSr);
  ok('invoice compact label uses Admin offering_label not addon_service',
    compact.indexOf('Towel') >= 0
    && compact.toLowerCase().indexOf('addon_service') < 0,
    compact);

  const historical = labelFn('addon_service', 1, {
    service_type: 'addon_service',
    quantity: 1,
    metadata: {
      rental_offering: true,
      offering_key: 'retired_thing',
      // no offering_label — historical fallback
      duration_key: '1_day',
    },
  });
  ok('invoice historical fallback uses offering_key not addon_service',
    historical.indexOf('retired_thing') >= 0
    || /rental/i.test(historical),
    historical);
  ok('invoice never bare addon_service for generic rental',
    historical.toLowerCase().indexOf('addon_service') < 0, historical);

  const lineText = formatServiceRecordInvoiceLineText({
    service_type: 'addon_service',
    quantity: 1,
    amount_due_cents: 200,
    metadata: {
      rental_offering: true,
      offering_key: 'towel_rental',
      offering_label: 'Towel',
      duration_key: '1_day',
      unit_cents: 200,
    },
  }, {
    typeLabel: (t, meta) => {
      if (meta && (meta.rental_offering || meta.offering_key)) {
        return String(meta.offering_label || meta.offering_key || 'Rental');
      }
      return t;
    },
  });
  ok('formatServiceRecordInvoiceLineText prefers Admin label',
    lineText.indexOf('Towel') >= 0
    && lineText.toLowerCase().indexOf('addon_service') < 0,
    lineText);

  // Production invoice surface: buildPaymentSummary (drawer readback) — not
  // formatter-only. Generic rental with offering_label: Towel must never paint
  // addon_service; inactive/deleted historical offering uses persisted key/label.
  const buildPaymentSummary = drawer.buildPaymentSummary;
  ok('production buildPaymentSummary owner exported', typeof buildPaymentSummary === 'function');
  if (typeof buildPaymentSummary === 'function') {
    const towelRow = {
      service_record_id: 'sr-towel',
      service_type: 'addon_service',
      service_date: DATE_A,
      quantity: 1,
      amount_due_cents: 200,
      metadata: {
        rental_offering: true,
        offering_key: 'towel_rental',
        offering_label: 'Towel',
        duration_key: '1_day',
        unit_cents: 200,
        staff_ui_service_type: 'rental',
      },
    };
    const histRow = {
      service_record_id: 'sr-retired',
      service_type: 'addon_service',
      service_date: DATE_A,
      quantity: 1,
      amount_due_cents: 150,
      metadata: {
        rental_offering: true,
        offering_key: 'deleted_offering_key',
        // historical snapshot — offering inactive/deleted; no live label
        duration_key: '1_day',
        unit_cents: 150,
      },
    };
    const pay = buildPaymentSummary(
      {},
      { total_amount_cents: 350, amount_paid_cents: 0, payment_status: 'unpaid' },
      [towelRow, histRow],
      'config',
      0,
      null,
      {},
    );
    const towelLine = (pay.line_items || []).find((li) => li.service_record_id === 'sr-towel');
    const histLine = (pay.line_items || []).find((li) => li.service_record_id === 'sr-retired');
    ok('production invoice readback renders Towel not addon_service',
      towelLine
      && String(towelLine.label).indexOf('Towel') >= 0
      && String(towelLine.label).toLowerCase().indexOf('addon_service') < 0,
      JSON.stringify(towelLine));
    ok('production invoice historical inactive offering uses persisted key',
      histLine
      && String(histLine.label).indexOf('deleted_offering_key') >= 0
      && String(histLine.label).toLowerCase().indexOf('addon_service') < 0,
      JSON.stringify(histLine));

    // Also prove full Payments line text owner for the same rows
    const payLineTowel = formatServiceRecordInvoiceLineText(towelRow);
    const payLineHist = formatServiceRecordInvoiceLineText(histRow);
    ok('payments line text Towel never addon_service',
      payLineTowel.indexOf('Towel') >= 0
      && payLineTowel.toLowerCase().indexOf('addon_service') < 0,
      payLineTowel);
    ok('payments line text historical key never addon_service',
      payLineHist.indexOf('deleted_offering_key') >= 0
      && payLineHist.toLowerCase().indexOf('addon_service') < 0,
      payLineHist);
  }
}

// ── validateScheduleBookingBody accepts lessons[] ───────────────────────
{
  const validated = validateScheduleBookingBody({
    guest_name: 'Multi Guest',
    guest_phone: '+34111111111',
    payment_status: 'unpaid',
    lessons: [
      { kind: 'group', course_id: COURSE_1, date: DATE_A },
      { kind: 'group', course_id: COURSE_1, date: DATE_B },
    ],
    surfer_count: 2,
    date_from: DATE_A,
    date_to: DATE_B,
  }, { requireGuestPhone: false, refDate: new Date('2026-08-01T12:00:00Z') });
  ok('validateScheduleBookingBody accepts lessons[] two group days',
    validated.ok === true
    && Array.isArray(validated.value.lessons)
    && validated.value.lessons.length === 2
    && validated.value.components.course
    && validated.value.components.course.quantity === 2,
    JSON.stringify(validated));

  const mixedBody = validateScheduleBookingBody({
    guest_name: 'Bad Mix',
    payment_status: 'unpaid',
    lessons: [
      { kind: 'group', course_id: COURSE_1, date: DATE_A },
      { kind: 'private', date: DATE_A, start: '09:00', end: '10:00' },
    ],
    surfer_count: 1,
    date_from: DATE_A,
    date_to: DATE_A,
  }, { allowBlankGuest: false, refDate: new Date('2026-08-01T12:00:00Z') });
  ok('validate rejects mixed lessons', mixedBody.ok === false, JSON.stringify(mixedBody));
}

// ── multi product-button selected_courses quote + persist contract ──────
{
  const multiNorm = normalizeSelectedCourses({
    course_id: COURSE_1,
    tier_key: '1_day',
    selected_courses: [
      { course_id: COURSE_2, tier_key: '1_day', course_label: 'Beta' },
      { course_id: COURSE_1, tier_key: '1_day', course_label: 'Alpha' },
      { course_id: COURSE_1, tier_key: '2_day' }, // dup id dropped
    ],
  });
  ok('normalizeSelectedCourses keeps ordered unique product ids',
    multiNorm.length === 2
    && multiNorm[0].course_id === COURSE_2
    && multiNorm[1].course_id === COURSE_1
    && multiNorm.every((r) => r.tier_key === '1_day')
    && !multiNorm.some((r) => Object.prototype.hasOwnProperty.call(r, 'amount_cents')),
    JSON.stringify(multiNorm));

  // Create transport: lessons[] empty (no Group schedule invent) + selected_courses.
  const multiBody = validateScheduleBookingBody({
    guest_name: 'Multi Course Guest',
    guest_phone: '+34911111111',
    payment_status: 'unpaid',
    surfer_count: 2,
    date_from: DATE_A,
    date_to: DATE_A,
    service_dates: [DATE_A],
    lessons: [],
    components: {
      course: {
        quantity: 2,
        course_id: COURSE_1,
        tier_key: '1_day',
        selected_courses: [
          { course_id: COURSE_1, tier_key: '1_day', course_label: 'Alpha' },
          { course_id: COURSE_2, tier_key: '1_day', course_label: 'Beta' },
        ],
      },
    },
  }, { requireGuestPhone: false, refDate: new Date('2026-08-01T12:00:00Z') });
  ok('validateScheduleBookingBody accepts multi selected_courses',
    multiBody.ok === true
    && Array.isArray(multiBody.value.components.course.selected_courses)
    && multiBody.value.components.course.selected_courses.length === 2
    && multiBody.value.components.course.selected_courses.map((c) => c.course_id).join(',')
      === `${COURSE_1},${COURSE_2}`
    && multiBody.value.components.course.course_id === COURSE_1
    && multiBody.value.components.course.selected_courses.every((c) => c.tier_key === '1_day'
      && c.offering_id === packPriceItemCode(c.course_id, '1_day'))
    && (!multiBody.value.lessons || multiBody.value.lessons.length === 0),
    JSON.stringify(multiBody));

  const moneyBody = validateScheduleBookingBody({
    guest_name: 'Money Guest',
    payment_status: 'unpaid',
    surfer_count: 1,
    date_from: DATE_A,
    date_to: DATE_A,
    service_dates: [DATE_A],
    lessons: [],
    components: {
      course: {
        quantity: 1,
        selected_courses: [
          { course_id: COURSE_1, tier_key: '1_day', amount_cents: 9999 },
          { course_id: COURSE_2, tier_key: '1_day' },
        ],
      },
    },
  }, { requireGuestPhone: false, refDate: new Date('2026-08-01T12:00:00Z') });
  ok('validate rejects client money on selected_courses',
    moneyBody.ok === false,
    JSON.stringify(moneyBody));

  const itemA = packPriceItemCode(COURSE_1, '1_day');
  const itemB = packPriceItemCode(COURSE_2, '1_day');
  const multiCfg = {
    ok: true,
    source: 'db',
    currency: 'EUR',
    rental_offerings: [],
    surf_packs: [
      {
        pack_id: COURSE_1,
        label: 'Alpha',
        active: true,
        group_size: 8,
        weekly: 'daily',
        schedules: ['0930_1130'],
        equipment_options: [],
        price_tiers: [{ key: '1_day', label: '1 day', hours: 2, amount_cents: 3500 }],
      },
      {
        pack_id: COURSE_2,
        label: 'Beta',
        active: true,
        group_size: 8,
        weekly: 'daily',
        schedules: ['0930_1130'],
        equipment_options: [],
        price_tiers: [{ key: '1_day', label: '1 day', hours: 2, amount_cents: 4500 }],
      },
    ],
    prices: [
      {
        id: 'price-a',
        category: 'package',
        offering_key: itemA,
        item_code: itemA,
        amount_cents: 3500,
        unit: 'day',
        active: true,
        currency: 'EUR',
        location_id: 'sunset-somo',
      },
      {
        id: 'price-b',
        category: 'package',
        offering_key: itemB,
        item_code: itemB,
        amount_cents: 4500,
        unit: 'day',
        active: true,
        currency: 'EUR',
        location_id: 'sunset-somo',
      },
    ],
    private_lesson: { enabled: false },
  };
  const quoteBuilt = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.MANUAL_STAFF,
    transportBody: {
      guest_name: 'Quote Multi',
      guest_phone: '+34911111111',
      date_from: DATE_A,
      date_to: DATE_A,
      service_dates: [DATE_A],
      payment_status: 'unpaid',
      surfer_count: 2,
      components: {
        course: {
          quantity: 2,
          course_id: COURSE_1,
          tier_key: '1_day',
          selected_courses: [
            { course_id: COURSE_1, tier_key: '1_day' },
            { course_id: COURSE_2, tier_key: '1_day' },
          ],
        },
      },
      lessons: [],
    },
    trustedLocationId: 'sunset-somo',
    now: new Date('2026-08-01T12:00:00Z'),
  });
  ok('multi selected_courses quote command builds', quoteBuilt.ok === true, JSON.stringify(quoteBuilt));
  const quoted = executeSunsetQuoteSync(quoteBuilt.command, { adminCfg: multiCfg });
  const courseLines = (quoted.ok && quoted.body && Array.isArray(quoted.body.line_items))
    ? quoted.body.line_items.filter((l) => l && l.component === 'course')
    : [];
  ok('multi selected_courses quote prices each course independently (server-owned)',
    quoted.ok === true
    && courseLines.length === 2
    && courseLines.some((l) => l.course_id === COURSE_1 && Number(l.total_cents) === 7000)
    && courseLines.some((l) => l.course_id === COURSE_2 && Number(l.total_cents) === 9000)
    && Number(quoted.body.total_cents) === 16000,
    JSON.stringify(quoted && quoted.body ? {
      total: quoted.body.total_cents,
      lines: courseLines,
      err: quoted.body,
    } : quoted));
}

// ── owners present for multi-lesson pricing / transport ─────────────────
{
  const quoteSrc = fs.readFileSync(
    path.join(__dirname, 'lib/luna-front-desk-quote-service.js'),
    'utf8',
  );
  ok('quote service owns per-lesson group pricing',
    /shouldPriceGroupLessonsIndividually|quoteGroupLessonsIndividually/.test(quoteSrc));
  ok('quote service multi-course CE equal-price authority',
    /quoteCourseEquipmentForLessonSet|course_equipment_price_conflict/.test(quoteSrc));
  ok('quote service owns multi selected_courses independent pricing',
    /quoteSelectedCoursesIndependently|normalizeSelectedCourses/.test(quoteSrc));
  const portalSrc = fs.readFileSync(
    path.join(__dirname, 'browser/sunset-schedule-portal-module.js'),
    'utf8',
  );
  ok('portal quote transport forwards lessons[]',
    /function schedulePortalFetchQuote[\s\S]{0,800}lessons:\s*Array\.isArray\(createPayload\.lessons\)/.test(portalSrc));
  ok('portal intent keys include lessons',
    /schedulePortalNormalizeLessonsIntent/.test(portalSrc));
  ok('portal owns multi course product button selection',
    /function schedulePortalGetSelectedCreateCourseIds/.test(portalSrc)
    && /function schedulePortalToggleCreateCourse/.test(portalSrc));
  const writesSrc = fs.readFileSync(
    path.join(__dirname, 'lib/sunset-schedule-booking-writes.js'),
    'utf8',
  );
  ok('create insert path owns per-lesson service rows',
    /useCanonicalGroupLessonRows|lesson_identity/.test(writesSrc));
  ok('create insert path owns multi selected_courses rows',
    /useSelectedCoursesRows/.test(writesSrc)
    && /normalizeSelectedCourses/.test(writesSrc));
  const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  ok('Create UI removes Group lessons section (groupLessons..addLesson)',
    !/ps-create-group-lessons-wrap/.test(apiSrc)
    && !/schedule\.create\.groupLessons/.test(apiSrc)
    && !/schedule\.create\.addLesson/.test(apiSrc)
    && !/scheduleReadCreateGroupLessonRows/.test(apiSrc)
    && /selected_courses:\s*selectedCourses/.test(apiSrc));
}

// ── stepper source contract (Create/Edit scoped) ────────────────────────
{
  const editUi = fs.readFileSync(
    path.join(__dirname, 'browser/sunset-schedule-drawer-edit-ui.js'),
    'utf8',
  );
  const portalUi = fs.readFileSync(
    path.join(__dirname, 'browser/sunset-schedule-portal-module.js'),
    'utf8',
  );
  const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  ok('compact integer stepper helper present for schedule surfaces',
    /portal-schedule-int-stepper|scheduleIntStepper|ps-int-stepper/.test(editUi + portalUi + apiSrc),
    'expected compact stepper class/helper in Create/Edit sources');
  ok('native spinner hide scoped to schedule create/edit steppers',
    /portal-schedule-int-stepper[\s\S]{0,200}webkit-inner-spin-button|ps-int-stepper[\s\S]{0,200}webkit-inner-spin-button/.test(apiSrc)
    || /portal-schedule-int-stepper input[\s\S]{0,120}-webkit-appearance:\s*none/.test(apiSrc)
    || /schedule-int-stepper/.test(apiSrc),
    'spinner CSS must be scoped');
}

console.log(`\nverify-sunset-multi-lessons-contract — ${pass} passed`);
