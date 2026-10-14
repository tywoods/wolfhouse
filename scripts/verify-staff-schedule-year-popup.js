'use strict';

// Year popup: one-based month, this year and next year, Refresh on the far right.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
assert.match(api, /id="bc-month-nav" hidden/);
assert.match(api, /id="bc-year-open"/);
assert.match(api, /window\.t\('calendar\.yearPopup\.empty'\)/);
assert.match(api, /order:99/);
const rangeAt = api.indexOf('id="bc-range-btn"');
const refreshAt = api.indexOf('id="bc-load"', rangeAt);
assert.ok(rangeAt > 0 && refreshAt > rangeAt, 'Refresh follows the range control');

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
  window: { t: (key) => (key === 'calendar.yearPopup.empty' ? 'Aún no hay años de reserva' : key) },
  bcData: { booking_years: [2024], blocks: [] },
  el: (id) => ({ 'bc-year-pop': pop, 'bc-calendar-title': title, 'bc-start': start }[id] || null),
  document: { createElement: () => ({ className: '', textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }) },
  bcReadDateField: (field) => field && field.value,
  bcSetRange: (a, b) => calls.push(['range', a, b]),
  Date: Date,
  Number: Number,
  String: String,
  console,
};
vm.createContext(sandbox);
const names = ['bcFourDigitYear', 'bcBookingYearsFromData', 'bcYearEmptyText', 'bcCloseYearPop', 'bcRenderYearPop', 'bcJumpToBookingYear', 'bcMonthWindow'];
vm.runInContext(names.map(extractFunction).join('\n') + '\nthis.api = { bcBookingYearsFromData, bcYearEmptyText, bcRenderYearPop, bcJumpToBookingYear, bcMonthWindow };', sandbox);

const clock = new Date(2026, 9, 14);
assert.equal(sandbox.api.bcBookingYearsFromData({ booking_years: [], blocks: [] }, clock).join(','), '2026,2027');
assert.equal(sandbox.api.bcBookingYearsFromData({ booking_years: [2024], blocks: [] }, clock).join(','), '2024,2026,2027');
assert.equal(sandbox.api.bcBookingYearsFromData({ booking_years: [], blocks: [] }, new Date(2027, 0, 1)).join(','), '2027,2028');
assert.equal(sandbox.api.bcYearEmptyText(), 'Aún no hay años de reserva');

function jump(iso, year) {
  calls.length = 0;
  start.value = iso;
  sandbox.api.bcJumpToBookingYear(year);
  return calls.map((row) => row.join(':')).join('|');
}
assert.equal(jump('2026-10-01', '2027'), 'range:2027-10-01:2027-11-01');
assert.equal(jump('2026-01-01', '2027'), 'range:2027-01-01:2027-02-01');
assert.equal(jump('2026-12-01', '2027'), 'range:2027-12-01:2028-01-01');
assert.equal(sandbox.api.bcMonthWindow(2027, 0), null, 'helper still rejects a zero-based month');

function slice(startMark, endMark) {
  const a = api.indexOf(startMark);
  const b = api.indexOf(endMark, a + startMark.length);
  assert.ok(a > 0 && b > a, startMark);
  return api.slice(a, b);
}
const toolbarHtml = eval('`' + slice('<!-- Controls card -->', '<!-- Warnings -->') + '`');
const css = [
  '.toolbar{display:flex;align-items:center;gap:10px}',
  '#tab-bed-calendar{display:block}',
  '#wrap-bc{max-width:100%;padding:4px 16px;box-sizing:border-box}',
  '.card{box-sizing:border-box}',
  eval('`' + slice('/* staff-portal-calendar:toolbar-row', '.bc-range-pick{') + '`'),
].join('\n');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent('<!DOCTYPE html><html><head><style>' + css + '</style></head><body><div id="tab-bed-calendar"><div id="wrap-bc"><div class="card">' + toolbarHtml + '</div></div></div></body></html>');
  for (const width of [769, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const boxes = await page.evaluate(() => {
      function box(id) {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, right: r.right, width: r.width };
      }
      return { range: box('bc-range-btn'), refresh: box('bc-load'), title: box('bc-calendar-title') };
    });
    assert.ok(boxes.refresh && boxes.range, width + ' missing controls');
    assert.ok(boxes.refresh.x >= boxes.range.right - 1, width + ' Refresh is not to the right of the range button ' + JSON.stringify(boxes));
    assert.ok(boxes.refresh.right <= width + 1, width + ' Refresh offscreen');
    assert.ok(boxes.title.x < boxes.range.x, width + ' title is not left of the range button');
  }
  await browser.close();
  console.log('PASS schedule year popup');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
