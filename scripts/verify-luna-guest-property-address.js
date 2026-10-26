'use strict';

const assert = require('node:assert/strict');
const {
  formatGuestPropertyAddress,
} = require('./lib/luna-guest-property-address');
const {
  buildWolfhousePaidConfirmationCopy,
} = require('./lib/luna-guest-confirmation-copy-style');

const FULL = 'C. Mies de La Ran, 41, 39140 Somo, Cantabria';
const GUEST = 'C. Mies de La Ran, 41, Somo, Cantabria';

assert.equal(formatGuestPropertyAddress(FULL), GUEST, 'ES 5-digit postcode drops, rest of line unchanged');
assert.equal(formatGuestPropertyAddress(GUEST), GUEST, 'already-guest address stays unchanged');
assert.equal(formatGuestPropertyAddress('10 Rue de Rivoli, 75001 Paris'), '10 Rue de Rivoli, Paris');
assert.equal(formatGuestPropertyAddress('Via Roma 12, 00100 Roma'), 'Via Roma 12, Roma');
assert.equal(formatGuestPropertyAddress('123 Main St, San Francisco, CA 94103'), '123 Main St, San Francisco, CA');
assert.equal(formatGuestPropertyAddress('10 Downing Street, SW1A 2AA London'), '10 Downing Street, London');
assert.equal(formatGuestPropertyAddress('123 Main St, 94103-1234 San Francisco, CA'), '123 Main St, San Francisco, CA');
assert.equal(formatGuestPropertyAddress(''), '');
assert.equal(formatGuestPropertyAddress(null), '');

const facts = {
  guest_name: 'Ada',
  booking_code: 'WH-20261108-1281',
  payment_status: 'deposit_paid',
  amount_paid_cents: 20000,
  balance_due_cents: 20000,
  total_amount_cents: 40000,
  check_in: '2026-11-01',
  check_out: '2026-11-09',
  guest_count: 1,
  room_kind: 'mixed shared',
  check_in_time: '15:00',
  address: FULL,
  maps_link: 'https://maps.example/wolfhouse',
};

for (const language of ['en', 'es', 'it']) {
  const message = buildWolfhousePaidConfirmationCopy({ ...facts, language });
  assert.match(message, /C\. Mies de La Ran, 41, Somo, Cantabria/, language + ' guest address');
  assert.doesNotMatch(message, /39140/, language + ' must not print the postcode');
  assert.match(message, /🗺️ https:\/\/maps\.example\/wolfhouse/, language + ' maps link stays');
}

console.log('PASS luna guest property address');
