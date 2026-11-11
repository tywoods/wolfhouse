'use strict';

const assert = require('node:assert/strict');
const { buildWolfhousePaidConfirmationCopy } = require('./lib/luna-guest-confirmation-copy-style');

const base = {
  language: 'en',
  guest_name: 'Jim',
  booking_code: 'WH-20270401-15504585',
  payment_status: 'deposit_paid',
  amount_paid_cents: 10000,
  balance_due_cents: 20000,
  total_amount_cents: 30000,
  check_in: '2027-04-01',
  check_out: '2027-04-05',
  guest_count: 3,
  gate_code: '2684#',
};

const r3 = buildWolfhousePaidConfirmationCopy({
  ...base,
  assigned_rooms: [{ number: 'R3', type: 'matrimonial_or_mixed' }],
  room_kinds: ['private or mixed'],
  room_number: 'R3',
});
assert.match(r3, /🛏️ \*Room:\* Room 3, mixed shared room/);
assert.doesNotMatch(r3, /A private or mixed room/);
assert.doesNotMatch(r3, /\bdorm/i);

const split = buildWolfhousePaidConfirmationCopy({
  ...base,
  assigned_rooms: [
    { number: 'R1', type: 'mixed' },
    { number: 'R1', type: 'mixed' },
    { number: 'R2', type: 'mixed' },
  ],
});
assert.match(split, /🛏️ \*Room:\* Room 1, mixed shared room, Room 2, mixed shared room/);

const unknown = buildWolfhousePaidConfirmationCopy({
  ...base,
  room_kinds: ['private or mixed'],
  requested_room_type: 'matrimonial_or_mixed',
});
assert.doesNotMatch(unknown, /🛏️/);
assert.doesNotMatch(unknown, /A private or mixed room/);

console.log('verify-pay-room-paid-confirmation: PASS');
