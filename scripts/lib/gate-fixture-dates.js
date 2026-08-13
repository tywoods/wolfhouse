'use strict';

/**
 * Fixture dates for verify-*.js gates.
 *
 * A gate whose fixture books '2026-07-10' tests private lessons until 2026-07-10 and tests
 * the calendar every day after. verify-sunset-private-lesson-luna-contract sat red for a
 * month that way. verify-gate-dates now catches that class; this module is the fix it
 * points at.
 *
 * TWO WAYS TO USE IT, and the second is not a lesser one:
 *
 *   1. Dates relative to run time — the common case. The fixture is always a month out,
 *      so it can never expire.
 *
 *        const { fixtureDates } = require('./lib/gate-fixture-dates');
 *        const dates = fixtureDates();
 *        const DATE_FROM = dates.daysFromNow(30);
 *        const SESSIONS = dates.range(DATE_FROM, 3);   // three consecutive days
 *
 *   2. A frozen clock — for gates that hardcoded a date because they wanted determinism.
 *      You get determinism without a literal, and the fixture still moves with the year.
 *
 *        const dates = fixtureDates();
 *        const STAY = dates.calendar(dates.weekdayFromNow('monday', 30));
 *        const NOW = STAY.clock(-5);        // a Date, five days before check-in
 *        quote({ now: NOW, date_from: STAY.day(0), date_to: STAY.day(4) });
 *
 *      The run clock is read ONCE per process, so a gate cannot straddle midnight and get
 *      two different "todays" from two calls. Set VERIFY_FIXTURE_NOW to replay a run:
 *
 *        VERIFY_FIXTURE_NOW=2026-08-13 node scripts/verify-whatever.js
 *
 *      or pin one calendar without touching the rest: fixtureDates({ now: someIsoDate }).
 *
 * PAST DATES GET THE SAME TREATMENT. A fixture that must stay in the past is as
 * calendar-driven as one that must stay in the future — '2026-06-01' is only "the past"
 * until it is not, and a row dated after the booking it prices means something different.
 * Say daysAgo(60), or hang it off the calendar: PRICE_UPDATED_AT = STAY.day(-80).
 *
 * TIME ZONES. Every day is computed in UTC and every instant lands at noon UTC — the one
 * hour that keeps its calendar day from UTC−11 through UTC+11, which covers Europe/Madrid
 * (where this product decides what "today" means) and every CI zone. Date-only values are
 * timezone-free entirely: they survive Postgres date columns and explicit_past_date
 * validation unchanged in every zone. verify-gate-fixture-dates.js and
 * prove-gate-fixture-dates-pglite.js prove that against the real validator and a real
 * Postgres engine rather than asserting it here.
 *
 * One consequence worth knowing: the booking validator's "today" is Madrid-local, which
 * is ahead of UTC. daysFromNow(0) can therefore read as yesterday to it for the last two
 * hours of a UTC day. Book at least a day out — daysFromNow(1) is always safe — and a
 * fixture 30 days out never comes near the boundary.
 *
 * WHOLE-CALENDAR FIXTURES. When a file defines its own seasons and stays, do not migrate
 * day by day — anchor once and keep every offset, which preserves each span, boundary and
 * cross-season split exactly:
 *
 *        const cal = dates.calendar(dates.weekdayFromNow('wednesday', 30));
 *        cal.day(0); cal.day(3); cal.day(-161);
 *
 * For dates that live in a fixture JSON rather than in the gate, remapIsoDates rewrites
 * the file's own calendar without editing the fixture.
 */

const MS_PER_DAY = 86400000;

/** Noon keeps a date-only value on its own calendar day at every real UTC offset. */
const DEFAULT_TIME_UTC = '12:00:00';

const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_ANYWHERE = /\d{4}-\d{2}-\d{2}/g;

/** The run clock, read once so every calendar in a process agrees. */
let runClock = null;

function parseIsoDay(iso, label) {
  const m = ISO_DATE.exec(String(iso || ''));
  if (!m) throw new TypeError(`${label}: expected YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  const d = new Date(ms);
  if (Number.isNaN(ms) || toIsoDay(d) !== iso) {
    throw new RangeError(`${label}: not a real date: ${iso}`);
  }
  return d;
}

function toIsoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function coerceNow(now, label) {
  if (now instanceof Date) {
    if (Number.isNaN(now.getTime())) throw new RangeError(`${label}: invalid Date`);
    return new Date(now.getTime());
  }
  const text = String(now).trim();
  if (ISO_DATE.test(text)) return parseIsoDay(text, label);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`${label}: expected YYYY-MM-DD or a parsable date, got ${JSON.stringify(now)}`);
  }
  return parsed;
}

function readRunClock() {
  if (runClock) return new Date(runClock.getTime());
  const pinned = process.env.VERIFY_FIXTURE_NOW;
  runClock = pinned ? coerceNow(pinned, 'VERIFY_FIXTURE_NOW') : new Date();
  return new Date(runClock.getTime());
}

/** `iso` moved by whole days, staying on the calendar. Negative moves back. */
function shift(iso, days) {
  const d = parseIsoDay(iso, 'shift(iso)');
  d.setUTCDate(d.getUTCDate() + Math.trunc(Number(days) || 0));
  return toIsoDay(d);
}

/** `count` consecutive days starting at `iso`. */
function range(iso, count) {
  const n = Math.trunc(Number(count));
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`range(count): expected a count, got ${count}`);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(shift(iso, i));
  return out;
}

/** Whole days from `fromIso` to `toIso`; negative when `toIso` is earlier. */
function daysBetween(fromIso, toIso) {
  const a = parseIsoDay(fromIso, 'daysBetween(from)');
  const b = parseIsoDay(toIso, 'daysBetween(to)');
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/** Weekday name of `iso` — the one to pass back to weekdayFromNow. */
function weekdayOf(iso) {
  return WEEKDAYS[parseIsoDay(iso, 'weekdayOf(iso)').getUTCDay()];
}

function weekdayIndex(name) {
  const idx = WEEKDAYS.indexOf(String(name || '').trim().toLowerCase());
  if (idx < 0) throw new RangeError(`weekday: expected one of ${WEEKDAYS.join(', ')}, got ${JSON.stringify(name)}`);
  return idx;
}

/** A Date at noon UTC (or `time`) on `iso` — what a gate injects as `now`. */
function clockAt(iso, time) {
  const t = String(time || DEFAULT_TIME_UTC).trim();
  const full = /^\d{2}:\d{2}$/.test(t) ? `${t}:00` : t;
  if (!/^\d{2}:\d{2}:\d{2}$/.test(full)) {
    throw new RangeError(`clockAt(time): expected HH:MM or HH:MM:SS, got ${JSON.stringify(time)}`);
  }
  const day = toIsoDay(parseIsoDay(iso, 'clockAt(iso)'));
  const d = new Date(`${day}T${full}Z`);
  if (Number.isNaN(d.getTime())) throw new RangeError(`clockAt: invalid instant ${day}T${full}Z`);
  return d;
}

/**
 * Rewrite every YYYY-MM-DD in `text` through `mapper`, for fixture files that carry their
 * own calendar. The mapper sees each distinct date once and its answer is reused, so a
 * fixture's internal relationships survive.
 */
function remapIsoDates(text, mapper) {
  if (typeof mapper !== 'function') throw new TypeError('remapIsoDates(mapper): expected a function');
  const seen = new Map();
  return String(text).replace(ISO_DATE_ANYWHERE, (found) => {
    if (!ISO_DATE.test(found)) return found;
    if (!seen.has(found)) {
      const next = mapper(found);
      seen.set(found, next == null ? found : String(next));
    }
    return seen.get(found);
  });
}

/**
 * A fixture calendar anchored on one day. Every other day is an offset from it, so the
 * whole fixture can move without any span, gap or weekday changing.
 */
function makeCalendar(anchorIso) {
  const anchor = toIsoDay(parseIsoDay(anchorIso, 'calendar(anchor)'));
  return {
    /** The anchor day itself. */
    iso: anchor,
    /** The day `offset` days from the anchor. Negative reaches back. */
    day(offset) { return shift(anchor, offset || 0); },
    /** `count` consecutive days starting `offset` days from the anchor. */
    days(offset, count) { return range(shift(anchor, offset || 0), count); },
    /** An instant (Date) at noon UTC, or `time`, on the day at `offset`. */
    clock(offset, time) { return clockAt(shift(anchor, offset || 0), time); },
    /** The same calendar re-anchored `offset` days along. */
    from(offset) { return makeCalendar(shift(anchor, offset || 0)); },
  };
}

/**
 * Build a fixture calendar bound to a clock.
 *
 *   fixtureDates()                       — the frozen run clock (or VERIFY_FIXTURE_NOW)
 *   fixtureDates({ now: '2026-01-02' })  — pinned, for a gate that needs one exact instant
 */
function fixtureDates(options) {
  const opts = options || {};
  const now = opts.now == null ? readRunClock() : coerceNow(opts.now, 'fixtureDates({ now })');
  const today = toIsoDay(now);

  const api = {
    /** The instant this calendar was built on. */
    now,
    /** Today, on that instant, in UTC. */
    today,
    /** `n` days from today. Negative reaches back. */
    daysFromNow(n) { return shift(today, n); },
    /** `n` days before today — for fixtures that must stay in the past. */
    daysAgo(n) { return shift(today, -Math.trunc(Number(n) || 0)); },
    /** The first `name` (e.g. 'monday') at least `atLeastDaysOut` days from today. */
    weekdayFromNow(name, atLeastDaysOut) {
      const want = weekdayIndex(name);
      const start = shift(today, atLeastDaysOut == null ? 30 : atLeastDaysOut);
      const have = parseIsoDay(start, 'weekdayFromNow').getUTCDay();
      return shift(start, (want - have + 7) % 7);
    },
    /**
     * The first day at least `atLeastDaysOut` out that falls on the same weekday as
     * `sampleIso` — for fixtures whose day is decided elsewhere (a fixture file, a
     * schedule), where the weekday is load-bearing but the month is not.
     */
    sameWeekdayFromNow(sampleIso, atLeastDaysOut) {
      return api.weekdayFromNow(weekdayOf(sampleIso), atLeastDaysOut);
    },
    /** A calendar anchored on `iso`, or on today when omitted. */
    calendar(iso) { return makeCalendar(iso == null ? today : iso); },
    /** An instant (Date) at noon UTC, or `time`, on `iso`. */
    clockAt,
    /** `count` consecutive days starting at `iso`. */
    range,
    /** `iso` moved by whole days. */
    shift,
    /** Whole days between two days. */
    daysBetween,
    /** Weekday name of `iso`. */
    weekdayOf,
  };

  return api;
}

module.exports = {
  fixtureDates,
  remapIsoDates,
  shift,
  range,
  daysBetween,
  weekdayOf,
  clockAt,
  WEEKDAYS,
  DEFAULT_TIME_UTC,
};
