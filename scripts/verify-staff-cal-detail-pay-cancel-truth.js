'use strict';

/**
 * Booking-detail payment chip + collectible balance follow the same
 * payment/cancel truth as the bookings list / calendar bars.
 * Not booking-code special cases.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

function sliceFn(name) {
  const start = api.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  let i = api.indexOf('{', start);
  let depth = 0;
  for (; i < api.length; i++) {
    if (api[i] === '{') depth++;
    else if (api[i] === '}') {
      depth--;
      if (depth === 0) return api.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

function makeT() {
  const pack = {
    'drawer.invoice.paid': 'Paid',
    'drawer.invoice.paidInFull': 'Paid in full',
    'drawer.invoice.payStatus.deposit_paid': 'Deposit paid',
    'drawer.invoice.balanceDue': 'Balance due',
    'drawer.invoice.refundReview': 'Refund review',
    'drawer.invoice.owe': 'Owe',
    'drawer.invoice.total': 'Total',
    'drawer.invoice.accomStatus.paid': 'Paid',
    'drawer.invoice.accomStatus.depositPaid': 'Deposit Paid',
    'drawer.invoice.accomStatus.unpaid': 'Unpaid',
    'calendar.detail.status.cancelled': 'Cancelado',
    'calendar.detail.status.expired': 'Caducada',
    'calendar.detail.status.fallback': 'Estado: {status}',
    'calendar.detail.roomingReview': 'Revisión de habitación',
  };
  return function t(key, vars) {
    let text = pack[key];
    if (text == null) text = key;
    if (vars && typeof vars === 'object') {
      Object.keys(vars).forEach((k) => {
        text = String(text).split('{' + k + '}').join(String(vars[k]));
      });
    }
    return text;
  };
}

function run() {
  const sandbox = {
    t: makeT(),
    escHtml: (s) => String(s == null ? '' : s),
    getClient: () => 'wolfhouse-somo',
    pgPayGuestSubtotalFromMetadata: () => null,
    bcCalendarFormatEur: (c) => '€' + (Number(c) / 100).toFixed(2),
    bcFormatTransferSummaryLabel: () => '',
    bcInvoicePaymentRequestDisplay: () => ({ createLink: false, label: '' }),
    bcInvoiceGuestStaffLabel: (_n, name) => name || 'Guest',
  };
  vm.createContext(sandbox);
  [
    'bcBookingStatusIsCancelled',
    'bcDrawerStatusPillCls',
    'bcCalendarDetailStatusLabel',
    'bcCalendarBlockPaymentState',
    'bcDetailHeaderMetaHtml',
    'bcGuestLedgerPaidCents',
    'bcAccommodationPayPebbleKey',
    'bcAccommodationPayPebbleHtml',
    'bcRenderPerGuestPaymentsHtml',
  ].forEach((name) => vm.runInContext(sliceFn(name), sandbox));
  return sandbox;
}

const s = run();

// Deposit-paid guest: list/invoice uses invoice_paid_cents; chip must not say Unpaid.
const depositGuest = [{
  guest_number: 1,
  guest_name: 'Ada',
  booking_guest_id: 'g1',
  deposit_amount_cents: 10000,
  amount_paid_cents: 0,
  invoice_paid_cents: 10000,
  payment_status: 'deposit_paid',
  subtotal_cents: 32500,
}];
assert.equal(s.bcAccommodationPayPebbleKey(1, depositGuest, []), 'deposit');
assert.match(s.bcAccommodationPayPebbleHtml(1, depositGuest, []), /is-deposit/);
assert.doesNotMatch(s.bcAccommodationPayPebbleHtml(1, depositGuest, []), /Unpaid|Sin pagar|Non pagato/);

// Status deposit_paid with no cents still matches list (not Unpaid).
assert.equal(s.bcAccommodationPayPebbleKey(1, [{
  guest_number: 1, deposit_amount_cents: 10000, amount_paid_cents: 0,
  payment_status: 'deposit_paid', subtotal_cents: 40000,
}], []), 'deposit');

// Cancelled: no collectible balance, Cancelado badge, guest does not owe, chip not Unpaid.
const cancelledBk = { status: 'cancelled' };
const header = s.bcDetailHeaderMetaHtml(
  { calendar_payment_primary: 'balance_due', calendar_payment_amount_cents: 8000, calendar_show_deposit_paid: false },
  cancelledBk,
  { invoice_total_cents: 8000, paid_total_cents: 0, balance_due_cents: 8000 },
);
assert.match(header, /Cancelado/);
assert.doesNotMatch(header, /Balance due|€80|Saldo pendiente/);

const expiredHeader = s.bcDetailHeaderMetaHtml(
  { status: 'expired', calendar_payment_primary: 'balance_due', calendar_payment_amount_cents: 8000 },
  { status: 'expired' },
  { invoice_total_cents: 8000, paid_total_cents: 0, balance_due_cents: 8000 },
);
assert.match(expiredHeader, /Caducada/);
assert.doesNotMatch(expiredHeader, /Balance due|€80/);

const cancelledGuest = [{
  guest_number: 1, guest_name: 'Bea', booking_guest_id: 'g2',
  deposit_amount_cents: 8000, amount_paid_cents: 0, subtotal_cents: 8000, payment_status: 'unpaid',
}];
const perGuest = s.bcRenderPerGuestPaymentsHtml(cancelledGuest, [], 'Bea', false, false, { bookingCancelled: true });
assert.match(perGuest, /bc-guest-pay-owed">€0\.00/);
assert.doesNotMatch(perGuest, /bc-guest-pay-owed">€80\.00/);

assert.notEqual(s.bcAccommodationPayPebbleKey(1, cancelledGuest, [], false, true), 'unpaid');
const cancelledPebble = s.bcAccommodationPayPebbleHtml(1, cancelledGuest, [], false, true);
assert.doesNotMatch(cancelledPebble, /Unpaid|Sin pagar|Non pagato/);

// Live confirmed with a real balance still shows it.
const live = s.bcDetailHeaderMetaHtml(
  { calendar_payment_primary: 'balance_due', calendar_payment_amount_cents: 8000, calendar_show_deposit_paid: true },
  { status: 'confirmed' },
  { invoice_total_cents: 18000, paid_total_cents: 10000, balance_due_cents: 8000, deposit_required_cents: 10000 },
);
assert.match(live, /Balance due/);
assert.match(live, /€80\.00/);
assert.match(live, /Deposit paid/);
assert.doesNotMatch(live, /Cancelado/);

assert.equal(s.bcAccommodationPayPebbleKey(1, [{
  guest_number: 1, deposit_amount_cents: 10000, amount_paid_cents: 0, subtotal_cents: 32500,
}], []), 'unpaid');

assert.doesNotMatch(api, /WH-20261114-14307494|WH-20261110-15243372/);

console.log('PASS verify-staff-cal-detail-pay-cancel-truth');
