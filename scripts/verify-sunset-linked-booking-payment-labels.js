'use strict';

/**
 * P2 — Customer-card / linked bookings show staff EN/ES payment labels,
 * not raw snake_case enums (paid_in_full, pending_deposit, …).
 *
 * Stay off inbox-thread.js, email inbound/poller/Graph, Admin Email settings,
 * Reservas expand (#631), and production. No deploy. Staff API enums unchanged.
 *
 * Run: node scripts/verify-sunset-linked-booking-payment-labels.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CONTEXT = path.join(ROOT, 'scripts/browser/inbox-context.js');
const PROFILE = path.join(ROOT, 'scripts/browser/inbox-customers-profile.js');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');

const contextSrc = fs.readFileSync(CONTEXT, 'utf8');
const profileSrc = fs.readFileSync(PROFILE, 'utf8');
const threadBefore = fs.readFileSync(THREAD, 'utf8');

assert.ok(contextSrc.includes('function inboxCustomerPaymentStatusLabel'));
assert.ok(contextSrc.includes('inboxCustomerPaymentStatusLabel(b.payment_status'));
assert.ok(!/var pay = b\.payment_status \|\| b\.payment_payment_status \|\| '—'/.test(contextSrc));
assert.ok(profileSrc.includes('pending_deposit'));
assert.ok(profileSrc.includes('paid_in_full'));
assert.ok(!/require\(['\"]\.\/browser\/inbox-thread/.test(contextSrc));
assert.ok(!/require\(['\"]\.\/browser\/inbox-thread/.test(profileSrc));

function loadLabel(src, fnName, lang) {
  const start = src.indexOf('function ' + fnName);
  assert.ok(start >= 0, fnName + ' missing');
  const nextFn = src.indexOf('\nfunction ', start + 1);
  const end = nextFn > start ? nextFn : src.length;
  const box = {
    portalT: (k) => ({
      'admin.bookings.status.paid': lang === 'es' ? 'Pagado' : 'Paid',
      'admin.bookings.status.unpaid': lang === 'es' ? 'Sin pagar' : 'Unpaid',
      'admin.bookings.status.partial': lang === 'es' ? 'Parcial' : 'Partial',
      'admin.bookings.status.refunded': lang === 'es' ? 'Reembolsado' : 'Refunded',
      'admin.bookings.status.cancelled': lang === 'es' ? 'Cancelado' : 'Cancelled',
    }[k] || k),
    portalLang: lang,
  };
  vm.createContext(box);
  vm.runInContext(src.slice(start, end) + '\nthis.' + fnName + ' = ' + fnName + ';', box);
  return box[fnName];
}

function assertNoSnakeCase(label, raw) {
  assert.ok(typeof label === 'string' && label.length > 0, 'empty label for ' + raw);
  assert.ok(!/_/.test(label), 'snake_case leak for ' + raw + ' → ' + label);
}

const profileEn = loadLabel(profileSrc, 'customerPaymentStatusLabel', 'en');
const profileEs = loadLabel(profileSrc, 'customerPaymentStatusLabel', 'es');
const contextEn = loadLabel(contextSrc, 'inboxCustomerPaymentStatusLabel', 'en');
const contextEs = loadLabel(contextSrc, 'inboxCustomerPaymentStatusLabel', 'es');

const cases = [
  ['paid_in_full', 'Paid', 'Pagado'],
  ['pending_deposit', 'Unpaid', 'Sin pagar'],
  ['deposit_paid', 'Partial', 'Parcial'],
  ['waiting_payment', 'Unpaid', 'Sin pagar'],
  ['paid', 'Paid', 'Pagado'],
  ['partially_paid', 'Partial', 'Parcial'],
  ['payment_link_sent', 'Unpaid', 'Sin pagar'],
];

cases.forEach(function (row) {
  const raw = row[0];
  const en = row[1];
  const es = row[2];
  assert.strictEqual(profileEn(raw), en, 'profile EN ' + raw);
  assert.strictEqual(profileEs(raw), es, 'profile ES ' + raw);
  assert.strictEqual(contextEn(raw), en, 'context EN ' + raw);
  assert.strictEqual(contextEs(raw), es, 'context ES ' + raw);
  assertNoSnakeCase(profileEn(raw), raw);
  assertNoSnakeCase(contextEn(raw), raw);
});

// Full customer card HTML must not dump raw enums.
const sandbox = {
  window: {},
  document: undefined,
  console,
  portalLang: 'en',
  portalT: (key, fallback) => ({
    'customers.detail.linkedBookings': 'Linked bookings',
    'customers.detail.bookingCode': 'Booking',
    'customers.detail.bookingDates': 'Dates',
    'customers.detail.paymentStatus': 'Payment',
    'customers.detail.createBooking': 'Create booking',
    'admin.bookings.status.paid': 'Paid',
    'admin.bookings.status.unpaid': 'Unpaid',
    'admin.bookings.status.partial': 'Partial',
  }[key] || fallback || key),
  escHtml: (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;'),
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(contextSrc + '\nthis.__inboxContext = window.__inboxContext;', sandbox);
const full = sandbox.window.__inboxContext.customerFullHtml({
  success: true,
  phone: '+34600000099',
  identity: { display_name: 'Pay Label Guest' },
  bookings: [
    { booking_id: 'b1', booking_code: 'SUN-1', check_in: '2026-08-01', check_out: '2026-08-03', payment_status: 'paid_in_full' },
    { booking_id: 'b2', booking_code: 'SUN-2', check_in: '2026-08-10', check_out: '2026-08-12', payment_status: 'pending_deposit' },
  ],
}, {});
assert.ok(full.includes('Paid'), 'full card shows Paid');
assert.ok(full.includes('Unpaid'), 'full card shows Unpaid');
assert.ok(!full.includes('paid_in_full'), 'full card must not show paid_in_full');
assert.ok(!full.includes('pending_deposit'), 'full card must not show pending_deposit');

assert.strictEqual(fs.readFileSync(THREAD, 'utf8'), threadBefore, 'inbox-thread.js must stay untouched');

console.log('PASS linked booking payment labels (EN/ES, no snake_case enums)');
