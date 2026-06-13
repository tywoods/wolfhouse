'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');

(async () => {
  const dbUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const rows = (await pg.query(
    `SELECT booking_code, check_in::date, check_out::date, status::text, payment_status::text,
            guest_count, guest_name
     FROM bookings
     WHERE phone LIKE '%491726422307%'
     ORDER BY check_in DESC
     LIMIT 10`,
  )).rows;
  console.log(JSON.stringify(rows, null, 2));

  await pg.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
