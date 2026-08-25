'use strict';

/**
 * verify:sunset-booking-drawer-summary
 *
 * Offline checks for Sunset booking drawer header + view-mode summary cleanup.
 * Static source assertions only — no Staff API, DB, or network.
 *
 * Run:
 *   node scripts/verify-sunset-booking-drawer-summary.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAFF_API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const VIEW_MODULE_PATH = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const CTRL_MODULE_PATH = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-controller.js');
const I18N_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');
const I18N_ES_SUNSET_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es-sunset.js');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

function fnBody(src, name) {
  const re = new RegExp('function ' + name + '\\([^)]*\\)\\{');
  const m = re.exec(src);
  if (!m) return '';
  let i = m.index + m[0].length - 1;
  let depth = 0;
  let started = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') {
      depth--;
      if (started && depth === 0) return src.slice(m.index, i + 1);
    }
  }
  return '';
}

console.log('\nverify:sunset-booking-drawer-summary — drawer header + summary checks\n');

const apiSrc = fs.existsSync(STAFF_API_PATH) ? fs.readFileSync(STAFF_API_PATH, 'utf8') : '';
const viewModSrc = fs.existsSync(VIEW_MODULE_PATH) ? fs.readFileSync(VIEW_MODULE_PATH, 'utf8') : '';
const ctrlModSrc = fs.existsSync(CTRL_MODULE_PATH) ? fs.readFileSync(CTRL_MODULE_PATH, 'utf8') : '';
const drawerSrc = viewModSrc || apiSrc;
const i18nSrc = fs.existsSync(I18N_PATH) ? fs.readFileSync(I18N_PATH, 'utf8') : '';
const i18nEsSrc = fs.existsSync(I18N_ES_SUNSET_PATH) ? fs.readFileSync(I18N_ES_SUNSET_PATH, 'utf8') : '';

console.log('[1] Hero + view summary helpers');

assert('scheduleRenderDrawerHeroMetadataLine helper', drawerSrc.includes('function scheduleRenderDrawerHeroMetadataLine('));
assert('scheduleRenderDrawerViewBookingDetailsHtml helper', drawerSrc.includes('function scheduleRenderDrawerViewBookingDetailsHtml('));
assert('scheduleRenderDrawerViewDateRow helper', drawerSrc.includes('function scheduleRenderDrawerViewDateRow('));
assert('scheduleRenderDrawerBookedItemsRow helper', drawerSrc.includes('function scheduleRenderDrawerBookedItemsRow('));
assert('scheduleDrawerSameDay helper', drawerSrc.includes('function scheduleDrawerSameDay('));
assert('hero metadata CSS class', apiSrc.includes('portal-schedule-drawer-hero-meta'));
assert('hero title CSS class', apiSrc.includes('portal-schedule-drawer-hero-title'));
assert('icon close button class', apiSrc.includes('portal-schedule-drawer-close-btn'));

console.log('\n[2] View mode — no duplicate guest/source; dates + booked items');

const viewFn = fnBody(drawerSrc, 'scheduleRenderViewDrawerHtml');
const viewDetailsFn = fnBody(drawerSrc, 'scheduleRenderDrawerViewBookingDetailsHtml');
const dateRowFn = fnBody(drawerSrc, 'scheduleRenderDrawerViewDateRow');
const sunsetDetailsBranch = (function () {
  const marker = 'if (!isSunsetSurfActive())';
  const idx = viewDetailsFn.indexOf(marker);
  if (idx < 0) return '';
  const tail = viewDetailsFn.slice(idx + marker.length);
  const ret = tail.match(/\}\s*return\s+([\s\S]+);\s*\}$/);
  return ret ? ret[1] : '';
})();

assert('view drawer uses booking details helper', viewFn.includes('scheduleRenderDrawerViewBookingDetailsHtml(ctx, row)'));
assert('view details omit guest name row (Sunset branch)', !sunsetDetailsBranch.includes("portalT('schedule.create.guestName')"));
assert('view details omit source row (Sunset branch)', !sunsetDetailsBranch.includes("portalT('schedule.drawer.source')"));
assert('view details show phone', viewDetailsFn.includes("portalT('schedule.drawer.phone')"));
assert('view details include booked items row', viewDetailsFn.includes('scheduleRenderDrawerBookedItemsRow'));
assert('booked items uses scheduleFormatComponentsView', drawerSrc.includes('scheduleFormatComponentsView(comps)'));
assert('same-day date label key', dateRowFn.includes("'schedule.create.date'"));
assert('multi-day dates label key', dateRowFn.includes("'schedule.drawer.section.dates'"));
assert('same-day uses scheduleDrawerSameDay', dateRowFn.includes('scheduleDrawerSameDay(ctx)'));

console.log('\n[3] Hero — metadata line + accessible controls');

const heroFn = fnBody(drawerSrc, 'scheduleRenderDrawerHeroHtml');
assert('hero metadata line removed from Sunset hero', !heroFn.includes('portal-schedule-drawer-hero-meta'));
assert('hero school in metadata via scheduleResolveDrawerSchoolLabel', apiSrc.includes('scheduleResolveDrawerSchoolLabel(ctx, row)'));
assert('hero source in metadata via scheduleRowSourceDrawerLabel', apiSrc.includes('scheduleRowSourceDrawerLabel(row)'));
assert('refresh retains aria-label', heroFn.includes('id="ps-drawer-refresh"') && heroFn.includes('aria-label'));
assert('close retains aria-label (Sunset icon)', heroFn.includes('id="ps-drawer-close"') && heroFn.includes('aria-label'));
assert('close retains title', heroFn.includes('schedule.drawer.close'));
assert('booking code subdued class', heroFn.includes('portal-schedule-drawer-booking-code-subtle'));

console.log('\n[4] Preserved drawer IDs + Wolfhouse fallback');

assert('ps-drawer-refresh id preserved', (drawerSrc + apiSrc).includes('id="ps-drawer-refresh"'));
assert('ps-drawer-close id preserved', (drawerSrc + apiSrc).includes('id="ps-drawer-close"'));
assert('ps-drawer-edit id preserved', (drawerSrc + apiSrc).includes('id="ps-drawer-edit"'));
assert('ps-drawer-conversation-btn id preserved', (apiSrc + ctrlModSrc).includes('id="ps-drawer-conversation-btn"'));
assert('non-Sunset view fallback keeps legacy rows', viewDetailsFn.includes('!isSunsetSurfActive()'));
assert('drawer-scoped mobile CSS', apiSrc.includes('@media(max-width:420px){.portal-schedule-drawer-hero-inner'));

console.log('\n[5] i18n — booked items EN/ES parity');

assert('EN bookedItems key', i18nSrc.includes("'schedule.drawer.bookedItems': 'Booked items'"));
assert('ES bookedItems key', i18nEsSrc.includes("'schedule.drawer.bookedItems'"));

console.log('\n[6] Unified invoice card (replaces booking + payment cards)');

const sunsetViewFn = fnBody(drawerSrc, 'scheduleRenderSunsetViewDrawerHtml');
const invoiceCardFn = fnBody(drawerSrc, 'scheduleRenderSunsetInvoiceCardHtml');
const recordFn = fnBody(drawerSrc, 'scheduleRenderSunsetRecordPaymentHtml');
const paySectionFn = fnBody(drawerSrc, 'scheduleRenderDrawerPaymentSectionViewHtml');
const bookingDrawerLibPath = path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js');
const bookingDrawerLib = fs.existsSync(bookingDrawerLibPath)
  ? fs.readFileSync(bookingDrawerLibPath, 'utf8')
  : '';

assert('sunset view drawer helper exists', drawerSrc.includes('function scheduleRenderSunsetViewDrawerHtml('));
assert('invoice card helper exists', drawerSrc.includes('function scheduleRenderSunsetInvoiceCardHtml('));
assert('view drawer branches to sunset renderer', drawerSrc.includes('if (isSunsetSurfActive()) return scheduleRenderSunsetViewDrawerHtml('));
assert('sunset view uses one invoice card (no separate booking card)',
  sunsetViewFn.includes('scheduleRenderSunsetInvoiceCardHtml')
  && !sunsetViewFn.includes('scheduleRenderSunsetBookingCardHtml'));
assert('sunset view does not also render separate money card',
  !sunsetViewFn.includes('scheduleRenderSunsetMoneyCardHtml')
  && sunsetViewFn.indexOf('scheduleRenderDrawerPaymentSectionHtml') < 0);
assert('payment section view delegates to invoice card on Sunset',
  paySectionFn.includes('scheduleRenderSunsetInvoiceCardHtml')
  || drawerSrc.includes('if (isSunsetSurfActive()) return scheduleRenderSunsetInvoiceCardHtml'));
const payModSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-actions.js'), 'utf8');
const waiverModSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-actions.js'), 'utf8');
assert('payment section delegates to view module', payModSrc.includes('scheduleRenderDrawerPaymentSectionViewHtml'));
assert('payment section delegates to edit module', payModSrc.includes('scheduleRenderDrawerPaymentSectionEditHtml'));
assert('date-strip helper exists', drawerSrc.includes('function scheduleDrawerStripLabelDate('));
assert('invoice has no daily commercial breakdown',
  !invoiceCardFn.includes('schedule.drawer.showDaily')
  && !invoiceCardFn.includes('ps-day-group')
  && !invoiceCardFn.includes('scheduleDrawerDayHeaderLabel'));
assert('commercial lines omit ISO dates from labels',
  drawerSrc.includes('function scheduleDrawerStripLabelDate(')
  && bookingDrawerLib.includes('formatSunsetDrawerDailyItemLabel'));
assert('record-payment collapsible keeps manual IDs', recordFn.includes('id="ps-drawer-manual-submit"') && recordFn.includes('id="ps-drawer-manual-amount"'));
assert('record-payment prefills outstanding balance input', recordFn.includes('scheduleDrawerEurInputValue') && recordFn.includes('balance_due_cents'));
assert('invoice card preserves payment-box id', invoiceCardFn.includes('id="ps-drawer-payment-box"'));
assert('invoice keeps stripe copy/delete ids', drawerSrc.includes("'ps-drawer-stripe-copy'") && drawerSrc.includes('id="ps-drawer-stripe-delete"'));
assert('invoice keeps payment-link create id', drawerSrc.includes('id="ps-drawer-stripe-link"'));
assert('progress bar for group waiver', waiverModSrc.includes('ps-reg-progress-bar'));
assert('invoice footer uses paid_payments credits',
  invoiceCardFn.includes('paid_payments') || invoiceCardFn.includes('paid_ledger'));
assert('invoice shows balance/paid-in-full/refund states',
  invoiceCardFn.includes('paidInFull')
  && (invoiceCardFn.includes('balanceDue') || invoiceCardFn.includes('dueSuffix') || invoiceCardFn.includes('remaining'))
  && (invoiceCardFn.includes('refundCredit') || invoiceCardFn.includes('needsRefund') || invoiceCardFn.includes('refund')));

console.log('\n[6b] Presentation-safe paid ledger on drawer context');

assert('loadSunsetBookingBundle loads paid payment rows',
  /status\s*=\s*'paid'::payment_record_status/.test(bookingDrawerLib)
  && /FROM payments/.test(bookingDrawerLib));
assert('buildPaidPaymentLedger or paid_payments assembly present',
  /buildPaidPaymentLedger|paid_payments/.test(bookingDrawerLib));
assert('ledger excludes unpaid/cancelled/expired',
  /paid/.test(bookingDrawerLib)
  && !/status\s+IN\s*\(\s*'checkout_created'/.test(bookingDrawerLib));
assert('buildPaymentSummary returns paid_payments',
  /paid_payments/.test(bookingDrawerLib));
assert('aggregate remainder/fallback credit when rows do not sum',
  /paid_ledger_remainder|remainder_cents|ledger_remainder/.test(bookingDrawerLib));
const loadBundleStart = bookingDrawerLib.indexOf('async function loadSunsetBookingBundle');
const loadBundleEnd = bookingDrawerLib.indexOf('function buildPaidPaymentLedger', loadBundleStart);
const loadBundleFn = bookingDrawerLib.slice(loadBundleStart, loadBundleEnd);
assert('all payment reads are explicitly client-scoped',
  (loadBundleFn.match(/INNER JOIN clients c ON c\.id = b\.client_id/g) || []).length >= 3
  && (loadBundleFn.match(/c\.slug = \$2/g) || []).length === 3
  && (loadBundleFn.match(/\[booking\.booking_id, clientSlug\]/g) || []).length === 3);

console.log('\n[6c] Sunset booking-context overview order');

const bcDrawerFn = fnBody(apiSrc, 'renderBookingContextDrawer');
const bcPayIdx = bcDrawerFn.indexOf('bcRenderPaymentSummaryBriefHtml');
const bcCardIdx = bcDrawerFn.indexOf('bc-drawer-card-booking');
assert('Sunset booking-context payment summary precedes booking card',
  bcDrawerFn.includes("var isSunset = getClient() === 'sunset'") &&
  bcDrawerFn.includes('if (isSunset) {') &&
  bcDrawerFn.includes('if (!isSunset) {') &&
  bcPayIdx > -1 && bcCardIdx > -1 && bcPayIdx < bcCardIdx);
assert('non-Sunset booking-context keeps payment summary after booking card',
  bcDrawerFn.lastIndexOf('bcRenderRunningInvoiceHtml') > bcCardIdx);

console.log('\n[7] i18n — invoice + registration share hint EN/ES parity');
[
  'schedule.drawer.paidInFull',
  'schedule.drawer.createPaymentLink',
  'schedule.drawer.copyPaymentLink',
  'schedule.drawer.recordPayment',
  'schedule.drawer.daysWord',
  'schedule.drawer.subtotal',
  'schedule.drawer.balanceDue',
  'schedule.drawer.refundCredit',
  'schedule.drawer.paymentCredit',
  'schedule.drawer.waiverGroupShareHint',
].forEach(function (k) {
  assert('EN key ' + k, i18nSrc.includes("'" + k + "'"));
  assert('ES key ' + k, i18nEsSrc.includes("'" + k + "'"));
});
assert('EN share hint sentence',
  i18nSrc.includes("Share this link with the group. Each student should complete the form once."));
assert('ES share hint keeps Spanish sentence',
  i18nEsSrc.includes('Comparte este enlace con el grupo. Cada alumno debe completar el formulario una vez.'));
assert('waiver UI uses portalT share hint (not server multi_student_note)',
  waiverModSrc.includes("portalT('schedule.drawer.waiverGroupShareHint')")
  && !/escHtml\(\s*data\.multi_student_note\s*\)/.test(waiverModSrc));

console.log('\n[8] buildPaymentSummary paid ledger fixtures (pure)');

const {
  buildPaymentSummary,
  buildPaidPaymentLedger,
} = require('./lib/sunset-schedule-booking-drawer');

const partialLedger = buildPaidPaymentLedger([
  {
    payment_id: 'p1',
    payment_status: 'paid',
    amount_paid_cents: 10000,
    paid_at: '2026-07-01T10:00:00Z',
    metadata: { method: 'bank_transfer', source: 'staff_bank_transfer' },
  },
  {
    payment_id: 'p2',
    payment_status: 'checkout_created',
    amount_paid_cents: 0,
    metadata: { method: 'link' },
  },
  {
    payment_id: 'p3',
    payment_status: 'cancelled',
    amount_paid_cents: 5000,
    metadata: { method: 'in_store' },
  },
], 10000);
assert('ledger keeps only successful paid rows',
  partialLedger.rows.length === 1
  && partialLedger.rows[0].payment_id === 'p1'
  && partialLedger.rows[0].amount_cents === 10000
  && partialLedger.rows[0].method === 'bank_transfer');

const multiLedger = buildPaidPaymentLedger([
  {
    payment_id: 'a',
    payment_status: 'paid',
    amount_paid_cents: 4000,
    metadata: { method: 'in_store' },
  },
  {
    payment_id: 'b',
    payment_status: 'paid',
    amount_paid_cents: 3000,
    metadata: { method: 'link', source: 'stripe' },
  },
], 10000);
assert('multi paid rows + aggregate remainder',
  multiLedger.rows.length === 2
  && multiLedger.detailed_sum_cents === 7000
  && multiLedger.remainder_cents === 3000);

const excessDetailLedger = buildPaidPaymentLedger([
  {
    payment_id: 'over-detail-a',
    payment_status: 'paid',
    amount_paid_cents: 7000,
    metadata: { method: 'in_store' },
  },
  {
    payment_id: 'over-detail-b',
    payment_status: 'paid',
    amount_paid_cents: 5000,
    metadata: { method: 'link' },
  },
], 10000);
assert('ledger fails closed to aggregate credit when detailed rows exceed aggregate',
  excessDetailLedger.rows.length === 0
  && excessDetailLedger.detailed_sum_cents === 0
  && excessDetailLedger.remainder_cents === 10000);

const paySummary = buildPaymentSummary(
  [],
  {
    total_amount_cents: 50000,
    amount_paid_cents: 10000,
    balance_due_cents: 40000,
    payment_status: 'unpaid',
    metadata: {},
  },
  [{
    service_record_id: 'sr1',
    service_type: 'surf_lesson',
    service_date: '2026-07-20',
    quantity: 2,
    amount_due_cents: 50000,
    metadata: {
      component: 'course',
      course_label: 'Beginner',
      unit_amount_cents: 3000,
    },
  }],
  'config',
  10000,
  null,
  {
    paid_rows: [{
      payment_id: 'cash1',
      payment_status: 'paid',
      amount_paid_cents: 10000,
      metadata: { method: 'bank_transfer' },
    }],
  },
);
assert('payment summary exposes paid_payments credit row',
  Array.isArray(paySummary.paid_payments)
  && paySummary.paid_payments.length === 1
  && paySummary.paid_payments[0].amount_cents === 10000);
assert('payment summary keeps subtotal/paid/balance truth',
  paySummary.subtotal_cents === 50000
  && paySummary.paid_cents === 10000
  && paySummary.balance_due_cents === 40000);
assert('line items carry unit_amount_cents when stored',
  paySummary.line_items[0].unit_amount_cents === 3000);

const staleStoredBalanceLowPaid = buildPaymentSummary(
  [],
  {
    total_amount_cents: 50000,
    amount_paid_cents: 0,
    balance_due_cents: 50000,
    payment_status: 'unpaid',
    metadata: {},
  },
  [], 'config', 10000, null,
  { paid_rows: [{ payment_status: 'paid', amount_paid_cents: 10000, metadata: {} }] },
);
assert('displayed balance reconciles when payment ledger is ahead of booking aggregate',
  staleStoredBalanceLowPaid.paid_cents === 10000
  && staleStoredBalanceLowPaid.balance_due_cents === 40000);

const staleStoredBalanceHighPaid = buildPaymentSummary(
  [],
  {
    total_amount_cents: 50000,
    amount_paid_cents: 30000,
    balance_due_cents: 50000,
    payment_status: 'unpaid',
    metadata: {},
  },
  [], 'config', 10000, null,
  { paid_rows: [{ payment_status: 'paid', amount_paid_cents: 10000, metadata: {} }] },
);
assert('displayed balance reconciles when booking paid aggregate is ahead of detail',
  staleStoredBalanceHighPaid.paid_cents === 30000
  && staleStoredBalanceHighPaid.balance_due_cents === 20000
  && staleStoredBalanceHighPaid.paid_ledger_remainder_cents === 20000);

const ambiguousUnit = buildPaymentSummary(
  [],
  {
    total_amount_cents: 6000,
    amount_paid_cents: 0,
    balance_due_cents: 6000,
    payment_status: 'unpaid',
    metadata: {
      quote_line_items: [
        { component: 'course', offering_id: 'course-a', duration_key: '1_day', unit_amount_cents: 3000 },
        { component: 'course', offering_id: 'course-b', duration_key: '1_day', unit_amount_cents: 4000 },
      ],
    },
  },
  [{
    service_record_id: 'ambiguous-course', service_type: 'surf_lesson',
    service_date: '2026-07-20', quantity: 2, amount_due_cents: 6000,
    metadata: { component: 'course' },
  }],
  'config', 0, null, {},
);
assert('ambiguous component-only quote lines do not invent unit math',
  ambiguousUnit.line_items[0].unit_amount_cents === null);

const exactUnit = buildPaymentSummary(
  [],
  {
    total_amount_cents: 8000,
    amount_paid_cents: 0,
    balance_due_cents: 8000,
    payment_status: 'unpaid',
    metadata: {
      quote_line_items: [
        { component: 'course', offering_id: 'course-a', duration_key: '1_day', unit_amount_cents: 3000 },
        { component: 'course', offering_id: 'course-b', duration_key: '1_day', unit_amount_cents: 4000 },
      ],
    },
  },
  [{
    service_record_id: 'exact-course', service_type: 'surf_lesson',
    service_date: '2026-07-20', quantity: 2, amount_due_cents: 8000,
    metadata: { component: 'course', course_id: 'course-b', duration_key: '1_day' },
  }],
  'config', 0, null, {},
);
assert('exact offering and duration identity selects the matching quote unit',
  exactUnit.line_items[0].unit_amount_cents === 4000);

const overpaid = buildPaymentSummary(
  [],
  {
    total_amount_cents: 10000,
    amount_paid_cents: 15000,
    balance_due_cents: 0,
    payment_status: 'paid',
    metadata: {},
  },
  [],
  'config',
  15000,
  null,
  {
    paid_rows: [{
      payment_id: 'over1',
      payment_status: 'paid',
      amount_paid_cents: 15000,
      metadata: { method: 'link' },
    }],
  },
);
assert('overpaid summary flags refund credit cents',
  overpaid.paid_cents === 15000
  && overpaid.balance_due_cents === 0
  && Number(overpaid.refund_credit_cents) === 5000);

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-booking-drawer-summary — FAILED');
  process.exit(1);
}
console.log('verify:sunset-booking-drawer-summary — ALL CHECKS PASSED');
