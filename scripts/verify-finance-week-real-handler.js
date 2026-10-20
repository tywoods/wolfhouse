'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { computeSunsetFinanceSummary } = require('./lib/sunset-finance-summary');
function functionSource(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2);
}
const api = fs.readFileSync(require.resolve('./staff-query-api.js'), 'utf8');
const ui = fs.readFileSync(require.resolve('./browser/sunset-admin-ui.js'), 'utf8');
const server = vm.createContext({ Date, SQL_INJECT_RE: /[;]/,
  assertStaffClientAccess: () => true,
  withPgClient: async fn => fn({}), fetchLodgingFinanceData: async () => ({ bookings: [], bsr: [], payments: [] }),
  computeSunsetFinanceSummary, computeWolfhouseCreatorFinance: () => ({}),
  send400: (_res, error) => ({ status: 400, data: { error } }),
  sendJSON: (_res, status, data) => ({ status, data }), console });
vm.runInContext('async ' + functionSource(api, 'handleAdminFinanceSummaryGet'), server);
let request;
const body = { contains: () => true };
const browser = vm.createContext({ financeViewState: { granularity: 'month', anchor: '2026-10-14' },
  financeSummaryHost: () => body, financeCustomClosePopover: () => {},
  financeViewSeedAnchor: () => '2026-10-14', el: () => null, window: {},
  loadAdminFinanceSummary: () => { request = browser.financeViewQuery(); } });
vm.runInContext(functionSource(ui, 'financeViewQuery') + '\n' + functionSource(ui, 'financeRedesignNavClick'), browser);
const button = { getAttribute: key => key === 'data-finance-gran' ? 'week' : null };
browser.financeRedesignNavClick({ target: { closest: () => button } });
assert.match(request, /granularity=week/);
const query = Object.fromEntries(new URLSearchParams(request));
query.client = 'wolfhouse-somo';
(async () => {
  const impossible = await server.handleAdminFinanceSummaryGet({...query, anchor:'2026-02-30'}, {}, {}, {});
  assert.strictEqual(impossible.status, 400, 'impossible anchor date must fail before finance fetch');
  const impossibleStart = await server.handleAdminFinanceSummaryGet({...query, granularity:'custom', start:'2026-02-30', end:'2026-03-02'}, {}, {}, {});
  assert.strictEqual(impossibleStart.status, 400, 'impossible custom start date must fail before finance fetch');
  const impossibleEnd = await server.handleAdminFinanceSummaryGet({...query, granularity:'custom', start:'2026-02-01', end:'2026-02-30'}, {}, {}, {});
  assert.strictEqual(impossibleEnd.status, 400, 'impossible custom end date must fail before finance fetch');
  const nonLeap = await server.handleAdminFinanceSummaryGet({...query, anchor:'2027-02-29'}, {}, {}, {});
  assert.strictEqual(nonLeap.status, 400, 'non-leap February 29 must fail before finance fetch');
  const leap = await server.handleAdminFinanceSummaryGet({...query, anchor:'2028-02-29'}, {}, {}, {});
  assert.strictEqual(leap.status, 200, 'valid leap-day anchor must reach finance summary');
  const { status, data } = await server.handleAdminFinanceSummaryGet(query, {}, {}, {});
  assert.strictEqual(status, 200);
  assert.strictEqual(data.summary.redesign.view.granularity, 'week', 'actual Week click must survive actual HTTP handler');
  assert.strictEqual(data.summary.redesign.view.range.start, '2026-10-12');
  assert.strictEqual(data.summary.redesign.view.range.end, '2026-10-18');
  console.log('PASS verify-finance-week-real-handler');
})().catch(error => { console.error(error); process.exitCode = 1; });
