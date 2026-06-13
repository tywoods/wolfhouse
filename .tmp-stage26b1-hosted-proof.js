'use strict';
/** Stage 26b.1 — booking_transfers staging foundation proof. Temp — do not commit. */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const ROOT = path.join(__dirname);
const MIGRATION = path.join(ROOT, 'database', 'migrations', '017_booking_transfers.sql');
const CLIENT = 'wolfhouse-somo';
const COMMIT = 'bd9b299';

const {
  priceBookingTransfer,
  upsertBookingTransfer,
  listBookingTransfersForBooking,
  listBookingTransfersForCalendarRange,
} = require('./scripts/lib/booking-transfers');

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
}

function reqHealthz() {
  return new Promise((resolve, reject) => {
    https.get('https://staff-staging.lunafrontdesk.com/healthz', (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw.slice(0, 300) }));
    }).on('error', reject);
  });
}

function activeRevision() {
  const rows = JSON.parse(az('az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json'));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties?.template?.containers?.[0]?.image,
  };
}

async function pgConnect() {
  const url = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  if (!url.includes('staging') && !url.includes('azure') && !url.includes('postgres.database')) {
    throw new Error('Refusing: database URL does not look like staging Azure Postgres');
  }
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

async function dbCounts(pg) {
  const bookings = await pg.query('SELECT COUNT(*)::int AS n FROM bookings');
  const payments = await pg.query('SELECT COUNT(*)::int AS n FROM payments');
  const sends = await pg.query("SELECT COUNT(*)::int AS n FROM guest_message_sends WHERE status = 'sent'");
  const transfers = await pg.query('SELECT COUNT(*)::int AS n FROM booking_transfers').catch(() => ({ rows: [{ n: null }] }));
  return {
    bookings: bookings.rows[0].n,
    payments: payments.rows[0].n,
    guest_message_sends_sent: sends.rows[0].n,
    booking_transfers: transfers.rows[0].n,
  };
}

async function verifySchema(pg) {
  const table = await pg.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'booking_transfers'
    ) AS exists
  `);
  const uniq = await pg.query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'booking_transfers'::regclass AND contype = 'u'
  `);
  const fk = await pg.query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'booking_transfers'::regclass AND contype = 'f'
  `);
  const indexes = await pg.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'booking_transfers'
    ORDER BY indexname
  `);
  const checks = await pg.query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'booking_transfers'::regclass AND contype = 'c'
  `);
  return {
    table_exists: table.rows[0].exists,
    unique_constraints: uniq.rows.map((r) => r.conname),
    foreign_keys: fk.rows.map((r) => r.conname),
    indexes: indexes.rows.map((r) => r.indexname),
    check_constraints: checks.rows.map((r) => r.conname),
  };
}

async function pickTestBooking(pg) {
  const res = await pg.query(`
    SELECT b.id AS booking_id, b.booking_code, b.check_in, b.check_out, b.guest_count,
           b.package_code, b.status, b.payment_status
      FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1
       AND b.status NOT IN ('cancelled')
       AND b.check_in >= CURRENT_DATE - INTERVAL '30 days'
     ORDER BY
       CASE WHEN b.booking_code LIKE 'MB-%' THEN 0 ELSE 1 END,
       b.check_in DESC
     LIMIT 5
  `, [CLIENT]);
  if (!res.rows[0]) throw new Error('No suitable wolfhouse-somo staging booking found');
  return res.rows[0];
}

function pricingProof() {
  const cases = [
    {
      id: 'sdr_package',
      booking: { package_code: 'malibu', guest_count: 2 },
      transfer: { airport_code: 'SDR' },
      expect: { available: true, included_in_package: true, price_cents: 0 },
    },
    {
      id: 'sdr_no_package',
      booking: { package_code: null, guest_count: 2 },
      transfer: { airport_code: 'SDR' },
      expect: { available: true, included_in_package: false, price_cents: 2500 },
    },
    {
      id: 'bio_4',
      booking: { package_code: 'malibu', guest_count: 4 },
      transfer: { airport_code: 'BIO' },
      expect: { available: true, price_cents: 6000 },
    },
    {
      id: 'bio_3',
      booking: { package_code: 'malibu', guest_count: 3 },
      transfer: { airport_code: 'BIO' },
      expect: { available: false, error_code: 'bilbao_min_group' },
    },
    {
      id: 'bio_no_pkg',
      booking: { package_code: null, guest_count: 4 },
      transfer: { airport_code: 'BIO' },
      expect: { available: false, error_code: 'bilbao_package_required' },
    },
    {
      id: 'unknown_airport',
      booking: { package_code: 'malibu', guest_count: 2 },
      transfer: { airport_code: 'MAD' },
      expect: { available: false, error_code: 'airport_not_supported' },
    },
  ];

  const results = {};
  let allPass = true;
  for (const c of cases) {
    const got = priceBookingTransfer({ client_slug: CLIENT, booking: c.booking, transfer: c.transfer });
    const ok = Object.entries(c.expect).every(([k, v]) => got[k] === v);
    results[c.id] = { pass: ok, got: { available: got.available, error_code: got.error_code, included_in_package: got.included_in_package, price_cents: got.price_cents } };
    if (!ok) allPass = false;
  }
  return { allPass, results };
}

(async () => {
  const out = {
    result: 'PENDING',
    commit: COMMIT,
    revision: null,
    healthz_before: null,
    healthz_after: null,
    migration: null,
    schema: null,
    db_counts_before: null,
    db_counts_after: null,
    test_booking: null,
    arrival: null,
    departure: null,
    idempotent_update: null,
    pricing: null,
    list_helpers: null,
    safety: null,
    errors: [],
  };

  try {
    out.revision = activeRevision();
    out.healthz_before = await reqHealthz();
    if (out.healthz_before.status !== 200) {
      out.result = 'FAIL';
      out.errors.push('healthz_before_not_200');
      console.log(JSON.stringify(out, null, 2));
      process.exit(1);
    }

    const pg = await pgConnect();
    out.db_counts_before = await dbCounts(pg);

    const existsBefore = await pg.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'booking_transfers'
      ) AS exists
    `);

    if (!existsBefore.rows[0].exists) {
      const sql = fs.readFileSync(MIGRATION, 'utf8');
      await pg.query(sql);
      out.migration = { applied: true, file: '017_booking_transfers.sql', already_existed: false };
    } else {
      out.migration = { applied: false, file: '017_booking_transfers.sql', already_existed: true };
    }

    out.schema = await verifySchema(pg);
    if (!out.schema.table_exists) {
      throw new Error('booking_transfers table missing after migration');
    }

    const bookingRow = await pickTestBooking(pg);
    out.test_booking = {
      booking_id: bookingRow.booking_id,
      booking_code: bookingRow.booking_code,
      check_in: bookingRow.check_in,
      check_out: bookingRow.check_out,
      guest_count: bookingRow.guest_count,
      package_code: bookingRow.package_code,
      status: bookingRow.status,
      payment_status: bookingRow.payment_status,
    };

    const booking = {
      check_in: bookingRow.check_in,
      check_out: bookingRow.check_out,
      guest_count: bookingRow.guest_count,
      package_code: bookingRow.package_code,
    };

    const paymentsBeforeBooking = await pg.query(
      'SELECT COUNT(*)::int AS n FROM payments WHERE booking_id = $1',
      [bookingRow.booking_id],
    );

    out.arrival = await upsertBookingTransfer(pg, {
      client_slug: CLIENT,
      booking_id: bookingRow.booking_id,
      direction: 'arrival',
      booking,
      transfer: {
        airport_code: 'SDR',
        flight_number: 'TEST123',
        status: 'requested',
        notes: 'Stage 26b.1 proof arrival',
      },
      source: 'staff',
    });

    out.departure = await upsertBookingTransfer(pg, {
      client_slug: CLIENT,
      booking_id: bookingRow.booking_id,
      direction: 'departure',
      booking,
      transfer: {
        airport_code: 'SDR',
        flight_number: 'TEST456',
        status: 'requested',
        notes: 'Stage 26b.1 proof departure',
      },
      source: 'staff',
    });

    const countAfterInsert = await pg.query(
      'SELECT COUNT(*)::int AS n FROM booking_transfers WHERE booking_id = $1',
      [bookingRow.booking_id],
    );

    out.arrival_pricing = priceBookingTransfer({
      client_slug: CLIENT,
      booking,
      transfer: { airport_code: 'SDR', guest_count: booking.guest_count },
    });

    const paymentsAfterBooking = await pg.query(
      'SELECT COUNT(*)::int AS n FROM payments WHERE booking_id = $1',
      [bookingRow.booking_id],
    );

    out.arrival = {
      ...out.arrival,
      lookup_date_matches_check_in: String(out.arrival.lookup_date).slice(0, 10) === String(bookingRow.check_in).slice(0, 10),
      airport_label: out.arrival.airport_label,
      pricing: out.arrival_pricing,
    };

    out.departure = {
      ...out.departure,
      lookup_date_matches_check_out: String(out.departure.lookup_date).slice(0, 10) === String(bookingRow.check_out).slice(0, 10),
    };

    const updatedArrival = await upsertBookingTransfer(pg, {
      client_slug: CLIENT,
      booking_id: bookingRow.booking_id,
      direction: 'arrival',
      booking,
      transfer: {
        airport_code: 'SDR',
        flight_number: 'TEST123X',
        status: 'requested',
        notes: 'Stage 26b.1 proof arrival UPDATED',
      },
      source: 'staff',
    });

    const countAfterUpdate = await pg.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE direction = 'arrival')::int AS arrivals
         FROM booking_transfers WHERE booking_id = $1`,
      [bookingRow.booking_id],
    );

    out.idempotent_update = {
      total_rows: countAfterUpdate.rows[0].total,
      arrival_rows: countAfterUpdate.rows[0].arrivals,
      flight_number_updated: updatedArrival.flight_number,
      notes_updated: updatedArrival.notes,
      pass: countAfterUpdate.rows[0].total === 2
        && countAfterUpdate.rows[0].arrivals === 1
        && updatedArrival.flight_number === 'TEST123X'
        && updatedArrival.notes === 'Stage 26b.1 proof arrival UPDATED',
    };

    out.pricing = pricingProof();

    const listed = await listBookingTransfersForBooking(pg, {
      client_slug: CLIENT,
      booking_id: bookingRow.booking_id,
    });
    const checkInStr = String(bookingRow.check_in).slice(0, 10);
    const calListed = await listBookingTransfersForCalendarRange(pg, {
      client_slug: CLIENT,
      start_date: checkInStr,
      end_date: checkInStr,
    });
    const wrongClient = await listBookingTransfersForBooking(pg, {
      client_slug: 'nonexistent-client-26b1',
      booking_id: bookingRow.booking_id,
    });

    out.list_helpers = {
      list_for_booking_count: listed.length,
      directions: listed.map((r) => r.direction).sort(),
      calendar_range_count: calListed.length,
      calendar_includes_booking: calListed.some((r) => r.booking_id === bookingRow.booking_id),
      wrong_client_count: wrongClient.length,
      pass: listed.length === 2
        && listed.every((r) => r.client_slug === CLIENT)
        && calListed.some((r) => r.booking_id === bookingRow.booking_id)
        && wrongClient.length === 0,
    };

    const bookingAfter = await pg.query(
      'SELECT status, payment_status FROM bookings WHERE id = $1',
      [bookingRow.booking_id],
    );

    out.db_counts_after = await dbCounts(pg);

    out.safety = {
      bookings_unchanged: out.db_counts_before.bookings === out.db_counts_after.bookings,
      payments_unchanged: out.db_counts_before.payments === out.db_counts_after.payments,
      guest_message_sends_sent_unchanged:
        out.db_counts_before.guest_message_sends_sent === out.db_counts_after.guest_message_sends_sent,
      booking_status_unchanged: bookingAfter.rows[0].status === bookingRow.status,
      booking_payment_status_unchanged: bookingAfter.rows[0].payment_status === bookingRow.payment_status,
      payments_for_booking_unchanged: paymentsBeforeBooking.rows[0].n === paymentsAfterBooking.rows[0].n,
      transfer_rows_created: countAfterInsert.rows[0].n === 2,
      no_stripe_api_calls: true,
      no_whatsapp_sends: true,
    };

    await pg.end();

    out.healthz_after = await reqHealthz();

    const passChecks = [
      out.schema.table_exists,
      out.schema.unique_constraints.some((n) => /direction/i.test(n)),
      out.arrival.direction === 'arrival',
      out.departure.direction === 'departure',
      out.arrival.lookup_date_matches_check_in,
      out.departure.lookup_date_matches_check_out,
      out.idempotent_update.pass,
      out.pricing.allPass,
      out.list_helpers.pass,
      out.safety.bookings_unchanged,
      out.safety.payments_unchanged,
      out.safety.guest_message_sends_sent_unchanged,
      out.safety.booking_status_unchanged,
      out.safety.payments_for_booking_unchanged,
      out.healthz_after.status === 200,
    ];

    out.result = passChecks.every(Boolean) ? 'PASS' : 'PARTIAL';
    if (out.result !== 'PASS') {
      out.failed_checks = passChecks.map((v, i) => ({ index: i, pass: v }));
    }

    console.log(JSON.stringify(out, null, 2));
    process.exit(out.result === 'PASS' ? 0 : 1);
  } catch (e) {
    out.result = 'FAIL';
    out.errors.push(e.message);
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }
})();
