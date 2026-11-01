#!/usr/bin/env node
'use strict';

/**
 * Luna contract: stamp provider-accepted on booking_confirmation_owed;
 * Meta delivery remains the only terminal clear. Lookup still-owed rows.
 */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const owed = require('./lib/staff-booking-confirmation-owed');

const ROOT = path.join(__dirname, '..');
const BOOKING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const WAMID = 'wamid.KATHI-ACK-1';

function makePg(state) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const s = String(sql);
      calls.push({ sql: s, params: params ? [...params] : [] });
      if (/FROM bookings b[\s\S]*JOIN clients/i.test(s) && /b\.id = \$2/i.test(s)) {
        if (state.bookingMissing) return { rows: [] };
        return { rows: [{ booking_id: BOOKING, booking_code: 'WH-20270310-13389959', phone: '+4911111111', client_id: 'client-1' }] };
      }
      if (/FROM booking_confirmation_owed[\s\S]*WHERE booking_id = \$1/i.test(s) && /SELECT/i.test(s) && !/UPDATE/i.test(s) && !/JOIN bookings/i.test(s)) {
        if (state.owedMissing) return { rows: [] };
        return { rows: [state.owedRow || { booking_id: BOOKING, provider_message_id: null, cleared_at: null }] };
      }
      if (/SET provider_message_id/i.test(s)) {
        state.owedRow = { booking_id: BOOKING, provider_message_id: params[1], cleared_at: null };
        return { rows: [{ booking_id: BOOKING, provider_message_id: params[1], cleared_at: null }] };
      }
      if (/INSERT INTO booking_confirmation_delivery_events/i.test(s)) {
        return { rows: state.deliveryEvent ? [] : [{ provider_message_id: params[0] }] };
      }
      if (/FROM booking_confirmation_delivery_events/i.test(s)) {
        return { rows: state.deliveryEvent ? [{ provider_message_id: params[0] }] : [] };
      }
      if (/SET[\s\S]*cleared_at = NOW/i.test(s)) {
        if (!state.deliveryEvent) return { rows: [] };
        return { rows: [{ booking_id: BOOKING, cleared_at: new Date().toISOString(), clear_reason: 'delivered' }] };
      }
      if (/FROM booking_confirmation_owed o[\s\S]*JOIN bookings b/i.test(s)) {
        if (state.owedMissing || (state.owedRow && state.owedRow.cleared_at)) return { rows: [] };
        return { rows: [{
          booking_id: BOOKING,
          booking_code: 'WH-20270310-13389959',
          conversation_id: CONV,
          owed_at: '2026-11-01T17:00:00.000Z',
          provider_message_id: (state.owedRow && state.owedRow.provider_message_id) || null,
        }] };
      }
      if (/SAVEPOINT|RELEASE|ROLLBACK TO/i.test(s)) return { rows: [] };
      throw new Error('unexpected SQL: ' + s.slice(0, 180));
    },
  };
}

async function main() {
  assert.equal(typeof owed.stampConfirmationAcceptedForBooking, 'function');
  assert.equal(typeof owed.listOpenConfirmationOwed, 'function');

  const missingBooking = await owed.stampConfirmationAcceptedForBooking(makePg({ bookingMissing: true }), {
    client_slug: 'wolfhouse-somo',
    booking_id: BOOKING,
    provider_message_id: WAMID,
  });
  assert.equal(missingBooking.ok, false);
  assert.equal(missingBooking.stamped, false);
  assert.equal(missingBooking.cause, 'booking_not_found');
  assert.equal(missingBooking.cleared, false);

  const missingOwed = await owed.stampConfirmationAcceptedForBooking(makePg({ owedMissing: true }), {
    client_slug: 'wolfhouse-somo',
    booking_id: BOOKING,
    provider_message_id: WAMID,
  });
  assert.equal(missingOwed.ok, false);
  assert.equal(missingOwed.stamped, false);
  assert.equal(missingOwed.cause, 'owed_row_not_found');
  assert.equal(missingOwed.cleared, false);

  const noProvider = await owed.stampConfirmationAcceptedForBooking(makePg({}), {
    client_slug: 'wolfhouse-somo',
    booking_id: BOOKING,
    provider_message_id: '',
  });
  assert.equal(noProvider.ok, false);
  assert.equal(noProvider.stamped, false);
  assert.equal(noProvider.cleared, false);
  assert.equal(noProvider.cause, 'provider_message_id_required');

  const pgAck = makePg({});
  const ack = await owed.stampConfirmationAcceptedForBooking(pgAck, {
    client_slug: 'wolfhouse-somo',
    booking_id: BOOKING,
    provider_message_id: WAMID,
  });
  assert.equal(ack.ok, true);
  assert.equal(ack.stamped, true);
  assert.equal(ack.idempotent, false);
  assert.equal(ack.cleared, false, 'accept must not clear without Meta delivered');
  assert.equal(ack.booking_id, BOOKING);
  assert.equal(ack.provider_message_id, WAMID);
  assert.ok(pgAck.calls.some((c) => /SET provider_message_id/i.test(c.sql)));
  assert.ok(!pgAck.calls.some((c) => /cleared_at = NOW/i.test(c.sql) && c.params && c.params.length && !pgAck.calls.some((d) => /delivery_events/i.test(d.sql))));

  const pgAgain = makePg({ owedRow: { booking_id: BOOKING, provider_message_id: WAMID, cleared_at: null } });
  const again = await owed.stampConfirmationAcceptedForBooking(pgAgain, {
    client_slug: 'wolfhouse-somo',
    booking_id: BOOKING,
    provider_message_id: WAMID,
  });
  assert.equal(again.ok, true);
  assert.equal(again.stamped, true);
  assert.equal(again.idempotent, true);
  assert.equal(again.cleared, false);

  const pgClearedOther = makePg({
    owedRow: { booking_id: BOOKING, provider_message_id: 'wamid.A', cleared_at: '2026-11-01T18:00:00.000Z' },
  });
  const mismatch = await owed.stampConfirmationAcceptedForBooking(pgClearedOther, {
    client_slug: 'wolfhouse-somo',
    booking_id: BOOKING,
    provider_message_id: 'wamid.B',
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.stamped, false);
  assert.equal(mismatch.idempotent, false);
  assert.equal(mismatch.cause, 'provider_message_id_mismatch');
  assert.equal(mismatch.stored_provider_message_id, 'wamid.A');
  assert.equal(mismatch.provider_message_id, 'wamid.B');
  assert.ok(!pgClearedOther.calls.some((c) => /SET provider_message_id/i.test(c.sql)), 'must not stamp B over cleared A');

  const open = await owed.listOpenConfirmationOwed(makePg({ owedRow: { booking_id: BOOKING, provider_message_id: WAMID, cleared_at: null } }), {
    client_slug: 'wolfhouse-somo',
    conversation_id: CONV,
  });
  assert.equal(open.ok, true);
  assert.equal(open.owed.length, 1);
  assert.equal(open.owed[0].booking_id, BOOKING);
  assert.equal(open.owed[0].booking_code, 'WH-20270310-13389959');
  assert.equal(open.owed[0].conversation_id, CONV);
  assert.equal(open.owed[0].provider_message_id, WAMID);

  const none = await owed.listOpenConfirmationOwed(makePg({}), {
    client_slug: 'wolfhouse-somo',
  });
  assert.equal(none.ok, false);
  assert.equal(none.cause, 'conversation_id_or_booking_id_required');

  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  assert.match(apiSrc, /\/staff\/bot\/booking-confirmation-owed\/accepted/);
  assert.match(apiSrc, /\/staff\/bot\/booking-confirmation-owed\/open/);
  assert.match(apiSrc, /stampConfirmationAcceptedForBooking/);
  assert.match(apiSrc, /listOpenConfirmationOwed/);
  assert.doesNotMatch(
    apiSrc.slice(apiSrc.indexOf('handleBotConfirmationOwedAccepted') >= 0 ? apiSrc.indexOf('handleBotConfirmationOwedAccepted') : 0,
      (apiSrc.indexOf('handleBotConfirmationOwedAccepted') >= 0 ? apiSrc.indexOf('handleBotConfirmationOwedAccepted') : 0) + 2500),
    /clearConfirmationOwedOnDelivery/,
  );

  console.log('ok confirmation owed accept stamp and open lookup');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
