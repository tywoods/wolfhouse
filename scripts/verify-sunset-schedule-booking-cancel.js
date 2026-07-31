'use strict';
const fs = require('fs');
const path = require('path');
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
      throw new Error('unexpected sql: ' + s.slice(0, 240));
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
    { match: (s) => s.startsWith('BEGIN'), run: async () => ({ rows: [] }) },
    { match: (s) => s.startsWith('COMMIT'), run: async () => ({ rows: [] }) },
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
      match: (s) => s.includes('FROM payments p') && s.includes('SELECT p.id') && s.includes('checkout_url IS NOT NULL') && !s.includes('UPDATE'),
      run: async () => ({
        rows: [{ payment_id: 'p1', checkout_url: 'https://checkout.stripe.com/x', payment_status: 'checkout_created', amount_due_cents: 1000 }],
      }),
    },
    {
      match: (s) => s.includes('SUM') && s.includes('amount_paid_cents'),
      run: async () => ({ rows: [{ paid_total: 5000 }] }),
    },
    {
      match: (s) => s.includes("status = 'paid'") && s.includes('SELECT p.id::text AS payment_id'),
      run: async () => ({ rows: [{ payment_id: 'paid1', payment_status: 'paid', amount_paid_cents: 5000 }] }),
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
  ];
  return [].concat(overrides || [], h);
}

function firstBookingSelect(log) {
  return log.find((s) => s.includes('FROM bookings b') && s.includes('SELECT b.id::text')) || '';
}

function hasBlockingForUpdate(log) {
  return log.some((s) => {
    if (!/FOR UPDATE/i.test(s)) return false;
    return !/NOWAIT/i.test(s);
  });
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
    const apiSource = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
    const viewSource = fs.readFileSync(path.join(__dirname, 'browser', 'sunset-schedule-drawer-view-ui.js'), 'utf8');
    const dayOpsSource = fs.readFileSync(path.join(__dirname, 'browser', 'sunset-schedule-day-ops-board-ui.js'), 'utf8');
    const cancelRoute = apiSource.match(/if \(pathname === '\/staff\/schedule\/bookings\/cancel'[\s\S]*?\n  \}/);
    const cancelCss = (apiSource.match(/\.portal-schedule-cancel-booking-btn\{([^}]*)\}/) || [])[1] || '';
    const cancelledRowCss = (apiSource.match(/\.portal-schedule-ops-row\.is-cancelled\{([^}]*)\}/) || [])[1] || '';
    ok('cancel route exists', !!cancelRoute);
    ok('cancel route requires operator auth', !!cancelRoute && /requireAuth\(req, res, 'operator'\)/.test(cancelRoute[0]));
    ok('cancel route checks auth before handler', !!cancelRoute && /if \(!auth\.ok\) return;[\s\S]*handleSunsetScheduleBookingCancel/.test(cancelRoute[0]));
    ok('cancel and delete use distinct button classes',
      /portal-schedule-cancel-booking-btn[^\n]*ps-drawer-cancel-booking/.test(viewSource)
      && /portal-schedule-delete-booking-btn[^\n]*ps-drawer-delete-booking/.test(viewSource));
    ok('cancel button uses grey, never delete red',
      /color:#6F756F/.test(cancelCss) && !/9C4A42/i.test(cancelCss));
    ok('delete button retains red danger styling',
      /\.portal-schedule-delete-booking-btn\{[^}]*color:#9C4A42/.test(apiSource));
    ok('cancelled schedule rows have complete grey styling',
      /background:rgba\(111,117,111,\.08\)/.test(cancelledRowCss)
      && /color:#777D77/.test(cancelledRowCss)
      && /opacity:\.64/.test(cancelledRowCss)
      && /filter:grayscale\(\.65\)/.test(cancelledRowCss));
    ok('day-ops renderer emits is-cancelled for ghost rows',
      /g\._isCancelled \|\| g\.schedule_ghost \? ' is-cancelled' : ''/.test(dayOpsSource));
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
    const first = firstBookingSelect(pg.log);
    ok('first booking SELECT includes NOWAIT', /FOR UPDATE OF b NOWAIT/i.test(first));
    ok('no FOR UPDATE without NOWAIT', !hasBlockingForUpdate(pg.log));
    ok('no service FOR UPDATE', !pg.log.some((s) => s.includes('booking_service_records') && /FOR UPDATE/i.test(s)));
    ok('no second redundant booking lock query', pg.log.filter((s) => /FOR UPDATE OF b/i.test(s)).length === 1);
    ok('void before commit', pg.log.findIndex((s) => s.includes('checkout_url = NULL')) < pg.log.findIndex((s) => s.startsWith('COMMIT')));
  }

  {
    // 55P03 on FIRST booking select → busy, no mutations/commit
    const pg = makePg(baseHandlers([
      {
        match: (s) => s.includes('FROM bookings b') && s.includes('SELECT b.id::text'),
        run: async () => {
          const e = new Error('could not obtain lock on row in relation "bookings"');
          e.code = '55P03';
          throw e;
        },
      },
    ]));
    const r = await m.cancelSunsetScheduleBooking(pg, {
      clientSlug: 'sunset',
      bookingId: booking.booking_id,
      locationId: 'sunset-somo',
    });
    ok('first-query 55P03 → 409 booking_busy', r.ok === false && r.status === 409 && r.body.error === 'booking_busy');
    ok('busy path no service mutation', !pg.log.some((s) => s.includes('UPDATE booking_service_records')));
    ok('busy path no payment void', !pg.log.some((s) => s.includes('checkout_url = NULL')));
    ok('busy path no commit', !pg.log.some((s) => s.startsWith('COMMIT')));
    ok('busy path rolls back', pg.log.some((s) => s.startsWith('ROLLBACK')));
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
