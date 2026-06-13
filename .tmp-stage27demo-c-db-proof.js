'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const PROOF_START = '2026-06-09T19:55:00.000Z';
const PHONE = '+491726422307';
const dbUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
(async () => {
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const sends = await pg.query(`
    SELECT id::text, status, send_kind, to_phone, idempotency_key,
           provider_message_id, LEFT(message_text, 120) AS excerpt, created_at
      FROM guest_message_sends
     WHERE client_slug = 'wolfhouse-somo' AND to_phone = $1
       AND created_at >= $2::timestamptz
     ORDER BY created_at DESC`, [PHONE, PROOF_START]);
  const bookings = await pg.query(`
    SELECT COUNT(*)::int AS n FROM bookings b
     INNER JOIN clients cl ON cl.id = b.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND b.phone = $1
       AND b.created_at >= $2::timestamptz`, [PHONE, PROOF_START]);
  const payments = await pg.query(`
    SELECT COUNT(*)::int AS n FROM payments p
     INNER JOIN bookings b ON b.id = p.booking_id
     INNER JOIN clients cl ON cl.id = b.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND b.phone = $1
       AND p.created_at >= $2::timestamptz`, [PHONE, PROOF_START]);
  const stripe = await pg.query(`
    SELECT COUNT(*)::int AS n FROM payments
     WHERE stripe_checkout_session_id IS NOT NULL
       AND created_at >= $2::timestamptz`, [PHONE, PROOF_START]).catch(() => ({ rows: [{ n: -1 }] }));
  console.log(JSON.stringify({
    guest_message_sends: sends.rows,
    bookings_created: bookings.rows[0].n,
    payments_created: payments.rows[0].n,
  }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
