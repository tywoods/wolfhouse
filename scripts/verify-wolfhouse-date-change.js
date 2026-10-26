'use strict';

const assert = require('assert');
const {
  createWolfhouseDateChangeService,
  routeWolfhouseDateChangeRequest,
} = require('./lib/wolfhouse-date-change');

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
        return { rows: [{ ...state.booking }] };
      }
      if (/UPDATE booking_beds/.test(sql)) return { rows: state.assignments.map((row) => ({ ...row, check_in: params[2], check_out: params[3] })) };
      throw new Error(`unexpected SQL: ${String(sql).slice(0, 100)}`);
    },
  };
}

async function main() {
  const state = {
    booking: { booking_id: 'b1', booking_code: 'WH-1', client_id: 'c1', client_slug: 'wolfhouse-somo', guest_phone: '+34111', check_in: '2027-05-01', check_out: '2027-05-05', guest_count: 1, status: 'confirmed', total_amount_cents: 20000, deposit_required_cents: 5000, amount_paid_cents: 5000, balance_due_cents: 15000 },
    assignments: [{ booking_bed_id: 'bb1', bed_id: 'bed1', bed_code: 'R1-B1', room_code: 'R1' }],
    conflicts: [],
  };
  const pg = fakePg(state);
  let quoted = null;
  const service = createWolfhouseDateChangeService({
    withPgClient: async (fn) => fn(pg),
    quoteNewDates: async (input) => { quoted = input; return { success: true, total_cents: 42000, currency: 'EUR', quote_id: 'q1', deposit_cents: 12000 }; },
    tokenSecret: 'unit-test-date-change-secret-32bytes-minimum',
    now: () => new Date('2026-10-26T20:00:00Z'),
  });

  const preview = await service.quote({ client_slug: 'wolfhouse-somo', booking_code: 'WH-1', guest_phone: '+34111', new_check_in: '2027-06-01', new_check_out: '2027-06-05' });
  assert.equal(preview.success, true);
  assert.equal(preview.can_move, true);
  assert.equal(preview.write_performed, false);
  assert.equal(quoted.exclude_booking_id, 'b1', 'quote must exclude the booking being moved');
  assert.deepEqual(quoted.selected_bed_codes, ['R1-B1']);
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
  assert.equal(state.booking.total_amount_cents, 42000, 'accepted quote total must replace stale booking total');
  assert.equal(state.booking.deposit_required_cents, 12000, 'accepted quote deposit must replace stale booking deposit');
  assert.equal(state.booking.amount_paid_cents, 5000, 'existing paid amount remains receipt-owned');
  assert.equal(state.booking.balance_due_cents, 37000, 'balance must be recomputed from accepted total and paid receipts');
  assert.equal(pg.calls.filter((call) => /INSERT INTO bookings/.test(call.sql)).length, 0, 'must not create a second booking');
  assert.equal(pg.calls.filter((call) => /DELETE FROM bookings/.test(call.sql)).length, 0, 'must not cancel/rebook');

  const denied = await service.quote({ client_slug: 'wolfhouse-somo', booking_code: 'WH-1', guest_phone: '+34999', new_check_in: '2027-07-01', new_check_out: '2027-07-05' });
  assert.equal(denied.reason_code, 'booking_owner_mismatch');

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

  console.log('verify-wolfhouse-date-change: PASS');
}

main().catch((err) => { console.error(err); process.exit(1); });
