'use strict';

const assert = require('assert/strict');
const {
  buildWolfhousePaidConfirmationCopy,
} = require('./lib/luna-guest-confirmation-copy-style');

const INTERNAL_LABELS = /(?:name:|deposit_paid|status|booking_code|check for this booking|tool|test)/i;

function factLines(message) {
  return message.split('\n').filter((line) => /^[📌📅🛏️👥🏄💶💳⏳✅📍🗺️🚐🔑]/u.test(line));
}

function assertSharedContract(message, {
  paid,
  total,
  owed,
  roomNeedle,
}) {
  assert.match(message, /^.+ 🌊\n\n\*.+\* 🎉/u);
  assert.ok(factLines(message).length >= 8, message);
  for (const line of factLines(message)) {
    assert.match(line, /^[📌📅🛏️👥🏄💶💳⏳✅📍🗺️🚐🔑]/u);
  }
  for (const emoji of ['📌', '📅', '🛏️', '👥', '💶']) {
    assert.equal(message.split(emoji).length - 1, 1, `${emoji}\n${message}`);
  }
  assert.match(message, roomNeedle);
  assert.match(message, new RegExp(`€${paid}(?!\\.)`));
  assert.match(message, new RegExp(`€${total}(?!\\.)`));
  if (owed > 0) assert.match(message, new RegExp(`€${owed}(?!\\.)`));
  assert.equal(paid + owed, total);
  assert.doesNotMatch(message, /€\d+\.00\b/);
  assert.doesNotMatch(message, INTERNAL_LABELS);
  assert.doesNotMatch(message, /\*\*/);
  assert.doesNotMatch(message, /^#/m);
  assert.doesNotMatch(message, /(?:DEMO-R\d+-B\d+|\bR3\b|\bB[1-9]\b)/i);
  assert.equal(message.split('🛏️').length - 1, 1, message);
}

const base = {
  guest_name: 'Fabio Rossi',
  booking_code: 'WH-2F393C',
  payment_status: 'deposit_paid',
  amount_paid_cents: 20000,
  balance_due_cents: 20000,
  total_amount_cents: 40000,
  check_in: '2026-11-01',
  check_out: '2026-11-09',
  guest_count: 1,
  room_kind: 'mixed shared',
  room_number: 'R3',
  package_name: 'Surf week with 5 lessons',
  check_in_time: '15:00',
  address: 'C. Mies de La Ran, 41, Somo',
  maps_link: 'https://maps.example/wolfhouse',
  balance_due_timing: 'on arrival, at reception',
  shuttle_booked: true,
  shuttle_copy: 'pick-up on Sun 1 Nov, just send me your flight number ✈️',
};

const enDeposit = buildWolfhousePaidConfirmationCopy({ ...base, language: 'en' });
assertSharedContract(enDeposit, {
  paid: 200,
  total: 400,
  owed: 200,
  roomNeedle: /🛏️ \*Room:\* A bed in our mixed shared room/,
});
assert.match(enDeposit, /^Hi Fabio! 🌊/);
assert.match(enDeposit, /\*Payment received — you're officially part of the Wolfhouse family!\* 🎉/);
assert.match(enDeposit, /📅 \*Dates:\* Sun 1 Nov – Mon 9 Nov \(8 nights\)/);
assert.match(enDeposit, /👥 \*Guests:\* 1/);
assert.match(enDeposit, /🏄 \*Package:\* Surf week with 5 lessons/);
assert.match(enDeposit, /💶 \*Paid today:\* €200/);
assert.match(enDeposit, /💳 \*Total:\* €400/);
assert.match(enDeposit, /⏳ \*Still to pay:\* €200 on arrival, at reception/);
assert.match(enDeposit, /📍 \*Check-in:\* from 15:00 · C\. Mies de La Ran, 41, Somo/);
assert.match(enDeposit, /🗺️ https:\/\/maps\.example\/wolfhouse/);
assert.match(enDeposit, /🚐 \*Shuttle:\* pick-up on Sun 1 Nov/);
assert.match(enDeposit, /If you need anything before you arrive, just message me here 😊/);
assert.match(enDeposit, /See you in the water! 🤙$/);

const enFull = buildWolfhousePaidConfirmationCopy({
  ...base,
  payment_status: 'paid',
  amount_paid_cents: 40000,
  balance_due_cents: 0,
  language: 'en',
});
assertSharedContract(enFull, {
  paid: 400,
  total: 400,
  owed: 0,
  roomNeedle: /🛏️ \*Room:\* A bed in our mixed shared room/,
});
assert.match(enFull, /💶 \*Paid:\* €400/);
assert.match(enFull, /✅ \*Fully paid\*, nothing left to pay/);
assert.doesNotMatch(enFull, /⏳|Paid today/);

const es = buildWolfhousePaidConfirmationCopy({ ...base, guest_name: 'Lucía Pérez', language: 'es' });
assertSharedContract(es, {
  paid: 200,
  total: 400,
  owed: 200,
  roomNeedle: /🛏️ \*Habitación:\* Una cama en nuestra habitación compartida mixta/,
});
assert.match(es, /^¡Hola Lucía! 🌊/);
assert.match(es, /\*Pago recibido — ¡ya formas parte de la familia Wolfhouse!\* 🎉/);
assert.match(es, /📅 \*Fechas:\* dom 1 nov – lun 9 nov \(8 noches\)/);
assert.match(es, /⏳ \*Pendiente:\* €200 a tu llegada, en recepción/);

const de = buildWolfhousePaidConfirmationCopy({ ...base, guest_name: 'Greta', language: 'de' });
assertSharedContract(de, {
  paid: 200,
  total: 400,
  owed: 200,
  roomNeedle: /🛏️ \*Zimmer:\* Ein Bett in unserem gemischten Mehrbettzimmer/,
});
assert.match(de, /^Hallo Greta! 🌊/);
assert.match(de, /\*Zahlung erhalten — du gehörst jetzt zur Wolfhouse-Familie!\* 🎉/);
assert.match(de, /📅 \*Daten:\* So 1 Nov – Mo 9 Nov \(8 Nächte\)/);
assert.match(de, /⏳ \*Noch offen:\* €200 bei Ankunft, an der Rezeption/);

const unnamed = buildWolfhousePaidConfirmationCopy({ ...base, guest_name: null, language: 'en' });
assert.match(unnamed, /^Hi there! 🌊/);
assert.doesNotMatch(unnamed, /Hi (?:null|Guest)/);

console.log('PASS verify-wolfhouse-paid-confirmation-style');
