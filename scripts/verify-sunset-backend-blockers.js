'use strict';
const assert = require('assert');
const fs = require('fs');
const { spawn } = require('child_process');
const pricing = require('./lib/sunset-course-equipment-pricing');
const ops = require('./lib/sunset-schedule-ops');
const store = require('./lib/sunset-admin-location-store');
const { formatServiceRecordInvoiceLineText } = require('./lib/service-record-invoice-line');

function child(location, cents) {
  const code = `const s=require(${JSON.stringify(require.resolve('./lib/sunset-admin-location-store'))});s.putCourseEquipmentPricing(${JSON.stringify(location)},{all_day:{enabled:true,surfboard_cents:${cents},wetsuit_cents:1}})`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', code], { stdio: 'inherit' });
    p.on('error', reject); p.on('exit', n => n === 0 ? resolve() : reject(new Error(`child exit ${n}`)));
  });
}

(async () => {
  assert.throws(() => pricing.quoteCourseEquipment({
    course: {
      equipment_options: [{
        offering_key: 'softboard',
        equipment_price_cents: Number.MAX_SAFE_INTEGER,
        all_day_surcharge_cents: 1,
      }],
    },
    selection: [{ offering_key: 'softboard', mode: 'all_day', quantity: 1 }],
    surfers: 1,
  }), /overflow/);
  assert.strictEqual(require('./lib/sunset-schedule-booking-writes').checkedMoneyAdd(2, 3, 'booking_total'), 5);
  assert.throws(() => require('./lib/sunset-schedule-booking-writes').checkedMoneyAdd(Number.MAX_SAFE_INTEGER, 1, 'booking_total'), /booking_total_overflow/);
  assert.throws(() => require('./lib/sunset-schedule-booking-writes').checkedMoneySubtract(Number.MIN_SAFE_INTEGER, 1, 'balance'), /balance_overflow/);

  const rows = [
    { booking_id: 'a', service_type: 'surf_lesson', service_date: '2026-08-01', quantity: 2 },
    { booking_id: 'a', service_type: 'surf_lesson', service_date: '2026-08-01', quantity: 2 },
    { booking_id: 'a', service_type: 'surfboard', service_date: '2026-08-01', quantity: 2 },
    { booking_id: 'a', service_type: 'wetsuit', service_date: '2026-08-01', quantity: 2 },
    { booking_id: 'b', service_type: 'surf_lesson', service_date: '2026-08-01', quantity: 3 },
    { booking_id: 'b', service_type: 'surfboard', service_date: '2026-08-01', quantity: 3 },
    { booking_id: 'cancel', booking_status: 'cancelled', service_type: 'surf_lesson', service_date: '2026-08-01', quantity: 99, metadata: { included_equipment: true } },
  ];
  const day = ops.aggregateDayOps(rows, '2026-08-01', {});
  assert.strictEqual(day.boardsLesson, 5, 'same booking deduped; different bookings additive');
  assert.strictEqual(day.wetsuitsLesson, 2, 'cancelled demand excluded');

  for (const sample of [
    { mode: 'during_course', component: 'surfboard', unit: 0, total: 0, label: 'Surfboard' },
    { mode: 'during_course', component: 'wetsuit', unit: 400, total: 800, label: 'Wetsuit' },
    { mode: 'all_day', component: 'surfboard', unit: 1200, total: 2400, label: 'Surfboard' },
  ]) {
    const text = formatServiceRecordInvoiceLineText({ service_type: sample.component,
      service_date: '2026-08-01', quantity: 2, amount_due_cents: sample.total,
      metadata: { course_equipment: true, component: sample.component,
        course_equipment_mode: sample.mode, unit_amount_cents: sample.unit } });
    assert(text.includes(sample.label) && text.includes('2026-08-01'));
    assert(text.endsWith(`€${(sample.total / 100).toFixed(2)}`), text);
  }

  const cancelOwner = fs.readFileSync(require.resolve('./lib/sunset-schedule-booking-drawer'), 'utf8');
  const cancelStart = cancelOwner.indexOf('async function cancelSunsetScheduleBooking');
  const cancelSlice = cancelOwner.slice(cancelStart, cancelStart + 6000);
  assert(cancelSlice.indexOf("await pg.query('BEGIN')") < cancelSlice.indexOf('loadSunsetBookingBundle'));
  assert(/loadSunsetBookingBundle\(pg, clientSlug, bookingId, null, true\)/.test(cancelSlice));
  assert(/paid_booking_cancel_conflict/.test(cancelSlice) && /ROLLBACK/.test(cancelSlice));

  const before = fs.existsSync(store.STORE_PATH) ? fs.readFileSync(store.STORE_PATH) : null;
  try {
    await Promise.all([child('sunset-somo', 111), child('sunset-sardinero', 222)]);
    assert.strictEqual(store.getCourseEquipmentPricing('sunset-somo').all_day.surfboard_cents, 111);
    assert.strictEqual(store.getCourseEquipmentPricing('sunset-sardinero').all_day.surfboard_cents, 222);
    const snapshot = fs.readFileSync(store.STORE_PATH, 'utf8');
    assert.throws(() => store.putCourseEquipmentPricing('sunset-somo', { bad: true }));
    assert.strictEqual(fs.readFileSync(store.STORE_PATH, 'utf8'), snapshot, 'failed mutation rolls back');
  } finally {
    try { fs.unlinkSync(`${store.STORE_PATH}.lock`); } catch (_) {}
    if (before == null) try { fs.unlinkSync(store.STORE_PATH); } catch (_) {}
    else fs.writeFileSync(store.STORE_PATH, before);
  }
  console.log('PASS backend money/persistence/inventory executable gate');
})().catch((err) => { console.error(err); process.exit(1); });
