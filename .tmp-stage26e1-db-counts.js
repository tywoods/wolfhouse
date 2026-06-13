'use strict';
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.PGCONN });
  await c.connect();
  const q = async (s) => (await c.query(s)).rows[0].count;
  const out = {
    booking_transfers: await q('SELECT COUNT(*)::text AS count FROM booking_transfers'),
    bookings: await q('SELECT COUNT(*)::text AS count FROM bookings'),
    payments: await q('SELECT COUNT(*)::text AS count FROM payments'),
    guest_message_sends_sent: await q("SELECT COUNT(*)::text AS count FROM guest_message_sends WHERE status='sent'"),
  };
  console.log(JSON.stringify(out));
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
