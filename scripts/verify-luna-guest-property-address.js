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
assert.equal(formatGuestPropertyAddress('C.P. 39140 Somo'), 'Somo', 'C.P. labelled postcode drops');
assert.equal(
  formatGuestPropertyAddress('41\n39140 Somo\nCantabria'),
  '41, Somo, Cantabria',
  'multiline postal line drops',
);
assert.equal(
  formatGuestPropertyAddress('12345 Main Street, 94103 San Francisco, CA'),
  '12345 Main Street, San Francisco, CA',
  '5-digit house number is not a postcode',
);
assert.equal(
  formatGuestPropertyAddress('12345 Broadway, New York, NY'),
  '12345 Broadway, New York, NY',
  'house number next to a street name stays',
);
assert.equal(
  formatGuestPropertyAddress('Calle Mayor, 12345, 28013 Madrid'),
  'Calle Mayor, 12345, Madrid',
  'standalone house number before postcode-city stays',
);
assert.equal(
  formatGuestPropertyAddress('C.P.: 39140 Somo'),
  'Somo',
  'labelled C.P.: postcode drops',
);
assert.equal(
  formatGuestPropertyAddress('C. Puerto 41, Somo'),
  'C. Puerto 41, Somo',
  'C. Puerto is a street, not a C.P. label',
);
assert.equal(
  formatGuestPropertyAddress('Calle Mayor 12, Capdepera'),
  'Calle Mayor 12, Capdepera',
  'Capdepera is a town, not a CAP label',
);
assert.equal(
  formatGuestPropertyAddress('C. Mies de La Ran, 41, 39140, Somo, Cantabria'),
  'C. Mies de La Ran, 41, Somo, Cantabria',
  'standalone middle 5-digit before a city is a postcode',
);
assert.equal(
  formatGuestPropertyAddress('C. Mies de La Ran, 41 39140 Somo, Cantabria'),
  'C. Mies de La Ran, 41, Somo, Cantabria',
  'single-line Spanish postcode drops',
);
assert.equal(
  formatGuestPropertyAddress('C. Mies de La Ran, 41, E-39140 Somo, Cantabria'),
  'C. Mies de La Ran, 41, Somo, Cantabria',
  'E-39140 country-prefixed postcode drops',
);
assert.equal(
  formatGuestPropertyAddress('12345 Highway 1, Malibu, CA'),
  '12345 Highway 1, Malibu, CA',
  'Highway house number stays',
);
assert.equal(
  formatGuestPropertyAddress('Calle Mayor 41, 28013, Madrid'),
  'Calle Mayor 41, Madrid',
  'postcode after street-line house number drops',
);
assert.equal(
  formatGuestPropertyAddress('Via Roma 12, 00100, Roma'),
  'Via Roma 12, Roma',
  'Italian CAP after street-line house number drops',
);
assert.equal(
  formatGuestPropertyAddress('C. Mies de La Ran 41, 39140, Somo, Cantabria'),
  'C. Mies de La Ran 41, Somo, Cantabria',
  'Spanish 5-digit after street-line house number drops',
);
assert.equal(
  formatGuestPropertyAddress('Via Nazionale 8, 00184, Roma'),
  'Via Nazionale 8, Roma',
  'Italian CAP 00184 drops',
);
assert.equal(
  formatGuestPropertyAddress(formatGuestPropertyAddress('Calle Mayor 41, 28013, Madrid')),
  'Calle Mayor 41, Madrid',
  'street-line house number stay is idempotent',
);

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

const confirmationCases = [
  {
    address: '12345 Broadway, New York, NY',
    expect: /12345 Broadway, New York, NY/,
    forbid: null,
    name: 'Broadway house number',
  },
  {
    address: 'Calle Mayor, 12345, 28013 Madrid',
    expect: /Calle Mayor, 12345, Madrid/,
    forbid: /28013/,
    name: 'Calle Mayor house number',
  },
  {
    address: 'C.P.: 39140 Somo',
    expect: /\bSomo\b/,
    forbid: /39140/,
    name: 'C.P.: labelled postcode',
  },
  {
    address: 'C. Puerto 41, Somo',
    expect: /C\. Puerto 41, Somo/,
    forbid: null,
    name: 'C. Puerto street kept',
  },
  {
    address: 'Calle Mayor 12, Capdepera',
    expect: /Calle Mayor 12, Capdepera/,
    forbid: /\bdepera\b/,
    name: 'Capdepera town kept',
  },
  {
    address: 'C. Mies de La Ran, 41, 39140, Somo, Cantabria',
    expect: /C\. Mies de La Ran, 41, Somo, Cantabria/,
    forbid: /39140/,
    name: 'middle standalone postcode',
  },
  {
    address: 'C. Mies de La Ran, 41 39140 Somo, Cantabria',
    expect: /C\. Mies de La Ran, 41, Somo, Cantabria/,
    forbid: /39140/,
    name: 'single-line Spanish postcode',
  },
  {
    address: 'C. Mies de La Ran, 41, E-39140 Somo, Cantabria',
    expect: /C\. Mies de La Ran, 41, Somo, Cantabria/,
    forbid: /39140/,
    name: 'E-39140 postcode',
  },
  {
    address: 'Calle Mayor 41, 28013, Madrid',
    expect: /Calle Mayor 41, Madrid/,
    forbid: /28013/,
    name: 'street-line house then 28013',
  },
  {
    address: 'Via Roma 12, 00100, Roma',
    expect: /Via Roma 12, Roma/,
    forbid: /00100/,
    name: 'street-line house then Italian CAP',
  },
];
for (const language of ['en', 'es', 'it']) {
  for (const row of confirmationCases) {
    const message = buildWolfhousePaidConfirmationCopy({ ...facts, language, address: row.address });
    assert.match(message, row.expect, language + ' ' + row.name);
    if (row.forbid) assert.doesNotMatch(message, row.forbid, language + ' ' + row.name + ' drops postcode');
    assert.match(message, /🗺️ https:\/\/maps\.example\/wolfhouse/, language + ' ' + row.name + ' maps');
  }
}

const { buildCheckinDayMessageBody } = require('./lib/luna-guest-checkin-day-message');
const checkin = buildCheckinDayMessageBody(
  { client_slug: 'wolfhouse-somo', language: 'en', address: '   ' },
  { loadClientCheckinConfig: () => ({ address: FULL, gate_code: '9999' }) },
);
assert.match(checkin.message_text, /C\. Mies de La Ran, 41, Somo, Cantabria/, 'whitespace address falls back to config then formats');
assert.doesNotMatch(checkin.message_text, /39140/);
assert.doesNotMatch(checkin.message_text, /\(address on file\)/);
assert.equal(checkin.address, GUEST);

console.log('PASS luna guest property address');
