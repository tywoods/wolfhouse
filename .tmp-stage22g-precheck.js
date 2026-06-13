'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const PAY = 'd0bb5fa9-7ecc-43b2-b0d9-181b5687ae0a';
const BK = '946cc3ba-70e9-4f9f-a6b8-140ca3d22a79';
(async () => {
  const url = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const p = await pg.query('SELECT status::text, amount_due_cents, amount_paid_cents, stripe_checkout_session_id, checkout_url IS NOT NULL AS has_url, paid_at FROM payments WHERE id=$1::uuid', [PAY]);
  const b = await pg.query('SELECT payment_status::text, amount_paid_cents, balance_due_cents, total_amount_cents, deposit_required_cents, confirmation_sent_at FROM bookings WHERE id=$1::uuid', [BK]);
  const ev = await pg.query('SELECT COUNT(*)::int c FROM guest_message_events');
  await pg.end();
  console.log(JSON.stringify({ payment: p.rows[0], booking: b.rows[0], guest_message_events_count: ev.rows[0].c }, null, 2));
})();
