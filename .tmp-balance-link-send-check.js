'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');

(async () => {
  const url = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(`
    SELECT created_at, status, LEFT(message_text, 220) AS msg, idempotency_key
      FROM guest_message_sends
     WHERE to_phone = '+491726422307'
       AND idempotency_key LIKE '%balance-proof4%'
     ORDER BY created_at DESC`);
  console.log(JSON.stringify(r.rows, null, 2));
  await pg.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
