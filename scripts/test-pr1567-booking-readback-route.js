'use strict';

const assert = require('node:assert/strict');
const { actualApiFunction } = require('./verify-package-minimum-transport');
const {
  loadCancellationGuestBookings,
  mapCancellationGuestBookingRows,
} = require('./lib/luna-guest-booking-disambiguation');

(async () => {
  const persisted = {
    booking_id: '6fca7c66-4778-45ca-b622-313621bf0db4',
    booking_code: 'WH-PR1567', client_slug: 'wolfhouse-somo',
    check_in: '2027-05-20', check_out: '2027-05-23',
    status: 'hold', payment_status: 'unpaid', guest_count: 1,
    guest_name: 'Luna Route Guest',
  };
  const pg = { async query(sql, params) {
    assert(!String(sql).includes('conversation_id'),
      'readback must only select columns present on the bookings schema');
    assert.deepEqual(params, ['%555123456%', 'wolfhouse-somo']);
    return { rows: [persisted] };
  } };
  const route = actualApiFunction('handleBotListBookingsByPhone', {
    readBody: async () => JSON.stringify({ phone: '+34 555 123 456' }),
    sendJSON: (_res, status, body) => ({ status, body }),
    send400: (_res, error) => ({ status: 400, body: { success: false, error } }),
    resolveBotHandlerTrustedClientSlug: () => 'wolfhouse-somo',
    SQL_INJECT_RE: /$a/,
    DEFAULT_CLIENT: 'wolfhouse-somo',
    withPgClient: (fn) => fn(pg),
    loadCancellationGuestBookings,
    mapCancellationGuestBookingRows,
  });
  const response = await route({}, {}, null, 'bot_token');
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.count, 1);
  assert.equal(response.body.bookings[0].booking_code, 'WH-PR1567');
  assert.equal(response.body.bookings[0].conversation_id, undefined);
  console.log('PR1567 list_my_bookings actual Staff route readback passed');
})().catch((error) => { console.error(error); process.exit(1); });