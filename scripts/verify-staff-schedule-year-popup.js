'use strict';

// Year popup: one-based month, this year and next year, Refresh on the far right.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
assert.match(api, /id="bc-month-nav" hidden/);
assert.match(api, /id="bc-year-open"/);
assert.match(api, /window\.t\('calendar\.yearPopup\.empty'\)/);
assert.match(api, /order:99/);
assert.match(api, /#tab-bed-calendar #bc-range-wrap\{display:none!important\}/);
const refreshAt = api.indexOf('id="bc-load"');
assert.ok(refreshAt > 0, 'Refresh stays');

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
const title = { textContent: '', expanded: 'false', setAttribute() {} };
const yearBtn = { expanded: 'false', setAttribute: (k, v) => { if (k === 'aria-expanded') yearBtn.expanded = v; } };
const start = { value: '2026-10-01' };
const sandbox = {
  window: { t: (key) => (key === 'calendar.yearPopup.empty' ? 'Aún no hay años de reserva' : key) },
  bcData: { booking_years: [2024], blocks: [] },
  el: (id) => ({ 'bc-year-pop': pop, 'bc-calendar-title': title, 'bc-year-open': yearBtn, 'bc-start': start }[id] || null),
  document: { createElement: () => ({ className: '', textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }) },
  bcReadDateField: (field) => field && field.value,
  bcSetRange: (a, b) => calls.push(['range', a, b]),
  Date: Date,
  Number: Number,
  String: String,
  console,
};
vm.createContext(sandbox);
const names = ['bcFourDigitYear', 'bcBookingYearsFromData', 'bcYearEmptyText', 'bcCloseYearPop', 'bcRenderYearPop', 'bcOpenYearPop', 'bcJumpToBookingYear', 'bcMonthWindow'];
vm.runInContext(names.map(extractFunction).join('\n') + '\nthis.api = { bcBookingYearsFromData, bcYearEmptyText, bcRenderYearPop, bcOpenYearPop, bcCloseYearPop, bcJumpToBookingYear, bcMonthWindow };', sandbox);

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
sandbox.api.bcOpenYearPop();
assert.equal(yearBtn.expanded, 'true');
assert.equal(title.expanded, 'false');
sandbox.api.bcCloseYearPop();
assert.equal(yearBtn.expanded, 'false');
pop.hidden = false;
yearBtn.expanded = 'true';
jump('2026-10-01', '2027');
assert.equal(pop.hidden, true);
assert.equal(yearBtn.expanded, 'false');

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

async function measure(page, width) {
  await page.setViewportSize({ width, height: 900 });
  return page.evaluate(() => {
    function box(id) {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    }
    const chip = document.querySelector('[data-chip="oct-nov"]');
    chip.scrollIntoView({ block: 'nearest', inline: 'center' });
    const chipRect = chip.getBoundingClientRect();
    const hit = document.elementFromPoint(chipRect.x + chipRect.width / 2, chipRect.y + chipRect.height / 2);
    return {
      range: box('bc-range-btn'),
      refresh: box('bc-load'),
      title: box('bc-calendar-title'),
      chips: box('bc-chips'),
      chip: { x: chipRect.x, y: chipRect.y, right: chipRect.right, bottom: chipRect.bottom },
      chipHit: !!(hit && (hit === chip || chip.contains(hit))),
    };
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent('<!DOCTYPE html><html><head><style>' + css + '</style></head><body><div id="tab-bed-calendar" class="active"><div id="wrap-bc"><div class="card">' + toolbarHtml + '</div></div></div><script>document.querySelectorAll(".bc-chip").forEach(function(el){el.addEventListener("click", function(){ window.__chip = el.dataset.chip; });});</script></body></html>');
  for (const width of [390, 768]) {
    const boxes = await measure(page, width);
    assert.ok(boxes.title.bottom <= boxes.chips.y + 2, width + ' title is not above the chips ' + JSON.stringify(boxes));
    assert.ok(boxes.refresh.bottom <= boxes.chips.y + 4, width + ' Refresh covers the chip row ' + JSON.stringify(boxes));
    assert.equal(boxes.chipHit, true, width + ' Oct-Nov is covered');
    await page.evaluate(() => { window.__chip = ''; });
    await page.locator('[data-chip="oct-nov"]').click({ timeout: 3000 });
    assert.equal(await page.evaluate(() => window.__chip), 'oct-nov', width + ' native chip click missed');
  }
  for (const width of [769, 1440]) {
    const boxes = await measure(page, width);
    assert.ok(!boxes.range || boxes.range.width === 0, width + ' range pill takes no layout ' + JSON.stringify(boxes.range));
    assert.ok(boxes.refresh.x >= boxes.chip.right - 1, width + ' Refresh is not right of the chips ' + JSON.stringify(boxes));
    assert.ok(boxes.refresh.right <= width + 1, width + ' Refresh offscreen');
    assert.equal(boxes.chipHit, true, width + ' Oct-Nov is not clickable');
  }
  const built = spawnSync(process.execPath, ['-e', "process.env.NODE_ENV='test';process.env.STAFF_UI_BUILDER_TEST_SEAM='1';process.env.STAFF_AUTH_REQUIRED='false';process.env.STAFF_AUTH_ALLOW_OPEN='true';process.stdout.write(require('./scripts/staff-query-api.js').buildUiHtmlForOfflineTest(0, 'wolfhouse-somo'));"], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(built.status, 0, 'full page build failed');
  const live = await browser.newPage();
  await live.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"rooms":[],"blocks":[],"days":[],"booking_years":[]}' }));
  await live.setContent(built.stdout, { waitUntil: 'domcontentloaded' });
  for (const width of [390, 768, 769, 1440]) {
    const boxes = await measure(live, width);
    if (width <= 768) {
      assert.ok(boxes.title.bottom <= boxes.chips.y + 2, 'full page ' + width + ' title is not above the chips');
      assert.ok(boxes.refresh.bottom <= boxes.chips.y + 4, 'full page ' + width + ' Refresh covers the chip row');
    } else {
      assert.ok(boxes.refresh.x >= boxes.chip.right - 1, 'full page ' + width + ' Refresh is not right of the chips');
    }
    assert.equal(boxes.chipHit, true, 'full page ' + width + ' Oct-Nov is covered');
    await live.locator('[data-chip="oct-nov"]').click({ timeout: 3000 });
  }
  await live.close();
  await browser.close();
  console.log('PASS schedule year popup');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
