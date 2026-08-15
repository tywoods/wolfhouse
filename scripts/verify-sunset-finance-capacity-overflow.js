'use strict';

/**
 * Finance Capacity used — over 100% stays honest and readable.
 * Visual fill clamps at 100% with is-over styling (not a fake/clipped 100% bar).
 * Staff API numbers remain source of truth; UI does not invent availability.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const redesignSrc = fs.readFileSync(
  path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'),
  'utf8'
);
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

assert.ok(apiSrc.includes('.pfb-bar-fill.is-over'), 'bar over-capacity fill CSS');
assert.ok(apiSrc.includes('.pfb-ring.is-over'), 'ring over-capacity CSS');
assert.ok(/minmax\(4\.75rem,\s*max-content\)/.test(apiSrc), 'amt column grows for wide ratios');
assert.ok(/minmax\(3\.25rem,\s*max-content\)/.test(apiSrc), 'pct column grows for 132%');
assert.ok(!/inbox-thread\.js/.test(redesignSrc), 'capacity fix stays off inbox-thread');

const box = {
  window: {},
  portalLang: 'en',
  portalT: (k, fb) => fb || k,
};
vm.createContext(box);
vm.runInContext(redesignSrc + '\nthis.renderFinanceRedesignHtml = renderFinanceRedesignHtml;', box);

const html = box.renderFinanceRedesignHtml({
  redesign: {
    view: { granularity: 'month', range: { start: '2026-08-01', end: '2026-08-31' } },
    net: { net_collected_cents: 0, gross_collected_cents: 0 },
    pipeline: { booked_cents: 0, bookings_count: 0 },
    outstanding: { outstanding_cents: 0, bookings_count: 0, due_soon_cents: 0, overdue_cents: 0 },
    revenue_by_product: [],
    capacity: {
      seats_pct: 132,
      seats_filled: 132,
      seats_capacity: 100,
      by_product: [
        { slot: 'lessons', label: 'Lessons', pct: 132, detail: '132/100' },
        { slot: 'boards', label: 'Boards', pct: 80, detail: '16/20' },
        { slot: 'other', label: 'Staff accommodation', used: 2, pct: null, detail: '2' },
      ],
    },
    daily_gross_trend: [],
    monthly_gross_trend: [],
    limitations: {},
  },
});

assert.ok(html.includes('132/100'), 'truthful over-capacity count');
assert.ok(html.includes('132%'), 'truthful over-capacity percent');
assert.ok(!/132\/100[\s\S]{0,120}100%/.test(html), 'no clamped 100% label beside 132/100');
assert.ok(/data-capacity-over="1"/.test(html), 'over marker on capacity UI');
assert.ok(/pfb-bar-fill[^>]*is-over/.test(html), 'over fill class on bar');
assert.ok(/pfb-bar-fill[^>]*is-over[^>]*width:100%|width:100%[^<]*is-over|pfb-bar-fill is-green is-over" style="width:100%"/.test(html),
  'bar fill width clamped to 100%');
assert.ok(/--pfb-ring:100%/.test(html), 'ring arc clamped to 100%');
assert.ok(/pfb-ring is-over/.test(html), 'ring over class');
assert.ok(/style="width:80%"/.test(html), 'under-capacity row keeps honest fill');
assert.ok(!/out 2/.test(html), 'no out-N leftover for accommodation without stock');
assert.ok(html.includes('Accommodation') || html.includes('Alojamiento'));

const under = box.renderFinanceRedesignHtml({
  redesign: {
    view: { granularity: 'month', range: { start: '2026-08-01', end: '2026-08-31' } },
    net: { net_collected_cents: 0, gross_collected_cents: 0 },
    pipeline: { booked_cents: 0, bookings_count: 0 },
    outstanding: { outstanding_cents: 0, bookings_count: 0, due_soon_cents: 0, overdue_cents: 0 },
    revenue_by_product: [],
    capacity: {
      seats_pct: 71,
      seats_filled: 34,
      seats_capacity: 48,
      by_product: [{ slot: 'lessons', label: 'Lessons', pct: 71, detail: '34/48' }],
    },
    daily_gross_trend: [],
    monthly_gross_trend: [],
    limitations: {},
  },
});
assert.ok(!/data-capacity-over/.test(under), 'no over marker under capacity');
assert.ok(!/pfb-ring is-over/.test(under), 'ring not over under capacity');
assert.ok(under.includes('71%') && under.includes('34/48'));

console.log('PASS finance capacity overflow display (132/100 honest, fill clamped, is-over)');
