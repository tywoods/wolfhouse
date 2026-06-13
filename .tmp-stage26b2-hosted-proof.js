'use strict';
/** Stage 26b.2 — re-upsert staging transfers with fixed lookup_date. Temp — do not commit. */

const { execSync } = require('child_process');
const { Client } = require('pg');
const { upsertBookingTransfer, listBookingTransfersForBooking, buildBookingTransferUpsertPayload } = require('./scripts/lib/booking-transfers');

const CLIENT = 'wolfhouse-somo';
const BOOKING_ID = 'adf70f79-c750-458d-a306-97c81304898b';
const BOOKING_CODE = 'MB-WOLFHO-20291001-9dcb42';

async function pgConnect() {
  const url = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

async function dbCounts(pg) {
  const bookings = await pg.query('SELECT COUNT(*)::int AS n FROM bookings');
  const payments = await pg.query('SELECT COUNT(*)::int AS n FROM payments');
  const sends = await pg.query("SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE status = 'sent'");
  return {
    bookings: bookings.rows[0].n,
    payments: payments.rows[0].n,
    guest_message_sends_sent: sends.rows[0].n,
  };
}

(async () => {
  const pg = await pgConnect();
  const before = await dbCounts(pg);

  const b = await pg.query(
    `SELECT b.id, b.booking_code, b.check_in, b.check_out, b.guest_count, b.package_code,
            b.status, b.payment_status
       FROM bookings b WHERE b.id = $1`,
    [BOOKING_ID],
  );
  if (!b.rows[0]) throw new Error('booking not found');
  const row = b.rows[0];
  const booking = {
    check_in: row.check_in,
    check_out: row.check_out,
    guest_count: row.guest_count,
    package_code: row.package_code,
  };

  const payload = buildBookingTransferUpsertPayload({
    client_slug: CLIENT,
    booking,
    transferInput: { direction: 'arrival', airport_code: 'SDR' },
  });

  await upsertBookingTransfer(pg, {
    client_slug: CLIENT,
    booking_id: BOOKING_ID,
    direction: 'arrival',
    booking,
    transfer: { airport_code: 'SDR', flight_number: 'TEST123X', notes: 'Stage 26b.2 proof arrival' },
    source: 'staff',
  });
  await upsertBookingTransfer(pg, {
    client_slug: CLIENT,
    booking_id: BOOKING_ID,
    direction: 'departure',
    booking,
    transfer: { airport_code: 'SDR', flight_number: 'TEST456', notes: 'Stage 26b.2 proof departure' },
    source: 'staff',
  });

  const listed = await listBookingTransfersForBooking(pg, { client_slug: CLIENT, booking_id: BOOKING_ID });
  const count = await pg.query('SELECT COUNT(*)::int AS n FROM booking_transfers WHERE booking_id = $1', [BOOKING_ID]);
  const after = await dbCounts(pg);

  const arrival = listed.find((r) => r.direction === 'arrival');
  const departure = listed.find((r) => r.direction === 'departure');

  const sqlDates = await pg.query(
    'SELECT direction, lookup_date::text AS lookup_date FROM booking_transfers WHERE booking_id = $1 ORDER BY direction',
    [BOOKING_ID],
  );

  console.log(JSON.stringify({
    result: (
      count.rows[0].n === 2
      && sqlDates.rows.find((r) => r.direction === 'arrival')?.lookup_date === '2029-10-01'
      && sqlDates.rows.find((r) => r.direction === 'departure')?.lookup_date === '2029-10-04'
      && before.bookings === after.bookings
      && before.payments === after.payments
      && before.guest_message_sends_sent === after.guest_message_sends_sent
    ) ? 'PASS' : 'FAIL',
    booking_code: BOOKING_CODE,
    booking_sql_dates: { check_in: row.check_in, check_out: row.check_out },
    payload_arrival_lookup_date: payload.lookup_date,
    transfer_count: count.rows[0].n,
    sql_lookup_dates: sqlDates.rows,
    arrival_lookup_date: arrival.lookup_date,
    departure_lookup_date: departure.lookup_date,
    db_counts_before: before,
    db_counts_after: after,
  }, null, 2));

  await pg.end();
})().catch((e) => { console.error(e); process.exit(1); });
