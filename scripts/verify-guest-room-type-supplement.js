'use strict';

/**
 * Regression gate — guest room_type flows from the message intake into the
 * quote, so private/double rooms actually charge the room supplement.
 *
 * Bug it locks: buildDryRunInputFromIntake used to hardcode room_type:'shared',
 * and the intake never extracted "private"/"double". A guest asking for a
 * private room was quoted at the shared price (supplement silently dropped),
 * and Luna confirmed the booking on the undercharged total.
 *
 * Deterministic — no DB, no API key.
 */

const {
  extractLunaGuestMessageIntake,
  validateLunaGuestMessageIntake,
  buildDryRunInputFromIntake,
} = require('./lib/luna-guest-message-intake');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const { mapRouterToQuoteFields } = require('./lib/luna-guest-quote-proposal-dry-run');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-guest-room-type-supplement.js\n');

// Resolve room_type the way the reply-draft path does: intake -> validate -> dry-run input.
function roomTypeFromMessage(msg) {
  const ex = extractLunaGuestMessageIntake(
    { message_text: msg, from: '+34123456789', client_slug: 'wolfhouse-somo' },
    { reference_date: '2026-06-10' },
  );
  const v = validateLunaGuestMessageIntake(ex);
  const dry = buildDryRunInputFromIntake(v.extraction, {});
  return { extracted: ex.room_type, dry: dry.room_type };
}

// Weekly Malibu for a couple → a clean quote where the per-room supplement applies.
function weeklyQuote(roomType) {
  return calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-07-06',
    check_out: '2026-07-13',
    guest_count: 2,
    package_code: 'malibu',
    room_type: roomType,
    payment_choice: 'deposit',
  });
}

function supplementCents(quote) {
  const li = (quote.line_items || []).find((i) => i.code === 'room_supplement');
  return li ? li.total_cents : 0;
}

section('A. Intake extracts the priced room type (en)');
{
  const priv = roomTypeFromMessage('Hi! Malibu package, private room please, for a couple');
  check('A1', priv.extracted === 'private', `"private room" -> private (got ${priv.extracted})`);
  check('A2', priv.dry === 'private', `dry-run input carries private (got ${priv.dry})`);

  const dbl = roomTypeFromMessage('Malibu package, double room, two of us');
  check('A3', dbl.extracted === 'double', `"double room" -> double (got ${dbl.extracted})`);

  const shared = roomTypeFromMessage('Malibu, shared dorm, two of us');
  check('A4', shared.extracted === 'shared', `"shared dorm" -> shared (got ${shared.extracted})`);

  const none = roomTypeFromMessage('Malibu package for two');
  check('A5', none.extracted === null, `unspecified -> null extraction (got ${none.extracted})`);
  check('A6', none.dry === 'shared', `unspecified defaults to shared in dry-run (got ${none.dry})`);
}

section('B. Multilingual room_type (es/it/fr/de)');
{
  const es = roomTypeFromMessage('Hola, paquete Malibu, habitación privada, para dos');
  check('B1', es.extracted === 'private', `es "privada" -> private (got ${es.extracted})`);
  const it = roomTypeFromMessage('Pacchetto Malibu, camera privata, per due');
  check('B2', it.extracted === 'private', `it "privata" -> private (got ${it.extracted})`);
  const fr = roomTypeFromMessage('Forfait Malibu, chambre privée, pour deux');
  check('B3', fr.extracted === 'private', `fr "privée" -> private (got ${fr.extracted})`);
  const de = roomTypeFromMessage('Malibu Paket, Privatzimmer, für zwei');
  check('B4', de.extracted === 'private', `de "Privatzimmer" -> private (got ${de.extracted})`);
}

section('C. Supplement actually reaches the quote (the pricing bug)');
{
  const privRt = roomTypeFromMessage('Malibu package, private room please, couple').dry;
  const dblRt = roomTypeFromMessage('Malibu package, double room, couple').dry;
  const noneRt = roomTypeFromMessage('Malibu package for two').dry;

  const priv = weeklyQuote(privRt);
  const dbl = weeklyQuote(dblRt);
  const shared = weeklyQuote(noneRt);

  check('C1', priv.success && dbl.success && shared.success, 'all three quotes succeed');
  check('C2', supplementCents(priv) === 7000, `private supplement = €70 flat / 7n (got ${supplementCents(priv)})`);
  check('C3', supplementCents(dbl) === 7000, `double supplement = €70 flat / 7n (got ${supplementCents(dbl)})`);
  check('C4', supplementCents(shared) === 0, `shared has no supplement (got ${supplementCents(shared)})`);
  check('C5', priv.total_cents > shared.total_cents, `private total > shared total (${priv.total_cents} vs ${shared.total_cents})`);
  check('C6', priv.total_cents - shared.total_cents === 7000, 'private costs exactly €70 more than shared — no silent undercharge');
}

section('D. Router/planner path — room_preference maps to priced room_type');
{
  // The conversation-brain captures room_preference (free text); the quote mapper
  // must translate it to the calculator's room_type. Gender-only prefs stay shared.
  const rt = (pref) => mapRouterToQuoteFields(
    { extracted_fields: { room_preference: pref } },
    { client_slug: 'wolfhouse-somo' },
  ).room_type;
  check('D1', rt('private') === 'private', `"private" -> private (got ${rt('private')})`);
  check('D2', rt('couple_private') === 'private', `snake-cased "couple_private" -> private (got ${rt('couple_private')})`);
  check('D3', rt('double') === 'double', `"double" -> double (got ${rt('double')})`);
  check('D4', rt('shared') === 'shared', `"shared" -> shared (got ${rt('shared')})`);
  check('D5', rt('girls') === 'shared', `gender-only "girls" stays shared-priced (got ${rt('girls')})`);
  check('D6', rt('mixed') === 'shared', `gender-only "mixed" stays shared-priced (got ${rt('mixed')})`);
  check('D7', rt(undefined) === 'shared', `no preference -> shared (got ${rt(undefined)})`);
}

console.log(`\n── Summary: ${passes} passed, ${failures} failed ──\n`);
process.exit(failures ? 1 : 0);
