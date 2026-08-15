'use strict';

/**
 * LANG-007 — Sunset Admin chrome follows the selected locale.
 * Copy-only: finance/pricing/luna-staff/email labels. No OAuth logic.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const ROOT = path.join(__dirname, '..');
const en = STAFF_PORTAL_STRINGS.en;
const es = STAFF_PORTAL_STRINGS.es;
const financeUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'), 'utf8');
const adminUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const threadSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
const emailUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');

const pairs = {
  'admin.finance.netCollected': ['Net collected', 'Cobrado neto'],
  'admin.finance.grossCollected': ['Gross collected', 'Cobrado bruto'],
  'admin.finance.refunds': ['Refunds', 'Reembolsos'],
  'admin.finance.outstanding': ['Outstanding', 'Pendiente'],
  'admin.finance.bookedPipeline': ['Booked (pipeline)', 'Reservado (cartera)'],
  'admin.finance.next30': ['Next 30 days', 'Próximos 30 días'],
  'admin.finance.deliveredUnpaid': ['Delivered, unpaid', 'Entregado, sin pagar'],
  'admin.finance.dueSoon': ['Due soon', 'Vence pronto'],
  'admin.finance.overdue': ['Overdue', 'Vencido'],
  'admin.finance.revenueByProduct': ['Revenue by product', 'Ingresos por producto'],
  'admin.finance.capacityUsed': ['Occupancy', 'Ocupación'],
  'admin.finance.gran.day': ['Day', 'Día'],
  'admin.finance.gran.month': ['Month', 'Mes'],
  'admin.finance.gran.year': ['Year', 'Año'],
  'admin.finance.gran.custom': ['Custom', 'Personalizado'],
  'admin.finance.trend.monthDays': ['Days', 'Días'],
  'admin.finance.trend.yearMonths': ['12 months', '12 meses'],
  'admin.finance.avg': ['avg', 'prom.'],
  'admin.email.endpointActive': ['Mailbox connection', 'Conexión del buzón'],
  'admin.tabs.lunaStaff': ['Luna Staff', 'Personal Luna'],
  'lunaStaff.numbers.title': ['Staff & Owner Numbers', 'Números de personal y propietario'],
  'lunaStaff.alerts.title': ['Guest Conversation Alerts', 'Alertas de conversación'],
  'lunaStaff.notes.title': ['General Notes for Luna', 'Notas generales para Luna'],
};

for (const [key, [enVal, esVal]] of Object.entries(pairs)) {
  assert.strictEqual(en[key], enVal, 'EN ' + key);
  assert.strictEqual(es[key], esVal, 'ES ' + key);
}

assert.notStrictEqual(es['admin.courseEquipment.editorTitle'], es['admin.courseEquipment.item'], 'no duplicate MATERIAL');
assert.ok(adminUi.includes('function adminRefreshOnLocaleChange'), 'admin locale refresh exists');
assert.ok(apiSrc.includes('adminRefreshOnLocaleChange()'), 'locale change calls admin refresh');
assert.ok(adminUi.includes('adminBookingsRefreshOnLocaleChange()'), 'locale change re-renders Reservas');
assert.ok(financeUi.includes("financeRedesignT('admin.finance.bookedPipeline'"), 'finance uses bookedPipeline key');
assert.ok(apiSrc.includes('data-i18n="lunaStaff.numbers.title"'), 'Luna Staff numbers title is i18n');
assert.ok(apiSrc.includes('data-i18n="lunaStaff.alerts.title"'), 'Luna Staff alerts title is i18n');
assert.ok(emailUi.includes("portalT('admin.email.endpointActive')"), 'email chrome still uses portalT');
assert.ok(!emailUi.includes('inbox-thread'), 'email UI does not touch thread');

const { execSync } = require('child_process');
const threadDiff = execSync('git diff --name-only github/master -- scripts/browser/inbox-thread.js', {
  cwd: ROOT,
  encoding: 'utf8',
});
assert.strictEqual(threadDiff.trim(), '', 'inbox-thread.js untouched vs github/master');

const { renderFinanceRedesignHtml } = require('./browser/sunset-admin-finance-redesign-ui.js');
function fakeSummary() {
  return {
    redesign: {
      view: { granularity: 'month', range: { start: '2026-08-01', end: '2026-08-31' } },
      net: { net_collected_cents: 10000, gross_collected_cents: 12000, refunds_cents: 2000 },
      pipeline: { booked_cents: 5000, bookings_count: 2, avg_booking_cents: 2500, next_30_days_cents: 1000, delivered_unpaid_cents: 400 },
      outstanding: { outstanding_cents: 800, bookings_count: 1, due_soon_cents: 300, overdue_cents: 500 },
      capacity: { seats_pct: 40, seats_filled: 4, seats_capacity: 10 },
      revenue_by_product: [{ key: 'lessons', slot: 'lessons', label: 'Lessons', cents: 4000, pct: 80 }],
      daily_gross_trend: [],
      monthly_gross_trend: [],
    },
  };
}

global.portalT = (key) => es[key] || key;
let htmlEs = renderFinanceRedesignHtml(fakeSummary());
assert.ok(htmlEs.includes('Cobrado neto'), 'ES finance hero net');
assert.ok(htmlEs.includes('Reservado (cartera)'), 'ES finance pipeline');
assert.ok(htmlEs.includes('Próximos 30 días'), 'ES next 30');
assert.ok(htmlEs.includes('Entregado, sin pagar'), 'ES delivered unpaid');
assert.ok(htmlEs.includes('Vence pronto'), 'ES due soon');
assert.ok(htmlEs.includes('Vencido'), 'ES overdue');
assert.ok(htmlEs.includes('Ingresos por producto'), 'ES revenue by product');
assert.ok(htmlEs.includes('Ocupación'), 'ES occupancy');
assert.ok(htmlEs.includes('Día') && htmlEs.includes('Mes') && htmlEs.includes('Año'), 'ES period tabs');
assert.ok(!htmlEs.includes('Booked (pipeline)'), 'ES does not keep EN pipeline');

global.portalT = (key) => en[key] || key;
let htmlEn = renderFinanceRedesignHtml(fakeSummary());
assert.ok(htmlEn.includes('Net collected'), 'EN finance hero net');
assert.ok(htmlEn.includes('Gross collected'), 'EN gross');
assert.ok(htmlEn.includes('Refunds'), 'EN refunds');
assert.ok(htmlEn.includes('Outstanding'), 'EN outstanding');
assert.ok(!htmlEn.includes('Cobrado neto'), 'EN does not keep ES net');
assert.ok(htmlEn.includes('Day') && htmlEn.includes('Month') && htmlEn.includes('Year'), 'EN period tabs');
assert.ok(htmlEn.includes('Days') && htmlEn.includes('12 months'), 'EN trend tabs');

delete global.portalT;
console.log('PASS LANG-007 Sunset Admin EN/ES chrome contract');
