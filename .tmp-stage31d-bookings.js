'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
(async () => {
  const db = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const since = '2026-06-10T21:04:00Z';
  const bookings = (await pg.query(
    `SELECT b.booking_code, b.package_code, b.check_in::text, b.check_out::text, b.guest_count,
            b.status::text, b.payment_status::text, b.created_at::text,
            p.id::text as payment_id, p.stripe_checkout_session_id
       FROM bookings b JOIN clients c ON c.id = b.client_id
       LEFT JOIN LATERAL (
         SELECT id, stripe_checkout_session_id, checkout_url FROM payments WHERE booking_id = b.id ORDER BY created_at DESC LIMIT 1
       ) p ON true
      WHERE c.slug='wolfhouse-somo' AND REPLACE(COALESCE(b.phone,''),'+','')='491726422307'
        AND b.created_at >= $1::timestamptz ORDER BY b.created_at`,
    [since],
  )).rows;
  const beds = (await pg.query(
    `SELECT bb.booking_id::text, bb.bed_code, bb.assignment_start_date::text, bb.assignment_end_date::text
       FROM booking_beds bb JOIN bookings b ON b.id = bb.booking_id JOIN clients c ON c.id = b.client_id
      WHERE c.slug='wolfhouse-somo' AND REPLACE(COALESCE(b.phone,''),'+','')='491726422307'
        AND b.created_at >= $1::timestamptz`,
    [since],
  )).rows;
  console.log(JSON.stringify({ bookings, beds }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
