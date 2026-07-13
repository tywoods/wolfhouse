'use strict';

/**
 * verify:sunset-drawer-auth-order
 *
 * Drawer GET must reject cross-school bookings before any Stripe reconcile
 * or payment/booking mutation.
 *
 * Run: node scripts/verify-sunset-drawer-auth-order.js
 */

const { getSunsetScheduleBookingDrawerContext } = require('./lib/sunset-schedule-booking-drawer');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

const BOOKING_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function buildPg(state) {
  const booking = {
    booking_id: BOOKING_ID,
    booking_code: 'SUNSET-20260802-SARD',
    guest_name: 'Sardinero Guest',
    phone: '+34000000000',
    status: 'hold',
    payment_status: 'waiting_payment',
    check_in: '2026-08-02',
    check_out: '2026-08-03',
    guest_count: 1,
    total_amount_cents: 4500,
    amount_paid_cents: 0,
    balance_due_cents: 4500,
    metadata: { source: 'luna_guest_whatsapp', luna_guest_booking: true, location_id: 'sunset-sardinero' },
  };
  const services = [{
    service_record_id: 'sr-1',
    service_type: 'surf_lesson',
    service_date: '2026-08-02',
    quantity: 1,
    amount_due_cents: 4500,
    amount_paid_cents: 0,
    payment_status: 'pending',
    slot_time: null,
    notes: null,
    staff_ui_service_type: 'lesson',
    metadata_component: 'lesson',
    metadata_components: '["lesson"]',
    location_id: 'sunset-sardinero',
    metadata_source: 'luna_guest_whatsapp',
    staff_manual_schedule: 'false',
    metadata: { location_id: 'sunset-sardinero', component: 'lesson', source: 'luna_guest_whatsapp' },
  }];
  return {
  query: async (sql) => {
    const q = String(sql);
    if (/SELECT p\.stripe_checkout_session_id AS sid/i.test(q)) {
      state.reconcileQueryCount += 1;
      return { rows: [{ sid: 'cs_pending_cross_school', payment_id: 'pay-1' }] };
    }
    if (/FROM bookings b[\s\S]*INNER JOIN clients/i.test(q)) return { rows: [booking] };
    if (/FROM booking_service_records/i.test(q)) return { rows: services };
    if (/FROM payments/i.test(q) && /checkout_url/i.test(q)) return { rows: [] };
    if (/SUM\(amount_paid_cents\)/i.test(q)) return { rows: [{ paid_total: 0 }] };
    return { rows: [] };
  },
  };
}

console.log('\nverify:sunset-drawer-auth-order\n');

(async () => {
  const state = { reconcileQueryCount: 0 };
  let stripeRetrieveCount = 0;
  let paymentWriteCount = 0;
  let bookingWriteCount = 0;

  const pg = buildPg(state);
  const origQuery = pg.query.bind(pg);
  pg.query = async (sql, params) => {
    const q = String(sql);
    if (/UPDATE payments/i.test(q) || /INSERT INTO payments/i.test(q)) paymentWriteCount += 1;
    if (/UPDATE bookings/i.test(q) && !/SELECT/i.test(q)) bookingWriteCount += 1;
    return origQuery(sql, params);
  };

  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => {
          stripeRetrieveCount += 1;
          return { id: 'cs_should_not_run', payment_status: 'paid', status: 'complete', amount_total: 4500, metadata: {} };
        },
      },
    },
  };

  const result = await getSunsetScheduleBookingDrawerContext(pg, {
    clientSlug: 'sunset',
    bookingId: BOOKING_ID,
    locationId: 'sunset-somo',
    stripe,
  });

  assert('returns booking_not_in_active_school', result.status === 404
    && result.body && result.body.error === 'booking_not_in_active_school');
  assert('reconcile pending-payment query not run', state.reconcileQueryCount === 0,
    `count=${state.reconcileQueryCount}`);
  assert('zero Stripe retrieve calls', stripeRetrieveCount === 0, `count=${stripeRetrieveCount}`);
  assert('zero payment writes', paymentWriteCount === 0, `count=${paymentWriteCount}`);
  assert('zero booking writes', bookingWriteCount === 0, `count=${bookingWriteCount}`);

  console.log(`\n── verify:sunset-drawer-auth-order ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  if (fail > 0) process.exit(1);
})();
