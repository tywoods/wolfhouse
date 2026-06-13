'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const az = (c) => execSync(c, { encoding: 'utf8' }).trim();

(async () => {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const holds = await pg.query(`
    SELECT b.booking_code, b.status::text, b.check_in::text, b.check_out::text, b.created_at::text
      FROM bookings b JOIN clients cl ON cl.id=b.client_id
     WHERE cl.slug='wolfhouse-somo' AND b.phone IN ('+491726422307','491726422307')
       AND b.check_in='2026-07-24'::date
     ORDER BY b.created_at DESC`);
  const since = '2026-06-10T08:09:43.184Z';
  const recent = await pg.query(`
    SELECT b.booking_code, b.status::text, b.check_in::text, b.created_at::text
      FROM bookings b JOIN clients cl ON cl.id=b.client_id
     WHERE cl.slug='wolfhouse-somo' AND b.phone IN ('+491726422307','491726422307')
       AND b.created_at >= $1::timestamptz ORDER BY b.created_at DESC`, [since]);
  console.log(JSON.stringify({ july_holds: holds.rows, proof_window_bookings: recent.rows }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
