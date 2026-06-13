'use strict';
/** Stage 28h.5 live retest inspection — temp, do not commit. */
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });

const PHONE = '+491726422307';
const CLIENT = 'wolfhouse-somo';
const DEPLOY_AT = '2026-06-10T10:20:56+00:00';
const TURN1 = 'Hello, I want to create a new booking please';
const TURN2 = 'July 1st to 5th. just me';

async function main() {
  const pg = new Client({
    connectionString: process.env.WOLFHOUSE_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await pg.connect();

  const conv = await pg.query(
    `SELECT c.id::text, c.phone, c.status, c.updated_at::text, c.metadata
       FROM conversations c
       JOIN clients cl ON cl.id = c.client_id
      WHERE cl.slug = $1 AND c.phone = $2
      ORDER BY c.updated_at DESC LIMIT 1`,
    [CLIENT, PHONE],
  );

  const msgs = await pg.query(
    `SELECT m.id::text, m.direction, m.message_text, m.created_at::text, m.whatsapp_message_id, m.metadata
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN clients cl ON cl.id = c.client_id
      WHERE cl.slug = $1 AND c.phone = $2
        AND m.created_at >= $3::timestamptz
      ORDER BY m.created_at ASC`,
    [CLIENT, PHONE, DEPLOY_AT],
  );

  const events = await pg.query(
    `SELECT g.id::text, g.message_text, g.created_at::text,
            g.normalized->'open_demo_result' AS open_demo_result,
            g.normalized->'extracted_fields' AS extracted_fields,
            g.normalized->'proposed_luna_reply' AS proposed_luna_reply
       FROM guest_message_events g
      WHERE g.client_slug = $1
        AND (g.from_phone = $2 OR g.from_phone = '491726422307')
        AND g.created_at >= $3::timestamptz
      ORDER BY g.created_at ASC`,
    [CLIENT, PHONE, DEPLOY_AT],
  );

  const bookingsAfter = await pg.query(
    `SELECT b.id::text, b.booking_code, b.status, b.check_in::text, b.check_out::text,
            b.created_at::text, b.confirmation_sent_at::text
       FROM bookings b
       JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.phone = $2 AND b.created_at >= $3::timestamptz
      ORDER BY b.created_at DESC`,
    [CLIENT, PHONE, DEPLOY_AT],
  );

  const paymentsAfter = await pg.query(
    `SELECT p.id::text, p.status, p.stripe_checkout_session_id, p.checkout_url, p.created_at::text
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.phone = $2 AND p.created_at >= $3::timestamptz`,
    [CLIENT, PHONE, DEPLOY_AT],
  );

  const allMsgs = await pg.query(
    `SELECT m.direction, m.message_text, m.created_at::text
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN clients cl ON cl.id = c.client_id
      WHERE cl.slug = $1 AND c.phone = $2
      ORDER BY m.created_at DESC LIMIT 12`,
    [CLIENT, PHONE],
  );

  const turn1Msg = allMsgs.rows.find((r) => r.message_text && r.message_text.includes('create a new booking'));
  const turn2Msg = allMsgs.rows.find((r) => r.message_text && r.message_text.includes('July 1st'));
  const turn2Event = events.rows.find((r) => r.message_text && r.message_text.includes('July 1st'));
  const turn1Event = events.rows.find((r) => r.message_text && r.message_text.includes('create a new booking'));

  const extract = (ev) => {
    if (!ev) return null;
    const odr = ev.open_demo_result || {};
    const ef = ev.extracted_fields || odr?.result?.extracted_fields || odr?.extracted_fields || {};
    const reply = ev.proposed_luna_reply || odr?.proposed_luna_reply || odr?.reply_text || null;
    return {
      check_in: ef.check_in || null,
      check_out: ef.check_out || null,
      guest_count: ef.guest_count ?? ef.guests ?? null,
      package_interest: ef.package_interest || null,
      proposed_luna_reply: typeof reply === 'string' ? reply : (reply ? JSON.stringify(reply) : null),
      missing: odr?.missing_required_fields || odr?.result?.missing_required_fields || null,
    };
  };

  console.log(JSON.stringify({
    deploy_at: DEPLOY_AT,
    post_deploy_message_count: msgs.rows.length,
    post_deploy_event_count: events.rows.length,
    conversation: conv.rows[0] ? {
      id: conv.rows[0].id,
      updated_at: conv.rows[0].updated_at,
      guest_context: conv.rows[0].metadata?.guest_context || null,
    } : null,
    turn1: {
      found_in_transcript: !!turn1Msg,
      inbound_body: turn1Msg?.message_text || null,
      extraction: extract(turn1Event),
      outbound_after: allMsgs.rows.filter((r) => r.direction === 'outbound').slice(0, 3),
    },
    turn2: {
      found_in_transcript: !!turn2Msg,
      inbound_body: turn2Msg?.message_text || null,
      extraction: extract(turn2Event),
      asks_checkout: /check-?out date/i.test(extract(turn2Event)?.proposed_luna_reply || ''),
      asks_package: /malibu|uluwatu|waimea|package/i.test(extract(turn2Event)?.proposed_luna_reply || ''),
    },
    post_deploy_messages: msgs.rows,
    post_deploy_events: events.rows.map((r) => ({
      message_text: r.message_text,
      created_at: r.created_at,
      ...extract(r),
    })),
    recent_transcript: allMsgs.rows.reverse(),
    bookings_after_deploy: bookingsAfter.rows,
    payments_after_deploy: paymentsAfter.rows,
    ready_for_retest: msgs.rows.length === 0,
  }, null, 2));

  await pg.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
