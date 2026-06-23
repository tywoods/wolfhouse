'use strict';
const path = require('path');
process.chdir('/opt/wolfhouse/WH');
const { patchLessonTimeRule } = require('../scripts/lib/tenant-admin-writes');
const { withPgClient } = require('../scripts/lib/pg-connect');

const ruleId = process.argv[2] || 'b37c438d-6605-4943-83f9-0a623cc992c3';

(async () => {
  await withPgClient(async (pg) => {
    const col = await pg.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tenant_lesson_time_rules' AND column_name = 'capacity'`,
    );
    console.log('hasCapacityCol', col.rows.length > 0);
    const patch = {
      label: 'Adult / adolescent group surf lesson (over 12)',
      time_local: '11:00',
      time_local_end: '13:00',
      capacity: 26,
      amount_cents: 0,
    };
    try {
      const result = await patchLessonTimeRule(pg, {
        ruleId,
        clientSlug: 'sunset',
        locationId: 'sunset-sardinero',
        patch,
        actor: { staff_user_id: null, email: 'probe@test' },
      });
      console.log('result', JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('THROW', err.message);
      console.error(err.stack);
    }
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
