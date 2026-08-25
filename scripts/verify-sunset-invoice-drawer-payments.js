'use strict';

/**
 * verify:sunset-invoice-drawer-payments
 *
 * Invoice drawer payment chrome: default Importe = outstanding, no unlabeled €0
 * paid cell, Mark as paid + editable/void payment list using existing methods.
 * Offline only. No DB / Azure / network / inbox / Admin Email / edit quote wizard.
 *
 * Run: node scripts/verify-sunset-invoice-drawer-payments.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const viewSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-view-ui.js'), 'utf8');
const actionsSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-actions.js'), 'utf8');
const editSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-edit-ui.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const enSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const esSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');
const { slicePortalFunction } = require('./lib/portal-fn-slice');
const mutate = require('./lib/staff-booking-manual-payment-mutate');
const inboxThreadSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
const emailUiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

function extractFn(src, name) {
  return slicePortalFunction(src, name);
}

function buildRenderCtx() {
  const portalT = (k) => {
    const map = {
      'schedule.drawer.invoiceTitle': 'Invoice',
      'schedule.drawer.subtotal': 'Subtotal',
      'schedule.drawer.balanceDue': 'Balance due',
      'schedule.drawer.paidInFull': 'Paid in full',
      'schedule.drawer.refundCredit': 'Refund / credit',
      'schedule.drawer.paymentCredit': 'Payment',
      'schedule.drawer.otherPayments': 'Other payments',
      'schedule.drawer.recordPayment': 'Record a manual payment',
      'schedule.drawer.markAsPaid': 'Mark as paid',
      'schedule.drawer.manualPayAmount': 'Amount (€)',
      'schedule.drawer.manualPayMethod': 'Method',
      'schedule.drawer.manualPayNote': 'Note (optional)',
      'schedule.drawer.manualPaySubmit': 'Record payment',
      'schedule.drawer.editPayment': 'Edit',
      'schedule.drawer.voidPayment': 'Void',
      'schedule.drawer.methodBankTransfer': 'bank transfer',
      'schedule.drawer.methodInShop': 'in shop',
      'schedule.drawer.methodCard': 'card',
      'schedule.drawer.dayWordCap': 'Day',
      'schedule.drawer.daysWordCap': 'Days',
      'schedule.drawer.surferWord': 'Surfer',
      'schedule.drawer.surfersWord': 'Surfers',
      'schedule.payment.paidBankTransfer': 'Paid - Bank Transfer',
      'schedule.payment.paidInStore': 'Paid - Cash',
      'schedule.payment.paidViaLink': 'Paid - Stripe',
      'schedule.drawer.createPaymentLink': 'Create payment link',
      'schedule.drawer.stripeUnavailable': 'Stripe unavailable',
    };
    return map[k] || k;
  };
  const sandbox = {
    portalT,
    isSunsetSurfActive: () => true,
    schedulePortalStripeLinkFromCtx: () => ({ url: '', actionable: false, stale: false }),
    scheduleDrawerPaymentShortUrl: () => '',
    scheduleDrawerPaidMethodLabel: (m) => {
      if (m === 'bank_transfer') return 'bank transfer';
      if (m === 'in_store') return 'in shop';
      if (m === 'link') return 'card';
      return '';
    },
    scheduleDrawerBuildCommercialLines: () => ({ lines: [] }),
    scheduleDrawerDDMMYY: (s) => String(s || '').slice(0, 10),
    scheduleDateOnlyLabel: (s) => String(s || ''),
    scheduleParseIso: (s) => new Date(s),
    scheduleDrawerEur: (cents) => {
      if (cents == null || Number.isNaN(Number(cents))) return '—';
      return '€' + (Number(cents) / 100).toFixed(2);
    },
    scheduleDrawerIsEquipmentLikeLine: () => false,
    scheduleDrawerIsCourseLikeLine: () => false,
    scheduleDrawerUsesStackedSvcDetail: () => false,
    scheduleDrawerFormatAccommodationInvoiceLabel: (l) => l.label || '—',
    scheduleDrawerFormatEquipmentInvoiceLabel: (l) => l.label || '—',
    scheduleDrawerFormatCourseInvoiceLabel: (l) => l.label || '—',
    scheduleDrawerFormatCommercialMathLabel: () => '',
    scheduleFormatComponentsView: () => '—',
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  const names = [
    'scheduleDrawerViewResolveStripe',
    'scheduleDrawerManualMethodOptionsHtml',
    'scheduleDrawerOutstandingDefaultEur',
    'scheduleRenderSunsetRecordPaymentHtml',
    'scheduleRenderSunsetInvoiceCreditLabel',
    'scheduleRenderSunsetInvoiceCreditRowHtml',
    'scheduleRenderSunsetMoneyActionsHtml',
    'scheduleRenderSunsetInvoiceCardHtml',
  ];
  let bundle = '';
  names.forEach((name) => {
    const fn = extractFn(viewSrc, name);
    if (!fn) throw new Error('missing ' + name);
    bundle += fn + '\nthis.' + name + ' = ' + name + ';\n';
  });
  vm.runInNewContext(bundle, sandbox, { timeout: 5000 });
  return sandbox;
}

console.log('\nverify:sunset-invoice-drawer-payments\n');

console.log('[1] Default Importe = outstanding balance');
const ctx = buildRenderCtx();
ok('outstanding helper formats €130.00', ctx.scheduleDrawerOutstandingDefaultEur({
  payment: { balance_due_cents: 13000 },
}) === '130.00');
ok('outstanding helper empty when zero', ctx.scheduleDrawerOutstandingDefaultEur({
  payment: { balance_due_cents: 0 },
}) === '');
const unpaidHtml = ctx.scheduleRenderSunsetInvoiceCardHtml({
  booking_id: '11111111-1111-1111-1111-111111111111',
  date_from: '2026-08-05',
  date_to: '2026-08-05',
  payment: {
    subtotal_cents: 13000,
    paid_cents: 0,
    balance_due_cents: 13000,
    payment_status: 'unpaid',
    line_items: [],
    paid_payments: [],
  },
  stripe_available: false,
});
ok('manual amount input prefilled with 130.00',
  /id="ps-drawer-manual-amount"[^>]*value="130\.00"/.test(unpaidHtml)
  || /value="130\.00"[^>]*id="ps-drawer-manual-amount"/.test(unpaidHtml));
ok('manual amount still editable (type=number)',
  /id="ps-drawer-manual-amount"[^>]*type="number"/.test(unpaidHtml)
  || /type="number"[^>]*id="ps-drawer-manual-amount"/.test(unpaidHtml));
ok('actions renderManualPaymentHtml also defaults amount',
  /value="' \+ escHtml\(defaultEur\)/.test(actionsSrc)
  || /defaultEur \? \(' value="'/.test(actionsSrc));

console.log('\n[2] No unlabeled €0.00 paid cell under balance due');
ok('no ps-invoice-paid-sr chrome', !unpaidHtml.includes('ps-invoice-paid-sr'));
ok('no absolute offscreen paid span', !/id="ps-drawer-paid"/.test(unpaidHtml));
ok('balance due labeled', unpaidHtml.includes('Balance due') && unpaidHtml.includes('€130.00'));
const afterBalance = unpaidHtml.split('Balance due')[1] || '';
ok('no bare €0.00 immediately under balance section',
  !/>\s*€0\.00\s*</.test(afterBalance.split('ps-invoice-pay-actions')[0] || afterBalance));

console.log('\n[3] Mark as paid + Stripe method + editable payment list');
ok('Mark as paid button present', unpaidHtml.includes('ps-drawer-mark-paid') && unpaidHtml.includes('Mark as paid'));
ok('manual method includes Stripe/link',
  /ps-drawer-manual-method[\s\S]*value="link"/.test(unpaidHtml)
  && /Paid - Stripe/.test(unpaidHtml));
ok('mark-paid method select includes link',
  /ps-drawer-mark-paid-method[\s\S]*value="link"/.test(unpaidHtml));
ok('actions wire mark_paid:true path',
  /mark_paid:\s*true/.test(actionsSrc) && /ps-drawer-mark-paid/.test(actionsSrc));
ok('actions wire void + update payment endpoints',
  /void-manual-payment/.test(actionsSrc) && /update-manual-payment/.test(actionsSrc));
const creditHtml = ctx.scheduleRenderSunsetInvoiceCardHtml({
  booking_id: '11111111-1111-1111-1111-111111111111',
  date_from: '2026-08-05',
  date_to: '2026-08-05',
  payment: {
    subtotal_cents: 13000,
    paid_cents: 5000,
    balance_due_cents: 8000,
    payment_status: 'unpaid',
    line_items: [],
    paid_payments: [{
      payment_id: '22222222-2222-2222-2222-222222222222',
      amount_cents: 5000,
      method: 'bank_transfer',
      kind: 'manual',
    }],
  },
});
ok('credit row has Edit + Void controls',
  creditHtml.includes('ps-payment-edit-btn')
  && creditHtml.includes('ps-payment-void-btn')
  && creditHtml.includes('Edit')
  && creditHtml.includes('Void'));

console.log('\n[4] Staff API methods + mutate helpers (existing enums only)');
ok('normalizeStaffManualMethod maps cash→in_store and stripe→link',
  mutate.normalizeStaffManualMethod('cash') === 'in_store'
  && mutate.normalizeStaffManualMethod('stripe') === 'link'
  && mutate.normalizeStaffManualMethod('link') === 'link');
ok('allowlist size 3 (bank_transfer/in_store/link)',
  mutate.SUNSET_PAID_METHODS.size === 3);
ok('record-cash-payment accepts mark_paid + link',
  /mark_paid/.test(apiSrc)
  && /staffManualMethodSource/.test(apiSrc)
  && /void-manual-payment/.test(apiSrc)
  && /update-manual-payment/.test(apiSrc));
ok('derive unpaid→waiting_payment when zero paid',
  mutate.deriveBookingPaymentStatus(13000, 0).payment_status === 'waiting_payment'
  && mutate.deriveBookingPaymentStatus(13000, 0).balance === 13000);
ok('derive paid when ledger covers total',
  mutate.deriveBookingPaymentStatus(13000, 13000).payment_status === 'paid'
  && mutate.deriveBookingPaymentStatus(13000, 13000).balance === 0);

(async function mutatePgSmoke() {
  const state = {
    payments: [{
      id: '22222222-2222-2222-2222-222222222222',
      booking_id: '11111111-1111-1111-1111-111111111111',
      status: 'paid',
      amount_paid_cents: 5000,
      amount_due_cents: 5000,
      metadata: { method: 'bank_transfer', source: 'staff_bank_transfer', staff_portal: true },
    }],
    booking: {
      id: '11111111-1111-1111-1111-111111111111',
      total_amount_cents: 13000,
      amount_paid_cents: 5000,
      balance_due_cents: 8000,
      payment_status: 'deposit_paid',
      metadata: {},
      client_slug: 'sunset-surf',
    },
  };
  const pg = {
    async query(sql, params) {
      const s = String(sql);
      if (/FOR UPDATE OF p/.test(s)) {
        const row = state.payments.find((p) => p.id === params[0] && p.booking_id === params[1]);
        return {
          rows: row ? [{
            payment_id: row.id,
            payment_status: row.status,
            amount_due_cents: row.amount_due_cents,
            amount_paid_cents: row.amount_paid_cents,
            metadata: row.metadata,
            booking_id: row.booking_id,
          }] : [],
        };
      }
      if (/UPDATE payments/.test(s) && /cancelled/.test(s)) {
        const row = state.payments.find((p) => p.id === params[0]);
        if (!row || row.status !== 'paid') return { rowCount: 0, rows: [] };
        row.status = 'cancelled';
        row.metadata = Object.assign({}, row.metadata, JSON.parse(params[1]));
        return { rowCount: 1, rows: [] };
      }
      if (/UPDATE payments/.test(s) && /amount_paid_cents/.test(s)) {
        const row = state.payments.find((p) => p.id === params[0]);
        if (!row || row.status !== 'paid') return { rowCount: 0, rows: [] };
        row.amount_due_cents = params[1];
        row.amount_paid_cents = params[1];
        row.metadata = JSON.parse(params[2]);
        return { rowCount: 1, rows: [] };
      }
      if (/FROM bookings b/.test(s) && /c\.slug/.test(s) && /LIMIT 1/.test(s)) {
        return {
          rows: [{
            booking_id: state.booking.id,
            total_amount_cents: state.booking.total_amount_cents,
            amount_paid_cents: state.booking.amount_paid_cents,
            balance_due_cents: state.booking.balance_due_cents,
            payment_status: state.booking.payment_status,
            metadata: state.booking.metadata,
          }],
        };
      }
      if (/SUM\(p\.amount_paid_cents\)/.test(s)) {
        const total = state.payments
          .filter((p) => p.status === 'paid')
          .reduce((n, p) => n + Number(p.amount_paid_cents || 0), 0);
        return { rows: [{ total }] };
      }
      if (/UPDATE bookings b/.test(s)) {
        state.booking.amount_paid_cents = params[0];
        state.booking.balance_due_cents = params[1];
        state.booking.payment_status = params[2];
        if (params.length >= 6) {
          state.booking.metadata = Object.assign({}, state.booking.metadata, JSON.parse(params[5]));
        } else if (/- 'sunset_payment_method'/.test(s) || /- \'sunset_payment_method\'/.test(s)) {
          delete state.booking.metadata.sunset_payment_method;
        }
        return { rowCount: 1, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const voided = await mutate.voidStaffPaidPayment(pg, {
    bookingId: state.booking.id,
    clientSlug: 'sunset-surf',
    paymentId: state.payments[0].id,
    actorLabel: 'test@example.com',
  });
  ok('void soft-cancels payment (no delete)',
    voided.ok === true
    && state.payments[0].status === 'cancelled'
    && voided.balance_due_cents === 13000
    && voided.payment_status === 'waiting_payment');

  state.payments[0].status = 'paid';
  state.payments[0].amount_paid_cents = 5000;
  state.booking.amount_paid_cents = 5000;
  state.booking.balance_due_cents = 8000;
  state.booking.payment_status = 'deposit_paid';
  const updated = await mutate.updateStaffPaidPayment(pg, {
    bookingId: state.booking.id,
    clientSlug: 'sunset-surf',
    paymentId: state.payments[0].id,
    amountCents: 13000,
    method: 'link',
    actorLabel: 'test@example.com',
  });
  ok('edit payment amount/method persists via existing enums',
    updated.ok === true
    && state.payments[0].amount_paid_cents === 13000
    && state.payments[0].metadata.method === 'link'
    && updated.payment_status === 'paid'
    && updated.balance_due_cents === 0);

  console.log('\n[5] i18n EN/ES');
  ok('EN Mark as paid', /'schedule\.drawer\.markAsPaid': 'Mark as paid'/.test(enSrc));
  ok('ES Marcar como pagado', /'schedule\.drawer\.markAsPaid': 'Marcar como pagado'/.test(esSrc));
  ok('ES Anular / Editar',
    /'schedule\.drawer\.voidPayment': 'Anular'/.test(esSrc)
    && /'schedule\.drawer\.editPayment': 'Editar'/.test(esSrc));

  console.log('\n[6] Stay-off surfaces');
  ok('did not touch inbox-thread.js',
    !/markAsPaid|void-manual-payment|ps-drawer-mark-paid/.test(inboxThreadSrc));
  ok('did not touch Admin Email chrome',
    !/markAsPaid|void-manual-payment|ps-drawer-mark-paid/.test(emailUiSrc));
  ok('edit drawer quote/save wizard not used for mark-paid',
    !/mark_paid:\s*true/.test(editSrc)
    && !/void-manual-payment/.test(editSrc));
  ok('no POST schedule/bookings/quote in this slice',
    !/schedule\/bookings\/quote/.test(actionsSrc)
    || !/mark_paid/.test(actionsSrc.split('schedule/bookings/quote')[0] || ''));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Sections 5–6 run inside mutatePgSmoke after async void/edit checks.
