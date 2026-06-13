'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');

function az(s) {
  return execSync(s, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

(async () => {
  const db = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const c = await pg.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'booking_service_records'::regclass
        AND contype = 'c'`,
  );
  console.log(JSON.stringify(c.rows, null, 2));
  await pg.end();
})();
