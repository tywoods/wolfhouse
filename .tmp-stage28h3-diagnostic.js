'use strict';

const { Client } = require('pg');
const { execSync } = require('child_process');

const PHONE = '491726422307';

async function main() {
  const db = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const events = await pg.query(
    `SELECT id::text, created_at::text, message_text, wa_message_id, suggested_reply, next_action, send_status,
            normalized->'open_demo_result' AS open_demo_result
       FROM guest_message_events
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(from_phone, ''), '+', '') = $1
        AND created_at >= '2026-06-10T10:00:00+00:00'::timestamptz
      ORDER BY created_at ASC`,
    [PHONE],
  );

  const sends = await pg.query(
    `SELECT id::text, status, message_text, provider_message_id, created_at::text
       FROM guest_message_sends
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(to_phone, ''), '+', '') = $1
        AND created_at >= '2026-06-10T10:00:00+00:00'::timestamptz
      ORDER BY created_at ASC`,
    [PHONE],
  );

  const conv = await pg.query(
    `SELECT conv.id::text, conv.last_message_preview, conv.staff_reply_draft,
            conv.metadata->'luna_guest_context' AS luna_guest_context,
            conv.updated_at::text
       FROM conversations conv JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(conv.phone, ''), '+', '') = $1`,
    [PHONE],
  );

  let messages = [];
  if (conv.rows[0]) {
    const m = await pg.query(
      `SELECT direction::text, message_text, source, created_at::text
         FROM messages WHERE conversation_id = $1::uuid
         ORDER BY created_at ASC`,
      [conv.rows[0].id],
    );
    messages = m.rows;
  }

  const bookings = await pg.query(
    `SELECT b.booking_code, b.status, b.payment_status, b.check_in::text, b.check_out::text, b.created_at::text
       FROM bookings b JOIN clients c ON c.id = b.client_id
      WHERE c.slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(b.phone, ''), '+', '') = $1
        AND b.created_at >= '2026-06-10T10:00:00+00:00'::timestamptz
      ORDER BY b.created_at ASC`,
    [PHONE],
  );

  const julyHold = await pg.query(
    `SELECT b.booking_code, b.status, b.payment_status, b.check_in::text, b.check_out::text,
            bb.bed_code, bb.assignment_start_date::text, bb.assignment_end_date::text
       FROM bookings b
       JOIN clients c ON c.id = b.client_id
       LEFT JOIN booking_beds bb ON bb.booking_id = b.id
      WHERE c.slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(b.phone, ''), '+', '') = $1
        AND b.check_in = '2026-07-10'::date AND b.check_out = '2026-07-17'::date
      ORDER BY b.created_at DESC
      LIMIT 5`,
    [PHONE],
  );

  const payments = await pg.query(
    `SELECT p.id::text, p.status, p.stripe_checkout_session_id, p.created_at::text, b.booking_code
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN clients c ON c.id = b.client_id
      WHERE c.slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(b.phone, ''), '+', '') = $1
        AND p.created_at >= '2026-06-10T10:00:00+00:00'::timestamptz`,
    [PHONE],
  );

  console.log(JSON.stringify({
    events: events.rows,
    sends: sends.rows,
    conversation: conv.rows[0],
    messages,
    bookings_since_session: bookings.rows,
    july_10_17_bookings: julyHold.rows,
    payments_since_session: payments.rows,
  }, null, 2));

  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
