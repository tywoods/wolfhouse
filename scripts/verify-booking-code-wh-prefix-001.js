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
const { buildManualBookingCreateSql } = require('./lib/staff-manual-booking-create-sql');
const {
  displayWolfhouseBookingCode,
  wolfhouseBookingCodeAliases,
} = require('./lib/wolfhouse-booking-code');
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

assert.ok(sql.includes("THEN 'WH-' || to_char($10::date, 'YYYYMMDD')"), 'wolfhouse mint is WH-date-suffix');
assert.ok(sql.includes("lower(btrim($1::text)) IN ('wolfhouse-somo', 'wolfhouse')"), 'mint is wolfhouse-gated');
assert.ok(sql.includes("'MB-' || upper(left(replace($1::text, '-', ''), 6))"), 'other clients keep MB- prefix');
assert.ok(!/^\s*'MB-' \|\| upper\(left/.test(sql), 'ungated MB- mint is gone');

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

console.log('verify-booking-code-wh-prefix-001: ok');
