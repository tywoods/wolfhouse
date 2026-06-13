'use strict';
const { Client } = require('pg');
const { execSync } = require('child_process');

(async () => {
  const dbUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const r = await pg.query(`
    UPDATE bookings
       SET hold_expires_at = NOW() + interval '7 days'
     WHERE booking_code = 'WH-G27-0ECC1D9B57'
     RETURNING booking_code, hold_expires_at::text`);
  console.log(JSON.stringify(r.rows[0]));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
