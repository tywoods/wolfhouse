'use strict';
require('dotenv').config({ path: 'infra/.env' });
const { Client } = require('pg');

const code = process.argv[2] || 'WH-G27-4B909CD53A';

(async () => {
  const { execSync } = require('child_process');
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const b = await pg.query(
    `SELECT id, booking_code, payment_status::text, confirmation_sent_at,
            primary_room_code, guest_name, phone, email, metadata, created_at, updated_at
       FROM bookings WHERE booking_code = $1`,
    [code],
  );
  const guestMeta = b.rows[0] && b.rows[0].metadata && b.rows[0].metadata.guest;
  console.log('guest_metadata', JSON.stringify(guestMeta || null));
  console.log('booking', JSON.stringify(b.rows[0], null, 2));
  if (!b.rows[0]) {
    await pg.end();
    return;
  }
  const id = b.rows[0].id;
  const pays = await pg.query(
    `SELECT id, payment_kind::text, amount_due_cents, amount_paid_cents, status::text,
            stripe_checkout_session_id, paid_at, created_at, metadata
       FROM payments WHERE booking_id = $1 ORDER BY created_at`,
    [id],
  );
  console.log('payments', JSON.stringify(pays.rows, null, 2));
  const beds = await pg.query(`SELECT * FROM booking_beds WHERE booking_id = $1`, [id]);
  console.log('booking_beds', JSON.stringify(beds.rows, null, 2));
  const sends = await pg.query(
    `SELECT * FROM guest_message_sends
      WHERE idempotency_key LIKE $1
      ORDER BY created_at DESC LIMIT 10`,
    [`%${code}%`],
  );
  console.log('guest_sends', JSON.stringify(sends.rows, null, 2));
  const phone = b.rows[0].metadata && b.rows[0].metadata.guest && b.rows[0].metadata.guest.phone;
  if (phone) {
    const allSends = await pg.query(
      `SELECT id, idempotency_key, status, blocked_reasons, created_at, send_kind
         FROM guest_message_sends WHERE to_phone = $1 ORDER BY created_at DESC LIMIT 20`,
      [phone],
    );
    console.log('all_phone_sends', JSON.stringify(allSends.rows, null, 2));
  }
  await pg.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
