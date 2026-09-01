'use strict';

/**
 * Bug Finder sunset price pass 29 Aug — Admin Finanzas loaded empty (unavailable
 * shell / no figures) while Reservas showed unpaid staff bookings
 * (Collected €0, Outstanding €440, 7 bookings).
 *
 * Root cause: Sunset Admin painted renderAdminFinanceShell on config reload /
 * Admin open, but unlike Wolfhouse did not refetch on Finanzas sub-tab select.
 * A Precios save → adminReloadConfig left Finanzas on the unavailable placeholder.
 *
 * This gate proves:
 *  1) Finanzas sub-tab select / Admin reload refetch finance (not stranded shell)
 *  2) Unpaid staff fixture outstanding matches Reservas summary vs Finanzas
 *     redesign for the same booking set in the selected period
 *     (figures from the Bug Finder report: 7 bookings, €440.00 outstanding).
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

const { computeBookingsSummary } = require('./lib/sunset-bookings-admin');
const { computeSunsetFinanceSummary } = require('./lib/sunset-finance-summary');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra != null ? ` (${extra})` : ''}`); }
}
function eq(label, got, want) {
  ok(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

const adminUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
const wolfUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/wolfhouse-admin-ui.js'), 'utf8');

// ——— Source: Sunset mirrors Wolfhouse finance-on-select ———
ok('Wolfhouse selects finance → loadAdminFinanceSummary',
  /next === 'finance' && typeof loadAdminFinanceSummary === 'function'\) loadAdminFinanceSummary\(\)/.test(wolfUi));
ok('Sunset adminSelectSubTab finance → loadAdminFinanceSummary (unless skipFinanceLoad)',
  /function adminSelectSubTab\([\s\S]*?next === 'finance' && !\(opts && opts.skipFinanceLoad\) && typeof loadAdminFinanceSummary === 'function'\) loadAdminFinanceSummary\(\)/.test(adminUi));
ok('loadAdminTab skipFinanceLoad then one scoped finance fetch (no shell-first flash)',
  /adminSelectSubTab\(adminActiveSubTab, \{ skipFinanceLoad: true \}\)/.test(adminUi)
  && /adminActiveSubTab === 'finance'[\s\S]*?loadAdminFinanceForCurrentScope\(\)/.test(adminUi)
  && !/adminSelectSubTab\(adminActiveSubTab\);\s*renderAdminFinanceShell\(\);/.test(adminUi));
ok('loadAdminTab refetches finance when body stayed empty after config load',
  /adminActiveSubTab === 'finance'\) financeEnsureLoadedIfEmpty\(\)/.test(adminUi));
ok('renderAdminFinanceShell uses financeSummaryHost (Sunset vs Wolfhouse body)',
  /function renderAdminFinanceShell\([\s\S]*?financeSummaryHost\(\)/.test(adminUi));
ok('adminReloadConfig still calls loadAdminTab (shell path)',
  /function adminReloadConfig\(\)\{[\s\S]*?loadAdminTab\(\);/.test(adminUi));

// ——— Runtime: Precios save miss → Finanzas select recovers ———
const calls = [];
const els = {
  'admin-panel-finance': { removeAttribute() {}, setAttribute() {} },
  'admin-panel-pricing': { removeAttribute() {}, setAttribute() {} },
  'admin-panel-luna-staff': { removeAttribute() {}, setAttribute() {} },
  'admin-panel-email': { removeAttribute() {}, setAttribute() {} },
  'tab-ask-luna': { classList: { toggle() {} } },
};
const ctx = {
  adminActiveSubTab: 'pricing',
  document: {
    querySelectorAll() { return []; },
    body: { dataset: {} },
  },
  el(id) { return els[id] || null; },
  portalT(k) { return k; },
  escHtml(s) { return String(s); },
  getClient() { return 'sunset'; },
  getSunsetLocation() { return 'sunset-somo'; },
  getPortalProfile() { return { is_surf_vertical: true }; },
  loadAdminFinanceSummary() { calls.push('loadAdminFinanceSummary'); },
  loadAdminFinanceForCurrentScope() { calls.push('loadAdminFinanceForCurrentScope'); },
  adminBeginOp() { return 1; },
  adminReleaseBusy() {},
  adminClearBusy() {},
  adminClearPricingDraftState() {},
  adminSyncEmailTabVisibility() {},
  wireAdminTab() {},
  wireAdminSubTabs() {},
  adminClearEquipErrors() {},
  renderAdminFinanceShell() { calls.push('renderAdminFinanceShell'); },
  renderAdminLoadingShell() {},
  renderAdminFromConfig() {},
  renderAdminFallback() {},
  console,
};
vm.createContext(ctx);

const selectFn = adminUi.match(/function adminSelectSubTab\([\s\S]*?\n\}/);
ok('extracted adminSelectSubTab', !!selectFn);
vm.runInContext(selectFn[0], ctx);

calls.length = 0;
ctx.adminActiveSubTab = 'pricing';
ctx.adminSelectSubTab('finance');
eq('select Finanzas from Precios triggers finance load', calls.join(','), 'loadAdminFinanceSummary');

const loadTabFn = adminUi.match(/function loadAdminTab\([\s\S]*?\n(?=function |$)/);
ok('extracted loadAdminTab', !!loadTabFn && /loadAdminFinanceForCurrentScope/.test(loadTabFn[0]));
// Exercise finance-open path: skip stacked select-load, one scoped fetch, no unavailable shell first.
vm.runInContext(`
function loadAdminTabFinanceRefetchStub(){
  adminActiveSubTab = 'finance';
  adminSelectSubTab(adminActiveSubTab, { skipFinanceLoad: true });
  if (adminActiveSubTab === 'finance' && typeof loadAdminFinanceForCurrentScope === 'function') {
    loadAdminFinanceForCurrentScope();
  } else if (typeof renderAdminFinanceShell === 'function') {
    renderAdminFinanceShell();
  }
}
`, ctx);
calls.length = 0;
ctx.loadAdminTabFinanceRefetchStub();
ok('Admin reload on Finanzas: one scoped refetch, no unavailable shell first',
  calls.indexOf('loadAdminFinanceForCurrentScope') >= 0
  && calls.indexOf('renderAdminFinanceShell') < 0
  && calls.filter(function (c) { return c === 'loadAdminFinanceSummary'; }).length === 0,
  calls.join(','));
ok('Admin reload on Finanzas: skipFinanceLoad prevented stacked summary fetch',
  calls.indexOf('loadAdminFinanceSummary') < 0, calls.join(','));

// ——— Money parity: Bug Finder report fixture (do not invent — use reported figures) ———
// Reservas: 7 unpaid staff bookings, Collected €0, Outstanding €440.00 (= 44000¢).
const BUG_BOOKINGS_COUNT = 7;
const BUG_OUTSTANDING_CENTS = 44000;
const BUG_COLLECTED_CENTS = 0;
const now = new Date('2026-08-29T12:00:00Z');
const dues = [8000, 6000, 6000, 6000, 6000, 6000, 6000]; // 8000+6×6000 = 44000
ok('fixture dues sum to Bug Finder outstanding', dues.reduce((a, b) => a + b, 0) === BUG_OUTSTANDING_CENTS);

const bookings = [];
const bsr = [];
for (let i = 0; i < BUG_BOOKINGS_COUNT; i++) {
  const id = 'staff-unpaid-' + i;
  const due = dues[i];
  bookings.push({
    booking_id: id,
    total_amount_cents: due,
    balance_due_cents: due,
    status: 'payment_pending',
    payment_status: 'waiting_payment',
    collected_cents: 0,
    outstanding_cents: due,
    charged_cents: due,
  });
  bsr.push({
    booking_id: id,
    service_date: '2026-08-29',
    service_type: 'group_lesson',
    quantity: 1,
    amount_due_cents: due,
    metadata: { source: 'staff_manual_schedule' },
  });
}

const reservas = computeBookingsSummary(bookings);
eq('Reservas summary bookings_count', reservas.bookings_count, BUG_BOOKINGS_COUNT);
eq('Reservas summary collected_cents', reservas.collected_cents, BUG_COLLECTED_CENTS);
eq('Reservas summary outstanding_cents', reservas.outstanding_cents, BUG_OUTSTANDING_CENTS);

const finance = computeSunsetFinanceSummary({
  bookings: bookings.map((b) => ({
    booking_id: b.booking_id,
    total_amount_cents: b.total_amount_cents,
    balance_due_cents: b.balance_due_cents,
  })),
  bsr,
  payments: [],
  refund_records: [],
  now,
  timeZone: 'Europe/Madrid',
  view: { granularity: 'month', anchor: '2026-08-29' },
});
const out = finance.redesign && finance.redesign.outstanding;
const pipe = finance.redesign && finance.redesign.pipeline;
eq('Finanzas outstanding_cents matches Reservas', out.outstanding_cents, reservas.outstanding_cents);
eq('Finanzas outstanding bookings_count matches Reservas', out.bookings_count, reservas.bookings_count);
eq('Finanzas pipeline bookings_count matches Reservas', pipe.bookings_count, reservas.bookings_count);
eq('Finanzas net/gross collected stays €0 with unpaid staff',
  finance.redesign.net.gross_collected_cents, BUG_COLLECTED_CENTS);

console.log(`\nverify:sunset-finance-empty-load-reservas-parity  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
