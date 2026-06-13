'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const url = execSync(
  'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
  { encoding: 'utf8' }
).trim();
(async () => {
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(`
    SELECT b.booking_code, b.status::text, b.check_in::text, b.check_out::text, bb.bed_code
    FROM bookings b
    JOIN clients c ON c.id = b.client_id
    LEFT JOIN booking_beds bb ON bb.booking_id = b.id
    WHERE c.slug = 'wolfhouse-somo'
      AND (b.booking_code LIKE 'MB-WOLFHO%' OR b.guest_name ILIKE '%stage106a%')
    ORDER BY b.created_at DESC
    LIMIT 20
  `);
  console.log(JSON.stringify(r.rows, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
