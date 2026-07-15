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

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const VIEW_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const PAY_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-payment-ui.js');
const PORTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function extractFunctionSource(src, name) {
  const needle = `function ${name}(`;
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const braceStart = src.indexOf('{', start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
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
    'schedule.drawer.surferWord': 'surfer',
    'schedule.drawer.surfersWord': 'surfers',
    'schedule.drawer.dateLabel': 'Dates',
    'schedule.drawer.showDaily': 'Show daily',
    'schedule.drawer.paymentSection': 'Payment',
    'schedule.drawer.noLineItems': 'No line items',
    'schedule.drawer.remaining': 'Remaining',
    'schedule.col.payment': 'Payment',
    'schedule.payment.unpaid': 'Unpaid',
    'schedule.payment.paid': 'Paid',
    'schedule.drawer.methodBankTransfer': 'bank transfer',
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
    'scheduleDrawerDayHeaderLabel',
    'scheduleRenderMoneyHeadlineHtml',
    'scheduleRenderSunsetMoneyActionsHtml',
    'scheduleRenderSunsetRecordPaymentHtml',
    'scheduleRenderSunsetMoneyCardHtml',
    'scheduleRenderSunsetBookingCardHtml',
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
  return ctx;
}

console.log('\nverify:sunset-schedule-drawer-view-ui\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const viewModSrc = fs.readFileSync(VIEW_MODULE, 'utf8');
const payModSrc = fs.readFileSync(PAY_MODULE, 'utf8');
const portalModSrc = fs.readFileSync(PORTAL_MODULE, 'utf8');
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
    line_items: [{ service_date: '2026-07-20', service_type: 'course', label: 'Beginner course', line_cents: 12000, quantity: 2 }],
  },
  stripe_available: true,
};

const staffHtml = ctx.scheduleRenderSunsetViewDrawerHtml(STAFF_ROW, baseCtx, true);
const lunaHtml = ctx.scheduleRenderSunsetViewDrawerHtml(LUNA_ROW, Object.assign({}, baseCtx, { guest_name: 'Jamie Luna' }), true);
['ps-drawer-payment-box', 'ps-money-headline', 'Beginner', '€120.00', '2 surfers', 'ps-drawer-edit'].forEach((needle) => {
  assert(`staff view includes ${needle}`, staffHtml.includes(needle));
  assert(`luna view includes ${needle}`, lunaHtml.includes(needle));
});

console.log('\n[5] Course, tier, dates, quantity and € totals');
assert('eur formatting from server cents', ctx.scheduleDrawerEur(12000) === '€120.00');
assert('components summary shows course qty', ctx.scheduleFormatComponentsView(baseCtx.components).includes('× 2'));
assert('booking card shows line amount', staffHtml.includes('€120.00'));
assert('money subtotal from payment object', staffHtml.includes('€120.00'));

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

const paidCtx = Object.assign({}, baseCtx, {
  payment: Object.assign({}, baseCtx.payment, { paid_cents: 12000, balance_due_cents: 0, payment_status: 'paid' }),
  payment_method: 'link',
});
const paidHeadline = ctx.scheduleRenderMoneyHeadlineHtml(paidCtx);
assert('paid status headline', paidHeadline.includes('Paid in full'));

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
['scheduleRenderViewDrawerHtml', 'scheduleRenderDrawerHeroHtml', 'scheduleRenderDrawerViewBookingDetailsHtml', 'scheduleDrawerSectionHtml', 'scheduleDrawerEur'].forEach((name) => {
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
assert('openScheduleDetailDrawer uses view loading helper', apiSrc.includes('scheduleRenderDrawerLoadingHtml()'));

console.log(`\n── verify:sunset-schedule-drawer-view-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
process.exit(fail ? 1 : 0);
