'use strict';

const assert = require('node:assert/strict');
const { actualApiFunction, bookingBody } = require('./verify-package-minimum-transport');
const { handleBotBookingCreateFromPlan } = require('./lib/staff-bot-v2-routes');
const {
  loadCancellationGuestBookings,
  mapCancellationGuestBookingRows,
} = require('./lib/luna-guest-booking-disambiguation');

(async () => {
  let committed = null;
  const freshPlan = bookingBody({
    guest_name: 'Luna Route Guest', phone: '+34 555 123 456',
    payment_choice: 'no_payment_yet',
  });
  const create = await handleBotBookingCreateFromPlan({}, {}, null, 'bot_token', {
    readBody: async () => JSON.stringify(freshPlan),
    sendJSON: (_res, status, body) => ({ status, body }),
    send400: (_res, error) => ({ status: 400, body: { success: false, error } }),
    appendAuditLog: () => {}, DEFAULT_CLIENT: 'wolfhouse-somo', STAFF_AUTH_REQUIRED: false,
    stampBookingCreateSource: require('./lib/booking-create-source-attribution').stampBookingCreateSource,
    handleBotBookingCreate: async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      committed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true, write_performed: true, created: true,
        booking_id: '6fca7c66-4778-45ca-b622-313621bf0db4',
        booking_code: 'WH-PR1567', status: 'hold', payment_status: 'unpaid',
      }));
    },
    handlePostBookingTransfer: () => { throw Error('no transfer requested'); },
    handleBotGuestPaymentCreateLink: () => { throw Error('no payment link requested'); },
    STRIPE_LINKS_ENABLED: false, STRIPE_SECRET_KEY: '', process: { env: {} },
  });
  assert.equal(create.status, 200);
  assert.equal(create.body.write_performed, true);
  assert.equal(create.body.booking_code, 'WH-PR1567');
  assert(committed, 'fresh Luna plan must reach the actual Staff create route write boundary');

  const persisted = {
    booking_id: '6fca7c66-4778-45ca-b622-313621bf0db4',
    booking_code: 'WH-PR1567', client_slug: 'wolfhouse-somo',
    check_in: '2027-05-20', check_out: '2027-05-23',
    status: 'hold', payment_status: 'unpaid', guest_count: 1,
    guest_name: 'Luna Route Guest',
    conversation_id: '59a575d4-6d39-4ba7-bb64-ece151ea1121',
  };
  const pg = { async query(sql, params) {
    assert(!String(sql).includes('b.conversation_id'),
      'readback must not reference the nonexistent bookings column');
    assert.match(String(sql), /FROM conversations cv/,
      'readback derives authority from the real conversations relation');
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
  assert.equal(response.body.bookings[0].conversation_id, persisted.conversation_id);
  console.log('PR1567 list_my_bookings actual Staff route readback passed');
})().catch((error) => { console.error(error); process.exit(1); });