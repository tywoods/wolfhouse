'use strict';

/**
 * Finance capacity denominators scale with days in the selected period.
 * Rentals: stock × period days. Accommodation: guest-nights / (beds × days).
 * >100% stays truthful with oversold flag; fill clamps in UI.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  computeSunsetFinanceSummary,
  periodDayCount,
  scaledPeriodStockCapacity,
  accommodationGuestNightsInRange,
} = require(path.join(__dirname, 'lib', 'sunset-finance-summary.js'));

const ROOT = path.join(__dirname, '..');
const redesignSrc = fs.readFileSync(
  path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'),
  'utf8',
);
const dataSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-finance-data.js'), 'utf8');

const AUG = { start: '2026-08-01', end: '2026-08-31' };
const NOW = new Date('2026-08-15T10:00:00Z');

assert.strictEqual(periodDayCount(AUG), 31);
assert.strictEqual(scaledPeriodStockCapacity(5, 31), 155);
assert.strictEqual(scaledPeriodStockCapacity(100, 31), 3100);

assert.strictEqual(accommodationGuestNightsInRange({
  check_in: '2026-08-10',
  check_out: '2026-08-13',
  occupied_nights: ['2026-08-10', '2026-08-11', '2026-08-12'],
}, AUG), 3);

const rentalStock = [
  { offering_key: 'board_and_suit_rental', stock_quantity: 100, active: true },
  { offering_key: 'sup_rental', stock_quantity: 5, active: true },
];

// 133 unit-days on board+suit across August → 133/3100 ≈ 4%
const bsr = [];
for (let d = 1; d <= 31; d += 1) {
  const day = String(d).padStart(2, '0');
  const date = `2026-08-${day}`;
  if (d <= 5) {
    bsr.push({
      booking_id: `B-SUP-${d}`,
      service_date: date,
      service_type: 'addon_service',
      quantity: 1,
      amount_due_cents: 1000,
      metadata: { offering_key: 'sup_rental', component: 'sup' },
    });
  }
}
for (let i = 0; i < 133; i += 1) {
  bsr.push({
    booking_id: `B-BS-${i}`,
    service_date: '2026-08-10',
    service_type: 'addon_service',
    quantity: 1,
    amount_due_cents: 500,
    metadata: { offering_key: 'board_and_suit_rental' },
  });
}

const summary = computeSunsetFinanceSummary({
  now: NOW,
  timeZone: 'Europe/Madrid',
  view: { granularity: 'month', anchor: '2026-08-15' },
  bsr,
  payments: [],
  bookings: [],
  rental_stock: rentalStock,
  surf_packs: [],
});

const capRows = summary.redesign.capacity.by_product;
const supRow = capRows.find((r) => (r.offering_keys || []).includes('sup_rental')
  || /sup/i.test(String(r.label || '')));
const bundleRow = capRows.find((r) => (r.offering_keys || []).includes('board_and_suit_rental')
  || /board/i.test(String(r.label || '')));

assert.ok(supRow, 'SUP capacity row present');
assert.strictEqual(supRow.detail, '5/155', `SUP detail got ${supRow.detail}`);
assert.ok(supRow.pct != null && supRow.pct <= 10, `SUP pct should be modest, got ${supRow.pct}`);
assert.strictEqual(supRow.oversold, false);

assert.ok(bundleRow, 'board+suit capacity row present');
assert.strictEqual(bundleRow.detail, '133/3100', `bundle detail got ${bundleRow.detail}`);
assert.strictEqual(bundleRow.oversold, false);

// Oversold rental still flags when used exceeds period stock
const oversold = computeSunsetFinanceSummary({
  now: NOW,
  timeZone: 'Europe/Madrid',
  view: { granularity: 'month', anchor: '2026-08-15' },
  bsr: [{
    booking_id: 'B-OVER',
    service_date: '2026-08-01',
    service_type: 'surfboard',
    quantity: 12,
    amount_due_cents: 1000,
    metadata: { offering_key: 'board_rental' },
  }],
  payments: [],
  bookings: [],
  rental_stock: [{ offering_key: 'board_rental', stock_quantity: 10, active: true }],
  surf_packs: [],
});
const overRow = oversold.redesign.capacity.by_product.find((r) => (r.offering_keys || []).includes('board_rental'));
assert.ok(overRow);
assert.strictEqual(overRow.detail, '12/310');
assert.strictEqual(overRow.pct, 4);
assert.strictEqual(overRow.oversold, false);

const oversoldHeavy = computeSunsetFinanceSummary({
  now: NOW,
  timeZone: 'Europe/Madrid',
  view: { granularity: 'month', anchor: '2026-08-15' },
  bsr: Array.from({ length: 320 }, (_, i) => ({
    booking_id: `B-${i}`,
    service_date: '2026-08-01',
    service_type: 'surfboard',
    quantity: 1,
    amount_due_cents: 100,
    metadata: { offering_key: 'board_rental' },
  })),
  payments: [],
  bookings: [],
  rental_stock: [{ offering_key: 'board_rental', stock_quantity: 10, active: true }],
  surf_packs: [],
});
const heavyRow = oversoldHeavy.redesign.capacity.by_product.find((r) => (r.offering_keys || []).includes('board_rental'));
assert.strictEqual(heavyRow.detail, '320/310');
assert.ok(heavyRow.pct > 100);
assert.strictEqual(heavyRow.oversold, true);

// Accommodation: guest-nights with configured bed capacity
const withAccom = computeSunsetFinanceSummary({
  now: NOW,
  timeZone: 'Europe/Madrid',
  view: { granularity: 'month', anchor: '2026-08-15' },
  bsr: [
    {
      booking_id: 'A1',
      service_date: '2026-08-05',
      service_type: 'addon_service',
      quantity: 1,
      amount_due_cents: 9000,
      metadata: {
        source: 'staff_accommodation',
        staff_accommodation: true,
        component: 'staff_accommodation',
        check_in: '2026-08-05',
        check_out: '2026-08-07',
        occupied_nights: ['2026-08-05', '2026-08-06'],
      },
    },
    {
      booking_id: 'A2',
      service_date: '2026-08-20',
      service_type: 'addon_service',
      quantity: 1,
      amount_due_cents: 4500,
      metadata: {
        source: 'staff_accommodation',
        staff_accommodation: true,
        component: 'staff_accommodation',
        check_in: '2026-08-20',
        check_out: '2026-08-21',
        occupied_nights: ['2026-08-20'],
      },
    },
  ],
  payments: [],
  bookings: [],
  rental_stock: rentalStock,
  surf_packs: [],
  accommodation_settings: { bed_capacity: 2 },
});
const accomRow = withAccom.redesign.capacity.by_product.find((r) => r.label === 'Accommodation'
  || (r.offering_keys || []).includes('staff_accommodation'));
assert.ok(accomRow, 'accommodation capacity row when bed_capacity configured');
assert.strictEqual(accomRow.detail, '3/62', `accommodation detail got ${accomRow.detail}`);

const hiddenAccom = computeSunsetFinanceSummary({
  now: NOW,
  timeZone: 'Europe/Madrid',
  view: { granularity: 'month', anchor: '2026-08-15' },
  bsr: [{
    booking_id: 'A1',
    service_date: '2026-08-05',
    service_type: 'addon_service',
    quantity: 1,
    amount_due_cents: 9000,
    metadata: {
      source: 'staff_accommodation',
      staff_accommodation: true,
      component: 'staff_accommodation',
      check_in: '2026-08-05',
      check_out: '2026-08-07',
      occupied_nights: ['2026-08-05', '2026-08-06'],
    },
  }],
  payments: [],
  bookings: [],
  rental_stock: rentalStock,
  surf_packs: [],
});
assert.ok(!hiddenAccom.redesign.capacity.by_product.some((r) => /accommodation/i.test(String(r.label || ''))),
  'accommodation hidden without bed_capacity');

assert.ok(dataSrc.includes('bed_capacity'), 'finance data fetch reads bed_capacity');
assert.ok(!/inbox-thread\.js/.test(redesignSrc), 'stays off inbox-thread');

const box = {
  window: {},
  portalLang: 'en',
  portalT: (k, fb) => fb || k,
};
vm.createContext(box);
vm.runInContext(redesignSrc + '\nthis.renderFinanceRedesignHtml = renderFinanceRedesignHtml;', box);

const html = box.renderFinanceRedesignHtml({
  redesign: {
    view: { granularity: 'month', range: AUG },
    net: { net_collected_cents: 0, gross_collected_cents: 0 },
    pipeline: { booked_cents: 0, bookings_count: 0 },
    outstanding: { outstanding_cents: 0, bookings_count: 0, due_soon_cents: 0, overdue_cents: 0 },
    revenue_by_product: [],
    capacity: {
      seats_pct: 71,
      seats_filled: 34,
      seats_capacity: 48,
      by_product: [
        { slot: 'lessons', label: 'Lessons', pct: 71, detail: '34/48', oversold: false },
        { slot: 'rank_1', label: 'Board+suit', pct: 132, detail: '132/3100', oversold: true },
      ],
    },
    daily_gross_trend: [],
    monthly_gross_trend: [],
    limitations: {},
  },
});

assert.ok(html.includes('132/3100'));
assert.ok(html.includes('132%'));
assert.ok(/data-capacity-over="1"/.test(html));
assert.ok(/pfb-bar-fill[^>]*is-over/.test(html));

console.log('PASS finance capacity period denominators (stock×days, accommodation guest-nights, oversold)');
