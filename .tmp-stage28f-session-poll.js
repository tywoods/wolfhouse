'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const PHONE = '+491726422307';
const RAW = '491726422307';
const az = (c) => execSync(c, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
const since = process.env.SINCE || null; // ISO timestamp optional
(async () => {
  const db = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const owner = await pg.query(
    `SELECT role, is_active::text FROM staff_phone_access WHERE client_slug='wolfhouse-somo' AND phone_normalized=$1`,
    [RAW],
  );
  const events = await pg.query(
    `SELECT gme.id::text, gme.created_at::text, gme.direction, gme.normalized->'open_demo_result' AS open_demo_result,
            LEFT(gme.message_text, 120) AS message_snippet
       FROM guest_message_events gme
      WHERE gme.client_slug='wolfhouse-somo'
        AND (REPLACE(COALESCE(gme.from_phone,''),'+','') = $1 OR gme.from_phone IN ($2,$3))
        ${since ? 'AND gme.created_at >= $4::timestamptz' : ''}
      ORDER BY gme.created_at DESC
      LIMIT 15`,
    since ? [RAW, PHONE, RAW, since] : [RAW, PHONE, RAW],
  );
  const bookings = await pg.query(
    `SELECT b.booking_code, b.id::text AS booking_id, b.status::text, b.payment_status::text,
            b.check_in::text, b.check_out::text, b.created_at::text
       FROM bookings b JOIN clients c ON c.id=b.client_id
      WHERE c.slug='wolfhouse-somo' AND b.phone IN ($1,$2,$3)
      ORDER BY b.created_at DESC LIMIT 3`,
    [PHONE, RAW, PHONE],
  );
  const latest = bookings.rows[0];
  let beds = [];
  let payments = [];
  if (latest) {
    beds = (await pg.query('SELECT bed_code, room_code FROM booking_beds WHERE booking_id=$1::uuid', [latest.booking_id])).rows;
    payments = (await pg.query('SELECT id::text, status::text FROM payments WHERE booking_id=$1::uuid ORDER BY created_at', [latest.booking_id])).rows;
  }
  const sends = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE to_phone IN ($1,$2) AND status='sent'`,
    [PHONE, RAW],
  );
  console.log(JSON.stringify({
    owner: owner.rows[0],
    event_count: events.rows.length,
    events: events.rows,
    latest_booking: latest ? { ...latest, beds, payments } : null,
    guest_message_sends: sends.rows[0].n,
  }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
