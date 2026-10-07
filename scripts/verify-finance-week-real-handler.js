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
  computeSunsetFinanceSummary, send400: () => { throw Error('400'); },
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
server.handleAdminFinanceSummaryGet(query, {}, {}, {}).then(({ status, data }) => {
  assert.strictEqual(status, 200);
  assert.strictEqual(data.summary.redesign.view.granularity, 'week', 'actual Week click must survive actual HTTP handler');
  assert.strictEqual(data.summary.redesign.view.range.start, '2026-10-12');
  assert.strictEqual(data.summary.redesign.view.range.end, '2026-10-18');
  console.log('PASS verify-finance-week-real-handler');
}).catch(error => { console.error(error); process.exitCode = 1; });
