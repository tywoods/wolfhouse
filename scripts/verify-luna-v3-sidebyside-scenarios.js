'use strict';

// Tiny loader for scripts/fixtures/luna-v3-sidebyside/. Does not call Crow's Nest.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const packDir = path.join(repoRoot, 'scripts', 'fixtures', 'luna-v3-sidebyside');
const reservedPhone = /^\+346999\d{5}$/;

const REQUIRED_IDS = [
  'solo-dorm-quote-to-booking',
  'group3-pay-together',
  'group3-pay-separately',
  'package-deposit-200',
  'switch-private-extra-quoted',
  'unpaid-cancel-luna',
  'paid-cancel-handoff',
  'november-stay',
  'no-beds-left',
  'spanish',
];

function isRealCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function main() {
  assert.equal(fs.existsSync(packDir), true, 'scripts/fixtures/luna-v3-sidebyside is missing');
  const manifest = JSON.parse(fs.readFileSync(path.join(packDir, 'manifest.json'), 'utf8'));
  assert.equal(Array.isArray(manifest.scripts), true);
  assert.equal(manifest.scripts.length, 10);

  const phones = new Set();
  const ids = [];
  for (const name of manifest.scripts) {
    assert.equal(name.endsWith('.json'), true, name);
    const script = JSON.parse(fs.readFileSync(path.join(packDir, name), 'utf8'));
    assert.equal(typeof script.id, 'string');
    ids.push(script.id);
    assert.equal(reservedPhone.test(script.phone), true, script.id + ' phone is not reserved +34 699 9xx');
    assert.equal(script.phone.length, 12, script.id);
    assert.equal(script.phone.includes('*'), false, script.id);
    assert.equal(phones.has(script.phone), false, script.id + ' reuses a phone');
    phones.add(script.phone);
    assert.equal(isRealCalendarDate(script.dates.check_in), true, script.id + ' check_in');
    assert.equal(isRealCalendarDate(script.dates.check_out), true, script.id + ' check_out');
    assert.equal(String(script.dates.check_in).startsWith('2027-'), true, script.id);
    assert.equal(String(script.dates.check_out).startsWith('2027-'), true, script.id);
    assert.equal(script.dates.stock_pricing_confirmed, false, script.id);
    assert.equal(Array.isArray(script.turns) && script.turns.length > 0, true, script.id);
    for (const turn of script.turns) {
      assert.equal(typeof turn.guest === 'string' && turn.guest.trim().length >= 8, true, script.id);
      const years = turn.guest.match(/\b(20\d{2})\b/g) || [];
      for (const year of years) assert.equal(year, '2027', script.id + ' dialogue year');
    }
    assert.equal(script.pass && typeof script.pass === 'object', true, script.id + ' missing pass criteria');
    assert.equal(typeof script.pass.summary === 'string' && script.pass.summary.length >= 8, true, script.id);
  }

  for (const id of REQUIRED_IDS) {
    assert.equal(ids.includes(id), true, 'missing scenario ' + id);
  }

  const loaded = manifest.scripts.map((name) => JSON.parse(fs.readFileSync(path.join(packDir, name), 'utf8')));
  const byId = Object.fromEntries(loaded.map((script) => [script.id, script]));

  assert.equal(byId['solo-dorm-quote-to-booking'].pass.quote_source, 'staff_pricing');
  assert.equal(byId['solo-dorm-quote-to-booking'].pass.booking_saved, true);
  assert.equal(byId['solo-dorm-quote-to-booking'].pass.deposit_euros_per_person, 100);
  assert.equal(byId['group3-pay-together'].pass.pay_together, true);
  assert.equal(byId['group3-pay-together'].party_size, 3);
  assert.equal(byId['group3-pay-separately'].pass.pay_together, false);
  assert.equal(byId['group3-pay-separately'].pass.payment_links_per_person, true);
  assert.equal(byId['package-deposit-200'].pass.deposit_euros_per_person, 200);
  assert.equal(byId['package-deposit-200'].pass.package, true);
  const pkgNights = (Date.parse(byId['package-deposit-200'].dates.check_out + 'T00:00:00Z') - Date.parse(byId['package-deposit-200'].dates.check_in + 'T00:00:00Z')) / 86400000;
  assert.equal(pkgNights >= 7, true, 'package stay must meet the 7-night minimum');
  assert.equal(/june 2027/i.test(byId['package-deposit-200'].turns[0].guest) && /4 to 8 june/i.test(byId['package-deposit-200'].turns[0].guest), false, '4-8 June is not package-eligible');
  assert.equal(byId['switch-private-extra-quoted'].pass.extra_cost_quoted_before_confirm, true);
  const unpaid = byId['unpaid-cancel-luna'];
  assert.equal(/save unpaid booking|unpaid shows as confirmed/.test((unpaid.turns[0].must || []).join(' ')), false, 'opening turn must not demand a saved booking');
  const saveIdx = unpaid.turns.findIndex((turn) => (turn.must || []).some((item) => /save/.test(item)));
  const unpaidIdx = unpaid.turns.findIndex((turn) => (turn.must || []).some((item) => /unpaid|no payment/.test(item)));
  const cancelIdx = unpaid.turns.findIndex((turn) => /cancel/i.test(turn.guest));
  assert.equal(saveIdx > 0, true, 'save comes after acceptance');
  assert.equal(unpaidIdx >= saveIdx && unpaidIdx < cancelIdx, true, 'prove unpaid before cancel');
  assert.equal(cancelIdx > saveIdx, true);
  assert.equal(byId['paid-cancel-handoff'].pass.luna_cancels, false);
  assert.equal(byId['paid-cancel-handoff'].pass.handoff_to_human, true);
  assert.equal(byId['november-stay'].dates.check_in.startsWith('2027-11-'), true);
  assert.equal(byId['november-stay'].pass.must_not_doubt_november, true);
  assert.equal(byId['no-beds-left'].pass.booking_saved, false);
  assert.equal(byId['spanish'].pass.language, 'es');
  const SAVE_IDS = [
    'solo-dorm-quote-to-booking',
    'group3-pay-together',
    'group3-pay-separately',
    'package-deposit-200',
    'switch-private-extra-quoted',
    'unpaid-cancel-luna',
  ];
  for (const id of SAVE_IDS) {
    const script = byId[id];
    assert.equal(typeof script.contact === 'string' && script.contact.length >= 3, true, id + ' contact');
    assert.equal(Array.isArray(script.occupants) && script.occupants.length >= 1, true, id + ' occupants');
    const named = script.turns.some((turn) => /my name is |our names are /i.test(turn.guest));
    assert.equal(named, true, id + ' missing name turn');
    const accept = script.turns.some((turn) => /book|take the private|yes,/i.test(turn.guest));
    assert.equal(accept, true, id + ' missing acceptance turn');
  }
  assert.equal(byId['paid-cancel-handoff'].prerequisites.paid_booking.required, true);
  assert.equal(byId['paid-cancel-handoff'].prerequisites.paid_booking.present, false);
  assert.equal(byId['no-beds-left'].prerequisites.sold_out.required, true);
  assert.equal(byId['no-beds-left'].prerequisites.sold_out.present, false);

  console.log('sidebyside scenarios pack 10 loaded');
}

main();
