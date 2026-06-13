'use strict';
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.WOLFHOUSE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const beds = await c.query(`
    SELECT r.room_code, b.bed_code
    FROM rooms r
    JOIN beds b ON b.room_id = r.id
    JOIN clients cl ON cl.id = r.client_id
    WHERE cl.slug = 'wolfhouse-somo' AND r.active AND b.active
    ORDER BY COALESCE(r.sort_order, 999), r.room_code, COALESCE(b.bed_number, 999)
    LIMIT 20`);
  console.log('BEDS', JSON.stringify(beds.rows, null, 2));

  const ciA = '2026-06-10';
  const coA = '2026-06-11';
  const ciB = '2026-06-11';
  const coB = '2026-06-12';

  for (const bed of beds.rows.slice(0, 5)) {
    const conflicts = await c.query(`
      SELECT bb.room_code, bb.bed_code, bb.assignment_start_date::text AS start_date,
             bb.assignment_end_date::text AS end_date, b.booking_code, b.guest_name
      FROM booking_beds bb
      JOIN bookings b ON b.id = bb.booking_id
      JOIN clients cl ON cl.id = b.client_id
      WHERE cl.slug = 'wolfhouse-somo'
        AND bb.room_code = $1 AND bb.bed_code = $2
        AND bb.assignment_start_date < $4::date AND bb.assignment_end_date > $3::date
        AND b.status NOT IN ('cancelled', 'expired')
      ORDER BY bb.assignment_start_date`, [bed.room_code, bed.bed_code, ciA, coB]);
    console.log(`CONFLICTS ${bed.room_code}/${bed.bed_code} for ${ciA}-${coB}:`, conflicts.rows.length,
      conflicts.rows.length ? JSON.stringify(conflicts.rows) : 'none');
  }
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
