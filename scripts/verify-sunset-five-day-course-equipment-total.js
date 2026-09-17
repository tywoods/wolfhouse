'use strict';

const assert = require('node:assert/strict');
const { applyAuthoritativeQuoteAmounts } = require('./lib/sunset-schedule-booking-writes');

const dates = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'];
const rows = [
  {
    service_record_id: '00000000-0000-0000-0000-000000000001',
    service_type: 'surf_lesson', service_date: dates[0], quantity: 3,
    metadata: { component: 'course', course_id: 'group-course', tier_key: '5_days', offering_id: 'group-course__5_days' },
  },
  ...dates.map((date, i) => ({
    service_record_id: `00000000-0000-0000-0000-00000000010${i}`,
    service_type: 'addon_service', service_date: date, quantity: 3,
    metadata: {
      course_equipment: true,
      component: 'course_equipment',
      offering_key: 'board_wetsuit',
      course_equipment_mode: 'during_course',
    },
  })),
];

const amounts = new Map();
const pg = {
  async query(_sql, params) {
    amounts.set(String(params[1]), Number(params[0]));
    return { rowCount: 1, rows: [] };
  },
};

(async () => {
  const quote = {
    total_cents: 63000,
    line_items: [
      {
        component: 'course', course_id: 'group-course', tier_key: '5_days',
        offering_id: 'group-course__5_days', quantity: 3, total_cents: 48000,
      },
      {
        component: 'course_equipment', course_equipment: true,
        offering_key: 'board_wetsuit', course_equipment_mode: 'during_course',
        quantity: 3, unit_amount_cents: 1000, date_count: 5, total_cents: 15000,
      },
    ],
  };

  const result = await applyAuthoritativeQuoteAmounts(pg, rows, quote, { clientSlug: 'sunset' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(amounts.get(rows[0].service_record_id), 48000);
  for (const row of rows.slice(1)) assert.equal(amounts.get(row.service_record_id), 3000);
  assert.equal([...amounts.values()].reduce((sum, cents) => sum + cents, 0), 63000);

  const mismatch = await applyAuthoritativeQuoteAmounts(pg, rows.slice(0, -1), quote, { clientSlug: 'sunset' });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error, 'course_equipment_date_split_mismatch');

  console.log('verify-sunset-five-day-course-equipment-total: PASS');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
