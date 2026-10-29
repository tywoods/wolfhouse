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

test('B: locale switch repaints the open drawer from raw state', () => {
  const hook = api.slice(api.indexOf('window.staffPortalOnLocaleChange'), api.indexOf('window.staffPortalOnLocaleChange') + 900);
  assert.match(hook, /bcRefreshOpenDrawerI18n\(\)/);
  assert.match(sliceFn(api, 'bcRefreshOpenDrawerI18n'), /bcRenderBlockSummaryPreviewHtml\(bcLastOpenedBlock\)/);
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
  assert.match(row, /payment_choice/);
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
