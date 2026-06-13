'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');

(async () => {
  const dbUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const bookings = await pg.query(`
    SELECT b.id::text, b.booking_code, b.phone, b.check_in::text, b.check_out::text,
           b.guest_count, b.status::text, COUNT(bb.id)::int AS bed_rows
      FROM bookings b
      JOIN clients c ON c.id = b.client_id
      LEFT JOIN booking_beds bb ON bb.booking_id = b.id
     WHERE c.slug = 'wolfhouse-somo'
       AND b.check_in <= '2026-07-17' AND b.check_out >= '2026-07-10'
     GROUP BY b.id ORDER BY b.created_at DESC`);
  const beds = await pg.query(`
    SELECT COUNT(*)::int AS total_beds FROM beds b
      JOIN rooms r ON r.id = b.room_id
      JOIN clients c ON c.id = r.client_id
     WHERE c.slug = 'wolfhouse-somo'`);
  const bb = await pg.query(`
    SELECT bb.bed_code, bb.room_code, b.booking_code, bb.assignment_start_date::text, bb.assignment_end_date::text
      FROM booking_beds bb
      JOIN bookings b ON b.id = bb.booking_id
      JOIN clients c ON c.id = bb.client_id
     WHERE c.slug = 'wolfhouse-somo'
       AND bb.assignment_start_date <= '2026-07-17' AND bb.assignment_end_date >= '2026-07-10'`);
  const wh = await pg.query(`
    SELECT b.id::text, b.booking_code, b.guest_name, b.phone, bb.bed_code, bb.room_code
      FROM bookings b
      LEFT JOIN booking_beds bb ON bb.booking_id = b.id
     WHERE b.check_in = '2026-07-10' AND b.check_out = '2026-07-17'
     ORDER BY b.booking_code, bb.bed_code`);
  await pg.end();
  console.log(JSON.stringify({ total_beds: beds.rows[0], overlapping_bookings: bookings.rows, overlapping_bb: bb.rows, wh_g27: wh.rows }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
