'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createWolfhouseDateChangeService,
  routeWolfhouseDateChangeRequest,
  ASSIGNMENTS_SQL,
} = require('./lib/wolfhouse-date-change');
const { bookingLedgerInvoicePaidBalance } = require('./lib/booking-invoice-totals');

function fakePg(state) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/BEGIN|COMMIT|ROLLBACK/.test(String(sql).trim())) return { rows: [] };
      if (/FROM bookings b[\s\S]*FOR UPDATE OF b/.test(sql)) return { rows: [state.booking] };
      if (/FROM booking_beds bb[\s\S]*JOIN beds/.test(sql) && /booking_id=\$2/.test(String(sql).replace(/\s/g, ''))) return { rows: state.assignments };
      if (/AS conflicting_booking_id/.test(sql)) return { rows: state.conflicts || [] };
      if (/UPDATE bookings/.test(sql)) {
        state.booking.check_in = params[2];
        state.booking.check_out = params[3];
        state.booking.total_amount_cents = params[4];
        state.booking.deposit_required_cents = params[5];
        state.booking.balance_due_cents = params[6];
        state.booking.metadata = { ...state.booking.metadata, quote_snapshot: JSON.parse(params[7]) };
        return { rows: [{ ...state.booking }] };
      }
      if (/UPDATE booking_beds/.test(sql)) return { rows: state.assignments.map((row) => ({ ...row, check_in: params[2], check_out: params[3] })) };
      throw new Error(`unexpected SQL: ${String(sql).slice(0, 100)}`);
    },
  };
}

async function main() {
  assert.match(
    ASSIGNMENTS_SQL,
    /FOR UPDATE OF bb\s*$/,
    'LEFT JOIN lock must target booking_beds only so PostgreSQL does not lock the nullable side',
  );
  const state = {
    booking: { booking_id: 'b1', booking_code: 'WH-1', client_id: 'c1', client_slug: 'wolfhouse-somo', guest_phone: '+34111', check_in: '2027-05-01', check_out: '2027-05-05', guest_count: 2, package_code: 'malibu', requested_room_type: 'unknown', room_preference: 'couple_private', metadata: { keep: 'yes', quote_snapshot: { guest_packages: [{ guest_number: 1, package_code: 'malibu' }, { guest_number: 2, package_code: 'uluwatu' }], room_type: 'private', line_items: [{ code: 'guest_package', guest_number: 1, package_code: 'malibu', total_cents: 42000 }, { code: 'guest_package', guest_number: 2, package_code: 'uluwatu', total_cents: 42000 }, { code: 'yoga_class', quantity: 2, total_cents: 20000 }] } }, status: 'confirmed', total_amount_cents: 104000, deposit_required_cents: 5000, amount_paid_cents: 5000, balance_due_cents: 99000 },
    assignments: [{ booking_bed_id: 'bb1', bed_id: 'bed1', bed_code: 'R1-B1', room_code: 'R1' }],
    conflicts: [],
  };
  const pg = fakePg(state);
  let quoted = null;
  const service = createWolfhouseDateChangeService({
    withPgClient: async (fn) => fn(pg),
    quoteNewDates: async (input) => { quoted = input; return { success: true, total_cents: 104000, currency: 'EUR', quote_id: 'q1', deposit_cents: 12000, guest_packages: input.guest_packages, room_type: input.room_type, line_items: [{ code: 'guest_package', total_cents: 84000 }, { code: 'yoga_class', total_cents: 20000 }] }; },
    tokenSecret: 'unit-test-date-change-secret-32bytes-minimum',
    now: () => new Date('2026-10-26T20:00:00Z'),
  });

  const preview = await service.quote({ client_slug: 'wolfhouse-somo', booking_code: 'WH-1', guest_phone: '+34111', new_check_in: '2027-06-01', new_check_out: '2027-06-05' });
  assert.equal(preview.success, true);
  assert.equal(preview.can_move, true);
  assert.equal(preview.write_performed, false);
  assert.equal(quoted.exclude_booking_id, 'b1', 'quote must exclude the booking being moved');
  assert.deepEqual(quoted.selected_bed_codes, ['R1-B1']);
  assert.deepEqual(quoted.guest_packages, state.booking.metadata.quote_snapshot.guest_packages, 'per-person package choices must survive the move');
  assert.deepEqual(quoted.add_ons, [{ code: 'yoga_class', quantity: 2 }], 'saved add-ons must survive the move');
  assert.equal(quoted.room_type, 'private', 'saved private-room choice must override an unknown room type');
  const conflictCall = pg.calls.find((call) => /AS conflicting_booking_id/.test(call.sql));
  assert(conflictCall, 'availability conflict query must run');
  assert(/bb\.booking_id <> \$2/.test(conflictCall.sql), 'conflict SQL must exclude the source booking');

  const wrongQuote = await service.move({ client_slug: 'wolfhouse-somo', booking_code: 'WH-1', guest_phone: '+34111', new_check_in: '2027-06-01', new_check_out: '2027-06-05', quote_token: 'tampered' });
  assert.equal(wrongQuote.success, false);
  assert.equal(wrongQuote.reason_code, 'date_change_quote_required');

  const moved = await service.move({ client_slug: 'wolfhouse-somo', booking_code: 'WH-1', guest_phone: '+34111', new_check_in: '2027-06-01', new_check_out: '2027-06-05', quote_token: preview.quote_token });
  assert.equal(moved.success, true);
  assert.equal(moved.write_performed, true);
  assert.equal(moved.booking.booking_id, 'b1');
  assert.equal(moved.booking.booking_code, 'WH-1');
  assert.equal(state.booking.check_in, '2027-06-01');
  assert.equal(state.booking.check_out, '2027-06-05');
  assert.equal(state.booking.total_amount_cents, 104000, 'accepted quote total must replace stale booking total');
  assert.equal(state.booking.deposit_required_cents, 12000, 'accepted quote deposit must replace stale booking deposit');
  assert.equal(state.booking.amount_paid_cents, 5000, 'existing paid amount remains receipt-owned');
  assert.equal(state.booking.balance_due_cents, 99000, 'balance must be recomputed from accepted total and paid receipts');
  assert.equal(state.booking.metadata.keep, 'yes', 'unrelated booking metadata must survive');
  assert.deepEqual(state.booking.metadata.quote_snapshot.line_items, [{ code: 'guest_package', total_cents: 84000 }, { code: 'yoga_class', total_cents: 20000 }], 'accepted quote snapshot must update atomically with money');
  assert.deepEqual(bookingLedgerInvoicePaidBalance(state.booking, 20000, 5000, 0), {
    invoice_total_cents: 104000,
    paid_total_cents: 5000,
    balance_due_cents: 99000,
    deposit_required_cents: 12000,
    needs_refund: false,
  }, 'invoice collector must read the moved booking and accepted snapshot as one money record');
  assert.equal(pg.calls.filter((call) => /INSERT INTO bookings/.test(call.sql)).length, 0, 'must not create a second booking');
  assert.equal(pg.calls.filter((call) => /DELETE FROM bookings/.test(call.sql)).length, 0, 'must not cancel/rebook');

  const denied = await service.quote({ client_slug: 'wolfhouse-somo', booking_code: 'WH-1', guest_phone: '+34999', new_check_in: '2027-07-01', new_check_out: '2027-07-05' });
  assert.equal(denied.reason_code, 'booking_owner_mismatch');

  const rentalState = {
    booking: {
      booking_id: 'b-rental', booking_code: 'WH-RENT', client_id: 'c1', client_slug: 'wolfhouse-somo',
      guest_phone: '+34111', check_in: '2027-05-01', check_out: '2027-05-05', guest_count: 2,
      package_code: 'malibu', requested_room_type: 'shared', room_preference: 'shared',
      metadata: {
        quote_snapshot: {
          guest_packages: [{ guest_number: 1, package_code: 'malibu' }, { guest_number: 2, package_code: 'malibu' }],
          room_type: 'shared',
          line_items: [
            { code: 'guest_package', total_cents: 84000 },
            { code: 'wetsuit_rental', days: 3, quantity: 1, people: 1, people_count: 1, total_cents: 6000 },
          ],
        },
      },
      status: 'confirmed', total_amount_cents: 90000, deposit_required_cents: 5000,
      amount_paid_cents: 0, balance_due_cents: 90000,
    },
    assignments: [{ booking_bed_id: 'bb2', bed_id: 'bed2', bed_code: 'R1-B2', room_code: 'R1' }],
    conflicts: [],
  };
  const rentalPg = fakePg(rentalState);
  let rentalQuoted = null;
  const rentalService = createWolfhouseDateChangeService({
    withPgClient: async (fn) => fn(rentalPg),
    quoteNewDates: async (input) => {
      rentalQuoted = input;
      return { success: true, total_cents: 90000, currency: 'EUR', quote_id: 'q-rental', deposit_cents: 5000 };
    },
    tokenSecret: 'unit-test-date-change-secret-32bytes-minimum',
    now: () => new Date('2026-10-26T20:00:00Z'),
  });
  const rentalPreview = await rentalService.quote({
    client_slug: 'wolfhouse-somo', booking_code: 'WH-RENT', guest_phone: '+34111',
    new_check_in: '2027-06-01', new_check_out: '2027-06-05',
  });
  assert.equal(rentalPreview.success, true);
  const wetsuit = (rentalQuoted.add_ons || []).find((row) => row.code === 'wetsuit_rental');
  assert(wetsuit, 'rental add-on must be sent back into pricing');
  assert.equal(Number(wetsuit.days), 3, '3 rental days must not collapse to 1');
  assert.equal(Number(wetsuit.people || wetsuit.quantity), 1, '1 renter in a 2-person booking must not become 2');

  const rateChanged = {
    total_amount_cents: 44500,
    deposit_required_cents: 42500,
    amount_paid_cents: 0,
    metadata: {
      quote_snapshot: {
        total_cents: 44500,
        deposit_cents: 42500,
        line_items: [
          { code: 'guest_package', total_cents: 40000 },
          { code: 'yoga_class', total_cents: 4500 },
        ],
      },
    },
  };
  assert.deepEqual(bookingLedgerInvoicePaidBalance(rateChanged, 3500, 0, 0), {
    invoice_total_cents: 44500,
    paid_total_cents: 0,
    balance_due_cents: 44500,
    deposit_required_cents: 42500,
    needs_refund: false,
  }, 'after an Admin rate change, invoice must use the stored accepted quote, not live service rows');

  const withLaterCharge = {
    total_amount_cents: 104000,
    deposit_required_cents: 12000,
    amount_paid_cents: 0,
    metadata: {
      quote_snapshot: {
        total_cents: 104000,
        deposit_cents: 12000,
        line_items: [
          { code: 'guest_package', total_cents: 84000 },
          { code: 'yoga_class', total_cents: 20000 },
        ],
      },
    },
  };
  assert.deepEqual(bookingLedgerInvoicePaidBalance(withLaterCharge, 21500, 0, 0, 1500), {
    invoice_total_cents: 105500,
    paid_total_cents: 0,
    balance_due_cents: 105500,
    deposit_required_cents: 12000,
    needs_refund: false,
  }, 'one money source must still include later Staff-added charges');

  const routeCalls = [];
  const response = { statusCode: 0, body: null };
  const routed = await routeWolfhouseDateChangeRequest({ method: 'POST', url: '/staff/bot/bookings/date-change-quote' }, response, {
    service: { quote: async (body) => { routeCalls.push(body); return { success: true }; } },
    readBody: async () => JSON.stringify({ booking_code: 'WH-1' }),
    sendJSON: (_res, status, body) => { response.statusCode = status; response.body = body; },
    trustedClientSlug: 'wolfhouse-somo', trustedGuestPhone: '+34111',
  });
  assert.equal(routed, true);
  assert.equal(response.statusCode, 200);
  assert.equal(routeCalls[0].client_slug, 'wolfhouse-somo');
  assert.equal(routeCalls[0].guest_phone, '+34111');

  const staffSource = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  assert.match(staffSource, /createWolfhouseDateChangeService/,
    'Staff router must compose the date-change service');
  assert.match(staffSource, /\/staff\/bot\/bookings\/date-change-quote/,
    'Staff router must expose the quote POST endpoint');
  assert.match(staffSource, /\/staff\/bot\/bookings\/date-change/,
    'Staff router must expose the move POST endpoint');
  assert.match(staffSource, /executeWolfhouseAccommodationQuote/,
    'date-change composition must use the real Staff accommodation pricing adapter');

  console.log('verify-wolfhouse-date-change: PASS');
}

main().catch((err) => { console.error(err); process.exit(1); });
