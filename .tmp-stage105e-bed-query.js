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
    SELECT b.booking_code, bb.bed_code, bb.assignment_start_date::text AS ci, bb.assignment_end_date::text AS co
    FROM booking_beds bb
    JOIN bookings b ON b.id = bb.booking_id
    JOIN clients c ON c.id = bb.client_id
    WHERE c.slug = 'wolfhouse-somo' AND bb.bed_code = 'DEMO-R1-B1'
    ORDER BY bb.assignment_start_date
  `);
  console.log(r.rows);
  await pg.end();
})();
