'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const az = (c) => execSync(c, { encoding: 'utf8' }).trim();
(async () => {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const code = 'WH-G27-F88DB3CBBD';
  const b = (await pg.query(
    'SELECT id::text, booking_code, status::text, payment_status::text, check_in::text, check_out::text, confirmation_sent_at FROM bookings WHERE booking_code = $1',
    [code],
  )).rows[0];
  let beds = []; let pay = null; let conv = null;
  if (b) {
    beds = (await pg.query('SELECT bed_code, room_code FROM booking_beds WHERE booking_id = $1::uuid ORDER BY bed_code', [b.id])).rows;
    pay = (await pg.query(
      'SELECT status::text, currency, amount_due_cents, stripe_checkout_session_id, checkout_url FROM payments WHERE booking_id = $1::uuid ORDER BY created_at DESC LIMIT 1',
      [b.id],
    )).rows[0];
    conv = (await pg.query('SELECT id::text, current_hold_booking_id::text FROM conversations WHERE current_hold_booking_id = $1::uuid', [b.id])).rows[0];
  }
  await pg.end();
  console.log(JSON.stringify({ booking: b, beds, payment: pay, conversation_link: conv }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
