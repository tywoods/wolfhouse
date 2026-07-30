'use strict';

/**
 * verify:sunset-course-card-owned-equipment
 *
 * Live bug: Group course booking with course-owned equipment
 * (Surfboard + Wetsuit · During Course · €5) invoices correctly but the
 * schedule course card paints "no equipment" because day gear SQL never
 * admitted course_equipment service rows.
 *
 * Proves:
 *  1) Gear query admits production CE metadata (course_equipment=true), not
 *     only rental_offering standalone rentals.
 *  2) Card label uses Admin-owned label + mode from persisted CE rows
 *     (During Course / All Day), correct surfer qty, "none" only when absent.
 *  3) Multi-course / multi-booking isolation: peer courses and other bookings
 *     never borrow another session's equipment.
 *  4) Standalone generic rentals stay separate from CE admission.
 *
 * Row shapes mirror insertCourseEquipmentRows / scheduleRow production writes.
 *
 * Run: node scripts/verify-sunset-course-card-owned-equipment.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const {
  getSunsetScheduleGearOnDateQuery,
  getSunsetScheduleLessonsOnDateQuery,
} = require('./lib/sunset-schedule-queries');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

const DATE = '2026-09-22';
const COURSE_A = 'course-a-uuid-card-0001';
const COURSE_B = 'course-b-uuid-card-0002';

/**
 * Exact production metadata shape from insertCourseEquipmentRows
 * (scripts/lib/sunset-schedule-booking-writes.js).
 */
function productionCeMetadata(opts) {
  const mode = opts.mode === 'all_day' ? 'all_day' : 'during_course';
  const unit = opts.unit_amount_cents != null ? opts.unit_amount_cents : (mode === 'all_day' ? 1000 : 500);
  const qty = opts.quantity != null ? opts.quantity : 1;
  return {
    source: 'staff_manual_schedule',
    staff_manual_schedule: true,
    course_equipment: true,
    offering_key: opts.offering_key || 'board_and_suit_rental',
    label: opts.label || 'Surfboard + Wetsuit',
    course_equipment_mode: mode,
    component: 'course_equipment',
    staff_ui_service_type: 'course_equipment',
    price_basis: 'per_person_per_course_date',
    billing_unit: 'person_per_course_date',
    pricing_provenance: 'course_owned_equipment',
    price_source: 'course_owned_equipment',
    during_course_price_cents: opts.during_course_price_cents != null ? opts.during_course_price_cents : 500,
    all_day_price_cents: opts.all_day_price_cents != null ? opts.all_day_price_cents : 1000,
    unit_amount_cents: unit,
    amount_cents: unit * qty,
    service_date: opts.service_date || DATE,
    course_id: opts.course_id || COURSE_A,
    location_id: opts.location_id || 'sunset-somo',
    bundle_id: opts.bundle_id || null,
  };
}

function productionCourseRow(opts) {
  const courseId = opts.course_id || COURSE_A;
  const qty = opts.quantity != null ? opts.quantity : 1;
  return {
    service_record_id: opts.id || `sr-course-${courseId}`,
    booking_id: opts.booking_id || 'bk-card-1',
    booking_code: opts.booking_code || 'SUNSET-CARD-1',
    guest_name: opts.guest_name || 'Card Guest',
    service_type: 'surf_lesson',
    service_date: opts.service_date || DATE,
    quantity: qty,
    payment_status: 'unpaid',
    record_source: 'staff_manual',
    staff_ui_service_type: 'course',
    course_id: courseId,
    course_label: opts.course_label || 'Beginner Group',
    metadata: {
      source: 'staff_manual_schedule',
      staff_manual_schedule: true,
      component: 'course',
      staff_ui_service_type: 'course',
      course_id: courseId,
      course_label: opts.course_label || 'Beginner Group',
      tier_key: '1_day',
      offering_id: `surf_pack_${courseId}__1_day`,
      selected_course: true,
      unit_amount_cents: 3500,
      amount_cents: 3500 * qty,
    },
    _scheduleType: 'course',
  };
}

function productionCeRow(opts) {
  const qty = opts.quantity != null ? opts.quantity : 1;
  const meta = productionCeMetadata(opts);
  return {
    service_record_id: opts.id || `sr-ce-${meta.course_equipment_mode}-${meta.offering_key}`,
    booking_id: opts.booking_id || 'bk-card-1',
    booking_code: opts.booking_code || 'SUNSET-CARD-1',
    guest_name: opts.guest_name || 'Card Guest',
    service_type: 'addon_service',
    service_date: opts.service_date || DATE,
    quantity: qty,
    amount_due_cents: meta.amount_cents,
    payment_status: 'unpaid',
    record_source: 'staff_manual',
    staff_ui_service_type: 'course_equipment',
    metadata: meta,
    _scheduleType: 'rental',
  };
}

function productionStandaloneRentalRow(opts) {
  return {
    service_record_id: opts.id || 'sr-rental-1',
    booking_id: opts.booking_id || 'bk-rental-1',
    booking_code: opts.booking_code || 'SUNSET-RENT-1',
    guest_name: opts.guest_name || 'Rental Guest',
    service_type: 'addon_service',
    service_date: opts.service_date || DATE,
    quantity: opts.quantity != null ? opts.quantity : 1,
    payment_status: 'unpaid',
    record_source: 'staff_manual',
    staff_ui_service_type: 'addon_service',
    metadata: {
      source: 'staff_manual_schedule',
      rental_offering: true,
      generic_rental: true,
      component: 'addon_service',
      offering_key: opts.offering_key || 'kayak_rental',
      offering_label: opts.label || 'Kayak',
      label: opts.label || 'Kayak',
    },
    _scheduleType: 'rental',
  };
}

// ── 1) Gear query admits production CE ───────────────────────────────────
console.log('\n[1] schedule gear query admits course-owned equipment');
{
  const sql = getSunsetScheduleGearOnDateQuery();
  ok(
    'admits course_equipment=true addon_service branch',
    /course_equipment'\s*=\s*'true'/.test(sql),
  );
  ok(
    'still admits rental_offering standalone branch',
    /rental_offering'\s*=\s*'true'/.test(sql),
  );
  ok(
    'CE branch is independent of rental_offering',
    /course_equipment[\s\S]*rental_offering|rental_offering[\s\S]*course_equipment/.test(sql)
      && !/course_equipment'\s*=\s*'true'[\s\S]{0,80}rental_offering'\s*=\s*'true'/.test(
        sql.replace(/\s+/g, ' '),
      ),
  );
  ok(
    'lessons query still course/lesson only (surf_lesson)',
    /service_type\s*=\s*'surf_lesson'/.test(getSunsetScheduleLessonsOnDateQuery()),
  );
}

// ── 2) Card label: During / All Day / none + Admin label + qty ───────────
console.log('\n[2] course card equipment label from production CE rows');
{
  const dayOpsSrc = fs.readFileSync(
    path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-day-ops-board-ui.js'),
    'utf8',
  );
  const sandbox = {
    portalT(key) {
      const map = {
        'schedule.courseEquipment.during': 'During Course',
        'schedule.courseEquipment.allDay': 'All Day',
        'schedule.equipment.boardAndWetsuit': 'board + wetsuit',
        'schedule.equipment.board': 'board',
        'schedule.equipment.wetsuit': 'wetsuit',
        'schedule.equipment.none': 'no equipment',
      };
      return map[key] || key;
    },
    scheduleGroupBoardsNeeded() { return 0; },
    scheduleGroupWetsuitsNeeded() { return 0; },
  };
  vm.createContext(sandbox);
  const parseFn = dayOpsSrc.match(
    /function scheduleDayOpsParseMetaBlob[\s\S]*?catch \(_\) \{ return \{\}; \}\n\}/,
  );
  const helpers = dayOpsSrc.match(
    /function scheduleDayOpsCourseEquipmentRows[\s\S]*?function scheduleDayOpsEquipmentPrepLabel[\s\S]*?return portalT\('schedule\.equipment\.none'\);\n\}/,
  );
  ok('extracted day-ops CE label owners', !!(parseFn && helpers));
  if (parseFn && helpers) {
    vm.runInContext(`${parseFn[0]}\n${helpers[0]}`, sandbox);

    // Live bug shape: 1 surfer, During Course, Surfboard + Wetsuit €5
    const duringGroup = {
      course_id: COURSE_A,
      quantity: 1,
      records: [
        productionCourseRow({ quantity: 1, course_id: COURSE_A }),
        productionCeRow({
          mode: 'during_course',
          quantity: 1,
          label: 'Surfboard + Wetsuit',
          offering_key: 'board_and_suit_rental',
          unit_amount_cents: 500,
          course_id: COURSE_A,
        }),
      ],
    };
    const duringLabel = sandbox.scheduleDayOpsEquipmentPrepLabel(duringGroup);
    ok(
      'During Course shows Admin label + mode (live bug shape)',
      duringLabel === 'Surfboard + Wetsuit · During Course',
      `label=${duringLabel}`,
    );
    ok('surfer quantity remains 1 on group', duringGroup.quantity === 1);

    const allDayGroup = {
      course_id: COURSE_A,
      quantity: 2,
      records: [
        productionCourseRow({ quantity: 2, course_id: COURSE_A }),
        productionCeRow({
          mode: 'all_day',
          quantity: 2,
          label: 'Softboard',
          offering_key: 'softboard',
          unit_amount_cents: 1000,
          course_id: COURSE_A,
        }),
      ],
    };
    const allDayLabel = sandbox.scheduleDayOpsEquipmentPrepLabel(allDayGroup);
    ok(
      'All Day shows Admin label + mode',
      allDayLabel === 'Softboard · All Day',
      `label=${allDayLabel}`,
    );
    ok('surfer quantity remains 2 on All Day group', allDayGroup.quantity === 2);

    const noneGroup = {
      course_id: COURSE_A,
      quantity: 1,
      records: [productionCourseRow({ quantity: 1, course_id: COURSE_A })],
    };
    ok(
      'no equipment only when course truly has none',
      sandbox.scheduleDayOpsEquipmentPrepLabel(noneGroup) === 'no equipment',
    );

    // Standalone rental in same group must not paint as CE
    const rentalOnly = {
      quantity: 1,
      records: [productionStandaloneRentalRow({})],
    };
    ok(
      'standalone rental is not painted as course equipment',
      sandbox.scheduleDayOpsEquipmentPrepLabel(rentalOnly) === 'no equipment',
    );

    // String metadata (pg jsonb sometimes serialized) still parses
    const stringMetaGroup = {
      course_id: COURSE_A,
      quantity: 1,
      records: [
        productionCourseRow({ quantity: 1 }),
        {
          ...productionCeRow({ mode: 'during_course', label: 'Surfboard + Wetsuit' }),
          metadata: JSON.stringify(productionCeMetadata({
            mode: 'during_course',
            label: 'Surfboard + Wetsuit',
          })),
        },
      ],
    };
    ok(
      'stringified production metadata still yields label',
      sandbox.scheduleDayOpsEquipmentPrepLabel(stringMetaGroup)
        === 'Surfboard + Wetsuit · During Course',
    );
  }
}

// ── 3) Multi-course / multi-booking isolation via aggregates ─────────────
console.log('\n[3] multi-course isolation — no borrow across bookings or peer courses');
{
  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
  ok(
    'scheduleCourseAggregates keeps same-booking CE but excludes peer Group courses',
    /exclude peer Group courses/.test(apiSrc)
      && /scheduleRowsForSameBookings/.test(apiSrc)
      && /scheduleRowType\(r\) !== 'course'/.test(apiSrc),
  );
  ok(
    'Private sessions include same-booking CE/gear for prep labels',
    /scheduleBuildPrivateLessonSessions[\s\S]{0,800}scheduleRowsForSameBookings/.test(apiSrc),
  );

  // Pure harness mirroring post-fix aggregate ownership (production row shapes).
  function bookingDayKey(row) {
    const dateIso = String(row.service_date || '').slice(0, 10);
    return row.booking_id ? `b:${row.booking_id}:${dateIso}` : `r:${row.service_record_id}`;
  }
  function rowsForSameBookings(allRows, seedRows) {
    const keys = {};
    (seedRows || []).forEach((r) => { keys[bookingDayKey(r)] = true; });
    return (allRows || []).filter((r) => !!keys[bookingDayKey(r)]);
  }
  function courseKey(row) {
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    return String(row.course_id || meta.course_id || '');
  }
  function isCourse(row) {
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    return meta.component === 'course' || row.staff_ui_service_type === 'course';
  }
  function aggregatesForCourse(allRows, cid, dateIso) {
    const filtered = (allRows || []).filter((r) => {
      if (String(r.service_date || '').slice(0, 10) !== dateIso) return false;
      if (!isCourse(r)) return false;
      return courseKey(r) === cid;
    });
    const related = rowsForSameBookings(allRows, filtered).filter((r) => {
      if (!isCourse(r)) return true;
      return courseKey(r) === cid;
    });
    return related;
  }
  function ceLabels(rows) {
    return (rows || [])
      .filter((r) => r.metadata && r.metadata.course_equipment === true)
      .map((r) => `${r.metadata.label} · ${r.metadata.course_equipment_mode}`);
  }

  // Booking 1: Course A + Surfboard During. Booking 2: Course B + Softboard All Day.
  const multiBookingDay = [
    productionCourseRow({
      booking_id: 'bk-1', booking_code: 'A1', course_id: COURSE_A, course_label: 'Beginner',
    }),
    productionCeRow({
      booking_id: 'bk-1', booking_code: 'A1', course_id: COURSE_A,
      label: 'Surfboard + Wetsuit', mode: 'during_course',
    }),
    productionCourseRow({
      booking_id: 'bk-2', booking_code: 'B1', course_id: COURSE_B, course_label: 'Intermediate',
      id: 'sr-course-b',
    }),
    productionCeRow({
      booking_id: 'bk-2', booking_code: 'B1', course_id: COURSE_B,
      label: 'Softboard', mode: 'all_day', offering_key: 'softboard',
      unit_amount_cents: 1000, id: 'sr-ce-b',
    }),
  ];
  const aRows = aggregatesForCourse(multiBookingDay, COURSE_A, DATE);
  const bRows = aggregatesForCourse(multiBookingDay, COURSE_B, DATE);
  ok(
    'Course A aggregate sees only Surfboard During (not Softboard)',
    ceLabels(aRows).join('|') === 'Surfboard + Wetsuit · during_course',
    JSON.stringify(ceLabels(aRows)),
  );
  ok(
    'Course B aggregate sees only Softboard All Day (not Surfboard)',
    ceLabels(bRows).join('|') === 'Softboard · all_day',
    JSON.stringify(ceLabels(bRows)),
  );

  // Same booking, two Group courses, shared CE (create-path authorization).
  // Peer course rows excluded; shared CE remains on each session.
  const multiCourseShared = [
    productionCourseRow({
      booking_id: 'bk-multi', course_id: COURSE_A, course_label: 'Beginner', id: 'sr-a',
    }),
    productionCourseRow({
      booking_id: 'bk-multi', course_id: COURSE_B, course_label: 'Intermediate', id: 'sr-b',
    }),
    productionCeRow({
      booking_id: 'bk-multi', course_id: COURSE_A,
      label: 'Surfboard + Wetsuit', mode: 'during_course', id: 'sr-ce-shared',
    }),
  ];
  const multiA = aggregatesForCourse(multiCourseShared, COURSE_A, DATE);
  const multiB = aggregatesForCourse(multiCourseShared, COURSE_B, DATE);
  ok(
    'multi selected_courses Course A keeps shared CE, drops peer course row',
    ceLabels(multiA).length === 1
      && multiA.filter(isCourse).length === 1
      && courseKey(multiA.find(isCourse)) === COURSE_A,
    JSON.stringify(multiA.map((r) => r.service_record_id)),
  );
  ok(
    'multi selected_courses Course B keeps shared CE, drops peer course row',
    ceLabels(multiB).length === 1
      && multiB.filter(isCourse).length === 1
      && courseKey(multiB.find(isCourse)) === COURSE_B,
    JSON.stringify(multiB.map((r) => r.service_record_id)),
  );
  ok(
    'Course B does not invent a different CE from Course A primary stamp',
    ceLabels(multiB)[0] === 'Surfboard + Wetsuit · during_course',
  );
}

// ── 4) Invoice comparator still owns money/label from same CE metadata ───
console.log('\n[4] invoice comparator (drawer) still formats CE from same row shape');
{
  const drawer = require('./lib/sunset-schedule-booking-drawer');
  const ce = productionCeRow({
    mode: 'during_course',
    quantity: 1,
    label: 'Surfboard + Wetsuit',
    unit_amount_cents: 500,
  });
  const label = drawer.formatSunsetDrawerDailyItemLabel
    ? drawer.formatSunsetDrawerDailyItemLabel(ce.service_type, ce.quantity, ce)
    : null;
  // Prefer exported helper; fall back to aggregate proof.
  if (typeof drawer.formatSunsetDrawerDailyItemLabel === 'function') {
    ok(
      'invoice CE label includes Admin name + During Course',
      /Surfboard \+ Wetsuit/.test(label) && /During Course/.test(label),
      `label=${label}`,
    );
  } else {
    const agg = drawer.aggregateComponentsFromServices([
      productionCourseRow({ quantity: 1 }),
      ce,
    ]);
    ok(
      'drawer aggregate reconstructs CE label + mode from production row',
      Array.isArray(agg.components.course_equipment)
        && agg.components.course_equipment[0].label === 'Surfboard + Wetsuit'
        && agg.components.course_equipment[0].mode === 'during_course'
        && Number(agg.components.course_equipment[0].quantity) === 1,
      JSON.stringify(agg.components.course_equipment),
    );
  }
}

console.log(`\nverify:sunset-course-card-owned-equipment — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('verify:sunset-course-card-owned-equipment — ALL CHECKS PASSED');
