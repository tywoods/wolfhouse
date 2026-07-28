'use strict';

/**
 * Sunset Admin Finance summary — pure, DB-free money math.
 *
 * All financial arithmetic lives here so it can be exhaustively unit-tested and
 * reviewed; the server only feeds it rows already filtered/joined per the audited
 * source contract, and the browser only renders its output (no client-side money
 * math). EUR, integer cents, Europe/Madrid calendar bucketing.
 *
 * Source contract (Skipper-audited, Stage 3 V1):
 *  - Booked      = Σ effective service-due over dated BSR rows, bucketed by
 *                  service_date. Custom lines use signed metadata.amount_cents.
 *                  Additive across rows/days.
 *  - Collected   = GROSS only (no proven refund ledger): Σ payments.amount_paid_cents
 *                  (status='paid', paid_at not null) bucketed by Madrid date of paid_at.
 *                  Independent of booking status.
 *  - Outstanding = Σ GREATEST(booking.total_amount_cents − Σpaid, 0) over DISTINCT
 *                  bookings that have ≥1 dated qualifying BSR row in the period.
 *                  NON-ADDITIVE across days (never sum daily to get the month).
 *  - Count       = number of distinct qualifying bookings.
 *  - Undated BSR rows never enter a dated period.
 *
 * Callers must pre-filter inputs (client='sunset', location_id='sunset-somo',
 * non-cancelled BSR/booking, source≠'demo_fixture_stage888' for Booked/Outstanding;
 * status='paid' + non-test for Collected). This module does not re-derive scope.
 */

const CUSTOM_LINE_MARKERS = Object.freeze(['staff_custom_line']);

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function isStaffCustomLine(metadata) {
  const md = metadata || {};
  return md.source === 'staff_custom_line'
    || md.staff_custom_line === true
    || md.component === 'staff_custom_line'
    || CUSTOM_LINE_MARKERS.includes(md.kind);
}

/**
 * Effective per-row due. Discounts cannot be stored as negative amount_due_cents
 * (DB CHECK >= 0), so staff custom commercial lines carry the signed authoritative
 * value in metadata.amount_cents — matching readPersistedServiceDueCents().
 */
function effectiveServiceDueCents(row) {
  const md = (row && row.metadata) || {};
  if (isStaffCustomLine(md) && md.amount_cents != null && Number.isFinite(Number(md.amount_cents))) {
    return toInt(md.amount_cents);
  }
  return toInt(row && row.amount_due_cents);
}

/** Calendar date (YYYY-MM-DD) of an instant in the given IANA time zone. DST-safe. */
function zonedDateString(instant, timeZone) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Pure calendar-date helpers (operate on YYYY-MM-DD via UTC midnight; no TZ math).
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}
function weekdayMon0(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
}
function monthRange(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const mm = String(m).padStart(2, '0');
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(lastDay).padStart(2, '0')}` };
}
function eachDate(range) {
  const out = [];
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) out.push(d);
  return out;
}
function inRange(dateStr, range) {
  return dateStr != null && dateStr >= range.start && dateStr <= range.end;
}

function periodRanges(now, timeZone) {
  const today = zonedDateString(now, timeZone);
  const monday = addDays(today, -weekdayMon0(today));
  return {
    today: { start: today, end: today },
    week: { start: monday, end: addDays(monday, 6) },
    month: monthRange(today),
  };
}

/**
 * @param {object} args
 * @param {Date|string} args.now
 * @param {string} [args.timeZone='Europe/Madrid']
 * @param {Array<{booking_id,service_date,amount_due_cents,metadata}>} args.bsr
 *   Dated + undated allowed; undated are ignored for dated periods.
 * @param {Array<{booking_id,amount_paid_cents,paid_at}>} args.payments  (status='paid', scoped)
 * @param {Array<{booking_id,total_amount_cents}>} args.bookings
 */
function computeSunsetFinanceSummary(args) {
  const timeZone = (args && args.timeZone) || 'Europe/Madrid';
  const now = args && args.now ? args.now : new Date();
  const bsr = Array.isArray(args && args.bsr) ? args.bsr : [];
  const payments = Array.isArray(args && args.payments) ? args.payments : [];
  const bookings = Array.isArray(args && args.bookings) ? args.bookings : [];

  const totalByBooking = new Map(bookings.map((b) => [b.booking_id, toInt(b.total_amount_cents)]));

  // Cumulative paid per booking (balance is total − ALL scoped paid, not period-scoped).
  const paidByBooking = new Map();
  for (const p of payments) {
    paidByBooking.set(p.booking_id, (paidByBooking.get(p.booking_id) || 0) + toInt(p.amount_paid_cents));
  }
  function bookingBalance(bookingId) {
    return Math.max(0, (totalByBooking.get(bookingId) || 0) - (paidByBooking.get(bookingId) || 0));
  }

  // Pre-index dated BSR rows with their effective due and Madrid payment dates.
  const datedBsr = bsr
    .filter((r) => typeof r.service_date === 'string' && r.service_date)
    .map((r) => ({ booking_id: r.booking_id, service_date: r.service_date, due: effectiveServiceDueCents(r) }));
  const datedPayments = payments
    .filter((p) => p.paid_at != null)
    .map((p) => ({ booking_id: p.booking_id, amount: toInt(p.amount_paid_cents), date: zonedDateString(p.paid_at, timeZone) }));

  function summarize(range) {
    let booked = 0;
    for (const r of datedBsr) if (inRange(r.service_date, range)) booked += r.due;

    let collected = 0;
    for (const p of datedPayments) if (inRange(p.date, range)) collected += p.amount;

    // Distinct bookings with a dated qualifying BSR row inside the range.
    const qualifying = new Set();
    for (const r of datedBsr) if (inRange(r.service_date, range)) qualifying.add(r.booking_id);
    let outstanding = 0;
    for (const bookingId of qualifying) outstanding += bookingBalance(bookingId);

    return {
      booked_cents: booked,
      collected_gross_cents: collected,
      outstanding_cents: outstanding,
      bookings_count: qualifying.size,
    };
  }

  const ranges = periodRanges(now, timeZone);
  const daily_trend = eachDate(ranges.month).map((date) => {
    const dayRange = { start: date, end: date };
    return { date, ...summarize(dayRange) };
  });

  return {
    currency: 'EUR',
    time_zone: timeZone,
    generated_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    periods: {
      today: summarize(ranges.today),
      week: summarize(ranges.week),
      month: summarize(ranges.month),
    },
    daily_trend,
    limitations: {
      net_collected_available: false,
      note: 'Collected is gross: refunds/reversals are not available until an authoritative refund ledger exists.',
    },
  };
}

/**
 * Data-quality reconciliation: the paid-payment ledger is the cash authority, so
 * Outstanding is computed as GREATEST(total_amount_cents − Σpaid, 0). Persisted
 * bookings.balance_due_cents is operational state that SHOULD equal that. This
 * surfaces any material disagreement so the staging reconciliation (and a
 * fail-closed test) can catch drift before it reaches money figures.
 *
 * @param {object} args
 * @param {Array<{booking_id,total_amount_cents,balance_due_cents}>} args.bookings
 * @param {Array<{booking_id,amount_paid_cents}>} args.payments  (scoped paid payments)
 * @param {number} [args.toleranceCents=0]  materiality threshold (integer cents)
 * @returns {{ checked:number, discrepancies:Array, material:boolean }}
 */
function reconcileBookingBalances(args) {
  const bookings = Array.isArray(args && args.bookings) ? args.bookings : [];
  const payments = Array.isArray(args && args.payments) ? args.payments : [];
  const tolerance = Number.isFinite(args && args.toleranceCents) ? Math.abs(Math.trunc(args.toleranceCents)) : 0;

  const paidByBooking = new Map();
  for (const p of payments) {
    paidByBooking.set(p.booking_id, (paidByBooking.get(p.booking_id) || 0) + toInt(p.amount_paid_cents));
  }

  const discrepancies = [];
  for (const b of bookings) {
    if (b.balance_due_cents == null) continue; // nothing persisted to reconcile against
    const computed = Math.max(0, toInt(b.total_amount_cents) - (paidByBooking.get(b.booking_id) || 0));
    const persisted = toInt(b.balance_due_cents);
    const delta = computed - persisted;
    if (Math.abs(delta) > tolerance) {
      discrepancies.push({ booking_id: b.booking_id, computed_cents: computed, persisted_cents: persisted, delta_cents: delta });
    }
  }

  return { checked: bookings.length, discrepancies, material: discrepancies.length > 0 };
}

module.exports = {
  computeSunsetFinanceSummary,
  effectiveServiceDueCents,
  zonedDateString,
  periodRanges,
  isStaffCustomLine,
  reconcileBookingBalances,
};
