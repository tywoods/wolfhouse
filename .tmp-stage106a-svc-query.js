'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const dbUrl = execSync(
  'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
  { encoding: 'utf8' }
).trim();
(async () => {
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(`
    SELECT id::text, service_type, quantity, amount_due_cents, status, payment_status,
           metadata->>'idempotency_key' AS idem,
           metadata->>'staff_ui_service_type' AS ui,
           metadata->>'board_variant' AS bv
    FROM booking_service_records
    WHERE client_slug = 'wolfhouse-somo' AND booking_code = 'MB-WOLFHO-20260920-4f62e2'
    ORDER BY created_at`);
  console.log(JSON.stringify(r.rows, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
