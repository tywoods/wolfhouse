'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
(async () => {
  const db = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(
    `SELECT booking_code, status::text, payment_status::text, check_in::text, check_out::text,
            b.amount_paid_cents, b.balance_due_cents, b.confirmation_sent_at::text, b.updated_at::text
       FROM bookings b JOIN clients c ON c.id=b.client_id
      WHERE c.slug='wolfhouse-somo' AND REPLACE(COALESCE(b.phone,''),'+','')='491726422307'
        AND b.check_in='2026-07-01'
      ORDER BY b.updated_at DESC`,
  );
  console.log(JSON.stringify(r.rows, null, 2));
  await pg.end();
})();
