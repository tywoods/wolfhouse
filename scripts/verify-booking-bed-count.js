/**
 * Verify booking_beds row count for one booking (local E2E helper).
 */
const { withPgClient } = require('./lib/pg-connect');

async function main() {
  let bookingCode = '';
  let expected = null;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--booking-code=')) bookingCode = arg.slice('--booking-code='.length).trim();
    else if (arg.startsWith('--expected-count=')) expected = Number(arg.slice('--expected-count='.length));
  }
  if (!bookingCode) {
    console.error('Usage: --booking-code=WH-rec... --expected-count=N');
    process.exit(1);
  }
  const { rows } = await withPgClient((client) =>
    client.query(
      `SELECT COUNT(*)::int AS c
       FROM booking_beds bb
       INNER JOIN bookings b ON b.id = bb.booking_id
       INNER JOIN clients c ON c.id = b.client_id
       WHERE c.slug = 'wolfhouse-somo' AND b.booking_code = $1`,
      [bookingCode]
    )
  );
  const count = rows[0].c;
  console.log(`PG booking_beds count for ${bookingCode}: ${count}`);
  if (expected != null && count !== expected) {
    throw new Error(`Expected ${expected} rows, found ${count}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
