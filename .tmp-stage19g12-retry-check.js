'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
(async () => {
  const whUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const wamid = 'wamid.HBgMNDkxNzI2NDIyMzA3FQIAEhgWM0VCMEIzQzcwNjRBRjJFOUU2MjdGOQA=';
  const ev = await pg.query('SELECT * FROM guest_message_events WHERE wa_message_id = $1', [wamid]);
  const all = await pg.query(
    `SELECT wa_message_id, created_at, draft_called, next_action, suggested_reply, send_attempted, send_status, send_blocked_reasons, message_type
     FROM guest_message_events WHERE from_phone LIKE '%491726422307%' ORDER BY created_at DESC LIMIT 5`,
  );
  const sends = await pg.query(
    `SELECT idempotency_key, status, provider_message_id, blocked_reasons, created_at FROM guest_message_sends
     WHERE to_phone LIKE '%491726422307%' ORDER BY created_at DESC LIMIT 5`,
  );
  await pg.end();
  console.log(JSON.stringify({ case_a: ev.rows[0], recent: all.rows, sends: sends.rows }, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
