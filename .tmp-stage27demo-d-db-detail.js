'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const id = 'a3bdf2bf-3b00-4127-b4c2-587543163f89';

(async () => {
  const u = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: u, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const bb = await pg.query(
    'SELECT id::text, room_code, bed_code, assignment_start_date::text, assignment_end_date::text FROM booking_beds WHERE booking_id = $1::uuid',
    [id],
  );
  let qs = { rows: [] };
  try {
    qs = await pg.query(
      'SELECT id::text, created_at FROM quote_snapshots WHERE booking_id = $1::uuid ORDER BY created_at DESC LIMIT 1',
      [id],
    );
  } catch (e) {
    qs = { err: e.message };
  }
  console.log(JSON.stringify({ booking_beds: bb.rows, quote_snapshots: qs.rows || qs }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
