'use strict';

/**
 * verify:gate-fixture-dates
 *
 * The contract of scripts/lib/gate-fixture-dates.js — the helper verify-gate-dates points
 * gates at. A shared date helper is only worth adopting if it is right about the two
 * things that bit real gates:
 *
 *   1. A fixture that must stay in the FUTURE stays bookable (no explicit_past_date), and
 *      a fixture that must stay in the PAST stays past. Both are calendar-driven.
 *   2. Its output survives the timezone normalisation between a gate and the code it
 *      calls. Proven here against the real validator in five zones, from UTC−11 to UTC+14,
 *      not asserted.
 *
 * The Postgres half of that proof lives in scripts/prove-gate-fixture-dates-pglite.js,
 * which round-trips these dates through a real Postgres engine under a hostile session
 * timezone. This gate stays offline and fast.
 *
 * Run: node scripts/verify-gate-fixture-dates.js
 *   npm run verify:gate-fixture-dates
 */

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  fixtureDates,
  remapIsoDates,
  shift,
  range,
  daysBetween,
  weekdayOf,
  clockAt,
  WEEKDAYS,
} = require('./lib/gate-fixture-dates');
const { validateSunsetGuestDateBounds } = require('./lib/sunset-guest-date-intake');

const SELF = path.join(__dirname, path.basename(__filename));

/** Zones chosen for their offsets: the two extremes, the product's own, and CI's. */
const ZONES = ['UTC', 'Europe/Madrid', 'America/New_York', 'Pacific/Midway', 'Pacific/Kiritimati'];

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function throws(label, fn) {
  let threw = false;
  try { fn(); } catch (_e) { threw = true; }
  ok(label, threw);
}

/** What a child process reports back, so every zone can be compared byte for byte. */
function childReport() {
  const dates = fixtureDates();
  const stay = dates.calendar(dates.weekdayFromNow('monday', 30));
  const future = dates.daysFromNow(30);
  const past = dates.daysAgo(60);
  const tomorrow = dates.daysFromNow(1);
  const check = (iso) => validateSunsetGuestDateBounds(iso, new Date(), { explicit: true });
  return {
    today: dates.today,
    future,
    past,
    tomorrow,
    stay: stay.days(0, 5),
    clock: stay.clock(-5).toISOString(),
    // The real validator, with its own Madrid-local idea of today.
    futureAccepted: check(future).ok === true,
    tomorrowAccepted: check(tomorrow).ok === true,
    pastReason: check(past).reason || null,
    yesterdayReason: check(dates.daysAgo(1)).reason || null,
  };
}

if (process.env.GATE_FIXTURE_DATES_CHILD === '1') {
  process.stdout.write(JSON.stringify(childReport()));
  process.exit(0);
}

function runIn(zone, env) {
  const out = execFileSync(process.execPath, [SELF], {
    encoding: 'utf8',
    env: {
      ...process.env, ...(env || {}), TZ: zone, GATE_FIXTURE_DATES_CHILD: '1',
    },
  });
  return JSON.parse(out);
}

console.log('\nverify:gate-fixture-dates\n');

// ── A) Days, ranges and the relationships a fixture depends on ──────────────
console.log('[A] Days and relationships');
{
  const dates = fixtureDates({ now: '2026-03-05' }); // a Thursday, pinned so the maths is checkable
  ok('today is the pinned day', dates.today === '2026-03-05', dates.today);
  ok('daysFromNow moves forward', dates.daysFromNow(30) === '2026-04-04', dates.daysFromNow(30));
  ok('daysFromNow(0) is today', dates.daysFromNow(0) === '2026-03-05');
  ok('daysAgo moves back', dates.daysAgo(60) === '2026-01-04', dates.daysAgo(60));
  ok('daysAgo and negative daysFromNow agree', dates.daysAgo(9) === dates.daysFromNow(-9));
  ok('month and year boundaries carry', shift('2026-12-31', 1) === '2027-01-01'
    && shift('2027-01-01', -1) === '2026-12-31');
  ok('leap day is a real day', shift('2028-02-28', 1) === '2028-02-29');
  ok('range is consecutive', JSON.stringify(range('2026-03-05', 3))
    === JSON.stringify(['2026-03-05', '2026-03-06', '2026-03-07']));
  ok('range(0) is empty', range('2026-03-05', 0).length === 0);
  ok('daysBetween is signed', daysBetween('2026-03-05', '2026-03-08') === 3
    && daysBetween('2026-03-08', '2026-03-05') === -3);
  ok('weekdayOf names the day', weekdayOf('2026-03-05') === 'thursday', weekdayOf('2026-03-05'));
  throws('a non-date is refused', () => shift('not-a-date', 1));
  throws('an impossible date is refused', () => shift('2026-02-30', 1));
  throws('an unknown weekday is refused', () => fixtureDates().weekdayFromNow('someday', 30));
}

// ── B) Weekday anchors — the shape a schedule-bound fixture needs ───────────
console.log('\n[B] Weekday anchors');
{
  const dates = fixtureDates();
  for (const name of WEEKDAYS) {
    const iso = dates.weekdayFromNow(name, 30);
    const out = daysBetween(dates.today, iso);
    ok(`${name} lands on a ${name}, at least 30 days out`,
      weekdayOf(iso) === name && out >= 30 && out < 37, `${iso} (+${out})`);
  }
  ok('sameWeekdayFromNow keeps the sample weekday',
    weekdayOf(fixtureDates().sameWeekdayFromNow('2026-09-05', 30)) === weekdayOf('2026-09-05'));
  ok('the default reach is 30 days',
    daysBetween(fixtureDates().today, fixtureDates().weekdayFromNow('monday')) >= 30);
}

// ── C) Whole-calendar fixtures keep every offset ────────────────────────────
console.log('\n[C] Calendars');
{
  const dates = fixtureDates({ now: '2026-03-05' });
  const cal = dates.calendar(dates.weekdayFromNow('wednesday', 30));
  ok('the anchor is the anchor', cal.day(0) === cal.iso);
  ok('offsets are exact', daysBetween(cal.iso, cal.day(18)) === 18);
  ok('negative offsets reach back', daysBetween(cal.iso, cal.day(-161)) === -161);
  ok('days() is a consecutive run from an offset',
    JSON.stringify(cal.days(2, 3)) === JSON.stringify([cal.day(2), cal.day(3), cal.day(4)]));
  ok('clock() is noon UTC on the offset day',
    cal.clock(3).toISOString() === `${cal.day(3)}T12:00:00.000Z`, cal.clock(3).toISOString());
  ok('clock() takes another time when a gate needs one',
    cal.clock(0, '08:30').toISOString() === `${cal.iso}T08:30:00.000Z`);
  ok('from() re-anchors and keeps the offsets', cal.from(10).day(-10) === cal.iso);
  ok('two calendars a week apart stay a week apart',
    daysBetween(cal.iso, cal.from(7).iso) === 7);
  ok('clockAt is the same instant by another route',
    clockAt(cal.iso).getTime() === cal.clock(0).getTime());
}

// ── D) Fixture files: remap a calendar without editing the fixture ──────────
console.log('\n[D] Fixture remapping');
{
  const dates = fixtureDates();
  const raw = '{"from":"2026-09-05","to":"2026-09-07","note":"booked 2026-09-05","n":20260905}';
  const to = dates.sameWeekdayFromNow('2026-09-05', 30);
  const out = remapIsoDates(raw, (iso) => shift(to, daysBetween('2026-09-05', iso)));
  const parsed = JSON.parse(out);
  ok('every date moved', !/2026-09-05|2026-09-07/.test(out), out);
  ok('the same date maps the same way everywhere',
    parsed.from === to && parsed.note === `booked ${to}`, out);
  ok('the span is preserved', daysBetween(parsed.from, parsed.to) === 2);
  ok('the weekday is preserved', weekdayOf(parsed.from) === weekdayOf('2026-09-05'));
  ok('digits that are not a date are untouched', out.includes('20260905'));
}

// ── E) One frozen clock per run ─────────────────────────────────────────────
console.log('\n[E] The clock is read once');
{
  ok('two calendars in one process agree',
    fixtureDates().now.getTime() === fixtureDates().now.getTime());
  ok('so a gate cannot straddle midnight and get two todays',
    fixtureDates().today === fixtureDates().today);

  const pinned = runIn('UTC', { VERIFY_FIXTURE_NOW: '2026-03-05T23:59:59Z' });
  ok('VERIFY_FIXTURE_NOW pins the run for replay',
    pinned.today === '2026-03-05' && pinned.future === '2026-04-04',
    JSON.stringify({ today: pinned.today, future: pinned.future }));

  const local = fixtureDates({ now: '2026-03-05' });
  ok('one calendar can be pinned without pinning the run',
    local.today === '2026-03-05' && fixtureDates().today !== '2026-03-05');
  throws('an unparsable pin is refused', () => fixtureDates({ now: 'whenever' }));
}

// ── F) Timezones — same days everywhere, and the validator agrees ───────────
console.log('\n[F] Timezones (UTC−11 … UTC+14)');
{
  const reports = ZONES.map((zone) => [zone, runIn(zone, { VERIFY_FIXTURE_NOW: '2026-03-05T23:30:00Z' })]);
  const [, first] = reports[0];
  for (const [zone, r] of reports) {
    ok(`${zone}: identical days`,
      JSON.stringify(r) === JSON.stringify(first),
      JSON.stringify(r));
  }
  ok('the pinned instant is 23:30 UTC — the hour a local-time helper would get wrong',
    first.today === '2026-03-05');
}

// ── G) Past stays past, future stays bookable — the real validator ──────────
console.log('\n[G] explicit_past_date, in every zone');
{
  for (const zone of ZONES) {
    const r = runIn(zone);
    ok(`${zone}: a 30-day-out fixture is accepted`, r.futureAccepted === true, JSON.stringify(r));
    ok(`${zone}: daysAgo(60) is rejected as explicit_past_date`,
      r.pastReason === 'explicit_past_date', String(r.pastReason));
    ok(`${zone}: daysAgo(1) is rejected too — the boundary case`,
      r.yesterdayReason === 'explicit_past_date', String(r.yesterdayReason));
    ok(`${zone}: daysFromNow(1) is not mistaken for the past`,
      r.tomorrowAccepted === true, JSON.stringify(r));
  }
  const dates = fixtureDates();
  const horizon = validateSunsetGuestDateBounds(dates.daysFromNow(30), new Date(), { explicit: true });
  ok('a 30-day fixture is inside the booking horizon', horizon.ok === true, JSON.stringify(horizon));
}

// ── H) The helper is not itself a hardcoded fixture ─────────────────────────
console.log('\n[H] The helper cannot rot');
{
  const src = require('fs').readFileSync(path.join(__dirname, 'lib', 'gate-fixture-dates.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const literals = code.match(/['"`]\d{4}-\d{2}-\d{2}/g) || [];
  ok('the library carries no fixture date of its own', literals.length === 0, literals.join(', '));
  assert.strictEqual(typeof fixtureDates, 'function');
}

console.log(`\n── verify:gate-fixture-dates ${fail ? 'FAILED' : 'PASSED'} (${pass} passed, ${fail} failed) ──\n`);
if (fail) {
  console.error('The date helper is the fix verify-gate-dates points at; it has to be right first.');
  process.exit(1);
}
