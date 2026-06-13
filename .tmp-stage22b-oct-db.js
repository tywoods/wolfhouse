'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const whUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
(async () => {
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(
    `SELECT normalized->'booking_write_preview' AS preview FROM guest_message_events WHERE wa_message_id = $1`,
    ['wamid.phase22b.complete.oct.001'],
  );
  console.log(JSON.stringify(r.rows[0], null, 2));
  await pg.end();
})();
