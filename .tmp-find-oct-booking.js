'use strict';
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DB_URL });
async function main() {
  await client.connect();
  const phone = '+491726422307';
  const suffix = phone.replace(/\D/g, '').slice(-9);

  const bookings = await client.query(
    `SELECT b.id::text, b.booking_code, b.check_in, b.check_out, b.status::text, b.payment_status::text,
            b.phone, b.guest_name, b.created_at,
            (SELECT COUNT(*) FROM booking_beds bb WHERE bb.booking_id = b.id)::int AS bed_count
     FROM bookings b
     WHERE b.phone LIKE $1
     ORDER BY b.check_in ASC`,
    [`%${suffix}%`]
  );
  console.log('All bookings for phone:', JSON.stringify(bookings.rows, null, 2));

  const oct = await client.query(
    `SELECT b.id::text, b.booking_code, b.check_in, b.check_out, b.status::text, b.payment_status::text
     FROM bookings b
     WHERE b.booking_code LIKE '%20241006%' OR b.booking_code LIKE '%5dbf98%'
        OR (b.check_in::date = '2024-10-06' AND b.check_out::date = '2024-10-09')`
  );
  console.log('Oct booking:', JSON.stringify(oct.rows, null, 2));

  // Check services on WH-G27 booking
  const svc = await client.query(
    `SELECT sr.id::text, sr.service_type, sr.status, sr.amount_due_cents, sr.metadata
     FROM service_records sr
     JOIN bookings b ON b.id = sr.booking_id
     WHERE b.booking_code = 'WH-G27-5AD46DDF56'`
  );
  console.log('Services on WH-G27:', JSON.stringify(svc.rows, null, 2));

  await client.end();
}
main().catch(e => console.error(e.message));
