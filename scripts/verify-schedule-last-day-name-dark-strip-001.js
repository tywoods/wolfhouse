'use strict';

/**
 * SCHEDULE-LAST-DAY-NAME-DARK-STRIP-001
 * Thin last-day names, dark bed-row band, group pebble without above-room banner,
 * >30-day headers, date/refresh separation, no Room/Bed corner label, Aug–Sep title.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
let passed = 0;
function ok(name, cond, detail) {
  assert.ok(cond, detail || name);
  passed += 1;
  console.log('  ✓ ' + name);
}

console.log('[1] Static chrome');
ok('job marker', /SCHEDULE-LAST-DAY-NAME-DARK-STRIP-001/.test(api));
ok('thin last-day class', /bc-block-thin/.test(api) && /spanDays === 1 \? ' bc-block-thin'/.test(api));
ok('thin label keeps a min width', /#tab-bed-calendar \.bc-block\.bc-block-thin \.bc-block-label\{[^}]*min-width:2\.6em/.test(api));
ok('dark wrap is flat charcoal, not cream gradient',
  /\[data-theme="dark"\] \.bc-grid-wrap-inner\{background:#2A2A2C/.test(api) &&
  !/\[data-theme="dark"\] \.bc-grid-wrap-inner\{background:linear-gradient\(180deg,var\(--cream\)/.test(api));
ok('booking-row cells match empty charcoal',
  /\[data-theme="dark"\] \.bc-day-cell:has\(\.bc-block\),\[data-theme="dark"\] tr\.bc-room-bed-row\{background:#2A2A2C\}/.test(api));
ok('empty-cell charcoal rule kept',
  /\[data-theme="dark"\] \.bc-day-cell:not\(:has\(\.bc-block\)\)\{background:#2A2A2C\}/.test(api));
ok('room-header strip unchanged',
  /\[data-theme="dark"\] \.bc-room-hdr\{background:var\(--room-bar,var\(--sand\)\)/.test(api));
ok('above-room group banner not inserted', !/html \+= bcRenderGroupParentRow\(/.test(api));
ok('group banner display none', /\.bc-group-parent-row\{display:none!important\}/.test(api));
ok('group pebble still composed into bars', /bcGroupChipHtml\(blk\)/.test(api));
ok('corner label removed', /<th class="bc-bed-head"><\/th>/.test(api));
ok('corner label string not painted', !/bc-bed-head">'\s*\+\s*escHtml\(t\('calendar\.grid\.roomBed'\)\)/.test(api));
ok('date and refresh stay in their own slots',
  /#tab-bed-calendar \.bc-range-wrap,\s*#tab-bed-calendar \.bc-legend-row\{flex:0 0 auto/.test(api) &&
  /#tab-bed-calendar #bc-load\{position:static/.test(api) &&
  /#tab-bed-calendar \.bc-chips\{flex:1 1 240px;min-width:0;overflow-x:auto/.test(api));
ok('title uses range start, not today-in-range',
  /viewed month is the range start/.test(api) &&
  !/todayIso >= start && todayIso <= end/.test(api));
ok('headers drop weekday over 30 days', /bcCalendarHeaderDayCount\(\) > 30\) return num/.test(api));

console.log('\n[2] Behavioral — headers, title, banner, thin name');
const headerStart = api.indexOf('function bcCalendarHeaderDayCount(){');
const headerEnd = api.indexOf('function bcFormatRoomMetaLabel(room)', headerStart);
assert.ok(headerStart > 0 && headerEnd > headerStart, 'extract header helpers');
const titleStart = api.indexOf('function bcUpdateCalendarTitle(){');
const titleEnd = api.indexOf('var bcLastBedCalendarData', titleStart);
assert.ok(titleStart > 0 && titleEnd > titleStart, 'extract title helper');
const groupStart = api.indexOf('function bcRenderGroupParentRow(){');
const groupEnd = api.indexOf('function bcSetGroupHover', groupStart);
assert.ok(groupStart > 0 && groupEnd > groupStart, 'extract banner helper');

const fields = { 'bc-start': '', 'bc-end': '' };
const titleEl = { attrs: {}, textContent: '', removeAttribute(n) { delete this.attrs[n]; } };
const ctx = {
  BC_YEAR_PREFIX_RE: /^\d{4}/,
  bcData: null,
  document: { documentElement: { lang: 'en' } },
  el(id) {
    if (id === 'bc-calendar-title') return titleEl;
    return { id: id, value: fields[id] || '' };
  },
  bcReadDateField(inp) { return inp && fields[inp.id] ? fields[inp.id] : ''; },
  t(key) {
    const map = { 'calendar.day.mon': 'Mon', 'calendar.day.tue': 'Tue', 'calendar.day.sun': 'Sun' };
    return map[key] || key;
  },
};
vm.createContext(ctx);
vm.runInContext(api.slice(headerStart, headerEnd) + '\n' + api.slice(titleStart, titleEnd) + '\n' + api.slice(groupStart, groupEnd), ctx);

fields['bc-start'] = '2026-09-28';
fields['bc-end'] = '2026-10-28';
ok('30-day range keeps weekday', ctx.bcFormatCalendarDayLabel({ date: '2026-09-28' }) === 'Mon 28');
fields['bc-start'] = '2026-08-01';
fields['bc-end'] = '2026-09-30';
ok('Aug–Sep range is day number only', ctx.bcFormatCalendarDayLabel({ date: '2026-08-01' }) === '01');
ok('no weekday on long range', !/Mon|Tue|Wed/.test(ctx.bcFormatCalendarDayLabel({ date: '2026-08-03' })));

ctx.bcUpdateCalendarTitle();
ok('Aug–Sep title is August \'26', titleEl.textContent === "August '26", 'got ' + titleEl.textContent);
ok('title has no range suffix', !/–| - /.test(titleEl.textContent));
ok('banner helper paints nothing', ctx.bcRenderGroupParentRow({ key: 'id:g1', guest_name: 'Tim', roomCount: 2 }, [{ date: '2026-08-01' }]) === '');

console.log('\nPASS ' + passed + ' checks — schedule last-day name / dark strip / chrome');
