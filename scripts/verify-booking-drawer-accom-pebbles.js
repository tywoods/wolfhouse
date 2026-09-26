'use strict';

/**
 * BOOKING-DRAWER-ACCOM-PEBBLES-PER-GUEST-STRIP-001
 *
 * Display only. Does not recompute deposits, shares, or invoice totals.
 * Run: node scripts/verify-booking-drawer-accom-pebbles.js
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
const i18n = fs.readFileSync(I18N, 'utf8');
const es = fs.readFileSync(I18N_ES, 'utf8');

const guestFn = extractFunctionSource(apiSrc, 'bcRenderPerGuestPaymentsHtml');
const markupFn = extractFunctionSource(apiSrc, 'bcRequestGuestPaymentLink');
const totalsFn = extractFunctionSource(apiSrc, 'bcComputeBookingInvoiceTotals');
const accFn = extractFunctionSource(apiSrc, 'bcRenderRunningInvoiceHtml');

check('A1', !guestFn.includes("deposit ' + escHtml(eur"), 'guest strip must not print deposit euros');
check('A2', !guestFn.includes("paid ' + escHtml(eur"), 'guest strip must not print paid euros');
check('A3', !/deposit\s*€|paid\s*€/.test(guestFn), 'no deposit/paid euro words in the guest renderer');
check('A4', guestFn.includes("t('drawer.invoice.depositLink')"), 'Deposit Link control remains');
check('A5', guestFn.includes("t('drawer.invoice.paymentLink')"), 'Payment Link control remains');
check('A6', guestFn.includes('bc-create-guest-payment-link-btn'), 'create control remains');
check('A7', guestFn.includes('bc-guest-pay-link-result'), 'copy/result slot remains');
check('A8', guestFn.includes("data-payment-target=\"deposit\""), 'deposit target preserved');
check('A9', guestFn.includes("data-payment-target=\"remaining_share\""), 'remaining-owed target preserved');

check('L1', markupFn.includes("paymentTarget === 'deposit'"), 'deposit create chooses its own label');
check('L2', markupFn.includes("t('drawer.invoice.depositLink')"), 'created deposit link label is Deposit Link');
check('L3', markupFn.includes("t('drawer.invoice.paymentLink')"), 'remaining-owed created link stays Payment Link');
check('L4', markupFn.includes('bcInlinePaymentLinkMarkup(link, linkLabel)'), 'label is passed into the copy markup');
check('L5', apiSrc.includes('function bcInlinePaymentLinkMarkup(url, label)'), 'markup accepts an explicit label');
check('L6', apiSrc.includes('btn-bc-copy-link-icon') && apiSrc.includes('bcCopyLinkIconSvg'), 'copy icon remains');

check('R1', accFn.includes('bc-accom-guest-line'), 'accommodation row is a pebble row');
check('R2', accFn.includes("parts.join(' \\u2014 ')"), 'row text stays name — room/package — nights — price');
check('R3', accFn.includes('bcAccommodationPayPebbleHtml(line.guest_number, bookingGuests, perPerson)'), 'pebble is per person');
check('R4', accFn.includes('bcNightsLabel(lineNights)') && accFn.includes('eur(cents)'), 'nights and price stay on the row');
check('R5', !accFn.includes('bcComputeBookingInvoiceTotals ='), 'renderer does not replace totals');
check('M1', /svcRows\.reduce\(function\(s, r\)\{ return s \+ bcServiceRecordBillableCents\(r\); \}, 0\)/.test(totalsFn), 'invoice total still sums stored cents');

check('C1', apiSrc.includes('.ctx-inv-line.bc-accom-guest-line{display:flex;align-items:center;justify-content:space-between;gap:8px}'), 'pebble stays on the same row, right aligned');
check('C2', apiSrc.includes('.bc-accom-pay-pebble.is-unpaid{background:#3A3A3C;color:#fff}'), 'Unpaid uses sun-mode drawer-tab gray and white text');
check('C3', apiSrc.includes('.bc-accom-pay-pebble.is-deposit{background:#D7EBE6;color:#1F4F48}'), 'Deposit Paid is soft teal');
check('C4', apiSrc.includes('.bc-accom-pay-pebble.is-paid{background:#DCEAD2;color:#3d6130}'), 'Paid is soft green');
check('C5', apiSrc.includes('.bc-accom-pay-pebble{flex:0 0 auto;margin-left:auto;border-radius:999px;padding:0 8px;font-size:10px;font-weight:600;line-height:16px;white-space:nowrap}'), 'pebble does not add row padding');
check('C6', !/\.bc-accom-guest-line\{[^}]*padding:\s*(?:[1-9]\d|8)/.test(apiSrc), 'no extra vertical padding on the accommodation row');
check('C7', apiSrc.includes('[data-theme="dark"] .bc-accom-pay-pebble.is-unpaid'), 'night rule exists and does not replace the day fill');

check('I1', i18n.includes("'drawer.invoice.accomStatus.unpaid': 'Unpaid'"), 'EN Unpaid');
check('I2', i18n.includes("'drawer.invoice.accomStatus.depositPaid': 'Deposit Paid'"), 'EN Deposit Paid');
check('I3', i18n.includes("'drawer.invoice.accomStatus.paid': 'Paid'"), 'EN Paid');
check('I4', es.includes('"drawer.invoice.accomStatus.unpaid": "Sin pagar"'), 'ES Unpaid differs');
check('I5', es.includes('"drawer.invoice.accomStatus.depositPaid": "Depósito pagado"'), 'ES Deposit Paid differs');
check('I6', es.includes('"drawer.invoice.accomStatus.paid": "Pagado"'), 'ES Paid differs');
check('I7', i18n.includes("'drawer.invoice.accomStatus.unpaid': 'Non pagato'"), 'IT Unpaid differs');
check('I8', i18n.includes("'drawer.invoice.accomStatus.depositPaid': 'Deposito pagato'"), 'IT Deposit Paid differs');
check('I9', i18n.includes("'drawer.invoice.depositLink': 'Deposit Link'"), 'EN Deposit Link label');
check('I10', i18n.includes("'drawer.invoice.paymentLink': 'Payment Link'"), 'EN Payment Link label');

const strings = {
  'drawer.invoice.depositLink': 'Deposit Link',
  'drawer.invoice.paymentLink': 'Payment Link',
  'drawer.invoice.createLink': 'Payment Link',
  'drawer.invoice.copyLink': 'Copy',
  'drawer.invoice.accomStatus.unpaid': 'Unpaid',
  'drawer.invoice.accomStatus.depositPaid': 'Deposit Paid',
  'drawer.invoice.accomStatus.paid': 'Paid',
  'drawer.invoice.unnamedGuest': 'Unnamed guest {number}',
  'drawer.payments.linkFailed': 'Payment link failed',
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

const names = [
  'bcInvoiceGuestStaffLabel',
  'bcInvoicePaymentRequestDisplay',
  'bcInvoiceTitleCaseStatus',
  'bcRenderPerGuestPaymentsHtml',
  'bcAccommodationPayPebbleKey',
  'bcAccommodationPayPebbleHtml',
  'bcInlinePaymentLinkMarkup',
  'bcCopyLinkIconSvg',
];
const sandbox = { t, escHtml, getClient: () => 'wolfhouse-somo' };
vm.createContext(sandbox);
vm.runInContext(names.map((name) => extractFunctionSource(apiSrc, name)).join('\n\n'), sandbox);

const guests = [
  { guest_number: 1, guest_name: 'Ada', booking_guest_id: 'g1', deposit_amount_cents: 10000, amount_paid_cents: 0, subtotal_cents: 32500 },
  { guest_number: 2, guest_name: 'Bea', booking_guest_id: 'g2', deposit_amount_cents: 10000, amount_paid_cents: 10000, subtotal_cents: 32500 },
  { guest_number: 3, guest_name: 'Cy', booking_guest_id: 'g3', deposit_amount_cents: 10000, amount_paid_cents: 32500, subtotal_cents: 32500 },
];
const strip = sandbox.bcRenderPerGuestPaymentsHtml(guests, [], 'Ada');
check('S1', strip.includes('Ada') && strip.includes('Bea') && strip.includes('Cy'), 'names stay');
check('S2', strip.includes('>Deposit Link<') && strip.includes('>Payment Link<'), 'both link labels stay');
check('S3', !/deposit €|paid €|€\d/.test(strip), `no euro amounts on the strip (${strip.slice(0, 240)})`);
check('S4', (strip.match(/bc-create-guest-payment-link-btn/g) || []).length === 3, 'unpaid gets both links; deposit-paid gets the balance link');
check('S5', !strip.includes('data-payment-target="deposit" data-booking-guest-id="g3"') && strip.includes('data-booking-guest-id="g1"'), 'fully paid guest does not get a new deposit link');

check('P1', sandbox.bcAccommodationPayPebbleKey(1, guests, []) === 'unpaid', 'nothing paid is Unpaid');
check('P2', sandbox.bcAccommodationPayPebbleKey(2, guests, []) === 'deposit', 'deposit covered, balance open is Deposit Paid');
check('P3', sandbox.bcAccommodationPayPebbleKey(3, guests, []) === 'paid', 'share covered is Paid');
check('P4', sandbox.bcAccommodationPayPebbleKey(1, [{ guest_number: 1, deposit_amount_cents: 10000, amount_paid_cents: 4000, subtotal_cents: 32500 }], []) === 'unpaid', 'partial deposit stays Unpaid');
const pebble = sandbox.bcAccommodationPayPebbleHtml(2, guests, []);
check('P5', pebble.includes('bc-accom-pay-pebble is-deposit') && pebble.includes('>Deposit Paid<'), pebble);

const depositMarkup = sandbox.bcInlinePaymentLinkMarkup('https://checkout.stripe.com/c/pay/cs_test', 'Deposit Link');
const payMarkup = sandbox.bcInlinePaymentLinkMarkup('https://checkout.stripe.com/c/pay/cs_bal', 'Payment Link');
check('U1', depositMarkup.includes('>Deposit Link</a>') && !depositMarkup.includes('>https://checkout.stripe.com'), 'created deposit label is Deposit Link, URL stays in href');
check('U2', payMarkup.includes('>Payment Link</a>'), 'remaining-owed label stays Payment Link');
check('U3', depositMarkup.includes('btn-bc-copy-link-icon') && depositMarkup.includes('aria-label="Copy"') && depositMarkup.includes('bc-copy-link-svg'), 'copy control remains an icon');
check('U4', sandbox.bcInlinePaymentLinkMarkup('https://checkout.stripe.com/c/pay/cs_bal').includes('>Payment Link</a>'), 'balance link with no label stays Payment Link');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
