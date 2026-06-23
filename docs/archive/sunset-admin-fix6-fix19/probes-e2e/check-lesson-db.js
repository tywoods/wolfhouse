'use strict';
process.chdir('/opt/wolfhouse/WH');
const { withPgClient } = require('../scripts/lib/pg-connect');

(async () => {
  await withPgClient(async (pg) => {
    const col = await pg.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tenant_lesson_time_rules' AND column_name = 'capacity'`,
    );
    console.log('hasCapacityCol', col.rows.length > 0);
    const rows = await pg.query(
      `SELECT id, label, time_local, time_local_end, lesson_type, weekdays_active
         FROM tenant_lesson_time_rules
        WHERE client_slug = 'sunset' AND location_id = 'sunset-sardinero' AND active = true`,
    );
    console.log('rows', JSON.stringify(rows.rows, null, 2));
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
