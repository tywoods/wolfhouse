'use strict';
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, 'infra', '.env') });

const CLIENT = 'wolfhouse-somo';
const PHONE = '+491726422307';
const PHRASES = ['Hello', 'Yes I want to book', 'July 1-5', 'July 1', '\n1\n', ' guest_count'];

async function main() {
  const pg = new Client({ connectionString: process.env.WOLFHOUSE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const conv = await pg.query(
    `SELECT id::text, phone, metadata, updated_at::text FROM conversations c
      JOIN clients cl ON cl.id = c.client_id WHERE cl.slug = $1 AND c.phone = $2`,
    [CLIENT, PHONE],
  );

  const msgs = await pg.query(
    `SELECT direction, message_text, created_at::text, metadata FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $1 AND c.phone = $2 ORDER BY m.created_at DESC LIMIT 20`,
    [CLIENT, PHONE],
  );

  const events = await pg.query(
    `SELECT message_text, created_at::text,
            normalized->'open_demo_result' AS open_demo_result,
            normalized->'review' AS review,
            next_action, suggested_reply, handoff_required
       FROM guest_message_events
      WHERE client_slug = $1 AND from_phone IN ($2, '491726422307')
      ORDER BY created_at DESC LIMIT 12`,
    [CLIENT, PHONE],
  );

  const sends = await pg.query(
    `SELECT to_phone, body_preview, created_at::text, status FROM guest_message_sends
      WHERE client_slug = $1 AND to_phone LIKE '%491726422307%' ORDER BY created_at DESC LIMIT 8`,
    [CLIENT],
  );

  const summarize = (ev) => {
    const odr = ev.open_demo_result || {};
    const rev = ev.review || odr.review || {};
    const r = rev.result || odr.result || {};
    const ef = r.extracted_fields || rev.extracted_fields || odr.extracted_fields || {};
    return {
      message_text: ev.message_text,
      created_at: ev.created_at,
      message_lane: r.message_lane || rev.message_lane,
      intake_state: r.intake_state || rev.intake_state,
      extracted_fields: ef,
      missing_required_fields: r.missing_required_fields || rev.missing_required_fields || odr.missing_required_fields,
      proposed_next_action: rev.proposed_next_action || odr.proposed_next_action || ev.next_action,
      proposed_luna_reply: (rev.proposed_luna_reply || odr.proposed_luna_reply || ev.suggested_reply || '').slice(0, 200),
      handoff_required: ev.handoff_required,
      safe_handoff: r.safe_handoff_required || rev.safe_handoff_required,
      handoff_reasons: r.handoff_reasons || rev.handoff_reasons,
    };
  };

  console.log(JSON.stringify({
    conversation_id: conv.rows[0]?.id,
    metadata_luna_guest_context: conv.rows[0]?.metadata?.luna_guest_context || null,
    metadata_keys: conv.rows[0]?.metadata ? Object.keys(conv.rows[0].metadata) : [],
    recent_messages: msgs.rows.reverse(),
    recent_events: events.rows.map(summarize).reverse(),
    recent_sends: sends.rows,
  }, null, 2));

  await pg.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
