'use strict';

const assert = require('assert/strict');
const confirmationStyle = require('./lib/luna-guest-confirmation-copy-style');
const {
  buildWolfhousePaidConfirmationCopy,
} = confirmationStyle;
assert.equal(Object.hasOwn(confirmationStyle, 'QUOTE_STYLE_COPY'), false,
  'confirmation copy must come from the native catalog, not an exported table');

const INTERNAL_LABELS = /(?:name:|deposit_paid|status|booking_code|check for this booking|tool|test)/i;

function factLines(message) {
  return message.split('\n').filter((line) => /^[📌📅🛏️👥🏄💶💳⏳✅📍🗺️🚐🔑]/u.test(line));
}

function euroTokenCents(token) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(token);
  assert.ok(match, token);
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

function labeledEuroCents(message, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = message.match(new RegExp(`${escaped}:\\* €(\\d+(?:\\.\\d{1,2})?)(?!\\d)`));
  assert.ok(match, `${label}\n${message}`);
  return euroTokenCents(match[1]);
}

function assertSharedContract(message, {
  paidCents,
  totalCents,
  owedCents,
  roomNeedle,
  labels,
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
  const paid = labeledEuroCents(message, labels.paid);
  const total = labeledEuroCents(message, labels.total);
  assert.equal(paid, paidCents, message);
  assert.equal(total, totalCents, message);
  if (owedCents > 0) {
    const owed = labeledEuroCents(message, labels.owed);
    assert.equal(owed, owedCents, message);
    assert.equal(paid + owed, total, message);
  } else {
    assert.equal(paid, total, message);
  }
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
  paidCents: 20000,
  totalCents: 40000,
  owedCents: 20000,
  roomNeedle: /🛏️ \*Room:\* A bed in our mixed shared room/,
  labels: { paid: 'Paid today', total: 'Total', owed: 'Still to pay' },
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
assert.doesNotMatch(enDeposit, /send me|flight number/);
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
  paidCents: 40000,
  totalCents: 40000,
  owedCents: 0,
  roomNeedle: /🛏️ \*Room:\* A bed in our mixed shared room/,
  labels: { paid: 'Paid', total: 'Total' },
});
assert.match(enFull, /💶 \*Paid:\* €400/);
assert.match(enFull, /✅ \*Fully paid\*, nothing left to pay/);
assert.doesNotMatch(enFull, /⏳|Paid today/);

const es = buildWolfhousePaidConfirmationCopy({ ...base, guest_name: 'Lucía Pérez', language: 'es' });
assertSharedContract(es, {
  paidCents: 20000,
  totalCents: 40000,
  owedCents: 20000,
  roomNeedle: /🛏️ \*Habitación:\* Una cama en nuestra habitación compartida mixta/,
  labels: { paid: 'Pagado hoy', total: 'Total', owed: 'Pendiente' },
});
assert.match(es, /^¡Hola Lucía! 🌊/);
assert.match(es, /\*Pago recibido — ¡ya formas parte de la familia Wolfhouse!\* 🎉/);
assert.match(es, /📅 \*Fechas:\* dom 1 nov – lun 9 nov \(8 noches\)/);
assert.match(es, /⏳ \*Pendiente:\* €200 a tu llegada, en recepción/);
assert.match(es, /🚐 \*Traslado:\* recogida el dom 1 nov/);
assert.doesNotMatch(es, /send me|flight number|pick-up on/);

const de = buildWolfhousePaidConfirmationCopy({ ...base, guest_name: 'Greta', language: 'de' });
assertSharedContract(de, {
  paidCents: 20000,
  totalCents: 40000,
  owedCents: 20000,
  roomNeedle: /🛏️ \*Zimmer:\* Ein Bett in unserem gemischten Mehrbettzimmer/,
  labels: { paid: 'Heute bezahlt', total: 'Gesamt', owed: 'Noch offen' },
});
assert.match(de, /^Hallo Greta! 🌊/);
assert.match(de, /\*Zahlung erhalten — du gehörst jetzt zur Wolfhouse-Familie!\* 🎉/);
assert.match(de, /📅 \*Daten:\* So 1 Nov – Mo 9 Nov \(8 Nächte\)/);
assert.match(de, /⏳ \*Noch offen:\* €200 bei Ankunft, an der Rezeption/);
assert.match(de, /🚐 \*Shuttle:\* Abholung am So 1 Nov/);
assert.doesNotMatch(de, /send me|flight number|pick-up on/);

const unnamed = buildWolfhousePaidConfirmationCopy({ ...base, guest_name: null, language: 'en' });
assert.match(unnamed, /^Hi there! 🌊/);
assert.doesNotMatch(unnamed, /Hi (?:null|Guest)/);

for (const [lang, paidLabel, totalLabel, fullyPaid] of [
  ['es', 'Pagado', 'Total', /Pagado por completo/],
  ['de', 'Bezahlt', 'Gesamt', /Vollständig bezahlt/],
]) {
  const full = buildWolfhousePaidConfirmationCopy({
    ...base,
    guest_name: lang === 'es' ? 'Lucía Pérez' : 'Greta',
    language: lang,
    payment_status: 'paid',
    amount_paid_cents: 40000,
    balance_due_cents: 0,
  });
  assert.match(full, fullyPaid);
  assert.equal(labeledEuroCents(full, paidLabel), 40000, full);
  assert.equal(labeledEuroCents(full, totalLabel), 40000, full);
  assert.doesNotMatch(full, /⏳|€0\b/);
}

const fractional = buildWolfhousePaidConfirmationCopy({
  ...base,
  amount_paid_cents: 12099,
  balance_due_cents: 20001,
  total_amount_cents: 32100,
});
assert.equal(labeledEuroCents(fractional, 'Paid today'), 12099, fractional);
assert.equal(labeledEuroCents(fractional, 'Still to pay'), 20001, fractional);
assert.equal(labeledEuroCents(fractional, 'Total'), 32100, fractional);
assert.match(fractional, /€120\.99/);
assert.match(fractional, /€200\.01/);
assert.doesNotMatch(fractional, /€0\b/);

const nullTotal = buildWolfhousePaidConfirmationCopy({
  ...base,
  total_amount_cents: null,
});
assert.equal(labeledEuroCents(nullTotal, 'Total'), 40000, nullTotal);
assert.doesNotMatch(nullTotal, /Total:\* €0\b/);

const unknownBalance = buildWolfhousePaidConfirmationCopy({
  ...base,
  balance_due_cents: null,
});
assert.doesNotMatch(unknownBalance, /Fully paid/);
assert.equal(labeledEuroCents(unknownBalance, 'Total'), 40000, unknownBalance);

for (const language of ['en', 'es', 'de', 'fr', 'it']) {
  const combinedRooms = buildWolfhousePaidConfirmationCopy({
    ...base, language, room_kinds: ['mixed shared', 'private room'], room_count: 2,
  });
  assert.doesNotMatch(combinedRooms, /undefined/i, `${language}\n${combinedRooms}`);
  assert.match(combinedRooms, /🛏️ \*.+:\* .+ .+ .+/u, combinedRooms);
}

console.log('PASS verify-wolfhouse-paid-confirmation-style');
