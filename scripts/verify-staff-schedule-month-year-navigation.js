'use strict';

// SCHEDULE-MONTH-YEAR-NAV-001
// Staff can jump to any month/year. Month shortcuts must follow the selected
// year. The calendar request uses an exclusive end (first of the next month).
const assert = require('node:assert/strict');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');

const src = readStaffPortalUiSource();

function extractFunction(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > 0, name + ' exists');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

assert.match(src, /id="bc-nav-month"/, 'month picker');
assert.match(src, /id="bc-nav-year"/, 'year field');
assert.match(src, /id="bc-nav-prev"/, 'previous month');
assert.match(src, /id="bc-nav-next"/, 'next month');
assert.match(src, /id="bc-nav-today"/, 'today');
assert.match(src, /calendar\.nav\.month/);
assert.match(src, /calendar\.nav\.year/);
assert.match(src, /calendar\.nav\.today/);

const chips = src.slice(src.indexOf("document.querySelectorAll('.bc-chip')"), src.indexOf('function loadTodaySummary'));
assert.equal(/bcSetRange\('2026-/.test(chips), false, 'production month shortcuts must not be pinned to 2026');
assert.match(chips, /bcMonthWindow\(/, 'month shortcuts use the selected-year window');
assert.match(src, /data-chip="demo"/, 'demo fixture preset stays isolated');

const monthWindow = extractFunction('bcMonthWindow');
const shift = extractFunction('bcShiftMonth');
const sandbox = { window: {}, Date };
const fn = new Function('window', 'Date', monthWindow + '\n' + shift + '\nreturn { bcMonthWindow, bcShiftMonth };');
const api = fn(sandbox.window, Date);

const june = api.bcMonthWindow(2027, 6);
assert.deepEqual(june, { start: '2027-06-01', end: '2027-07-01' });

const feb = api.bcMonthWindow(2028, 2);
assert.deepEqual(feb, { start: '2028-02-01', end: '2028-03-01' });

const dec = api.bcMonthWindow(2027, 12);
assert.deepEqual(dec, { start: '2027-12-01', end: '2028-01-01' });

assert.equal(api.bcShiftMonth('2027-01-31', 1), '2027-02-01', 'Jan 31 must not skip February');
assert.equal(api.bcShiftMonth('2027-12-01', 1), '2028-01-01');
assert.equal(api.bcShiftMonth('2028-01-01', -1), '2027-12-01');

require('./verify-staff-schedule-month-year-behavior');

console.log('PASS schedule month/year navigation');
