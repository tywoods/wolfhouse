'use strict';

const assert = require('node:assert/strict');
const {
  formatGuestPropertyAddress,
} = require('./lib/luna-guest-property-address');
const {
  buildWolfhousePaidConfirmationCopy,
} = require('./lib/luna-guest-confirmation-copy-style');
const {
  resolveConfirmationAddress,
} = require('./lib/luna-booking-confirmation-preview');

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
assert.equal(
  formatGuestPropertyAddress('Highway 1, 12345, 90265 Malibu, CA'),
  'Highway 1, 12345, Malibu, CA',
  'numbered street Highway 1 is not the house number',
);
assert.equal(
  formatGuestPropertyAddress('Calle 42, 12345, 28013 Madrid'),
  'Calle 42, 12345, Madrid',
  'numbered street Calle 42 is not the house number',
);
assert.equal(
  formatGuestPropertyAddress(formatGuestPropertyAddress('Highway 1, 12345, 90265 Malibu, CA')),
  'Highway 1, 12345, Malibu, CA',
  'numbered-street layout is idempotent',
);
assert.equal(
  formatGuestPropertyAddress('State Route 1, 12345, 90265 Malibu, CA'),
  'State Route 1, 12345, Malibu, CA',
  'State Route 1 keeps house 12345; 90265 next to town drops',
);
assert.equal(
  formatGuestPropertyAddress('Avenida 42, 12345, 28013 Madrid'),
  'Avenida 42, 12345, Madrid',
  'Avenida 42 keeps house 12345; 28013 next to town drops',
);
assert.equal(
  formatGuestPropertyAddress('County Road 12, 12345, 94103 San Francisco, CA'),
  'County Road 12, 12345, San Francisco, CA',
  'County Road 12 keeps house 12345',
);
assert.equal(
  formatGuestPropertyAddress('Carrera 7, 12345, 11011 Bogotá'),
  'Carrera 7, 12345, Bogotá',
  'Carrera 7 keeps house 12345; 11011 next to town drops',
);
assert.equal(
  formatGuestPropertyAddress(formatGuestPropertyAddress('State Route 1, 12345, 90265 Malibu, CA')),
  'State Route 1, 12345, Malibu, CA',
  'State Route layout is idempotent',
);
assert.equal(
  formatGuestPropertyAddress(formatGuestPropertyAddress('Avenida 42, 12345, 28013 Madrid')),
  'Avenida 42, 12345, Madrid',
  'Avenida 42 layout is idempotent',
);
assert.equal(
  formatGuestPropertyAddress(formatGuestPropertyAddress('County Road 12, 12345, 94103 San Francisco, CA')),
  'County Road 12, 12345, San Francisco, CA',
  'County Road layout is idempotent',
);
assert.equal(
  formatGuestPropertyAddress('Diagonal 123, 08005, Barcelona'),
  'Diagonal 123, Barcelona',
  '5-digit next to the town is the postcode; 123 on Diagonal is the house',
);
assert.equal(
  formatGuestPropertyAddress('Via Roma 12, 00100, Roma, RM'),
  'Via Roma 12, Roma, RM',
  'Italian CAP next to the town drops; RM region is not a keep-house signal',
);
assert.equal(
  formatGuestPropertyAddress(formatGuestPropertyAddress('State Route 1, 12345, 90265 Malibu, California')),
  'State Route 1, 12345, Malibu, California',
  'second pass keeps house 12345 when the region is spelled California',
);
assert.equal(
  formatGuestPropertyAddress('Calle Mayor, 12345, Madrid'),
  'Calle Mayor, 12345, Madrid',
  'standalone 5-digit is the house when the street has no number yet',
);
assert.equal(
  formatGuestPropertyAddress('Carretera 1, 12345, Madrid'),
  'Carretera 1, 12345, Madrid',
  'unlisted road label is not proof of a house; keep 12345',
);
assert.equal(
  formatGuestPropertyAddress('US 101, 12345, San Francisco, CA'),
  'US 101, 12345, San Francisco, CA',
  'unlisted US 101 is not proof of a house; keep 12345',
);
assert.equal(
  formatGuestPropertyAddress(formatGuestPropertyAddress('Carretera 1, 12345, 28013 Madrid')),
  'Carretera 1, 12345, Madrid',
  'Carretera with explicit postcode stays idempotent on the leftover house',
);
assert.equal(
  formatGuestPropertyAddress(formatGuestPropertyAddress('US 101, 12345, 94103 San Francisco, CA')),
  'US 101, 12345, San Francisco, CA',
  'US 101 with explicit postcode stays idempotent on the leftover house',
);
assert.equal(
  formatGuestPropertyAddress('Carretera Nacional 1, 12345, Madrid'),
  'Carretera Nacional 1, 12345, Madrid',
  'qualified unlisted road is not proof of a house; keep 12345',
);
assert.equal(
  formatGuestPropertyAddress('US Business 101, 12345, San Francisco, CA'),
  'US Business 101, 12345, San Francisco, CA',
  'qualified unlisted US Business is not proof of a house; keep 12345',
);
assert.equal(
  formatGuestPropertyAddress(formatGuestPropertyAddress('Carretera Nacional 1, 12345, 28013 Madrid')),
  'Carretera Nacional 1, 12345, Madrid',
  'Carretera Nacional with explicit postcode stays idempotent on leftover 12345',
);
assert.equal(
  formatGuestPropertyAddress(formatGuestPropertyAddress('US Business 101, 12345, 94103 San Francisco, CA')),
  'US Business 101, 12345, San Francisco, CA',
  'US Business with explicit postcode stays idempotent on leftover 12345',
);
assert.equal(
  formatGuestPropertyAddress('Route Nationale 7, 12345, Paris'),
  'Route Nationale 7, 12345, Paris',
  'Route Nationale 7 is a route, not a house; keep 12345',
);
assert.equal(
  formatGuestPropertyAddress('US Highway Business 101, 12345, San Francisco, CA'),
  'US Highway Business 101, 12345, San Francisco, CA',
  'US Highway Business 101 is a route, not a house; keep 12345',
);
assert.equal(
  formatGuestPropertyAddress(formatGuestPropertyAddress('Route Nationale 7, 12345, 75001 Paris')),
  'Route Nationale 7, 12345, Paris',
  'Route Nationale with explicit postcode stays idempotent on leftover 12345',
);
assert.equal(
  formatGuestPropertyAddress(formatGuestPropertyAddress('US Highway Business 101, 12345, 94103 San Francisco, CA')),
  'US Highway Business 101, 12345, San Francisco, CA',
  'US Highway Business with explicit postcode stays idempotent on leftover 12345',
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
  {
    address: 'Highway 1, 12345, 90265 Malibu, CA',
    expect: /Highway 1, 12345, Malibu, CA/,
    forbid: /90265/,
    name: 'numbered street Highway 1 keeps house 12345',
  },
  {
    address: 'Calle 42, 12345, 28013 Madrid',
    expect: /Calle 42, 12345, Madrid/,
    forbid: /28013/,
    name: 'numbered street Calle 42 keeps house 12345',
  },
  {
    address: 'State Route 1, 12345, 90265 Malibu, CA',
    expect: /State Route 1, 12345, Malibu, CA/,
    forbid: /90265/,
    name: 'State Route 1 keeps house 12345',
  },
  {
    address: 'Avenida 42, 12345, 28013 Madrid',
    expect: /Avenida 42, 12345, Madrid/,
    forbid: /28013/,
    name: 'Avenida 42 keeps house 12345',
  },
  {
    address: 'Diagonal 123, 08005, Barcelona',
    expect: /Diagonal 123, Barcelona/,
    forbid: /08005/,
    name: 'Diagonal house 123 drops Barcelona postcode',
  },
  {
    address: 'Via Roma 12, 00100, Roma, RM',
    expect: /Via Roma 12, Roma, RM/,
    forbid: /00100/,
    name: 'Via Roma house 12 drops CAP before Roma RM',
  },
  {
    address: 'Carretera 1, 12345, Madrid',
    expect: /Carretera 1, 12345, Madrid/,
    forbid: null,
    name: 'Carretera 1 keeps house 12345',
  },
  {
    address: 'US 101, 12345, San Francisco, CA',
    expect: /US 101, 12345, San Francisco, CA/,
    forbid: null,
    name: 'US 101 keeps house 12345',
  },
  {
    address: 'Carretera Nacional 1, 12345, Madrid',
    expect: /Carretera Nacional 1, 12345, Madrid/,
    forbid: null,
    name: 'Carretera Nacional 1 keeps house 12345',
  },
  {
    address: 'US Business 101, 12345, San Francisco, CA',
    expect: /US Business 101, 12345, San Francisco, CA/,
    forbid: null,
    name: 'US Business 101 keeps house 12345',
  },
  {
    address: 'Route Nationale 7, 12345, Paris',
    expect: /Route Nationale 7, 12345, Paris/,
    forbid: null,
    name: 'Route Nationale 7 keeps house 12345',
  },
  {
    address: 'US Highway Business 101, 12345, San Francisco, CA',
    expect: /US Highway Business 101, 12345, San Francisco, CA/,
    forbid: null,
    name: 'US Highway Business 101 keeps house 12345',
  },
  {
    address: 'Route Nationale 7, 12345, 75001 Paris',
    expect: /Route Nationale 7, 12345, Paris/,
    forbid: /75001/,
    name: 'Route Nationale 7 explicit postcode keeps leftover 12345',
  },
  {
    address: 'US Highway Business 101, 12345, 94103 San Francisco, CA',
    expect: /US Highway Business 101, 12345, San Francisco, CA/,
    forbid: /94103/,
    name: 'US Highway Business 101 explicit postcode keeps leftover 12345',
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

const draftResolved = resolveConfirmationAddress({ address: FULL }, { address: null });
assert.equal(draftResolved.source, 'confirmation_draft');
assert.equal(draftResolved.address, GUEST, 'draft address still drops the postcode');
assert.doesNotMatch(draftResolved.address, /39140/);

const idempotentRaw = [
  FULL,
  GUEST,
  '10 Rue de Rivoli, 75001 Paris',
  'Via Roma 12, 00100 Roma',
  '123 Main St, San Francisco, CA 94103',
  '10 Downing Street, SW1A 2AA London',
  '123 Main St, 94103-1234 San Francisco, CA',
  'C.P. 39140 Somo',
  '41\n39140 Somo\nCantabria',
  '12345 Main Street, 94103 San Francisco, CA',
  '12345 Broadway, New York, NY',
  'Calle Mayor, 12345, 28013 Madrid',
  'C.P.: 39140 Somo',
  'C. Puerto 41, Somo',
  'Calle Mayor 12, Capdepera',
  'C. Mies de La Ran, 41, 39140, Somo, Cantabria',
  'C. Mies de La Ran, 41 39140 Somo, Cantabria',
  'C. Mies de La Ran, 41, E-39140 Somo, Cantabria',
  '12345 Highway 1, Malibu, CA',
  'Calle Mayor 41, 28013, Madrid',
  'Via Roma 12, 00100, Roma',
  'C. Mies de La Ran 41, 39140, Somo, Cantabria',
  'Via Nazionale 8, 00184, Roma',
  'Highway 1, 12345, 90265 Malibu, CA',
  'Calle 42, 12345, 28013 Madrid',
  'State Route 1, 12345, 90265 Malibu, CA',
  'Avenida 42, 12345, 28013 Madrid',
  'County Road 12, 12345, 94103 San Francisco, CA',
  'Carrera 7, 12345, 11011 Bogotá',
  'Diagonal 123, 08005, Barcelona',
  'Via Roma 12, 00100, Roma, RM',
  'State Route 1, 12345, 90265 Malibu, California',
  'Calle Mayor, 12345, Madrid',
  'Carretera 1, 12345, Madrid',
  'US 101, 12345, San Francisco, CA',
  'Carretera 1, 12345, 28013 Madrid',
  'US 101, 12345, 94103 San Francisco, CA',
  'Carretera Nacional 1, 12345, Madrid',
  'US Business 101, 12345, San Francisco, CA',
  'Carretera Nacional 1, 12345, 28013 Madrid',
  'US Business 101, 12345, 94103 San Francisco, CA',
  'Route Nationale 7, 12345, Paris',
  'US Highway Business 101, 12345, San Francisco, CA',
  'Route Nationale 7, 12345, 75001 Paris',
  'US Highway Business 101, 12345, 94103 San Francisco, CA',
];
for (const raw of idempotentRaw) {
  const once = formatGuestPropertyAddress(raw);
  assert.equal(formatGuestPropertyAddress(once), once, 'idempotent ' + JSON.stringify(raw));
}

console.log('PASS luna guest property address');
