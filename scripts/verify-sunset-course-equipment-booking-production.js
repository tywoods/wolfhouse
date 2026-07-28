'use strict';
const assert = require('assert');
const writes = require('./lib/sunset-schedule-booking-writes');
const pricing = require('./lib/sunset-course-equipment-pricing');

function memoryPg() {
  const rows = [];
  return { rows, async query(sql, p) {
    if (/INSERT INTO booking_service_records/i.test(sql)) {
      const metadata = JSON.parse(p[9]);
      const row = { id: `00000000-0000-0000-0000-${String(rows.length + 1).padStart(12, '0')}`,
        service_record_id: `00000000-0000-0000-0000-${String(rows.length + 1).padStart(12, '0')}`,
        client_slug: p[0], booking_id: p[1], booking_code: p[2], guest_name: p[3],
        service_type: p[4], service_date: p[5], quantity: p[6], payment_status: p[7], metadata };
      rows.push(row); return { rows: [row], rowCount: 1 };
    }
    if (/UPDATE booking_service_records SET amount_due_cents/i.test(sql)) {
      const row = rows.find(r => r.id === p[1]); row.amount_due_cents = p[0]; return { rowCount: 1, rows: [] };
    }
    throw new Error(`unexpected SQL ${sql}`);
  }};
}

(async () => {
  const config = { during_course: { policy: 'extra', surfboard_cents: 600, wetsuit_cents: 400 }, all_day: { surfboard_cents: 1200, wetsuit_cents: 800 } };
  const valid = writes.validateScheduleBookingBody({ guest_name: 'Stateful', service_dates: ['2026-08-03','2026-08-04'], payment_status: 'unpaid', components: { course: { quantity: 3, course_id: 'c', tier_key: '2_days' } }, course_equipment: { mode: 'all_day', quantity: 2 } });
  assert(valid.ok, valid.error); assert.deepStrictEqual(valid.value.course_equipment, { mode: 'all_day', quantity: 2 });
  assert(!writes.validateScheduleBookingBody({ guest_name:'x', service_dates:['2026-08-03'], components:{ course:{quantity:2,course_id:'c'} }, course_equipment:{mode:'all_day',quantity:3} }).ok, 'server rejects quantity above surfers');
  assert(!writes.validateScheduleBookingBody({ guest_name:'x', service_dates:['2026-08-03'], components:{surfboard:{quantity:1}}, surfer_count:1, course_equipment:{mode:'all_day',quantity:1} }).ok, 'no-lesson cannot buy course coverage');

  const pg = memoryPg();
  const rows = await writes.insertCourseEquipmentRows(pg, { clientSlug:'sunset', bookingId:'00000000-0000-0000-0000-000000000099', bookingCode:'SUN-1', guestName:'Stateful', selection:valid.value.course_equipment, surfers:3, bookingDates:valid.value.service_dates, config, attribution:{metadataSource:'staff_schedule',staffManualSchedule:true,dbSource:'staff_manual'}, locationId:'sunset-somo', bundleId:'b', srPayment:'pending' });
  assert.strictEqual(rows.length, 4, 'separate board+wetsuit row per date');
  assert.strictEqual(rows.reduce((n,r)=>n+r.amount_due_cents,0), 8000, 'checked per-person/day all-day pricing');
  assert.strictEqual(new Set(rows.map(r=>`${r.service_date}|${r.metadata.component}`)).size, 4);
  assert(rows.every(r=>r.metadata.course_equipment_mode === 'all_day' && r.metadata.location_id === 'sunset-somo'));
  const free = pricing.quoteCourseEquipment({ config:{...config,during_course:{policy:'free_with_course',surfboard_cents:999,wetsuit_cents:999}}, selection:{mode:'during_course',quantity:3}, surfers:3, booking_dates:['2026-08-03'] });
  assert.strictEqual(free.total_cents, 0); assert.strictEqual(free.lines.length, 2);
  assert.deepStrictEqual(pricing.dedupeInventory([...rows.map(r=>({component:r.metadata.component,service_date:r.service_date,quantity:r.quantity})),{component:'surfboard',service_date:'2026-08-03',quantity:1}]).find(r=>r.component==='surfboard'&&r.service_date==='2026-08-03').quantity,2);
  console.log('verify:sunset-course-equipment-booking-production — ALL CHECKS PASSED');
})().catch(e=>{console.error(e);process.exit(1);});
