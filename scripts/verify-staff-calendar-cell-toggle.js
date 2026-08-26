'use strict';

/**
 * Empty-cell click must toggle off on the second click (staff-staging sticky squares).
 * Runs bcHandleCellClick in a stubbed vm so we do not need a browser.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

assert.match(api, /function bcCellInCurrentSelection/);
assert.match(api, /painted \|\| bcCellInCurrentSelection\(td\)/);
assert.doesNotMatch(
  api,
  /Same bed clicked again — extend\/adjust the date range/,
  'old no-op extend path on a selected date must be gone',
);

const start = api.indexOf('function bcSelRange(){');
const end = api.indexOf('/* ── Add-ons payload builder', start);
assert.ok(start > 0 && end > start, 'extract cell-toggle helpers');
const slice = api.slice(start, end);

function makeTd(date, room, bed, painted) {
  const classes = new Set(painted ? ['bc-sel'] : []);
  return {
    dataset: { date, room, bed },
    classList: {
      contains(name) { return classes.has(name); },
      add(name) { classes.add(name); },
      remove() {
        for (let i = 0; i < arguments.length; i++) classes.delete(arguments[i]);
      },
    },
  };
}

function harness() {
  const state = {
    bcSel: null,
    bcSelectedBeds: [],
    cleared: 0,
    highlighted: 0,
  };
  const ctx = {
    bcSel: null,
    bcSelectedBeds: [],
    el() { return { style: { display: 'none' } }; },
    bcClearSelection() {
      ctx.bcSel = null;
      ctx.bcSelectedBeds = [];
      state.cleared += 1;
    },
    bcApplySelectionHighlight() {
      state.highlighted += 1;
    },
    bcAddDaysISO(iso, delta) {
      const d = new Date(iso + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + delta);
      return d.toISOString().slice(0, 10);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(slice, ctx);
  return { ctx, state };
}

function click(h, td) {
  h.ctx.bcHandleCellClick(td);
  h.state.bcSel = h.ctx.bcSel && {
    anchor_date: h.ctx.bcSel.anchor_date,
    cursor_date: h.ctx.bcSel.cursor_date,
  };
  h.state.bcSelectedBeds = (h.ctx.bcSelectedBeds || []).map((b) => ({
    room_code: b.room_code,
    bed_code: b.bed_code,
  }));
}

{
  const h = harness();
  const td = makeTd('2026-08-26', 'R1', 'B1', false);
  click(h, td);
  assert.deepEqual(h.state.bcSel, { anchor_date: '2026-08-26', cursor_date: '2026-08-26' });
  assert.equal(h.state.bcSelectedBeds.length, 1);
  /* Second click, even without .bc-sel (the sticky case). */
  const again = makeTd('2026-08-26', 'R1', 'B1', false);
  click(h, again);
  assert.equal(h.ctx.bcSel, null);
  assert.equal(h.state.bcSelectedBeds.length, 0);
  assert.ok(h.state.cleared >= 1, 'second click clears the one-cell paint');
}

{
  const h = harness();
  click(h, makeTd('2026-08-26', 'R1', 'B1', false));
  click(h, makeTd('2026-08-28', 'R1', 'B1', false));
  assert.deepEqual(h.state.bcSel, { anchor_date: '2026-08-26', cursor_date: '2026-08-28' });
  click(h, makeTd('2026-08-28', 'R1', 'B1', true));
  assert.deepEqual(h.state.bcSel, { anchor_date: '2026-08-26', cursor_date: '2026-08-27' });
  click(h, makeTd('2026-08-26', 'R1', 'B1', true));
  assert.deepEqual(h.state.bcSel, { anchor_date: '2026-08-27', cursor_date: '2026-08-27' });
  click(h, makeTd('2026-08-27', 'R1', 'B1', true));
  assert.equal(h.ctx.bcSel, null);
}

{
  const h = harness();
  click(h, makeTd('2026-08-26', 'R1', 'B1', false));
  click(h, makeTd('2026-08-26', 'R1', 'B2', false));
  assert.equal(h.state.bcSelectedBeds.length, 2);
  click(h, makeTd('2026-08-26', 'R1', 'B2', true));
  assert.equal(h.state.bcSelectedBeds.length, 1);
  assert.equal(h.state.bcSelectedBeds[0].room_code, 'R1');
  assert.equal(h.state.bcSelectedBeds[0].bed_code, 'B1');
  assert.ok(h.ctx.bcSel, 'other bed stays selected');
  click(h, makeTd('2026-08-26', 'R1', 'B1', true));
  assert.equal(h.ctx.bcSel, null);
}

console.log('PASS staff-calendar-cell-toggle: second click deselects');
