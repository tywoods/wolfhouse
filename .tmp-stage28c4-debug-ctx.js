'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const az = (c) => execSync(c, { encoding: 'utf8' }).trim();

(async () => {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const since = '2026-06-10T07:59:54.285Z';
  const conv = await pg.query(`
    SELECT c.id::text, c.phone, c.needs_human, c.metadata, c.updated_at::text
      FROM conversations c JOIN clients cl ON cl.id=c.client_id
     WHERE cl.slug='wolfhouse-somo' AND c.phone IN ('+491726422307','491726422307')`);
  const events = await pg.query(`
    SELECT wa_message_id, normalized->'open_demo_result' AS odr,
           normalized->'open_demo_route' AS route, created_at::text
      FROM guest_message_events
     WHERE normalized->>'from'='491726422307' AND created_at >= $1::timestamptz
     ORDER BY created_at`, [since]);
  console.log(JSON.stringify({ conversations: conv.rows, events: events.rows }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
