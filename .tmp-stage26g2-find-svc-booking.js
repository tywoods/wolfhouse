'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const db = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
(async () => {
  const c = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.check_in::text, b.check_out::text,
           COUNT(sr.id)::int AS svc_count,
           COUNT(sr.id) FILTER (WHERE sr.service_date IS NOT NULL)::int AS dated_count,
           COUNT(sr.id) FILTER (WHERE sr.service_date IS NULL)::int AS undated_count
    FROM booking_service_records sr
    INNER JOIN bookings b ON (sr.booking_id = b.id OR (sr.booking_id IS NULL AND sr.booking_code = b.booking_code))
    INNER JOIN clients cl ON cl.id = b.client_id
    WHERE sr.client_slug = 'wolfhouse-somo'
    GROUP BY b.id, b.booking_code, b.check_in, b.check_out
    HAVING COUNT(sr.id) > 0
    ORDER BY COUNT(sr.id) DESC
    LIMIT 8`);
  console.log(JSON.stringify(r.rows, null, 2));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
