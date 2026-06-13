'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const dbUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
(async () => {
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const conv = await pg.query(`
    SELECT c.id::text, c.phone, c.last_message_preview,
           LEFT(c.staff_reply_draft, 200) AS staff_reply_draft_preview,
           c.metadata->>'channel' AS channel_meta, c.updated_at
      FROM conversations c
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND c.phone = '+34600995555'
     ORDER BY c.updated_at DESC LIMIT 1`);
  const convId = conv.rows[0]?.id;
  const msgs = convId
    ? await pg.query('SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1::uuid', [convId])
    : { rows: [{ n: 0 }] };
  const sends = await pg.query(`
    SELECT COUNT(*)::int AS n FROM guest_message_sends
     WHERE client_slug = 'wolfhouse-somo' AND to_phone = '+34600995555'
       AND created_at > NOW() - INTERVAL '30 minutes'`);
  const bookings = await pg.query(`
    SELECT COUNT(*)::int AS n FROM bookings b
     INNER JOIN clients cl ON cl.id = b.client_id
     WHERE cl.slug = 'wolfhouse-somo' AND b.phone = '+34600995555'
       AND b.created_at > NOW() - INTERVAL '30 minutes'`);
  console.log(JSON.stringify({
    conversation: conv.rows[0] || null,
    inbound_message_count: msgs.rows[0].n,
    whatsapp_sends_last_30m: sends.rows[0].n,
    bookings_created_last_30m: bookings.rows[0].n,
  }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
