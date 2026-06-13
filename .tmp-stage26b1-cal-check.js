'use strict';
const { execSync } = require('child_process');
const { Client } = require('pg');
const { listBookingTransfersForCalendarRange } = require('./scripts/lib/booking-transfers');

(async () => {
  const url = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const id = 'adf70f79-c750-458d-a306-97c81304898b';
  const rows = await pg.query(
    'SELECT direction, lookup_date::text, check_in::text AS booking_check_in FROM booking_transfers t JOIN bookings b ON b.id = t.booking_id WHERE t.booking_id = $1',
    [id],
  );
  const cal = await listBookingTransfersForCalendarRange(pg, {
    client_slug: 'wolfhouse-somo',
    start_date: '2029-09-29',
    end_date: '2029-10-03',
  });
  console.log(JSON.stringify({ stored: rows.rows, calendar_count: cal.length, calendar_directions: cal.map((r) => r.direction) }, null, 2));
  await pg.end();
})();
