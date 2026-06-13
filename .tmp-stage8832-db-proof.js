'use strict';
const { Client } = require('pg');

const BOOKING_CODE = 'MB-WOLFHO-20260901-cb4799';
const BOOKING_ID = 'e15b7554-c766-4357-beb3-d23262e3b7b8';
const SERVICE_DATE = '2026-09-04';
const IDEMPOTENCY_KEY = 'MB-WOLFHO-20260901-cb4799-wetsuit-2026-09-04-1-34999000123';

(async () => {
  const c = new Client({
    connectionString: process.env.WOLFHOUSE_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const booking = await c.query(
    'SELECT payment_status, amount_paid_cents, balance_due_cents, confirmation_sent_at FROM bookings WHERE booking_code = $1',
    [BOOKING_CODE],
  );

  const svc = await c.query(
    `SELECT id, service_type, service_date, source, payment_status, amount_paid_cents, payment_id, metadata, created_at
       FROM booking_service_records
      WHERE booking_id = $1 AND service_type = 'wetsuit' AND service_date = $2::date AND source = 'luna_guest'
      ORDER BY created_at DESC`,
    [BOOKING_ID, SERVICE_DATE],
  );

  let payment = null;
  if (svc.rows[0]?.payment_id) {
    const pr = await c.query(
      'SELECT id, status, payment_kind, checkout_url, stripe_checkout_session_id FROM payments WHERE id = $1',
      [svc.rows[0].payment_id],
    );
    payment = pr.rows[0];
  }

  const byKey = await c.query(
    `SELECT COUNT(*)::int AS n FROM booking_service_records
      WHERE booking_id = $1 AND metadata->>'idempotency_key' = $2`,
    [BOOKING_ID, IDEMPOTENCY_KEY],
  );

  console.log(JSON.stringify({
    booking: booking.rows[0],
    service_rows: svc.rows,
    service_count_for_date: svc.rows.length,
    payment,
    idempotency_key_rows: byKey.rows[0].n,
    idempotency_key: IDEMPOTENCY_KEY,
  }, null, 2));

  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
