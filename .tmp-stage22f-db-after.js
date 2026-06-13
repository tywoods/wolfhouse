'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
(async () => {
  const url = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const p = await pg.query('SELECT status::text, amount_due_cents, amount_paid_cents, checkout_url IS NOT NULL AS has_url, stripe_checkout_session_id IS NOT NULL AS has_sid, paid_at FROM payments WHERE id=$1::uuid', ['d0bb5fa9-7ecc-43b2-b0d9-181b5687ae0a']);
  const b = await pg.query('SELECT confirmation_sent_at, metadata->>\'idempotency_key\' AS idem FROM bookings WHERE id=$1::uuid', ['946cc3ba-70e9-4f9f-a6b8-140ca3d22a79']);
  const pc = await pg.query('SELECT COUNT(*)::int c FROM payments WHERE booking_id=$1::uuid', ['946cc3ba-70e9-4f9f-a6b8-140ca3d22a79']);
  await pg.end();
  console.log(JSON.stringify({ payment: p.rows[0], booking: b.rows[0], payment_count: pc.rows[0].c }, null, 2));
})();
