#!/usr/bin/env node
'use strict';

/**
 * BOOKING-CODE-WH-PREFIX-001 + BOOKING-BAR-ACCENT-001
 *
 * New Wolfhouse codes are WH-<date>-<suffix>. Stored MB-WOLFHO- still
 * resolves. Sunset mint is not renamed. Schedule left accent is a stable
 * per-booking color, flush to the bar, not payment status.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { PGlite } = require('@electric-sql/pglite');
const {
  buildManualBookingCreateSql,
  isGeneratedBookingCodeCollision,
  queryManualBookingCreateWithCodeRetry,
  GENERATED_BOOKING_CODE_RETRY_LIMIT,
} = require('./lib/staff-manual-booking-create-sql');
const {
  displayWolfhouseBookingCode,
  wolfhouseBookingCodeAliases,
  MODERN_RE,
} = require('./lib/wolfhouse-booking-code');
const { isValidPaymentShortLinkBookingCode } = require('./lib/luna-payment-short-link');
const {
  assignBookingAccents,
  annotateCalendarBlocks,
  BOOKING_ACCENT_STAY_SQL,
} = require('./lib/staff-calendar-group-paint');

const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');
const inbox = fs.readFileSync(path.join(root, 'scripts/browser/inbox-thread.js'), 'utf8');
const schedule = fs.readFileSync(path.join(root, 'scripts/browser/sunset-schedule-drawer-view-ui.js'), 'utf8');
const sql = buildManualBookingCreateSql();

const legacy = 'MB-WOLFHO-20261014-c79264';
const modern = 'WH-20261014-c79264';

assert.strictEqual(displayWolfhouseBookingCode(legacy), modern);
assert.strictEqual(displayWolfhouseBookingCode(modern), modern);
assert.strictEqual(displayWolfhouseBookingCode('SUNSET-20261014-ABC123'), 'SUNSET-20261014-ABC123');
assert.strictEqual(displayWolfhouseBookingCode('MB-SUNSET-20260701-FULL01'), 'MB-SUNSET-20260701-FULL01');
assert.deepStrictEqual(wolfhouseBookingCodeAliases(legacy).sort(), [legacy, modern].sort());
assert.ok(wolfhouseBookingCodeAliases(modern).includes(legacy));
assert.ok(MODERN_RE.test('WH-20261108-1281'), 'new 4-digit codes match');
assert.ok(MODERN_RE.test('WH-20261014-12345678'), 'old 8-digit codes still match');
assert.ok(MODERN_RE.test('WH-20261014-c79264'), 'legacy 6-hex display form still matches');
assert.ok(!MODERN_RE.test('WH-20261108-12'), '2-digit suffixes are not codes');
assert.ok(isValidPaymentShortLinkBookingCode('WH-20261108-1281'), 'payment links accept 4-digit WH codes');
assert.ok(isValidPaymentShortLinkBookingCode('WH-20261014-12345678'), 'payment links accept 8-digit WH codes');
assert.ok(isValidPaymentShortLinkBookingCode('MB-WOLFHO-20260801-7AAF07'), 'payment links still accept stored MB-WOLFHO codes');

assert.ok(sql.includes("THEN 'WH-' || to_char($10::date, 'YYYYMMDD')"), 'wolfhouse mint is WH-date-suffix');
assert.match(sql, /SELECT COALESCE\(\s*\$5::text,/, 'supplied booking references remain authoritative');
assert.match(
  sql,
  /THEN 'WH-'[\s\S]*?lpad\(\(floor\(random\(\) \* 10000\)\)::int::text, 4, '0'\)/,
  'wolfhouse mint is 4 random digits per check-in date',
);
assert.ok(!/lpad\(\(\(\('x' \|\| substring\(md5\(\$4::text\), 1, 6\)\)::bit\(24\)\)::bigint\)::text, 8, '0'\)/.test(sql), 'eight-digit digest mint is gone');
assert.strictEqual(GENERATED_BOOKING_CODE_RETRY_LIMIT, 8, 'clashes retry before failing');
assert.ok(typeof queryManualBookingCreateWithCodeRetry === 'function', 'unique clashes retry in one helper');
assert.ok(sql.includes("lower(btrim($1::text)) IN ('wolfhouse-somo', 'wolfhouse')"), 'mint is wolfhouse-gated');
assert.ok(sql.includes("'MB-' || upper(left(replace($1::text, '-', ''), 6))"), 'other clients keep MB- prefix');
assert.ok(sql.includes("|| '-' || substring(md5($4::text), 1, 6)"), 'other clients retain six-hex suffixes');
assert.ok(!/^\s*'MB-' \|\| upper\(left/.test(sql), 'ungated MB- mint is gone');
assert.ok(!sql.includes('Guaranteed unique within session via idempotency_key suffix.'), 'digest comments do not claim guaranteed uniqueness');

assert.strictEqual(
  isGeneratedBookingCodeCollision({ code: '23505', constraint: 'bookings_hostel_id_booking_code_key' }),
  true,
  'the exact generated booking-code unique violation is classified',
);
for (const error of [
  { code: '23505', constraint: 'bookings_pkey' },
  { code: '23505', constraint: 'bookings_client_id_idempotency_key_key' },
  { code: '23503', constraint: 'bookings_hostel_id_booking_code_key' },
  { code: '23505' },
  null,
]) {
  assert.strictEqual(isGeneratedBookingCodeCollision(error), false, 'unrelated database errors remain generic');
}

assert.ok(api.includes('queryManualBookingCreateWithCodeRetry'), 'Staff create retries generated-code clashes');
assert.ok(api.includes('isGeneratedBookingCodeCollision(err)'), 'Staff and Luna catches use exact constraint classification');
assert.strictEqual(
  (api.match(/reason_code: 'booking_code_collision'/g) || []).length,
  2,
  'Staff and Luna handlers each return a clear collision result',
);
assert.strictEqual(
  (api.match(/no_write_performed: true/g) || []).length >= 2,
  true,
  'collision responses explicitly report no write',
);

assert.ok(api.includes('function staffDisplayBookingCode'), 'portal display helper');
assert.ok(api.includes('staffDisplayBookingCode(blk.booking_code)'), 'booking-card header uses display form');
assert.ok(api.includes('data-bc-copy-code="\' + escHtml(shown)'), 'copy button copies the display form');
assert.ok(api.includes('data-bc-stored-code="\' + escHtml(code)'), 'copy keeps the stored code');
assert.ok(api.includes('resolveStoredWolfhouseBookingCode'), 'context lookup resolves legacy codes');
assert.ok(inbox.includes('staffDisplayBookingCode(bctx.booking_code)'), 'inbox shows the display form');
assert.ok(schedule.includes('staffDisplayBookingCode(rawCode)'), 'schedule hero shows the display form');

assert.ok(api.includes('BOOKING-BAR-ACCENT-001'), 'accent marker');
assert.ok(api.includes('border-left-color:var(--bc-group-accent,#7A8A9A)'), 'accent is the left border, flush');
assert.ok(api.includes('.bc-block.bc-booking-accent.bc-pay-stripe::before'), 'payment stripe does not paint the edge');
assert.ok(api.includes('bc-booking-accent'), 'bars carry the accent class');
assert.ok(BOOKING_ACCENT_STAY_SQL.includes("INTERVAL '2 months'"), 'accent collision window is 2 months');

const near = assignBookingAccents([
  { booking_id: 'same-hue-a', check_in: '2026-10-01', check_out: '2026-10-08' },
  { booking_id: 'same-hue-a', check_in: '2026-10-01', check_out: '2026-10-08' },
]);
assert.strictEqual(near.size, 1, 'one booking, one color');

const group = annotateCalendarBlocks([
  { booking_id: 'g1', bed_code: 'R1-B1', start_date: '2026-10-05', end_date: '2026-10-11', payment_status: 'paid' },
  { booking_id: 'g1', bed_code: 'R1-B2', start_date: '2026-10-05', end_date: '2026-10-11', payment_status: 'unpaid' },
  { booking_id: 'g2', bed_code: 'R3-B1', start_date: '2026-10-20', end_date: '2026-10-24', payment_status: 'paid' },
], []);
assert.strictEqual(group[0].calendar_group_accent, group[1].calendar_group_accent, 'beds of one booking share a color');
assert.notStrictEqual(group[0].calendar_group_accent, group[2].calendar_group_accent, 'a nearby booking does not reuse it');
assert.ok(!/#C4783A|#1B4D3E|#3E7A52|#87A87C|#7AAABB/.test(group[0].calendar_group_accent), 'accent is not a payment or status stripe');

const far = assignBookingAccents([
  { booking_id: 'reuse-me', check_in: '2026-01-02', check_out: '2026-01-06' },
  { booking_id: 'reuse-me-later', check_in: '2026-06-01', check_out: '2026-06-05' },
]);
assert.ok(far.get('reuse-me') && far.get('reuse-me-later'));

let collided = false;
for (let i = 0; i < 80 && !collided; i += 1) {
  for (let j = i + 1; j < 80; j += 1) {
    const colors = assignBookingAccents([
      { booking_id: `near-${i}`, check_in: '2026-10-01', check_out: '2026-10-04' },
      { booking_id: `near-${j}`, check_in: '2026-11-01', check_out: '2026-11-04' },
    ]);
    if (colors.get(`near-${i}`) === colors.get(`near-${j}`)) collided = true;
  }
}
assert.strictEqual(collided, false, 'no two stays within 2 months share a color in the probe set');

(async () => {
  const collision = { code: '23505', constraint: 'bookings_hostel_id_booking_code_key' };
  let attempts = 0;
  const pg = {
    async query(text) {
      if (String(text).includes('SAVEPOINT') || String(text).startsWith('ROLLBACK') || String(text).startsWith('RELEASE')) {
        return { rows: [] };
      }
      attempts += 1;
      if (attempts < 3) throw collision;
      return { rows: [{ booking_code: 'WH-20261108-1281' }] };
    },
  };
  const retried = await queryManualBookingCreateWithCodeRetry(pg, ['wolfhouse-somo', null, null, 'idem', null]);
  assert.strictEqual(retried.rows[0].booking_code, 'WH-20261108-1281');
  assert.strictEqual(attempts, 3, 'unique clash retries then succeeds');

  const db = new PGlite();
  try {
    const converted = await db.query(`
      SELECT lpad((floor(0.0123 * 10000))::int::text, 4, '0') AS suffix
    `);
    assert.strictEqual(converted.rows[0].suffix, '0123', '4-digit suffixes keep leading zeros');

    const generated = await db.query(`
      SELECT CASE
        WHEN lower(btrim($1::text)) IN ('wolfhouse-somo', 'wolfhouse')
          OR lower(btrim($1::text)) LIKE 'wolfhouse-%'
        THEN 'WH-' || to_char($2::date, 'YYYYMMDD')
                   || '-' || lpad((floor(random() * 10000))::int::text, 4, '0')
        ELSE 'MB-' || upper(left(replace($1::text, '-', ''), 6))
                   || '-' || to_char($2::date, 'YYYYMMDD')
                   || '-' || substring(md5($3::text), 1, 6)
      END AS booking_code
    `, ['wolfhouse-somo', '2026-11-08', 'booking-code-proof']);
    assert.match(generated.rows[0].booking_code, /^WH-20261108-\d{4}$/);

    const otherClient = await db.query(`
      SELECT 'MB-' || upper(left(replace($1::text, '-', ''), 6))
                   || '-' || to_char($2::date, 'YYYYMMDD')
                   || '-' || substring(md5($3::text), 1, 6) AS booking_code
    `, ['sunset-beach', '2026-10-14', 'booking-code-proof']);
    assert.match(otherClient.rows[0].booking_code, /^MB-SUNSET-20261014-[0-9a-f]{6}$/);

    console.log('verify-booking-code-wh-prefix-001: ok');
  } finally {
    await db.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
