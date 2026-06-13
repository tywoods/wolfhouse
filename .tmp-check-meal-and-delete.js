'use strict';
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DB_URL });
async function main() {
  await client.connect();

  const svc = await client.query(
    `SELECT sr.id::text, sr.service_type, sr.status, sr.amount_due_cents, sr.metadata, sr.created_at
     FROM booking_service_records sr
     JOIN bookings b ON b.id = sr.booking_id
     WHERE b.booking_code = 'WH-G27-5AD46DDF56'`
  );
  console.log('Services on WH-G27:', JSON.stringify(svc.rows, null, 2));

  const payments = await client.query(
    `SELECT p.id::text, p.payment_kind, p.payment_status, p.amount_due_cents, p.metadata
     FROM payments p
     JOIN bookings b ON b.id = p.booking_id
     WHERE b.booking_code = 'WH-G27-5AD46DDF56'
     ORDER BY p.created_at`
  );
  console.log('Payments on WH-G27:', JSON.stringify(payments.rows, null, 2));

  const octId = '946cc3ba-70e9-4f9f-a6b8-140ca3d22a79';
  const beds = await client.query(
    `SELECT bb.id::text, bb.bed_id, bb.check_in, bb.check_out
     FROM booking_beds bb WHERE bb.booking_id = $1::uuid`, [octId]
  );
  console.log('Oct booking beds:', JSON.stringify(beds.rows, null, 2));

  await client.end();
}
main().catch(e => console.error(e.message));
