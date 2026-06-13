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
  const mb = await pg.query(`
    SELECT bb.bed_code, b.check_in::text AS ci, b.check_out::text AS co
    FROM booking_beds bb
    JOIN bookings b ON b.id = bb.booking_id
    JOIN clients c ON c.id = b.client_id
    WHERE c.slug = 'wolfhouse-somo' AND b.booking_code = 'MB-WOLFHO-20260920-4f62e2'
  `);
  console.log('MB', mb.rows);
  const bed = mb.rows[0] && mb.rows[0].bed_code;
  const ov = await pg.query(`
    SELECT b.booking_code, bb.bed_code, b.check_in::text AS ci, b.check_out::text AS co
    FROM booking_beds bb
    JOIN bookings b ON b.id = bb.booking_id
    JOIN clients c ON c.id = b.client_id
    WHERE c.slug = 'wolfhouse-somo' AND bb.bed_code = $1
      AND b.booking_code <> 'MB-WOLFHO-20260920-4f62e2'
      AND b.status NOT IN ('cancelled', 'expired')
      AND bb.assignment_start_date < '2026-09-28'::date
      AND bb.assignment_end_date > '2026-09-25'::date
    LIMIT 10
  `, [bed]);
  console.log('overlaps', ov.rows);
  const demo = await pg.query(`
    SELECT b.booking_code, b.guest_count, b.status,
           (SELECT COUNT(*)::int FROM booking_beds bb WHERE bb.booking_id=b.id) AS beds
    FROM bookings b JOIN clients c ON c.id=b.client_id
    WHERE c.slug='wolfhouse-somo' AND b.booking_code='DEMO-2603'
  `);
  console.log('DEMO', demo.rows);
  const sep = await pg.query(`
    SELECT b.booking_code, b.check_in::text AS ci, b.check_out::text AS co
    FROM booking_beds bb
    JOIN bookings b ON b.id = bb.booking_id
    JOIN clients c ON c.id = b.client_id
    WHERE c.slug = 'wolfhouse-somo' AND bb.bed_code = 'DEMO-R1-B1'
      AND b.status NOT IN ('cancelled', 'expired')
      AND b.check_in >= '2026-09-01' AND b.check_in < '2026-10-01'
    ORDER BY b.check_in
  `);
  console.log('sep R1-B1', sep.rows);
  await pg.end();
})();
