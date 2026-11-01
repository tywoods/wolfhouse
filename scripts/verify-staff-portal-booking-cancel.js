#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const lib = require('./lib/staff-portal-booking-cancel');
const guest = require('./lib/guest-unpaid-cancellation');
const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');

assert.equal(
  lib.explainStaffBookingCancelError({ message: 'cancelled_booking_has_collectible_payment' }),
  'This booking still has an open unpaid payment or payment link. Cancel cannot finish until those unpaid rows are closed.',
);
assert.equal(
  lib.explainStaffBookingCancelError({ message: 'weird_sql' }),
  'Could not cancel this booking: weird_sql',
);
assert.equal(
  lib.explainStaffBookingCancelError({ message: 'payment_exists' }),
  'This booking has collected money. Cancel from here cannot refund it.',
);
assert.equal(
  lib.explainStaffBookingCancelError({ message: 'payment_race_or_evidence_changed' }),
  'Payment evidence changed while cancelling. Nothing was cancelled.',
);

const portal = api.slice(
  api.indexOf('async function handleBookingCancel'),
  api.indexOf('async function handleBotBookingCancel'),
);
assert.doesNotMatch(portal, /error: 'cancel failed'/);
assert.match(portal, /executeStaffUnpaidCancellationBoundary/);
assert.match(portal, /explainStaffBookingCancelError/);
assert.match(api, /data\.detail/);
assert.match(portal, /409/);

const evidence = {
  booking_found: true,
  phone_matches: true,
  booking_id: '68ea258c-6709-42a3-b984-b3892c619ae9',
  client_id: 'client-1',
  booking_code: 'WH-20270310-13389959',
  booking_status: 'payment_pending',
  booking_payment_status: 'waiting_payment',
  booking_amount_paid_cents: 0,
  booking_deposit_paid_cents: 0,
  payment_row_count: 3,
  payment_inert_draft_count: 0,
  payment_provider_active_count: 2,
  payment_positive_count: 0,
  payment_unknown_amount_count: 0,
  payment_captured_count: 0,
  payment_unknown_status_count: 0,
  payment_event_paid_count: 0,
  guest_row_count: 2,
  guest_positive_count: 0,
  guest_paid_status_count: 0,
  guest_unknown_status_count: 0,
  guest_unknown_amount_count: 0,
  evidence_consistent: true,
};

assert.deepEqual(
  guest.classifyGuestCancellationPaymentEvidence({
    ...evidence,
    booking_amount_paid_cents: 40000,
    payment_captured_count: 0,
    payment_positive_count: 0,
  }),
  { eligible: false, reason: 'payment_exists' },
  'recorded booking money with no captured payments row still blocks',
);

assert.ok(typeof lib.executeStaffUnpaidCancellationBoundary === 'function');
assert.match(lib.STAFF_CANCEL_PAYMENT_EVIDENCE_SQL, /FOR UPDATE OF b/i);
assert.match(lib.STAFF_CANCEL_PAYMENT_EVIDENCE_SQL, /booking_amount_paid_cents/);
assert.match(lib.STAFF_CANCEL_PAYMENT_EVIDENCE_SQL, /guest_positive_count/);
assert.match(lib.STAFF_CANCEL_BOOKING_UPDATE_SQL, /COALESCE\(b\.amount_paid_cents,0\)=0/);
assert.match(lib.STAFF_CANCEL_BOOKING_UPDATE_SQL, /NOT EXISTS[\s\S]*payments/);
assert.doesNotMatch(lib.STAFF_CANCEL_BOOKING_UPDATE_SQL, /regexp_replace\(COALESCE\(b\.phone/);

function fakePg({ initial, recheck, updateRows, throwOnUpdate }) {
  return {
    evidenceCalls: 0,
    locks: [],
    async query(sql) {
      const s = String(sql);
      if (/SAVEPOINT |ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT/i.test(s)) return { rows: [] };
      if (/FOR UPDATE OF b/i.test(s) || s === lib.STAFF_CANCEL_PAYMENT_EVIDENCE_SQL || s === guest.GUEST_CANCEL_PAYMENT_EVIDENCE_SQL) {
        this.evidenceCalls += 1;
        return { rows: [this.evidenceCalls === 1 ? initial : recheck] };
      }
      if (/FROM payments p[\s\S]*FOR UPDATE/i.test(s)) { this.locks.push('payments'); return { rows: [] }; }
      if (/FROM booking_guests[\s\S]*FOR UPDATE/i.test(s)) { this.locks.push('guests'); return { rows: [] }; }
      if (/FROM payment_events[\s\S]*FOR UPDATE/i.test(s)) { this.locks.push('events'); return { rows: [] }; }
      if (/payment_events pe/i.test(s) && /COUNT/i.test(s)) return { rows: [{ c: 0 }] };
      if (s === guest.GUEST_CANCEL_RETIRE_ZERO_PAID_PAYMENTS_SQL || /UPDATE payments[\s\S]*status='cancelled'/i.test(s)) {
        return { rows: [{ id: 'p1' }], rowCount: 1 };
      }
      if (throwOnUpdate && /UPDATE bookings/i.test(s)) {
        const err = new Error('cancelled_booking_has_collectible_payment');
        throw err;
      }
      if (/UPDATE bookings/i.test(s)) return { rows: updateRows || [] };
      return { rows: [] };
    },
  };
}

Promise.resolve()
  .then(async () => {
    const unpaid = fakePg({ initial: evidence, recheck: evidence, updateRows: [{ booking_id: evidence.booking_id, status: 'cancelled' }] });
    const ok = await lib.executeStaffUnpaidCancellationBoundary(unpaid, {
      clientSlug: 'wolfhouse-somo',
      bookingId: evidence.booking_id,
    });
    assert.equal(ok.blocked, false);
    assert.ok(unpaid.locks.includes('payments'));
    assert.ok(unpaid.locks.includes('guests'));
    assert.equal(unpaid.evidenceCalls >= 2, true, 'must re-read evidence after locks');

    const recorded = fakePg({
      initial: { ...evidence, booking_amount_paid_cents: 40000 },
      recheck: { ...evidence, booking_amount_paid_cents: 40000 },
      updateRows: [],
    });
    const blocked = await lib.executeStaffUnpaidCancellationBoundary(recorded, {
      clientSlug: 'wolfhouse-somo',
      bookingId: evidence.booking_id,
    });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.reason, 'payment_exists');

    const race = fakePg({ initial: evidence, recheck: evidence, updateRows: [] });
    const raced = await lib.executeStaffUnpaidCancellationBoundary(race, {
      clientSlug: 'wolfhouse-somo',
      bookingId: evidence.booking_id,
    });
    assert.equal(raced.blocked, true);
    assert.equal(raced.reason, 'payment_race_or_evidence_changed');

    assert.equal(lib.staffCancelConflictStatus({ message: 'cancelled_booking_has_collectible_payment' }), 409);
    assert.equal(lib.staffCancelConflictStatus({ message: 'boom' }), 500);

    console.log('ok staff portal unpaid cancel shares locked evidence sequence');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
