'use strict';

const { execSync } = require('child_process');
const { Client } = require('pg');

async function main() {
  const db = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const bookingId = '4568e749-d907-45b7-ada7-1cb98ed73c09';
  const b = await pg.query(
    `SELECT id::text, booking_code, status::text, payment_status::text, package_code, updated_at::text
       FROM bookings WHERE id = $1::uuid`,
    [bookingId],
  );
  console.log('BOOKING', JSON.stringify(b.rows, null, 2));

  const table = await pg.query("SELECT to_regclass('public.booking_service_records') AS t");
  console.log('TABLE', table.rows[0]);

  const svc = await pg.query(
    `SELECT id::text, service_type, status, source, service_date::text, metadata, created_at::text
       FROM booking_service_records WHERE booking_id = $1::uuid ORDER BY created_at`,
    [bookingId],
  );
  console.log('SVC', JSON.stringify(svc.rows, null, 2));

  const recent = await pg.query(
    `SELECT b.booking_code, bsr.service_type, bsr.status, bsr.source, bsr.created_at::text
       FROM booking_service_records bsr
       JOIN bookings b ON b.id = bsr.booking_id
      WHERE bsr.created_at >= '2026-06-11T06:27:00Z'::timestamptz
      ORDER BY bsr.created_at DESC LIMIT 10`,
  );
  console.log('RECENT', JSON.stringify(recent.rows, null, 2));

  const events = await pg.query(
    `SELECT created_at::text, message_text,
            normalized->'open_demo_result'->'attached_manual_services' AS attached,
            normalized->'open_demo_result'->'booking_write' AS bw
       FROM guest_message_events
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(from_phone,''),'+','') = '491726422307'
        AND created_at >= '2026-06-11T06:27:00Z'::timestamptz
        AND message_text = 'deposit'
      ORDER BY created_at DESC LIMIT 1`,
  );
  console.log('DEPOSIT_EVENT', JSON.stringify(events.rows, null, 2));

  await pg.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
