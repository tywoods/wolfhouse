'use strict';

/**
 * verify:finanzas-revenue-by-product-001
 * FINANZAS-REVENUE-BY-PRODUCT-001 — Wolfhouse lodging Revenue by product.
 * Stay totals tagged with package_code/name → real package rows (no surf "—" slots).
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const {
  buildLodgingRevenueByProductRows,
  computeSunsetFinanceSummary,
  lodgingPackageLabel,
} = require(path.join(ROOT, 'scripts/lib/sunset-finance-summary.js'));
const dataSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-finance-data.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'), 'utf8');
const i18nEs = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra != null ? ` (${extra})` : ''}`); }
}
function eq(label, a, b) {
  ok(label, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
}

const RANGE = { start: '2026-08-15', end: '2026-08-15' };

console.log('\n[1] SQL + wire — lodging BSR carries package identity');
ok('LODGING_BSR_SQL joins packages for name',
  /LODGING_BSR_SQL[\s\S]{0,800}LEFT JOIN packages p/.test(dataSrc)
  && /package_code/.test(dataSrc)
  && /package_name/.test(dataSrc));
ok('LODGING_BSR_SQL no longer hardcodes empty metadata',
  !/LODGING_BSR_SQL[\s\S]{0,400}'\{\}'::jsonb AS metadata/.test(dataSrc));
ok('finance summary uses lodging_packages for wolfhouse',
  /productMode:\s*lodging\s*\?\s*'lodging_packages'/.test(apiSrc)
  || /productMode: lodging \? 'lodging_packages'/.test(apiSrc));

console.log('\n[2] Package labels');
eq('Malibu from code', lodgingPackageLabel({ package_code: 'malibu' }), 'Malibu');
eq('DB name wins', lodgingPackageLabel({ package_code: 'malibu', package_name: 'Malibu Surf Week' }), 'Malibu Surf Week');
eq('no package → Accommodation', lodgingPackageLabel({}), 'Accommodation');

console.log('\n[3] Day slice — real package rows, no Lessons / — placeholders');
const dayRows = buildLodgingRevenueByProductRows([
  { service_date: '2026-08-15', due: 34900, metadata: { package_code: 'malibu', package_name: 'Malibu' } },
  { service_date: '2026-08-15', due: 39900, metadata: { package_code: 'uluwatu', package_name: 'Uluwatu' } },
  { service_date: '2026-08-15', due: 19900, metadata: { package_code: 'malibu', package_name: 'Malibu' } },
  { service_date: '2026-08-15', due: 12000, metadata: {} },
  { service_date: '2026-08-16', due: 99999, metadata: { package_code: 'waimea', package_name: 'Waimea' } }, // out of day
], RANGE);

eq('3 product rows (malibu, uluwatu, accommodation)', dayRows.length, 3);
eq('top is Malibu (349+199)', dayRows[0].cents, 54800);
ok('top label Malibu', /malibu/i.test(dayRows[0].label));
eq('second Uluwatu', dayRows[1].cents, 39900);
ok('second label Uluwatu', /uluwatu/i.test(dayRows[1].label));
eq('no-package Accommodation slot', dayRows[2].slot, 'accommodation');
eq('no-package cents', dayRows[2].cents, 12000);
ok('no Lessons / course_included / em-dash slots',
  !dayRows.some((r) => r.slot === 'lessons' || r.slot === 'course_included' || r.label === '—' || r.label === '\u2014'));
const daySum = dayRows.reduce((a, r) => a + r.cents, 0);
eq('day rows sum to in-range dues', daySum, 54800 + 39900 + 12000);

console.log('\n[4] Empty period → no placeholder rows');
eq('empty → []', buildLodgingRevenueByProductRows([], RANGE).length, 0);

console.log('\n[5] Summary productMode lodging_packages');
const summary = computeSunsetFinanceSummary({
  now: new Date('2026-08-15T12:00:00Z'),
  timeZone: 'Europe/Madrid',
  view: { granularity: 'day', anchor: '2026-08-15' },
  productMode: 'lodging_packages',
  bsr: [
    {
      booking_id: 'B1', service_date: '2026-08-15', service_type: 'accommodation',
      amount_due_cents: 34900, quantity: 1,
      metadata: { package_code: 'malibu', package_name: 'Malibu' },
    },
    {
      booking_id: 'B2', service_date: '2026-08-15', service_type: 'accommodation',
      amount_due_cents: 59900, quantity: 1,
      metadata: { package_code: 'waimea', package_name: 'Waimea' },
    },
  ],
  payments: [],
  bookings: [
    { booking_id: 'B1', total_amount_cents: 34900 },
    { booking_id: 'B2', total_amount_cents: 59900 },
  ],
  surf_packs: [],
  rental_stock: [],
});
const products = summary.redesign.revenue_by_product || [];
eq('summary has 2 package rows', products.length, 2);
ok('Waimea ranks first by €', /waimea/i.test(products[0].label) && products[0].cents === 59900);
ok('Malibu second', /malibu/i.test(products[1].label) && products[1].cents === 34900);
ok('no surf placeholder rows in summary',
  !products.some((r) => r.slot === 'lessons' || r.label === '—' || r.label === '\u2014'));
ok('lodging capacity_by_product empty (later epic)',
  Array.isArray(summary.redesign.capacity.by_product)
  && summary.redesign.capacity.by_product.length === 0);

console.log('\n[6] Default surf mode unchanged (still 5-row F2)');
const surf = computeSunsetFinanceSummary({
  now: new Date('2026-08-15T12:00:00Z'),
  timeZone: 'Europe/Madrid',
  view: { granularity: 'day', anchor: '2026-08-15' },
  bsr: [{
    booking_id: 'S1', service_date: '2026-08-15', service_type: 'surf_lesson',
    amount_due_cents: 5000, quantity: 1, metadata: { component: 'course' },
  }],
  payments: [],
  bookings: [{ booking_id: 'S1', total_amount_cents: 5000 }],
});
eq('surf still 5 rows', (surf.redesign.revenue_by_product || []).length, 5);
eq('surf lessons cents', surf.redesign.revenue_by_product[0].cents, 5000);

console.log('\n[7] UI + ES labels');
ok('UI localizes Accommodation slot',
  /slot === 'accommodation'/.test(uiSrc)
  && /admin\.finance\.product\.accommodation/.test(uiSrc));
ok('UI localizes Other slot', /admin\.finance\.product\.other/.test(uiSrc));
ok('ES has Alojamiento', /admin\.finance\.product\.accommodation['"]:\s*['"]Alojamiento['"]/.test(i18nEs));
ok('ES has Ingresos por producto', /Ingresos por producto/.test(i18nEs));

console.log(`\n── verify:finanzas-revenue-by-product-001: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
