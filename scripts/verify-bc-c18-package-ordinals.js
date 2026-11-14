'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  normalizeGuestPackagesInput,
  resolveBotBookingPackageContext,
} = require('./lib/bot-booking-package-normalize');

function context(guestPackages) {
  return resolveBotBookingPackageContext({
    guestPackages, guestCount: 2, packageCode: 'malibu',
    checkIn: '2026-11-01', checkOut: '2026-11-08', config: {},
  });
}

test('C18: explicit invalid ordinals are unresolved, never silently replaced by index', () => {
  for (const ordinal of [0, -1, 1.5, 3]) {
    const raw = [{ guest_number: ordinal, package_code: 'malibu' }, { guest_number: 2, package_code: 'package_none' }];
    const result = normalizeGuestPackagesInput(raw, 2);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.guest_packages, raw);
    assert.equal(result.guest_package_association.status, 'unresolved');
    assert.equal(result.guest_package_association.issues[0].code, 'invalid_guest_number');
    assert.deepEqual(context(raw).guest_package_association, result.guest_package_association);
  }
});

test('C18: omitted ordinals retain positional compatibility and numeric strings normalize', () => {
  const result = normalizeGuestPackagesInput([
    { package_code: 'MALIBU' }, { guest_number: '2', package_code: 'package_none' },
  ], 2);
  assert.deepEqual(result.guest_packages, [
    { guest_number: 1, package_code: 'malibu' }, { guest_number: 2, package_code: 'package_none' },
  ]);
  assert.deepEqual(result.guest_package_association, { status: 'resolved', issues: [] });
});

test('C18: explicit/implicit and numeric-string collisions are unresolved without renumbering', () => {
  for (const rows of [
    [{ guest_number: 2, package_code: 'malibu' }, { package_code: 'package_none' }],
    [{ guest_number: '1', package_code: 'malibu' }, { guest_number: 1, package_code: 'package_none' }],
  ]) {
    const result = normalizeGuestPackagesInput(rows, 2);
    assert.equal(result.error, undefined);
    assert.equal(result.guest_packages[0].guest_number, result.guest_packages[1].guest_number);
    assert.equal(result.guest_package_association.status, 'unresolved');
    assert.equal(context(rows).guest_package_association.status, 'unresolved');
  }
});

test('C18: existing package validation remains intact', () => {
  assert.match(normalizeGuestPackagesInput([], 2).error, /required/);
  assert.match(normalizeGuestPackagesInput([{ package_code: 'malibu' }], 2).error, /length/);
  assert.match(normalizeGuestPackagesInput([{}], 1).error, /required/);
  assert.match(normalizeGuestPackagesInput([{ package_code: 'bad package' }], 1).error, /Invalid/);
  assert.equal(normalizeGuestPackagesInput([{}], 1, 'rincon').guest_packages[0].package_code, 'rincon');
});

test('C18: duplicate ordinals remain unresolved without a normalizer save error', () => {
  const raw = [
    { guest_number: 1, package_code: 'package_none' },
    { guest_number: 1, package_code: 'malibu' },
  ];
  const result = normalizeGuestPackagesInput(raw, 2, 'malibu');
  assert.equal(result.error, undefined, 'association ambiguity must not block save');
  assert.deepEqual(result.guest_packages, raw, 'never renumber or drop duplicate rows');
  const expected = {
    status: 'unresolved',
    issues: [{ code: 'duplicate_guest_number', guest_number: 1, row_numbers: [1, 2] }],
  };
  assert.deepEqual(result.guest_package_association, expected);
  const resolved = context(result.guest_packages);
  assert.deepEqual(resolved.guestPackagesForQuote, raw);
  assert.deepEqual(resolved.guest_package_association, expected);
});

test('C18: out-of-order explicit ordinals retain the package on the intended guest', () => {
  const raw = [
    { guest_number: 2, package_code: 'package_none' },
    { guest_number: 1, package_code: 'Malibu' },
  ];
  const before = JSON.stringify(raw);
  const result = normalizeGuestPackagesInput(raw, 2, 'malibu');
  assert.equal(result.error, undefined);
  const expected = [
    { guest_number: 2, package_code: 'package_none' },
    { guest_number: 1, package_code: 'malibu' },
  ];
  assert.deepEqual(result.guest_packages, expected);
  assert.deepEqual(context(result.guest_packages).guestPackagesForQuote, expected);
  assert.equal(JSON.stringify(raw), before, 'input must not be mutated');
});
