'use strict';

/**
 * BUG-009 — Luna Staff alert counts, disabled toggles, capacity leftover.
 * Stay off inbox-thread.js, email-settings, language packs, production.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const redesign = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'), 'utf8');
const finance = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-finance-summary.js'), 'utf8');

assert.ok(api.includes('function staffNotificationAllRecipients'));
assert.ok(api.includes('rows = staffNotificationAllRecipients()'));
assert.ok(!/tbody\.innerHTML = '<tr><td colspan="5" style="opacity:\.7">No numbers yet\.<\/td><\/tr>'/.test(api));
assert.ok(api.includes('el(\'sns-new-enabled\').disabled = !serverOn'));
assert.ok(api.includes('el(\'sns-new-enabled\').checked = serverOn && !!nc.enabled'));
assert.ok(redesign.includes("var pctLabel = rawPct != null ? (String(Math.round(rawPct)) + '%') : ''"));
assert.ok(redesign.includes('pfb-bar-row--util'));
assert.ok(finance.includes('scaledPeriodStockCapacity'), 'period stock scaling helper');
assert.ok(finance.includes('accommodationGuestNightsInRange'), 'accommodation guest-night helper');
assert.ok(!finance.includes('detail: stockKnown ? `${used}/${stockSum}` : (used ? String(used) :'));
assert.ok(!api.includes('inbox-thread.js'));

const start = redesign.indexOf('function financeRedesignEsc');
assert.ok(start >= 0);
const box = {
  window: {},
  portalLang: 'en',
  portalT: (k, fb) => fb || k,
};
vm.createContext(box);
vm.runInContext(redesign + '\nthis.renderFinanceRedesignHtml = renderFinanceRedesignHtml;', box);
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
        { slot: 'lessons', label: 'Lessons', pct: 132, detail: '132/100', oversold: true },
      ],
    },
    daily_gross_trend: [],
    monthly_gross_trend: [],
    limitations: {},
  },
});
assert.ok(html.includes('132/100'), 'over-capacity count stays visible');
assert.ok(html.includes('132%'), 'percent matches 132/100');
assert.ok(!/132\/100[\s\S]{0,80}100%/.test(html), 'does not paint 100% next to 132/100');
assert.ok(/pfb-bar-row--util is-over|data-capacity-over="1"/.test(html), 'marks over-capacity row');
assert.ok(/pfb-bar-fill[^>]*is-over[^>]*style="width:100%"/.test(html)
  || /style="width:100%"[^>]*is-over/.test(html)
  || /pfb-bar-fill[^"]*is-over[^"]*"[^>]*width:100%/.test(html), 'fill clamps at 100% with over style');
assert.ok(/pfb-ring is-over|data-finance-cap-ring="1"[^>]*data-capacity-over="1"/.test(html), 'ring marks over-capacity');
assert.ok(/--pfb-ring:100%/.test(html), 'ring visual clamps at 100%');
assert.ok(!/Staff accommodation|Alojamiento/.test(html), 'accommodation without bed_capacity stays hidden');

assert.ok(api.includes('.pfb-bar-fill.is-over') && api.includes('.pfb-ring.is-over'), 'over-capacity CSS present');
assert.ok(/minmax\(4\.75rem,\s*max-content\)/.test(api), 'capacity amt column can grow for 132/100');

console.log('PASS BUG-009 alert recipients + disabled toggles + matching capacity %');
