'use strict';
const { Client } = require('pg');
async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  // 1. Booking detail
  const b = await c.query(`SELECT * FROM bookings WHERE booking_code = 'WH-G27-4B909CD53A'`);
  console.log('BOOKING:', JSON.stringify(b.rows[0], null, 2));

  const bookingId = b.rows[0] && b.rows[0].id;
  if (!bookingId) { await c.end(); return; }

  // 2. Calendar (find table name)
  const tables = await c.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name ILIKE '%calendar%' OR table_name ILIKE '%booking%' OR table_name ILIKE '%bed%'
    ORDER BY table_name`);
  console.log('TABLES:', tables.rows.map(r => r.table_name));

  // 3. Beds/room assignment
  const beds = await c.query(`
    SELECT * FROM booking_beds WHERE booking_id = $1`, [bookingId]).catch(() => ({ rows: [] }));
  console.log('BOOKING_BEDS:', JSON.stringify(beds.rows, null, 2));

  // 4. Stripe event: why unpaid?
  const p = await c.query(`
    SELECT id, amount_paid_cents, status,
           metadata->>'stripe_payment_status' as stripe_payment_status,
           metadata->>'stripe_event_type' as event_type,
           metadata->>'is_payment_truth' as is_payment_truth
    FROM payments WHERE booking_id = $1 ORDER BY created_at`, [bookingId]);
  console.log('PAYMENTS SUMMARY:', JSON.stringify(p.rows, null, 2));

  // 5. Check Stripe checkout URL stored in metadata
  const checkout = await c.query(`
    SELECT metadata->>'stripe_checkout_url' as checkout_url,
           metadata->>'stripe_session_id' as session_id
    FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1`, [bookingId]).catch(() => ({ rows: [] }));
  console.log('CHECKOUT URL:', JSON.stringify(checkout.rows, null, 2));

  await c.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
