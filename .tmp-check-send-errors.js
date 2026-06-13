'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');

const PHONE = '+491726422307';

(async () => {
  const url = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const events = await pg.query(
    `SELECT created_at::text, message_text, send_attempted, send_status,
            normalized->'open_demo_result'->>'whatsapp_sent' AS whatsapp_sent,
            normalized->'open_demo_result'->>'live_reply_gate_code' AS gate_code,
            wa_message_id
       FROM guest_message_events
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(from_phone, ''), '+', '') = REPLACE($1, '+', '')
      ORDER BY created_at DESC LIMIT 8`,
    [PHONE],
  );

  const sends = await pg.query(
    `SELECT created_at::text, status, LEFT(message_text, 80) AS preview,
            blocked_reasons, provider_response
       FROM guest_message_sends
      WHERE client_slug = 'wolfhouse-somo'
        AND REPLACE(COALESCE(to_phone, ''), '+', '') = REPLACE($1, '+', '')
      ORDER BY created_at DESC LIMIT 8`,
    [PHONE],
  );

  await pg.end();
  console.log(JSON.stringify({ events: events.rows, sends: sends.rows }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
