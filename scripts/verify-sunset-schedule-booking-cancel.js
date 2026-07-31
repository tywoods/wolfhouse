'use strict';
const assert = require('assert');
const m = require('./lib/sunset-schedule-booking-drawer');

function makePg(handlers) {
  const log = [];
  return {
    log,
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      log.push(s);
      for (const h of handlers) {
        if (h.match(s, params)) return h.run(sql, params, s);
      }
      throw new Error('unexpected sql: ' + s.slice(0, 220));
    },
  };
}

const booking = {
  booking_id: '11111111-1111-1111-1111-111111111111',
  booking_code: 'SUNSET-TEST',
  guest_name: 'T',
  status: 'confirmed',
  payment_status: 'paid',
  metadata: { source: 'staff_manual_schedule', staff_manual_schedule: true, location_id: 'sunset-somo' },
};

function baseHandlers(overrides = []) {
  const h = [
    { match: (s) => s === 'BEGIN' || s.startsWith('BEGIN'), run: async () => ({ rows: [] }) },
    { match: (s) => s === 'COMMIT' || s.startsWith('COMMIT'), run: async () => ({ rows: [] }) },
    { match: (s) => s.startsWith('ROLLBACK'), run: async () => ({ rows: [] }) },
    {
      match: (s) => s.includes('FROM bookings b') && s.includes('SELECT b.id::text'),
      run: async () => ({ rows: [booking] }),
    },
    {
      match: (s) => s.includes('FROM booking_service_records') && s.includes('SELECT id::text'),
      run: async () => ({
        rows: [{
          service_record_id: '22222222-2222-2222-2222-222222222222',
          service_type: 'surf_lesson',
          location_id: 'sunset-somo',
          metadata_source: 'staff_manual_schedule',
          staff_manual_schedule: 'true',
          metadata: { source: 'staff_manual_schedule', staff_manual_schedule: true, location_id: 'sunset-somo' },
        }],
      }),
    },
    {
      match: (s) => s.includes('FROM payments p') && s.includes('checkout_url IS NOT NULL') && s.includes('SELECT p.id'),
      run: async () => ({
        rows: [{ payment_id: 'p1', checkout_url: 'https://checkout.stripe.com/x', payment_status: 'checkout_created', amount_due_cents: 1000 }],
      }),
    },
    {
      match: (s) => s.includes("status = 'paid'") && s.includes('SUM'),
      run: async () => ({ rows: [{ paid_total: 5000 }] }),
    },
    {
      match: (s) => s.includes("status = 'paid'") && s.includes('SELECT p.id::text AS payment_id'),
      run: async () => ({ rows: [{ payment_id: 'paid1', payment_status: 'paid', amount_paid_cents: 5000 }] }),
    },
    {
      match: (s) => s.includes('FOR UPDATE OF b NOWAIT'),
      run: async () => ({ rows: [{ id: booking.booking_id }] }),
    },
    {
      match: (s) => s.includes('UPDATE booking_service_records SET status'),
      run: async () => ({ rowCount: 2, rows: [] }),
    },
    {
      match: (s) => s.includes("status = 'cancelled'::booking_status"),
      run: async () => ({ rowCount: 1, rows: [] }),
    },
    {
      match: (s) => s.includes('UPDATE payments') && s.includes('checkout_url = NULL'),
      run: async () => ({ rowCount: 1, rows: [] }),
    },
    {
      match: (s) => s.includes('UPDATE bookings') && s.includes('WHERE id = $2::uuid'),
      run: async () => ({ rowCount: 1, rows: [] }),
    },
    {
      match: (s) => s.includes('UPDATE bookings') && s.includes('payment_link_invalidated'),
      run: async () => ({ rowCount: 1, rows: [] }),
    },
  ];
  return [].concat(overrides || [], h);
}

async function run() {
  console.log('\nverify:sunset-schedule-booking-cancel\n');
  let pass = 0;
  function ok(name, cond) {
    if (!cond) throw new Error('FAIL ' + name);
    console.log('  PASS ', name);
    pass += 1;
  }

  {
    const pg = makePg(baseHandlers());
    const r = await m.cancelSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: booking.booking_id,
      locationId: 'sunset-somo',
    });
    ok('paid cancel succeeds', r.ok === true && r.body.cancelled === true);
    ok('voids payment links', r.body.payment_links_voided === 1);
    ok('no service FOR UPDATE lock', !pg.log.some((s) => s.includes('booking_service_records') && s.includes('FOR UPDATE')));
    ok('uses booking NOWAIT lock', pg.log.some((s) => s.includes('NOWAIT')));
    ok('void before commit', pg.log.findIndex((s) => s.includes('checkout_url = NULL')) < pg.log.findIndex((s) => s.startsWith('COMMIT')));
  }

  {
    const pg = makePg(baseHandlers([
      {
        match: (s) => s.includes('UPDATE payments') && s.includes('checkout_url = NULL'),
        run: async () => { throw new Error('simulated_void_failure'); },
      },
    ]));
    const r = await m.cancelSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: booking.booking_id,
      locationId: 'sunset-somo',
    });
    ok('void failure rolls back cancel', r.ok === false && r.body.error === 'payment_link_invalidate_failed');
    ok('void failure has detail', String(r.body.detail || '').includes('simulated_void_failure'));
    ok('void failure no commit', !pg.log.some((s) => s.startsWith('COMMIT')));
  }

  {
    const pg = makePg(baseHandlers([
      {
        match: (s) => s.includes('FOR UPDATE OF b NOWAIT'),
        run: async () => { const e = new Error('could not obtain lock on row'); e.code = '55P03'; throw e; },
      },
    ]));
    const r = await m.cancelSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: booking.booking_id,
      locationId: 'sunset-somo',
    });
    ok('busy lock returns 409 booking_busy', r.ok === false && r.status === 409 && r.body.error === 'booking_busy');
  }

  {
    const pg = makePg(baseHandlers());
    const r = await m.cancelSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: booking.booking_id,
      locationId: 'sunset-sardinero',
    });
    ok('wrong location rejected', r.ok === false && r.body.error === 'booking_not_in_active_school');
  }

  console.log(`\n── verify:sunset-schedule-booking-cancel PASSED (pass=${pass} fail=0) ──\n`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
