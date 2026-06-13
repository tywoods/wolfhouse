'use strict';

const { Client } = require('pg');
const { execSync } = require('child_process');

const PHONE = '+491726422307';

async function main() {
  const db = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const events = await pg.query(
    `SELECT id::text, created_at::text, from_phone, message_text, wa_message_id, to_phone_number_id,
            normalized->'open_demo_result' AS open_demo_result,
            suggested_reply, next_action, send_attempted, send_status
       FROM guest_message_events
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(from_phone, ''), '+', '') = REPLACE($1, '+', '')
      ORDER BY created_at DESC
      LIMIT 5`,
    [PHONE],
  );

  const sends = await pg.query(
    `SELECT id::text, to_phone, status, message_text, provider_message_id, idempotency_key, created_at::text
       FROM guest_message_sends
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(to_phone, ''), '+', '') = REPLACE($1, '+', '')
      ORDER BY created_at DESC
      LIMIT 5`,
    [PHONE],
  );

  const conv = await pg.query(
    `SELECT conv.id::text, conv.phone, conv.last_message_preview, conv.staff_reply_draft,
            LEFT(conv.metadata::text, 800) AS meta_snip, conv.updated_at::text
       FROM conversations conv
       JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(conv.phone, ''), '+', '') = REPLACE($1, '+', '')`,
    [PHONE],
  );

  let messages = { rows: [] };
  if (conv.rows[0]) {
    messages = await pg.query(
      `SELECT id::text, direction::text, message_text, source, created_at::text, whatsapp_message_id
         FROM messages
        WHERE conversation_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 15`,
      [conv.rows[0].id],
    );
  }

  console.log(JSON.stringify({ events: events.rows, sends: sends.rows, conv: conv.rows, messages: messages.rows }, null, 2));
  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
