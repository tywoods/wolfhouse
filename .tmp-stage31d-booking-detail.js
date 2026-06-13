'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
(async () => {
  const db = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const codes = ['WH-G27-077CB90CDE', 'WH-G27-077CB90CDE', 'WH-G27-90051E4EA0'];
  for (const code of ['WH-G27-077CB90CDE', 'WH-G27-077CB90CDE']) {}
  const r = await pg.query(
    `SELECT booking_code, package_code, check_in::text, check_out::text, guest_count, status::text, payment_status::text
       FROM bookings WHERE booking_code = ANY($1::text[])`,
    [['WH-G27-077CB90CDE', 'WH-G27-90051E4EA0', 'WH-G27-077CB90CDE']],
  );
  // also find bookings from stripe sessions
  const r2 = await pg.query(
    `SELECT b.booking_code, b.package_code, b.check_in::text, b.check_out::text, b.guest_count, b.status::text,
            p.stripe_checkout_session_id
       FROM bookings b JOIN payments p ON p.booking_id = b.id
      WHERE p.stripe_checkout_session_id IN ($1, $2, $3)`,
    [
      'cs_test_a1SpLsyfhHg2QoHWI0lWgNlgCcDmjb6MmrSF9gqieDbNWmU7vQwh2hSjxy',
      'cs_test_a1fieZOmFSUN0QdSx1R7ZCmekjndkCRrAUki9wet8nxrIHf9drvjyy8lno',
      'cs_test_a1uGUKjM8xdVagJ4M52Vk3rBOvu7HyNe9ZyWnGk70vEIEXqSHX9n6qmgzC',
    ],
  );
  console.log(JSON.stringify({ by_stripe: r2.rows }, null, 2));
  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
