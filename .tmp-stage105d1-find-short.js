'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
(async () => {
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' }
  ).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(`
    SELECT b.booking_code, b.package_code, b.guest_count,
           b.check_in::text, b.check_out::text,
           (b.check_out::date - b.check_in::date) AS nights,
           COUNT(bb.id)::int AS beds
    FROM bookings b
    JOIN clients c ON c.id = b.client_id
    LEFT JOIN booking_beds bb ON bb.booking_id = b.id
    WHERE c.slug = 'wolfhouse-somo'
      AND (b.package_code IS NULL OR TRIM(b.package_code) = '')
      AND (b.check_out::date - b.check_in::date) < 6
    GROUP BY b.id, b.booking_code, b.package_code, b.guest_count, b.check_in, b.check_out
    HAVING COUNT(bb.id) >= 1
    ORDER BY beds DESC, nights
    LIMIT 10
  `);
  console.log(r.rows);
  await pg.end();
})();
