'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const url = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
(async () => {
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(`
    SELECT b.booking_code, b.status::text, b.check_in::text AS ci, b.check_out::text AS co,
           COUNT(bb.id)::int AS n, MIN(bb.bed_code) AS bed
    FROM bookings b
    JOIN clients c ON c.id = b.client_id
    LEFT JOIN booking_beds bb ON bb.booking_id = b.id
    WHERE c.slug = 'wolfhouse-somo'
      AND (b.guest_name ILIKE 'Stage106a%' OR b.booking_code LIKE 'MB-WOLFHO-2026%')
    GROUP BY b.id, b.booking_code, b.status, b.check_in, b.check_out
    ORDER BY b.created_at DESC LIMIT 15`);
  console.log(JSON.stringify(r.rows, null, 2));
  await pg.end();
})();
