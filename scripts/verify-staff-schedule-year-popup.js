'use strict';

// Year popup lists years from booking data. The live month/year boxes stay hidden.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
assert.match(api, /id="bc-month-nav" hidden/);
assert.match(api, /#tab-bed-calendar #bc-month-nav\{display:none!important\}/);
assert.match(api, /id="bc-year-pop"/);
assert.match(api, /id="bc-calendar-title"/);
assert.match(api, /bed-calendar-booking-years/);
assert.match(api, /booking_years: bookingYears/);
const titleAt = api.indexOf('id="bc-calendar-title"');
const refreshAt = api.indexOf('id="bc-load"', titleAt);
const navAt = api.indexOf('id="bc-month-nav"', titleAt);
assert.ok(titleAt > 0 && refreshAt > titleAt && navAt > refreshAt, 'title, then refresh, then hidden nav');

function extractFunction(name) {
  const start = api.indexOf('function ' + name + '(');
  assert.ok(start > 0, name);
  let i = api.indexOf('{', start);
  let depth = 0;
  for (; i < api.length; i += 1) {
    if (api[i] === '{') depth += 1;
    else if (api[i] === '}') {
      depth -= 1;
      if (depth === 0) return api.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

const calls = [];
const pop = { hidden: true, innerHTML: '', children: [] };
pop.appendChild = (node) => pop.children.push(node);
const title = { textContent: '', expanded: 'false', setAttribute: (k, v) => { if (k === 'aria-expanded') title.expanded = v; } };
const start = { value: '2026-10-01' };
const sandbox = {
  bcData: {
    booking_years: [2027, 2026, 1899, 'nope'],
    blocks: [{ check_in: '2028-06-02' }, { start_date: '2019-01-01' }],
  },
  el: (id) => ({ 'bc-year-pop': pop, 'bc-calendar-title': title, 'bc-start': start }[id] || null),
  document: { createElement: (tag) => ({ tag, type: '', className: '', textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }) },
  bcReadDateField: (field) => field && field.value,
  bcMonthWindow: (year, month) => {
    calls.push(['window', year, month]);
    const startMonth = String(month + 1).padStart(2, '0');
    const endYear = month === 11 ? year + 1 : year;
    const endMonth = String(month === 11 ? 1 : month + 2).padStart(2, '0');
    return { start: year + '-' + startMonth + '-01', end: endYear + '-' + endMonth + '-01' };
  },
  bcSetRange: (a, b) => calls.push(['range', a, b]),
  console,
};
vm.createContext(sandbox);
const names = ['bcFourDigitYear', 'bcBookingYearsFromData', 'bcCloseYearPop', 'bcRenderYearPop', 'bcJumpToBookingYear'];
vm.runInContext(names.map(extractFunction).join('\n') + '\nthis.api = { bcBookingYearsFromData, bcRenderYearPop, bcJumpToBookingYear, bcCloseYearPop };', sandbox);

assert.equal(sandbox.api.bcBookingYearsFromData(sandbox.bcData).join(','), '2019,2026,2027,2028');
assert.equal(sandbox.api.bcBookingYearsFromData({ booking_years: [], blocks: [] }).join(','), '');
sandbox.api.bcRenderYearPop();
assert.equal(pop.children.map((node) => node.attrs['data-year']).join(','), '2019,2026,2027,2028');
sandbox.api.bcJumpToBookingYear('2027');
assert.equal(calls.map((row) => row.join(':')).join('|'), 'window:2027:9|range:2027-10-01:2027-11-01');
assert.equal(pop.hidden, true);
sandbox.api.bcJumpToBookingYear('1899');
assert.equal(calls.length, 2);

console.log('PASS schedule year popup');
