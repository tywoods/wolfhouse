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
assert.ok(finance.includes("detail: stockKnown ? `${used}/${stockSum}` : (used ? String(used) : '—')"));
assert.ok(!finance.includes('out ${used}'));
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
        { slot: 'lessons', label: 'Lessons', pct: 132, detail: '132/100' },
        { slot: 'other', label: 'Staff accommodation', used: 2, pct: null, detail: '2' },
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
assert.ok(html.includes('Alojamiento') || html.includes('Accommodation'));
assert.ok(!/out 2/.test(html), 'no English out-N leftover');

console.log('PASS BUG-009 alert recipients + disabled toggles + matching capacity %');
