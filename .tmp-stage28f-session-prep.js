'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const az = (c) => execSync(c, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
const db = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
const windows = [
  ['2026-11-10', '2026-11-17', 'Nov 10-17'],
  ['2026-08-04', '2026-08-11', 'Aug 4-11'],
  ['2026-08-11', '2026-08-18', 'Aug 11-18'],
  ['2026-12-01', '2026-12-08', 'Dec 1-8'],
  ['2026-06-26', '2026-07-03', 'Jun 26-Jul 3'],
];
(async () => {
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const before = await pg.query(
    `SELECT role, is_active::text FROM staff_phone_access
      WHERE client_slug='wolfhouse-somo' AND phone_normalized='491726422307'`,
  );
  await pg.query(
    `UPDATE staff_phone_access SET is_active=false, updated_at=NOW()
      WHERE client_slug='wolfhouse-somo' AND (phone_normalized='491726422307' OR phone_e164='+491726422307')`,
  );
  const after = await pg.query(
    `SELECT role, is_active::text FROM staff_phone_access
      WHERE client_slug='wolfhouse-somo' AND phone_normalized='491726422307'`,
  );
  const allBeds = await pg.query(
    `SELECT bed_code, room_code FROM beds b
      JOIN rooms r ON r.id=b.room_id JOIN clients c ON c.id=r.client_id
     WHERE c.slug='wolfhouse-somo' AND r.room_code LIKE 'DEMO-R%' ORDER BY bed_code`,
  );
  const out = { owner: { before: before.rows[0], after: after.rows[0] }, windows: [] };
  for (const [ci, co, label] of windows) {
    const occ = await pg.query(
      `SELECT bb.bed_code, b.booking_code, b.status::text, b.phone
         FROM booking_beds bb JOIN bookings b ON b.id=bb.booking_id JOIN clients c ON c.id=b.client_id
        WHERE c.slug='wolfhouse-somo' AND bb.room_code LIKE 'DEMO-R%'
          AND LOWER(b.status::text) NOT IN ('cancelled','canceled','expired')
          AND b.check_in < $2::date AND b.check_out > $1::date
        ORDER BY bb.bed_code`,
      [ci, co],
    );
    const occSet = new Set(occ.rows.map((r) => r.bed_code));
    const free = allBeds.rows.filter((b) => !occSet.has(b.bed_code));
    out.windows.push({ label, check_in: ci, check_out: co, free_count: free.length, free_beds: free.map((f) => f.bed_code), blocks: occ.rows });
  }
  console.log(JSON.stringify(out, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
