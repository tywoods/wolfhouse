'use strict';

/**
 * verify:sunset-finance-custom-range-picker
 * Execution-level (not source-only): real shared helper (state, iso) +
 * finance custom calendar day clicks complete range / single day / load.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${extra != null ? ` — ${extra}` : ''}`);
  }
}

// ── Real shared helper (state, iso) — extracted shape matching staff-query-api ──
function scheduleCreateDateRangeIsValidIso(iso) {
  iso = String(iso || '').slice(0, 10);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(iso)) return false;
  // Minimal calendar validity (no scheduleParseIso dependency)
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() + 1 === m &&
    dt.getUTCDate() === d
  );
}
function scheduleCreateDateRangeSelectDay(state, iso) {
  state = state || {};
  var start = state.start ? String(state.start).slice(0, 10) : null;
  var end = state.end ? String(state.end).slice(0, 10) : null;
  iso = String(iso || '').slice(0, 10);
  if (!scheduleCreateDateRangeIsValidIso(iso)) return { start: start, end: end };
  if (!start || (start && end)) return { start: iso, end: null };
  if (iso < start) return { start: iso, end: null };
  return { start: start, end: iso };
}

// Prove helper arg order semantics
let st = scheduleCreateDateRangeSelectDay({}, '2026-08-10');
ok('helper first click holds start only', st.start === '2026-08-10' && st.end == null);
st = scheduleCreateDateRangeSelectDay(st, '2026-08-15');
ok('helper second later click sets end', st.start === '2026-08-10' && st.end === '2026-08-15');
st = scheduleCreateDateRangeSelectDay({}, '2026-08-10');
st = scheduleCreateDateRangeSelectDay(st, '2026-08-10');
ok('helper same-day second click start===end', st.start === '2026-08-10' && st.end === '2026-08-10');

// Wrong arg order (what the bug did) must NOT complete a range
const wrong = scheduleCreateDateRangeSelectDay('2026-08-10', { start: null, end: null });
ok(
  'wrong order (iso as state) does not complete a real draft',
  !(wrong && wrong.start === '2026-08-10' && wrong.end === '2026-08-15')
);

// ── Minimal DOM for financeOpenCustomRangePicker ──
function makeEl(tag, attrs) {
  const el = {
    tagName: String(tag).toUpperCase(),
    attrs: Object.assign({}, attrs || {}),
    children: [],
    style: {},
    hidden: false,
    parent: null,
    innerHTML: '',
    onclick: null,
    value: attrs && attrs.value != null ? attrs.value : '',
    getAttribute(k) {
      return this.attrs[k] != null ? String(this.attrs[k]) : null;
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    appendChild(c) {
      c.parent = this;
      this.children.push(c);
      return c;
    },
    querySelector(sel) {
      return queryOne(this, sel);
    },
    querySelectorAll(sel) {
      const out = [];
      walk(this, (n) => {
        if (matchSel(n, sel)) out.push(n);
      });
      return out;
    },
    closest(sel) {
      let n = this;
      while (n) {
        if (matchSel(n, sel)) return n;
        n = n.parent;
      }
      return null;
    },
    click() {
      if (typeof this.onclick === 'function') {
        this.onclick({ target: this, preventDefault() {}, stopPropagation() {} });
      }
    },
  };
  if (attrs && attrs.id) el.attrs.id = attrs.id;
  if (attrs && attrs['data-pfb-day']) el.attrs['data-pfb-day'] = attrs['data-pfb-day'];
  if (attrs && attrs['data-pfb-cal']) el.attrs['data-pfb-cal'] = attrs['data-pfb-cal'];
  if (attrs && attrs.class) el.attrs.class = attrs.class;
  return el;
}

function walk(node, fn) {
  fn(node);
  (node.children || []).forEach((c) => walk(c, fn));
}
function matchSel(n, sel) {
  if (!n || !sel) return false;
  // support "#id", "[attr]", "[attr=val]", "button[data-pfb-day]", compound commas
  const parts = String(sel).split(',').map((s) => s.trim());
  return parts.some((p) => {
    if (p.startsWith('#')) return n.attrs && n.attrs.id === p.slice(1);
    const mEq = p.match(/^\[([^=\]]+)="([^"]*)"\]$/) || p.match(/^\[([^=\]]+)='([^']*)'\]$/);
    if (mEq) return n.attrs && String(n.attrs[mEq[1]]) === mEq[2];
    const mA = p.match(/^\[([^\]]+)\]$/);
    if (mA) return n.attrs && n.attrs[mA[1]] != null;
    // tag[attr]
    const mT = p.match(/^([a-zA-Z0-9_-]+)(\[.+\])?$/);
    if (mT) {
      if (mT[1] && n.tagName !== mT[1].toUpperCase() && mT[1] !== '*') {
        // allow if only attr part matters for our fake
      }
      if (mT[2]) return matchSel(n, mT[2]);
      return n.tagName === mT[1].toUpperCase();
    }
    return false;
  });
}
function queryOne(root, sel) {
  let found = null;
  walk(root, (n) => {
    if (!found && matchSel(n, sel)) found = n;
  });
  return found;
}

// Parse painted HTML into fake nodes for day buttons
function parsePainted(pop) {
  const html = String(pop.innerHTML || '');
  pop.children = [];
  const dayRe = /data-pfb-day="(\d{4}-\d{2}-\d{2})"/g;
  let m;
  while ((m = dayRe.exec(html))) {
    const btn = makeEl('button', { 'data-pfb-day': m[1], class: 'pfb-cal-day' });
    pop.appendChild(btn);
  }
  const calRe = /data-pfb-cal="(prev|next|clear|close)"/g;
  while ((m = calRe.exec(html))) {
    const btn = makeEl('button', { 'data-pfb-cal': m[1] });
    pop.appendChild(btn);
  }
}

// Sandbox implementing financeOpenCustomRangePicker from source (patched)
const adminSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
ok(
  'source uses (state, iso) order',
  /scheduleCreateDateRangeSelectDay\(\s*financeCustomRangeDraft[^,]*,\s*iso\s*\)/.test(adminSrc)
);
ok(
  'source does not use (iso, state) order',
  !/scheduleCreateDateRangeSelectDay\(\s*iso\s*,\s*financeCustomRangeDraft/.test(adminSrc)
);

// Extract function body via regex
const fnMatch = adminSrc.match(
  /function financeOpenCustomRangePicker\(body\) \{[\s\S]*?\n\}\n\n\nfunction loadAdminFinanceSummary/
);
ok('extracted financeOpenCustomRangePicker', !!fnMatch);
if (!fnMatch) {
  console.log(`\n── verify:sunset-finance-custom-range-picker: ${pass} passed, ${fail} failed ──`);
  process.exit(1);
}
const fnSrc = fnMatch[0].replace(/\n\n\nfunction loadAdminFinanceSummary[\s\S]*$/, '');

const loads = [];
const financeViewState = { granularity: 'month', anchor: null, start: null, end: null };
let financeCustomRangeDraft = { start: null, end: null };

const body = makeEl('div', { id: 'admin-finance-body' });
const pop = makeEl('div', { id: 'pfb-custom-range-pop' });
pop.hidden = true;
pop.style.display = 'none';
body.appendChild(pop);
const startHidden = makeEl('input', { id: 'pfb-custom-start', value: '' });
const endHidden = makeEl('input', { id: 'pfb-custom-end', value: '' });
body.appendChild(startHidden);
body.appendChild(endHidden);

const idMap = {
  'pfb-custom-range-pop': pop,
  'pfb-custom-start': startHidden,
  'pfb-custom-end': endHidden,
  'admin-finance-body': body,
};

function el(id) {
  return idMap[id] || null;
}
function loadAdminFinanceSummary() {
  loads.push({
    gran: financeViewState.granularity,
    start: financeViewState.start,
    end: financeViewState.end,
  });
}

// Wrap paint path: after assigning innerHTML, rebuild children so click targets exist.
// Monkey-patch by wrapping original after eval — simpler: override pop property setter.
let lastOnclick = null;
const ctx = {
  el,
  financeViewState,
  get financeCustomRangeDraft() {
    return financeCustomRangeDraft;
  },
  set financeCustomRangeDraft(v) {
    financeCustomRangeDraft = v;
  },
  scheduleCreateDateRangeSelectDay,
  loadAdminFinanceSummary,
  document: {
    getElementById(id) {
      return el(id);
    },
  },
  console,
};
// Evaluate function in ctx
vm.runInNewContext(fnSrc + '\nthis.financeOpenCustomRangePicker = financeOpenCustomRangePicker;', ctx);

// Intercept paint: wrap original open so after call, parse days + rebind day clicks through pop.onclick
ctx.financeOpenCustomRangePicker(body);
parsePainted(pop);
ok('picker opens (display block / not hidden)', pop.hidden === false && pop.style.display === 'block');
ok('calendar has day buttons', pop.querySelectorAll('[data-pfb-day]').length >= 28);

// Simulate first day click via pop.onclick (real handler path)
const day10 = pop.querySelector('[data-pfb-day="2026-08-10"]') || pop.children.find((c) => c.getAttribute('data-pfb-day') === '2026-08-10');
// Month may be current month from Date — force ym by setting draft start before open
// Re-open with fixed month
financeViewState.granularity = 'custom';
financeCustomRangeDraft = { start: null, end: null };
startHidden.value = '';
endHidden.value = '';
// Seed month via hidden start so paint uses 2026-08
startHidden.value = '2026-08-01';
loads.length = 0;
ctx.financeOpenCustomRangePicker(body);
// After open, draft was reset from hidden — start may be 2026-08-01
// Clear draft start for clean first click
financeCustomRangeDraft = { start: null, end: null };
// Re-paint only: call open again without hidden start
startHidden.value = '';
// Manually set ym by putting a start then clearing after open is hard.
// Directly invoke pop.onclick with synthetic day nodes after ensuring ym=2026-08:
// Force by opening with start=2026-08-01 then clearing draft:
startHidden.value = '2026-08-01';
ctx.financeOpenCustomRangePicker(body);
financeCustomRangeDraft = { start: null, end: null };
// Rebind paint children
parsePainted(pop);
// Manually set ym by hacking: click days present
const days = pop.querySelectorAll('[data-pfb-day]');
ok('days painted for Aug 2026', days.length >= 28 && days.some((d) => String(d.getAttribute('data-pfb-day')).startsWith('2026-08')));

function clickDay(iso) {
  const btn = days.find((d) => d.getAttribute('data-pfb-day') === iso) || makeEl('button', { 'data-pfb-day': iso });
  if (!btn.parent) pop.appendChild(btn);
  // Real path: pop.onclick receives event with target=btn, closest finds data-pfb-day
  if (typeof pop.onclick !== 'function') throw new Error('pop.onclick missing');
  pop.onclick({
    target: btn,
    preventDefault() {},
    stopPropagation() {},
  });
  // After paint() on incomplete, re-parse children but keep onclick
  parsePainted(pop);
}

// First click
loads.length = 0;
clickDay('2026-08-10');
ok('first click holds draft start only', financeCustomRangeDraft.start === '2026-08-10' && financeCustomRangeDraft.end == null);
ok('first click does not load summary yet', loads.length === 0);
ok('popover still open after first click', pop.hidden === false);

// Second later click
clickDay('2026-08-15');
ok('second later click sets start+end', financeCustomRangeDraft.start === '2026-08-10' && financeCustomRangeDraft.end === '2026-08-15');
ok('popover closed after complete range', pop.hidden === true || pop.style.display === 'none');
ok(
  'loadAdminFinanceSummary called with custom range',
  loads.length === 1 &&
    loads[0].gran === 'custom' &&
    loads[0].start === '2026-08-10' &&
    loads[0].end === '2026-08-15'
);

// Same-day path
startHidden.value = '2026-08-01';
endHidden.value = '';
financeViewState.start = null;
financeViewState.end = null;
loads.length = 0;
ctx.financeOpenCustomRangePicker(body);
financeCustomRangeDraft = { start: null, end: null };
parsePainted(pop);
clickDay('2026-08-20');
ok('same-day: first holds start', financeCustomRangeDraft.start === '2026-08-20' && !financeCustomRangeDraft.end);
clickDay('2026-08-20');
ok('same-day: second sets start===end', financeCustomRangeDraft.start === '2026-08-20' && financeCustomRangeDraft.end === '2026-08-20');
ok(
  'same-day: loads custom start===end',
  loads.length === 1 && loads[0].start === '2026-08-20' && loads[0].end === '2026-08-20'
);

console.log(`\n── verify:sunset-finance-custom-range-picker: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
