/* eslint-disable no-console */
'use strict';

/**
 * verify-sunset-multi-date-lesson-pricing.js
 *
 * Regression: booking-create returns an authoritative total for multiple dated
 * group lessons (lesson + service_dates). The total must come from config/DB
 * truth (not model math), using the configured single-lesson unit price.
 *
 * Pure/offline: priceSunsetBookingServices is exercised with a fake pg client.
 * The resolver reads config/clients/sunset.baseline.json (DB layers disabled).
 */

const { priceSunsetBookingServices } = require('./lib/sunset-stripe-payment-links');

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${msg}`); }
  else { fail += 1; console.log(`  FAIL  ${msg}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n── verify-sunset-multi-date-lesson-pricing ──\n');

// Force config-only resolution (no DB overlay reads).
process.env.SUNSET_ADMIN_DB_READ_ENABLED = '0';
process.env.SUNSET_ADMIN_JSON_OVERLAY = '0';

const bookingId = '00000000-0000-0000-0000-000000000001';
const lessonRows = [
  { id: '00000000-0000-0000-0000-000000000011', service_type: 'surf_lesson', service_date: '2026-07-20', quantity: 1, amount_due_cents: 0, metadata: '{}' },
  { id: '00000000-0000-0000-0000-000000000012', service_type: 'surf_lesson', service_date: '2026-07-21', quantity: 1, amount_due_cents: 0, metadata: '{}' },
  { id: '00000000-0000-0000-0000-000000000013', service_type: 'surf_lesson', service_date: '2026-07-22', quantity: 1, amount_due_cents: 0, metadata: '{}' },
  { id: '00000000-0000-0000-0000-000000000014', service_type: 'surf_lesson', service_date: '2026-07-23', quantity: 1, amount_due_cents: 0, metadata: '{}' },
];

const updates = {
  serviceRecordDue: [],
  bookingTotal: [],
};

const pg = {
  async query(sql, params) {
    const q = String(sql || '');
    if (q.includes('SELECT metadata FROM bookings')) {
      // Booking metadata: must carry a Sunset location for config scoping.
      return { rows: [{ metadata: { location_id: 'sunset-somo' } }] };
    }
    if (q.includes('FROM booking_service_records') && q.includes('WHERE client_slug = $1 AND booking_id = $2::uuid')) {
      return { rows: lessonRows };
    }
    if (q.startsWith('UPDATE booking_service_records SET amount_due_cents')) {
      updates.serviceRecordDue.push({ due: params[0], id: params[1] });
      return { rows: [] };
    }
    if (q.startsWith('UPDATE bookings')) {
      updates.bookingTotal.push({ total: params[0], bookingId: params[2] });
      return { rows: [] };
    }
    throw new Error(`unexpected query in test fake pg: ${q.slice(0, 120)}`);
  },
};

(async () => {
  const priced = await priceSunsetBookingServices(pg, 'sunset', bookingId);
  ok(priced && priced.ok === true, 'pricing ok', JSON.stringify(priced));

  ok(updates.serviceRecordDue.length === 4, 'updates 4 lesson rows', updates.serviceRecordDue.length);
  const dues = updates.serviceRecordDue.map((u) => u.due);
  const unique = [...new Set(dues)];
  ok(unique.length === 1, 'all 4 lessons use same unit total (qty=1 each)', JSON.stringify(unique));
  const unitDue = unique[0];
  ok(Number.isInteger(unitDue) && unitDue > 0, 'unit due_cents is positive int', unitDue);

  ok(priced.total_cents === unitDue * 4, 'total_cents = unit × 4 dates', `${priced.total_cents} vs ${unitDue * 4}`);
  ok(updates.bookingTotal.length === 1, 'booking total updated once', updates.bookingTotal.length);
  ok(updates.bookingTotal[0].total === priced.total_cents, 'bookings.total_amount_cents set to priced total', JSON.stringify(updates.bookingTotal[0]));

  console.log('\n────────────────────────────────────────────────');
  console.log(`verify-sunset-multi-date-lesson-pricing  pass=${pass}  fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('verify-sunset-multi-date-lesson-pricing — ALL CHECKS PASSED');
})().catch((err) => {
  console.error('verify-sunset-multi-date-lesson-pricing crashed:', err && err.message);
  process.exit(1);
});