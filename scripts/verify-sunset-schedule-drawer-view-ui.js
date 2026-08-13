'use strict';

/**
 * verify:sunset-schedule-drawer-view-ui
 *
 * Slice 12 — Schedule drawer read-only view rendering gate.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-drawer-view-ui.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { collectPortalFunctions, slicePortalFunction } = require('./lib/portal-fn-slice');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const VIEW_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const PAY_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-actions.js');
const PORTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');
const CTRL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-controller.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function extractFunctionSource(src, name) {
  return slicePortalFunction(src, name);
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function portalT(key) {
  const map = {
    'schedule.drawer.loading': 'Loading…',
    'schedule.drawer.loadFailed': 'Could not load booking',
    'schedule.drawer.paidInFull': 'Paid in full',
    'schedule.drawer.dueSuffix': 'due',
    'schedule.drawer.subtotal': 'Subtotal',
    'schedule.drawer.paid': 'Paid',
    'schedule.drawer.paymentsTitle': 'Payments',
    'schedule.drawer.paymentLinkActive': 'Payment link active',
    'schedule.drawer.createPaymentLink': 'Create payment link',
    'schedule.drawer.stripeUnavailable': 'Stripe unavailable',
    'schedule.drawer.section.booking': 'Booking',
    'schedule.drawer.section.notes': 'Notes',
    'schedule.drawer.edit': 'Edit',
    'schedule.drawer.startConv': 'Start conversation',
    'schedule.drawer.deleteBooking': 'Delete booking',
    'schedule.drawer.close': 'Close',
    'schedule.refresh': 'Refresh',
    'schedule.drawer.copyCode': 'Copy code',
    'schedule.drawer.bookingCode': 'Booking code',
    'schedule.drawer.phone': 'Phone',
    'schedule.drawer.bookedItems': 'Booked items',
    'schedule.create.guestName': 'Guest name',
    'schedule.create.dateFrom': 'From',
    'schedule.create.dateTo': 'To',
    'schedule.create.date': 'Date',
    'schedule.drawer.section.dates': 'Dates',
    'schedule.drawer.source': 'Source',
    'schedule.drawer.waiverTitle': 'Waiver',
    'schedule.drawer.waiverLoading': 'Loading waiver…',
    'schedule.type.course': 'Course',
    'schedule.type.privateCourse': 'Private',
    'schedule.type.boardRental': 'Board',
    'schedule.type.wetsuitRental': 'Wetsuit',
    'schedule.drawer.dayWordCap': 'Day',
    'schedule.drawer.daysWordCap': 'Days',
    'schedule.drawer.daysWord': 'days',
    'schedule.drawer.avgWord': 'avg',
    'schedule.addon.perDaySuffix': '/day',
    'schedule.courseEquipment.during': 'During Course',
    'schedule.courseEquipment.allDay': 'All Day',
    'schedule.drawer.surferWord': 'surfer',
    'schedule.drawer.surfersWord': 'surfers',
    'schedule.drawer.dateLabel': 'Dates',
    'schedule.drawer.showDaily': 'Show daily',
    'schedule.drawer.paymentSection': 'Payment',
    'schedule.drawer.noLineItems': 'No line items',
    'schedule.drawer.remaining': 'Remaining',
    'schedule.drawer.balanceDue': 'Balance due',
    'schedule.drawer.refundCredit': 'Refund / credit',
    'schedule.drawer.paymentCredit': 'Payment',
    'schedule.drawer.otherPayments': 'Other payments',
    'schedule.col.payment': 'Payment',
    'schedule.payment.unpaid': 'Unpaid',
    'schedule.payment.paid': 'Paid',
    'schedule.drawer.methodBankTransfer': 'bank transfer',
    'schedule.drawer.methodInShop': 'in shop',
    'schedule.drawer.methodCard': 'card',
    'schedule.drawer.openCustomer': 'Open customer',
    'schedule.drawer.recordPayment': 'Record payment',
    'schedule.drawer.manualPayAmount': 'Amount',
    'schedule.drawer.manualPayMethod': 'Method',
    'schedule.payment.paidBankTransfer': 'Bank transfer',
    'schedule.payment.paidInStore': 'In store',
    'schedule.drawer.manualPayNote': 'Note',
    'schedule.drawer.manualPaySubmit': 'Submit',
    'schedule.drawer.moreStripeOptions': 'More options',
    'schedule.drawer.stripeDelete': 'Delete link',
    'schedule.drawer.copyLink': 'Copy link',
    'schedule.drawer.stripeStaleHint': 'Link may be stale',
    'schedule.ops.rentalBoth': 'Board + wetsuit',
    'schedule.drawer.bundleSets': 'sets',
    'schedule.drawer.bundleOneSet': '1 set',
    'schedule.drawer.invoiceTitle': 'Invoice',
  };
  return map[key] || key;
}

function buildRenderCtx(viewModSrc, portalModSrc, apiSrc) {
  const ctx = {
    console,
    getClient: () => 'sunset',
    getPortalProfile: () => ({ customers_crm: true }),
    portalHasCustomersCrm: (p) => !!(p && p.customers_crm),
    isSunsetSurfActive: () => true,
    scheduleRowSourceDrawerLabel: (row) => (row && row.record_source === 'luna_guest' ? 'Luna' : 'Staff'),
    scheduleResolveDrawerSchoolLabel: () => 'Sunset Surf',
    scheduleResolveCourseDisplayLabel: (_id, label) => label || 'Beginner',
    scheduleFormatRange: (a, b) => `${a.toISOString().slice(0, 10)} – ${b.toISOString().slice(0, 10)}`,
    scheduleParseIso: (s) => new Date(s + 'T12:00:00'),
    scheduleDrawerCanEdit: () => true,
    scheduleDrawerPaymentShortUrl: (c) => (c && c.booking_code ? `https://staff.example/pay/${c.booking_code}` : ''),
    schedulePaymentStatusLabel: (status) => (status === 'paid' ? 'Paid' : 'Unpaid'),
    scheduleRenderDrawerManualPaymentHtml: () => '<div id="ps-drawer-manual-pay"></div>',
    scheduleRenderDrawerStripeLinkSectionHtml: (c) => {
      const r = ctx.schedulePortalStripeLinkFromCtx(c);
      return r.actionable ? `<a id="ps-drawer-stripe-url" href="${r.url}">${r.url}</a>` : '';
    },
    scheduleRenderDrawerPaymentSectionHtml: (c) => ctx.scheduleRenderDrawerPaymentSectionViewHtml(c),
  };
  vm.createContext(ctx);
  vm.runInContext(`function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}`, ctx);
  vm.runInContext(`function portalT(k){return (${portalT.toString()})(k);}`, ctx);

  const stripeFn = extractFunctionSource(portalModSrc, 'schedulePortalStripeLinkFromCtx');
  if (stripeFn) vm.runInContext(`${stripeFn}\nthis.schedulePortalStripeLinkFromCtx=schedulePortalStripeLinkFromCtx;`, ctx);

  // Compact date range used by grouped equipment coverage labels.
  vm.runInContext(`function schedulePortalFormatCompactDateRange(fromIso, toIso){
    var from = String(fromIso || '').slice(0, 10);
    var to = String(toIso == null || toIso === '' ? from : toIso).slice(0, 10);
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(from)) return '';
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(to)) to = from;
    function part(iso){
      var y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)), d = Number(iso.slice(8, 10));
      var mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1] || '';
      return { day: d, mon: mon, month: m, year: y };
    }
    var a = part(from); var b = part(to);
    if (from === to) return String(a.day) + ' ' + a.mon;
    if (a.month === b.month && a.year === b.year) return String(a.day) + '\\u2013' + String(b.day) + ' ' + a.mon;
    return String(a.day) + ' ' + a.mon + '\\u2013' + String(b.day) + ' ' + b.mon;
  }
  this.schedulePortalFormatCompactDateRange = schedulePortalFormatCompactDateRange;`, ctx);
  vm.runInContext(`function scheduleParseIso(iso){
    var s = String(iso || '').slice(0, 10);
    var p = s.split('-');
    return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12, 0, 0));
  }
  this.scheduleParseIso = scheduleParseIso;`, ctx);

  const fns = [
    'scheduleRenderDrawerLoadingHtml',
    'scheduleRenderDrawerErrorHtml',
    'scheduleDrawerViewResolveStripe',
    'scheduleDrawerSectionHtml',
    'scheduleRenderDeleteBookingRowHtml',
    'scheduleFormatComponentsView',
    'scheduleRenderDrawerOpenCustomerBtnHtml',
    'scheduleRenderDrawerWaiverSectionHtml',
    'scheduleDateOnlyLabel',
    'scheduleDrawerSameDay',
    'scheduleFormatDrawerDateDisplay',
    'scheduleFormatDrawerDateRangeText',
    'scheduleRenderDrawerHeroMetadataLine',
    'scheduleRenderDrawerViewDateRow',
    'scheduleRenderDrawerBookedItemsRow',
    'scheduleRenderDrawerViewBookingDetailsHtml',
    'scheduleRenderDrawerHeroHtml',
    'scheduleDrawerStripLabelDate',
    'scheduleDrawerDDMMYY',
    'scheduleDrawerCopyIconBtnHtml',
    'scheduleDrawerPaidMethodLabel',
    'scheduleDrawerServiceTypeLabel',
    'scheduleDrawerServiceOrder',
    'scheduleDrawerSortItems',
    'scheduleDrawerCommercialLineRank',
    'scheduleDrawerEquipmentCoverageLabel',
    'scheduleDrawerStripAccommodationIsoDates',
    'scheduleDrawerFormatAccommodationDdMm',
    'scheduleDrawerFormatAccommodationInvoiceLabel',
    'scheduleDrawerFormatAccommodationSeasonSegment',
    'scheduleDrawerFormatAccommodationSeasonSubtitle',
    'scheduleDrawerIsCourseLikeLine',
    'scheduleDrawerIsEquipmentLikeLine',
    'scheduleDrawerUsesStackedSvcDetail',
    'scheduleDrawerFormatCourseInvoiceLabel',
    'scheduleDrawerCourseEquipmentModeLabel',
    'scheduleDrawerFormatEquipmentInvoiceLabel',
    'scheduleDrawerFormatDaysTimesUnit',
    'scheduleDrawerFormatDaysAvgUnit',
    'scheduleDrawerBuildCommercialLines',
    'scheduleDrawerFormatCommercialMathLabel',
    'scheduleDrawerDayHeaderLabel',
    'scheduleRenderMoneyHeadlineHtml',
    'scheduleRenderSunsetMoneyActionsHtml',
    'scheduleRenderSunsetRecordPaymentHtml',
    'scheduleRenderSunsetInvoiceCreditLabel',
    'scheduleRenderSunsetInvoiceCardHtml',
    'scheduleRenderSunsetViewDrawerHtml',
    'scheduleRenderViewDrawerHtml',
    'scheduleDrawerEur',
    'scheduleRenderDrawerPaymentSectionViewHtml',
  ];
  fns.forEach((name) => {
    const fnSrc = extractFunctionSource(viewModSrc, name);
    assert(`module defines ${name}`, !!fnSrc);
    if (fnSrc) vm.runInContext(`${fnSrc}\nthis.${name}=${name};`, ctx);
  });
  // The list above names the view owners under test; it does not name what they
  // call. Resolve the remainder against the view/portal/actions modules and the
  // template, or a helper that moved leaves the slice with a ReferenceError.
  const dangling = collectPortalFunctions(
    [viewModSrc, payModSrc, portalModSrc, ctrlModSrc, apiSrc].filter(Boolean),
    fns,
    { provided: Object.keys(ctx), omitProvided: true },
  );
  if (dangling.code) {
    const expose = dangling.resolved.map((n) => `this.${n}=${n};`).join('\n');
    vm.runInContext(`${dangling.code}\n${expose}`, ctx);
  }
  assert('every helper the view owners call is in scope',
    dangling.missing.length === 0 && dangling.unparsable.length === 0,
    `missing=${dangling.missing.join(',')} unparsable=${dangling.unparsable.join(',')}`);
  return ctx;
}

console.log('\nverify:sunset-schedule-drawer-view-ui\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const viewModSrc = fs.readFileSync(VIEW_MODULE, 'utf8');
const payModSrc = fs.readFileSync(PAY_MODULE, 'utf8');
const portalModSrc = fs.readFileSync(PORTAL_MODULE, 'utf8');
const ctrlModSrc = fs.existsSync(CTRL_MODULE) ? fs.readFileSync(CTRL_MODULE, 'utf8') : '';
const browserLoader = fs.readFileSync(BROWSER_SRC, 'utf8');

console.log('[1] Module files and injection');
assert('drawer view module exists', fs.existsSync(VIEW_MODULE));
assert('drawer view inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-view-ui */'));
assert('browser source loads drawer view module', browserLoader.includes('getSunsetScheduleDrawerViewBrowserSource'));
assert('inject chains portal + drawer view', browserLoader.includes('SCHEDULE_DRAWER_VIEW_INJECT_MARKER'));
assert('inline scheduleRenderViewDrawerHtml removed from staff-api', !apiSrc.includes('function scheduleRenderViewDrawerHtml('));
assert('inline scheduleDrawerEur removed from staff-api', !apiSrc.includes('function scheduleDrawerEur('));
assert('payment section wrapper in payment module', payModSrc.includes('function scheduleRenderDrawerPaymentSectionHtml('));
assert('payment wrapper removed from staff-api', !apiSrc.includes('function scheduleRenderDrawerPaymentSectionHtml('));
assert('payment section delegates to view module', payModSrc.includes('scheduleRenderDrawerPaymentSectionViewHtml'));

console.log('\n[2] View module must not fetch or compute prices');
assert('no fetch in view module', !/\bfetch\s*\(/.test(viewModSrc));
assert('no Math.max balance fallback in money headline', !/Math\.max\(sub\s*-\s*paid/.test(viewModSrc));
assert('uses schedulePortalStripeLinkFromCtx resolver', viewModSrc.includes('schedulePortalStripeLinkFromCtx'));
assert('money actions respect actionable flag', /resolved\.actionable|scheduleDrawerViewResolveStripe/.test(viewModSrc));

console.log('\n[3] Loading and typed error states');
const ctx = buildRenderCtx(viewModSrc, portalModSrc, apiSrc);
assert('loading html uses state-msg', ctx.scheduleRenderDrawerLoadingHtml().includes('state-msg'));
assert('error html escapes reason code', ctx.scheduleRenderDrawerErrorHtml('Failed', 'drawer_untrusted_booking_source').includes('drawer_untrusted_booking_source')
  && !ctx.scheduleRenderDrawerErrorHtml('Failed', '<script>').includes('<script>'));

console.log('\n[4] Staff + Luna parity — same canonical fields');
const STAFF_ROW = { record_source: 'staff_manual', booking_code: 'SS-STAFF-1', guest_name: 'Alex Staff' };
const LUNA_ROW = { record_source: 'luna_guest', booking_code: 'SS-LUNA-1', guest_name: 'Jamie Luna' };
const baseCtx = {
  booking_id: '11111111-1111-1111-1111-111111111111',
  booking_code: 'SS-TEST-1',
  guest_name: 'Test Guest',
  phone: '+34600000000',
  date_from: '2026-07-20',
  date_to: '2026-07-20',
  components: { course: { course_id: 'c1', course_label: 'Beginner', quantity: 2 } },
  payment: {
    subtotal_cents: 12000,
    paid_cents: 0,
    balance_due_cents: 12000,
    payment_status: 'unpaid',
    line_items: [{
      service_date: '2026-07-20',
      service_type: 'course',
      label: 'Beginner · 2',
      line_cents: 12000,
      quantity: 2,
      unit_amount_cents: 6000,
      component: 'course',
      course_id: 'c1',
    }],
    paid_payments: [],
  },
  stripe_available: true,
};

const staffHtml = ctx.scheduleRenderSunsetViewDrawerHtml(STAFF_ROW, baseCtx, true);
const lunaHtml = ctx.scheduleRenderSunsetViewDrawerHtml(LUNA_ROW, Object.assign({}, baseCtx, { guest_name: 'Jamie Luna' }), true);
['ps-drawer-payment-box', 'ps-invoice-card', 'Beginner', '€120.00', 'ps-drawer-edit'].forEach((needle) => {
  assert(`staff view includes ${needle}`, staffHtml.includes(needle));
  assert(`luna view includes ${needle}`, lunaHtml.includes(needle));
});
assert('no separate booking-section + payment-card pair',
  !staffHtml.includes('schedule.drawer.section.booking')
  && (staffHtml.match(/ps-drawer-payment-box/g) || []).length === 1);

console.log('\n[5] Invoice fixtures — arithmetic, credits, no date/service/payment duplication');
assert('eur formatting from server cents', ctx.scheduleDrawerEur(12000) === '€120.00');
assert('components summary shows course qty', ctx.scheduleFormatComponentsView(baseCtx.components).includes('× 2'));

// Fixture 1: €30 × 2 surfers × 5 days = €300 course
const courseDays = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'];
const courseItems = courseDays.map((d, i) => ({
  service_record_id: 'c-' + i,
  service_date: d,
  service_type: 'surf_lesson',
  label: 'Beginner · 2',
  line_cents: i === 0 ? 30000 : 0,
  quantity: 2,
  unit_amount_cents: 3000,
  component: 'course',
  course_id: 'beginner',
  course_label: 'Beginner',
}));
const courseCommercial = ctx.scheduleDrawerBuildCommercialLines(courseItems, null);
assert('fixture1: one commercial course line €300',
  courseCommercial.lines.length === 1
  && courseCommercial.lines[0].line_cents === 30000
  && courseCommercial.lines[0].math_mode === 'linear'
  && courseCommercial.lines[0].unit_cents === 3000
  && courseCommercial.lines[0].quantity === 2
  && courseCommercial.lines[0].billable_days === 5);
const courseHtml = ctx.scheduleRenderSunsetInvoiceCardHtml({
  date_from: '2026-07-20',
  date_to: '2026-07-24',
  components: { course: { quantity: 2, course_label: 'Beginner' } },
  payment: {
    subtotal_cents: 30000,
    paid_cents: 0,
    balance_due_cents: 30000,
    payment_status: 'unpaid',
    line_items: courseItems,
    paid_payments: [],
  },
  stripe_available: true,
});
assert('fixture1: invoice shows unit×surfers×days math',
  /€30\.00/.test(courseHtml) && /×\s*2/.test(courseHtml) && /×\s*5/.test(courseHtml));
assert('fixture1: date range once in header, not on service lines',
  (courseHtml.match(/20-07-26|2026-07-20/g) || []).length <= 2
  && !/ps-day-group/.test(courseHtml)
  && !/Show daily/.test(courseHtml));
assert('fixture1: line total right-aligned class',
  /ps-svc-amt|ps-invoice-amt/.test(courseHtml) && courseHtml.includes('€300.00'));

// Fixture 2: €20 × 2 sets × 5 days = €200 board+wetsuit
const bundleItems = [];
courseDays.forEach((d, i) => {
  bundleItems.push({
    service_record_id: 'b-' + i,
    service_date: d,
    service_type: 'surfboard',
    label: 'Surfboard · 2',
    line_cents: i === 0 ? 20000 : 0,
    quantity: 2,
    unit_amount_cents: 2000,
    offering_key: 'board_and_suit_rental',
    pricing_group_id: 'pg-bundle',
    bundle_part: 'surfboard',
    duration_key: '5_days',
  });
  bundleItems.push({
    service_record_id: 'w-' + i,
    service_date: d,
    service_type: 'wetsuit',
    label: 'Wetsuit · 2',
    line_cents: 0,
    quantity: 2,
    unit_amount_cents: 2000,
    offering_key: 'board_and_suit_rental',
    pricing_group_id: 'pg-bundle',
    bundle_part: 'wetsuit',
    duration_key: '5_days',
  });
});
const bundleCommercial = ctx.scheduleDrawerBuildCommercialLines(bundleItems, {
  offering_key: 'board_and_suit_rental',
  duration: '5_days',
  pricing_group_id: 'pg-bundle',
  quantity: 2,
});
assert('fixture2: one board+wetsuit commercial line €200',
  bundleCommercial.lines.length === 1
  && bundleCommercial.lines[0].is_bundle
  && bundleCommercial.lines[0].line_cents === 20000
  && bundleCommercial.lines[0].math_mode === 'linear'
  && bundleCommercial.lines[0].unit_cents === 2000
  && bundleCommercial.lines[0].quantity === 2
  && bundleCommercial.lines[0].billable_days === 5);
assert('fixture2/9: zero-value inventory peers hidden',
  Object.keys(bundleCommercial.hidden_ids).length === 10
  && !bundleCommercial.lines.some((l) => /Wetsuit/.test(l.label) && l.line_cents === 0 && !l.is_bundle));

// Fixture 3: nonlinear six-day package does not fabricate daily math
const packageItems = [
  {
    service_record_id: 'pkg1',
    service_date: '2026-08-01',
    service_type: 'surf_lesson',
    label: 'Six-day package · 1',
    line_cents: 18000,
    quantity: 1,
    unit_amount_cents: 18000,
    component: 'course',
    course_id: 'six-day',
    duration_key: '6_days',
  },
  {
    service_record_id: 'pkg2',
    service_date: '2026-08-02',
    service_type: 'surf_lesson',
    label: 'Six-day package · 1',
    line_cents: 0,
    quantity: 1,
    unit_amount_cents: 18000,
    component: 'course',
    course_id: 'six-day',
    duration_key: '6_days',
  },
  {
    service_record_id: 'pkg3',
    service_date: '2026-08-03',
    service_type: 'surf_lesson',
    label: 'Six-day package · 1',
    line_cents: 0,
    quantity: 1,
    unit_amount_cents: 18000,
    component: 'course',
    course_id: 'six-day',
    duration_key: '6_days',
  },
  {
    service_record_id: 'pkg4',
    service_date: '2026-08-04',
    service_type: 'surf_lesson',
    label: 'Six-day package · 1',
    line_cents: 0,
    quantity: 1,
    unit_amount_cents: 18000,
    component: 'course',
    course_id: 'six-day',
    duration_key: '6_days',
  },
  {
    service_record_id: 'pkg5',
    service_date: '2026-08-05',
    service_type: 'surf_lesson',
    label: 'Six-day package · 1',
    line_cents: 0,
    quantity: 1,
    unit_amount_cents: 18000,
    component: 'course',
    course_id: 'six-day',
    duration_key: '6_days',
  },
  {
    service_record_id: 'pkg6',
    service_date: '2026-08-06',
    service_type: 'surf_lesson',
    label: 'Six-day package · 1',
    line_cents: 0,
    quantity: 1,
    unit_amount_cents: 18000,
    component: 'course',
    course_id: 'six-day',
    duration_key: '6_days',
  },
];
const packageCommercial = ctx.scheduleDrawerBuildCommercialLines(packageItems, null);
assert('fixture3: package mode (not invented daily)',
  packageCommercial.lines.length === 1
  && packageCommercial.lines[0].line_cents === 18000
  && packageCommercial.lines[0].math_mode === 'package'
  && packageCommercial.lines[0].unit_cents === 18000
  && packageCommercial.lines[0].billable_days === 6);
const packageHtml = ctx.scheduleRenderSunsetInvoiceCardHtml({
  date_from: '2026-08-01',
  date_to: '2026-08-06',
  payment: {
    subtotal_cents: 18000,
    paid_cents: 0,
    balance_due_cents: 18000,
    line_items: packageItems,
    paid_payments: [],
  },
});
assert('fixture3: no fabricated €3.00 daily unit', !packageHtml.includes('€3.00'));

// Fixture 4: subtotal €500, manual −€100, balance €400
const partialHtml = ctx.scheduleRenderSunsetInvoiceCardHtml({
  booking_id: '11111111-1111-1111-1111-111111111111',
  date_from: '2026-07-20',
  date_to: '2026-07-24',
  payment: {
    subtotal_cents: 50000,
    paid_cents: 10000,
    balance_due_cents: 40000,
    payment_status: 'unpaid',
    line_items: courseItems.map((li, i) => Object.assign({}, li, {
      line_cents: i === 0 ? 50000 : 0,
      unit_amount_cents: 5000,
    })),
    paid_payments: [{
      payment_id: 'm1',
      amount_cents: 10000,
      method: 'bank_transfer',
      kind: 'manual',
    }],
  },
  stripe_available: true,
});
assert('fixture4: subtotal €500.00', partialHtml.includes('€500.00') && partialHtml.includes('Subtotal'));
assert('fixture4: negative manual credit −€100.00',
  /[−\-]\s*€100\.00|€-100\.00|-€100\.00/.test(partialHtml)
  && /bank transfer/i.test(partialHtml));
assert('fixture4: balance due €400.00',
  partialHtml.includes('€400.00')
  && (partialHtml.includes('Balance due') || partialHtml.includes('due')));
assert('fixture4: controls inside invoice card',
  partialHtml.includes('ps-drawer-stripe-link')
  && partialHtml.includes('ps-drawer-manual-submit')
  && partialHtml.includes('ps-drawer-payment-box'));

// Fixture 5: multiple paid rows + aggregate remainder fallback
const multiHtml = ctx.scheduleRenderSunsetInvoiceCardHtml({
  date_from: '2026-07-20',
  date_to: '2026-07-20',
  payment: {
    subtotal_cents: 20000,
    paid_cents: 15000,
    balance_due_cents: 5000,
    payment_status: 'unpaid',
    line_items: [{ service_date: '2026-07-20', service_type: 'course', label: 'Course · 1', line_cents: 20000, quantity: 1 }],
    paid_payments: [
      { payment_id: 'p1', amount_cents: 5000, method: 'in_store', kind: 'manual' },
      { payment_id: 'p2', amount_cents: 5000, method: 'link', kind: 'card' },
    ],
    paid_ledger_remainder_cents: 5000,
  },
});
assert('fixture5: two detailed credit lines + remainder fallback',
  (multiHtml.match(/[−\-]\s*€50\.00|€-50\.00|-€50\.00/g) || []).length >= 2
  && multiHtml.includes('Other payments'));

// Fixture 6: fully paid and overpaid/refund
const paidFullHtml = ctx.scheduleRenderSunsetInvoiceCardHtml({
  date_from: '2026-07-20',
  date_to: '2026-07-20',
  payment: {
    subtotal_cents: 12000,
    paid_cents: 12000,
    balance_due_cents: 0,
    payment_status: 'paid',
    refund_credit_cents: 0,
    line_items: baseCtx.payment.line_items,
    paid_payments: [{ payment_id: 'full', amount_cents: 12000, method: 'link', kind: 'card' }],
  },
});
assert('fixture6a: paid in full state', paidFullHtml.includes('Paid in full'));
const overpaidHtml = ctx.scheduleRenderSunsetInvoiceCardHtml({
  date_from: '2026-07-20',
  date_to: '2026-07-20',
  payment: {
    subtotal_cents: 10000,
    paid_cents: 15000,
    balance_due_cents: 0,
    payment_status: 'paid',
    refund_credit_cents: 5000,
    line_items: [{ service_date: '2026-07-20', service_type: 'course', label: 'Course · 1', line_cents: 10000, quantity: 1 }],
    paid_payments: [{ payment_id: 'over', amount_cents: 15000, method: 'link', kind: 'card' }],
  },
});
assert('fixture6b: refund/credit state when overpaid',
  overpaidHtml.includes('Refund / credit') && overpaidHtml.includes('€50.00'));

// Fixture 7: no duplicated date/service/payment cards
assert('fixture7: single invoice card class', (partialHtml.match(/ps-invoice-card/g) || []).length === 1);
assert('fixture7: no legacy money-card / daily schedule',
  !partialHtml.includes('ps-money-card')
  && !partialHtml.includes('Show daily')
  && !partialHtml.includes('ps-day-group'));

console.log('\n[5b] Invoice order + conservative daily equipment grouping');
const ceDates = [
  '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02',
  '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
];
const ceDailyItems = ceDates.map((d, i) => ({
  service_record_id: 'ce-' + i,
  service_date: d,
  service_type: 'addon_service',
  label: 'Surfboard + Wetsuit · During Course · 1',
  line_cents: 500,
  quantity: 1,
  unit_amount_cents: 500,
  unit_cents: 500,
  component: 'course_equipment',
  course_equipment: true,
  course_equipment_mode: 'during_course',
  offering_key: 'board_and_suit_rental',
  currency: 'EUR',
}));
const mixedOrderItems = [
  {
    service_record_id: 'course-1',
    service_date: '2026-07-30',
    service_type: 'surf_lesson',
    label: 'Beginner · 1',
    line_cents: 45000,
    quantity: 1,
    unit_amount_cents: 45000,
    component: 'course',
    course_id: 'beginner',
  },
  {
    service_record_id: 'rent-once',
    service_date: '2026-07-30',
    service_type: 'surfboard',
    label: 'Surfboard · 1',
    line_cents: 1500,
    quantity: 1,
    unit_amount_cents: 1500,
    offering_key: 'board_rental',
    duration_key: '1_day',
  },
  {
    service_record_id: 'accom-1',
    service_date: '2026-07-30',
    service_type: 'addon_service',
    label: 'Accommodation · 2026-07-30 → 2026-08-07 · 8 nights',
    line_cents: 24000,
    quantity: 1,
    unit_amount_cents: 24000,
    component: 'staff_accommodation',
    staff_accommodation: true,
    check_in: '2026-07-30',
    check_out: '2026-08-07',
    nights: 8,
  },
  {
    service_record_id: 'custom-1',
    service_date: '2026-07-30',
    service_type: 'addon_service',
    label: 'Discount',
    line_cents: -500,
    quantity: 1,
    unit_amount_cents: -500,
    component: 'staff_custom_line',
    staff_custom_line: true,
  },
].concat(ceDailyItems);

const mixedCommercial = ctx.scheduleDrawerBuildCommercialLines(mixedOrderItems, null);
assert('order: accommodation first among display lines',
  mixedCommercial.lines[0]
  && (mixedCommercial.lines[0].staff_accommodation
    || /Accommodation/i.test(String(mixedCommercial.lines[0].label || ''))));
const ranks = mixedCommercial.lines.map((l) => ctx.scheduleDrawerCommercialLineRank(l));
assert('order: ranks non-decreasing (accom → course → rental → custom)',
  ranks.every((r, i) => i === 0 || r >= ranks[i - 1]),
  JSON.stringify(ranks));
assert('group: eight identical CE days collapse to one line',
  mixedCommercial.lines.filter((l) => l.course_equipment || /Surfboard \+ Wetsuit/i.test(String(l.label || ''))).length === 1);
const ceLine = mixedCommercial.lines.find((l) => l.course_equipment || /Surfboard \+ Wetsuit/i.test(String(l.label || '')));
assert('group: CE summed cents = 8 × €5.00',
  ceLine && ceLine.line_cents === 4000,
  ceLine && String(ceLine.line_cents));
assert('group: CE billable_days = 8',
  ceLine && ceLine.billable_days === 8);
assert('group: CE math is linear unit×days (no date coverage subtitle)',
  ceLine
  && ceLine.math_mode === 'linear'
  && ceLine.unit_cents === 500
  && !ceLine.duration_label,
  ceLine && JSON.stringify({ mode: ceLine.math_mode, unit: ceLine.unit_cents, dur: ceLine.duration_label }));
const ceMath = ctx.scheduleDrawerFormatCommercialMathLabel(ceLine);
assert('group: CE math label is 8 days × €5.00/day',
  /8\s+days\s+×\s+€5\.00\/day/i.test(ceMath),
  ceMath);
assert('group: CE math has no calendar dates (was mistaken for prices)',
  !/\bJul\b|\bAug\b|2026-07|30\s*Jul|–|—/.test(ceMath + String(ceLine.duration_label || '')));

const mixedHtml = ctx.scheduleRenderSunsetInvoiceCardHtml({
  date_from: '2026-07-30',
  date_to: '2026-08-06',
  components: { course: { quantity: 1, course_label: 'Beginner' } },
  payment: {
    subtotal_cents: 70000,
    paid_cents: 0,
    balance_due_cents: 70000,
    payment_status: 'unpaid',
    line_items: mixedOrderItems,
    paid_payments: [],
  },
});
assert('render: grouped CE amount €40.00 once',
  (mixedHtml.match(/€40\.00/g) || []).length >= 1
  && (mixedHtml.match(/Surfboard \+ Wetsuit/g) || []).length <= 2);
assert('render: CE shows 8 days × €5.00/day, not date range',
  /8\s+days\s+×\s+€5\.00\/day/i.test(mixedHtml)
  && !/30\s*Jul|Jul\u2013|Jul–/i.test(mixedHtml));
assert('render: accommodation still present',
  /Accommodation/i.test(mixedHtml));
assert('render: custom discount line not merged away',
  /Discount/i.test(mixedHtml) || mixedHtml.includes('−') || mixedHtml.includes('-€5') || mixedHtml.includes('€-5') || mixedHtml.includes('€-5.00') || /€5\.00/.test(mixedHtml));

// Non-group cases: mismatched unit / mode / accommodation stay separate
const mismatchItems = [
  Object.assign({}, ceDailyItems[0], { service_record_id: 'm0', line_cents: 500, unit_amount_cents: 500 }),
  Object.assign({}, ceDailyItems[1], {
    service_record_id: 'm1',
    line_cents: 1000,
    unit_amount_cents: 1000,
    unit_cents: 1000,
  }),
  Object.assign({}, ceDailyItems[2], {
    service_record_id: 'm2',
    course_equipment_mode: 'all_day',
    label: 'Surfboard + Wetsuit · All Day · 1',
    line_cents: 500,
    unit_amount_cents: 500,
  }),
  {
    service_record_id: 'ac-x',
    service_date: '2026-07-30',
    service_type: 'addon_service',
    label: 'Accommodation · stay',
    line_cents: 10000,
    quantity: 1,
    unit_amount_cents: 10000,
    component: 'staff_accommodation',
    staff_accommodation: true,
  },
  {
    service_record_id: 'ac-y',
    service_date: '2026-08-01',
    service_type: 'addon_service',
    label: 'Accommodation · stay 2',
    line_cents: 10000,
    quantity: 1,
    unit_amount_cents: 10000,
    component: 'staff_accommodation',
    staff_accommodation: true,
  },
];
const mismatchCommercial = ctx.scheduleDrawerBuildCommercialLines(mismatchItems, null);
assert('non-group: mismatched CE unit/mode stay separate',
  mismatchCommercial.lines.filter((l) => /Surfboard \+ Wetsuit/i.test(String(l.label || ''))
    || l.course_equipment).length >= 2);
assert('non-group: accommodation never collapses',
  mismatchCommercial.lines.filter((l) => l.staff_accommodation || /Accommodation/i.test(String(l.label || ''))).length === 2);

// Multiple stays: each commercial line keeps its own DD-MM range + secondary math
const multiStayItems = [
  {
    service_record_id: 'stay-a',
    service_date: '2026-08-25',
    service_type: 'addon_service',
    label: 'Accommodation · 2026-08-25 → 2026-08-30 · 5 nights',
    line_cents: 50000,
    quantity: 1,
    unit_amount_cents: 50000,
    component: 'staff_accommodation',
    staff_accommodation: true,
    check_in: '2026-08-25',
    check_out: '2026-08-30',
    nights: 5,
    season_groups: [
      { title: 'High Season', nights: 5, nightly_cents: 10000, subtotal_cents: 50000 },
    ],
  },
  {
    service_record_id: 'stay-b',
    service_date: '2026-09-10',
    service_type: 'addon_service',
    label: 'Accommodation · 2026-09-10 → 2026-09-12 · 2 nights',
    line_cents: 16000,
    quantity: 1,
    unit_amount_cents: 16000,
    component: 'staff_accommodation',
    staff_accommodation: true,
    check_in: '2026-09-10',
    check_out: '2026-09-12',
    nights: 2,
    season_groups: [
      { title: 'Shoulder', nights: 2, nightly_cents: 8000, subtotal_cents: 16000 },
    ],
  },
];
const multiStayCommercial = ctx.scheduleDrawerBuildCommercialLines(multiStayItems, null);
const multiStayLines = multiStayCommercial.lines.filter((l) => l.staff_accommodation);
assert('multi-stay: two commercial accommodation lines (never merged)',
  multiStayLines.length === 2
  && multiStayLines[0].line_cents === 50000
  && multiStayLines[1].line_cents === 16000,
  String(multiStayLines.length));
const multiPrimaries = multiStayLines.map((l) => ctx.scheduleDrawerFormatAccommodationInvoiceLabel(l));
const multiSecondaries = multiStayLines.map((l) => ctx.scheduleDrawerFormatCommercialMathLabel(l));
assert('multi-stay: each line primary uses its own check_in/check_out DD-MM range',
  multiPrimaries[0] === 'Accommodation \u00b7 25-08 - 30-08'
  && multiPrimaries[1] === 'Accommodation \u00b7 10-09 - 12-09',
  JSON.stringify(multiPrimaries));
assert('multi-stay: each secondary uses its own nights × rate/night · season',
  multiSecondaries[0] === '5 nights \u00d7 \u20ac100.00/night \u00b7 High Season'
  && multiSecondaries[1] === '2 nights \u00d7 \u20ac80.00/night \u00b7 Shoulder',
  JSON.stringify(multiSecondaries));
assert('multi-stay: half-open night count is authoritative metadata (not calendar day count)',
  multiStayLines[0].nights === 5
  && multiStayLines[1].nights === 2
  // 25→30 inclusive calendar days would be 6; authoritative nights stay 5
  && !/6\s+nights/.test(multiSecondaries.join(' '))
  && /5\s+nights/.test(multiSecondaries[0]));
const multiStayHtml = ctx.scheduleRenderSunsetInvoiceCardHtml({
  date_from: '2026-08-01',
  date_to: '2026-09-30',
  components: {},
  payment: {
    subtotal_cents: 66000,
    paid_cents: 0,
    balance_due_cents: 66000,
    payment_status: 'unpaid',
    line_items: multiStayItems,
    paid_payments: [],
  },
});
assert('multi-stay render: both date ranges + both secondaries; two amounts; no season child rows',
  /Accommodation\s*·\s*25-08\s*-\s*30-08/.test(multiStayHtml)
  && /Accommodation\s*·\s*10-09\s*-\s*12-09/.test(multiStayHtml)
  && /5\s+nights\s*×\s*€100\.00\/night\s*·\s*High Season/.test(multiStayHtml)
  && /2\s+nights\s*×\s*€80\.00\/night\s*·\s*Shoulder/.test(multiStayHtml)
  && (multiStayHtml.match(/data-testid="ps-invoice-accommodation"/g) || []).length === 2
  && (multiStayHtml.match(/€500\.00/g) || []).length === 1
  && (multiStayHtml.match(/€160\.00/g) || []).length === 1
  && !/ps-invoice-accommodation-season/.test(multiStayHtml));
// Invoice header dates must not replace line-specific stay dates
assert('multi-stay: primary never falls back to invoice header date_from/date_to',
  (() => {
    const blocks = multiStayHtml.match(/data-testid="ps-invoice-accommodation"[\s\S]*?<\/div>/g) || [];
    if (blocks.length !== 2) return false;
    const joined = blocks.join('\n');
    return !/Accommodation\s*·\s*01-08\s*-\s*30-09/.test(joined)
      && !/\b01-08\b/.test(joined)
      && !/\b30-09\b/.test(joined)
      && /25-08\s*-\s*30-08/.test(joined)
      && /10-09\s*-\s*12-09/.test(joined);
  })());

// Arithmetic preserved: source sum == commercial sum
const sourceSum = mixedOrderItems.reduce((a, li) => a + Number(li.line_cents || 0), 0);
const commercialSum = mixedCommercial.lines.reduce((a, li) => a + Number(li.line_cents || 0), 0);
assert('arithmetic: commercial sum equals source line sum',
  sourceSum === commercialSum,
  `source=${sourceSum} commercial=${commercialSum}`);

console.log('\n[5c] Screenshot invoice math cleanup (display-only)');
// Screenshot commercial metadata: Accommodation €700 + Curso €228.57 + CE 8×€5 = €968.57
const shotCeItems = ceDates.map((d, i) => ({
  service_record_id: 'shot-ce-' + i,
  service_date: d,
  service_type: 'addon_service',
  label: 'Surfboard + Wetsuit · During Course · 1',
  line_cents: 500,
  quantity: 1,
  unit_amount_cents: 500,
  unit_cents: 500,
  component: 'course_equipment',
  course_equipment: true,
  course_equipment_mode: 'during_course',
  offering_key: 'board_and_suit_rental',
  currency: 'EUR',
}));
const shotCourseDays = ceDates.map((d, i) => ({
  service_record_id: 'shot-course-' + i,
  service_date: d,
  service_type: 'surf_lesson',
  label: 'Curso Mañana · 1',
  line_cents: i === 0 ? 22857 : 0,
  quantity: 1,
  unit_amount_cents: 22857,
  component: 'course',
  course_id: 'curso-manana',
  course_label: 'Curso Mañana',
}));
const shotItems = [
  {
    service_record_id: 'shot-accom',
    service_date: '2026-07-30',
    service_type: 'addon_service',
    label: 'Accommodation · 2026-07-30 → 2026-08-06 · 7 nights',
    line_cents: 70000,
    quantity: 1,
    unit_amount_cents: 70000,
    component: 'staff_accommodation',
    staff_accommodation: true,
    check_in: '2026-07-30',
    check_out: '2026-08-06',
    nights: 7,
    season_groups: [
      { title: 'High Season', nights: 7, nightly_cents: 10000, subtotal_cents: 70000 },
    ],
  },
].concat(shotCourseDays).concat(shotCeItems);

const shotCommercial = ctx.scheduleDrawerBuildCommercialLines(shotItems, null);
const shotAccomLines = shotCommercial.lines.filter((l) => l.staff_accommodation
  || /^Accommodation\b/i.test(String(l.label || '')));
assert('shot: one accommodation commercial line only',
  shotAccomLines.length === 1,
  String(shotAccomLines.length));
assert('shot: accommodation amount €700 once (no season child total)',
  shotAccomLines[0] && shotAccomLines[0].line_cents === 70000);
const shotAccomPrimary = ctx.scheduleDrawerFormatAccommodationInvoiceLabel(shotAccomLines[0]);
const shotAccomSecondary = ctx.scheduleDrawerFormatCommercialMathLabel(shotAccomLines[0]);
assert('shot: accommodation primary is DD-MM stay range (no nights / season / ISO / amount math)',
  shotAccomLines[0]
  && /^Accommodation\s*·\s*30-07\s*-\s*06-08$/i.test(shotAccomPrimary)
  && !/nights?|High Season|×|2026-07-30|2026-08-06/i.test(shotAccomPrimary)
  && !/High Season|×|2026-07-30|2026-08-06/i.test(String(shotAccomLines[0].label || '')),
  `primary=${shotAccomPrimary} label=${shotAccomLines[0] && shotAccomLines[0].label}`);
assert('shot: accommodation secondary is nights × rate/night · season via existing subtitle',
  /^7\s+nights\s*×\s*€100\.00\/night\s*·\s*High Season$/i.test(shotAccomSecondary)
  && shotAccomSecondary === ctx.scheduleDrawerFormatAccommodationSeasonSubtitle(shotAccomLines[0]),
  shotAccomSecondary);
assert('shot: DD-MM derived from line check_in/check_out (not header, not hardcoded shape alone)',
  ctx.scheduleDrawerFormatAccommodationDdMm(shotAccomLines[0].check_in) === '30-07'
  && ctx.scheduleDrawerFormatAccommodationDdMm(shotAccomLines[0].check_out) === '06-08'
  && ctx.scheduleDrawerFormatAccommodationInvoiceLabel({
    check_in: '2026-08-25',
    check_out: '2026-08-30',
    nights: 5,
  }) === 'Accommodation \u00b7 25-08 - 30-08'
  && ctx.scheduleDrawerFormatAccommodationInvoiceLabel({
    check_in: '2026-01-09',
    check_out: '2026-01-12',
    nights: 3,
  }) === 'Accommodation \u00b7 09-01 - 12-01');
assert('shot: primary omits dates when check_in/check_out unavailable (fail closed)',
  ctx.scheduleDrawerFormatAccommodationInvoiceLabel({
    label: 'Accommodation · 7 nights',
    nights: 7,
    season_groups: [{ title: 'High Season', nights: 7, nightly_cents: 10000 }],
  }) === 'Accommodation');
const shotCourseLine = shotCommercial.lines.find((l) => /Curso Mañana/i.test(String(l.label || ''))
  || (l.component === 'course' && !l.course_equipment));
assert('shot: course package amount €228.57 preserved',
  shotCourseLine && shotCourseLine.line_cents === 22857,
  shotCourseLine && String(shotCourseLine.line_cents));
const shotCoursePrimary = ctx.scheduleDrawerFormatCourseInvoiceLabel(shotCourseLine);
const shotCourseMath = ctx.scheduleDrawerFormatCommercialMathLabel(shotCourseLine);
assert('shot: course primary is service label only',
  /^Curso Mañana$/i.test(shotCoursePrimary)
  && !/days|avg|×|€/i.test(shotCoursePrimary),
  shotCoursePrimary);
assert('shot: course uses avg daily (22857 ¢ does not divide by 8)',
  /8\s+days\s*·\s*avg\s*€28\.57\/day/i.test(shotCourseMath)
  && !/8\s+days\s*×\s*€28\.57\/day/i.test(shotCourseMath),
  shotCourseMath);
assert('shot: course uses stacked secondary (not inline)',
  ctx.scheduleDrawerUsesStackedSvcDetail(shotCourseLine) === true);
const shotExactCourse = {
  label: 'Exact Daily Course',
  line_cents: 24000,
  quantity: 1,
  billable_days: 8,
  unit_cents: 24000,
  math_mode: 'package',
  component: 'course',
  service_type: 'surf_lesson',
};
assert('shot: course exact daily when cents divide',
  /8\s+days\s*×\s*€30\.00\/day/i.test(ctx.scheduleDrawerFormatCommercialMathLabel(shotExactCourse)));
assert('shot: exact-daily primary is service label only',
  /^Exact Daily Course$/i.test(ctx.scheduleDrawerFormatCourseInvoiceLabel(shotExactCourse)));
const shotCe = shotCommercial.lines.find((l) => l.course_equipment
  || /Surfboard \+ Wetsuit/i.test(String(l.label || '')));
const shotCePrimary = ctx.scheduleDrawerFormatEquipmentInvoiceLabel(shotCe);
const shotCeMath = ctx.scheduleDrawerFormatCommercialMathLabel(shotCe);
assert('shot: equipment 8×€5 = €40, linear, no dates',
  shotCe
  && shotCe.line_cents === 4000
  && shotCe.math_mode === 'linear'
  && shotCe.unit_cents === 500
  && /8\s+days\s*×\s*€5\.00\/day/i.test(shotCeMath),
  shotCe && JSON.stringify(shotCe));
assert('shot: equipment primary keeps mode; secondary is arithmetic only',
  /^Surfboard \+ Wetsuit\s*·\s*During Course$/i.test(shotCePrimary)
  && /8\s+days\s*×\s*€5\.00\/day/i.test(shotCeMath)
  && !/During Course|All Day/i.test(shotCeMath),
  `primary=${shotCePrimary} secondary=${shotCeMath}`);
assert('shot: equipment uses stacked secondary (not inline)',
  ctx.scheduleDrawerUsesStackedSvcDetail(shotCe) === true);
const shotSum = shotCommercial.lines.reduce((a, l) => a + Number(l.line_cents || 0), 0);
const shotSource = shotItems.reduce((a, l) => a + Number(l.line_cents || 0), 0);
assert('shot: commercial sum unchanged vs source (€968.57)',
  shotSum === 96857 && shotSource === 96857,
  `source=${shotSource} commercial=${shotSum}`);
const ranksShot = shotCommercial.lines.map((l) => ctx.scheduleDrawerCommercialLineRank(l));
assert('shot: order Accommodation → course → equipment',
  ranksShot[0] === 0
  && ranksShot.some((r, i) => r === 1 && (i === 0 || ranksShot[i - 1] <= 1))
  && ranksShot.every((r, i) => i === 0 || r >= ranksShot[i - 1]),
  JSON.stringify(ranksShot));

// Cross-season: each segment inline; still one right-side amount
const crossItems = [{
  service_record_id: 'cross-ac',
  service_date: '2026-06-28',
  service_type: 'addon_service',
  label: 'Accommodation · 2026-06-28 → 2026-07-03 · 5 nights',
  line_cents: 44000,
  quantity: 1,
  unit_amount_cents: 44000,
  component: 'staff_accommodation',
  staff_accommodation: true,
  check_in: '2026-06-28',
  check_out: '2026-07-03',
  nights: 5,
  season_groups: [
    { title: 'Low', nights: 3, nightly_cents: 8000, subtotal_cents: 24000 },
    { title: 'High', nights: 2, nightly_cents: 10000, subtotal_cents: 20000 },
  ],
}];
const crossCommercial = ctx.scheduleDrawerBuildCommercialLines(crossItems, null);
assert('cross-season: one line, amount = stay total only',
  crossCommercial.lines.length === 1
  && crossCommercial.lines[0].line_cents === 44000);
const crossPrimary = ctx.scheduleDrawerFormatAccommodationInvoiceLabel(crossCommercial.lines[0]);
const crossSecondary = ctx.scheduleDrawerFormatCommercialMathLabel(crossCommercial.lines[0]);
assert('cross-season: primary is line stay DD-MM range only',
  /^Accommodation\s*·\s*28-06\s*-\s*03-07$/i.test(crossPrimary)
  && !/nights?|Low|High|×|2026-06-28|2026-07-03/i.test(crossPrimary),
  crossPrimary);
assert('cross-season: both authoritative segments on secondary (nights×rate/night · season), no average, no ISO',
  /^3\s+nights\s*×\s*€80\.00\/night\s*·\s*Low;\s*2\s+nights\s*×\s*€100\.00\/night\s*·\s*High$/i.test(crossSecondary)
  && !/€88|€90|average|avg/i.test(crossSecondary)
  && !/2026-06-28|2026-07-03/.test(crossSecondary)
  && !/Low|High|×/i.test(String(crossCommercial.lines[0].label || '')),
  `secondary=${crossSecondary} label=${crossCommercial.lines[0].label}`);
assert('cross-season: segment nights sum to authoritative stay nights (half-open), amount still stay total',
  crossCommercial.lines[0].nights === 5
  && crossCommercial.lines[0].season_groups[0].nights
    + crossCommercial.lines[0].season_groups[1].nights === 5
  && crossCommercial.lines[0].line_cents === 44000);

const shotHtml = ctx.scheduleRenderSunsetInvoiceCardHtml({
  date_from: '2026-07-30',
  date_to: '2026-08-06',
  components: { course: { quantity: 1, course_label: 'Curso Mañana' } },
  payment: {
    subtotal_cents: 96857,
    paid_cents: 0,
    balance_due_cents: 96857,
    payment_status: 'unpaid',
    line_items: shotItems,
    paid_payments: [],
  },
});
assert('shot render: subtotal €968.57',
  /id="ps-drawer-subtotal"[^>]*>€968\.57</.test(shotHtml) || shotHtml.includes('€968.57'));
assert('shot render: €700 appears once (no duplicate season amount)',
  (shotHtml.match(/€700\.00/g) || []).length === 1,
  String((shotHtml.match(/€700\.00/g) || []).length));
assert('shot render: one accommodation item, two text lines (primary + ps-svc-detail), one amount',
  (() => {
    const m = shotHtml.match(
      /data-testid="ps-invoice-accommodation"[^>]*>[\s\S]*?<span class="ps-svc-name">([\s\S]*?)<\/span>\s*<span class="ps-svc-amt[^"]*">([^<]*)<\/span>/,
    );
    if (!m) return false;
    const nameBlock = m[1];
    const amt = m[2];
    const primaryOk = /Accommodation\s*·\s*30-07\s*-\s*06-08/i.test(nameBlock)
      && !/Accommodation\s*·\s*30-07\s*-\s*06-08\s*·\s*High Season/i.test(nameBlock)
      && !/7\s*nights/i.test(nameBlock.replace(/<span class="ps-svc-detail">[\s\S]*$/, ''));
    const secondaryOk = /<span class="ps-svc-detail">7\s+nights\s*×\s*€100\.00\/night\s*·\s*High Season<\/span>/i.test(nameBlock);
    const noIso = !/2026-07-30|2026-08-06/.test(nameBlock);
    const oneAmt = amt === '€700.00';
    return primaryOk && secondaryOk && noIso && oneAmt
      && (shotHtml.match(/data-testid="ps-invoice-accommodation"/g) || []).length === 1;
  })(),
  'expected primary DD-MM range + secondary nights×rate/night · season + single €700.00');
assert('shot render: no season child row testids / no ISO stay dates on accom line',
  !/ps-invoice-accommodation-season/.test(shotHtml)
  && /ps-invoice-accommodation/.test(shotHtml)
  && /High Season/.test(shotHtml)
  && !/Accommodation[^<]*2026-07-30/.test(shotHtml));

function findInvoiceNameAmt(html, primaryRe) {
  const re = /class="ps-svc-summary-row ps-invoice-line([^"]*)"[^>]*>[\s\S]*?<span class="ps-svc-name">([\s\S]*?)<\/span>\s*<span class="ps-svc-amt[^"]*">([^<]*)<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    if (primaryRe.test(m[2])) {
      return { rowClass: m[1], nameBlock: m[2], amt: m[3] };
    }
  }
  return null;
}
function primaryTextFromNameBlock(nameBlock) {
  return String(nameBlock || '').replace(/<span class="ps-svc-detail">[\s\S]*$/, '').trim();
}

assert('shot render: course primary/secondary lines separated, one amount €228.57',
  (() => {
    const hit = findInvoiceNameAmt(shotHtml, /Curso Mañana/i);
    if (!hit) return false;
    const primary = primaryTextFromNameBlock(hit.nameBlock);
    const secondaryOk = /<span class="ps-svc-detail">8\s+days\s*·\s*avg\s*€28\.57\/day<\/span>/i.test(hit.nameBlock);
    const noInlineDot = !/<span class="ps-svc-detail">\s*·/.test(hit.nameBlock);
    const classOk = /\bis-course-line\b/.test(hit.rowClass);
    return /^Curso Mañana$/i.test(primary)
      && secondaryOk
      && noInlineDot
      && classOk
      && hit.amt === '€228.57'
      && (shotHtml.match(/€228\.57/g) || []).length === 1;
  })(),
  'expected Curso Mañana + grey avg secondary + single €228.57');
assert('shot render: exact-daily course primary label only + secondary days×rate',
  (() => {
    const exactHtml = ctx.scheduleRenderSunsetInvoiceCardHtml({
      date_from: '2026-07-30',
      date_to: '2026-08-06',
      components: { course: { quantity: 1, course_label: 'Exact Daily Course' } },
      payment: {
        subtotal_cents: 24000,
        paid_cents: 0,
        balance_due_cents: 24000,
        payment_status: 'unpaid',
        line_items: [{
          service_record_id: 'exact-course',
          service_date: '2026-07-30',
          service_type: 'surf_lesson',
          label: 'Exact Daily Course',
          line_cents: 24000,
          quantity: 1,
          unit_amount_cents: 24000,
          component: 'course',
          course_id: 'exact',
          course_label: 'Exact Daily Course',
          // Force multi-day package math path via covered dates on collapsed peers.
        }].concat(ceDates.slice(1).map((d, i) => ({
          service_record_id: 'exact-course-' + (i + 1),
          service_date: d,
          service_type: 'surf_lesson',
          label: 'Exact Daily Course',
          line_cents: 0,
          quantity: 1,
          unit_amount_cents: 24000,
          component: 'course',
          course_id: 'exact',
          course_label: 'Exact Daily Course',
        }))),
        paid_payments: [],
      },
    });
    const hit = findInvoiceNameAmt(exactHtml, /Exact Daily Course/i);
    if (!hit) return false;
    const primary = primaryTextFromNameBlock(hit.nameBlock);
    // Line amount once in commercial rows (subtotal/balance also show €240.00 — ignore totals).
    const lineAmtCount = (exactHtml.match(/ps-svc-amt ps-invoice-amt">€240\.00</g) || []).length;
    return /^Exact Daily Course$/i.test(primary)
      && /<span class="ps-svc-detail">8\s+days\s*×\s*€30\.00\/day<\/span>/i.test(hit.nameBlock)
      && !/<span class="ps-svc-detail">\s*·/.test(hit.nameBlock)
      && /\bis-course-line\b/.test(hit.rowClass)
      && hit.amt === '€240.00'
      && lineAmtCount === 1;
  })(),
  'expected Exact Daily Course + 8 days × €30.00/day secondary + one line amount');
assert('shot render: equipment primary keeps mode; secondary arithmetic; one amount €40.00',
  (() => {
    const hit = findInvoiceNameAmt(shotHtml, /Surfboard \+ Wetsuit/i);
    if (!hit) return false;
    const primary = primaryTextFromNameBlock(hit.nameBlock);
    const secondaryOk = /<span class="ps-svc-detail">8\s+days\s*×\s*€5\.00\/day<\/span>/i.test(hit.nameBlock);
    const modeNotInSecondary = !/<span class="ps-svc-detail">[^<]*(During Course|All Day)/i.test(hit.nameBlock);
    const noInlineDot = !/<span class="ps-svc-detail">\s*·/.test(hit.nameBlock);
    const classOk = /\bis-equipment-line\b/.test(hit.rowClass);
    return /^Surfboard \+ Wetsuit\s*·\s*During Course$/i.test(primary)
      && secondaryOk
      && modeNotInSecondary
      && noInlineDot
      && classOk
      && hit.amt === '€40.00'
      && (shotHtml.match(/€40\.00/g) || []).length === 1;
  })(),
  'expected Surfboard + Wetsuit · During Course + 8 days × €5.00/day + single €40.00');
assert('shot render: stacked secondary CSS classes present for course/equipment',
  /is-course-line/.test(shotHtml)
  && /is-equipment-line/.test(shotHtml)
  && /is-accommodation-line/.test(shotHtml)
  && /is-course-line \.ps-svc-detail/.test(apiSrc)
  && /is-equipment-line \.ps-svc-detail/.test(apiSrc));
assert('shot render: course avg daily + equipment exact math + no Jul date on CE',
  /avg\s*€28\.57\/day/i.test(shotHtml)
  && /8\s+days\s*×\s*€5\.00\/day/i.test(shotHtml)
  && !/30\s*Jul/i.test(shotHtml));
assert('shot render: commercial line amounts sum to subtotal authority',
  (() => {
    // Subtotal is pay.subtotal_cents (authoritative); line amounts must not invent extra €700
    return (shotHtml.match(/€700\.00/g) || []).length === 1
      && (shotHtml.match(/€228\.57/g) || []).length === 1
      && (shotHtml.match(/€40\.00/g) || []).length === 1
      && shotHtml.includes('€968.57');
  })());

console.log('\n[6] Payment link display');
const unpaidCtx = Object.assign({}, baseCtx, {
  stripe_link: { checkout_url: 'https://checkout.stripe.com/pay/cs_test_abc', actionable: true },
});
const unpaidHtml = ctx.scheduleRenderSunsetMoneyActionsHtml(unpaidCtx);
assert('active unpaid link is actionable', unpaidHtml.includes('ps-drawer-stripe-url') && unpaidHtml.includes('href='));

const cancelledCtx = Object.assign({}, baseCtx, {
  payment_link_invalidated: true,
  stripe_link: { checkout_url: 'https://checkout.stripe.com/pay/cs_old', actionable: false },
});
const cancelledHtml = ctx.scheduleRenderSunsetMoneyActionsHtml(cancelledCtx);
assert('invalidated link hidden (no checkout anchor)', !cancelledHtml.includes('checkout.stripe.com'));
assert('create link button when no actionable url', cancelledHtml.includes('ps-drawer-stripe-link'));

console.log('\n[7] XSS — guest/course labels and notes escaped');
const xssCtx = Object.assign({}, baseCtx, {
  guest_name: '<img onerror=alert(1)>',
  notes: '<script>x</script>',
  components: { course: { course_label: '<b>Evil</b>', quantity: 1 } },
});
const xssHtml = ctx.scheduleRenderSunsetViewDrawerHtml(STAFF_ROW, xssCtx, false);
assert('guest name escaped', xssHtml.includes('&lt;img') && !xssHtml.includes('<img onerror'));
assert('notes escaped', xssHtml.includes('&lt;script&gt;') && !xssHtml.includes('<script>x</script>'));
assert('course label escaped when rendered', !xssHtml.includes('<b>Evil</b>'));

console.log('\n[8] Empty optional fields');
const sparseCtx = { booking_id: '22222222-2222-2222-2222-222222222222', payment: {} };
const sparseHtml = ctx.scheduleRenderSunsetViewDrawerHtml(STAFF_ROW, sparseCtx, false);
assert('missing phone shows safely', sparseHtml.includes('portal-schedule-drawer-kv') || sparseHtml.includes('portal-schedule-drawer-hero'));
assert('empty payment eur dash', ctx.scheduleDrawerEur(null) === '—');
assert('empty components summary', ctx.scheduleFormatComponentsView(null) === '—');

console.log('\n[9] Wolfhouse classic view path preserved');
const whSandbox = {
  console,
  getClient: () => 'wolfhouse',
  isSunsetSurfActive: () => false,
  scheduleRowSourceDrawerLabel: () => 'Staff',
  scheduleDrawerCanEdit: () => false,
  scheduleRenderDrawerPaymentSectionHtml: (c) => ctx.scheduleRenderDrawerPaymentSectionViewHtml(c),
  schedulePaymentStatusLabel: (status) => (status === 'paid' ? 'Paid' : 'Unpaid'),
  scheduleRenderDrawerManualPaymentHtml: () => '',
  scheduleRenderDrawerStripeLinkSectionHtml: () => '',
  scheduleRenderDrawerOpenCustomerBtnHtml: () => '',
  scheduleRenderDrawerWaiverSectionHtml: () => '',
  scheduleRenderDeleteBookingRowHtml: () => '',
};
vm.createContext(whSandbox);
vm.runInContext(`function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}`, whSandbox);
vm.runInContext(`function portalT(k){return (${portalT.toString()})(k);}`, whSandbox);
['scheduleRenderViewDrawerHtml', 'scheduleRenderDrawerHeroHtml', 'scheduleRenderDrawerViewBookingDetailsHtml', 'scheduleDrawerSectionHtml', 'scheduleDrawerEur', 'scheduleRenderDrawerPaymentSectionViewHtml'].forEach((name) => {
  const fnSrc = extractFunctionSource(viewModSrc, name);
  if (fnSrc) vm.runInContext(`${fnSrc}\nthis.${name}=${name};`, whSandbox);
});
const whHtml = whSandbox.scheduleRenderViewDrawerHtml({ record_source: 'staff_manual', booking_code: 'WH-1' }, {
  guest_name: 'WH Guest',
  phone: null,
  date_from: '2026-08-01',
  date_to: '2026-08-03',
  payment: { subtotal_cents: 5000, paid_cents: 0, balance_due_cents: 5000, line_items: [] },
}, false);
assert('wolfhouse view renders guest hero', whHtml.includes('WH Guest'));
assert('wolfhouse hero booking code', whHtml.includes('portal-schedule-drawer-booking-code'));

console.log('\n[10] Mobile-friendly markup retained');
assert('drawer hero close aria', staffHtml.includes('aria-label'));
assert('money link row class', unpaidHtml.includes('ps-money-link-row'));
assert('invoice amount alignment class', /ps-svc-amt|ps-invoice-amt|text-align:\s*right/.test(staffHtml + partialHtml));
assert('openScheduleDetailDrawer uses view loading helper', ctrlModSrc.includes('scheduleRenderDrawerLoadingHtml()'));
assert('canonical remount after manual pay (no optimistic browser money)',
  payModSrc.includes('paymentRefetchAndRemount')
  && /record-cash-payment/.test(payModSrc)
  && !/paid_cents\s*\+\s*|balance_due_cents\s*-\s*/.test(payModSrc));

console.log(`\n── verify:sunset-schedule-drawer-view-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
process.exit(fail ? 1 : 0);
