'use strict';
const { Client } = require('pg');
async function main() {
  const c = new Client({ connectionString: process.env.DB_URL });
  await c.connect();
  const r = await c.query(
    `SELECT b.id::text, b.booking_code, cl.slug
       FROM bookings b JOIN clients cl ON cl.id = b.client_id
      WHERE b.id = $1::uuid`,
    ['8c4d5efc-21e6-4d0c-a42c-c0ba4ea30988'],
  );
  console.log(r.rows);
  await c.end();
}
main();
