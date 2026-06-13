'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const PROOF_START = new Date(Date.now() - 45 * 60 * 1000).toISOString();
(async () => {
  const whUrl = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const sent = await pg.query(
    "SELECT id FROM guest_message_sends WHERE status = 'sent' AND created_at >= $1::timestamptz LIMIT 3",
    [PROOF_START],
  );
  const bookings = await pg.query(
    'SELECT id FROM bookings WHERE created_at >= $1::timestamptz LIMIT 3',
    [PROOF_START],
  );
  const payments = await pg.query(
    'SELECT id FROM payments WHERE created_at >= $1::timestamptz LIMIT 3',
    [PROOF_START],
  );
  await pg.end();
  console.log(JSON.stringify({
    proof_start: PROOF_START,
    sent: sent.rows.length,
    bookings: bookings.rows.length,
    payments: payments.rows.length,
  }, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
