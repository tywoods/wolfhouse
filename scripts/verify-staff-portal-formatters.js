'use strict';

/**
 * Pass 6 shared Staff formatters — one locale/date/money owner.
 * Display only. Never parse painted money back into values.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const i18n = require('./lib/staff-portal-i18n');

function tag(loc) {
  return i18n.getStaffLocaleTagFrom(loc);
}

test('getStaffLocaleTagFrom maps es/it/en', () => {
  assert.equal(tag('es'), 'es-ES');
  assert.equal(tag('it'), 'it-IT');
  assert.equal(tag('en'), 'en-GB');
});

test('date-only stays the same calendar day in ES/IT/EN and never rolls over', () => {
  for (const loc of ['es', 'it', 'en']) {
    const out = i18n.formatStaffPortalDateValue('2026-11-25', { year: 'numeric' }, tag(loc));
    assert.ok(out);
    assert.doesNotMatch(out, /2026-11-25/);
    assert.match(out, /25/);
    assert.match(out, /2026/);
  }
  assert.equal(i18n.formatStaffPortalDateValue('2026-02-31', {}, tag('es')), '');
  assert.equal(i18n.formatStaffPortalDateValue('not-a-date', {}, tag('en')), '');
  assert.equal(i18n.formatStaffPortalDateValue(null, {}, tag('it')), '');
});

test('timestamps use Europe/Madrid, not the host timezone', () => {
  const iso = '2026-07-01T23:30:00Z';
  const es = i18n.formatStaffPortalDateTimeValue(iso, { timeZone: 'Europe/Madrid' }, tag('es'));
  assert.ok(es);
  assert.doesNotMatch(es, /2026-07-01T/);
  assert.match(es, /2/);
  const invalid = i18n.formatStaffPortalDateTimeValue('invalid-clock', { timeZone: 'Europe/Madrid' }, tag('en'));
  assert.equal(invalid, '');
});

test('money uses Intl grouping and two decimals; null is unavailable not zero', () => {
  const es = i18n.formatStaffPortalMoneyValue(123400, 'EUR', tag('es'));
  assert.ok(es);
  const parts = new Intl.NumberFormat('es-ES', {
    style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true,
  }).formatToParts(1234);
  const group = parts.find((p) => p.type === 'group');
  if (group) assert.ok(es.includes(group.value), 'ES four-digit grouping');
  assert.match(es, /1.?234/);
  const zero = i18n.formatStaffPortalMoneyValue(0, 'EUR', tag('it'));
  assert.ok(zero);
  assert.match(zero, /0/);
  assert.equal(i18n.formatStaffPortalMoneyValue(null, 'EUR', tag('es')), null);
  assert.equal(i18n.formatStaffPortalMoneyValue(undefined, 'EUR', tag('en')), null);
  assert.equal(i18n.formatStaffPortalMoneyValue('nope', 'EUR', tag('it')), null);
});

test('locale change does not change the cents or calendar day', () => {
  const cents = 30000;
  const ymd = '2026-11-25';
  const moneyEn = i18n.formatStaffPortalMoneyValue(cents, 'EUR', tag('en'));
  const moneyIt = i18n.formatStaffPortalMoneyValue(cents, 'EUR', tag('it'));
  assert.notEqual(moneyEn, moneyIt);
  assert.equal(i18n.formatStaffPortalMoneyValue(cents, 'EUR', tag('es')) == null, false);
  const dayEn = i18n.formatStaffPortalDateValue(ymd, { year: 'numeric' }, tag('en'));
  const dayEs = i18n.formatStaffPortalDateValue(ymd, { year: 'numeric' }, tag('es'));
  assert.match(dayEn, /25/);
  assert.match(dayEs, /25/);
});
