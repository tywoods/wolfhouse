'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
(async () => {
  const db = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const phone = '491726422307';
  const b = await pg.query(
    `SELECT b.id::text, b.booking_code, b.payment_status::text, b.amount_paid_cents,
            b.balance_due_cents, b.confirmation_sent_at::text, b.created_at::text
       FROM bookings b JOIN clients c ON c.id = b.client_id
      WHERE c.slug = 'wolfhouse-somo' AND REPLACE(COALESCE(b.phone,''),'+','') = $1
      ORDER BY b.updated_at DESC LIMIT 3`, [phone],
  );
  const p = await pg.query(
    `SELECT p.id::text, p.status::text, p.amount_due_cents, p.amount_paid_cents,
            p.stripe_checkout_session_id, p.checkout_url
       FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN clients c ON c.id = b.client_id
      WHERE c.slug = 'wolfhouse-somo' AND REPLACE(COALESCE(b.phone,''),'+','') = $1
      ORDER BY p.created_at DESC LIMIT 3`, [phone],
  );
  const beds = await pg.query(
    `SELECT bb.bed_code, bb.room_code, r.name AS room_name
       FROM booking_beds bb
       JOIN bookings b ON b.id = bb.booking_id
       JOIN clients c ON c.id = b.client_id
       JOIN beds bd ON bd.id = bb.bed_id
       JOIN rooms r ON r.id = bd.room_id
      WHERE c.slug = 'wolfhouse-somo' AND REPLACE(COALESCE(b.phone,''),'+','') = $1`, [phone],
  );
  const sends = await pg.query(
    `SELECT id::text, status, send_kind, provider_message_id, LEFT(message_text,120) AS excerpt, created_at::text
       FROM guest_message_sends
      WHERE client_slug = 'wolfhouse-somo' AND REPLACE(COALESCE(to_phone,''),'+','') = $1
      ORDER BY created_at DESC LIMIT 10`, [phone],
  );
  console.log(JSON.stringify({ bookings: b.rows, payments: p.rows, beds: beds.rows, sends: sends.rows }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
