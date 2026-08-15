'use strict';

/**
 * Finanzas Custom range — localized display + calendar chrome (leftover P2).
 * Display-only: no period math. Stay off staff-query-api, inbox-thread, bookings UI.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const redesignPath = path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js');
const adminPath = path.join(ROOT, 'scripts/browser/sunset-admin-ui.js');
const redesignSrc = fs.readFileSync(redesignPath, 'utf8');
const adminSrc = fs.readFileSync(adminPath, 'utf8');

assert.ok(!redesignSrc.includes("if (g === 'custom') return start + ' – ' + end"),
  'redesign title must not concatenate raw ISO for custom');
assert.ok(redesignSrc.includes('function financeRedesignFormatIsoRange'),
  'redesign exposes range formatter');
assert.ok(redesignSrc.includes('financeRedesignFormatIsoRange(start, end)'),
  'custom title/display use localized range');
assert.ok(redesignSrc.includes("schedule.create.dateRange.prevMonth"),
  'calendar prev month aria uses i18n key');
assert.ok(redesignSrc.includes("schedule.create.dateRange.nextMonth"),
  'calendar next month aria uses i18n key');

assert.ok(!adminSrc.includes("var dayLabels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']"),
  'admin calendar must not hardcode English DOW chrome');
assert.ok(adminSrc.includes("'calendar.day.sun'"),
  'admin calendar uses calendar.day.* keys');
assert.ok(adminSrc.includes('financeRedesignFormatIsoRange'),
  'live Custom display prefers redesign formatter');

assert.ok(!redesignSrc.includes('inbox-thread.js'));
assert.ok(!adminSrc.includes('staff-email-settings-routes'));

const {
  financeRedesignTitle,
  financeRedesignCustomDisplay,
  financeRedesignFormatIsoRange,
  renderFinanceRedesignHtml,
} = require(redesignPath);

const customView = {
  granularity: 'custom',
  range: { start: '2026-08-01', end: '2026-08-15' },
};

global.portalLang = 'en';
global.portalT = (k) => k;
const enRange = financeRedesignFormatIsoRange('2026-08-01', '2026-08-15');
const enTitle = financeRedesignTitle(customView);
const enDisplay = financeRedesignCustomDisplay(customView);
assert.ok(!/\d{4}-\d{2}-\d{2}/.test(enRange), 'EN range has no raw ISO: ' + enRange);
assert.ok(!/\d{4}-\d{2}-\d{2}/.test(enTitle), 'EN title has no raw ISO: ' + enTitle);
assert.ok(!/\d{4}-\d{2}-\d{2}/.test(enDisplay), 'EN display has no raw ISO: ' + enDisplay);
assert.ok(/Aug|1 Aug|Aug 1/i.test(enRange), 'EN range looks localized: ' + enRange);
assert.strictEqual(enTitle, enDisplay);

global.portalLang = 'es';
const esRange = financeRedesignFormatIsoRange('2026-08-01', '2026-08-15');
const esTitle = financeRedesignTitle(customView);
const esDisplay = financeRedesignCustomDisplay(customView);
assert.ok(!/\d{4}-\d{2}-\d{2}/.test(esRange), 'ES range has no raw ISO: ' + esRange);
assert.ok(!/\d{4}-\d{2}-\d{2}/.test(esTitle), 'ES title has no raw ISO: ' + esTitle);
assert.ok(/ago/i.test(esRange), 'ES range uses Spanish month chrome: ' + esRange);
assert.strictEqual(esTitle, esDisplay);
assert.notStrictEqual(esRange, enRange, 'ES and EN Custom ranges differ');

const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
global.portalT = (key) => STAFF_PORTAL_STRINGS.es[key] || key;
global.portalLang = 'es';
const htmlEs = renderFinanceRedesignHtml({
  redesign: {
    view: customView,
    net: { net_collected_cents: 0, gross_collected_cents: 0, refunds_cents: 0 },
    pipeline: { booked_cents: 0, bookings_count: 0 },
    outstanding: { outstanding_cents: 0, bookings_count: 0, due_soon_cents: 0, overdue_cents: 0 },
    capacity: { seats_pct: null },
    revenue_by_product: [],
    daily_gross_trend: [],
    monthly_gross_trend: [],
  },
});
assert.ok(htmlEs.includes('Mes anterior'), 'ES prev-month aria');
assert.ok(htmlEs.includes('Mes siguiente'), 'ES next-month aria');
assert.ok(htmlEs.includes('Anterior') && htmlEs.includes('Siguiente'), 'ES period nav aria');
const displayMatch = htmlEs.match(/id="pfb-custom-display"[^>]*>([^<]*)</);
assert.ok(displayMatch, 'custom display span present');
assert.ok(!/\d{4}-\d{2}-\d{2}/.test(displayMatch[1]), 'visible Custom display has no raw ISO: ' + displayMatch[1]);
assert.ok(/ago/i.test(displayMatch[1]), 'visible Custom display ES month: ' + displayMatch[1]);
const labelMatch = htmlEs.match(/data-finance-range-label="1"[^>]*>([^<]*)</);
assert.ok(labelMatch, 'range label present');
assert.ok(!/\d{4}-\d{2}-\d{2}/.test(labelMatch[1]), 'range label has no raw ISO: ' + labelMatch[1]);
// Hidden date inputs keep ISO for picker math — that is intentional.

// Live sync path in admin-ui (financeCustomDisplayText) via vm slice
const aStart = adminSrc.indexOf('function financeCustomDisplayText');
const aEnd = adminSrc.indexOf('function financeDateAddDays');
assert.ok(aStart > 0 && aEnd > aStart, 'financeCustomDisplayText slice bounds');
const abox = {
  portalT: (k) => STAFF_PORTAL_STRINGS.es[k] || k,
  portalLang: 'es',
  financeDateIsValidIso(iso) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''));
  },
  financeCustomLocaleTag() { return 'es'; },
  financeRedesignFormatIsoRange,
};
vm.createContext(abox);
vm.runInContext(
  adminSrc.slice(aStart, aEnd) + '\nthis.financeCustomDisplayText = financeCustomDisplayText;',
  abox
);
const liveEs = abox.financeCustomDisplayText('2026-08-01', '2026-08-15');
assert.ok(!/\d{4}-\d{2}-\d{2}/.test(liveEs), 'live Custom display no raw ISO: ' + liveEs);
assert.ok(/ago/i.test(liveEs), 'live Custom display ES month: ' + liveEs);

// DOW chrome localization smoke
const calStart = adminSrc.indexOf('function financeRenderCustomCalendar');
assert.ok(calStart > 0);
assert.ok(adminSrc.slice(calStart, calStart + 2500).includes('calendar.day.sun'));
assert.ok(adminSrc.slice(calStart, calStart + 2500).includes('portalT(dayKeys'));

delete global.portalT;
delete global.portalLang;
console.log('PASS Finanzas Custom range locale (EN/ES display + calendar chrome)');
