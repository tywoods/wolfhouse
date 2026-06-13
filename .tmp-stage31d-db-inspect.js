'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
(async () => {
  const db = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const since = '2026-06-10T21:04:00Z';
  const events = (await pg.query(
    `SELECT created_at, message_text, suggested_reply, send_status,
            normalized->'open_demo_result'->'conversation_brain'->>'composer_state' as composer_state,
            normalized->'open_demo_result'->'quote_facts_used_by_composer' as composer_facts
       FROM guest_message_events
      WHERE client_slug='wolfhouse-somo' AND REPLACE(COALESCE(from_phone,''),'+','')='491726422307'
        AND created_at >= $1::timestamptz ORDER BY created_at`,
    [since],
  )).rows;
  const sends = (await pg.query(
    `SELECT created_at, message_text, status, send_kind FROM guest_message_sends
      WHERE client_slug='wolfhouse-somo' AND REPLACE(COALESCE(to_phone,''),'+','')='491726422307'
        AND created_at >= $1::timestamptz ORDER BY created_at`,
    [since],
  )).rows;
  console.log(JSON.stringify({ events, sends }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
