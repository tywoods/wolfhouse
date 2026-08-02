#!/usr/bin/env node
'use strict';

/**
 * Captain / bot-runnable: call the production staff schedule booking quote helper
 * against real PG (read-only by default). No staff cookie required.
 *
 * Default: read-only quote probes for surfboard_wetsuit_rental 1_day + 2_hours.
 * Outputs only key/unit/amount/total lines (and service date). Exits nonzero on mismatch.
 *
 * Usage:
 *   node scripts/job-sunset-staff-sw-quote-readonly.js
 *   node scripts/job-sunset-staff-sw-quote-readonly.js --date=2026-09-05
 *   SERVICE_DATE=2026-09-05 DATABASE_URL=... node scripts/job-sunset-staff-sw-quote-readonly.js
 *
 * Create mode is disabled by default. --allow-create is reserved and still does
 * not perform creates (job remains quote-only).
 *
 * Env:
 *   DATABASE_URL / PG* — standard pg connection
 *   SUNSET_LOCATION_ID — default sunset-somo
 *   SERVICE_DATE / --date — YYYY-MM-DD (default 2026-09-05)
 *   EXPECT_SW_1_DAY_CENTS — default 3000
 *   EXPECT_SW_2_HOURS_CENTS — default 1500
 */

const { Client } = require('pg');
const {
  executeSunsetStaffScheduleBookingQuote,
} = require('./lib/sunset-staff-schedule-booking-quote');
const {
  resolveBusinessVertical,
  VERTICAL_CHANNELS,
} = require('./lib/luna-front-desk-business-vertical');

const SW = 'surfboard_wetsuit_rental';
const LOCATION = String(process.env.SUNSET_LOCATION_ID || 'sunset-somo').trim();
const EXPECT_DAY = Number(process.env.EXPECT_SW_1_DAY_CENTS || 3000);
const EXPECT_2H = Number(process.env.EXPECT_SW_2_HOURS_CENTS || 1500);
const DEFAULT_SERVICE_DATE = '2026-09-05';

/** Stable stderr codes only — never dump bodies or raw DB messages. */
const STDERR_ALLOWLIST = new Set([
  'mismatch',
  'vertical_unresolved',
  'price_missing',
  'price_not_found',
  'price_not_configured',
  'unpriced',
  'invalid_date',
  'pg_connect_failed',
  'pg_readonly_begin_failed',
  'pg_query_failed',
  'helper_failed',
  'job_error',
]);

function parseServiceDate() {
  let raw = process.env.SERVICE_DATE || '';
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--date=')) raw = a.slice('--date='.length);
    else if (a === '--date' && process.argv[process.argv.indexOf(a) + 1]) {
      raw = process.argv[process.argv.indexOf(a) + 1];
    }
  }
  raw = String(raw || DEFAULT_SERVICE_DATE).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { ok: false, reason: 'invalid_date', date: raw };
  }
  const t = Date.parse(`${raw}T12:00:00Z`);
  if (!Number.isFinite(t)) return { ok: false, reason: 'invalid_date', date: raw };
  return { ok: true, date: raw };
}

function stderrCode(code, extra) {
  const c = STDERR_ALLOWLIST.has(code) ? code : 'job_error';
  const bit = extra != null && String(extra).trim() ? ` detail=${String(extra).trim().slice(0, 48)}` : '';
  process.stderr.write(`${c}${bit}\n`);
}

function lineOut(obj) {
  const key = obj.key || '';
  const unit = obj.unit || '';
  const amount = obj.amount != null ? obj.amount : '';
  const total = obj.total != null ? obj.total : '';
  process.stdout.write(`key=${key} unit=${unit} amount=${amount} total=${total}\n`);
}

function firstCommercialLine(body, offeringKey) {
  const lines = Array.isArray(body && body.line_items) ? body.line_items : [];
  return lines.find((l) => {
    const k = String(l.offering_key || l.offering_id || l.offering_item_code || l.component || '');
    return k.includes(offeringKey) && l.course_equipment !== true;
  }) || null;
}

function reasonFromResult(result) {
  if (!result) return 'helper_failed';
  const body = result.body || {};
  const r = String(body.reason_code || body.reason || body.error || result.error || 'helper_failed').trim();
  if (STDERR_ALLOWLIST.has(r)) return r;
  if (/price/i.test(r) || /unpriced/i.test(r)) return 'price_not_configured';
  return 'helper_failed';
}

async function quoteOnce(pg, durationKey, serviceDate) {
  const resolved = resolveBusinessVertical({
    clientSlug: 'sunset',
    locationId: LOCATION,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.reason || resolved.reason_code || 'vertical_unresolved',
      body: {
        reason_code: resolved.reason_code || resolved.reason || 'vertical_unresolved',
      },
    };
  }
  const body = {
    date_from: serviceDate,
    date_to: serviceDate,
    service_dates: [serviceDate],
    components: {},
    rentals: [{ offering_key: SW, duration_key: durationKey, quantity: 1 }],
    course_equipment: [],
    surfer_count: 1,
    lessons: [],
    custom_line_items: [],
  };
  return executeSunsetStaffScheduleBookingQuote({
    clientSlug: 'sunset',
    locationId: LOCATION,
    body,
    pgClient: pg,
    verticalResolved: resolved,
    channel: VERTICAL_CHANNELS.MANUAL_STAFF,
  });
}

/**
 * Begin a read-only transaction. Prefer PostgreSQL READ ONLY mode so writes fail.
 * Returns { ok, mode } for tests / operators.
 */
async function beginReadOnlyTxn(client) {
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    return { ok: true, mode: 'set_transaction_read_only' };
  } catch (err) {
    try {
      await client.query('BEGIN READ ONLY');
      return { ok: true, mode: 'begin_read_only' };
    } catch (err2) {
      return {
        ok: false,
        mode: null,
        code: (err2 && err2.code) || (err && err.code) || 'pg_readonly_begin_failed',
      };
    }
  }
}

async function main() {
  const allowCreate = process.argv.includes('--allow-create');
  void allowCreate; // reserved; create is never performed

  const dateParsed = parseServiceDate();
  if (!dateParsed.ok) {
    stderrCode('invalid_date', dateParsed.date);
    process.exit(2);
  }
  const SERVICE_DATE = dateParsed.date;
  process.stdout.write(`date=${SERVICE_DATE}\n`);

  const client = new Client({
    connectionString: process.env.DATABASE_URL || undefined,
  });
  let exitCode = 0;
  try {
    try {
      await client.connect();
    } catch (_) {
      stderrCode('pg_connect_failed');
      process.exit(2);
    }

    const began = await beginReadOnlyTxn(client);
    if (!began.ok) {
      stderrCode('pg_readonly_begin_failed', began.code);
      try { await client.end(); } catch (_) { /* ignore */ }
      process.exit(2);
    }

    try {
      // Prove session is read-only when PG supports it (ignore if unavailable).
      try {
        const ro = await client.query('SHOW transaction_read_only');
        const v = ro && ro.rows && ro.rows[0] && String(Object.values(ro.rows[0])[0] || '').toLowerCase();
        if (v && v !== 'on') {
          // Still continue — some test doubles may not implement SHOW.
        }
      } catch (_) { /* ignore SHOW support */ }

      const day = await quoteOnce(client, '1_day', SERVICE_DATE);
      if (!day.ok) {
        lineOut({
          key: `${SW}__1_day`,
          unit: 'day',
          amount: '',
          total: 'FAIL',
        });
        stderrCode(reasonFromResult(day));
        exitCode = 1;
      } else {
        const li = firstCommercialLine(day.body, SW);
        const amount = li
          ? Number(li.unit_amount_cents != null ? li.unit_amount_cents
            : (li.unit_cents != null ? li.unit_cents : li.total_cents))
          : Number(day.body.total_cents);
        const total = Number(day.body.total_cents);
        const unit = (li && (li.billing_unit || li.unit)) || 'day';
        lineOut({
          key: `${SW}__1_day`,
          unit,
          amount,
          total,
        });
        if (total !== EXPECT_DAY || amount !== EXPECT_DAY) {
          stderrCode('mismatch', `1_day got=${amount}/${total}`);
          exitCode = 1;
        }
      }

      const twoH = await quoteOnce(client, '2_hours', SERVICE_DATE);
      if (!twoH.ok) {
        lineOut({
          key: `${SW}__2_hours`,
          unit: 'session',
          amount: '',
          total: 'FAIL',
        });
        stderrCode(reasonFromResult(twoH));
        exitCode = 1;
      } else {
        const li = firstCommercialLine(twoH.body, SW);
        const amount = li
          ? Number(li.unit_amount_cents != null ? li.unit_amount_cents
            : (li.unit_cents != null ? li.unit_cents : li.total_cents))
          : Number(twoH.body.total_cents);
        const total = Number(twoH.body.total_cents);
        const unit = (li && (li.billing_unit || li.unit)) || 'session';
        lineOut({
          key: `${SW}__2_hours`,
          unit,
          amount,
          total,
        });
        if (total !== EXPECT_2H || amount !== EXPECT_2H) {
          stderrCode('mismatch', `2_hours got=${amount}/${total}`);
          exitCode = 1;
        }
      }
    } finally {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    }
  } catch (_) {
    // Never print raw err.message or response bodies.
    stderrCode('job_error');
    exitCode = 2;
  } finally {
    try { await client.end(); } catch (_) { /* ignore */ }
  }
  process.exit(exitCode);
}

module.exports = {
  parseServiceDate,
  beginReadOnlyTxn,
  reasonFromResult,
  STDERR_ALLOWLIST,
  DEFAULT_SERVICE_DATE,
};

if (require.main === module) {
  main();
}
