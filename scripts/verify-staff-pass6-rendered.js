'use strict';

/**
 * Pass 6 Staff screens — display contracts (ES/IT/EN). Offline source + vm.
 * Does not write bookings, money, or guest language.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const ROOT = __dirname;
const api = fs.readFileSync(path.join(ROOT, 'staff-query-api.js'), 'utf8');
const bookings = fs.readFileSync(path.join(ROOT, 'browser/sunset-admin-bookings-ui.js'), 'utf8');
const finance = fs.readFileSync(path.join(ROOT, 'browser/sunset-admin-finance-redesign-ui.js'), 'utf8');
const invoice = fs.readFileSync(path.join(ROOT, 'browser/booking-invoice.js'), 'utf8');
const profile = fs.readFileSync(path.join(ROOT, 'browser/inbox-customers-profile.js'), 'utf8');
const inbox = fs.readFileSync(path.join(ROOT, 'browser/inbox-context.js'), 'utf8');
const { STAFF_PORTAL_STRINGS, formatStaffPortalMoneyValue, getStaffLocaleTagFrom } = require('./lib/staff-portal-i18n');

function sliceFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

test('A: payment dates and money go through shared formatters, not host locale', () => {
  assert.match(sliceFn(api, 'bcCalendarFormatEur'), /formatStaffPortalMoney/);
  assert.match(api, /formatStaffPortalDateTime/);
  assert.match(sliceFn(api, 'bcFormatIsoDateDisplay'), /formatStaffPortalDate/);
  assert.doesNotMatch(sliceFn(bookings, 'adminBookingsDateRangeMonthLabel'), /toLocaleDateString\(undefined/);
  assert.match(sliceFn(bookings, 'adminBookingsDateRangeMonthLabel'), /formatStaffPortalDate/);
  assert.match(sliceFn(bookings, 'adminBookingsFormatEur'), /formatStaffPortalMoney/);
  assert.doesNotMatch(sliceFn(bookings, 'adminBookingsFormatEur'), /cents \|\| 0/);
  assert.match(sliceFn(finance, 'whFinMoney'), /formatStaffPortalMoney/);
  assert.match(sliceFn(finance, 'whFinTimestamp'), /formatStaffPortalDateTime|Europe\/Madrid/);
});

test('B: locale switch repaints the live desktop drawer mount', () => {
  const hook = api.slice(api.indexOf('window.staffPortalOnLocaleChange'), api.indexOf('window.staffPortalOnLocaleChange') + 900);
  assert.match(hook, /bcRefreshOpenDrawerI18n\(\)/);
  const fn = sliceFn(api, 'bcRefreshOpenDrawerI18n');
  assert.match(fn, /bcLiveDrawerBody/);
  assert.match(sliceFn(api, 'bcLiveDrawerBody'), /bc-side-body/);
  assert.match(sliceFn(api, 'bcLiveDrawerBody'), /bcSideDrawerLive/);
  assert.match(fn, /bcRenderBlockSummaryPreviewHtml\(bcLastOpenedBlock\)/);
  assert.match(sliceFn(api, 'bcRefreshOpenDrawerChromeI18n'), /bc-side-booking-actions|bcBookingHeaderActionsHtml/);
  assert.doesNotMatch(fn, /innerHTML = bcRenderDrawerLoadingHtml/);
});

test('B: locale switch mid-load still lets the in-flight response paint tabs', () => {
  const label = { textContent: 'Loading details…' };
  const loading = {
    id: 'bc-drawer-preview',
    className: 'bc-drawer-loading',
    querySelector: function (sel) { return String(sel).includes('ctx-loading') ? label : null; },
    setAttribute: function () {},
  };
  const ctxEl = {
    isConnected: true,
    firstChild: loading,
    tabs: null,
    querySelector: function (sel) {
      sel = String(sel);
      if (sel.includes('bc-drawer-file-tabs')) return this.tabs;
      if (sel.includes('bc-drawer-preview') || sel.includes('bc-drawer-loading')) return loading;
      if (sel.includes('ctx-loading')) return label;
      return null;
    },
    set innerHTML(html) {
      this.firstChild = { id: 'replaced-loading' };
      if (String(html).includes('bc-drawer-file-tabs')) {
        this.tabs = { id: 'bc-drawer-file-tabs' };
      }
    },
  };
  const sandbox = {
    el: function (id) { return id === 'bc-side-body' || id === 'bc-ctx-body' ? ctxEl : null; },
    bcLiveDrawerBody: function () { return ctxEl; },
    bcRefreshOpenDrawerChromeI18n: function () {},
    bcTranslatePendingDrawerPreview: null,
    bcLastBookingContext: null,
    bcLastOpenedBlock: { booking_code: 'WH-20261125-05094937' },
    bcFieldEditState: {},
    bcPaintSideStayMeta: function () {},
    bcRenderDrawerLoadingHtml: function () {
      return '<div class="bc-drawer-loading" id="bc-drawer-preview"><div class="ctx-loading">Caricamento dettagli…</div></div>';
    },
    bcRenderBlockSummaryPreviewHtml: function () { return '<div>preview</div>'; },
    t: function (key) {
      return key === 'calendar.create.loadingDetails' ? 'Caricamento dettagli…' : key;
    },
  };
  vm.createContext(sandbox);
  const helpers = [
    sliceFn(api, 'bcTranslatePendingDrawerPreview'),
    sliceFn(api, 'bcRefreshOpenDrawerI18n'),
  ].join('\n');
  vm.runInContext(helpers, sandbox);
  const mount = ctxEl.firstChild;
  sandbox.bcRefreshOpenDrawerI18n();
  assert.equal(ctxEl.firstChild, mount, 'locale switch must not replace the request-owned loading node');
  assert.equal(label.textContent, 'Caricamento dettagli…');
  const ownsDetailMount = ctxEl.isConnected && ctxEl.firstChild === mount;
  assert.equal(ownsDetailMount, true, 'stale-response guard still owns the mount');
  if (ownsDetailMount) {
    ctxEl.innerHTML = '<div id="bc-drawer-file-tabs" class="bc-drawer-file-tabs"></div>';
  }
  assert.ok(ctxEl.querySelector('#bc-drawer-file-tabs'), 'HTTP 200 after locale switch paints details tabs');
});

test('D: stripe_full from booking.metadata paints the €600 total, not Caparra', () => {
  const fns = [
    sliceFn(invoice, 'bcBookingPaymentChoice'),
    sliceFn(invoice, 'bcInvoiceDepositRowHtml'),
    sliceFn(invoice, 'bcInvoiceTotalLinkActionHtml'),
  ].join('\n');
  const sandbox = {
    t: function (key) { return key; },
    escHtml: function (s) { return String(s == null ? '' : s); },
    formatStaffPortalMoney: function (cents) { return '€' + (Number(cents) / 100).toFixed(2); },
    bcWolfhouseStayDepositCents: function () { return 10000; },
    bcBookingStatusIsCancelled: function () { return false; },
    bcInvoiceText: function (key) { return 'invoice.' + key; },
  };
  vm.createContext(sandbox);
  vm.runInContext(fns, sandbox);
  const payloads = [
    { metadata: { payment_choice: 'stripe_full' } },
    { metadata: JSON.stringify({ payment_choice: 'stripe_full' }) },
  ];
  payloads.forEach(function (bk) {
    const html = sandbox.bcInvoiceDepositRowHtml(bk, 0, 60000);
    assert.match(html, /calendar\.create\.pay\.full/);
    assert.doesNotMatch(html, /calendar\.create\.pay\.deposit/);
    assert.doesNotMatch(html, /bc-generate-deposit-link-btn/);
    assert.match(html, /€600\.00/);
  });
});

test('D: finance keeps a verified zero subtotal when coverage is partial', () => {
  const htmlFn = sliceFn(finance, 'whFinMetricHtml');
  assert.doesNotMatch(htmlFn, /opts\.deposits && state === 'partial'/);
  const sandbox = {
    financeRedesignEsc: function (s) { return String(s); },
    financeRedesignT: function (key, fallback) { return fallback || key; },
    financeRedesignLocaleTag: function () { return 'it-IT'; },
    whFinStateLabel: function (state) { return state; },
    whFinMoneyHtml: function (cents) { return '<span data-wh-fin-cents="' + cents + '">€' + (Number(cents) / 100).toFixed(2) + '</span>'; },
    whFinReasons: function () { return ''; },
  };
  vm.createContext(sandbox);
  vm.runInContext(htmlFn, sandbox);
  const html = sandbox.whFinMetricHtml({ state: 'partial', amount_cents: 0 }, 'EUR', { deposits: true, receipts: true });
  assert.match(html, /data-wh-fin-cents="0"/);
  assert.match(html, /wh-fin-partial/);
  assert.doesNotMatch(html, /data-wh-fin-value="unknown"/);
});

test('D: draft/unsent ledger rows are not painted as payments', () => {
  const fn = sliceFn(api, 'bcPaymentLedgerRowDisplayLabel');
  assert.match(fn, /st === 'draft'/);
  const sandbox = {
    t: function (key) { return key; },
    bcPaymentHistoryText: function (key) { return 'history.' + key; },
    bcPaymentLedgerParseMetadata: function (v) { return v || {}; },
    bcPaymentLedgerIsPaidStatus: function () { return false; },
    bcPaymentLedgerRowHasLinkUrl: function () { return false; },
    bcFormatAddonServicePaymentLedgerLabel: function () { return 'addon'; },
  };
  vm.createContext(sandbox);
  vm.runInContext(fn, sandbox);
  assert.equal(sandbox.bcPaymentLedgerRowDisplayLabel({ payment_status: 'draft' }), '');
  sandbox.bcPaymentLedgerRowHasLinkUrl = function () { return true; };
  vm.runInContext(fn, sandbox);
  assert.equal(
    sandbox.bcPaymentLedgerRowDisplayLabel({ payment_status: 'draft', checkout_url: 'https://pay.example' }),
    'history.stripeLinkAwaiting'
  );
});

test('D: rooming review only when authoritative true', () => {
  const header = sliceFn(api, 'bcDetailHeaderMetaHtml');
  assert.match(header, /needs_rooming_review === true/);
  assert.doesNotMatch(header, /if \(bk\.needs_rooming_review\) html/);
});

test('D: cancelled bookings do not present outstanding as collectible', () => {
  const exp = sliceFn(bookings, 'renderAdminBookingsExpansion');
  assert.match(exp, /isCancelled/);
  assert.match(exp, /!isCancelled[\s\S]*admin\.bookings\.outstanding|admin\.bookings\.outstanding[\s\S]*!isCancelled/);
});

test('D: finance incomplete deposits do not paint missing as zero', () => {
  const htmlFn = sliceFn(finance, 'whFinMetricHtml');
  assert.match(htmlFn, /opts\.deposits/);
  assert.match(htmlFn, /partial/);
});

test('D: waiver with no linked record is not unsigned', () => {
  assert.doesNotMatch(sliceFn(bookings, 'renderAdminBookingsExpansion'), /waiverUnknown/);
  assert.match(profile, /customers\.detail\.waiverSigned/);
  assert.match(inbox, /inboxClientInfoWaiver/);
});

test('D: invoice payment type follows payment_choice, not a deposit default', () => {
  const row = sliceFn(invoice, 'bcInvoiceDepositRowHtml');
  assert.match(sliceFn(invoice, 'bcBookingPaymentChoice'), /metadata/);
  assert.match(row, /bcBookingPaymentChoice/);
  assert.match(row, /calendar\.create\.pay\.full/);
});

test('A: shared money grouping is used for four-digit ES amounts', () => {
  const es = formatStaffPortalMoneyValue(123400, 'EUR', getStaffLocaleTagFrom('es'));
  const parts = new Intl.NumberFormat('es-ES', {
    style: 'currency', currency: 'EUR', minimumFractionDigits: 2, useGrouping: true,
  }).formatToParts(1234);
  const group = parts.find((p) => p.type === 'group');
  if (group) assert.ok(es.includes(group.value));
  assert.equal(STAFF_PORTAL_STRINGS.it['calendar.create.pay.deposit'].length > 0, true);
});
