'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const db = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
(async () => {
  const c = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(`
    SELECT service_type, service_date::text, payment_status, status
    FROM booking_service_records sr
    INNER JOIN bookings b ON b.booking_code = 'MB-WOLFHO-20260920-4f62e2'
    WHERE sr.client_slug = 'wolfhouse-somo'
      AND (sr.booking_id = b.id OR sr.booking_code = b.booking_code)
    ORDER BY service_date NULLS LAST, service_type`);
  console.log(JSON.stringify(r.rows, null, 2));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
