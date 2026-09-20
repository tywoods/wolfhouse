'use strict';

/**
 * verify:sunset-bookings-package-display-polish-001
 *
 * Bookings expanded view reuses Schedule commercial-line grouping (display only):
 *   - multi-day course → one line with name, duration, quantity, package total
 *   - later course days are not independent €0 charges
 *   - charged equipment days stay visible
 *   - "Included" only with explicit During Course / policy evidence
 *   - Jacky optional €0 gear stays €0 (supported zeros)
 *   - Charged → Booking total, Net → Net collected, show Outstanding
 *   - ordinary renderer still paints ungrouped singles
 *
 * No reprice / backfill. Stay off Crow's Nest, Hermes, production.
 *
 * Run:
 *   node scripts/verify-sunset-bookings-package-display-polish-001.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const { collectPortalFunctions } = require('./lib/portal-fn-slice');
const DOMAIN = require('./lib/sunset-bookings-admin');

const ROOT = path.join(__dirname, '..');
const BOOKINGS_UI = path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js');
const VIEW_UI = path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-view-ui.js');
const I18N = path.join(ROOT, 'scripts/lib/staff-portal-i18n.js');
const I18N_ES = path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js');

const bookingsSrc = fs.readFileSync(BOOKINGS_UI, 'utf8');
const viewSrc = fs.readFileSync(VIEW_UI, 'utf8');
const i18nSrc = fs.readFileSync(I18N, 'utf8');
const i18nEsSrc = fs.readFileSync(I18N_ES, 'utf8');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

console.log('\nverify:sunset-bookings-package-display-polish-001\n');

// ── Source contracts ────────────────────────────────────────────────────────
ok(
  'Bookings expand reuses Schedule commercial-line grouping',
  /scheduleDrawerBuildCommercialLines/.test(bookingsSrc),
);
ok(
  'Bookings expand does not copy-paste grouping helper',
  !/function scheduleDrawerBuildCommercialLines/.test(bookingsSrc),
);
ok(
  'Included labeling requires explicit policy evidence helper',
  /adminBookingsHasExplicitIncludedEvidence/.test(bookingsSrc)
    && /during_course_policy/.test(bookingsSrc),
);
ok(
  'Must not invent Included for optional zeros',
  /adminBookingsHasExplicitIncludedEvidence/.test(bookingsSrc)
    && !/if\s*\(\s*(Number\()?.*line_cents.*===\s*0/.test(bookingsSrc.split('function adminBookingsHasExplicitIncludedEvidence')[1] || ''),
);
ok('i18n EN Booking total', /'admin\.bookings\.charged': 'Booking total'/.test(i18nSrc));
ok('i18n EN Net collected', /'admin\.bookings\.net': 'Net collected'/.test(i18nSrc));
ok('i18n EN Outstanding expand key', /'admin\.bookings\.outstanding': 'Outstanding'/.test(i18nSrc));
ok('i18n ES Booking total', /'admin\.bookings\.charged': 'Total de la reserva'/.test(i18nEsSrc));
ok('i18n ES Net collected', /'admin\.bookings\.net': 'Cobrado neto'/.test(i18nEsSrc));
ok('i18n IT Booking total', /'admin\.bookings\.charged': 'Totale prenotazione'/.test(i18nSrc));
ok('i18n IT Net collected', /'admin\.bookings\.net': 'Incassato netto'/.test(i18nSrc));
ok(
  'Expand payment story shows Outstanding',
  /admin\.bookings\.outstanding/.test(bookingsSrc)
    && /outstanding_cents/.test(bookingsSrc),
);

// ── Domain: display fields only, no money invention ─────────────────────────
console.log('\n[domain items + payment_story]');

const courseDays = [
  {
    service_record_id: 'c1',
    service_type: 'surf_lesson',
    service_date: '2026-07-10',
    quantity: 2,
    amount_due_cents: 18000,
    metadata: {
      component: 'course',
      course_id: 'beginner-adult',
      course_label: 'Beginner adult',
      tier_key: '3_days',
      unit_amount_cents: 9000,
    },
  },
  {
    service_record_id: 'c2',
    service_type: 'surf_lesson',
    service_date: '2026-07-11',
    quantity: 2,
    amount_due_cents: 0,
    metadata: {
      component: 'course',
      course_id: 'beginner-adult',
      course_label: 'Beginner adult',
      tier_key: '3_days',
    },
  },
  {
    service_record_id: 'c3',
    service_type: 'surf_lesson',
    service_date: '2026-07-12',
    quantity: 2,
    amount_due_cents: 0,
    metadata: {
      component: 'course',
      course_id: 'beginner-adult',
      course_label: 'Beginner adult',
      tier_key: '3_days',
    },
  },
];
const includedCe = {
  service_record_id: 'ce-inc',
  service_type: 'addon_service',
  service_date: '2026-07-10',
  quantity: 2,
  amount_due_cents: 0,
  metadata: {
    course_equipment: true,
    component: 'course_equipment',
    course_equipment_mode: 'during_course',
    during_course_policy: 'included',
    offering_key: 'surfboard_wetsuit_rental',
    label: 'Surfboard + wetsuit',
    unit_amount_cents: 0,
  },
};
const optionalZeroCe = {
  service_record_id: 'ce-opt',
  service_type: 'addon_service',
  service_date: '2026-07-10',
  quantity: 1,
  amount_due_cents: 0,
  metadata: {
    course_equipment: true,
    component: 'course_equipment',
    course_equipment_mode: 'during_course',
    during_course_policy: 'optional',
    offering_key: 'softboard',
    label: 'Softboard',
    unit_amount_cents: 0,
  },
};
const chargedCeDays = [
  {
    service_record_id: 'ce-paid-1',
    service_type: 'addon_service',
    service_date: '2026-07-10',
    quantity: 1,
    amount_due_cents: 2000,
    metadata: {
      course_equipment: true,
      component: 'course_equipment',
      course_equipment_mode: 'all_day',
      during_course_policy: 'optional',
      offering_key: 'surfboard',
      label: 'Surfboard',
      unit_amount_cents: 2000,
    },
  },
  {
    service_record_id: 'ce-paid-2',
    service_type: 'addon_service',
    service_date: '2026-07-11',
    quantity: 1,
    amount_due_cents: 2000,
    metadata: {
      course_equipment: true,
      component: 'course_equipment',
      course_equipment_mode: 'all_day',
      during_course_policy: 'optional',
      offering_key: 'surfboard',
      label: 'Surfboard',
      unit_amount_cents: 2000,
    },
  },
];

const row = DOMAIN.buildBookingListRow({
  booking: {
    booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    booking_code: 'SUNSET-PKG-1',
    guest_name: 'Ada',
    status: 'confirmed',
    total_amount_cents: 22000,
  },
  services: [...courseDays, includedCe, ...chargedCeDays],
  collected_cents: 10000,
  refunded_cents: 0,
});

ok('charged_cents stays booking total (no reprice)', row.charged_cents === 22000);
ok('payment_story.charged_cents unchanged', row.payment_story.charged_cents === 22000);
ok('payment_story includes outstanding_cents', row.payment_story.outstanding_cents === 12000);
ok('net_cents still collected−refunded', row.payment_story.net_cents === 10000);

const courseItems = row.items.filter((it) => String(it.service_type || '') === 'surf_lesson');
ok('course items keep per-day amount_due_cents', courseItems.length === 3
  && courseItems[0].amount_due_cents === 18000
  && courseItems[1].amount_due_cents === 0
  && courseItems[2].amount_due_cents === 0);
ok('course items expose grouping fields', courseItems.length === 3 && courseItems.every((it) => (
  it.line_cents === it.amount_due_cents
  && it.component === 'course'
  && it.course_id === 'beginner-adult'
  && it.tier_key === '3_days'
  && Number(it.quantity) === 2
)));
const incItem = row.items.find((it) => it.service_record_id === 'ce-inc');
ok('included CE carries policy + mode (no invented money)', incItem
  && incItem.course_equipment === true
  && incItem.course_equipment_mode === 'during_course'
  && incItem.during_course_policy === 'included'
  && incItem.amount_due_cents === 0
  && incItem.line_cents === 0);

const jackyRow = DOMAIN.buildBookingListRow({
  booking: { booking_id: 'b', booking_code: 'JACKY', total_amount_cents: 18000 },
  services: [...courseDays, optionalZeroCe],
  collected_cents: 0,
  refunded_cents: 0,
});
const jackyItem = jackyRow.items.find((it) => it.service_record_id === 'ce-opt');
ok('Jacky optional €0 stays zero with optional policy', jackyItem
  && jackyItem.during_course_policy === 'optional'
  && jackyItem.amount_due_cents === 0
  && jackyItem.line_cents === 0
  && jackyItem.course_equipment === true);

// ── UI: grouping + labels ───────────────────────────────────────────────────
console.log('\n[expand renderer]');

function portalT(key) {
  const map = {
    'admin.bookings.charged': 'Booking total',
    'admin.bookings.collected': 'Collected',
    'admin.bookings.refunded': 'Refunded',
    'admin.bookings.net': 'Net collected',
    'admin.bookings.outstanding': 'Outstanding',
    'admin.bookings.items': 'Items',
    'admin.bookings.noItems': 'No line items',
    'admin.bookings.paymentStory': 'Payment story',
    'admin.bookings.guestMeta': 'Guest & origin',
    'admin.bookings.guest': 'Guest',
    'admin.bookings.phone': 'Phone',
    'admin.bookings.waiver': 'Waiver',
    'admin.bookings.waiverUnknown': 'Unknown / not linked',
    'admin.bookings.createdBy': 'Created by',
    'admin.bookings.refunds': 'Refund records',
    'admin.bookings.noRefunds': 'No refund records',
    'admin.courseEquipment.included': 'Included',
    'schedule.drawer.includedInBundle': 'Included',
    'schedule.drawer.dayWordCap': 'Day',
    'schedule.drawer.daysWordCap': 'Days',
    'schedule.drawer.daysWord': 'days',
    'schedule.drawer.avgWord': 'avg',
    'schedule.drawer.surferWord': 'surfer',
    'schedule.drawer.surfersWord': 'surfers',
    'schedule.courseEquipment.during': 'During Course',
    'schedule.courseEquipment.allDay': 'All Day',
    'schedule.addon.perDaySuffix': '/day',
    'schedule.ops.rentalBoth': 'Board + wetsuit',
    'schedule.drawer.bundleOneSet': '1 set',
    'schedule.drawer.bundleSets': 'sets',
    'schedule.type.boardRental': 'Board rental',
    'schedule.type.wetsuitRental': 'Wetsuit rental',
  };
  return map[key] || key;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sliceByNameBounds(src, startName, endName) {
  const start = src.indexOf(`function ${startName}`);
  const end = endName ? src.indexOf(`function ${endName}`) : src.length;
  if (start < 0 || end <= start) return '';
  return src.slice(start, end);
}

function loadExpandSandbox(opts) {
  const includeGrouping = !opts || opts.includeGrouping !== false;
  const sandbox = {
    portalT,
    escHtml,
    getStaffLocale() { return 'en'; },
    adminBookingsCanWriteRefund() { return false; },
    adminBookingsFormatMadridCreated(iso) {
      return String(iso || '').slice(0, 16).replace('T', ' ');
    },
    schedulePortalDurationLabel(k) {
      return ({ '3_days': '3 days', '1_day': '1 day' })[k] || k;
    },
    scheduleDrawerStripLabelDate(l) { return String(l || ''); },
  };
  vm.createContext(sandbox);
  if (includeGrouping) {
    const sliced = collectPortalFunctions(viewSrc, [
      'scheduleDrawerBuildCommercialLines',
      'scheduleDrawerFormatCommercialMathLabel',
      'scheduleDrawerFormatCourseInvoiceLabel',
      'scheduleDrawerFormatEquipmentInvoiceLabel',
      'scheduleDrawerIsCourseLikeLine',
      'scheduleDrawerIsEquipmentLikeLine',
    ], {
      provided: Object.keys(sandbox),
    });
    if (sliced.missing.length || sliced.unparsable.length) {
      throw new Error(`grouping slice missing=${sliced.missing.join(',')} unparsable=${sliced.unparsable.join(',')}`);
    }
    const expose = sliced.resolved.map((n) => `this.${n}=${n};`).join('\n');
    vm.runInContext(`${sliced.code}\n${expose}`, sandbox);
  }
  // Brace-slice cannot parse helpers that compare charAt(0) === '{'.
  const helperSrc = sliceByNameBounds(bookingsSrc, 'adminBookingsFormatEur', 'adminBookingsFormatMadridCreated');
  const extraStart = bookingsSrc.indexOf('function adminBookingsHasExplicitIncludedEvidence');
  const extraEnd = bookingsSrc.indexOf('function renderAdminBookingsExpansion');
  const extraSrc = extraStart >= 0 && extraEnd > extraStart
    ? bookingsSrc.slice(extraStart, extraEnd)
    : '';
  const renderSrc = sliceByNameBounds(bookingsSrc, 'renderAdminBookingsExpansion', 'openAdminBookingsRefundForm');
  vm.runInContext(
    'var escHtml = this.escHtml;'
      + 'var portalT = this.portalT;'
      + 'var adminBookingsCanWriteRefund = this.adminBookingsCanWriteRefund;'
      + 'var adminBookingsFormatMadridCreated = this.adminBookingsFormatMadridCreated;'
      + 'var scheduleDrawerBuildCommercialLines = this.scheduleDrawerBuildCommercialLines;'
      + 'var scheduleDrawerFormatCommercialMathLabel = this.scheduleDrawerFormatCommercialMathLabel;'
      + 'var scheduleDrawerFormatCourseInvoiceLabel = this.scheduleDrawerFormatCourseInvoiceLabel;'
      + 'var scheduleDrawerFormatEquipmentInvoiceLabel = this.scheduleDrawerFormatEquipmentInvoiceLabel;'
      + 'var scheduleDrawerIsCourseLikeLine = this.scheduleDrawerIsCourseLikeLine;'
      + 'var scheduleDrawerIsEquipmentLikeLine = this.scheduleDrawerIsEquipmentLikeLine;'
      + 'var scheduleDrawerEur = this.scheduleDrawerEur;'
      + helperSrc
      + extraSrc
      + renderSrc
      + '\nthis.adminBookingsFormatItemDate=adminBookingsFormatItemDate;'
      + '\nthis.adminBookingsCleanItemLabel=adminBookingsCleanItemLabel;'
      + '\nthis.adminBookingsIsJunkExpandItem=adminBookingsIsJunkExpandItem;'
      + '\nthis.renderAdminBookingsExpansion=renderAdminBookingsExpansion;'
      + (extraSrc.indexOf('function adminBookingsHasExplicitIncludedEvidence') >= 0
        ? '\nthis.adminBookingsHasExplicitIncludedEvidence=adminBookingsHasExplicitIncludedEvidence;'
        : ''),
    sandbox,
  );
  return sandbox;
}

const grouped = loadExpandSandbox({ includeGrouping: true });
ok('sandbox has Schedule grouping', typeof grouped.scheduleDrawerBuildCommercialLines === 'function');
ok('sandbox has expand renderer', typeof grouped.renderAdminBookingsExpansion === 'function');
ok('sandbox has included-evidence helper', typeof grouped.adminBookingsHasExplicitIncludedEvidence === 'function');

const packageHtml = grouped.renderAdminBookingsExpansion({
  booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  guest_name: 'Ada',
  phone: '+346****1222',
  created_by: 'ops@sunset.test',
  status: 'paid',
  items: row.items,
  payment_story: row.payment_story,
  outstanding_cents: row.outstanding_cents,
  charged_cents: row.charged_cents,
  waiver: { status: 'completed' },
  refunds: [],
});

ok('Booking total label', /Booking total/.test(packageHtml));
ok('Net collected label', /Net collected/.test(packageHtml));
ok('Outstanding label + amount', /Outstanding/.test(packageHtml) && /€120\.00/.test(packageHtml));
ok('package total €180.00 shown once for course', (packageHtml.match(/€180\.00/g) || []).length === 1);
ok('Beginner adult grouped once', (packageHtml.match(/Beginner adult/g) || []).length === 1);
ok(
  'later course days not independent €0 charges',
  !/Beginner adult[^<]*€0\.00/.test(packageHtml.replace(/\n/g, ' ')),
);
ok('course quantity 2 visible', /\u00d7\s*2/.test(packageHtml) || /2\s+surfers/.test(packageHtml) || /× 2/.test(packageHtml));
ok('course duration visible', /3 days|3 Days/.test(packageHtml));

const itemsSection = (packageHtml.match(/data-bookings-section="items"[\s\S]*?<\/section>/) || [''])[0];
ok('charged all-day equipment preserved as grouped €40.00', /€40\.00/.test(itemsSection));
ok('all-day equipment not swallowed into course total', /Surfboard/.test(itemsSection));
ok('included CE labeled Included', /Included/.test(itemsSection));
ok('included CE does not show as €0.00 charge', !/Included[^<]*€0\.00/.test(itemsSection.replace(/\n/g, ' ')));

const jackyHtml = grouped.renderAdminBookingsExpansion({
  booking_id: 'jacky',
  guest_name: 'Jacky',
  phone: '+346****0000',
  created_by: 'ops@sunset.test',
  status: 'unpaid',
  items: jackyRow.items,
  payment_story: jackyRow.payment_story,
  outstanding_cents: jackyRow.outstanding_cents,
  waiver: { status: 'completed' },
  refunds: [],
});
const jackyItems = (jackyHtml.match(/data-bookings-section="items"[\s\S]*?<\/section>/) || [''])[0];
ok('Jacky optional €0 gear is not labeled Included', !/Included/.test(jackyItems));
ok('Jacky optional €0 still shows €0.00', /Softboard[\s\S]*€0\.00/.test(jackyItems) || /€0\.00/.test(jackyItems));

// Ordinary renderer: no Schedule grouping in sandbox (expand-clean regression).
const ordinary = loadExpandSandbox({ includeGrouping: false });
const expectedEn = new Date(Date.UTC(2026, 7, 11, 12, 0, 0)).toLocaleDateString('en-GB', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});
const ordinaryHtml = ordinary.renderAdminBookingsExpansion({
  booking_id: 'ord',
  guest_name: 'Gary',
  phone: '+346****1222',
  created_by: 'ops@sunset.test',
  status: 'paid',
  items: [
    {
      label: 'Adult group course',
      service_type: 'surf_lesson',
      service_date: '2026-08-11',
      amount_due_cents: 12000,
    },
    {
      label: 'Wetsuit rental',
      service_type: 'wetsuit',
      service_date: '2026-08-11',
      amount_due_cents: 3000,
    },
  ],
  payment_story: {
    charged_cents: 15000,
    collected_cents: 15000,
    refunded_cents: 0,
    net_cents: 15000,
    outstanding_cents: 0,
  },
  waiver: { status: 'completed' },
  refunds: [],
});
ok(
  'ordinary renderer keeps dated singles',
  ordinaryHtml.indexOf(`Adult group course · ${expectedEn}`) >= 0
    && ordinaryHtml.indexOf(`Wetsuit rental · ${expectedEn}`) >= 0,
);
ok('ordinary renderer keeps server cents', ordinaryHtml.indexOf('€120.00') >= 0 && ordinaryHtml.indexOf('€30.00') >= 0);
ok('ordinary payment labels still Booking total / Net collected', /Booking total/.test(ordinaryHtml) && /Net collected/.test(ordinaryHtml));

// Evidence helper unit
if (typeof grouped.adminBookingsHasExplicitIncludedEvidence === 'function') {
  ok('included policy is evidence', grouped.adminBookingsHasExplicitIncludedEvidence({
    during_course_policy: 'included',
    course_equipment: true,
    line_cents: 0,
  }) === true);
  ok('optional policy is not evidence', grouped.adminBookingsHasExplicitIncludedEvidence({
    during_course_policy: 'optional',
    course_equipment: true,
    line_cents: 0,
  }) === false);
  ok('bare €0 is not evidence', grouped.adminBookingsHasExplicitIncludedEvidence({
    course_equipment: true,
    line_cents: 0,
  }) === false);
  ok('included_equipment flag is evidence', grouped.adminBookingsHasExplicitIncludedEvidence({
    included_equipment: true,
    line_cents: 0,
  }) === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('PASS sunset bookings package display polish');
