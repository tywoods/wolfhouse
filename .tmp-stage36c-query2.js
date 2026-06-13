'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const db = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
(async () => {
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const recent = await pg.query(`
    SELECT b.booking_code, b.status::text, b.check_in::text, b.check_out::text, b.phone, b.created_at::text
      FROM bookings b JOIN clients c ON c.id = b.client_id
     WHERE c.slug = 'wolfhouse-somo'
       AND b.created_at >= '2026-06-11T08:00:00Z'
     ORDER BY b.created_at DESC LIMIT 10`);
  const july = await pg.query(`
    SELECT b.booking_code, b.status::text, b.check_in::text, b.check_out::text, b.phone, b.created_at::text
      FROM bookings b JOIN clients c ON c.id = b.client_id
     WHERE c.slug = 'wolfhouse-somo'
       AND b.check_in = '2026-07-01' AND b.check_out = '2026-07-05'
     ORDER BY b.created_at DESC LIMIT 5`);
  const pay = await pg.query(`
    SELECT p.id::text, p.status, p.checkout_url, p.created_at::text, b.booking_code
      FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN clients c ON c.id = b.client_id
     WHERE c.slug = 'wolfhouse-somo' AND p.created_at >= '2026-06-11T08:00:00Z'
     ORDER BY p.created_at DESC LIMIT 5`);
  const sends = await pg.query(`
    SELECT message_text, send_kind, created_at::text FROM guest_message_sends
     WHERE client_slug = 'wolfhouse-somo' AND created_at >= '2026-06-11T08:09:00Z'
       AND REPLACE(COALESCE(to_phone,''),'+','') = '491726422307'
     ORDER BY created_at ASC`);
  console.log(JSON.stringify({ recent: recent.rows, july: july.rows, payments: pay.rows, send_count: sends.rows.length, last_send: sends.rows[sends.rows.length - 1] }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
