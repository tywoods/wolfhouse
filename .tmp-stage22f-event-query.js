'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
(async () => {
  const url = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(
    "SELECT wa_message_id, client_slug FROM guest_message_events WHERE wa_message_id LIKE '%phase22b%' OR wa_message_id LIKE '%oct%' LIMIT 10",
  );
  console.log('events', JSON.stringify(r.rows, null, 2));
  const c = await pg.query('SELECT COUNT(*)::int c FROM guest_message_events');
  console.log('total events', c.rows[0].c);
  await pg.end();
})();
