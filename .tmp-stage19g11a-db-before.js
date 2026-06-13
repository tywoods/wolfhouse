'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const CLIENT = 'wolfhouse-somo';
const PHONE = '491726422307';
(async () => {
  const whUrl = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const ev = await pg.query(
    'SELECT COUNT(*)::int AS n FROM guest_message_events WHERE client_slug = $1 AND REPLACE(COALESCE(from_phone, \'\'), \'+\', \'\') LIKE $2',
    [CLIENT, `%${PHONE}%`],
  );
  const se = await pg.query(
    'SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE client_slug = $1 AND REPLACE(COALESCE(to_phone, \'\'), \'+\', \'\') LIKE $2',
    [CLIENT, `%${PHONE}%`],
  );
  const bk = await pg.query('SELECT COUNT(*)::int AS n FROM bookings');
  const pay = await pg.query('SELECT COUNT(*)::int AS n FROM payments');
  await pg.end();
  console.log(JSON.stringify({
    guest_message_events: ev.rows[0].n,
    guest_message_sends: se.rows[0].n,
    bookings: bk.rows[0].n,
    payments: pay.rows[0].n,
  }, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
