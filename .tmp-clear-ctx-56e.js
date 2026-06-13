'use strict';
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DB_URL });
async function main() {
  await client.connect();

  // Clear luna context for the test phone
  const r = await client.query(
    `UPDATE conversations c
        SET metadata = metadata
              - 'luna_guest_context'
              - 'luna_inbound_reviews'
              - 'guest_context',
            staff_reply_draft = NULL,
            last_bot_reply = NULL,
            pending_action = NULL,
            conversation_summary = NULL
       FROM clients cl
      WHERE cl.id = c.client_id
        AND cl.slug = 'wolfhouse-somo'
        AND c.phone = '+491726422307'
    RETURNING c.id`
  );
  console.log('Cleared context for rows:', r.rowCount, r.rows.map(x => x.id));
  await client.end();
}
main().catch(e => console.error(e.message));
