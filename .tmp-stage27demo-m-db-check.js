'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');

(async () => {
  const dbUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const b = (await pg.query(`
    SELECT id::text, booking_code, status::text, payment_status::text,
           hold_expires_at::text, check_in::text, check_out::text
      FROM bookings WHERE booking_code = 'WH-G27-0ECC1D9B57'`)).rows[0];
  const p = (await pg.query(`
    SELECT p.id::text, p.status::text, p.checkout_url, p.stripe_checkout_session_id, p.amount_paid_cents
      FROM payments p INNER JOIN bookings b ON b.id = p.booking_id
     WHERE b.booking_code = 'WH-G27-0ECC1D9B57' ORDER BY p.created_at`)).rows;
  console.log(JSON.stringify({ booking: b, payments: p }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
