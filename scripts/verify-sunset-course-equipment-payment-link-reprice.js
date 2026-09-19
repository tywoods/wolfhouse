/* eslint-disable no-console */
'use strict';

/**
 * Regression: payment-link repricing must keep every per-date all-day
 * course-equipment charge even though ownership metadata includes course_id.
 * Pure/offline: exercises the production priceSunsetBookingServices function.
 */

process.env.SUNSET_ADMIN_DB_READ_ENABLED = '0';
process.env.SUNSET_ADMIN_JSON_OVERLAY = '0';

const assert = require('assert');
const { priceSunsetBookingServices } = require('./lib/sunset-stripe-payment-links');

const bookingId = '00000000-0000-0000-0000-000000000001';
const rows = [
  { id: '00000000-0000-0000-0000-000000000021', service_type: 'surf_lesson', service_date: '2026-07-20', quantity: 1, amount_due_cents: 20000, metadata: { component: 'course', course_id: 'course-1', tier_key: '2_days' } },
  { id: '00000000-0000-0000-0000-000000000022', service_type: 'surf_lesson', service_date: '2026-07-21', quantity: 1, amount_due_cents: 0, metadata: { component: 'course', course_id: 'course-1', tier_key: '2_days' } },
  { id: '00000000-0000-0000-0000-000000000031', service_type: 'addon_service', service_date: '2026-07-20', quantity: 1, amount_due_cents: 2000, metadata: { component: 'addon_service', course_equipment: true, course_id: 'course-1', tier_key: '2_days' } },
  { id: '00000000-0000-0000-0000-000000000032', service_type: 'addon_service', service_date: '2026-07-21', quantity: 1, amount_due_cents: 2000, metadata: { component: 'course_equipment', course_id: 'course-1', tier_key: '2_days' } },
];

const updates = { serviceDue: [], bookingTotal: [] };
const pg = {
  async query(sql, params) {
    const q = String(sql || '');
    if (q.includes('SELECT metadata FROM bookings')) {
      return { rows: [{ metadata: { location_id: 'sunset-somo' } }] };
    }
    if (q.includes('FROM booking_service_records') && q.includes('WHERE client_slug = $1 AND booking_id = $2::uuid')) {
      return { rows };
    }
    if (q.startsWith('UPDATE booking_service_records SET amount_due_cents')) {
      updates.serviceDue.push({ due: params[0], id: params[1] });
      return { rows: [] };
    }
    if (q.startsWith('UPDATE bookings')) {
      updates.bookingTotal.push({ total: params[0], bookingId: params[2] });
      return { rows: [] };
    }
    throw new Error(`unexpected query in fake pg: ${q.slice(0, 140)}`);
  },
};

(async () => {
  const priced = await priceSunsetBookingServices(pg, 'sunset', bookingId);
  const equipmentIds = new Set(rows.slice(2).map((row) => row.id));
  const zeroedEquipmentIds = updates.serviceDue
    .filter((update) => update.due === 0 && equipmentIds.has(update.id))
    .map((update) => update.id);

  assert.deepStrictEqual(zeroedEquipmentIds, [], 'course-equipment rows must never be peer-zeroed');
  assert.strictEqual(priced.ok, true, JSON.stringify(priced));
  assert.strictEqual(priced.total_cents, 24000, 'course 20000 + all-day equipment 2000 × 2');
  assert.strictEqual(updates.bookingTotal.length, 1, 'booking total updated exactly once');
  assert.strictEqual(updates.bookingTotal[0].total, 24000, 'payment-link amount preserves every equipment day');
  console.log('verify:sunset-course-equipment-payment-link-reprice — ALL CHECKS PASSED');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
