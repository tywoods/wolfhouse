'use strict';
/** Stage 49b.1 — re-check full final live reply text (no resend). Temp — do not commit. */
const { execSync } = require('child_process');
const { Client } = require('pg');

(async () => {
  const url = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  if (!/staging|wolfhouse_staging/i.test(url)) throw new Error('DB guard: not staging URL');
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(`
    SELECT m.direction::text, m.message_text, m.created_at::text
      FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = 'wolfhouse-somo'
       AND (c.phone = '+34600995581' OR c.phone = '34600995581')
       AND m.created_at >= NOW() - INTERVAL '30 minutes'
     ORDER BY m.created_at ASC`);
  await pg.end();
  const out = r.rows.filter((m) => /out/i.test(m.direction));
  const last = out[out.length - 1] || { message_text: '' };
  console.log(JSON.stringify({
    outbound_count: out.length,
    last_reply_len: last.message_text.length,
    last_reply_tail: last.message_text.slice(-180),
    last_reply_next_step: /\?/.test(last.message_text),
    last_reply_no_explain_ask: !/want me to explain them quickly|do you already know which one you prefer/i.test(last.message_text),
    last_reply_has_packages: /malibu/i.test(last.message_text) && /uluwatu/i.test(last.message_text) && /waimea/i.test(last.message_text),
  }, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
