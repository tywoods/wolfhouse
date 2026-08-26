'use strict';

/**
 * Bug Finder #6 — Finanzas Custom/Día Neto, bruto, and refunds must honor the
 * selected period the same way Reservado (booked pipeline) already does.
 *
 * Stay off inbox-thread, email-settings, PR #723 occupancy, PR #725 year window,
 * production, and deploy.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  computeSunsetFinanceSummary,
  resolvePrimaryRange,
  inferFinanceGranularityFromBounds,
} = require(path.join(ROOT, 'scripts/lib/sunset-finance-summary.js'));
const adminUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

function isoDaysFromNow(offset) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

const monthAnchor = isoDaysFromNow(0);
const monthYm = monthAnchor.slice(0, 7);
const customStart = `${monthYm}-01`;
const customEnd = `${monthYm}-10`;
const dayAnchor = `${monthYm}-05`;
const lateService = `${monthYm}-20`;
const lateRefund = `${monthYm}-25`;
const earlyRefund = `${monthYm}-04`;
const earlyPaidAt = `${monthYm}-05T12:00:00Z`;
const latePaidAt = `${lateService}T12:00:00Z`;
const earlyService = `${monthYm}-03`;

const now = new Date(`${monthAnchor}T10:00:00Z`);
const TZ = 'Europe/Madrid';

const bsr = [
  { booking_id: 'EARLY', service_date: earlyService, amount_due_cents: 300000, metadata: {} },
  { booking_id: 'LATE', service_date: lateService, amount_due_cents: 188900, metadata: {} },
];
const payments = [
  { booking_id: 'EARLY', amount_paid_cents: 100000, paid_at: earlyPaidAt },
  { booking_id: 'LATE', amount_paid_cents: 62000, paid_at: latePaidAt },
];
const refund_records = [
  { booking_id: 'EARLY', amount_cents: 14000, effective_date: lateRefund },
  { booking_id: 'EARLY', amount_cents: 5000, effective_date: earlyRefund },
];

function summary(view) {
  return computeSunsetFinanceSummary({
    now,
    timeZone: TZ,
    view,
    bsr,
    payments,
    refund_records,
    bookings: [],
  });
}

const month = summary({ granularity: 'month', anchor: monthAnchor });
const custom = summary({ granularity: 'custom', start: customStart, end: customEnd });
const customBoundsOnly = summary({ start: customStart, end: customEnd });
const day = summary({ granularity: 'day', anchor: dayAnchor });
const dayBoundsOnly = summary({ start: dayAnchor, end: dayAnchor });

assert.strictEqual(custom.redesign.pipeline.booked_cents, 300000, 'Custom Booked = first-10-days BSR dues');
assert.strictEqual(month.redesign.pipeline.booked_cents, 488900, 'Month Booked = full-month BSR dues');
assert.ok(
  custom.redesign.pipeline.booked_cents < month.redesign.pipeline.booked_cents,
  'Custom Booked narrows vs month',
);

assert.strictEqual(custom.redesign.net.gross_collected_cents, 100000, 'Custom gross = paid_at in custom range only');
assert.strictEqual(month.redesign.net.gross_collected_cents, 162000, 'Month gross = all month payments');
assert.strictEqual(custom.redesign.net.completed_refunds_cents, 5000, 'Custom refunds = effective dates in custom range only');
assert.strictEqual(month.redesign.net.completed_refunds_cents, 19000, 'Month refunds = all month refunds');
assert.strictEqual(custom.redesign.net.net_collected_cents, 95000, 'Custom net = gross − refunds in range');
assert.strictEqual(month.redesign.net.net_collected_cents, 143000, 'Month net = month gross − month refunds');

assert.ok(
  custom.redesign.net.gross_collected_cents < month.redesign.net.gross_collected_cents,
  'Custom gross narrows vs month',
);
assert.ok(
  custom.redesign.net.net_collected_cents < month.redesign.net.net_collected_cents,
  'Custom net narrows vs month',
);

assert.strictEqual(
  customBoundsOnly.redesign.pipeline.booked_cents,
  custom.redesign.pipeline.booked_cents,
  'bounds-only custom Booked matches explicit custom',
);
assert.strictEqual(
  customBoundsOnly.redesign.net.gross_collected_cents,
  custom.redesign.net.gross_collected_cents,
  'bounds-only custom gross matches explicit custom',
);
assert.strictEqual(
  customBoundsOnly.redesign.net.completed_refunds_cents,
  custom.redesign.net.completed_refunds_cents,
  'bounds-only custom refunds match explicit custom',
);
assert.strictEqual(customBoundsOnly.redesign.view.granularity, 'custom', 'bounds-only infers custom granularity');

assert.strictEqual(day.redesign.net.gross_collected_cents, 100000, 'Day gross = payment on selected day');
assert.strictEqual(dayBoundsOnly.redesign.net.gross_collected_cents, 100000, 'day bounds-only gross');
assert.strictEqual(dayBoundsOnly.redesign.view.granularity, 'day', 'bounds-only infers day granularity');

const inferred = resolvePrimaryRange({
  now,
  timeZone: TZ,
  view: { start: customStart, end: customEnd },
});
assert.strictEqual(inferred.granularity, 'custom');
assert.strictEqual(inferred.range.start, customStart);
assert.strictEqual(inferred.range.end, customEnd);

assert.strictEqual(inferFinanceGranularityFromBounds(dayAnchor, dayAnchor), 'day');
assert.strictEqual(inferFinanceGranularityFromBounds(customStart, customEnd), 'custom');

assert.ok(
  /g === 'day'[\s\S]*&start=/.test(adminUi) && /&end=/.test(adminUi),
  'Day query carries explicit start=end=anchor bounds',
);
assert.ok(
  /cache:\s*'no-store'/.test(adminUi) && /loadAdminFinanceSummary/.test(adminUi),
  'finance summary fetch bypasses cache',
);
assert.ok(
  /computeSunsetFinanceSummary\(\{ \.\.\.data, now: new Date\(\), timeZone: 'Europe\/Madrid', view \}\)/.test(api),
  'handler keeps query view authoritative over fetch payload',
);
assert.ok(!adminUi.includes('inbox-thread.js'), 'stay off inbox-thread');

console.log('PASS Bug Finder #6 Finanzas Custom/Día net/gross/refunds honor selected period');
