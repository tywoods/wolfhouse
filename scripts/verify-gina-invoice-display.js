'use strict';

/**
 * GINA-INVOICE-DISPLAY-001
 *
 * Staff invoice drawer display only. Money totals stay on the existing
 * billable-cent sum. Run: node scripts/verify-gina-invoice-display.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const I18N = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');
const I18N_ES = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es.js');

let pass = 0;
let fail = 0;
function check(id, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${id}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${id}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

function extractFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') depth -= 1;
    if (depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

const apiSrc = fs.readFileSync(API, 'utf8');
const NAMES = [
  'bcStayNightsFromCheckInOut',
  'bcNightsLabel',
  'bcServiceRecordBillableCents',
  'bcParseServiceRecordMeta',
  'bcPluralUnit',
  'bcFormatRentalPeopleDaysLine',
  'bcResolveRentalPeopleFromMeta',
  'bcResolveRentalInvoiceDisplayQty',
  'bcResolveBoardRentalRateCents',
  'bcResolveRentalInvoiceUnitCents',
  'staffAddonUiTypeLabel',
  'bcRunningInvoiceSvcTypeLabel',
  'bcRunningInvoiceSvcUnitLabel',
  'bcRunningInvoiceSvcLineText',
  'bcFieldEditPackageDisplayLabel',
  'bcRunningInvoicePackageLabel',
  'bcQuoteRoomSupplementLine',
  'bcQuoteRoomSupplementCents',
  'bcAccommodationDisplayCents',
  'bcRunningInvoiceAccommodationCents',
  'bcInvoiceAccCentsWithSupplement',
  'bcPaymentLedgerIsPaidStatus',
  'bcPaymentLedgerPaidTotalCents',
  'bcIsActiveTransferForInvoice',
  'bcSumActiveTransferChargesCents',
  'bcTransferDirectionLabel',
  'bcTransferInvoiceLineItems',
  'bcComputeBookingInvoiceTotals',
  'bcRenderPrivateRoomSupplementLineHtml',
  'bcBookingStatusIsCancelled',
  'bcInvoiceGuestStaffLabel',
  'bcInvoiceGuestNameByNumber',
  'bcInvoicePackageLabelOrNull',
  'bcInvoicePaymentRequestDisplay',
  'bcInvoiceTitleCaseStatus',
  'bcInvoiceServiceRollupKey',
  'bcInvoiceRolledServiceLineText',
  'bcRollupInvoiceServiceDisplay',
  'bcRenderPerGuestPaymentsHtml',
  'bcRenderRunningInvoiceHtml',
  'bcRequestGuestPaymentLink',
  'bcInitPaymentLinkShell',
  'bcNewPaymentLinkIdempotencyKey',
  'bcBindCreateGuestPaymentLinkButtons',
  'bcInitGuestPaymentLinkShell',
];

const strings = {
  'drawer.invoice.accommodation': 'Accommodation',
  'drawer.invoice.services': 'Services',
  'drawer.invoice.transfers': 'Transfers',
  'drawer.invoice.totals': 'Totals',
  'drawer.invoice.invoiceTotal': 'Invoice total',
  'drawer.invoice.paid': 'Paid',
  'drawer.invoice.balanceDue': 'Balance due',
  'drawer.invoice.noServices': 'No services',
  'drawer.invoice.noTransfers': 'No transfers',
  'drawer.invoice.notAvailable': 'Not available',
  'drawer.invoice.guestLine': 'Guest {number} — {detail}',
  'drawer.invoice.unnamedGuest': 'Unnamed guest {number}',
  'drawer.invoice.createLink': 'Create link',
  'drawer.invoice.copyLink': 'Copy',
  'drawer.invoice.payStatus.pending': 'Pending',
  'drawer.invoice.payStatus.paid': 'Paid',
  'drawer.invoice.payStatus.deposit_paid': 'Deposit paid',
  'drawer.invoice.payStatus.checkout_created': 'Checkout created',
  'drawer.invoice.payStatus.draft': 'Draft',
  'drawer.invoice.payStatus.waived': 'Waived',
  'drawer.invoice.payStatus.refunded': 'Refunded',
  'drawer.invoice.payStatus.failed': 'Failed',
  'drawer.invoice.payStatus.cancelled': 'Cancelled',
  'drawer.invoice.payStatus.expired': 'Expired',
  'drawer.field.night': 'night',
  'drawer.field.nightsPlural': 'nights',
  'drawer.payments.generateBalanceLink': 'Generate link',
  'drawer.payments.linkFailed': 'Payment link failed',
  'drawer.payments.linkReady': 'Payment link ready',
  'drawer.transfers.arrival': 'Arrival',
  'drawer.transfers.departure': 'Departure',
  'drawer.tab.transfers': 'Transfers',
};

function t(key, vars) {
  let text = strings[key] || key;
  if (vars) {
    Object.keys(vars).forEach((k) => {
      text = String(text).split(`{${k}}`).join(String(vars[k]));
    });
  }
  return text;
}
function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const extracted = [];
for (const name of NAMES) {
  try {
    extracted.push(extractFunctionSource(apiSrc, name));
  } catch (err) {
    extracted.push(`function ${name}(){ throw new Error(${JSON.stringify(err.message)}); }`);
  }
}

const sandbox = {
  console,
  // buildUiHtml injects this shared helper into the production invoice script.
  staffPaymentDisplayStatus: require('./lib/staff-booking-display-truth').staffPaymentDisplayStatus,
  t,
  escHtml,
  BC_RENTAL_DAY_RATES: {
    hard_board_rental: 2000,
    soft_top_rental: 1500,
    wetsuit_rental: 500,
    wetsuit_hard_board_combo: 2000,
    wetsuit_soft_top_combo: 1500,
  },
  BC_RUNNING_INVOICE_ACCOMM_CODES: {
    package: true,
    package_proration: true,
    room_supplement: true,
    accommodation_only: true,
    manual_accommodation: true,
    guest_package: true,
    guest_package_proration: true,
    guest_accommodation_only: true,
  },
  BC_STAFF_ACTIONS: true,
  BC_STRIPE_LINKS: true,
  fetchCalls: [],
  fetch(url, opts) {
    sandbox.fetchCalls.push({ url, opts });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true, payment_short_url: 'https://pay.example/g' }),
    });
  },
  getClient: () => 'wolfhouse-somo',
  encodeURIComponent,
  document: {
    _nodes: [],
    getElementById() { return null; },
    querySelectorAll(sel) {
      if (sel === '.bc-create-guest-payment-link-btn') return sandbox.document._nodes;
      return [];
    },
  },
  el() { return null; },
};
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(`${extracted.join('\n\n')}\nthis.__loaded = true;`, sandbox);

function dayRow(type, extraMeta, cents, day) {
  return {
    service_type: type,
    quantity: 1,
    amount_due_cents: cents,
    service_date: `2026-09-${String(23 + day).padStart(2, '0')}`,
    metadata: Object.assign({
      rental_days: 1,
      rental_people: 3,
      rental_span_days: 5,
      split_unit: day + 1,
    }, extraMeta),
  };
}

function ginaFixture() {
  const hard = [];
  const wet = [];
  for (let i = 0; i < 5; i += 1) {
    hard.push(dayRow('surfboard', {
      board_variant: 'hard',
      staff_ui_service_type: 'hard_board',
      pricing_addon_code: 'wetsuit_hard_board_combo',
      combo_part: 'surfboard',
    }, 7500, i));
    wet.push(dayRow('wetsuit', {
      combo_part: 'wetsuit',
      unit_cents: 0,
      pricing_addon_code: 'wetsuit_hard_board_combo',
    }, 0, i));
  }
  const bookingGuests = [
    { guest_number: 1, guest_name: 'Gina Rossi', booking_guest_id: '11111111-1111-4111-8111-111111111111', deposit_amount_cents: 10833, amount_paid_cents: 10833, payment_status: 'deposit_paid' },
    { guest_number: 2, guest_name: 'Luca Rossi', booking_guest_id: '22222222-2222-4222-8222-222222222222', deposit_amount_cents: 10833, amount_paid_cents: 0, payment_status: 'not_requested' },
    { guest_number: 3, guest_name: '', booking_guest_id: '33333333-3333-4333-8333-333333333333', deposit_amount_cents: 10834, amount_paid_cents: 0, payment_status: 'checkout_created' },
  ];
  const guestAccLines = [
    { guest_number: 1, package_code: 'no_package', package_label: 'No package', nights: 5, accommodation_cents: 20000 },
    { guest_number: 2, package_code: 'package_none', package_label: 'No package', nights: 5, accommodation_cents: 20000 },
    { guest_number: 3, package_code: 'malibu', package_label: 'Malibu', nights: 5, accommodation_cents: 20000 },
  ];
  const bk = {
    guest_name: 'Gina Rossi',
    guest_count: 3,
    check_in: '2026-09-23',
    check_out: '2026-09-28',
    package_code: 'no_package',
    status: 'confirmed',
    payment_status: 'deposit_paid',
    total_amount_cents: 97500,
    deposit_required_cents: 32500,
    amount_paid_cents: 32500,
    balance_due_cents: 65000,
    metadata: {
      quote_snapshot: {
        line_items: [{ code: 'accommodation_only', total_cents: 60000 }],
      },
    },
  };
  const pmt = {
    amount_paid_cents: 32500,
    rows: [{ payment_status: 'paid', amount_paid_cents: 32500 }],
  };
  return { bk, svcRows: hard.concat(wet), pmt, guestAccLines, bookingGuests };
}

console.log('\nverify-gina-invoice-display.js\n');

const fx = ginaFixture();
let html = '';
let renderErr = null;
try {
  html = sandbox.bcRenderRunningInvoiceHtml(
    fx.bk, fx.svcRows, fx.pmt, [], fx.guestAccLines, fx.bookingGuests, [], { overview: true },
  );
} catch (err) {
  renderErr = err;
}
check('R0', !renderErr, renderErr && renderErr.message);

const acc = (html.match(/id="bc-inv-accommodation"[\s\S]*?(?=<div class="ctx-inv-group" id="bc-inv-services")/) || [''])[0];
const svc = (html.match(/id="bc-inv-services"[\s\S]*?(?=<div class="ctx-inv-group" id="bc-inv-transfers")/) || [''])[0];
const guest = (html.match(/id="bc-inv-per-guest"[\s\S]*$/) || [''])[0];
const hardLines = (svc.match(/Hard board/g) || []).length;
const wetLines = (svc.match(/Wetsuit/g) || []).length;

check('A1', acc.includes('Gina Rossi'), 'lead name on accommodation');
check('A2', acc.includes('Luca Rossi'), 'known guest name on accommodation');
check('A3', acc.includes('Unnamed guest 3'), `clearer label than Guest N (${acc.slice(0, 400)})`);
check('A4', !/Guest [123]/.test(acc), 'no Guest N labels');
check('A5', !acc.includes('No package'), 'empty package dropped');
check('A6', acc.includes('Malibu'), 'real package kept');

check('S1', hardLines === 1, `Hard board lines=${hardLines}`);
check('S2', wetLines === 1, `Wetsuit lines=${wetLines}`);
check('S3', svc.includes('5 rental days') && svc.includes('3 people'), 'rolled stay math');
check('S4', svc.includes('free with board'), 'wetsuit free note rolled up');
check('S5', !/Wetsuit[\s\S]{0,80}€/.test(svc), 'free note has no euro amount');
check('S6', svc.includes('€375.00'), 'hard board shows summed cents, not a recomputed rate');

check('P1', guest.includes('Gina Rossi') && guest.includes('Luca Rossi'), 'per-guest names');
check('P2', guest.includes('Unnamed guest 3'), 'per-guest unnamed label');
check('P3', !guest.includes('not_requested') && !guest.includes('Not requested'), 'no not_requested text');
check('P4', (guest.match(/bc-create-guest-payment-link-btn/g) || []).length === 1, 'one Create link for the unrequested guest');
check('P5', guest.includes('>Create link<'), 'button label');
check('P6', guest.includes('data-booking-guest-id="22222222-2222-4222-8222-222222222222"'), 'button carries guest id');
check('P7', guest.includes('Deposit paid'), 'deposit_paid translated');
check('P8', guest.includes('Checkout created'), 'checkout_created translated');

check('M1', html.includes('€975.00'), 'invoice total preserved');
check('M2', html.includes('€325.00'), 'paid preserved');
check('M3', html.includes('€650.00'), 'balance preserved');
check('M3a', html.includes('id="bc-generate-payment-link-btn"'), 'overview balance due has its own Create link control');
check('M3b', html.includes('id="bc-payment-link-result"'), 'overview balance due has an inline link result target');

let rollup = null;
let rollupErr = null;
try {
  rollup = sandbox.bcRollupInvoiceServiceDisplay(fx.svcRows);
} catch (err) {
  rollupErr = err;
}
check('M4', !rollupErr && rollup && rollup.moneyChanged === false, rollupErr && rollupErr.message);
check('M5', rollup && rollup.displayCents === 37500 && rollup.inputCents === 37500, `cents ${rollup && rollup.displayCents}/${rollup && rollup.inputCents}`);
check('M6', rollup && !rollup.conflict, 'day-split rows are not treated as double-counts');

const dup = [];
for (let i = 0; i < 5; i += 1) {
  dup.push({
    service_type: 'surfboard',
    quantity: 1,
    amount_due_cents: 37500,
    service_date: '2026-09-23',
    metadata: { rental_days: 5, rental_people: 3, staff_ui_service_type: 'hard_board', board_variant: 'hard' },
  });
}
let dupRoll = null;
try { dupRoll = sandbox.bcRollupInvoiceServiceDisplay(dup); } catch (_) { dupRoll = null; }
check('M7', dupRoll && dupRoll.conflict && dupRoll.conflict.reason === 'duplicate_full_span_charges', 'full-span duplicates are reported, not repriced');
check('M8', dupRoll && dupRoll.moneyChanged === false && dupRoll.displayCents === 187500, 'conflict path still sums stored cents');

const totalsFn = extractFunctionSource(apiSrc, 'bcComputeBookingInvoiceTotals');
check('M9', /svcRows\.reduce\(function\(s, r\)\{ return s \+ bcServiceRecordBillableCents\(r\); \}, 0\)/.test(totalsFn), 'invoice total still sums every service row');
check('M10', /var invoiceTotal = fin\.invoiceTotal;/.test(extractFunctionSource(apiSrc, 'bcRenderRunningInvoiceHtml')), 'drawer total still uses computed invoice total');

let shell = '';
let req = '';
try { shell = extractFunctionSource(apiSrc, 'bcInitGuestPaymentLinkShell'); } catch (err) { shell = ''; }
try { req = extractFunctionSource(apiSrc, 'bcRequestGuestPaymentLink'); } catch (err) { req = ''; }
check('W1', shell.includes('bcBindCreateGuestPaymentLinkButtons'), 'row buttons share the guest-link shell');
check('W2', shell.includes("if (!genBtn) return;") === false, 'missing select must not skip row buttons');
check('W3', req.includes('/staff/bookings/generate-guest-payment-link'), 'reuses existing guest payment-link route');
check('W4', req.includes("payment_target: 'deposit'") || req.includes('payment_target: "deposit"'), 'same deposit target as the existing control');

const i18n = fs.readFileSync(I18N, 'utf8');
const es = fs.readFileSync(I18N_ES, 'utf8');
check('I1', i18n.includes("'drawer.invoice.createLink': 'Create link'"), 'EN create link');
check('I1a', i18n.includes("'drawer.invoice.copyLink': 'Copy'"), 'EN visible Copy control');
check('I2', i18n.includes("'drawer.invoice.unnamedGuest': 'Unnamed guest {number}'"), 'EN unnamed guest');
check('I3', es.includes('"drawer.invoice.createLink": "Crear enlace"'), 'ES create link differs from EN');
check('I3a', es.includes('"drawer.invoice.copyLink": "Copiar"'), 'ES visible Copy control');
check('I4', i18n.includes("'drawer.invoice.createLink': 'Crea link'"), 'IT create link differs from EN');
let unknown = null;
try { unknown = sandbox.bcInvoicePaymentRequestDisplay('payment_link_sent'); } catch (err) { unknown = null; }
check('I5', unknown && unknown.createLink === false && unknown.label === 'Payment link sent', unknown && unknown.label);

function fakeInlineNode() {
  return {
    innerHTML: '',
    outerHTML: '<button class="bc-create-guest-payment-link-btn">Create link</button>',
    style: { display: 'none' },
    disabled: false,
    addEventListener(type, listener) {
      this.listeners = this.listeners || {};
      this.listeners[type] = listener;
    },
    classList: {
      values: new Set(),
      add(value) { this.values.add(value); },
      remove(value) { this.values.delete(value); },
    },
  };
}

async function verifyInlinePaymentLinkResults() {
  const originalFetch = sandbox.fetch;
  const originalRefresh = sandbox.bcRefreshPaymentsTab;
  let refreshes = 0;
  sandbox.bcRefreshPaymentsTab = () => { refreshes += 1; };

  const perGuestResult = fakeInlineNode();
  const perGuestBtn = fakeInlineNode();
  sandbox.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ success: true, payment_short_url: 'https://pay.example/guest-inline' }),
  });
  sandbox.bcRequestGuestPaymentLink('guest-inline', perGuestResult, perGuestBtn, { booking: { booking_id: 'b1' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('UX1', perGuestBtn.outerHTML.includes('<a href="https://pay.example/guest-inline"')
    && perGuestBtn.outerHTML.includes('https://pay.example/guest-inline'), 'per-guest success renders its payment-link anchor in place');
  check('UX1a', perGuestBtn.outerHTML.includes('btn-bc-copy-link-icon')
    && perGuestBtn.outerHTML.includes('>Copy<'), 'per-guest URL exposes a visible Copy control');
  check('UX1b', perGuestBtn.outerHTML.includes('https://pay.example/guest-inline')
    && perGuestBtn.outerHTML.includes('btn-bc-copy-link-icon')
    && !perGuestBtn.outerHTML.includes('bc-create-guest-payment-link-btn'), 'per-guest success replaces its Create link control in place');
  check('UX2', refreshes === 0, 'per-guest success does not jump to Payments');
  refreshes = 0;

  const failureResult = fakeInlineNode();
  const failureBtn = fakeInlineNode();
  sandbox.fetch = () => Promise.resolve({
    ok: false,
    json: () => Promise.resolve({ success: false, error: 'Stripe unavailable' }),
  });
  sandbox.bcRequestGuestPaymentLink('guest-failure', failureResult, failureBtn, { booking: { booking_id: 'b1' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('UX3', failureResult.innerHTML.includes('Stripe unavailable'), 'per-guest failure remains inline');
  check('UX4', !failureResult.innerHTML.includes('Payment link ready'), 'per-guest failure never claims a ready link');
  check('UX5', refreshes === 0, 'per-guest failure does not jump to Payments');

  const balanceResult = fakeInlineNode();
  const balanceBtn = fakeInlineNode();
  sandbox.el = (id) => (id === 'bc-generate-payment-link-btn' ? balanceBtn : (id === 'bc-payment-link-result' ? balanceResult : null));
  sandbox.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ success: true, payment_short_url: 'https://pay.example/balance-inline' }),
  });
  sandbox.bcInitPaymentLinkShell({ booking: { booking_id: 'b1', booking_code: 'B1' } });
  check('UX6', !!(balanceBtn.listeners && balanceBtn.listeners.click), 'balance button has an executable inline action');
  balanceBtn.listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('UX7', balanceResult.innerHTML.includes('<a href="https://pay.example/balance-inline"')
    && balanceResult.innerHTML.includes('https://pay.example/balance-inline'), 'balance success renders an inline payment-link anchor');
  check('UX7a', balanceResult.innerHTML.includes('btn-bc-copy-link-icon')
    && balanceResult.innerHTML.includes('>Copy<'), 'balance URL exposes a visible Copy control');
  check('UX8', refreshes === 0, 'balance success does not jump to Payments');

  const balanceFailureResult = fakeInlineNode();
  const balanceFailureBtn = fakeInlineNode();
  sandbox.el = (id) => (id === 'bc-generate-payment-link-btn' ? balanceFailureBtn : (id === 'bc-payment-link-result' ? balanceFailureResult : null));
  sandbox.fetch = () => Promise.resolve({
    ok: false,
    json: () => Promise.resolve({ success: false, error: 'Stripe unavailable' }),
  });
  sandbox.bcInitPaymentLinkShell({ booking: { booking_id: 'b1', booking_code: 'B1' } });
  balanceFailureBtn.listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('UX9', balanceFailureResult.innerHTML.includes('Stripe unavailable'), 'balance failure remains inline');
  check('UX10', !balanceFailureResult.innerHTML.includes('Payment link ready'), 'balance failure never claims a ready link');
  check('UX11', refreshes === 0, 'balance failure does not jump to Payments');

  sandbox.fetch = originalFetch;
  sandbox.bcRefreshPaymentsTab = originalRefresh;
}

verifyInlinePaymentLinkResults().then(() => {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
