'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const whUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
(async () => {
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(`
    WITH params AS (SELECT '2026-09-24'::date AS ci, '2026-09-27'::date AS co, 2 AS gc)
    SELECT bd.bed_code, r.room_code
      FROM beds bd
      INNER JOIN rooms r ON r.id = bd.room_id
      INNER JOIN clients c ON c.id = r.client_id
     WHERE c.slug = 'wolfhouse-somo' AND bd.active = true AND bd.sellable = true
     ORDER BY bd.bed_code LIMIT 20`);
  const wolf = await pg.query(`SELECT booking_code, check_in, check_out, guest_count, status::text FROM bookings WHERE booking_code LIKE 'MB-WOLFHO-20260924%'`);
  console.log(JSON.stringify({ sample_beds: r.rows, wolf_booking: wolf.rows }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
