'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');

const phone = '+491726422307';

(async () => {
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const bk = await pg.query(
    `SELECT id::text AS id, booking_code, status::text, payment_status::text,
            check_in::text, check_out::text, metadata
       FROM bookings WHERE phone = $1 ORDER BY updated_at DESC LIMIT 3`,
    [phone],
  );
  console.log('bookings:', JSON.stringify(bk.rows, null, 2));
  if (bk.rows[0]) {
    const id = bk.rows[0].id;
    const svc = await pg.query(
      `SELECT service_type, service_date::text, status, source
         FROM booking_service_records WHERE booking_id = $1::uuid ORDER BY created_at DESC`,
      [id],
    );
    const tr = await pg.query(
      `SELECT direction, scheduled_at, notes FROM booking_transfers WHERE booking_id = $1::uuid`,
      [id],
    );
    console.log('services:', svc.rows);
    console.log('transfers:', tr.rows);
    console.log('luna_notes:', bk.rows[0].metadata && bk.rows[0].metadata.luna_guest_notes);
  }
  const conv = await pg.query(
    `SELECT id::text, needs_human, bot_mode FROM conversations WHERE guest_phone = $1 ORDER BY updated_at DESC LIMIT 1`,
    [phone],
  );
  console.log('conv:', conv.rows[0]);
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
