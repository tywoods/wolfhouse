'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');
const az = (c) => execSync(c, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
const PHONE = '+491726422307';
const RAW = '491726422307';

(async () => {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const before = await pg.query(
    `SELECT role, is_active::text FROM staff_phone_access
      WHERE client_slug='wolfhouse-somo' AND (phone_normalized=$1 OR phone_e164=$2)`,
    [RAW, PHONE],
  );
  await pg.query(
    `UPDATE staff_phone_access SET is_active=false
      WHERE client_slug='wolfhouse-somo' AND (phone_normalized=$1 OR phone_e164=$2)`,
    [RAW, PHONE],
  );
  const after = await pg.query(
    `SELECT role, is_active::text FROM staff_phone_access
      WHERE client_slug='wolfhouse-somo' AND (phone_normalized=$1 OR phone_e164=$2)`,
    [RAW, PHONE],
  );
  console.log(JSON.stringify({ before: before.rows, after: after.rows }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
