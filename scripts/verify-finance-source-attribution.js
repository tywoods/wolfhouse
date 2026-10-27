'use strict';
const assert = require('assert/strict');
const { stampBookingCreateSource } = require('./lib/booking-create-source-attribution');
const { computeWolfhouseCreatorFinance } = require('./lib/sunset-finance-summary');

const luna = stampBookingCreateSource({ source: 'plugin-spoof', nested: { source: 'spoof' } }, 'bot_token', null);
assert.equal(luna.source, 'luna_guest', 'Luna service principal wins over plugin source');
const staff = stampBookingCreateSource({ source: 'luna_guest' }, 'staff_portal', { staff_user_id: 's-1' });
assert.equal(staff.source, 'staff', 'staff principal wins over plugin source');
assert.equal(staff.source, 'staff');

const finance = computeWolfhouseCreatorFinance({
  now: '2026-10-27T12:00:00.000Z',
  view: { granularity: 'day', anchor: '2026-10-27' },
  clientSlug: 'wolfhouse-somo', currency: 'EUR',
  bookings: [
    { booking_id: 'luna', created_at: '2026-10-27T10:00:00Z', total_amount_cents: 10000, currency: 'EUR', metadata: { source: 'luna_guest' } },
    { booking_id: 'legacy', created_at: '2026-10-27T10:00:00Z', total_amount_cents: 5000, currency: 'EUR', metadata: {} },
  ], payments: [], refund_records: [], bsr: [],
});
const byCreator = new Map(finance.creators.map(row => [row.creator, row]));
assert.equal(byCreator.get('luna').new_booking_count.count, 1, 'persisted luna_guest is Luna');
assert.equal(byCreator.get('staff').new_booking_count.count, 1, 'unattributed persisted metadata is Staff');
assert.equal(byCreator.has('unattributed'), false, 'Finance does not display an unattributed bucket');
console.log('PASS verify-finance-source-attribution');
