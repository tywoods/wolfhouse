'use strict';
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.WOLFHOUSE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(`
    SELECT bb1.room_code, bb1.bed_code,
           bb1.assignment_end_date::text AS turnover_day,
           b1.guest_name AS out_guest, b1.booking_code AS out_code,
           b2.guest_name AS in_guest, b2.booking_code AS in_code
    FROM booking_beds bb1
    JOIN bookings b1 ON b1.id = bb1.booking_id
    JOIN booking_beds bb2 ON bb2.room_code = bb1.room_code AND bb2.bed_code = bb1.bed_code
    JOIN bookings b2 ON b2.id = bb2.booking_id
    WHERE bb1.assignment_end_date = bb2.assignment_start_date
      AND bb1.booking_id <> bb2.booking_id
      AND b1.status NOT IN ('cancelled', 'expired')
      AND b2.status NOT IN ('cancelled', 'expired')
    ORDER BY bb1.assignment_end_date DESC
    LIMIT 10`);
  console.log(JSON.stringify(r.rows, null, 2));
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
