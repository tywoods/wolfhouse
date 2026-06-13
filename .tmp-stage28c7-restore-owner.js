'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const az = (c) => execSync(c, { encoding: 'utf8' }).trim();
(async () => {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  await pg.query(
    `UPDATE staff_phone_access SET is_active = true, updated_at = NOW()
      WHERE client_slug = 'wolfhouse-somo' AND phone_normalized = '491726422307'`,
  );
  const r = await pg.query(
    `SELECT is_active::text FROM staff_phone_access WHERE phone_normalized = '491726422307'`,
  );
  await pg.end();
  console.log(JSON.stringify({ owner_is_active: r.rows[0]?.is_active }));
})().catch((e) => { console.error(e); process.exit(1); });
