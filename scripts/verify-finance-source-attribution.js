'use strict';

const assert = require('assert/strict');
const { stampBookingCreateSource } = require('./lib/booking-create-source-attribution');
const {
  computeWolfhouseCreatorFinance,
} = require('./lib/sunset-finance-summary');
const {
  LODGING_BSR_SQL,
  fetchLodgingFinanceData,
} = require('./lib/sunset-finance-data');

function creatorRows(projection) {
  return new Map(projection.creators.map((row) => [row.creator, row]));
}

async function main() {
  const luna = stampBookingCreateSource({ source: 'plugin-spoof', nested: { source: 'spoof' } }, 'bot_token', null);
  assert.equal(luna.source, 'luna_guest', 'Luna service principal wins over plugin source');
  const staff = stampBookingCreateSource({ source: 'luna_guest' }, 'staff_portal', { staff_user_id: 's-1' });
  assert.equal(staff.source, 'staff', 'staff principal wins over plugin source');

  // Finance's persisted-row query is the attribution authority.  Only the
  // canonical persisted metadata.source='luna_guest' is Luna; every other
  // persisted value (including absent metadata) is Staff.
  assert.match(LODGING_BSR_SQL, /CASE\s+WHEN b\.metadata->>'source' = 'luna_guest'\s+THEN 'luna_guest'::text\s+ELSE 'staff'::text END AS source/s,
    'lodging Finance SQL classifies canonical luna_guest and defaults to staff');
  assert.doesNotMatch(LODGING_BSR_SQL, /luna_guest_whatsapp|actor_source|bot_source|staff_manual_schedule|created_by_staff/,
    'lodging Finance SQL does not infer creator from non-canonical metadata');

  // This is intentionally an execution-level regression: rows below represent
  // persisted bookings returned by the real Finance data query, flow through
  // fetchLodgingFinanceData, then through the Finance aggregation.
  const persistedBookings = [
    { booking_id: 'luna', total_amount_cents: 1000, balance_due_cents: 0, created_at: '2026-10-27T10:00:00Z', metadata: { source: 'luna_guest' }, currency: 'EUR' },
    { booking_id: 'staff', total_amount_cents: 2000, balance_due_cents: 0, created_at: '2026-10-27T10:01:00Z', metadata: { source: 'staff' }, currency: 'EUR' },
    { booking_id: 'unknown', total_amount_cents: 3000, balance_due_cents: 0, created_at: '2026-10-27T10:02:00Z', metadata: { source: 'imported_legacy' }, currency: 'EUR' },
    { booking_id: 'missing', total_amount_cents: 4000, balance_due_cents: 0, created_at: '2026-10-27T10:03:00Z', metadata: {}, currency: 'EUR' },
  ];
  const bsrRows = persistedBookings.map((booking) => ({
    service_record_id: `service-${booking.booking_id}`,
    booking_id: booking.booking_id,
    service_date: '2026-10-27',
    service_type: 'accommodation',
    quantity: 1,
    amount_due_cents: booking.total_amount_cents,
    metadata: {},
    // This is the persisted-query projection selected by LODGING_BSR_SQL.
    source: booking.metadata.source === 'luna_guest' ? 'luna_guest' : 'staff',
  }));
  const paymentRows = persistedBookings.map((booking) => ({
    payment_id: `payment-${booking.booking_id}`,
    booking_id: booking.booking_id,
    amount_paid_cents: booking.total_amount_cents,
    paid_at: '2026-10-27T11:00:00Z',
    payment_kind: 'full_amount',
    metadata: {},
    currency: 'EUR',
    booking_metadata: booking.metadata,
  }));
  const pg = {
    async query(sql) {
      if (/^BEGIN|^COMMIT|^ROLLBACK|^SAVEPOINT|^RELEASE SAVEPOINT/i.test(sql)) return { rows: [] };
      if (/FROM bookings b\s+JOIN clients c[\s\S]*LEFT JOIN packages p/.test(sql)) return { rows: bsrRows };
      if (/FROM booking_service_records bsr/.test(sql)) return { rows: [] };
      if (/FROM booking_transfers t/.test(sql)) return { rows: [] };
      if (/SELECT b\.id AS booking_id[\s\S]*FROM bookings b/.test(sql)) return { rows: persistedBookings };
      if (/FROM payments p/.test(sql)) return { rows: paymentRows };
      if (/FROM beds bd/.test(sql) || /FROM booking_beds bb/.test(sql) || /FROM booking_refund_records r/.test(sql)) return { rows: [] };
      throw new Error(`unexpected Finance SQL: ${sql.slice(0, 80)}`);
    },
  };
  const data = await fetchLodgingFinanceData(pg, { clientSlug: 'wolfhouse-somo' });
  assert.deepEqual(data.bookings.map((booking) => booking.metadata.source || null),
    ['luna_guest', 'staff', 'imported_legacy', null], 'Finance fetch preserves persisted metadata.source values');

  const finance = computeWolfhouseCreatorFinance({
    now: '2026-10-27T12:00:00.000Z',
    view: { granularity: 'day', anchor: '2026-10-27' },
    clientSlug: 'wolfhouse-somo', currency: 'EUR', ...data,
  });
  const byCreator = creatorRows(finance);
  const lunaRow = byCreator.get('luna');
  const staffRow = byCreator.get('staff');
  const totalRow = byCreator.get('total');
  assert.equal(lunaRow.new_booking_count.count, 1, 'canonical persisted luna_guest is Luna');
  assert.equal(staffRow.new_booking_count.count, 3, 'staff, unknown, and missing persisted sources are Staff');
  assert.equal(lunaRow.new_booking_value.amount_cents, 1000);
  assert.equal(staffRow.new_booking_value.amount_cents, 9000);
  assert.equal(lunaRow.gross_receipts.amount_cents + staffRow.gross_receipts.amount_cents,
    totalRow.gross_receipts.amount_cents, 'Luna + Staff receipts equal Total');
  assert.equal(lunaRow.deposits_received.amount_cents + staffRow.deposits_received.amount_cents,
    totalRow.deposits_received.amount_cents, 'Luna + Staff deposits equal Total');
  assert.equal(lunaRow.new_booking_count.count + staffRow.new_booking_count.count,
    totalRow.new_booking_count.count, 'Luna + Staff booking counts equal Total');
  assert.equal(lunaRow.new_booking_value.amount_cents + staffRow.new_booking_value.amount_cents,
    totalRow.new_booking_value.amount_cents, 'Luna + Staff booking value equals Total');
  assert.equal(byCreator.has('unattributed'), false, 'Finance does not display an unattributed bucket');
  console.log('PASS verify-finance-source-attribution');
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
