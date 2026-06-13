'use strict';
const { Client } = require('pg');
const dbUrl = process.env.DB_URL;
const client = new Client({ connectionString: dbUrl });
async function main() {
  await client.connect();
  const r = await client.query(
    `SELECT c.id, c.phone, c.needs_human, c.pending_action,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id)::int AS msg_count,
            (c.metadata->>'luna_guest_context') IS NOT NULL AS has_luna_ctx
     FROM conversations c
     JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo'
       AND c.phone = '+491726422307'`
  );
  console.log(JSON.stringify(r.rows, null, 2));

  // Also check recent guest_message_events
  const e = await client.query(
    `SELECT wa_message_id, message_text, draft_called, send_attempted, send_status, created_at
     FROM guest_message_events
     WHERE client_slug = 'wolfhouse-somo' AND from_phone = '+491726422307'
     ORDER BY created_at DESC LIMIT 5`
  );
  console.log('recent events:', JSON.stringify(e.rows, null, 2));
  await client.end();
}
main().catch(e => console.error(e.message));
