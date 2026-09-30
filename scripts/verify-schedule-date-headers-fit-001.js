'use strict';

/**
 * SCHEDULE-DATE-HEADERS-FIT-001
 * Weekday + day number must be fully readable in the fixed Schedule column.
 * Do not widen the grid. Over-30-day headers stay day-number only.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
let passed = 0;
function ok(name, cond, detail) {
  assert.ok(cond, detail || name);
  passed += 1;
  console.log('  ✓ ' + name);
}

console.log('[1] Static chrome');
ok('job marker', /SCHEDULE-DATE-HEADERS-FIT-001/.test(api));
const cssStart = api.indexOf('/* SCHEDULE-DATE-HEADERS-FIT-001 — weekday + day fit the fixed column');
const cssEnd = api.indexOf('/* staff-portal-calendar:side-drawer', cssStart);
assert.ok(cssStart > 0 && cssEnd > cssStart, 'fit css block');
const css = api.slice(cssStart, cssEnd);
ok('scoped day-head rule', /#tab-bed-calendar \.bc-grid thead th\.bc-day-head\{/.test(css));
ok('9px type, not zoom-scaled 12px', /font-size:9px;/.test(css) && !/font-size:calc\(12px/.test(css));
ok('tracking tighter than the 0.03em header', /letter-spacing:0;/.test(css) && /letter-spacing:-0\.04em;/.test(css));
ok('no horizontal padding', /padding:2px 0;/.test(css));
ok('fit rule does not widen the column', !/min-width:/.test(css));
ok('stacked weekday and day', /bc-day-head-wd/.test(css) && /bc-day-head-num/.test(css) && /display:block;/.test(css));
ok('desktop grid still fixed and not scrolled',
  /#tab-bed-calendar \.bc-grid\{width:100%;min-width:0;table-layout:fixed\}/.test(api) &&
  /#tab-bed-calendar #bc-grid-wrap,#tab-bed-calendar \.bc-grid-wrap-inner\{overflow-x:hidden\}/.test(api));
ok('header uses the stack helper', /html \+= bcCalendarDayHeadHtml\(day\);/.test(api));
ok('long-range day-number contract kept', /bcCalendarHeaderDayCount\(\) > 30\) return num/.test(api));
ok('no new weight-800', !/SCHEDULE-DATE-HEADERS-FIT-001[\s\S]{0,800}font-weight:\s*800/.test(api));

console.log('\n[2] Behavioral — labels stay full weekday + day, long range stays numeric');
const headerStart = api.indexOf('function bcCalendarHeaderDayCount(){');
const headerEnd = api.indexOf('function bcFormatRoomMetaLabel(room)', headerStart);
assert.ok(headerStart > 0 && headerEnd > headerStart, 'extract header helpers');
const fields = { 'bc-start': '', 'bc-end': '' };
const ctx = {
  BC_YEAR_PREFIX_RE: /^\d{4}/,
  bcData: null,
  document: { documentElement: { lang: 'en' } },
  el(id) { return { id: id, value: fields[id] || '' }; },
  bcReadDateField(inp) { return inp && fields[inp.id] ? fields[inp.id] : ''; },
  t(key) {
    const map = {
      'calendar.day.sun': 'Sun',
      'calendar.day.mon': 'Mon',
      'calendar.day.tue': 'Tue',
      'calendar.day.wed': 'Wed',
      'calendar.day.thu': 'Thu',
      'calendar.day.fri': 'Fri',
      'calendar.day.sat': 'Sat',
    };
    return map[key] || key;
  },
  escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  },
};
vm.createContext(ctx);
vm.runInContext(api.slice(headerStart, headerEnd), ctx);

fields['bc-start'] = '2026-09-30';
fields['bc-end'] = '2026-10-30';
ok('30-day range keeps weekday + zero-padded day', ctx.bcFormatCalendarDayLabel({ date: '2026-09-30' }) === 'Wed 30');
ok('two-digit day 31', ctx.bcFormatCalendarDayLabel({ date: '2026-10-31' }) === 'Sat 31');
ok('single-digit day stays zero-padded', ctx.bcFormatCalendarDayLabel({ date: '2026-10-01' }) === 'Thu 01');
const head31 = ctx.bcCalendarDayHeadHtml({ date: '2026-10-31' });
ok('31 stacks weekday and number',
  head31.indexOf('bc-day-head-wd') > 0 &&
  head31.indexOf('>Sat<') > 0 &&
  head31.indexOf('bc-day-head-num') > 0 &&
  head31.indexOf('>31<') > 0 &&
  head31.indexOf('aria-label="Sat 31"') > 0);
const head01 = ctx.bcCalendarDayHeadHtml({ date: '2026-10-01' });
ok('01 stacks Thu and 01',
  head01.indexOf('>Thu<') > 0 && head01.indexOf('>01<') > 0 && head01.indexOf('aria-label="Thu 01"') > 0);
fields['bc-start'] = '2026-08-01';
fields['bc-end'] = '2026-09-30';
ok('Aug–Sep stays day number only', ctx.bcFormatCalendarDayLabel({ date: '2026-08-01' }) === '01');
const longHead = ctx.bcCalendarDayHeadHtml({ date: '2026-08-31' });
ok('long range has no weekday span', longHead.indexOf('bc-day-head-wd') < 0 && longHead.indexOf('>31<') > 0);

function chromeBin() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  const known = '/opt/data/home/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
  if (fs.existsSync(known)) return known;
  return '';
}

console.log('\n[3] Geometry — widest weekday fits the squeezed column');
const chrome = chromeBin();
if (!chrome) {
  console.log('  · geometry skipped (no chrome)');
} else {
  const outHtml = path.join(__dirname, '..', 'tmp', 'schedule-date-headers-fit-001.html');
  const outDom = path.join(__dirname, '..', 'tmp', 'schedule-date-headers-fit-001.dom.html');
  fs.mkdirSync(path.dirname(outHtml), { recursive: true });
  const fixture = `<!doctype html>
<html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@700&display=swap" rel="stylesheet">
<style>
  body{margin:0}
  #tab-bed-calendar{font-family:'Instrument Sans',system-ui,sans-serif}
  .bc-grid{border-collapse:separate;border-spacing:0;width:100%;table-layout:fixed}
  .bc-grid th{border-right:1px solid #ddd;padding:0;text-align:center}
  .bc-bed-head{width:130px}
  ${css}
</style></head><body>
<div id="tab-bed-calendar"><div id="out">pending</div></div>
<script>
async function go(){
  try { await document.fonts.ready; } catch (e) {}
  await new Promise(function(r){ setTimeout(r, 700); });
  const views = [
    { name: 'shot-1440', width: 1440 },
    { name: 'laptop-1280', width: 1280 },
    { name: 'pinned-rail-1280', width: 1280 - 419 },
    { name: 'desktop-1024', width: 1024 }
  ];
  const labels = ['Wed 31','Thu 01','Fri 02','Mon 09','Sat 10','Mié 31'];
  const rows = [];
  function textWidth(text, sample){
    const probe = document.createElement('span');
    const cs = getComputedStyle(sample);
    probe.textContent = text;
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;font:' + cs.font + ';letter-spacing:' + cs.letterSpacing + ';';
    document.body.appendChild(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    return w;
  }
  views.forEach(function(view){
    const wrap = document.createElement('div');
    wrap.id = 'bc-grid-wrap';
    wrap.style.cssText = 'width:' + view.width + 'px;padding:0 16px;box-sizing:border-box';
    const table = document.createElement('table');
    table.className = 'bc-grid';
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    const bed = document.createElement('th');
    bed.className = 'bc-bed-head';
    bed.textContent = 'R1-B1';
    tr.appendChild(bed);
    const heads = [];
    for (let i = 0; i < 30; i++) {
      const label = labels[i % labels.length];
      const parts = label.split(' ');
      const th = document.createElement('th');
      th.className = 'bc-day-head';
      th.innerHTML = '<span class="bc-day-head-wd">' + parts[0] + '</span><span class="bc-day-head-num">' + parts[1] + '</span>';
      tr.appendChild(th);
      heads.push(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
    wrap.appendChild(table);
    document.getElementById('tab-bed-calendar').appendChild(wrap);
    heads.forEach(function(th, i){
      const label = labels[i % labels.length];
      const bits = th.querySelectorAll('span');
      const col = th.clientWidth;
      let clip = false;
      const parts = [];
      bits.forEach(function(sp){
        const need = textWidth(sp.textContent, sp);
        if (need > col + 0.5) clip = true;
        parts.push(sp.textContent + ':' + Math.round(need * 10) / 10 + '/' + col);
      });
      rows.push({ view: view.name, label: label, col: col, clip: clip, detail: parts.join(' ') });
    });
    wrap.remove();
  });
  document.getElementById('out').textContent = JSON.stringify(rows);
}
go();
</script></body></html>`;
  fs.writeFileSync(outHtml, fixture);
  const run = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=5000', '--dump-dom', 'file://' + outHtml,
  ], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, 'chrome geometry ' + (run.stderr || run.error || run.status));
  fs.writeFileSync(outDom, run.stdout || '');
  const match = (run.stdout || '').match(/<div id="out">([\s\S]*?)<\/div>/);
  assert.ok(match && match[1] !== 'pending', 'geometry payload');
  const rows = JSON.parse(match[1]);
  const clipped = rows.filter((row) => row.clip);
  ok('no clipped weekday or day in shot, laptop, pinned-rail, or 1024', clipped.length === 0,
    clipped.slice(0, 4).map((row) => row.view + ' ' + row.label + ' ' + row.detail).join('; '));
  const shot = rows.find((row) => row.view === 'shot-1440' && row.label === 'Wed 31');
  const pinned = rows.find((row) => row.view === 'pinned-rail-1280' && row.label === 'Wed 31');
  function slack(row) {
    if (!row) return -1;
    const need = Number(String(row.detail).split(' ')[0].split(':')[1].split('/')[0]);
    return row.col - need;
  }
  ok('shot column still narrow (did not widen the grid)', shot && shot.col < 50 && shot.col > 30, JSON.stringify(shot));
  ok('pinned rail Wed has at least 2px spare', slack(pinned) >= 2, JSON.stringify(pinned));
  console.log('  · shot Wed 31 ' + (shot && shot.detail));
  console.log('  · pinned Wed 31 ' + (pinned && pinned.detail));
}

console.log('\nPASS ' + passed + ' checks — schedule date headers fit');
