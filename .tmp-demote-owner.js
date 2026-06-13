'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
(async () => {
  const db = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  await pg.query(
    `UPDATE staff_phone_access SET is_active = false, updated_at = NOW()
      WHERE client_slug = 'wolfhouse-somo'
        AND (phone_normalized = '491726422307' OR phone_e164 = '+491726422307')
        AND is_active = true`,
  );
  const r = await pg.query(
    `SELECT role, is_active::text FROM staff_phone_access
      WHERE client_slug = 'wolfhouse-somo'
        AND (phone_normalized = '491726422307' OR phone_e164 = '+491726422307')`,
  );
  console.log(JSON.stringify(r.rows, null, 2));
  await pg.end();
})();
