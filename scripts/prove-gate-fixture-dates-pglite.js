'use strict';

/**
 * Postgres round-trip proof for scripts/lib/gate-fixture-dates.js.
 *
 * Gates feed fixture dates into Postgres — service_date, check_in, effective_from — and
 * read them back to compare. Between the gate and the comparison sit the driver's type
 * parser and the session TimeZone, either of which can move a date by a day. That is the
 * failure this proof exists to rule out, in a real Postgres engine (PGlite), not a mock.
 *
 * Hostile on purpose: the node process runs in one extreme zone and the database session
 * in the other, so any zone-dependent arithmetic shows up as an off-by-one day.
 *
 * Run: node scripts/prove-gate-fixture-dates-pglite.js
 *   npm run prove:gate-fixture-dates-pglite
 */

const path = require('path');
const {
  fixtureDates, shift, daysBetween, weekdayOf,
} = require('./lib/gate-fixture-dates');

const ROOT = path.resolve(__dirname, '..');

/** Node in UTC+14, Postgres in UTC−11: 25 hours apart, worse than any real deployment. */
const NODE_TZ = 'Pacific/Kiritimati';
const DB_TZ = 'Pacific/Midway';

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

function loadPglite() {
  const roots = [ROOT, '/opt/data/wolfhouse-agent', '/opt/wolfhouse/WH'];
  for (const base of roots) {
    try {
      return require(require.resolve('@electric-sql/pglite', { paths: [base] })).PGlite;
    } catch (_) { /* try the next dependency root */ }
  }
  throw new Error('PGlite unavailable; install/resolve @electric-sql/pglite (this proof refuses a mock)');
}

async function main() {
  if (process.env.TZ !== NODE_TZ) {
    // Re-exec in the hostile zone: TZ has to be set before the process starts.
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [__filename], {
      stdio: 'inherit',
      env: { ...process.env, TZ: NODE_TZ },
    });
    process.exit(r.status == null ? 1 : r.status);
  }

  console.log(`\nprove:gate-fixture-dates-pglite  (node TZ ${NODE_TZ}, session TimeZone ${DB_TZ})\n`);

  const PGlite = loadPglite();
  const db = await PGlite.create();
  try {
    await db.query(`set timezone='${DB_TZ}'`);
    const shown = (await db.query('show timezone')).rows[0];
    ok('the session runs in the hostile zone', shown.TimeZone === DB_TZ, JSON.stringify(shown));

    const dates = fixtureDates();
    const stay = dates.calendar(dates.weekdayFromNow('monday', 30));
    const serviceDates = stay.days(0, 5);
    const effectiveFrom = stay.day(-200);
    const quotedAt = stay.clock(-5);

    await db.query(`
      create table fixture_round_trip (
        id int primary key,
        service_date date not null,
        effective_from date not null,
        quoted_at timestamptz not null
      )
    `);
    for (let i = 0; i < serviceDates.length; i += 1) {
      await db.query(
        'insert into fixture_round_trip values ($1, $2, $3, $4)',
        [i, serviceDates[i], effectiveFrom, quotedAt],
      );
    }

    // ── Date columns come back as the same calendar day ──────────────────────
    const back = await db.query(`
      select id, service_date, effective_from, quoted_at,
             to_char(service_date, 'YYYY-MM-DD') as service_text,
             to_char(effective_from, 'YYYY-MM-DD') as effective_text
        from fixture_round_trip order by id
    `);
    const readIso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

    ok('every service_date survives the driver',
      back.rows.every((r, i) => readIso(r.service_date) === serviceDates[i]),
      JSON.stringify(back.rows.map((r) => readIso(r.service_date))));
    ok('every service_date survives Postgres text rendering in the hostile session zone',
      back.rows.every((r, i) => r.service_text === serviceDates[i]),
      JSON.stringify(back.rows.map((r) => r.service_text)));
    ok('a date that must stay in the past survives too',
      back.rows.every((r) => readIso(r.effective_from) === effectiveFrom && r.effective_text === effectiveFrom),
      `${effectiveFrom} vs ${back.rows[0] && back.rows[0].effective_text}`);
    ok('the stay is still five consecutive days after the round trip',
      daysBetween(readIso(back.rows[0].service_date), readIso(back.rows[4].service_date)) === 4);
    ok('the anchor weekday survives',
      weekdayOf(readIso(back.rows[0].service_date)) === 'monday',
      weekdayOf(readIso(back.rows[0].service_date)));
    ok('the injected clock is the same instant on the way back',
      back.rows[0].quoted_at instanceof Date
      && back.rows[0].quoted_at.getTime() === quotedAt.getTime(),
      String(back.rows[0].quoted_at));

    // ── Comparisons, which is what gates actually do with these ──────────────
    const cmp = await db.query(
      `select count(*)::int as n from fixture_round_trip
        where service_date >= $1::date and service_date <= $2::date`,
      [serviceDates[0], serviceDates[4]],
    );
    ok('a BETWEEN over the stay finds all five rows', cmp.rows[0].n === 5, JSON.stringify(cmp.rows));

    const future = await db.query(
      'select count(*)::int as n from fixture_round_trip where service_date > current_date',
      [],
    );
    ok('the whole stay is still in the future to Postgres itself',
      future.rows[0].n === 5, JSON.stringify(future.rows));

    const past = await db.query(
      'select count(*)::int as n from fixture_round_trip where effective_from < current_date',
      [],
    );
    ok('the past-dated Admin row is still in the past to Postgres itself',
      past.rows[0].n === 5, JSON.stringify(past.rows));

    // ── The boundary: a date-only value is timezone-free, an instant is not ──
    const dayBoundary = await db.query(
      `select to_char($1::date, 'YYYY-MM-DD') as as_date,
              to_char($2::timestamptz at time zone 'UTC', 'YYYY-MM-DD') as as_instant_utc`,
      [serviceDates[0], stay.clock(0)],
    );
    ok('noon UTC still reads as its own day when rendered in UTC',
      dayBoundary.rows[0].as_date === serviceDates[0]
      && dayBoundary.rows[0].as_instant_utc === serviceDates[0],
      JSON.stringify(dayBoundary.rows[0]));

    const roundedTrip = shift(serviceDates[0], 0);
    ok('shift(iso, 0) is a no-op, so a re-read date can be reused as-is',
      roundedTrip === serviceDates[0]);
  } finally {
    await db.close();
  }

  console.log(`\n── prove:gate-fixture-dates-pglite ${fail ? 'FAILED' : 'PASSED'} (${pass} passed, ${fail} failed) ──\n`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error(`\nprove:gate-fixture-dates-pglite THREW — ${err && err.message}`);
  process.exit(1);
});
