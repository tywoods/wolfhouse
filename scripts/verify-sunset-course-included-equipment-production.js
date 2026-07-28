'use strict';
const assert = require('assert');
const writes = require('./lib/sunset-schedule-booking-writes');
const ops = require('./lib/sunset-schedule-ops');

function memoryPg() {
  const rows = [];
  return {
    rows,
    async query(sql, params) {
      if (/to_regclass/i.test(sql)) return { rows: [{ t: 'booking_service_records' }] };
      if (/pg_constraint/i.test(sql)) return { rows: [{ definition: "CHECK ((service_type)::text = ANY ((ARRAY['addon_service'::character varying])::text[]))" }] };
      if (/^\s*ALTER TABLE/i.test(sql)) return { rows: [], rowCount: 0 };
      if (!/INSERT INTO booking_service_records/i.test(sql)) throw new Error(`unexpected SQL: ${sql}`);
      const addon = /'addon_service'/.test(sql);
      const metadata = JSON.parse(addon ? params[9] : params[9]);
      const row = addon
        ? { id: `sr-${rows.length + 1}`, service_record_id: `sr-${rows.length + 1}`, booking_id: params[1], booking_code: params[2], guest_name: params[3], service_type: 'addon_service', service_date: params[4], quantity: params[5], amount_due_cents: params[6], payment_status: params[7], record_source: params[8], metadata }
        : { id: `sr-${rows.length + 1}`, service_record_id: `sr-${rows.length + 1}`, booking_id: params[1], booking_code: params[2], guest_name: params[3], service_type: params[4], service_date: params[5], quantity: params[6], payment_status: params[7], record_source: params[8], metadata, amount_due_cents: 0 };
      rows.push(row);
      return { rows: [row], rowCount: 1 };
    },
  };
}

async function persist(pg, { dates, people, included, paid = false }) {
  const components = { course: { course_id: 'pack-1', course_label: 'Course', tier_key: '1_day', quantity: people } };
  if (paid) components.full_day_equipment_extension = { dates: Object.fromEntries(dates.map(date => [date, people])) };
  const input = { guest_name: 'Production Owner', notes: '', needs_reply: false, service_dates: dates, components };
  const created = await writes.insertScheduleComponentServiceRows(pg, { clientSlug: 'sunset', bookingId: 'booking-1', bookingCode: 'SUN-1', input, attribution: { metadataSource: 'staff_schedule', staffManualSchedule: true, dbSource: 'staff_manual' }, locationId: 'sunset-somo', srPayment: 'pending', assignedCourse: { course_id: 'pack-1', pack: { equipment_included: included } }, bundleId: 'bundle-1' });
  if (paid) created.push(...await writes.insertFullDayEquipmentAddonRows(pg, { clientSlug: 'sunset', bookingId: 'booking-1', bookingCode: 'SUN-1', guestName: input.guest_name, addonDates: components.full_day_equipment_extension.dates, addonUnitCents: 1500, componentKeys: Object.keys(components), bundleId: 'bundle-1', locationId: 'sunset-somo', srPayment: 'pending', attribution: { metadataSource: 'staff_schedule', staffManualSchedule: true, dbSource: 'staff_manual' } }));
  return created;
}

(async () => {
  const pg = memoryPg();
  await persist(pg, { dates: ['2026-08-10', '2026-08-11'], people: 3, included: true, paid: true });
  const included = pg.rows.filter(r => r.metadata.included_equipment === true && ['surfboard', 'wetsuit'].includes(r.metadata.component));
  assert.strictEqual(included.length, 4, 'create persists distinct board+wetsuit rows for every course day');
  assert(included.every(r => r.amount_due_cents === 0 && r.quantity === 3));
  assert.strictEqual(new Set(included.map(r => `${r.service_date}:${r.metadata.component}`)).size, 4, 'no duplicate persisted identities');
  const day = ops.aggregateDayOps(pg.rows, '2026-08-10', {});
  assert.strictEqual(day.boardsTotal, 3, 'real schedule aggregate deduplicates included + paid board demand');
  assert.strictEqual(day.wetsuitsTotal, 3, 'real schedule aggregate deduplicates included + paid wetsuit demand');
  const paid = pg.rows.filter(r => r.metadata.component === writes.FULL_DAY_EQUIPMENT_ADDON_KEY);
  assert.strictEqual(paid.length, 2, 'paid extension remains separately persisted');
  assert(paid.every(r => r.amount_due_cents > 0 || r.metadata.unit_amount_cents === 1500), 'paid extension remains billable');

  // Edit reconciliation uses the production replacement writer: old owned rows are deleted in the same txn,
  // then this shared Create/Edit persistence owner rebuilds exactly the requested dates/quantity.
  pg.rows.splice(0);
  await persist(pg, { dates: ['2026-08-12'], people: 2, included: true });
  const edited = pg.rows.filter(r => r.metadata.included_equipment === true && ['surfboard', 'wetsuit'].includes(r.metadata.component));
  assert.strictEqual(edited.length, 2);
  assert(edited.every(r => r.service_date === '2026-08-12' && r.quantity === 2));
  assert(!pg.rows.some(r => ['2026-08-10', '2026-08-11'].includes(r.service_date)), 'no orphan old dates after edit replacement');

  console.log('verify:sunset-course-included-equipment-production — ALL CHECKS PASSED');
})().catch(err => { console.error(err); process.exit(1); });
