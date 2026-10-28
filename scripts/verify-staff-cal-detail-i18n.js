'use strict';

/**
 * Calendar booking-detail panel copy goes through Staff i18n (EN/ES/IT),
 * not hardcoded English months / nights / Paid / status labels.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

function sliceFn(name) {
  const start = api.indexOf('function ' + name + '(');
  assert.ok(start > 0, 'missing ' + name);
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

const stayFn = sliceFn('bcSideStayMetaHtml');
const dateFn = sliceFn('bcSideHeaderDateLabel');
const headerFn = sliceFn('bcDetailHeaderMetaHtml');

assert.doesNotMatch(stayFn, /' nights'|\" nights\"/);
assert.doesNotMatch(stayFn, /' guest'|\" guest\"/);
assert.match(stayFn, /booking\.stay\.night/);
assert.match(stayFn, /booking\.stay\.nights/);
assert.match(stayFn, /nights === 1/);

assert.doesNotMatch(dateFn, /\['Jan','Feb','Mar'/);
assert.match(dateFn, /formatStaffPortalDate/);

assert.match(headerFn, /t\('drawer\.invoice\.paid'\)/);
assert.doesNotMatch(headerFn, />Paid</);
assert.doesNotMatch(headerFn, /Rooming review/);
assert.doesNotMatch(headerFn, /\.replace\(\/_\/g,\s*' '\)/);
assert.match(headerFn, /bcCalendarDetailStatusLabel/);
assert.match(headerFn, /calendar\.detail\.roomingReview/);

assert.match(api, /<title[^>]*data-i18n=/);
assert.doesNotMatch(api, /<title>Luna Front Desk<\/title>/);

assert.ok(api.includes("t('drawer.invoice.paid')") && api.includes("t('drawer.invoice.owe')"), 'guest pay Paid/Owe through t()');

const en = STAFF_PORTAL_STRINGS.en;
const es = STAFF_PORTAL_STRINGS.es;
const it = STAFF_PORTAL_STRINGS.it;

const STATUS_SLUGS = [
  'confirmed', 'hold', 'payment_pending', 'needs_review', 'cancelled', 'conflict',
  'operator', 'tour_operator', 'manual', 'blocked', 'needs_human', 'paid',
  'deposit_paid', 'unpaid', 'partial', 'hidden', 'refund_needed', 'refunded',
];

const HISTORY_KEYS = [
  'failedPayment', 'cancelledPaymentLink', 'paidCash', 'paidBankTransfer', 'stripePaid',
  'stripeLinkAwaiting', 'draftPayment', 'dueAtCheckout', 'statusFallback',
  'service.wetsuitRental', 'service.surfboardRental', 'service.groupLesson', 'service.yoga',
  'service.dinner', 'service.fallback',
].map((key) => 'drawer.payments.history.' + key);

const required = [
  'booking.stay.night',
  'booking.stay.nights',
  'booking.stay.guest',
  'booking.stay.guests',
  'drawer.invoice.paid',
  'drawer.invoice.owe',
  'drawer.invoice.total',
  'drawer.invoice.balanceDue',
  'drawer.invoice.payStatus.deposit_paid',
  'drawer.invoice.refundReview',
  'calendar.detail.newBooking',
  'drawer.invoice.perGuest',
  'calendar.detail.roomingReview',
  'calendar.detail.status.fallback',
].concat(HISTORY_KEYS, STATUS_SLUGS.map((s) => 'calendar.detail.status.' + s));

const allowSameEn = new Set(['drawer.invoice.total', 'drawer.payments.history.service.yoga']);
for (const key of required) {
  assert.ok(en[key], 'EN ' + key);
  assert.ok(es[key], 'ES ' + key);
  assert.ok(it[key], 'IT ' + key);
  if (!allowSameEn.has(key)) {
    assert.notEqual(es[key], en[key], 'ES ' + key + ' not EN');
    assert.notEqual(it[key], en[key], 'IT ' + key + ' not EN');
  }
}

assert.doesNotMatch(it['login.needHelpDetail'] || '', /\bstaff\b/i);

function makeT(loc) {
  const pack = STAFF_PORTAL_STRINGS[loc];
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

function runStay(loc) {
  const sandbox = {
    escHtml: function (s) { return String(s == null ? '' : s); },
    t: makeT(loc),
    window: {},
  };
  sandbox.window = sandbox;
  sandbox.window.formatStaffPortalDate = function () { return 'X'; };
  vm.createContext(sandbox);
  vm.runInContext(
    [
      sliceFn('bcStayNightsFromCheckInOut'),
      sliceFn('bcSideHeaderDateLabel'),
      sliceFn('bcSideStayMetaHtml'),
    ].join('\n'),
    sandbox,
  );
  return sandbox;
}

const esStay = runStay('es');
const itStay = runStay('it');
assert.match(esStay.bcSideStayMetaHtml('2026-10-21', '2026-10-22', 1), /1 noche/);
assert.doesNotMatch(esStay.bcSideStayMetaHtml('2026-10-21', '2026-10-22', 1), /noches/);
assert.match(itStay.bcSideStayMetaHtml('2026-10-21', '2026-10-22', 1), /1 notte/);
assert.doesNotMatch(itStay.bcSideStayMetaHtml('2026-10-21', '2026-10-22', 1), /notti/);
assert.match(esStay.bcSideStayMetaHtml('2026-10-21', '2026-10-25', 3), /4 noches/);
assert.match(itStay.bcSideStayMetaHtml('2026-10-21', '2026-10-25', 3), /4 notti/);

function runStatus(loc) {
  const sandbox = {
    escHtml: function (s) { return String(s == null ? '' : s); },
    t: makeT(loc),
  };
  vm.createContext(sandbox);
  vm.runInContext(sliceFn('bcCalendarDetailStatusLabel'), sandbox);
  return sandbox;
}

const esSt = runStatus('es');
const itSt = runStatus('it');
assert.equal(esSt.bcCalendarDetailStatusLabel('confirmed'), es['calendar.detail.status.confirmed']);
assert.equal(itSt.bcCalendarDetailStatusLabel('confirmed'), it['calendar.detail.status.confirmed']);
assert.doesNotMatch(esSt.bcCalendarDetailStatusLabel('confirmed'), /confirmed/i);
assert.doesNotMatch(itSt.bcCalendarDetailStatusLabel('confirmed'), /confirmed/i);
assert.equal(esSt.bcCalendarDetailStatusLabel('needs_review'), es['calendar.detail.status.needs_review']);
assert.equal(itSt.bcCalendarDetailStatusLabel('needs review'), it['calendar.detail.status.needs_review']);
assert.doesNotMatch(esSt.bcCalendarDetailStatusLabel('needs_review'), /needs review/i);
assert.doesNotMatch(itSt.bcCalendarDetailStatusLabel('needs_review'), /needs review/i);
assert.doesNotMatch(es['calendar.detail.roomingReview'], /Rooming review/i);
assert.doesNotMatch(it['calendar.detail.roomingReview'], /Rooming review/i);

for (const slug of STATUS_SLUGS) {
  const gotEs = esSt.bcCalendarDetailStatusLabel(slug);
  const gotIt = itSt.bcCalendarDetailStatusLabel(slug);
  assert.equal(gotEs, es['calendar.detail.status.' + slug]);
  assert.equal(gotIt, it['calendar.detail.status.' + slug]);
}

const unknownEs = esSt.bcCalendarDetailStatusLabel('brand_new_status');
assert.match(unknownEs, /Estado:/);
assert.doesNotMatch(unknownEs, /^brand new status$/);

const historyFns = [
  sliceFn('bcPaymentHistoryText'),
  sliceFn('bcAddonServiceTypeStaffLabel'),
  sliceFn('bcFormatAddonServicePaymentLedgerLabel'),
  sliceFn('bcPaymentLedgerRowDisplayLabel'),
].join('\n');
assert.doesNotMatch(historyFns, /Failed payment|Cancelled payment link|Paid cash|Paid bank transfer|Stripe paid|Draft payment|due at checkout/);
assert.match(api.slice(api.indexOf('function bcRefreshOpenDrawerI18n('), api.indexOf('window.staffPortalOnLocaleChange')), /bcRenderBlockSummaryPreviewHtml\(bcLastOpenedBlock\)/);
assert.match(api.slice(api.indexOf('window.staffPortalOnLocaleChange'), api.indexOf('window.staffPortalOnLocaleChange') + 700), /bcRefreshOpenDrawerI18n\(\)/);

function runHistory(loc) {
  const sandbox = {
    t: makeT(loc),
    bcPaymentLedgerParseMetadata: (value) => value || {},
    bcPaymentLedgerIsPaidStatus: (status) => status === 'paid' || status === 'deposit_paid',
    bcPaymentLedgerRowHasLinkUrl: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext(historyFns, sandbox);
  return sandbox;
}
for (const [loc, expected] of [
  ['es', ['Pago en efectivo', 'Pago por transferencia bancaria', 'Enlace de Stripe pendiente de pago', 'Alquiler de neopreno — Pagado']],
  ['it', ['Pagamento in contanti', 'Pagamento con bonifico bancario', 'Link Stripe in attesa di pagamento', 'Noleggio muta — Pagato']],
]) {
  const history = runHistory(loc);
  assert.equal(history.bcPaymentLedgerRowDisplayLabel({ payment_status:'paid', metadata:{ method:'cash' } }), expected[0]);
  assert.equal(history.bcPaymentLedgerRowDisplayLabel({ payment_status:'paid', metadata:{ method:'bank_transfer' } }), expected[1]);
  assert.equal(history.bcPaymentLedgerRowDisplayLabel({ payment_status:'checkout_created', metadata:{} }), expected[2]);
  assert.equal(history.bcPaymentLedgerRowDisplayLabel({ payment_status:'paid', payment_kind:'addon_service', metadata:{ service_type:'wetsuit' } }), expected[3]);
}

console.log('PASS verify-staff-cal-detail-i18n');
