'use strict';
/** Stage 28h.6 manual smoke — temp, do not commit. */
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });
const { resetLunaConversationContext } = require('./scripts/lib/staff-conversation-writes');

const CLIENT = 'wolfhouse-somo';
const PHONE = '+491726422307';
const CONV_ID = '7361e380-1074-4441-a9e1-f92c127a4e76';
const BOOKING_CODE = 'WH-G27-3888294D42';

async function main() {
  const pg = new Client({ connectionString: process.env.WOLFHOUSE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const beforeMeta = await pg.query(
    `SELECT metadata FROM conversations WHERE id = $1::uuid`, [CONV_ID],
  );
  const beforeMsgs = await pg.query(
    `SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1::uuid`, [CONV_ID],
  );
  const beforeEvents = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_events WHERE client_slug = $1 AND from_phone IN ($2, '491726422307')`,
    [CLIENT, PHONE],
  );
  const beforeBooking = await pg.query(
    `SELECT booking_code, status, payment_status FROM bookings WHERE booking_code = $1`, [BOOKING_CODE],
  );
  const beforePayments = await pg.query(
    `SELECT COUNT(*)::int AS n FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.booking_code = $1`,
    [BOOKING_CODE],
  );

  const result = await resetLunaConversationContext(pg, CLIENT, CONV_ID);

  const afterMeta = await pg.query(`SELECT metadata FROM conversations WHERE id = $1::uuid`, [CONV_ID]);
  const afterMsgs = await pg.query(
    `SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1::uuid`, [CONV_ID],
  );
  const afterEvents = await pg.query(
    `SELECT COUNT(*)::int AS n FROM guest_message_events WHERE client_slug = $1 AND from_phone IN ($2, '491726422307')`,
    [CLIENT, PHONE],
  );
  const afterBooking = await pg.query(
    `SELECT booking_code, status, payment_status FROM bookings WHERE booking_code = $1`, [BOOKING_CODE],
  );

  const meta = afterMeta.rows[0]?.metadata || {};
  console.log(JSON.stringify({
    reset_result: result,
    messages_before: beforeMsgs.rows[0].n,
    messages_after: afterMsgs.rows[0].n,
    events_before: beforeEvents.rows[0].n,
    events_after: afterEvents.rows[0].n,
    had_luna_context_before: !!(beforeMeta.rows[0]?.metadata?.luna_guest_context || beforeMeta.rows[0]?.metadata?.luna_inbound_reviews),
    luna_guest_context_after: meta.luna_guest_context || null,
    luna_inbound_reviews_after: meta.luna_inbound_reviews || null,
    booking_before: beforeBooking.rows[0] || null,
    booking_after: afterBooking.rows[0] || null,
    payments_before: beforePayments.rows[0].n,
    pass: afterMsgs.rows[0].n === beforeMsgs.rows[0].n
      && afterEvents.rows[0].n === beforeEvents.rows[0].n
      && !meta.luna_guest_context
      && !meta.luna_inbound_reviews
      && afterBooking.rows[0]?.booking_code === BOOKING_CODE,
  }, null, 2));

  await pg.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
