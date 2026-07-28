'use strict';
const assert = require('assert');
const fs = require('fs');
const { spawn } = require('child_process');
const pricing = require('./lib/sunset-course-equipment-pricing');
const ops = require('./lib/sunset-schedule-ops');
const store = require('./lib/sunset-admin-location-store');

function child(location, cents) {
  const code = `const s=require(${JSON.stringify(require.resolve('./lib/sunset-admin-location-store'))});s.putCourseEquipmentPricing(${JSON.stringify(location)},{during_course:{policy:'extra',surfboard_cents:${cents},wetsuit_cents:1},all_day:{surfboard_cents:2,wetsuit_cents:3}})`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', code], { stdio: 'inherit' });
    p.on('error', reject); p.on('exit', n => n === 0 ? resolve() : reject(new Error(`child exit ${n}`)));
  });
}

(async () => {
  assert.throws(() => pricing.quoteCourseEquipment({
    config: { during_course: { policy: 'extra', surfboard_cents: Number.MAX_SAFE_INTEGER, wetsuit_cents: 1 }, all_day: { surfboard_cents: 0, wetsuit_cents: 0 } },
    selection: { mode: 'during_course', quantity: 1 }, surfers: 1, booking_dates: ['2026-08-01'],
  }), /overflow/);

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

  const before = fs.existsSync(store.STORE_PATH) ? fs.readFileSync(store.STORE_PATH) : null;
  try {
    await Promise.all([child('sunset-somo', 111), child('sunset-sardinero', 222)]);
    assert.strictEqual(store.getCourseEquipmentPricing('sunset-somo').during_course.surfboard_cents, 111);
    assert.strictEqual(store.getCourseEquipmentPricing('sunset-sardinero').during_course.surfboard_cents, 222);
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
