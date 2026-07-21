'use strict';

/**
 * Regression — singular person/guest count + coherent omitted-year date ranges.
 *
 * Staging bug (ref 2026-07-21): "I need a 10 person booking for July 20th to the 25th"
 * missed guest_count (singular "person") and independently year-inferred checkout
 * before check-in (2027-07-20 / 2026-07-25), which collapsed into generic safe handoff.
 *
 * Deterministic — no DB, no API key, no writes.
 */

const {
  extractLunaGuestMessageIntake,
  validateLunaGuestMessageIntake,
  INTAKE_SAFETY_FLAGS,
} = require('./lib/luna-guest-message-intake');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

function intake(messageText, referenceDate, extra = {}) {
  const ex = extractLunaGuestMessageIntake(
    {
      client_slug: 'wolfhouse-somo',
      message_text: messageText,
      from: extra.from || '+34600000000',
      ...extra.input,
    },
    { reference_date: referenceDate },
  );
  const v = validateLunaGuestMessageIntake(ex);
  return { ex, v, out: v.extraction };
}

function oneQuestion(text) {
  const q = String(text || '').match(/\?/g);
  return !q || q.length <= 1;
}

console.log('\nverify-luna-singular-person-date-range.js\n');

section('A. July-21 reference regression (exact staging phrase)');
{
  const { ex, v, out } = intake(
    'I need a 10 person booking for July 20th to the 25th',
    '2026-07-21',
  );
  check('A1', ex.guests === 10, `singular "10 person" -> guests=10 (got ${ex.guests})`);
  check('A2', ex.check_in === '2027-07-20', `check-in inferred once -> 2027-07-20 (got ${ex.check_in})`);
  check('A3', ex.check_out === '2027-07-25', `checkout same year as check-in -> 2027-07-25 (got ${ex.check_out})`);
  check('A4', ex.check_out > ex.check_in, 'checkout after check-in');
  check('A5', v.errors.length === 0, `no invalid_date_range (errors=${JSON.stringify(v.errors)})`);
  check('A6', out.handoff_required !== true, 'no handoff on coherent range');
  check('A7', out.no_write_performed === true && INTAKE_SAFETY_FLAGS.no_write_performed === true, 'no writes');
  check('A8', oneQuestion(out.ask_next), `one-question ask_next (${out.ask_next})`);
}

section('B. Singular vs plural guest-count');
{
  // Avoid "for N …" shortcut — that path already matches the bare digit after "for".
  const singularPerson = intake('Malibu, 3 person group, August 10 to 15', '2026-06-01');
  check('B1', singularPerson.ex.guests === 3, `"3 person" -> 3 (got ${singularPerson.ex.guests})`);

  const pluralPersons = intake('Malibu, 10 persons, August 10 to 15', '2026-06-01');
  check('B2', pluralPersons.ex.guests === 10, `"10 persons" -> 10 (got ${pluralPersons.ex.guests})`);

  const singularGuest = intake('Malibu, 1 guest stay, August 10 to 15', '2026-06-01');
  check('B3', singularGuest.ex.guests === 1, `"1 guest" -> 1 (got ${singularGuest.ex.guests})`);

  const pluralGuests = intake('Malibu, 2 guests, August 10 to 15', '2026-06-01');
  check('B4', pluralGuests.ex.guests === 2, `"2 guests" -> 2 (got ${pluralGuests.ex.guests})`);
}

section('C. Omitted-year coherent ranges + New Year crossing');
{
  const pastAnchor = intake('July 20th to the 25th', '2026-07-21');
  check('C1', pastAnchor.ex.check_in === '2027-07-20' && pastAnchor.ex.check_out === '2027-07-25',
    `past check-in day keeps checkout in check-in year (${pastAnchor.ex.check_in}→${pastAnchor.ex.check_out})`);

  const futureSameYear = intake('August 1 to 5', '2026-07-21');
  check('C2', futureSameYear.ex.check_in === '2026-08-01' && futureSameYear.ex.check_out === '2026-08-05',
    `future same-year range (${futureSameYear.ex.check_in}→${futureSameYear.ex.check_out})`);

  const ny = intake('December 28 to January 3', '2026-07-21');
  check('C3', ny.ex.check_in === '2026-12-28' && ny.ex.check_out === '2027-01-03',
    `genuine New Year crossing +1 on checkout (${ny.ex.check_in}→${ny.ex.check_out})`);

  const nyFromJan = intake('December 28 to January 3', '2026-01-05');
  check('C4', nyFromJan.ex.check_in === '2026-12-28' && nyFromJan.ex.check_out === '2027-01-03',
    `NY crossing from January ref (${nyFromJan.ex.check_in}→${nyFromJan.ex.check_out})`);
}

section('D. Invalid/inverted range → date clarification, not safe handoff');
{
  const { ex, v, out } = intake('July 25th to the 20th', '2026-07-21');
  check('D1', v.errors.includes('invalid_date_range'), `invalid_date_range flagged (errors=${JSON.stringify(v.errors)})`);
  check('D2', out.check_in == null && out.check_out == null, `both dates cleared for clarification (in=${out.check_in}, out=${out.check_out})`);
  check('D3', out.handoff_required !== true, 'no generic safe handoff');
  check('D4', /date/i.test(String(out.ask_next || '')), `ask_next clarifies dates (got ${out.ask_next})`);
  check('D5', oneQuestion(out.ask_next), 'one question only');
  check('D6', ex.no_write_performed === true, 'still no writes');
}

console.log(`\n── verify-luna-singular-person-date-range ${failures ? 'FAILED' : 'PASSED'} (${passes}/${passes + failures}) ──\n`);
process.exit(failures ? 1 : 0);
