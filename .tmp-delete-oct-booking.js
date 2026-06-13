'use strict';
const { Client } = require('pg');
const OCT_BOOKING_ID = '946cc3ba-70e9-4f9f-a6b8-140ca3d22a79';
const client = new Client({ connectionString: process.env.DB_URL });
async function main() {
  await client.connect();
  await client.query('BEGIN');
  try {
    const chk = await client.query(
      `SELECT booking_code, check_in, check_out, status::text, guest_name
         FROM bookings WHERE id = $1::uuid`, [OCT_BOOKING_ID]
    );
    if (!chk.rows.length) { console.log('Booking not found'); await client.query('ROLLBACK'); return; }
    console.log('Deleting:', chk.rows[0]);

    const delSvc = await client.query(
      `DELETE FROM booking_service_records WHERE booking_id = $1::uuid`, [OCT_BOOKING_ID]
    );
    console.log('Deleted service records:', delSvc.rowCount);

    const delBeds = await client.query(
      `DELETE FROM booking_beds WHERE booking_id = $1::uuid`, [OCT_BOOKING_ID]
    );
    console.log('Deleted booking_beds:', delBeds.rowCount);

    const delPmt = await client.query(
      `DELETE FROM payments WHERE booking_id = $1::uuid`, [OCT_BOOKING_ID]
    );
    console.log('Deleted payments:', delPmt.rowCount);

    const delBk = await client.query(
      `DELETE FROM bookings WHERE id = $1::uuid RETURNING booking_code`, [OCT_BOOKING_ID]
    );
    console.log('Deleted booking:', delBk.rows[0]?.booking_code);

    await client.query('COMMIT');
    console.log('Done.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  await client.end();
}
main().catch(e => console.error(e.message));
