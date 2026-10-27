'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { computeWolfhouseCreatorFinance } = require('./lib/sunset-finance-summary');

const uiPath = process.env.WH_FINANCE_UI_PATH || path.join(__dirname, 'browser/sunset-admin-ui.js');
const ui = fs.readFileSync(uiPath, 'utf8');
let pass = 0;
let fail = 0;
function ok(name, value) {
  if (value) pass += 1;
  else fail += 1;
  console.log(`  ${value ? 'PASS' : 'FAIL'}  ${name}`);
}
function fn(name) {
  const start = ui.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  let i = ui.indexOf('{', start);
  let depth = 0;
  for (; i < ui.length; i += 1) {
    if (ui[i] === '{') depth += 1;
    else if (ui[i] === '}' && !--depth) return ui.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

// Real Staff producer probe: an unresolved source makes every creator bucket
// and total partial, carrying `reason_codes`.
const projection = computeWolfhouseCreatorFinance({
  now: new Date('2026-10-17T12:00:00.000Z'),
  view: { granularity: 'month', anchor: '2026-10-17' },
  currency: 'EUR', payments: [], refund_records: [],
  bookings: [
    // Booking currency is intentionally missing/stale: the producer must use
    // Staff's property currency, while the no-source booking rolls into Staff.
    { booking_id: 'luna', created_at: '2026-10-01T10:00:00Z', total_amount_cents: 10000, currency: null, metadata: { source: 'luna_guest' } },
    { booking_id: 'staff', created_at: '2026-10-02T10:00:00Z', total_amount_cents: 20000, currency: 'UNKNOWN', metadata: { source: 'staff' } },
    { booking_id: 'unknown', created_at: '2026-10-03T10:00:00Z', total_amount_cents: 0, currency: null, metadata: {} },
  ],
});
const period = { booked_cents: 30000, collected_gross_cents: 0, outstanding_cents: 30000, bookings_count: 3 };
const summary = { redesign: { view: { granularity: 'month', range: { start: '2026-10-01', end: '2026-10-31' } } }, periods: { today: period, week: period, month: period }, daily_trend: [] };
const expected = /Luna.*1.*€100\.00[\s\S]*Staff.*2.*€200\.00[\s\S]*Total.*3.*€300\.00/;

function makeContext() {
  const body = { innerHTML: '', contains: () => true, dataset: {} };
  const ctx = {
    Promise, console, setTimeout, clearTimeout, window: {}, Intl,
    portalLang: 'en', financeLoadSeq: 0, financeLastSummary: null, financeLastCreator: null,
    financeWolfhouseLoadFailed: false, financeSummaryPhase: 'success',
    financeViewState: { granularity: 'month', anchor: '2026-10-01', start: null, end: null },
    financeCustomDraft: { start: null, end: null }, financeCustomFocusIso: null,
    escHtml: value => String(value),
    portalT: key => ({
      'admin.finance.loading': 'Loading', 'admin.finance.booked': 'Booked sales',
      'admin.finance.collectedGross': 'Net collected', 'admin.finance.outstanding': 'Balance still due',
      'admin.finance.bookings': 'Bookings', 'admin.finance.grossNote': '',
      'admin.finance.today': 'Today', 'admin.finance.week': 'Week', 'admin.finance.month': 'Month',
    }[key] || key),
    getClient: () => 'wolfhouse-somo', getSunsetLocation: () => '',
    portalIsLodgingAdmin: () => true, el: () => body,
    adminClientQuery: () => '?client=wolfhouse-somo', financeViewQuery: () => '',
    // Guards: rollback handlers must not dispatch to either redesign renderer.
    renderFinanceRedesignHtml: () => { throw new Error('unexpected Sunset redesign render'); },
    renderWolfhouseCreatorFinanceHtml: () => { throw new Error('unexpected Wolfhouse redesign render'); },
    financePaintStored: () => { throw new Error('unexpected retained redesign paint'); },
    wireFinanceRedesignNav: () => {}, wireFinanceRetry: () => {},
    financeApplyYearWindow: () => {}, financeViewSeedAnchor: () => '2026-10-01', financeCustomClosePopover: () => {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, summary, wolfhouse_creator_finance: projection }) }),
  };
  vm.createContext(ctx);
  [
    'financeFmtEur', 'financePeriodEmpty', 'financeMetricRow', 'financeCard', 'renderFinanceTrendHtml',
    'renderWolfhouseCreatorCountRow', 'renderFinanceSummaryHtml', 'financeSummaryHost', 'wolfhouseCreatorFinanceIsV1',
    'loadAdminFinanceSummary', 'adminRefreshOnLocaleChange', 'financeRedesignNavClick',
  ].forEach(name => vm.runInContext(fn(name), ctx));
  return { ctx, body };
}
async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}
async function route(name, action) {
  try {
    await action();
  } catch (error) {
    console.log(`  route error: ${error.message}`);
    ok(name, false);
  }
}
function originalLayout(html) {
  return /Net collected/.test(html) && /Booked sales/.test(html) && /Balance still due/.test(html) && !html.includes('Creator comparison');
}

(async () => {
  const { ctx, body } = makeContext();
  await route('initial handler renders original summary and Luna 1 / Staff 2 / Total 3', async () => {
    ctx.loadAdminFinanceSummary();
    await settle();
    ok('initial handler renders original summary and Luna 1 / Staff 2 / Total 3', originalLayout(body.innerHTML) && expected.test(body.innerHTML));
  });

  // Locale repaint must render from retained server facts rather than a source regex or a stubbed renderer.
  body.innerHTML = 'LOCALE_SENTINEL';
  await route('locale handler repaints original summary from retained projection', async () => {
    ctx.adminRefreshOnLocaleChange();
    ok('locale handler repaints original summary from retained projection', originalLayout(body.innerHTML) && expected.test(body.innerHTML));
  });

  // The ordinary Days trend route must retain the same original summary, never
  // switch to either redesign renderer.
  body.innerHTML = 'TREND_SENTINEL';
  const button = { getAttribute: key => key === 'data-finance-trend' ? 'days' : null };
  await route('trend handler renders original summary and retained creator counts', async () => {
    ctx.financeRedesignNavClick({ target: { closest: () => button }, preventDefault: () => {} });
    await settle();
    ok('trend handler renders original summary and retained creator counts', originalLayout(body.innerHTML) && expected.test(body.innerHTML));
  });

  console.log(`\n── finance rollback gate: ${pass} passed, ${fail} failed ──`);
  if (fail) process.exitCode = 1;
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
