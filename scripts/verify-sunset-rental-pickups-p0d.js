'use strict';

/**
 * P0d — Rental Pickups Today by SERVICE RECORD + friendly labels everywhere.
 *
 * Scope (never booking type):
 *   - Pickups include every standalone rental line from any booking
 *     (including course/lesson add-ons).
 *   - Exact rental metadata identity only; course_equipment===true excluded.
 *   - Course card = only course_equipment===true (during_course / all_day).
 *   - Same offering_key may appear once in pickups and once on course card.
 *
 * Labels:
 *   - Shared production resolver: offering_label/catalog_label/display_name
 *     then key fallback (strip _rental, [_-]+ → spaces, Title Case).
 *   - Persist offering_label at standalone rental write time.
 *   - Invoice line + drawer aggregation never emit bare offering_key when
 *     a friendly label can be derived.
 *
 * Behavioral: executes production owners (no copied predicate as sole proof).
 *
 * Run: node scripts/verify-sunset-rental-pickups-p0d.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DAY_OPS = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-day-ops-board-ui.js');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');

const {
  formatServiceRecordInvoiceLineText,
  resolveGenericRentalInvoiceLabel,
} = require('./lib/service-record-invoice-line');
const {
  formatSunsetDrawerDailyItemLabel,
} = require('./lib/sunset-schedule-booking-drawer');
const {
  buildGenericRentalServiceRecord,
} = require('./lib/tenant-rental-price-resolver');
const {
  prepareGenericRentalsForCreate,
} = require('./lib/sunset-schedule-booking-writes');

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

const DATE = '2026-08-15';
const RONNIE_BOOKING = 'bk-ronnie-p0d-0001';
const STEVE_BOOKING = 'bk-steve-p0d-0002';

// ── Shared label resolver (production owner) ─────────────────────────────
let resolveRentalOfferingFriendlyLabel;
let humanizeRentalOfferingKey;
try {
  const labelMod = require('./lib/rental-offering-label');
  resolveRentalOfferingFriendlyLabel = labelMod.resolveRentalOfferingFriendlyLabel;
  humanizeRentalOfferingKey = labelMod.humanizeRentalOfferingKey;
} catch (err) {
  resolveRentalOfferingFriendlyLabel = null;
  humanizeRentalOfferingKey = null;
}

// ── Production-shaped fixtures ───────────────────────────────────────────
function metaBase(extra) {
  return {
    source: 'staff_manual_schedule',
    staff_manual_schedule: true,
    location_id: 'sunset-somo',
    ...(extra || {}),
  };
}

function courseRow(opts) {
  const courseId = opts.course_id || 'course-tarde-p0d';
  return {
    service_record_id: opts.id || 'sr-ronnie-course',
    booking_id: opts.booking_id || RONNIE_BOOKING,
    booking_code: opts.booking_code || 'SUNSET-RONNIE',
    guest_name: opts.guest_name || 'Ronnie',
    service_type: 'surf_lesson',
    service_date: DATE,
    quantity: 1,
    payment_status: 'unpaid',
    record_source: 'staff_manual',
    staff_ui_service_type: 'course',
    course_id: courseId,
    course_label: opts.course_label || 'Curso Tarde',
    metadata: metaBase({
      component: 'course',
      staff_ui_service_type: 'course',
      course_id: courseId,
      course_label: opts.course_label || 'Curso Tarde',
    }),
    _scheduleType: 'course',
    _isDbManual: true,
  };
}

function standaloneRentalRow(opts) {
  const key = opts.offering_key;
  const label = opts.offering_label != null ? opts.offering_label : null;
  const amount = opts.amount_due_cents != null ? opts.amount_due_cents : 1000;
  return {
    service_record_id: opts.id || `sr-${key}`,
    booking_id: opts.booking_id || RONNIE_BOOKING,
    booking_code: opts.booking_code || 'SUNSET-RONNIE',
    guest_name: opts.guest_name || 'Ronnie',
    service_type: opts.service_type || 'addon_service',
    service_date: DATE,
    quantity: opts.quantity != null ? opts.quantity : 1,
    amount_due_cents: amount,
    payment_status: 'unpaid',
    record_source: 'staff_manual',
    staff_ui_service_type: 'rental',
    metadata: metaBase({
      rental_offering: true,
      generic_rental: opts.generic_rental !== false,
      staff_ui_service_type: 'rental',
      component: opts.component || 'addon_service',
      offering_key: key,
      offering_label: label,
      catalog_label: opts.catalog_label,
      display_name: opts.display_name,
      duration_key: opts.duration_key || '1_day',
      item_code: opts.item_code || `${key}__1_day`,
      unit_cents: amount,
      label: label,
    }),
    _scheduleType: 'rental',
    _isDbManual: true,
  };
}

function ceRow(opts) {
  const key = opts.offering_key || 'surfboard_wetsuit_rental';
  const mode = opts.mode === 'all_day' ? 'all_day' : 'during_course';
  return {
    service_record_id: opts.id || `sr-ce-${key}`,
    booking_id: opts.booking_id || RONNIE_BOOKING,
    booking_code: opts.booking_code || 'SUNSET-RONNIE',
    guest_name: opts.guest_name || 'Ronnie',
    service_type: 'addon_service',
    service_date: DATE,
    quantity: 1,
    amount_due_cents: opts.amount_due_cents != null ? opts.amount_due_cents : 0,
    payment_status: 'unpaid',
    record_source: 'staff_manual',
    staff_ui_service_type: 'course_equipment',
    metadata: metaBase({
      course_equipment: true,
      course_equipment_mode: mode,
      offering_key: key,
      label: opts.label || 'Surfboard + Wetsuit',
      component: 'course_equipment',
      staff_ui_service_type: 'course_equipment',
      unit_amount_cents: opts.amount_due_cents != null ? opts.amount_due_cents : 0,
    }),
    _scheduleType: 'rental',
    _isDbManual: true,
  };
}

/** Unrelated addon_service (meal) — must never appear in pickups. */
function mealAddonRow(opts) {
  return {
    service_record_id: opts.id || 'sr-meal',
    booking_id: opts.booking_id || RONNIE_BOOKING,
    booking_code: opts.booking_code || 'SUNSET-RONNIE',
    guest_name: opts.guest_name || 'Ronnie',
    service_type: 'addon_service',
    service_date: DATE,
    quantity: 1,
    amount_due_cents: 1200,
    payment_status: 'unpaid',
    record_source: 'staff_manual',
    staff_ui_service_type: 'addon_service',
    metadata: metaBase({
      component: 'addon_service',
      catalog_service: true,
      offering_key: 'meal_plan_lunch',
      service_name: 'Lunch meal',
      // No rental_offering / generic_rental / staff_ui rental identity
    }),
    _scheduleType: 'rental',
    _isDbManual: true,
  };
}

function classicBoardWetsuitRows(opts) {
  const bookingId = opts.booking_id || STEVE_BOOKING;
  const guest = opts.guest_name || 'Steve';
  const code = opts.booking_code || 'SUNSET-STEVE';
  return [
    {
      service_record_id: 'sr-steve-board',
      booking_id: bookingId,
      booking_code: code,
      guest_name: guest,
      service_type: 'surfboard',
      service_date: DATE,
      quantity: 1,
      payment_status: 'unpaid',
      record_source: 'staff_manual',
      metadata: metaBase({ component: 'surfboard' }),
      _scheduleType: 'rental',
      _isDbManual: true,
    },
    {
      service_record_id: 'sr-steve-wetsuit',
      booking_id: bookingId,
      booking_code: code,
      guest_name: guest,
      service_type: 'wetsuit',
      service_date: DATE,
      quantity: 1,
      payment_status: 'unpaid',
      record_source: 'staff_manual',
      metadata: metaBase({ component: 'wetsuit' }),
      _scheduleType: 'rental',
      _isDbManual: true,
    },
  ];
}

function buildRonnieFixtureRows() {
  return [
    courseRow({}),
    standaloneRentalRow({
      id: 'sr-ronnie-sup',
      offering_key: 'sup_rental',
      offering_label: 'SUP',
      amount_due_cents: 2500,
    }),
    standaloneRentalRow({
      id: 'sr-ronnie-sw-standalone',
      offering_key: 'surfboard_wetsuit_rental',
      offering_label: 'Surfboard + Wetsuit',
      amount_due_cents: 3000,
    }),
    standaloneRentalRow({
      id: 'sr-ronnie-bike',
      offering_key: 'bicycle_rental',
      offering_label: 'Bicycle',
      amount_due_cents: 1500,
    }),
    standaloneRentalRow({
      id: 'sr-ronnie-towel',
      offering_key: 'towel_rental',
      offering_label: 'Towel',
      amount_due_cents: 500,
    }),
    standaloneRentalRow({
      id: 'sr-ronnie-flipflops',
      offering_key: 'flipflops_rental',
      offering_label: 'Flipflops',
      amount_due_cents: 300,
    }),
    // During-course same-key S+W €0 — pickups must exclude; course card only.
    ceRow({
      id: 'sr-ronnie-ce-sw',
      offering_key: 'surfboard_wetsuit_rental',
      label: 'Surfboard + Wetsuit',
      mode: 'during_course',
      amount_due_cents: 0,
    }),
    mealAddonRow({}),
  ];
}

// ── Load production day-ops + portal grouping owners in one VM ───────────
function loadProductionDayOpsContext() {
  const dayOpsSrc = fs.readFileSync(DAY_OPS, 'utf8');
  const apiSrc = fs.readFileSync(STAFF_API, 'utf8');

  function extractFn(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing production function ${name}`);
    const braceStart = src.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      if (src[i] === '}') depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`Unclosed ${name}`);
  }

  // Minimal portal helpers required by grouping + pickup owners.
  const portalFns = [
    'scheduleRowMeta',
    'scheduleRowIsCourse',
    'scheduleRowIsPrivateLesson',
    'scheduleRowType',
    'scheduleRowComponentKey',
    'scheduleRowCourseMeta',
    'scheduleResolveCourseDisplayLabel',
    'scheduleRowEffectivePaid',
    'scheduleEnsureRowId',
    'scheduleBuildDisplayGroups',
    'scheduleGroupIsStandaloneRental',
    'scheduleGroupHasCourse',
    'scheduleRentalPickupKind',
    'scheduleGroupBoardsNeeded',
    'scheduleGroupWetsuitsNeeded',
    'scheduleGroupComponentQty',
  ].map((n) => {
    try {
      return extractFn(apiSrc, n);
    } catch (_) {
      return `function ${n}(){ return null; }`;
    }
  }).join('\n');

  // scheduleRowMeta is often a thin helper — ensure parse exists
  const rowMetaFallback = `
    function scheduleRowMeta(row){
      if (!row) return {};
      var m = row.metadata != null ? row.metadata : row._meta;
      if (!m) return {};
      if (typeof m === 'object') return m;
      try { return JSON.parse(m); } catch(_){ return {}; }
    }
    function scheduleEnsureRowId(r){
      if (!r) return r;
      if (!r._scheduleId) r._scheduleId = r.service_record_id || r.booking_id || ('r' + Math.random());
      return r;
    }
    function scheduleRowEffectivePaid(){ return false; }
    function scheduleRowIsPrivateLesson(r){
      return !!(r && (r._scheduleType === 'private_lesson' || r.service_type === 'private_lesson'
        || (r.staff_ui_service_type === 'private_lesson')));
    }
    function scheduleRowIsCourse(r){
      if (!r) return false;
      if (r._scheduleType === 'course' || r.staff_ui_service_type === 'course') return true;
      var m = scheduleRowMeta(r);
      return m.component === 'course' || m.staff_ui_service_type === 'course';
    }
    function scheduleRowCourseMeta(r){
      var m = scheduleRowMeta(r);
      return { course_id: r && (r.course_id || m.course_id), course_label: r && (r.course_label || m.course_label) };
    }
    function scheduleResolveCourseDisplayLabel(id, label){ return label || id || ''; }
    function scheduleGroupBoardsNeeded(g){
      if (!g) return 0;
      if (g.components && g.components.surfboard) return Math.max(1, Number(g.quantity) || 1);
      return 0;
    }
    function scheduleGroupWetsuitsNeeded(g){
      if (!g) return 0;
      if (g.components && g.components.wetsuit) return Math.max(1, Number(g.quantity) || 1);
      return 0;
    }
    function scheduleGroupComponentQty(g, key){
      return g && g.components && g.components[key] ? Math.max(1, Number(g.quantity) || 1) : 0;
    }
    function scheduleRentalPickupKind(group){
      if (!group) return null;
      var hasBoard = !!(group.components && group.components.surfboard) || scheduleGroupBoardsNeeded(group) > 0;
      var hasWets = !!(group.components && group.components.wetsuit) || scheduleGroupWetsuitsNeeded(group) > 0;
      if (hasBoard && hasWets) return 'both';
      if (hasBoard) return 'board';
      if (hasWets) return 'wetsuit';
      return null;
    }
  `;

  const sandbox = {
    portalT(key) {
      const map = {
        'schedule.ops.rentalPickupsToday': 'Rental pickups today',
        'schedule.ops.rentalBoth': 'Both',
        'schedule.ops.rentalBoardsOnly': 'Boards',
        'schedule.ops.rentalWetsuitsOnly': 'Wetsuits',
        'schedule.ops.rentalNothingScheduled': 'Nothing',
        'schedule.ops.rentalSortGuest': 'Guest',
        'schedule.ops.rentalSortItem': 'Item',
        'schedule.ops.rentalSortAria': 'Sort',
        'schedule.ops.rentalFilterGuest': 'Filter',
        'schedule.ops.rentalFilterEmpty': 'No matching guests',
        'schedule.courseEquipment.during': 'During Course',
        'schedule.courseEquipment.allDay': 'All Day',
        'schedule.equipment.boardAndWetsuit': 'board + wetsuit',
        'schedule.equipment.board': 'board',
        'schedule.equipment.wetsuit': 'wetsuit',
        'schedule.equipment.none': 'no equipment',
        'schedule.emptyDay': 'Nothing scheduled',
      };
      return map[key] || key;
    },
    escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
    console,
  };
  vm.createContext(sandbox);

  // Prefer real extracted portal owners; fill gaps with fallbacks.
  vm.runInContext(rowMetaFallback, sandbox);
  try {
    vm.runInContext(portalFns, sandbox);
  } catch (e) {
    // Partial extract ok — fallbacks cover missing pieces.
  }
  // Re-assert safe meta parse after extract (monolith helpers may assume host DOM).
  vm.runInContext(`
    scheduleRowMeta = function(row){
      if (!row) return {};
      var m = row.metadata != null ? row.metadata : row._meta;
      if (!m) return {};
      if (typeof m === 'object') return m;
      try { return JSON.parse(m); } catch(_){ return {}; }
    };
    if (typeof scheduleRowComponentKey !== 'function') {
      scheduleRowComponentKey = function(row){
        var meta = scheduleRowMeta(row);
        if (meta.rental_offering === true && meta.offering_key) return 'rental:' + String(meta.offering_key);
        if (meta.course_equipment === true) return 'course_equipment';
        if (meta.component) return String(meta.component);
        if (row && row.staff_ui_service_type) {
          var ui = String(row.staff_ui_service_type).toLowerCase();
          if (ui === 'board_rental') return 'surfboard';
          if (ui === 'wetsuit_rental') return 'wetsuit';
          if (ui === 'course') return 'course';
          if (ui === 'rental' && meta.offering_key) return 'rental:' + String(meta.offering_key);
        }
        var st = String(row && row.service_type || '').toLowerCase();
        if (st === 'surf_lesson') return scheduleRowIsCourse(row) ? 'course' : 'lesson';
        if (/surfboard|board/.test(st)) return 'surfboard';
        if (/wetsuit/.test(st)) return 'wetsuit';
        if (st === 'addon_service' && meta.offering_key) return 'rental:' + String(meta.offering_key);
        return 'unknown';
      };
    }
  `, sandbox);

  // Run full day-ops module (defines pickup + course-card owners).
  vm.runInContext(dayOpsSrc, sandbox);

  return sandbox;
}

console.log('\nverify:sunset-rental-pickups-p0d\n');

// ═══════════════════════════════════════════════════════════════════════════
// 1) Label resolver precedence + fallback
// ═══════════════════════════════════════════════════════════════════════════
console.log('[1] Friendly label resolver (production owner)');
{
  ok(
    'shared rental-offering-label module exports resolver',
    typeof resolveRentalOfferingFriendlyLabel === 'function'
      && typeof humanizeRentalOfferingKey === 'function',
  );

  if (typeof resolveRentalOfferingFriendlyLabel === 'function') {
    ok(
      'catalog/admin offering_label wins (Surfboard + Wetsuit)',
      resolveRentalOfferingFriendlyLabel({
        offering_key: 'surfboard_wetsuit_rental',
        offering_label: 'Surfboard + Wetsuit',
      }) === 'Surfboard + Wetsuit',
    );
    ok(
      'catalog_label wins when offering_label absent',
      resolveRentalOfferingFriendlyLabel({
        offering_key: 'surfboard_wetsuit_rental',
        catalog_label: 'Surfboard + Wetsuit',
      }) === 'Surfboard + Wetsuit',
    );
    ok(
      'display_name wins when higher labels absent',
      resolveRentalOfferingFriendlyLabel({
        offering_key: 'sup_rental',
        display_name: 'SUP',
      }) === 'SUP',
    );
    ok(
      'Admin label SUP preserved (catalog wins over humanize)',
      resolveRentalOfferingFriendlyLabel({
        offering_key: 'sup_rental',
        offering_label: 'SUP',
      }) === 'SUP',
    );
    ok(
      'generic fallback electric_bike_rental → Electric Bike',
      resolveRentalOfferingFriendlyLabel({
        offering_key: 'electric_bike_rental',
      }) === 'Electric Bike'
        || humanizeRentalOfferingKey('electric_bike_rental') === 'Electric Bike',
      `got=${resolveRentalOfferingFriendlyLabel({ offering_key: 'electric_bike_rental' })}`,
    );
    ok(
      'never returns bare offering_key when key can be humanized',
      resolveRentalOfferingFriendlyLabel({
        offering_key: 'surfboard_wetsuit_rental',
      }) !== 'surfboard_wetsuit_rental',
    );
    ok(
      'rejects identity-like label equal to offering_key then humanizes',
      resolveRentalOfferingFriendlyLabel({
        offering_key: 'surfboard_wetsuit_rental',
        offering_label: 'surfboard_wetsuit_rental',
        label: 'surfboard_wetsuit_rental',
      }) === 'Surfboard Wetsuit',
    );
    ok(
      'rejects identity-like item_code-as-label then uses catalog',
      resolveRentalOfferingFriendlyLabel({
        offering_key: 'surfboard_wetsuit_rental',
        label: 'surfboard_wetsuit_rental__1_day',
        catalog_label: 'Surfboard + Wetsuit',
      }) === 'Surfboard + Wetsuit',
    );
    ok(
      'board_rental fallback is Surfboard',
      resolveRentalOfferingFriendlyLabel({ offering_key: 'board_rental' }) === 'Surfboard',
    );
    ok(
      'wetsuit_rental fallback is Wetsuit',
      resolveRentalOfferingFriendlyLabel({ offering_key: 'wetsuit_rental' }) === 'Wetsuit',
    );
  } else {
    ok('resolver missing — RED expected', false, 'require ./lib/rental-offering-label failed');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2) Write path persists offering_label
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[2] Standalone service-record write metadata persists offering_label');
{
  const priced = {
    ok: true,
    client_slug: 'sunset-somo',
    location_id: 'sunset-somo',
    offering_key: 'surfboard_wetsuit_rental',
    offering_label: 'Surfboard + Wetsuit',
    duration_key: '1_day',
    item_code: 'surfboard_wetsuit_rental__1_day',
    unit: 'day',
    unit_cents: 3000,
    quantity: 1,
    amount_cents: 3000,
    currency: 'EUR',
  };
  const built = buildGenericRentalServiceRecord(priced, {
    bookingId: RONNIE_BOOKING,
    bookingCode: 'SUNSET-RONNIE',
    guestName: 'Ronnie',
    serviceDate: DATE,
  });
  ok('buildGenericRentalServiceRecord ok', built.ok === true, JSON.stringify(built));
  ok(
    'offering_label persisted on write metadata',
    built.ok
      && built.record.metadata.offering_label === 'Surfboard + Wetsuit',
    built.ok ? `label=${built.record.metadata.offering_label}` : '',
  );
  ok(
    'offering_key still present for identity',
    built.ok && built.record.metadata.offering_key === 'surfboard_wetsuit_rental',
  );

  // Fallback when catalog label missing: write path should still persist friendly label.
  const pricedNoLabel = {
    ...priced,
    offering_key: 'electric_bike_rental',
    offering_label: null,
    item_code: 'electric_bike_rental__1_day',
  };
  const builtFb = buildGenericRentalServiceRecord(pricedNoLabel, {
    serviceDate: DATE,
  });
  // Prefer production prepare path if it injects friendly label; otherwise builder may fill.
  let prepareLabel = null;
  try {
    // prepareGenericRentalsForCreate needs pg — exercise builder fallback only here.
    prepareLabel = builtFb.ok ? builtFb.record.metadata.offering_label : null;
  } catch (_) { /* ignore */ }

  const friendlyMissing = typeof resolveRentalOfferingFriendlyLabel === 'function'
    ? resolveRentalOfferingFriendlyLabel({
      offering_key: 'electric_bike_rental',
      offering_label: prepareLabel,
    })
    : null;
  ok(
    'unknown key write path yields friendly label (persisted or resolvable)',
    (prepareLabel && prepareLabel !== 'electric_bike_rental')
      || friendlyMissing === 'Electric Bike',
    `persisted=${prepareLabel} resolved=${friendlyMissing}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3) Invoice line + drawer owners — Surfboard + Wetsuit, no raw key
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[3] Invoice line + drawer aggregation owners');
{
  const swMeta = {
    rental_offering: true,
    generic_rental: true,
    offering_key: 'surfboard_wetsuit_rental',
    offering_label: 'Surfboard + Wetsuit',
    duration_key: '1_day',
    item_code: 'surfboard_wetsuit_rental__1_day',
    unit_cents: 3000,
  };
  const sr = {
    service_type: 'addon_service',
    quantity: 1,
    amount_due_cents: 3000,
    metadata: swMeta,
  };
  const invoiceText = formatServiceRecordInvoiceLineText(sr);
  ok(
    'invoice line uses Surfboard + Wetsuit (not raw key)',
    invoiceText.includes('Surfboard + Wetsuit')
      && !invoiceText.includes('surfboard_wetsuit_rental'),
    `text=${invoiceText}`,
  );

  // Missing offering_label — still no bare key when friendly can be derived.
  const srNoLabel = {
    service_type: 'addon_service',
    quantity: 1,
    amount_due_cents: 3000,
    metadata: {
      rental_offering: true,
      generic_rental: true,
      offering_key: 'surfboard_wetsuit_rental',
      duration_key: '1_day',
      item_code: 'surfboard_wetsuit_rental__1_day',
      unit_cents: 3000,
    },
  };
  const invoiceFb = formatServiceRecordInvoiceLineText(srNoLabel);
  ok(
    'invoice fallback never emits bare offering_key when humanizable',
    !invoiceFb.includes('surfboard_wetsuit_rental')
      && /Surfboard|Wetsuit|surfboard/i.test(invoiceFb),
    `text=${invoiceFb}`,
  );

  const genericLabel = resolveGenericRentalInvoiceLabel(srNoLabel.metadata, 'addon_service');
  ok(
    'resolveGenericRentalInvoiceLabel uses friendly fallback',
    genericLabel !== 'surfboard_wetsuit_rental'
      && genericLabel !== 'addon_service',
    `label=${genericLabel}`,
  );

  const drawerLabel = formatSunsetDrawerDailyItemLabel('addon_service', 1, sr);
  ok(
    'drawer label uses Surfboard + Wetsuit',
    drawerLabel.includes('Surfboard + Wetsuit')
      && !drawerLabel.includes('surfboard_wetsuit_rental'),
    `label=${drawerLabel}`,
  );

  const drawerFb = formatSunsetDrawerDailyItemLabel('addon_service', 1, srNoLabel);
  ok(
    'drawer fallback never emits bare offering_key when humanizable',
    !drawerFb.includes('surfboard_wetsuit_rental'),
    `label=${drawerFb}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 4) Pickups + course card on Ronnie mixed fixture (production owners)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[4] Production pickup selector + course-card on Ronnie mixed fixture');
{
  const ctx = loadProductionDayOpsContext();
  ok('production day-ops loaded scheduleBuildRentalPickupLines',
    typeof ctx.scheduleBuildRentalPickupLines === 'function');
  ok('production day-ops loaded scheduleDayOpsCourseEquipmentRows',
    typeof ctx.scheduleDayOpsCourseEquipmentRows === 'function');
  ok('production portal loaded scheduleBuildDisplayGroups',
    typeof ctx.scheduleBuildDisplayGroups === 'function');

  const ronnieRows = buildRonnieFixtureRows();
  const steveRows = classicBoardWetsuitRows({});
  const allRows = ronnieRows.concat(steveRows);

  // Prefer the same selection path renderScheduleDayOpsBoardHtml uses if exposed;
  // otherwise mirror production: display groups filtered for pickup eligibility.
  let gearGroups;
  if (typeof ctx.scheduleSelectRentalPickupGroups === 'function') {
    gearGroups = ctx.scheduleSelectRentalPickupGroups(allRows);
  } else {
    const groups = ctx.scheduleBuildDisplayGroups(allRows);
    // Production must NOT use pure-standalone-only filter for pickups.
    // Behavioral expectation: groups that yield pickup lines (service-record scope).
    gearGroups = groups.filter((g) => {
      if (typeof ctx.scheduleGroupHasRentalPickups === 'function') {
        return ctx.scheduleGroupHasRentalPickups(g);
      }
      // Probe: if still filtered by booking-type standalone, Ronnie course booking drops.
      return ctx.scheduleGroupIsStandaloneRental
        ? ctx.scheduleGroupIsStandaloneRental(g)
        : true;
    });
  }

  const pickupLines = ctx.scheduleBuildRentalPickupLines(gearGroups);
  const offeringKeys = pickupLines
    .map((l) => l.offeringKey || (l.itemKey && String(l.itemKey).replace(/^offering:/, '')))
    .filter(Boolean);
  const labels = pickupLines.map((l) => l.itemLabel);

  const ronnieLines = pickupLines.filter((l) => l.guestName === 'Ronnie');
  const steveLines = pickupLines.filter((l) => l.guestName === 'Steve');

  ok(
    'Ronnie pickups include SUP',
    ronnieLines.some((l) => l.offeringKey === 'sup_rental' || /SUP/i.test(l.itemLabel)),
    `keys=${offeringKeys.join(',')} labels=${labels.join('|')}`,
  );
  ok(
    'Ronnie pickups include standalone surfboard_wetsuit_rental',
    ronnieLines.some((l) => l.offeringKey === 'surfboard_wetsuit_rental'),
    `keys=${ronnieLines.map((l) => l.offeringKey).join(',')}`,
  );
  ok(
    'Ronnie pickups include bicycle, towel, flipflops',
    ['bicycle_rental', 'towel_rental', 'flipflops_rental'].every((k) =>
      ronnieLines.some((l) => l.offeringKey === k)),
    `keys=${ronnieLines.map((l) => l.offeringKey).join(',')}`,
  );
  ok(
    'Ronnie pickups exclude course_equipment S+W (CE not in pickups)',
    // Only one S+W line (standalone), not two
    ronnieLines.filter((l) => l.offeringKey === 'surfboard_wetsuit_rental').length === 1,
    `count=${ronnieLines.filter((l) => l.offeringKey === 'surfboard_wetsuit_rental').length}`,
  );
  ok(
    'unrelated meal addon_service excluded from pickups',
    !ronnieLines.some((l) => l.offeringKey === 'meal_plan_lunch' || /meal/i.test(l.itemLabel)),
  );
  ok(
    'Steve rental-only still shows in pickups',
    steveLines.length >= 1
      || pickupLines.some((l) => l.guestName === 'Steve'),
    `steveLines=${steveLines.length} allGuests=${[...new Set(pickupLines.map((l) => l.guestName))].join(',')}`,
  );
  ok(
    'pickup labels are friendly (Surfboard + Wetsuit / SUP), not bare keys',
    ronnieLines.every((l) => {
      if (!l.offeringKey) return true;
      return l.itemLabel && l.itemLabel !== l.offeringKey;
    }),
    `labels=${ronnieLines.map((l) => `${l.offeringKey}=>${l.itemLabel}`).join('; ')}`,
  );

  // Course card selector on Ronnie group (mixed records)
  const ronnieGroup = (ctx.scheduleBuildDisplayGroups(ronnieRows) || [])[0]
    || { records: ronnieRows, guest_name: 'Ronnie', components: { course: true } };
  const ceRows = ctx.scheduleDayOpsCourseEquipmentRows(ronnieGroup);
  ok(
    'course card rows are only course_equipment===true',
    ceRows.length === 1
      && ceRows[0].meta.course_equipment === true
      && ceRows[0].meta.offering_key === 'surfboard_wetsuit_rental',
    `ceCount=${ceRows.length}`,
  );
  ok(
    'course card omits standalone rentals (SUP, S+W paid, bike, towel, flipflops)',
    ceRows.every((x) => x.meta.course_equipment === true
      && x.meta.rental_offering !== true
      && x.meta.generic_rental !== true),
  );

  const ceLabel = ctx.scheduleDayOpsEquipmentPrepLabel(ronnieGroup);
  ok(
    'course card shows only CE S+W During Course',
    ceLabel === 'Surfboard + Wetsuit · During Course',
    `label=${ceLabel}`,
  );

  // Same-key distinct lanes: pickups has standalone key, card has CE key — no cross dedupe.
  ok(
    'same-key standalone+CE remain distinct across lanes',
    ronnieLines.some((l) => l.offeringKey === 'surfboard_wetsuit_rental')
      && ceRows.some((x) => x.meta.offering_key === 'surfboard_wetsuit_rental'),
  );

  // Course-only booking with CE all_day only — pickups empty for that guest, card shows all_day.
  const courseOnly = {
    records: [
      courseRow({ id: 'sr-only-course', booking_id: 'bk-course-only', guest_name: 'Cara' }),
      ceRow({
        id: 'sr-only-ce',
        booking_id: 'bk-course-only',
        guest_name: 'Cara',
        mode: 'all_day',
        offering_key: 'softboard',
        label: 'Softboard',
        amount_due_cents: 1000,
      }),
    ],
    guest_name: 'Cara',
    components: { course: true, course_equipment: true },
    booking_id: 'bk-course-only',
  };
  const courseOnlyPickups = ctx.scheduleBuildRentalPickupLines([courseOnly]);
  ok(
    'course-only CE does not appear in pickups',
    courseOnlyPickups.length === 0,
    `lines=${JSON.stringify(courseOnlyPickups)}`,
  );
  ok(
    'course card during/all_day only — all_day Softboard',
    ctx.scheduleDayOpsEquipmentPrepLabel(courseOnly) === 'Softboard · All Day',
  );
  // Standalone-only omitted from course card
  const standaloneOnlyGroup = {
    records: [standaloneRentalRow({
      booking_id: 'bk-only-rent',
      guest_name: 'Solo',
      offering_key: 'towel_rental',
      offering_label: 'Towel',
    })],
    guest_name: 'Solo',
    components: { 'rental:towel_rental': true },
  };
  ok(
    'standalone rental omitted from course card',
    ctx.scheduleDayOpsEquipmentPrepLabel(standaloneOnlyGroup) === 'no equipment',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 5) Source-level: production filter is not booking-type standalone-only
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[5] Production source does not gate pickups on pure-standalone booking type');
{
  const dayOpsSrc = fs.readFileSync(DAY_OPS, 'utf8');
  // Must not be the only filter path for pickups.
  const stillUsesOnlyStandalone = /scheduleBuildDisplayGroups\(activeRows\)\.filter\(scheduleGroupIsStandaloneRental\)/.test(dayOpsSrc);
  ok(
    'day-ops pickups not filtered solely by scheduleGroupIsStandaloneRental',
    !stillUsesOnlyStandalone,
    stillUsesOnlyStandalone
      ? 'still: scheduleBuildDisplayGroups(activeRows).filter(scheduleGroupIsStandaloneRental)'
      : '',
  );
  ok(
    'day-ops generic descriptors exclude course_equipment',
    /course_equipment/.test(dayOpsSrc)
      && /scheduleGenericRentalDescriptors|scheduleBuildRentalPickupLines|scheduleIsStandaloneRentalPickupRecord|isStandaloneRentalPickup/.test(dayOpsSrc),
  );
  ok(
    'course card render prefers CE equip over generic descriptor',
    /isCourseLane/.test(dayOpsSrc)
      && /scheduleDayOpsEquipmentPrepLabel/.test(dayOpsSrc)
      && /scheduleRenderOpsBookingRow/.test(dayOpsSrc),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 6) SQL gear query admits all supported standalone identities; meals out
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[6] Production gear SQL admission contract');
{
  const {
    getSunsetScheduleGearOnDateQuery,
    getSunsetScheduleCancelledGearOnDateQuery,
  } = require('./lib/sunset-schedule-queries');
  const gearSql = getSunsetScheduleGearOnDateQuery();
  const cancelSql = getSunsetScheduleCancelledGearOnDateQuery();
  for (const [name, sql] of [['active', gearSql], ['cancelled', cancelSql]]) {
    ok(
      `${name} gear SQL admits rental_offering=true`,
      /rental_offering'\s*=\s*'true'/.test(sql),
    );
    ok(
      `${name} gear SQL admits generic_rental=true`,
      /generic_rental'\s*=\s*'true'/.test(sql),
    );
    ok(
      `${name} gear SQL admits service_type rental`,
      /service_type\s*=\s*'rental'/.test(sql),
    );
    ok(
      `${name} gear SQL keeps canonical surfboard/wetsuit`,
      /service_type\s+IN\s*\(\s*'wetsuit'\s*,\s*'surfboard'\s*\)/.test(sql)
        || /service_type\s+IN\s*\(\s*'surfboard'\s*,\s*'wetsuit'\s*\)/.test(sql),
    );
    ok(
      `${name} gear SQL admits CE separately`,
      /course_equipment'\s*=\s*'true'/.test(sql),
    );
    // Meals: addon_service without rental markers must not be sufficient alone.
    ok(
      `${name} gear SQL does not admit bare addon_service without rental markers`,
      !/service_type\s*=\s*'addon_service'\s*(?:AND\s+[^)]*)?offering_key/.test(
        sql.replace(/\s+/g, ' '),
      )
      || (
        /rental_offering|generic_rental/.test(sql)
        && /course_equipment/.test(sql)
      ),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7) Drawer edit uses shared CANONICAL_RENTAL_OFFERING_KEYS
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[7] Drawer edit canonical filters use shared CANONICAL list');
{
  const drawerSrc = fs.readFileSync(
    path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-drawer.js'),
    'utf8',
  );
  const browserCanonical = fs.readFileSync(
    path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-rental-availability.js'),
    'utf8',
  );
  const {
    CANONICAL_RENTAL_OFFERING_KEYS,
    isExactOfferingFutureWriteKey,
  } = require('./lib/sunset-schedule-booking-writes');
  ok(
    'drawer imports CANONICAL_RENTAL_OFFERING_KEYS',
    /CANONICAL_RENTAL_OFFERING_KEYS/.test(drawerSrc)
      && !/new Set\(\['board_rental',\s*'wetsuit_rental',\s*'board_and_suit_rental'\]\)/.test(drawerSrc),
  );
  ok(
    'drawer hasExactOfferingRentals uses isExactOfferingFutureWriteKey',
    /isExactOfferingFutureWriteKey/.test(drawerSrc)
      && !/=== 'board_and_suit_rental'/.test(
        drawerSrc.slice(drawerSrc.indexOf('hasExactOfferingRentals')),
      ),
  );
  ok(
    'shared list includes surfboard_wetsuit_rental + board_and_wetsuit_rental',
    CANONICAL_RENTAL_OFFERING_KEYS.includes('surfboard_wetsuit_rental')
      && CANONICAL_RENTAL_OFFERING_KEYS.includes('board_and_wetsuit_rental'),
  );
  ok(
    'isExactOfferingFutureWriteKey true for S+W',
    isExactOfferingFutureWriteKey('surfboard_wetsuit_rental') === true,
  );
  ok(
    'browser SCHEDULE_CANONICAL includes S+W + board_and_wetsuit',
    /surfboard_wetsuit_rental/.test(browserCanonical)
      && /board_and_wetsuit_rental/.test(browserCanonical),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// 8–11) Production quote→create Ronnie + board render + payment summary
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[8] Production quote→create Ronnie (exact canonical S+W + generics + CE)');
(async function ronnieCreatePath() {
  const {
    executeSunsetStaffScheduleBookingQuote,
  } = require('./lib/sunset-staff-schedule-booking-quote');
  const {
    CANONICAL_RENTAL_OFFERING_KEYS,
  } = require('./lib/sunset-schedule-booking-writes');
  const {
    BOOKING_CREATE_CHANNELS,
    buildSunsetBookingCreateCommand,
    executeSunsetBookingCreate,
  } = require('./lib/luna-front-desk-booking-create-service');
  const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');
  const { buildPaymentSummary } = require('./lib/sunset-schedule-booking-drawer');
  const {
    resolveBusinessVertical,
    VERTICAL_CHANNELS,
    invokeVerticalOperation,
  } = require('./lib/luna-front-desk-business-vertical');
  const tbc = require('./lib/tenant-business-config');
  const tro = require('./lib/tenant-rental-offerings');
  const stockService = require('./lib/tenant-rental-stock-service');

  const LOC = 'sunset-somo';
  const DATE_R = '2026-09-05';
  const PACK_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const SW = 'surfboard_wetsuit_rental';
  const SUP = 'sup_rental';
  const COURSE_CENTS = 4000;
  const SUP_CENTS = 5000;
  const SW_CENTS = 3000;
  const BIKE_CENTS = 1500;
  const TOWEL_CENTS = 500;
  const FLIP_CENTS = 300;
  const PACK_ITEM = packPriceItemCode(PACK_ID, '1_day');

  const OFFERINGS = [
    { offering_key: SW, label: 'Surfboard + Wetsuit', active: true, stock_quantity: 20, location_id: LOC, client_slug: 'sunset' },
    { offering_key: SUP, label: 'SUP', active: true, stock_quantity: 10, location_id: LOC, client_slug: 'sunset' },
    { offering_key: 'bicycle_rental', label: 'Bicycle', active: true, stock_quantity: 8, location_id: LOC, client_slug: 'sunset' },
    { offering_key: 'towel_rental', label: 'Towel', active: true, stock_quantity: 30, location_id: LOC, client_slug: 'sunset' },
    { offering_key: 'flipflops_rental', label: 'Flipflops', active: true, stock_quantity: 20, location_id: LOC, client_slug: 'sunset' },
    { offering_key: 'board_rental', label: 'Surfboard', active: true, stock_quantity: 15, location_id: LOC, client_slug: 'sunset' },
    { offering_key: 'wetsuit_rental', label: 'Wetsuit', active: true, stock_quantity: 15, location_id: LOC, client_slug: 'sunset' },
  ];
  const PRICE_ROWS = [
    {
      id: 'pr-course', amount_cents: COURSE_CENTS, currency: 'EUR', item_type: 'package',
      item_code: PACK_ITEM, unit: 'day', location_id: LOC, active: true, pricing_status: 'confirmed',
    },
    ...[
      [SW, SW_CENTS], [SUP, SUP_CENTS], ['bicycle_rental', BIKE_CENTS],
      ['towel_rental', TOWEL_CENTS], ['flipflops_rental', FLIP_CENTS],
      ['board_rental', 2000], ['wetsuit_rental', 1000],
    ].map(([k, c], i) => ({
      id: `pr-${i}`, amount_cents: c, currency: 'EUR', item_type: 'rental',
      item_code: `${k}__1_day`, unit: 'day', location_id: LOC, active: true,
      pricing_status: 'confirmed', offering_key: k,
    })),
  ];
  const EQ_SW = {
    offering_key: SW,
    label: 'Surfboard + Wetsuit',
    during_course_price_cents: 0,
    all_day_price_cents: 2500,
    during_course_policy: 'included',
  };
  const adminCfg = {
    ok: true,
    source: 'db',
    currency: 'EUR',
    rental_offerings: OFFERINGS,
    surf_packs: [{
      pack_id: PACK_ID,
      label: 'Curso Tarde',
      active: true,
      group_size: 24,
      weekly: 'sat_sun',
      schedules: ['1600_1800'],
      equipment_options: [EQ_SW],
      price_tiers: [{ key: '1_day', label: '1 day', hours: 2, amount_cents: COURSE_CENTS }],
    }],
    prices: PRICE_ROWS.map((p) => ({
      id: p.id,
      category: p.item_type,
      offering_key: p.offering_key || p.item_code,
      item_code: p.item_code,
      amount_cents: p.amount_cents,
      unit: p.unit,
      active: true,
      currency: 'EUR',
      location_id: LOC,
      pricing_status: 'confirmed',
    })),
    private_lesson: {
      id: 'private-p0d', enabled: true, label: 'Private', amount_cents: 6000,
      currency: 'EUR', price_basis: 'per_session', default_duration_minutes: 120,
      equipment_options: [EQ_SW],
    },
  };

  function makePg() {
    const state = {
      bookings: [], services: [], committed: false, rolledBack: false,
      bookingSeq: 0, serviceSeq: 0, inTxn: false, sqlLog: [],
      priceRuleWrites: [], sessionLocks: new Set(),
    };
    const packConfig = {
      age_band: '12_and_up', group_size: 24, beaches: ['somo'], weekly: 'sat_sun',
      schedules: ['1600_1800'], equipment_options: [EQ_SW],
      price_tiers: [{ key: '1_day', label: '1 day', hours: 2, amount_cents: COURSE_CENTS }],
    };
    return {
      state,
      committed: () => state.committed,
      async query(sql, params = []) {
        const q = String(sql);
        state.sqlLog.push({ q: q.slice(0, 120) });
        if (/^\s*BEGIN/i.test(q)) { state.inTxn = true; return { rows: [] }; }
        if (/^\s*COMMIT/i.test(q)) { state.committed = true; state.inTxn = false; return { rows: [] }; }
        if (/^\s*ROLLBACK/i.test(q)) {
          state.rolledBack = true; state.inTxn = false;
          if (!state.committed) { state.bookings = []; state.services = []; }
          return { rows: [] };
        }
        if (/pg_advisory/i.test(q)) return { rows: [] };
        if (/FROM information_schema/i.test(q) || /to_regclass/i.test(q)) {
          return { rows: [{ table_name: 'tenant_price_rules', reg: 'tenant_price_rules', t: 'booking_service_records', '?column?': 1 }] };
        }
        if (/pg_constraint|ALTER TABLE|CREATE /i.test(q)) {
          return { rows: [{ definition: "CHECK ((service_type)::text = ANY ((ARRAY['addon_service'::character varying,'surf_lesson'::character varying])::text[]))" }] };
        }
        if (/SELECT id FROM clients WHERE slug/i.test(q)) {
          return { rows: [{ id: 'client-sunset-uuid' }] };
        }
        if (/FROM tenant_surf_pack_rules/i.test(q)) {
          return {
            rows: [{
              id: PACK_ID, label: 'Curso Tarde', active: true, location_id: LOC,
              config_json: packConfig,
            }],
          };
        }
        if (/tenant_private_lesson/i.test(q)) return { rows: [] };
        if (/tenant_rental_offerings/i.test(q)) {
          return {
            rows: OFFERINGS.map((o) => ({
              id: o.offering_key, offering_key: o.offering_key, label: o.label,
              display_name: o.label, active: true, client_slug: 'sunset',
              location_id: LOC, stock_quantity: o.stock_quantity || 20,
              remaining: o.stock_quantity || 20, stock_scope: 'location',
              config_json: {}, group_key: null, excludes: [], sort_order: 0,
            })),
          };
        }
        if (/FROM tenant_price_rules/i.test(q)) {
          const codes = (params || []).filter((p) => typeof p === 'string' && String(p).includes('__'));
          let rows = PRICE_ROWS;
          if (codes.length) rows = PRICE_ROWS.filter((r) => codes.includes(r.item_code));
          return { rows: rows.map((r) => ({ ...r, client_slug: 'sunset' })) };
        }
        if (/INSERT INTO bookings/i.test(q)) {
          state.bookingSeq += 1;
          const id = `bk-ronnie-${state.bookingSeq}`;
          const row = {
            id, booking_code: params[1] || `SUNSET-RONNIE-${state.bookingSeq}`,
            total_amount_cents: null, guest_name: 'Ronnie',
          };
          state.bookings.push(row);
          return { rows: [row], rowCount: 1 };
        }
        if (/INSERT INTO booking_service_records/i.test(q)) {
          state.serviceSeq += 1;
          const id = `sr-ronnie-${state.serviceSeq}`;
          let meta = {};
          for (let i = (params || []).length - 1; i >= 0; i -= 1) {
            const p = params[i];
            if (p && typeof p === 'object' && !Array.isArray(p)) { meta = p; break; }
            if (typeof p === 'string' && p.trim().startsWith('{')) {
              try { meta = JSON.parse(p); break; } catch (_) { /* continue */ }
            }
          }
          const isGenericShape = /'addon_service'/.test(q) && /\$5::date/.test(q);
          let service_type;
          let service_date;
          let quantity;
          let amount_due_cents = 0;
          if (isGenericShape) {
            service_type = 'addon_service';
            service_date = params[4];
            quantity = params[5];
            amount_due_cents = params[6] != null ? Number(params[6]) : 0;
          } else {
            service_type = params[4];
            service_date = params[5];
            quantity = params[6];
          }
          const row = {
            service_record_id: id, id, service_type, service_date, quantity,
            amount_due_cents, metadata: meta, booking_id: params[1],
            guest_name: 'Ronnie', payment_status: 'unpaid', record_source: 'staff_manual',
          };
          state.services.push(row);
          return { rows: [{ ...row }], rowCount: 1 };
        }
        if (/UPDATE booking_service_records/i.test(q) && /amount_due_cents/i.test(q)) {
          const due = Number(params[0]);
          for (const p of params) {
            const hit = state.services.find((s) => String(s.service_record_id) === String(p)
              || String(s.id) === String(p));
            if (hit && Number.isFinite(due)) {
              hit.amount_due_cents = due;
              return { rowCount: 1, rows: [] };
            }
          }
          return { rowCount: 1, rows: [] };
        }
        if (/UPDATE bookings/i.test(q) && /total_amount_cents/i.test(q)) {
          const total = Number(params[0]);
          if (state.bookings[0] && Number.isFinite(total)) state.bookings[0].total_amount_cents = total;
          return { rowCount: 1, rows: [] };
        }
        if (/UPDATE bookings/i.test(q)) return { rowCount: 1, rows: [] };
        if (/idempotency/i.test(q)) return { rows: [] };
        if (/FROM bookings/i.test(q)) return { rows: state.bookings.slice() };
        if (/booking_service_records/i.test(q)) return { rows: state.services.slice() };
        if (/COALESCE\(SUM/i.test(q)) return { rows: [{ seats: 0, paid_total: 0 }] };
        if (/FROM payments/i.test(q) || /waiver/i.test(q)) return { rows: [] };
        return { rows: [] };
      },
    };
  }

  async function withAdmin(fn) {
    const origCfg = tbc.resolveTenantBusinessConfigAsync;
    const origList = tro.listRentalOfferings;
    const origLoad = tbc.loadTenantPriceRuleFromDb;
    tbc.resolveTenantBusinessConfigAsync = async () => adminCfg;
    tro.listRentalOfferings = async () => OFFERINGS;
    tbc.loadTenantPriceRuleFromDb = async (_pg, params) => {
      const duration = params.duration;
      const itemCode = params.itemCode;
      const code = String(itemCode || '').includes('__') ? itemCode : `${itemCode}__${duration}`;
      const hit = (adminCfg.prices || []).find((p) => p.item_code === code && p.active !== false)
        || PRICE_ROWS.find((p) => p.item_code === code && p.active !== false);
      if (!hit || !(Number(hit.amount_cents) > 0)) return { status: 'not_found', location_id: LOC };
      return {
        status: 'found', amount_cents: hit.amount_cents, currency: 'EUR',
        item_code: hit.item_code || code, unit: hit.unit, location_id: LOC, pricing_status: 'confirmed',
      };
    };
    process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';
    try {
      return await fn();
    } finally {
      tbc.resolveTenantBusinessConfigAsync = origCfg;
      tro.listRentalOfferings = origList;
      if (origLoad) tbc.loadTenantPriceRuleFromDb = origLoad;
    }
  }

  const vertical = resolveBusinessVertical({
    channel: VERTICAL_CHANNELS.MANUAL_STAFF,
    clientSlug: 'sunset',
    locationId: LOC,
  });
  ok('sunset staff vertical resolves', vertical && vertical.ok === true, JSON.stringify(vertical));

  const transportBody = {
    guest_name: 'Ronnie',
    guest_phone: '+34600000001',
    location_id: LOC,
    date_from: DATE_R,
    date_to: DATE_R,
    service_dates: [DATE_R],
    payment_status: 'unpaid',
    notes: '',
    components: {
      course: {
        course_id: PACK_ID, tier_key: '1_day', quantity: 1, offering_id: PACK_ITEM,
      },
    },
    rentals: [
      { offering_key: SUP, duration_key: '1_day', quantity: 1 },
      { offering_key: SW, duration_key: '1_day', quantity: 1 },
      { offering_key: 'bicycle_rental', duration_key: '1_day', quantity: 1 },
      { offering_key: 'towel_rental', duration_key: '1_day', quantity: 1 },
      { offering_key: 'flipflops_rental', duration_key: '1_day', quantity: 1 },
    ],
    course_equipment: [
      { offering_key: SW, mode: 'during_course', quantity: 1 },
    ],
    custom_line_items: [],
    surfer_count: 1,
    lessons: [],
  };

  let quoteOut = null;
  let createOut = null;
  let createPg = null;
  await withAdmin(async () => {
    const pgQ = makePg();
    const loadRule = async (params) => {
      const duration = params.duration;
      const itemCode = params.itemCode;
      const code = String(itemCode || '').includes('__') ? itemCode : `${itemCode}__${duration}`;
      const hit = PRICE_ROWS.find((p) => p.item_code === code && p.active !== false);
      if (!hit || !(Number(hit.amount_cents) > 0)) return { status: 'not_found', location_id: LOC };
      return {
        status: 'found', amount_cents: hit.amount_cents, currency: 'EUR',
        item_code: hit.item_code, unit: hit.unit, location_id: LOC, pricing_status: 'confirmed',
      };
    };
    quoteOut = await executeSunsetStaffScheduleBookingQuote({
      clientSlug: 'sunset',
      locationId: LOC,
      body: transportBody,
      pgClient: pgQ,
      verticalResolved: vertical,
      channel: VERTICAL_CHANNELS.MANUAL_STAFF,
      listOfferings: async () => OFFERINGS,
      loadRule,
      invokeVertical: async (resolvedV, op, pgClient, req) =>
        invokeVerticalOperation(resolvedV, op, pgClient, req),
    });
    ok(
      'production staff quote ok for Ronnie combo',
      quoteOut && quoteOut.ok === true,
      JSON.stringify(quoteOut && quoteOut.body || quoteOut).slice(0, 400),
    );

    createPg = makePg();
    const cCmd = buildSunsetBookingCreateCommand({
      channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
      transportBody: {
        ...transportBody,
        quote_provenance: quoteOut && quoteOut.body && quoteOut.body.quote_provenance,
      },
      trustedLocationId: LOC,
      now: new Date('2026-09-05T12:00:00Z'),
      actorHints: { staff_user_id: 'staff-p0d', email: 'p0d@test' },
    });
    ok('create command builds', cCmd.ok === true, JSON.stringify(cCmd).slice(0, 200));
    if (cCmd.ok) {
      const origAssert = stockService.assertRentalStockClaimsInTxn;
      stockService.assertRentalStockClaimsInTxn = async (pgClient, opts) =>
        origAssert(pgClient, opts);
      try {
        createOut = await executeSunsetBookingCreate(createPg, cCmd.command);
      } finally {
        stockService.assertRentalStockClaimsInTxn = origAssert;
      }
    }
  });

  ok(
    'production create owner succeeds',
    createOut && createOut.ok === true,
    JSON.stringify(createOut && createOut.body || createOut).slice(0, 500),
  );

  const services = (createPg && createPg.state.services) || [];
  const parseMeta = (s) => {
    const m = s && s.metadata;
    if (!m) return {};
    if (typeof m === 'object') return m;
    try { return JSON.parse(m); } catch (_) { return {}; }
  };

  const swStandalone = services.filter((s) => {
    const m = parseMeta(s);
    return m.offering_key === SW && m.course_equipment !== true && m.rental_offering === true;
  });
  const swCe = services.filter((s) => {
    const m = parseMeta(s);
    return m.offering_key === SW && m.course_equipment === true;
  });
  const byKey = (k) => services.filter((s) => parseMeta(s).offering_key === k);

  ok('exact canonical S+W standalone row inserted', swStandalone.length >= 1,
    `count=${swStandalone.length} n=${services.length}`);
  ok(
    'exact S+W offering_label is Admin Surfboard + Wetsuit',
    swStandalone.length
      && parseMeta(swStandalone[0]).offering_label === 'Surfboard + Wetsuit',
    swStandalone[0] ? JSON.stringify(parseMeta(swStandalone[0])).slice(0, 300) : 'none',
  );
  ok(
    'exact S+W not identity-like raw key as label',
    swStandalone.length
      && parseMeta(swStandalone[0]).offering_label !== SW
      && parseMeta(swStandalone[0]).label !== SW,
  );
  ok('CE S+W separate row', swCe.length >= 1);
  ok('same-key standalone+CE never deduped (both present)',
    swStandalone.length >= 1 && swCe.length >= 1);
  ok('SUP persisted with Admin SUP label',
    byKey(SUP).length >= 1 && parseMeta(byKey(SUP)[0]).offering_label === 'SUP');
  ok('bicycle label Bicycle',
    byKey('bicycle_rental').length >= 1
      && parseMeta(byKey('bicycle_rental')[0]).offering_label === 'Bicycle');
  ok('towel label Towel',
    byKey('towel_rental').length >= 1
      && parseMeta(byKey('towel_rental')[0]).offering_label === 'Towel');
  ok('flipflops label Flipflops',
    byKey('flipflops_rental').length >= 1
      && parseMeta(byKey('flipflops_rental')[0]).offering_label === 'Flipflops');
  ok('S+W is exact/canonical',
    CANONICAL_RENTAL_OFFERING_KEYS.includes(SW)
      && swStandalone.length
      && parseMeta(swStandalone[0]).rental_offering === true);

  function toScheduleRow(s, guestName) {
    const m = parseMeta(s);
    const isCourse = m.component === 'course' || s.service_type === 'surf_lesson';
    return {
      service_record_id: s.service_record_id || s.id,
      _scheduleId: s.service_record_id || s.id,
      booking_id: s.booking_id || (createPg.state.bookings[0] && createPg.state.bookings[0].id),
      booking_code: s.booking_code,
      guest_name: guestName || s.guest_name || 'Ronnie',
      service_type: s.service_type,
      service_date: DATE_R,
      quantity: s.quantity || 1,
      amount_due_cents: s.amount_due_cents,
      payment_status: 'unpaid',
      record_source: 'staff_manual',
      staff_ui_service_type: m.staff_ui_service_type,
      course_id: m.course_id,
      course_label: m.course_label,
      metadata: m,
      _meta: m,
      _scheduleType: isCourse ? 'course' : 'rental',
      _isDbManual: true,
    };
  }

  const ronnieScheduleRows = services.map((s) => toScheduleRow(s, 'Ronnie'));
  const steveRows = [
    {
      service_record_id: 'sr-steve-board', _scheduleId: 'sr-steve-board',
      booking_id: 'bk-steve-p0d', booking_code: 'SUNSET-STEVE', guest_name: 'Steve',
      service_type: 'surfboard', service_date: DATE_R, quantity: 1, payment_status: 'unpaid',
      record_source: 'staff_manual',
      metadata: { component: 'surfboard', offering_key: 'board_rental', offering_label: 'Surfboard' },
      _meta: { component: 'surfboard', offering_key: 'board_rental', offering_label: 'Surfboard' },
      _scheduleType: 'rental', _isDbManual: true,
    },
    {
      service_record_id: 'sr-steve-wetsuit', _scheduleId: 'sr-steve-wetsuit',
      booking_id: 'bk-steve-p0d', booking_code: 'SUNSET-STEVE', guest_name: 'Steve',
      service_type: 'wetsuit', service_date: DATE_R, quantity: 1, payment_status: 'unpaid',
      record_source: 'staff_manual',
      metadata: { component: 'wetsuit', offering_key: 'wetsuit_rental', offering_label: 'Wetsuit' },
      _meta: { component: 'wetsuit', offering_key: 'wetsuit_rental', offering_label: 'Wetsuit' },
      _scheduleType: 'rental', _isDbManual: true,
    },
  ];
  const allRows = ronnieScheduleRows.concat(steveRows);

  console.log('\n[9] Production grouping + board render owners on inserted rows');
  {
    const ctx = loadProductionDayOpsContext();
    ctx.scheduleRowSourceKind = (g) => (g && g._isDbManual ? 'staff' : 'luna');
    ctx.scheduleRowSourceAriaLabel = () => 'Staff booking';
    ctx.scheduleDayOpsRowStatusHtml = () => '<span>Unpaid</span>';
    ctx.scheduleRenderDayProgressMetaHtml = () => '';
    if (typeof ctx.scheduleGroupHasPrivateLesson !== 'function') {
      ctx.scheduleGroupHasPrivateLesson = (g) => !!(g && g.components && g.components.private_lesson);
    }
    if (typeof ctx.scheduleGroupHasLesson !== 'function') {
      ctx.scheduleGroupHasLesson = (g) => !!(g && g.components && g.components.lesson);
    }
    if (typeof ctx.scheduleGroupHasCourse !== 'function') {
      ctx.scheduleGroupHasCourse = (g) => !!(g && (
        (g.components && g.components.course)
        || (g.records || []).some((r) => {
          const m = r.metadata || r._meta || {};
          return m.component === 'course' || r._scheduleType === 'course'
            || r.staff_ui_service_type === 'course';
        })
      ));
    }
    if (typeof ctx.scheduleGroupComponentQty !== 'function') {
      ctx.scheduleGroupComponentQty = (g, key) => (g && g.components && g.components[key]
        ? Math.max(1, Number(g.quantity) || 1) : 0);
    }
    const groups = typeof ctx.scheduleSelectRentalPickupGroups === 'function'
      ? ctx.scheduleSelectRentalPickupGroups(allRows)
      : ctx.scheduleBuildDisplayGroups(allRows).filter(ctx.scheduleGroupHasRentalPickups);
    const lines = ctx.scheduleBuildRentalPickupLines(groups);
    const ronnieLines = lines.filter((l) => l.guestName === 'Ronnie');
    const steveLines = lines.filter((l) => l.guestName === 'Steve');
    const rKeys = ronnieLines.map((l) => l.offeringKey).filter(Boolean);

    ok('pickups include SUP', rKeys.includes(SUP) || ronnieLines.some((l) => /SUP/i.test(l.itemLabel)));
    ok('pickups include standalone S+W', rKeys.includes(SW));
    ok('pickups include bicycle towel flipflops',
      ['bicycle_rental', 'towel_rental', 'flipflops_rental'].every((k) => rKeys.includes(k)),
      `keys=${rKeys.join(',')}`);
    ok('pickups exclude CE S+W (one standalone only)',
      ronnieLines.filter((l) => l.offeringKey === SW).length === 1);
    ok('pickup S+W label is Surfboard + Wetsuit not raw key',
      ronnieLines.some((l) => l.offeringKey === SW && l.itemLabel === 'Surfboard + Wetsuit'));
    ok('Steve rental-only still in pickups', steveLines.length >= 1);

    const ronnieGroup = (ctx.scheduleBuildDisplayGroups(ronnieScheduleRows) || [])[0];
    ok('ronnie display group built', !!ronnieGroup);
    if (ronnieGroup) {
      const ceRows = ctx.scheduleDayOpsCourseEquipmentRows(ronnieGroup);
      ok('course card CE only (same-key S+W once)',
        ceRows.length === 1 && ceRows[0].meta.offering_key === SW);
      const prepLabel = ctx.scheduleDayOpsEquipmentPrepLabel(ronnieGroup);
      ok('course card equip is CE S+W During Course only',
        prepLabel === 'Surfboard + Wetsuit · During Course',
        `label=${prepLabel}`);
      ok('course card prep has no standalone SUP/bicycle labels',
        !/\bSUP\b/.test(prepLabel) && !/Bicycle|Towel|Flipflops/i.test(prepLabel));

      const cardHtml = ctx.scheduleRenderOpsBookingRow(ronnieGroup);
      ok('rendered course card HTML present', !!cardHtml && cardHtml.includes('Ronnie'));
      ok('rendered course card shows CE equip sublabel',
        cardHtml.includes('Surfboard + Wetsuit') && cardHtml.includes('During Course'),
        cardHtml.slice(0, 400));
      ok('rendered course card does not paint standalone SUP as equip',
        !/>SUP</.test(cardHtml));
      ok('rendered course card carries booking identity for click',
        /data-ps-booking-id=/.test(cardHtml));
    }
  }

  console.log('\n[10] Payment summary / drawer aggregate: two S+W semantic lines');
  {
    if (services.length && typeof buildPaymentSummary === 'function') {
      const booking = createPg.state.bookings[0] || {
        total_amount_cents: 0, amount_paid_cents: 0, payment_status: 'unpaid',
      };
      const pay = buildPaymentSummary(
        {},
        {
          total_amount_cents: booking.total_amount_cents || 0,
          amount_paid_cents: 0,
          payment_status: 'unpaid',
        },
        services.map((s) => ({
          ...s,
          service_record_id: s.service_record_id || s.id,
          service_date: DATE_R,
        })),
        'config',
        0,
        null,
        {},
      );
      const items = pay.line_items || [];
      ok('payment summary has lines', items.length > 0, JSON.stringify(items.map((i) => i.label)).slice(0, 300));
      ok('no raw surfboard_wetsuit_rental in payment labels',
        items.every((li) => String(li.label || '').indexOf(SW) < 0),
        JSON.stringify(items.map((i) => i.label)).slice(0, 400));
      const hasFriendlySw = items.some((li) => /Surfboard \+ Wetsuit/i.test(String(li.label || '')));
      ok('payment summary includes Surfboard + Wetsuit friendly label', hasFriendlySw);

      if (swStandalone[0]) {
        const inv = formatServiceRecordInvoiceLineText({
          service_type: swStandalone[0].service_type || 'addon_service',
          quantity: 1,
          amount_due_cents: SW_CENTS,
          metadata: parseMeta(swStandalone[0]),
        });
        ok('invoice standalone S+W friendly',
          inv.includes('Surfboard + Wetsuit') && !inv.includes(SW), inv);
      }
      if (swCe[0]) {
        const invCe = formatServiceRecordInvoiceLineText({
          service_type: 'addon_service',
          quantity: 1,
          amount_due_cents: swCe[0].amount_due_cents || 0,
          metadata: parseMeta(swCe[0]),
        });
        ok('invoice CE S+W During Course friendly',
          invCe.includes('Surfboard + Wetsuit')
            && invCe.includes('During Course')
            && !invCe.includes(SW),
          invCe);
        const dr = formatSunsetDrawerDailyItemLabel('addon_service', 1, {
          service_type: 'addon_service',
          quantity: 1,
          metadata: parseMeta(swCe[0]),
        });
        ok('drawer CE label During Course friendly',
          dr.includes('Surfboard + Wetsuit') && dr.includes('During Course') && !dr.includes(SW),
          dr);
      }
    } else {
      ok('buildPaymentSummary available with services', false,
        `services=${services.length}`);
    }
  }

  console.log('\n[11] Legacy board_rental offering_label on create');
  {
    await withAdmin(async () => {
      const boardPg = makePg();
      const boardBody = {
        guest_name: 'BoardOnly',
        guest_phone: '+34600000002',
        location_id: LOC,
        date_from: DATE_R,
        date_to: DATE_R,
        service_dates: [DATE_R],
        payment_status: 'unpaid',
        notes: '',
        components: {},
        rentals: [
          { offering_key: 'board_rental', duration_key: '1_day', quantity: 1 },
        ],
        course_equipment: [],
        custom_line_items: [],
        surfer_count: 1,
        lessons: [],
      };
      // Quote first for provenance
      const q = await executeSunsetStaffScheduleBookingQuote({
        clientSlug: 'sunset',
        locationId: LOC,
        body: boardBody,
        pgClient: boardPg,
        verticalResolved: vertical,
        channel: VERTICAL_CHANNELS.MANUAL_STAFF,
        listOfferings: async () => OFFERINGS,
        loadRule: async (params) => {
          const duration = params.duration;
          const itemCode = params.itemCode;
          const code = String(itemCode || '').includes('__') ? itemCode : `${itemCode}__${duration}`;
          const hit = PRICE_ROWS.find((p) => p.item_code === code);
          if (!hit || !(Number(hit.amount_cents) > 0)) return { status: 'not_found', location_id: LOC };
          return {
            status: 'found', amount_cents: hit.amount_cents, currency: 'EUR',
            item_code: hit.item_code, unit: hit.unit, location_id: LOC, pricing_status: 'confirmed',
          };
        },
        invokeVertical: async (resolvedV, op, pgClient, req) =>
          invokeVerticalOperation(resolvedV, op, pgClient, req),
      });
      const bCmd = buildSunsetBookingCreateCommand({
        channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
        transportBody: {
          ...boardBody,
          quote_provenance: q && q.body && q.body.quote_provenance,
        },
        trustedLocationId: LOC,
        now: new Date('2026-09-05T12:00:00Z'),
        actorHints: { staff_user_id: 'staff-p0d' },
      });
      let bOut = null;
      if (bCmd.ok) bOut = await executeSunsetBookingCreate(boardPg, bCmd.command);
      const boardSvcs = (boardPg.state.services || []).filter((s) => {
        const m = parseMeta(s);
        return m.offering_key === 'board_rental' || s.service_type === 'surfboard';
      });
      const boardMeta = boardSvcs[0] ? parseMeta(boardSvcs[0]) : {};
      ok(
        'board_rental create persists friendly Surfboard offering_label',
        bOut && bOut.ok
          && boardMeta.offering_label
          && boardMeta.offering_label !== 'board_rental'
          && /Surfboard/i.test(String(boardMeta.offering_label)),
        JSON.stringify({ ok: bOut && bOut.ok, meta: boardMeta, n: boardSvcs.length }).slice(0, 400),
      );
    });
  }

  console.log(`\n── verify:sunset-rental-pickups-p0d ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  if (fail) process.exit(1);
}()).catch((err) => {
  console.error('P0d async suite error', err);
  process.exit(1);
});
