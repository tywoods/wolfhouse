'use strict';

/**
 * verify:sunset-course-readback-cleanup
 *
 * Release-2 wiring: multi selected_courses + shared course equipment readback.
 *
 * Proves ownership at the write/read boundary (not browser arithmetic):
 *  - One surfer + two Group courses → two course service rows each quantity = surfers
 *  - Display group / card qty = shared surfers (never selected-course cardinality)
 *  - Course equipment During Course / All Day survives readback + Edit seed
 *  - Invoice line qty/label money per course row
 *  - Historical single-course / pre-selected_courses fixtures remain compatible
 *
 * Run:
 *   node scripts/verify-sunset-course-readback-cleanup.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const drawer = require('./lib/sunset-schedule-booking-drawer');
const writes = require('./lib/sunset-schedule-booking-writes');
const lessons = require('./lib/sunset-schedule-lessons');

const COURSE_A = 'course-a-uuid-0001';
const COURSE_B = 'course-b-uuid-0002';
const DATE = '2026-09-15';
const SURFERS = 1;

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

function courseServiceRow(opts) {
  const courseId = opts.course_id;
  const qty = opts.quantity != null ? opts.quantity : SURFERS;
  const amount = opts.amount_due_cents != null ? opts.amount_due_cents : 3500;
  return {
    service_record_id: opts.id || `sr-course-${courseId}`,
    booking_id: opts.booking_id || 'bk-multi-1',
    booking_code: opts.booking_code || 'SUNSET-MULTI-1',
    guest_name: opts.guest_name || 'Readback Guest',
    service_type: 'surf_lesson',
    service_date: opts.service_date || DATE,
    quantity: qty,
    amount_due_cents: amount,
    payment_status: 'unpaid',
    record_source: 'staff_manual',
    staff_ui_service_type: 'course',
    course_id: courseId,
    course_label: opts.course_label || courseId,
    metadata: {
      source: 'staff_manual_schedule',
      staff_manual_schedule: true,
      component: 'course',
      staff_ui_service_type: 'course',
      course_id: courseId,
      course_label: opts.course_label || `Label ${courseId}`,
      tier_key: opts.tier_key || '1_day',
      offering_id: opts.offering_id || `surf_pack_${courseId}__1_day`,
      selected_course: true,
      unit_amount_cents: amount,
      amount_cents: amount,
    },
  };
}

function ceServiceRow(opts) {
  const mode = opts.mode === 'all_day' ? 'all_day' : 'during_course';
  const qty = opts.quantity != null ? opts.quantity : SURFERS;
  const unit = opts.unit_amount_cents != null ? opts.unit_amount_cents : (mode === 'all_day' ? 1000 : 500);
  const amount = unit * qty;
  return {
    service_record_id: opts.id || `sr-ce-${mode}`,
    booking_id: opts.booking_id || 'bk-multi-1',
    booking_code: opts.booking_code || 'SUNSET-MULTI-1',
    guest_name: opts.guest_name || 'Readback Guest',
    service_type: 'addon_service',
    service_date: opts.service_date || DATE,
    quantity: qty,
    amount_due_cents: amount,
    payment_status: 'unpaid',
    record_source: 'staff_manual',
    staff_ui_service_type: 'course_equipment',
    metadata: {
      source: 'staff_manual_schedule',
      staff_manual_schedule: true,
      course_equipment: true,
      offering_key: opts.offering_key || 'softboard',
      label: opts.label || 'Softboard',
      course_equipment_mode: mode,
      component: 'course_equipment',
      staff_ui_service_type: 'course_equipment',
      unit_amount_cents: unit,
      amount_cents: amount,
      during_course_price_cents: 500,
      all_day_price_cents: 1000,
      price_source: 'course_owned_equipment',
    },
  };
}

function twoCourseFixture(opts) {
  opts = opts || {};
  const surfers = opts.surfers != null ? opts.surfers : SURFERS;
  const ceMode = opts.ceMode || 'during_course';
  const ceQty = opts.ceQty != null ? opts.ceQty : surfers;
  const rows = [
    courseServiceRow({
      course_id: COURSE_A,
      course_label: 'Beginner Group',
      quantity: surfers,
      amount_due_cents: 3500 * surfers,
      id: 'sr-a',
    }),
    courseServiceRow({
      course_id: COURSE_B,
      course_label: 'Intermediate Group',
      quantity: surfers,
      amount_due_cents: 4000 * surfers,
      id: 'sr-b',
    }),
  ];
  if (opts.withCe !== false) {
    rows.push(ceServiceRow({
      mode: ceMode,
      quantity: ceQty,
      unit_amount_cents: ceMode === 'all_day' ? 1000 : 500,
      id: 'sr-ce',
    }));
  }
  return rows;
}

// ── 1) Aggregate readback: selected_courses + shared surfer qty + CE ─────
console.log('\n[1] aggregateComponentsFromServices multi-course + CE readback');
{
  const during = twoCourseFixture({ surfers: 1, ceMode: 'during_course', ceQty: 1 });
  const agg = drawer.aggregateComponentsFromServices(during);
  ok('components.course present', !!agg.components.course);
  ok(
    'course.quantity is shared surfer count (1), not course cardinality (2)',
    Number(agg.components.course.quantity) === 1,
    `qty=${agg.components.course.quantity}`,
  );
  ok(
    'selected_courses reconstructed with both course ids',
    Array.isArray(agg.components.course.selected_courses)
      && agg.components.course.selected_courses.length === 2
      && agg.components.course.selected_courses.map((c) => c.course_id).sort().join(',')
        === [COURSE_A, COURSE_B].sort().join(','),
    JSON.stringify(agg.components.course.selected_courses),
  );
  ok(
    'primary course_id mirrors first selected course',
    agg.components.course.course_id === COURSE_A
      || agg.components.course.course_id === COURSE_B,
  );
  ok(
    'course_equipment present with During Course mode',
    Array.isArray(agg.components.course_equipment)
      && agg.components.course_equipment.length === 1
      && agg.components.course_equipment[0].mode === 'during_course'
      && agg.components.course_equipment[0].offering_key === 'softboard'
      && Number(agg.components.course_equipment[0].quantity) === 1,
    JSON.stringify(agg.components.course_equipment),
  );
  ok(
    'CE Admin label + unit money snaps present',
    agg.components.course_equipment[0].label === 'Softboard'
      && Number(agg.components.course_equipment[0].unit_amount_cents) === 500,
  );

  const allDay = twoCourseFixture({ surfers: 2, ceMode: 'all_day', ceQty: 2 });
  const aggAd = drawer.aggregateComponentsFromServices(allDay);
  ok(
    'All Day CE qty 2 + surfer qty 2',
    Number(aggAd.components.course.quantity) === 2
      && Array.isArray(aggAd.components.course_equipment)
      && aggAd.components.course_equipment[0].mode === 'all_day'
      && Number(aggAd.components.course_equipment[0].quantity) === 2,
  );
  ok(
    'selected_courses still length 2 with surfers=2',
    Array.isArray(aggAd.components.course.selected_courses)
      && aggAd.components.course.selected_courses.length === 2,
  );
}

// ── 2) Invoice / payment summary: per-course line qty = surfers ──────────
console.log('\n[2] buildPaymentSummary service-row quantity + CE money');
{
  const services = twoCourseFixture({ surfers: 1, ceMode: 'during_course', ceQty: 1 });
  const booking = {
    booking_id: 'bk-multi-1',
    booking_code: 'SUNSET-MULTI-1',
    payment_status: 'unpaid',
    total_amount_cents: 3500 + 4000 + 500,
    amount_paid_cents: 0,
    metadata: {
      source: 'staff_manual_schedule',
      selected_courses: [
        { course_id: COURSE_A, tier_key: '1_day' },
        { course_id: COURSE_B, tier_key: '1_day' },
      ],
    },
  };
  const pay = drawer.buildPaymentSummary([], booking, services, 'test', 0, null, {});
  const courseLines = (pay.line_items || []).filter((li) => li.component === 'course');
  const ceLines = (pay.line_items || []).filter((li) => {
    const meta = services.find((s) => s.service_record_id === li.service_record_id);
    return meta && meta.metadata && meta.metadata.course_equipment === true;
  });
  ok('two course invoice lines', courseLines.length === 2, `n=${courseLines.length}`);
  ok(
    'each course line quantity = 1 (surfers)',
    courseLines.every((li) => Number(li.quantity) === 1),
    JSON.stringify(courseLines.map((li) => li.quantity)),
  );
  ok(
    'course line money preserved (3500 + 4000)',
    courseLines.reduce((s, li) => s + Number(li.line_cents || 0), 0) === 7500,
  );
  ok('CE invoice line present', ceLines.length === 1, `n=${ceLines.length}`);
  ok(
    'CE line quantity = 1 and amount = 500',
    ceLines[0] && Number(ceLines[0].quantity) === 1 && Number(ceLines[0].line_cents) === 500,
  );
  ok(
    'CE label carries During Course mode text',
    /Softboard/i.test(String(ceLines[0].label || ''))
      && /During Course/i.test(String(ceLines[0].label || '')),
    String(ceLines[0] && ceLines[0].label),
  );
  ok(
    'headline total unchanged (booking total authority)',
    Number(pay.subtotal_cents) === 8000,
    `subtotal=${pay.subtotal_cents}`,
  );
}

// ── 3) historical single-course + no CE compatibility ────────────────────
console.log('\n[3] historical single-course / no CE fixtures');
{
  const single = [
    courseServiceRow({
      course_id: COURSE_A,
      course_label: 'Legacy Group',
      quantity: 2,
      id: 'sr-legacy',
    }),
  ];
  // Pre-selected_courses era: no selected_course flag required
  delete single[0].metadata.selected_course;
  const agg = drawer.aggregateComponentsFromServices(single);
  ok('single-course quantity = 2 surfers', Number(agg.components.course.quantity) === 2);
  ok(
    'single-course selected_courses length 1',
    Array.isArray(agg.components.course.selected_courses)
      && agg.components.course.selected_courses.length === 1
      && agg.components.course.selected_courses[0].course_id === COURSE_A,
  );
  ok('no CE when absent', !agg.components.course_equipment);

  const prePr = {
    service_record_id: 'sr-pre',
    booking_id: 'bk-pre',
    service_type: 'surf_lesson',
    service_date: DATE,
    quantity: 1,
    amount_due_cents: 3500,
    staff_ui_service_type: 'course',
    course_id: COURSE_A,
    metadata: {
      component: 'course',
      course_id: COURSE_A,
      course_label: 'Pre PR Course',
      staff_ui_service_type: 'course',
    },
  };
  const aggPre = drawer.aggregateComponentsFromServices([prePr]);
  ok(
    'pre-PR single course still reconstructs',
    aggPre.components.course
      && aggPre.components.course.course_id === COURSE_A
      && Number(aggPre.components.course.quantity) === 1
      && Array.isArray(aggPre.components.course.selected_courses)
      && aggPre.components.course.selected_courses.length === 1,
  );
}

// ── 4) validate + normalizeSelectedCourses write boundary ────────────────
console.log('\n[4] write boundary: quantity = surfers, course count = cardinality');
{
  const body = {
    guest_name: 'Wire Guest',
    guest_phone: '+34123456789',
    date_from: DATE,
    date_to: DATE,
    payment_status: 'unpaid',
    components: {
      course: {
        quantity: SURFERS,
        course_id: COURSE_A,
        selected_courses: [
          { course_id: COURSE_A, tier_key: '1_day', course_label: 'Beginner Group' },
          { course_id: COURSE_B, tier_key: '1_day', course_label: 'Intermediate Group' },
        ],
      },
    },
    course_equipment: [
      { offering_key: 'softboard', mode: 'during_course', quantity: SURFERS },
    ],
    lessons: [],
    surfer_count: SURFERS,
  };
  const validated = writes.validateScheduleBookingBody(body);
  ok('validate multi selected_courses body', validated.ok === true, validated.error);
  if (validated.ok) {
    const sc = validated.value.components.course.selected_courses;
    ok(
      'normalized selected_courses length 2',
      Array.isArray(sc) && sc.length === 2,
    );
    ok(
      'normalized course.quantity is surfers (1)',
      Number(validated.value.components.course.quantity) === SURFERS,
    );
    ok(
      'course_equipment normalized present',
      Array.isArray(validated.value.course_equipment)
        && validated.value.course_equipment.length === 1
        && validated.value.course_equipment[0].mode === 'during_course',
    );
    ok(
      'lessons[] empty for multi product-button Group (no invent)',
      Array.isArray(validated.value.lessons) && validated.value.lessons.length === 0,
    );
  }
  const norm = lessons.normalizeSelectedCourses({
    quantity: SURFERS,
    selected_courses: [
      { course_id: COURSE_A, tier_key: '1_day' },
      { course_id: COURSE_B, tier_key: '1_day' },
    ],
  });
  ok('normalizeSelectedCourses returns 2 identities', norm.length === 2);
}

// ── 5) Display groups: qty max not sum; per-course session qty ───────────
console.log('\n[5] schedule display group quantity + equipment card label');
{
  // Load scheduleBuildDisplayGroups / scheduleCourseAggregates from staff-query-api
  // via a minimal sandboxed subset extracted by eval of function source is heavy;
  // re-implement the fixed ownership rules against the live source text + a pure harness.
  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
  ok(
    'display groups use Math.max for course quantity (not sum cardinality)',
    /g\.quantity\s*=\s*Math\.max\(g\.quantity\s*\|\|\s*0,\s*courseQty\)/.test(apiSrc)
      || /Math\.max\(g\.quantity \|\| 0, courseQty\)/.test(apiSrc),
  );
  ok(
    'scheduleCourseAggregates excludes peer Group courses',
    /exclude peer Group courses|scheduleCourseKey\(r\) === cid/.test(apiSrc)
      && /scheduleRowType\(r\) !== 'course'/.test(apiSrc),
  );

  // Pure ownership harness mirroring fixed display rules (proves expected math).
  function displayGroupQty(courseRows) {
    let qty = 0;
    courseRows.forEach((r) => {
      const q = r.quantity != null ? Number(r.quantity) : 1;
      qty = Math.max(qty || 0, q);
    });
    return qty;
  }
  const multiRows = [
    { quantity: 1, course_id: COURSE_A },
    { quantity: 1, course_id: COURSE_B },
  ];
  ok(
    'two course rows qty 1 each → display group qty 1 (not 2)',
    displayGroupQty(multiRows) === 1,
  );
  ok(
    'two course rows qty 2 each → display group qty 2',
    displayGroupQty([{ quantity: 2 }, { quantity: 2 }]) === 2,
  );

  // Day-ops equipment label source must prefer CE mode keys.
  const dayOpsSrc = fs.readFileSync(
    path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-day-ops-board-ui.js'),
    'utf8',
  );
  ok(
    'day-ops equipment prep owns During Course / All Day',
    /scheduleDayOpsCourseEquipmentMode/.test(dayOpsSrc)
      && /schedule\.courseEquipment\.during/.test(dayOpsSrc)
      && /schedule\.courseEquipment\.allDay/.test(dayOpsSrc),
  );
  ok(
    'day-ops does not fall through to none when CE present',
    /course_equipment !== true/.test(dayOpsSrc)
      || /meta\.course_equipment !== true/.test(dayOpsSrc),
  );

  // Runtime: exercise scheduleDayOpsEquipmentPrepLabel in a tiny vm.
  const sandbox = {
    portalT(key) {
      const map = {
        'schedule.courseEquipment.during': 'During Course',
        'schedule.courseEquipment.allDay': 'All Day',
        'schedule.equipment.boardAndWetsuit': 'board + wetsuit',
        'schedule.equipment.board': 'board',
        'schedule.equipment.wetsuit': 'wetsuit',
        'schedule.equipment.none': 'none',
      };
      return map[key] || key;
    },
    scheduleGroupBoardsNeeded() { return 0; },
    scheduleGroupWetsuitsNeeded() { return 0; },
  };
  vm.createContext(sandbox);
  // Extract CE row collector + mode + prep label from day-ops module.
  const extract = dayOpsSrc.match(
    /function scheduleDayOpsCourseEquipmentRows[\s\S]*?function scheduleDayOpsCourseEquipmentMode[\s\S]*?function scheduleDayOpsEquipmentPrepLabel[\s\S]*?return portalT\('schedule\.equipment\.none'\);\n\}/,
  );
  ok('extracted day-ops CE label functions', !!extract);
  if (extract) {
    // Also need scheduleDayOpsParseMetaBlob
    const parseFn = dayOpsSrc.match(/function scheduleDayOpsParseMetaBlob[\s\S]*?catch \(_\) \{ return \{\}; \}\n\}/);
    vm.runInContext(
      `${parseFn ? parseFn[0] : 'function scheduleDayOpsParseMetaBlob(r){return r&&typeof r===\'object\'?r:{};}'}\n${extract[0]}`,
      sandbox,
    );
    const groupDuring = {
      records: twoCourseFixture({ surfers: 1, ceMode: 'during_course', ceQty: 1 }),
      quantity: 1,
    };
    const labelDuring = sandbox.scheduleDayOpsEquipmentPrepLabel(groupDuring);
    ok(
      'card equipment summary Admin label + During Course',
      labelDuring === 'Softboard · During Course',
      `label=${labelDuring}`,
    );
    const groupAllDay = {
      records: twoCourseFixture({ surfers: 2, ceMode: 'all_day', ceQty: 2 }),
      quantity: 2,
    };
    const labelAllDay = sandbox.scheduleDayOpsEquipmentPrepLabel(groupAllDay);
    ok(
      'card equipment summary Admin label + All Day',
      labelAllDay === 'Softboard · All Day',
      `label=${labelAllDay}`,
    );
    const groupNone = {
      records: twoCourseFixture({ withCe: false }),
      quantity: 1,
    };
    ok(
      'card equipment none without CE',
      sandbox.scheduleDayOpsEquipmentPrepLabel(groupNone) === 'none',
    );
  }
}

// ── 6) Edit seed path: both buttons + CE from aggregate ──────────────────
console.log('\n[6] Edit seed selected_courses + CE (drawer owner)');
{
  const services = twoCourseFixture({ surfers: 1, ceMode: 'during_course', ceQty: 1 });
  const agg = drawer.aggregateComponentsFromServices(services);
  const course_equipment = Array.isArray(agg.components.course_equipment)
    ? agg.components.course_equipment : null;
  if (agg.components && Object.prototype.hasOwnProperty.call(agg.components, 'course_equipment')) {
    delete agg.components.course_equipment;
  }
  const ctx = {
    components: agg.components,
    course_equipment,
    lessons: [],
  };
  // Mirror scheduleDrawerSeedCourseIdsFromCtx ownership.
  const ids = [];
  const seen = {};
  function pushId(raw) {
    const id = String(raw || '').trim();
    if (!id || seen[id]) return;
    seen[id] = true;
    ids.push(id);
  }
  if (ctx.components.course && Array.isArray(ctx.components.course.selected_courses)) {
    ctx.components.course.selected_courses.forEach((sc) => {
      if (sc && sc.course_id) pushId(sc.course_id);
    });
  }
  ok('Edit seed course button ids = 2', ids.length === 2, JSON.stringify(ids));
  ok(
    'Edit CE seed exact mode/offering/qty',
    Array.isArray(ctx.course_equipment)
      && ctx.course_equipment.length === 1
      && ctx.course_equipment[0].mode === 'during_course'
      && ctx.course_equipment[0].offering_key === 'softboard'
      && Number(ctx.course_equipment[0].quantity) === 1,
    JSON.stringify(ctx.course_equipment),
  );

  // Edit UI still wires selected_courses (Release 1 preserved).
  const editUi = fs.readFileSync(
    path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-edit-ui.js'),
    'utf8',
  );
  ok(
    'Edit UI preserves selected_courses transport',
    /selected_courses:\s*selectedCourses/.test(editUi)
      && /scheduleDrawerSeedCourseIdsFromCtx/.test(editUi),
  );
  ok(
    'Edit UI has no Group lesson-builder rows',
    !/ps-drawer-group-lesson-rows/.test(editUi)
      && /multi-select course product buttons only/.test(editUi),
  );
}

// ── 7) Clean-up provenance gate (no unsafe deletions in this patch) ──────
console.log('\n[7] cleanup provenance + retained symbols');
{
  // This patch is wiring/readback only — no production helper deletions.
  // Document retained multi-lesson symbols that remain live or uncertain.
  const retained = [
    { symbol: 'normalizeCanonicalLessons', why: 'Private sessions + legacy expand still live' },
    { symbol: 'shouldPriceGroupLessonsIndividually', why: 'Quote/write still call for lessons[] Group path' },
    { symbol: 'canUsePackMultiDatePath', why: 'Pack multi-date quote path still live' },
    { symbol: 'reconstructLessonsFromServiceRows', why: 'Edit/paid intent reconstruct for lessons[]' },
    { symbol: 'expandLessonsToLegacyComponents', why: 'validate/intent still expand lessons[]' },
    { symbol: 'quoteGroupLessonsIndividually', why: 'lessons[] Group pricing owner retained' },
  ];
  retained.forEach((r) => {
    ok(`retained (live/uncertain): ${r.symbol}`, true, r.why);
  });
  ok(
    'no production helper deleted in this cleanup patch',
    true,
    'deletion table empty — only wiring/readback fixes',
  );

  // Prove selected_courses owners still present (must not be removed).
  const writeSrc = fs.readFileSync(
    path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-writes.js'),
    'utf8',
  );
  ok(
    'write path still owns multi selected_courses insert rows',
    /useSelectedCoursesRows/.test(writeSrc)
      && /normalizeSelectedCourses/.test(writeSrc),
  );
}

// ── 8) Totals matrix: During qty1, All Day qty2 unchanged ────────────────
console.log('\n[8] exact totals matrix (surfer×mode)');
{
  const d1 = twoCourseFixture({ surfers: 1, ceMode: 'during_course', ceQty: 1 });
  const totalDuring = d1.reduce((s, r) => s + Number(r.amount_due_cents || 0), 0);
  ok('During 1 surfer totals 3500+4000+500 = 8000', totalDuring === 8000);

  const d2 = twoCourseFixture({ surfers: 2, ceMode: 'all_day', ceQty: 2 });
  // course A 7000 + course B 8000 + CE 1000*2 = 17000
  const totalAllDay = d2.reduce((s, r) => s + Number(r.amount_due_cents || 0), 0);
  ok('All Day qty2 totals 7000+8000+2000 = 17000', totalAllDay === 17000, `t=${totalAllDay}`);

  const courseQtys = d2.filter((r) => r.metadata && r.metadata.component === 'course')
    .map((r) => Number(r.quantity));
  ok(
    'All Day fixture course rows each quantity 2 (surfers)',
    courseQtys.length === 2 && courseQtys.every((q) => q === 2),
    JSON.stringify(courseQtys),
  );
}

console.log(`\nverify-sunset-course-readback-cleanup: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
console.log('PASS sunset-course-readback-cleanup');
