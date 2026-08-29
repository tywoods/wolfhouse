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
 *  - Outstanding = Σ GREATEST(authoritative booking total − Σpaid, 0) over DISTINCT
 *                  bookings that have ≥1 dated qualifying BSR row in the period.
 *                  The persisted booking total wins when present; legacy null totals
 *                  fall back to every qualifying effective BSR commercial row once.
 *                  NON-ADDITIVE across days (never sum daily to get the month).
 *  - Redesign Pendiente (period outstanding / Day·Month·Year·Custom hero):
 *                  For each unpaid booking with dated BSR in the selected period:
 *                    period_bal = min(booking_balance, max(0, Σ effective dues in period))
 *                  Then Pendiente = min(Σ period_bal, max(0, Booked)).
 *                  Aging (due soon / overdue) and delivered-unpaid use the same
 *                  period_bal basis and inherit the Booked cap (never invent money).
 *                  Needed because negative custom-line dues shrink Booked while
 *                  max(0, period_due) still attributes full positive dues as unpaid.
 *  - Count       = number of distinct qualifying bookings.
 *  - Undated BSR rows never enter a dated period.
 *
 * Callers must pre-filter inputs (client='sunset', location_id='sunset-somo',
 * non-cancelled BSR/booking, source≠'demo_fixture_stage888' for Booked/Outstanding;
 * status='paid' + non-test for Collected). This module does not re-derive scope.
 */

const CUSTOM_LINE_MARKERS = Object.freeze(['staff_custom_line']);

class FinanceDataQualityError extends Error {
  constructor() {
    super('finance data quality check failed');
    this.name = 'FinanceDataQualityError';
    this.code = 'FINANCE_DATA_QUALITY';
  }
  toJSON() { return { name: this.name, code: this.code }; }
}

/**
 * Parse a monetary integer-cents value.
 * Accepts safe integers and canonical decimal integer strings only
 * (no leading zeros, no scientific notation, no fractions).
 * @returns {{ ok:true, value:number } | { ok:false, reason:string }}
 */
function parseCanonicalIntCents(value) {
  if (value === null || value === undefined || value === '') {
    return { ok: false, reason: 'null_or_empty' };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false, reason: 'non_finite' };
    if (!Number.isSafeInteger(value)) return { ok: false, reason: 'non_integer_or_unsafe' };
    return { ok: true, value };
  }
  if (typeof value === 'string') {
    // Canonical only — no trim, no leading zeros, no scientific notation.
    // Leading/trailing whitespace is non-canonical (matches prior hard toInt).
    if (!value) return { ok: false, reason: 'null_or_empty' };
    if (!/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value)) {
      return { ok: false, reason: 'non_canonical' };
    }
    const n = Number(value);
    if (!Number.isSafeInteger(n)) return { ok: false, reason: 'non_integer_or_unsafe' };
    return { ok: true, value: n };
  }
  return { ok: false, reason: 'unsupported_type' };
}

/**
 * Sanitized diagnostic record — IDs + field source only. Never amounts, names, phones.
 * @param {object} entry
 * @returns {object}
 */
function sanitizeFinanceOffendingRecord(entry) {
  const e = entry || {};
  const out = {
    source: e.source != null ? String(e.source) : 'unknown',
    reason: e.reason != null ? String(e.reason) : 'malformed',
  };
  if (e.booking_id != null && String(e.booking_id).trim()) {
    out.booking_id = String(e.booking_id).trim();
  }
  if (e.payment_id != null && String(e.payment_id).trim()) {
    out.payment_id = String(e.payment_id).trim();
  }
  if (e.refund_id != null && String(e.refund_id).trim()) {
    out.refund_id = String(e.refund_id).trim();
  }
  if (e.service_record_id != null && String(e.service_record_id).trim()) {
    out.service_record_id = String(e.service_record_id).trim();
  }
  return out;
}

/** Module-level soft-fail diagnostics sink for one compute/fetch pass. */
let _financeDiagSink = null;

function createFinanceDiagnostics() {
  return { malformed: [], balance_drift: [], reconciliation_unavailable: [] };
}

/**
 * Raw commercial cents field for a BSR row (custom lines use signed metadata.amount_cents).
 * @param {object} row
 * @returns {*}
 */
function bsrRawCommercialAmount(row) {
  const md = (row && row.metadata) || {};
  if (isStaffCustomLine(md) && md.amount_cents != null) return md.amount_cents;
  return row && row.amount_due_cents;
}

function reportMalformedMonetary(entry) {
  const rec = sanitizeFinanceOffendingRecord(entry);
  if (_financeDiagSink && Array.isArray(_financeDiagSink.malformed)) {
    _financeDiagSink.malformed.push(rec);
  }
  try {
    // Structured, sanitized only — no amounts / PII.
    console.warn('[finance.data_quality] malformed_monetary_row', JSON.stringify(rec));
  } catch (_e) { /* ignore log failures */ }
  return rec;
}

/**
 * Material balance-drift diagnostic. Includes booking_id + reconciliation fields
 * (computed/persisted/delta cents) so Captain can identify stale balance_due rows.
 * Never includes guest names/phones. Soft-fail only — does not throw.
 */
function reportMaterialBalanceDrift(entry) {
  const e = entry || {};
  const rec = {
    source: e.source != null ? String(e.source) : 'booking.balance_due_cents',
    reason: e.reason != null ? String(e.reason) : 'material_balance_drift',
  };
  if (e.booking_id != null && String(e.booking_id).trim()) {
    rec.booking_id = String(e.booking_id).trim();
  }
  // Reconciliation fields (integer cents) are intentional operator diagnostics.
  if (Number.isFinite(e.computed_cents)) rec.computed_cents = Math.trunc(e.computed_cents);
  if (Number.isFinite(e.persisted_cents)) rec.persisted_cents = Math.trunc(e.persisted_cents);
  if (Number.isFinite(e.delta_cents)) rec.delta_cents = Math.trunc(e.delta_cents);
  if (_financeDiagSink && Array.isArray(_financeDiagSink.balance_drift)) {
    _financeDiagSink.balance_drift.push(rec);
  }
  try {
    console.warn('[finance.data_quality] material_balance_drift', JSON.stringify(rec));
  } catch (_e) { /* ignore log failures */ }
  return rec;
}

/** Run fn with diagnostics sink active (for fetch soft-scan without full compute). */
function withFinanceDiagnostics(diagnostics, fn) {
  const diag = diagnostics || createFinanceDiagnostics();
  const prev = _financeDiagSink;
  _financeDiagSink = diag;
  try {
    return fn(diag);
  } finally {
    _financeDiagSink = prev;
  }
}

/**
 * Hard parse — throws FinanceDataQualityError. Reserved for already-validated
 * aggregate math (checkedAdd/Subtract) and genuine invariant failures.
 */
function toInt(value) {
  const parsed = parseCanonicalIntCents(value);
  if (!parsed.ok) throw new FinanceDataQualityError();
  return parsed.value;
}

/**
 * Soft parse for a single monetary row field. Malformed → 0 + diagnostic log.
 * One bad row must never abort the whole summary.
 */
function toIntSoft(value, ctx) {
  const parsed = parseCanonicalIntCents(value);
  if (parsed.ok) return parsed.value;
  reportMalformedMonetary({ ...(ctx || {}), reason: parsed.reason });
  return 0;
}

function checkedAdd(a, b) {
  const left = toInt(a); const right = toInt(b);
  if ((right > 0 && left > Number.MAX_SAFE_INTEGER - right)
    || (right < 0 && left < Number.MIN_SAFE_INTEGER - right)) throw new FinanceDataQualityError();
  return left + right;
}

function checkedSubtract(a, b) {
  const left = toInt(a); const right = toInt(b);
  if ((right < 0 && left > Number.MAX_SAFE_INTEGER + right)
    || (right > 0 && left < Number.MIN_SAFE_INTEGER + right)) throw new FinanceDataQualityError();
  return left - right;
}

function isStaffCustomLine(metadata) {
  const md = metadata || {};
  return md.source === 'staff_custom_line'
    || md.staff_custom_line === true
    || md.component === 'staff_custom_line'
    || CUSTOM_LINE_MARKERS.includes(md.kind);
}

/**
 * Enforce redesign invariant: period Pendiente (and its aging pills) ≤ Booked.
 * Scales due-soon / overdue / delivered-unpaid by the same ratio when the cap binds
 * so pills stay consistent with the hero total. Does not invent prices — only caps
 * derived unpaid attribution to the period's net booked cents from Staff API rows.
 *
 * @param {{
 *   period_outstanding_cents: number,
 *   due_soon_cents: number,
 *   overdue_cents: number,
 *   delivered_unpaid_cents: number,
 *   booked_cents: number,
 * }} parts
 * @returns {{
 *   period_outstanding_cents: number,
 *   due_soon_cents: number,
 *   overdue_cents: number,
 *   delivered_unpaid_cents: number,
 * }}
 */
function capPeriodOutstandingToBooked(parts) {
  const bookedCap = Math.max(0, Number(parts.booked_cents) || 0);
  let outstanding = Math.max(0, Number(parts.period_outstanding_cents) || 0);
  let dueSoon = Math.max(0, Number(parts.due_soon_cents) || 0);
  let overdue = Math.max(0, Number(parts.overdue_cents) || 0);
  let delivered = Math.max(0, Number(parts.delivered_unpaid_cents) || 0);
  if (outstanding <= bookedCap) {
    return {
      period_outstanding_cents: outstanding,
      due_soon_cents: dueSoon,
      overdue_cents: overdue,
      delivered_unpaid_cents: Math.min(delivered, bookedCap),
    };
  }
  if (outstanding <= 0) {
    return {
      period_outstanding_cents: bookedCap,
      due_soon_cents: 0,
      overdue_cents: 0,
      delivered_unpaid_cents: 0,
    };
  }
  // Integer-safe proportional scale; fix rounding on the larger aging bucket.
  const scaleNum = bookedCap;
  const scaleDen = outstanding;
  dueSoon = Math.floor((dueSoon * scaleNum) / scaleDen);
  overdue = Math.floor((overdue * scaleNum) / scaleDen);
  delivered = Math.floor((delivered * scaleNum) / scaleDen);
  let aging = dueSoon + overdue;
  if (aging !== bookedCap) {
    const delta = bookedCap - aging;
    if (dueSoon >= overdue) dueSoon += delta;
    else overdue += delta;
    if (dueSoon < 0) {
      overdue += dueSoon;
      dueSoon = 0;
    }
    if (overdue < 0) {
      dueSoon += overdue;
      overdue = 0;
    }
  }
  outstanding = bookedCap;
  delivered = Math.min(Math.max(0, delivered), bookedCap);
  return {
    period_outstanding_cents: outstanding,
    due_soon_cents: Math.max(0, dueSoon),
    overdue_cents: Math.max(0, overdue),
    delivered_unpaid_cents: delivered,
  };
}

/**
 * Effective per-row due. Discounts cannot be stored as negative amount_due_cents
 * (DB CHECK >= 0), so staff custom commercial lines carry the signed authoritative
 * value in metadata.amount_cents — matching readPersistedServiceDueCents().
 *
 * Soft by default: malformed/null/non-finite/non-integer → 0 + structured log.
 * Pass { hard: true } only for callers that intentionally fail closed.
 */
function effectiveServiceDueCents(row, opts) {
  const hard = !!(opts && opts.hard);
  const md = (row && row.metadata) || {};
  const ctx = {
    source: isStaffCustomLine(md) && md.amount_cents != null
      ? 'bsr.metadata.amount_cents'
      : 'bsr.amount_due_cents',
    booking_id: row && row.booking_id != null ? row.booking_id : null,
    service_record_id: row && (row.service_record_id || row.id) != null
      ? (row.service_record_id || row.id)
      : null,
  };
  if (isStaffCustomLine(md) && md.amount_cents != null) {
    return hard ? toInt(md.amount_cents) : toIntSoft(md.amount_cents, ctx);
  }
  const raw = row && row.amount_due_cents;
  return hard ? toInt(raw) : toIntSoft(raw, ctx);
}

function authoritativeTotalByBooking(bookings, bsr) {
  const fallback = new Map();
  for (const row of bsr) {
    fallback.set(row.booking_id, checkedAdd(fallback.get(row.booking_id) || 0, effectiveServiceDueCents(row)));
  }
  return new Map(bookings.map((booking) => {
    if (booking.total_amount_cents == null) {
      return [booking.booking_id, fallback.get(booking.booking_id) || 0];
    }
    // Present but malformed total → soft 0 (do not silently swap to BSR fallback).
    return [
      booking.booking_id,
      toIntSoft(booking.total_amount_cents, {
        source: 'booking.total_amount_cents',
        booking_id: booking.booking_id,
      }),
    ];
  }));
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
function monthRangeForYearMonth(year, month) {
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` };
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

function yearRange(dateStr) {
  const y = Number(String(dateStr).slice(0, 4));
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

/** True when start/end span one full calendar year (Jan 1 → Dec 31). */
function isFullCalendarYearRange(start, end) {
  if (!start || !end || start > end) return false;
  const y = String(start).slice(0, 4);
  if (!/^\d{4}$/.test(y)) return false;
  return start === `${y}-01-01` && end === `${y}-12-31`;
}

/** Inclusive day count for a resolved period (occupancy denominators scale by this). */
function periodDayCount(range) {
  if (!range || !range.start || !range.end) return 1;
  const days = eachDate(range).length;
  return days > 0 ? days : 1;
}

function shiftRangeYears(range, years) {
  const shift = (iso) => {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return iso;
    const ny = y + years;
    // Clamp invalid calendar days (e.g. 2024-02-29 → 2023-02-28).
    const lastDay = new Date(Date.UTC(ny, m, 0)).getUTCDate();
    const day = Math.min(d, lastDay);
    return `${ny}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };
  return { start: shift(range.start), end: shift(range.end) };
}

function priorPeriodRange(range, granularity) {
  const g = String(granularity || 'month');
  if (g === 'day') {
    const prev = addDays(range.start, -1);
    return { start: prev, end: prev };
  }
  if (g === 'year') {
    return shiftRangeYears(range, -1);
  }
  // month (default) and custom: previous equal-length block ending day before start
  if (g === 'month') {
    const prevEnd = addDays(range.start, -1);
    return monthRange(prevEnd);
  }
  // custom: same length immediately before
  const days = eachDate(range).length;
  const end = addDays(range.start, -1);
  const start = addDays(end, -(days - 1));
  return { start, end };
}

/**
 * Next-30 window inside the selected period (not a fixed wall-clock ops window).
 * - Past periods (entirely before today): empty — nothing upcoming in-selection.
 * - Periods that include today: today … min(today+29, period.end).
 * - Future periods: period.start … min(period.start+29, period.end).
 * @param {{start:string,end:string}} primaryRange
 * @param {string} today YYYY-MM-DD in location TZ
 * @returns {{start:string,end:string}|null}
 */
function next30RangeForPeriod(primaryRange, today) {
  if (!primaryRange || !primaryRange.start || !primaryRange.end || !today) return null;
  if (today > primaryRange.end) return null;
  const start = today < primaryRange.start ? primaryRange.start : today;
  const capped = addDays(start, 29);
  const end = capped < primaryRange.end ? capped : primaryRange.end;
  if (start > end) return null;
  return { start, end };
}

function sumCollectedGrossForRange(datedPayments, range) {
  let collected = 0;
  for (const p of datedPayments) {
    if (inRange(p.date, range)) collected = checkedAdd(collected, p.amount);
  }
  return collected;
}

function sumBookedDuesForRange(datedBsr, range) {
  let booked = 0;
  for (const r of datedBsr) {
    if (inRange(r.service_date, range)) booked = checkedAdd(booked, r.due);
  }
  return booked;
}

/**
 * Fixed Jan→Dec monthly series for the selected calendar year.
 * Includes Staff API BSR dues (booked) and gross collected so Year KPIs can be
 * reconciled to the chart without inventing prices.
 */
function monthlyCollectedGrossTrend(datedPayments, year, datedBsr) {
  const y = Number(year);
  if (!Number.isFinite(y)) return [];
  const bsrRows = Array.isArray(datedBsr) ? datedBsr : [];
  const rows = [];
  for (let month = 1; month <= 12; month += 1) {
    const range = monthRangeForYearMonth(y, month);
    const lyRange = shiftRangeYears(range, -1);
    rows.push({
      year: y,
      month,
      start: range.start,
      end: range.end,
      booked_cents: sumBookedDuesForRange(bsrRows, range),
      ly_booked_cents: sumBookedDuesForRange(bsrRows, lyRange),
      collected_gross_cents: sumCollectedGrossForRange(datedPayments, range),
      ly_collected_gross_cents: sumCollectedGrossForRange(datedPayments, lyRange),
    });
  }
  return rows;
}

/**
 * Product bar bucket for a BSR row (or service_type + optional metadata).
 * Canonical DB types map directly; addon_service/unknown use metadata.component
 * and/or metadata.offering_key tokens (board→boards, suit→wetsuits).
 */
function productBucket(serviceTypeOrRow, metadataMaybe) {
  let serviceType;
  let metadata;
  if (serviceTypeOrRow && typeof serviceTypeOrRow === 'object' && !Array.isArray(serviceTypeOrRow)) {
    serviceType = serviceTypeOrRow.service_type;
    metadata = serviceTypeOrRow.metadata || {};
  } else {
    serviceType = serviceTypeOrRow;
    metadata = metadataMaybe || {};
  }
  const t = String(serviceType || '').toLowerCase();
  if (t === 'surf_lesson') return 'lessons';
  if (t === 'surfboard') return 'boards';
  if (t === 'wetsuit') return 'wetsuits';
  // addon_service / yoga / meal / unknown — discriminator tokens
  const token = `${metadata.component || ''} ${metadata.offering_key || ''}`.toLowerCase();
  const hasBoard = /surfboard|\bboard\b/.test(token);
  const hasSuit = /wetsuit|\bsuit\b/.test(token);
  if (hasBoard && !hasSuit) return 'boards';
  if (hasSuit && !hasBoard) return 'wetsuits';
  return 'retail';
}

/**
 * F2/F-cleanup — exactly 5 revenue rows for the selected period:
 *  1. Lessons (surf_lesson / course)
 *  2. Course-included item(s) — offerings marked course-includable on packs;
 *     sum across during_course + all_day + standalone modes
 *  3–4. Next 2 items by € revenue (excluding lessons + course-included keys)
 *  5. Other — remainder (all unranked items) as its own row.
 * Capacity mirrors only the first 4 (no Other — Other has no stock denominator).
 * Empty/sparse periods keep the 5-row structure with €0 slots.
 */
function courseIncludableOfferingKeys(surfPacks) {
  const keys = new Set();
  for (const pack of Array.isArray(surfPacks) ? surfPacks : []) {
    const cfg = pack && pack.config && typeof pack.config === 'object' ? pack.config : {};
    const opts = Array.isArray(pack && pack.equipment_options)
      ? pack.equipment_options
      : (Array.isArray(cfg.equipment_options) ? cfg.equipment_options : []);
    for (const o of opts) {
      const k = String((o && o.offering_key) || '').trim();
      if (k) keys.add(k);
    }
  }
  return keys;
}

function revenueItemKeyAndLabel(row) {
  const md = (row && row.metadata) || {};
  const st = String(row && row.service_type || '').toLowerCase();
  // Lessons / courses
  if (st === 'surf_lesson' || st === 'course' || md.component === 'course') {
    return { kind: 'lessons', key: 'lessons', label: 'Lessons' };
  }
  const offering = String(md.offering_key || '').trim();
  if (offering) {
    let label = String(md.offering_label || md.label || md.staff_ui_service_type || offering)
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    if (/^staff\s+accommodation$/i.test(label) || offering === 'staff_accommodation') {
      label = 'Accommodation';
    } else if (/accommodation/i.test(label) && /staff/i.test(label)) {
      label = 'Accommodation';
    }
    return { kind: 'item', key: offering, label: label || offering };
  }
  // Legacy typed rentals without offering_key
  if (st === 'surfboard') return { kind: 'item', key: 'board_rental', label: 'Board rental' };
  if (st === 'wetsuit') return { kind: 'item', key: 'wetsuit_rental', label: 'Wetsuit rental' };
  const bucket = productBucket(row);
  if (bucket === 'boards') return { kind: 'item', key: 'board_rental', label: 'Board rental' };
  if (bucket === 'wetsuits') return { kind: 'item', key: 'wetsuit_rental', label: 'Wetsuit rental' };
  const fallback = String(md.component || st || 'other').trim() || 'other';
  return {
    kind: 'item',
    key: `misc:${fallback}`,
    label: fallback.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  };
}

function buildRevenueByProductRows(datedBsr, range, surfPacks) {
  const includable = courseIncludableOfferingKeys(surfPacks);
  let lessonsCents = 0;
  const itemCents = new Map(); // key -> { cents, label }
  const courseIncludedParts = new Map(); // offering keys that are includable

  for (const r of Array.isArray(datedBsr) ? datedBsr : []) {
    if (!inRange(r.service_date, range)) continue;
    const due = Number.isFinite(r.due) ? r.due : 0;
    if (!Number.isFinite(due)) continue;
    const id = revenueItemKeyAndLabel(r);
    if (id.kind === 'lessons') {
      lessonsCents = checkedAdd(lessonsCents, due);
      continue;
    }
    const prev = itemCents.get(id.key) || { cents: 0, label: id.label };
    prev.cents = checkedAdd(prev.cents, due);
    if (!prev.label) prev.label = id.label;
    itemCents.set(id.key, prev);
    if (includable.has(id.key)) courseIncludedParts.set(id.key, true);
  }

  // Course-included row: sum ALL modes for includable offering keys (even if €0).
  let courseIncludedCents = 0;
  const courseIncludedLabels = [];
  for (const key of includable) {
    const row = itemCents.get(key);
    if (row) {
      courseIncludedCents = checkedAdd(courseIncludedCents, row.cents);
      if (row.label) courseIncludedLabels.push(row.label);
      itemCents.delete(key); // exclude from ranked top-2 / other
    }
  }
  // If packs define no includable set, but period has course_equipment rows, treat those keys as included.
  if (includable.size === 0) {
    for (const r of Array.isArray(datedBsr) ? datedBsr : []) {
      if (!inRange(r.service_date, range)) continue;
      const md = r.metadata || {};
      if (md.course_equipment === true || md.course_equipment === 'true') {
        const k = String(md.offering_key || '').trim();
        if (!k) continue;
        const row = itemCents.get(k);
        if (row) {
          courseIncludedCents = checkedAdd(courseIncludedCents, row.cents);
          if (row.label) courseIncludedLabels.push(row.label);
          itemCents.delete(k);
          courseIncludedParts.set(k, true);
        }
      }
    }
  }

  const ranked = Array.from(itemCents.entries())
    .map(([key, v]) => ({ key, label: v.label || key, cents: v.cents }))
    .sort((a, b) => {
      if (b.cents !== a.cents) return b.cents - a.cents;
      return String(a.label).localeCompare(String(b.label));
    });

  const top1 = ranked[0] || { key: 'item_1', label: '—', cents: 0 };
  const top2 = ranked[1] || { key: 'item_2', label: '—', cents: 0 };
  let remainderCents = 0;
  for (let i = 2; i < ranked.length; i++) {
    remainderCents = checkedAdd(remainderCents, ranked[i].cents);
  }

  const courseLabel = courseIncludedLabels.length
    ? (courseIncludedLabels.length === 1
      ? courseIncludedLabels[0]
      : 'Course equipment')
    : 'Course equipment';

  const rows = [
    { key: 'lessons', label: 'Lessons', cents: lessonsCents, slot: 'lessons' },
    {
      key: 'course_included',
      label: courseLabel,
      cents: courseIncludedCents,
      slot: 'course_included',
      offering_keys: Array.from(courseIncludedParts.keys()),
    },
    {
      key: top1.key === 'item_1' ? 'rank_1' : top1.key,
      label: top1.cents > 0 || ranked[0] ? top1.label : '—',
      cents: top1.cents,
      slot: 'rank_1',
      offering_keys: top1.key && top1.key !== 'item_1' ? [top1.key] : [],
    },
    {
      key: top2.key === 'item_2' ? 'rank_2' : top2.key,
      label: top2.cents > 0 || ranked[1] ? top2.label : '—',
      cents: top2.cents,
      slot: 'rank_2',
      offering_keys: top2.key && top2.key !== 'item_2' ? [top2.key] : [],
    },
    {
      key: 'other',
      label: 'Other',
      cents: remainderCents,
      slot: 'other',
      offering_keys: [],
    },
  ];

  // Full product total (the Other row already carries the unranked remainder).
  const productTotal = rows.reduce((a, p) => checkedAdd(a, p.cents), 0);
  return rows.map((p) => {
    const pct = productTotal > 0 ? Math.round((1000 * p.cents) / productTotal) / 10 : 0;
    return {
      key: p.key,
      label: p.label,
      cents: p.cents,
      pct,
      slot: p.slot,
      offering_keys: p.offering_keys || undefined,
    };
  });
}

function metaFlagTrue(md, key) {
  const v = md && md[key];
  return v === true || v === 'true' || v === 1 || v === '1';
}

function metaFlagFalse(md, key) {
  const v = md && md[key];
  return v === false || v === 'false' || v === 0 || v === '0';
}

function isCourseLikeRow(row) {
  const md = (row && row.metadata) || {};
  const st = String(row && row.service_type || '').toLowerCase();
  if (st !== 'surf_lesson') return false;
  const ui = String(md.staff_ui_service_type || md.component || '').toLowerCase();
  return ui === 'course' || ui === 'private_lesson' || !!md.course_id || ui === 'lesson' || ui === '';
}

function gearOutFromBsr(datedFullBsr, range) {
  let boards = 0;
  let wetsuits = 0;
  for (const r of datedFullBsr) {
    if (!inRange(r.service_date, range)) continue;
    const md = r.metadata || {};
    const qty = Number.isFinite(r.quantity) && r.quantity > 0 ? Math.trunc(r.quantity) : 1;
    const st = String(r.service_type || '').toLowerCase();
    if (st === 'surfboard') {
      boards += qty;
      continue;
    }
    if (st === 'wetsuit') {
      wetsuits += qty;
      continue;
    }
    if (st !== 'surf_lesson') continue;
    if (metaFlagTrue(md, 'no_equipment') || metaFlagTrue(md, 'own_equipment')) continue;
    const courseLike = md.component === 'course'
      || md.staff_ui_service_type === 'course'
      || md.component === 'private_lesson'
      || md.staff_ui_service_type === 'private_lesson'
      || md.component === 'lesson'
      || md.staff_ui_service_type === 'lesson'
      || !!md.course_id;
    // Explicit include flags win; course-like defaults to board+wetsuit when unset.
    const boardYes = metaFlagTrue(md, 'include_board')
      || (courseLike && md.include_board == null && !metaFlagFalse(md, 'include_board'));
    const suitYes = metaFlagTrue(md, 'include_wetsuit')
      || (courseLike && md.include_wetsuit == null && !metaFlagFalse(md, 'include_wetsuit'));
    if (boardYes) boards += qty;
    if (suitYes) wetsuits += qty;
  }
  return { boards_out: boards, wetsuits_out: wetsuits };
}

function stockTotals(rentalStock) {
  const list = Array.isArray(rentalStock) ? rentalStock : [];
  let boards = null;
  let wetsuits = null;
  let boardsSet = false;
  let wetsuitsSet = false;
  for (const item of list) {
    if (!item || item.active === false) continue;
    const key = `${item.offering_key || ''} ${item.group_key || ''} ${item.label || ''}`.toLowerCase();
    const n = item.stock_quantity;
    if (n == null || !Number.isInteger(n)) continue;
    const hasBoardToken = /board|surfboard|sup/.test(key);
    // suit token: wetsuit, or bare "suit" (board+suit / Board+suit)
    const hasSuitToken = /wetsuit|wet\s*suit|(?:^|[^a-z])suit(?:[^a-z]|$)/.test(key);
    // Bundle = explicit legacy forms OR (board token AND suit token) e.g. board+suit
    const isBundle = /board_and_suit|bundle/.test(key) || (hasBoardToken && hasSuitToken);
    const isBoardOnly = hasBoardToken && !hasSuitToken;
    const isSuitOnly = hasSuitToken && !hasBoardToken;
    if (isBoardOnly || isBundle) {
      boards = boardsSet ? boards + n : n;
      boardsSet = true;
    }
    if (isSuitOnly || isBundle) {
      wetsuits = wetsuitsSet ? wetsuits + n : n;
      wetsuitsSet = true;
    }
  }
  return {
    boards_stock: boardsSet ? boards : null,
    wetsuits_stock: wetsuitsSet ? wetsuits : null,
  };
}

function defaultPackGroupSize(surfPacks) {
  const packs = Array.isArray(surfPacks) ? surfPacks : [];
  let best = null;
  for (const p of packs) {
    if (p && Number.isFinite(p.group_size) && p.group_size > 0) {
      if (best == null || p.group_size > best) best = p.group_size;
    }
  }
  return best;
}

function packSizeForRow(row, surfPacks, fallback) {
  const packs = Array.isArray(surfPacks) ? surfPacks : [];
  const md = (row && row.metadata) || {};
  const courseId = md.course_id != null ? String(md.course_id) : '';
  if (courseId) {
    const hit = packs.find((p) => String(p.pack_id) === courseId);
    if (hit && hit.group_size) return hit.group_size;
  }
  // Prefer pack matching label fragment
  const label = String(md.course_label || md.pack_label || '').toLowerCase();
  if (label) {
    const hit = packs.find((p) => String(p.label || '').toLowerCase() === label);
    if (hit && hit.group_size) return hit.group_size;
  }
  return fallback;
}

function pctInt(num, den) {
  if (den == null || den <= 0 || num == null) return null;
  return Math.round((100 * num) / den);
}

function deltaPct(current, previous) {
  if (previous == null || previous === 0) {
    if (current == null || current === 0) return null;
    return null; // undefined baseline — UI shows "—"
  }
  return Math.round(((current - previous) * 1000) / previous) / 10; // one decimal
}

/**
 * Resolve the primary viewing range for Option B navigator.
 * @param {{now,timeZone,view?:{granularity?:string,start?:string,end?:string,anchor?:string}}} args
 */
function resolvePrimaryRange(args) {
  const timeZone = (args && args.timeZone) || 'Europe/Madrid';
  const now = args && args.now ? args.now : new Date();
  const today = zonedDateString(now, timeZone);
  const view = (args && args.view) || {};
  let granularity = String(view.granularity || 'month').toLowerCase();
  if (!['day', 'month', 'year', 'custom'].includes(granularity)) granularity = 'month';

  const start = (view.start && /^\d{4}-\d{2}-\d{2}$/.test(view.start)) ? view.start : '';
  const end = (view.end && /^\d{4}-\d{2}-\d{2}$/.test(view.end)) ? view.end : '';

  // Client may send full-year bounds when granularity is dropped on the wire — never collapse to anchor month.
  if (start && end && isFullCalendarYearRange(start, end)) {
    granularity = 'year';
  }

  if (granularity === 'custom' && start && end && start <= end) {
    return { granularity, range: { start, end }, today };
  }

  const anchor = (view.anchor && /^\d{4}-\d{2}-\d{2}$/.test(view.anchor)) ? view.anchor : today;
  if (granularity === 'day') {
    return { granularity: 'day', range: { start: anchor, end: anchor }, today };
  }
  if (granularity === 'year') {
    const range = (start && end && isFullCalendarYearRange(start, end))
      ? { start, end }
      : yearRange(anchor);
    return { granularity: 'year', range, today };
  }
  return { granularity: 'month', range: monthRange(anchor), today };
}

/**
 * @param {object} args
 * @param {Date|string} args.now
 * @param {string} [args.timeZone='Europe/Madrid']
 * @param {Array<{booking_id,service_date,amount_due_cents,metadata,service_type?,quantity?}>} args.bsr
 *   Dated + undated allowed; undated are ignored for dated periods.
 * @param {Array<{booking_id,amount_paid_cents,paid_at}>} args.payments  (status='paid', scoped)
 * @param {Array<{booking_id,total_amount_cents}>} args.bookings
 * @param {Array<{booking_id,amount_paid_cents,paid_at}>} [args.pending_refund_payments]  // Slice 2: ignored (retired proxy)
 * @param {Array<{booking_id,amount_cents,effective_date,location_id?}>} [args.refund_records]
 * @param {boolean} [args.refund_ledger_unavailable]
 * @param {Array} [args.rental_stock]
 * @param {Array} [args.surf_packs]
 * @param {{granularity?:string,anchor?:string,start?:string,end?:string}} [args.view]
 */
function computeSunsetFinanceSummary(args) {
  const timeZone = (args && args.timeZone) || 'Europe/Madrid';
  const now = args && args.now ? args.now : new Date();
  const bsr = Array.isArray(args && args.bsr) ? args.bsr : [];
  const payments = Array.isArray(args && args.payments) ? args.payments : [];
  const bookings = Array.isArray(args && args.bookings) ? args.bookings : [];
  // Slice 2: pending cancellation proxy retired from Net — do not sum pending_refund_payments.
  const refundRecords = Array.isArray(args && args.refund_records) ? args.refund_records : [];
  const refundLedgerUnavailable = !!(args && args.refund_ledger_unavailable);
  const rentalStock = Array.isArray(args && args.rental_stock) ? args.rental_stock : [];
  const surfPacks = Array.isArray(args && args.surf_packs) ? args.surf_packs : [];

  // Soft-fail diagnostics for this pass (malformed rows → 0; overflow still hard-fails).
  const diagnostics = (args && args.diagnostics && typeof args.diagnostics === 'object')
    ? args.diagnostics
    : createFinanceDiagnostics();
  const prevSink = _financeDiagSink;
  _financeDiagSink = diagnostics;

  try {
  const totalByBooking = authoritativeTotalByBooking(bookings, bsr);

  // Soft-parse each payment once (cumulative paid + dated collected share the same amount).
  const paymentAmounts = payments.map((p) => ({
    booking_id: p.booking_id,
    paid_at: p.paid_at,
    amount: toIntSoft(p.amount_paid_cents, {
      source: 'payment.amount_paid_cents',
      booking_id: p.booking_id,
      payment_id: p.payment_id || p.id || null,
    }),
  }));

  // Cumulative paid per booking (balance is total − ALL scoped paid, not period-scoped).
  const paidByBooking = new Map();
  for (const p of paymentAmounts) {
    paidByBooking.set(p.booking_id, checkedAdd(paidByBooking.get(p.booking_id) || 0, p.amount));
  }

  // Pre-index dated BSR rows with their effective due and Madrid payment dates.
  const datedBsr = bsr
    .filter((r) => typeof r.service_date === 'string' && r.service_date)
    .map((r) => ({
      booking_id: r.booking_id,
      service_date: r.service_date,
      due: effectiveServiceDueCents(r),
      service_type: r.service_type != null ? String(r.service_type) : null,
      quantity: r.quantity != null && Number.isFinite(Number(r.quantity)) ? Number(r.quantity) : 1,
      metadata: r.metadata || {},
    }));
  const datedPayments = paymentAmounts
    .filter((p) => p.paid_at != null)
    .map((p) => ({
      booking_id: p.booking_id,
      amount: p.amount,
      date: zonedDateString(p.paid_at, timeZone),
    }));

  // Refunds bucketed by effective_date (DATE / YYYY-MM-DD) — same inclusive inRange as other series.
  const datedRefunds = refundRecords
    .map((r) => ({
      booking_id: r.booking_id,
      amount: toIntSoft(r.amount_cents, {
        source: 'refund.amount_cents',
        booking_id: r.booking_id,
        refund_id: r.refund_id || r.id || null,
      }),
      date: r.effective_date != null ? String(r.effective_date).slice(0, 10) : '',
    }))
    .filter((r) => r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date));

  function bookingBalance(bookingId) {
    return Math.max(0, checkedSubtract(totalByBooking.get(bookingId) || 0, paidByBooking.get(bookingId) || 0));
  }

  function summarize(range) {
    let booked = 0;
    for (const r of datedBsr) if (inRange(r.service_date, range)) booked = checkedAdd(booked, r.due);

    let collected = 0;
    for (const p of datedPayments) if (inRange(p.date, range)) collected = checkedAdd(collected, p.amount);

    // Distinct bookings with a dated qualifying BSR row inside the range.
    const qualifying = new Set();
    for (const r of datedBsr) if (inRange(r.service_date, range)) qualifying.add(r.booking_id);
    let outstanding = 0;
    for (const bookingId of qualifying) outstanding = checkedAdd(outstanding, bookingBalance(bookingId));

    return {
      booked_cents: booked,
      collected_gross_cents: collected,
      outstanding_cents: outstanding,
      bookings_count: qualifying.size,
    };
  }

  /** Σ recorded refunds with effective_date ∈ range (L2/L3). */
  function refundsInRange(range) {
    let sum = 0;
    for (const r of datedRefunds) {
      if (inRange(r.date, range)) sum = checkedAdd(sum, r.amount);
    }
    return sum;
  }

  /** Independent net for a range: gross(R) − refunds_effective(R). Negative allowed (L3/L4). */
  function netStats(range) {
    const s = summarize(range);
    const refunds = refundsInRange(range);
    return {
      ...s,
      refunds_cents: refunds,
      net_collected_cents: checkedSubtract(s.collected_gross_cents, refunds),
    };
  }

  const ranges = periodRanges(now, timeZone);
  const daily_trend = eachDate(ranges.month).map((date) => {
    const dayRange = { start: date, end: date };
    return { date, ...summarize(dayRange) };
  });

  // ── Option B redesign block (additive; legacy periods kept) ───────────────
  const primary = resolvePrimaryRange({ now, timeZone, view: args && args.view });
  const primaryRange = primary.range;
  const granularity = primary.granularity;
  const today = primary.today;
  const priorRange = priorPeriodRange(primaryRange, granularity);
  const yoyRange = shiftRangeYears(primaryRange, -1);

  const primaryStats = summarize(primaryRange);
  const priorStats = summarize(priorRange);
  const yoyStats = summarize(yoyRange);

  const primaryNet = netStats(primaryRange);
  const priorNet = netStats(priorRange);
  const yoyNet = netStats(yoyRange);

  const gross = primaryNet.collected_gross_cents;
  const completed_refunds_cents = primaryNet.refunds_cents;
  const net_collected_cents = primaryNet.net_collected_cents;
  // Retired cancellation proxy — always 0 in Slice 2 redesign Net.
  const pending_refund_cents = 0;

  const next30Range = next30RangeForPeriod(primaryRange, today);
  const lastServiceByBooking = new Map();
  for (const r of datedBsr) {
    const prev = lastServiceByBooking.get(r.booking_id);
    if (!prev || r.service_date > prev) lastServiceByBooking.set(r.booking_id, r.service_date);
  }
  const qualifyingPrimary = new Set();
  for (const r of datedBsr) if (inRange(r.service_date, primaryRange)) qualifyingPrimary.add(r.booking_id);

  // Next 30: period-relative upcoming window (see next30RangeForPeriod). Not wall-clock-only.
  let next_30_days_cents = 0;
  if (next30Range) {
    for (const r of datedBsr) {
      if (inRange(r.service_date, next30Range)) next_30_days_cents = checkedAdd(next_30_days_cents, r.due);
    }
  }

  let delivered_unpaid_cents = 0;
  let delivered_unpaid_bookings = 0;
  let due_soon_cents = 0;
  let overdue_cents = 0;
  let outstanding_bookings = 0;
  const periodDueByBooking = new Map();
  for (const r of datedBsr) {
    if (inRange(r.service_date, primaryRange)) {
      periodDueByBooking.set(r.booking_id, checkedAdd(periodDueByBooking.get(r.booking_id) || 0, r.due));
    }
  }
  let period_outstanding_cents = 0;
  for (const bookingId of qualifyingPrimary) {
    const bal = bookingBalance(bookingId);
    if (bal <= 0) continue;
    const periodDue = periodDueByBooking.get(bookingId) || 0;
    // Cap each booking at its positive period dues so multi-day remainders
    // cannot inflate Day/Month Pendiente above that period's line items.
    const periodBal = Math.min(bal, Math.max(0, periodDue));
    if (periodBal <= 0) continue;
    outstanding_bookings += 1;
    period_outstanding_cents = checkedAdd(period_outstanding_cents, periodBal);
    const last = lastServiceByBooking.get(bookingId);
    if (!last) {
      due_soon_cents = checkedAdd(due_soon_cents, periodBal);
      continue;
    }
    const daysPast = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(last + 'T00:00:00Z')) / 86400000);
    if (daysPast > 7) overdue_cents = checkedAdd(overdue_cents, periodBal);
    else due_soon_cents = checkedAdd(due_soon_cents, periodBal);
    if (last < today) {
      delivered_unpaid_cents = checkedAdd(delivered_unpaid_cents, periodBal);
      delivered_unpaid_bookings += 1;
    }
  }
  // Negative custom-line dues shrink Booked while per-booking max(0, period_due)
  // still attributes positive dues in full — enforce Pendiente ≤ Booked and keep
  // aging pills on the same capped basis (Staff API cents only; no invented prices).
  const cappedOutstanding = capPeriodOutstandingToBooked({
    period_outstanding_cents,
    due_soon_cents,
    overdue_cents,
    delivered_unpaid_cents,
    booked_cents: primaryStats.booked_cents,
  });
  period_outstanding_cents = cappedOutstanding.period_outstanding_cents;
  due_soon_cents = cappedOutstanding.due_soon_cents;
  overdue_cents = cappedOutstanding.overdue_cents;
  delivered_unpaid_cents = cappedOutstanding.delivered_unpaid_cents;

  // Product revenue (BSR recognition by service_date in primary range) — F2 five-row shape
  const revenue_by_product = buildRevenueByProductRows(datedBsr, primaryRange, surfPacks);

  // Capacity — lesson seats
  const fallbackGs = defaultPackGroupSize(surfPacks);
  // Session key: date + course_id (or pack fallback bucket)
  const sessionMap = new Map(); // key -> { capacity, filled }
  let lessonDue = 0;
  let lessonQty = 0;
  for (const r of datedBsr) {
    if (!inRange(r.service_date, primaryRange)) continue;
    if (String(r.service_type || '').toLowerCase() !== 'surf_lesson') continue;
    const qty = Number.isFinite(r.quantity) && r.quantity > 0 ? Math.trunc(r.quantity) : 1;
    lessonQty += qty;
    lessonDue = checkedAdd(lessonDue, r.due);
    if (!isCourseLikeRow(r) && !r.metadata.course_id) {
      // still count open lessons toward filled if we have a capacity session
    }
    const md = r.metadata || {};
    const courseKey = md.course_id != null
      ? String(md.course_id)
      : String(md.course_label || md.staff_ui_service_type || r.service_type || 'lesson');
    const sk = `${r.service_date}|${courseKey}`;
    const cap = packSizeForRow(r, surfPacks, fallbackGs);
    if (!sessionMap.has(sk)) sessionMap.set(sk, { capacity: cap, filled: 0 });
    const s = sessionMap.get(sk);
    s.filled += qty;
    if (cap != null && (s.capacity == null || cap > s.capacity)) s.capacity = cap;
  }
  let seats_filled = 0;
  let seats_capacity = 0;
  let capacityKnown = false;
  for (const s of sessionMap.values()) {
    seats_filled += s.filled;
    if (s.capacity != null && s.capacity > 0) {
      seats_capacity += s.capacity;
      capacityKnown = true;
    }
  }
  const unsold_seats = capacityKnown ? Math.max(0, seats_capacity - seats_filled) : null;

  // Capacity rows mirror the first 4 revenue slots — NO "Other" (no stock denominator).
  const stockByOffering = new Map();
  for (const row of Array.isArray(rentalStock) ? rentalStock : []) {
    const k = String((row && (row.offering_key || row.group_key)) || '').trim();
    if (!k) continue;
    const q = row.stock_quantity != null ? Number(row.stock_quantity) : null;
    if (q != null && Number.isFinite(q) && q >= 0) {
      const prev = stockByOffering.get(k);
      stockByOffering.set(k, prev == null ? q : prev + q);
    }
  }
  // Units booked per offering in primary range (qty sum on non-lesson BSR).
  const unitsByOffering = new Map();
  for (const r of datedBsr) {
    if (!inRange(r.service_date, primaryRange)) continue;
    const id = revenueItemKeyAndLabel(r);
    if (id.kind === 'lessons') continue;
    const qty = Number.isFinite(r.quantity) && r.quantity > 0 ? Math.trunc(r.quantity) : 1;
    unitsByOffering.set(id.key, (unitsByOffering.get(id.key) || 0) + qty);
  }
  const capacity_by_product = revenue_by_product.filter((p) => p.slot !== 'other').map((p) => {
    if (p.slot === 'lessons') {
      const filled = capacityKnown ? seats_filled : lessonQty;
      const cap = capacityKnown ? seats_capacity : null;
      return {
        key: p.key,
        label: p.label,
        slot: p.slot,
        used: filled,
        stock: cap,
        pct: cap != null && cap > 0 ? pctInt(filled, cap) : null,
        detail: cap != null ? `${filled}/${cap}` : String(filled != null ? filled : '—'),
      };
    }
    const keys = Array.isArray(p.offering_keys) && p.offering_keys.length
      ? p.offering_keys
      : (p.key && p.key !== 'rank_1' && p.key !== 'rank_2' && p.key !== 'course_included' ? [p.key] : []);
    let used = 0;
    let stockSum = 0;
    let stockKnown = false;
    for (const k of keys) {
      used += unitsByOffering.get(k) || 0;
      if (stockByOffering.has(k)) {
        stockSum += stockByOffering.get(k);
        stockKnown = true;
      }
    }
    // course_included may sum multiple pack equipment keys
    if (p.slot === 'course_included' && keys.length === 0) {
      // no keys → zero util
    }
    return {
      key: p.key,
      label: p.label,
      slot: p.slot,
      used,
      stock: stockKnown ? stockSum : null,
      pct: stockKnown && stockSum > 0 ? pctInt(used, stockSum) : null,
      detail: stockKnown ? `${used}/${stockSum}` : (used ? String(used) : '—'),
      offering_keys: keys,
    };
  });

  const avg_lesson_price_cents = lessonQty > 0 ? Math.round(lessonDue / lessonQty) : null;
  const left_on_table_cents = (unsold_seats != null && avg_lesson_price_cents != null)
    ? unsold_seats * avg_lesson_price_cents
    : null;

  const gear = gearOutFromBsr(datedBsr, primaryRange);
  const stock = stockTotals(rentalStock);

  // Daily trend for primary range + last-year ghost (gross collected + booked)
  const trendDates = eachDate(primaryRange);
  // Cap year view trend to not explode UI if somehow huge — year is ok at 365
  const daily_gross_trend = trendDates.map((date) => {
    const day = summarize({ start: date, end: date });
    const lyDate = shiftRangeYears({ start: date, end: date }, -1).start;
    const ly = summarize({ start: lyDate, end: lyDate });
    return {
      date,
      booked_cents: day.booked_cents,
      collected_gross_cents: day.collected_gross_cents,
      ly_booked_cents: ly.booked_cents,
      ly_collected_gross_cents: ly.collected_gross_cents,
    };
  });

  const chartYear = Number(String(primaryRange.start || today).slice(0, 4));
  const monthly_gross_trend = monthlyCollectedGrossTrend(datedPayments, chartYear, datedBsr);

  const avg_booking_cents = primaryStats.bookings_count > 0
    ? Math.round(primaryStats.booked_cents / primaryStats.bookings_count)
    : null;

  const redesign = {
    view: {
      granularity,
      range: primaryRange,
      prior_range: priorRange,
      yoy_range: yoyRange,
      today,
    },
    net: {
      net_collected_cents,
      gross_collected_cents: gross,
      completed_refunds_cents,
      refunds_cents: completed_refunds_cents,
      pending_refund_cents,
      pending_refund_label: null,
      // Slice 2: true net from recorded ledger (may equal gross when refunds=0).
      net_equals_gross: completed_refunds_cents === 0,
      refund_basis: 'effective_date',
      refund_source: 'booking_refund_records',
      // L4: compare nets independently (not prior/yoy gross).
      vs_prior_pct: deltaPct(net_collected_cents, priorNet.net_collected_cents),
      vs_yoy_pct: deltaPct(net_collected_cents, yoyNet.net_collected_cents),
    },
    pipeline: {
      booked_cents: primaryStats.booked_cents,
      bookings_count: primaryStats.bookings_count,
      avg_booking_cents,
      next_30_days_cents,
      delivered_unpaid_cents,
      delivered_unpaid_bookings,
      vs_prior_pct: deltaPct(primaryStats.booked_cents, priorStats.booked_cents),
      vs_yoy_pct: deltaPct(primaryStats.booked_cents, yoyStats.booked_cents),
    },
    outstanding: {
      outstanding_cents: period_outstanding_cents,
      bookings_count: outstanding_bookings,
      due_soon_cents,
      overdue_cents,
      aging_proxy: 'service_date',
      vs_prior_pct: deltaPct(primaryStats.outstanding_cents, priorStats.outstanding_cents),
      vs_yoy_pct: deltaPct(primaryStats.outstanding_cents, yoyStats.outstanding_cents),
    },
    revenue_by_product,
    capacity: {
      seats_filled: capacityKnown ? seats_filled : lessonQty,
      seats_capacity: capacityKnown ? seats_capacity : null,
      seats_pct: capacityKnown ? pctInt(seats_filled, seats_capacity) : null,
      unsold_seats,
      avg_lesson_price_cents,
      left_on_table_cents,
      boards_out: gear.boards_out,
      boards_stock: stock.boards_stock,
      boards_pct: stock.boards_stock != null ? pctInt(gear.boards_out, stock.boards_stock) : null,
      wetsuits_out: gear.wetsuits_out,
      wetsuits_stock: stock.wetsuits_stock,
      wetsuits_pct: stock.wetsuits_stock != null ? pctInt(gear.wetsuits_out, stock.wetsuits_stock) : null,
      by_product: capacity_by_product,
    },
    daily_gross_trend,
    monthly_gross_trend,
    limitations: {
      pending_refund_estimated_from_cancellations: false,
      net_uses_recorded_refunds: !refundLedgerUnavailable,
      refund_basis: 'effective_date',
      refund_ledger_unavailable: refundLedgerUnavailable,
      note: refundLedgerUnavailable
        ? 'Refund ledger unavailable. Net currently equals gross for this response.'
        : 'Net = gross collected − manual recorded refunds in this period (effective date). Not a Stripe payout report.',
    },
  };

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
    redesign,
    // Soft-fail diagnostics. Malformed rows: IDs/source only.
    // Material balance drift: booking_id + reconciliation cents (no guest PII).
    // Merge any fetch-time data_quality so one path surfaces both classes.
    data_quality: (() => {
      const fetchDq = (args && args.data_quality && typeof args.data_quality === 'object')
        ? args.data_quality
        : null;
      const malformed = diagnostics.malformed.slice();
      if (fetchDq && Array.isArray(fetchDq.malformed)) {
        for (const m of fetchDq.malformed) malformed.push(m);
      }
      const balanceDrift = Array.isArray(diagnostics.balance_drift)
        ? diagnostics.balance_drift.slice()
        : [];
      if (fetchDq && Array.isArray(fetchDq.balance_drift)) {
        for (const d of fetchDq.balance_drift) balanceDrift.push(d);
      }
      return {
        malformed_count: malformed.length,
        malformed,
        balance_drift_count: balanceDrift.length,
        balance_drift: balanceDrift,
      };
    })(),
    // Legacy top-level limitations — BYTE-COMPATIBLE with Slice 1 / redesign-s1 Seadog#4 (L1).
    // Do NOT flip net_collected_available in Slice 2.
    limitations: {
      net_collected_available: false,
      note: 'Collected is gross: refunds/reversals are not available until an authoritative refund ledger exists.',
    },
  };
  } finally {
    _financeDiagSink = prevSink;
  }
}

/**
 * Data-quality reconciliation: the paid-payment ledger is the cash authority, so
 * Outstanding is computed from the persisted total, or the full effective BSR-line
 * total only when that aggregate is absent, then subtracts the authoritative paid
 * ledger and clamps at zero. Persisted
 * bookings.balance_due_cents is operational state that SHOULD equal that. This
 * surfaces any material disagreement. Callers soft-flag and continue — one
 * stale balance_due must not black out Finance. FinanceDataQualityError is
 * reserved for unrecoverable structure/overflow during money math.
 *
 * Incomplete inputs: when booking total is null (legacy BSR fallback) and any
 * commercial BSR amount for that booking is malformed, reconciliation is
 * unavailable — never invent material_balance_drift from partial BSR sums.
 *
 * @param {object} args
 * @param {Array<{booking_id,total_amount_cents,balance_due_cents}>} args.bookings
 * @param {Array<{booking_id,amount_due_cents,metadata}>} args.bsr
 * @param {Array<{booking_id,amount_paid_cents}>} args.payments  (scoped paid payments)
 * @param {number} [args.toleranceCents=0]  materiality threshold (integer cents)
 * @param {boolean} [args.report=true]  emit structured soft-fail logs for drifts
 * @param {Iterable<string>} [args.incompleteBsrBookingIds]  booking ids known to have
 *   malformed/filtered BSR rows (when caller passes pre-cleaned BSR only)
 * @returns {{ checked:number, discrepancies:Array, material:boolean, flagged_booking_ids:string[], reconciliation_unavailable:Array, diagnostics:object }}
 */
function reconcileBookingBalances(args) {
  const bookings = Array.isArray(args && args.bookings) ? args.bookings : [];
  const bsr = Array.isArray(args && args.bsr) ? args.bsr : [];
  const payments = Array.isArray(args && args.payments) ? args.payments : [];
  const tolerance = Number.isFinite(args && args.toleranceCents) ? Math.abs(Math.trunc(args.toleranceCents)) : 0;
  const shouldReport = !(args && args.report === false);
  const diagnostics = (args && args.diagnostics && typeof args.diagnostics === 'object')
    ? args.diagnostics
    : createFinanceDiagnostics();
  if (!Array.isArray(diagnostics.balance_drift)) diagnostics.balance_drift = [];
  if (!Array.isArray(diagnostics.malformed)) diagnostics.malformed = [];
  if (!Array.isArray(diagnostics.reconciliation_unavailable)) diagnostics.reconciliation_unavailable = [];
  const prevSink = _financeDiagSink;
  _financeDiagSink = diagnostics;

  try {
    const skipBookingIds = new Set();
    const incompleteBsrBookingIds = new Set();
    if (args && args.incompleteBsrBookingIds) {
      for (const id of args.incompleteBsrBookingIds) {
        if (id != null) incompleteBsrBookingIds.add(String(id));
      }
    }
    const paidByBooking = new Map();
    for (const p of payments) {
      const parsed = parseCanonicalIntCents(p.amount_paid_cents);
      if (!parsed.ok) {
        reportMalformedMonetary({
          source: 'payment.amount_paid_cents',
          booking_id: p.booking_id,
          payment_id: p.payment_id || p.id || null,
          reason: parsed.reason,
        });
        if (p.booking_id != null) skipBookingIds.add(String(p.booking_id));
        continue;
      }
      paidByBooking.set(p.booking_id, checkedAdd(paidByBooking.get(p.booking_id) || 0, parsed.value));
    }

    // Pre-mark bookings with malformed totals so we do not invent drift.
    for (const b of bookings) {
      if (b.total_amount_cents == null) continue;
      const t = parseCanonicalIntCents(b.total_amount_cents);
      if (!t.ok) {
        reportMalformedMonetary({
          source: 'booking.total_amount_cents',
          booking_id: b.booking_id,
          reason: t.reason,
        });
        if (b.booking_id != null) skipBookingIds.add(String(b.booking_id));
      }
    }

    // BSR: detect malformed commercial amounts. Soft-touch logs IDs; never invent
    // drift from incomplete legacy (null total) BSR fallbacks.
    for (const row of bsr) {
      const raw = bsrRawCommercialAmount(row);
      const parsed = parseCanonicalIntCents(raw);
      if (!parsed.ok) {
        reportMalformedMonetary({
          source: isStaffCustomLine((row && row.metadata) || {}) && (row.metadata || {}).amount_cents != null
            ? 'bsr.metadata.amount_cents'
            : 'bsr.amount_due_cents',
          booking_id: row && row.booking_id != null ? row.booking_id : null,
          service_record_id: row && (row.service_record_id || row.id) != null
            ? (row.service_record_id || row.id)
            : null,
          reason: parsed.reason,
        });
        if (row && row.booking_id != null) incompleteBsrBookingIds.add(String(row.booking_id));
        continue;
      }
      // Soft path for sink consistency when already clean.
      effectiveServiceDueCents(row);
    }

    const discrepancies = [];
    const flagged_booking_ids = [];
    const reconciliation_unavailable = [];
    const totalByBooking = authoritativeTotalByBooking(bookings, bsr);
    let checked = 0;
    for (const b of bookings) {
      if (b.balance_due_cents == null) continue; // nothing persisted to reconcile against
      if (b.booking_id != null && skipBookingIds.has(String(b.booking_id))) continue;
      const balParsed = parseCanonicalIntCents(b.balance_due_cents);
      if (!balParsed.ok) {
        // Malformed balance: log + skip (do not invent drift from soft zeros).
        reportMalformedMonetary({
          source: 'booking.balance_due_cents',
          booking_id: b.booking_id,
          reason: balParsed.reason,
        });
        continue;
      }
      // Legacy null total depends on full BSR sum. Incomplete/malformed BSR inputs
      // must not invent material_balance_drift — flag recon unavailable instead.
      if (
        b.total_amount_cents == null
        && b.booking_id != null
        && incompleteBsrBookingIds.has(String(b.booking_id))
      ) {
        const rec = {
          booking_id: String(b.booking_id),
          reason: 'incomplete_inputs_malformed_bsr',
          source: 'reconcile.legacy_bsr_fallback',
        };
        reconciliation_unavailable.push(rec);
        diagnostics.reconciliation_unavailable.push(rec);
        if (shouldReport) {
          try {
            console.warn('[finance.data_quality] reconciliation_unavailable', JSON.stringify(rec));
          } catch (_e) { /* ignore log failures */ }
        }
        continue;
      }
      checked += 1;
      const computed = Math.max(0, checkedSubtract(totalByBooking.get(b.booking_id), paidByBooking.get(b.booking_id) || 0));
      const persisted = balParsed.value;
      const delta = checkedSubtract(computed, persisted);
      if (Math.abs(delta) > tolerance) {
        const disc = {
          booking_id: b.booking_id,
          computed_cents: computed,
          persisted_cents: persisted,
          delta_cents: delta,
        };
        discrepancies.push(disc);
        if (b.booking_id != null) flagged_booking_ids.push(String(b.booking_id));
        // Soft-flag only — never throw. Outstanding uses total−paid, not balance_due.
        if (shouldReport) {
          reportMaterialBalanceDrift({
            ...disc,
            source: 'booking.balance_due_cents',
            reason: 'material_balance_drift',
          });
        }
      }
    }

    return {
      checked,
      discrepancies,
      material: discrepancies.length > 0,
      flagged_booking_ids,
      reconciliation_unavailable,
      diagnostics,
    };
  } finally {
    _financeDiagSink = prevSink;
  }
}

module.exports = {
  computeSunsetFinanceSummary,
  effectiveServiceDueCents,
  zonedDateString,
  periodRanges,
  resolvePrimaryRange,
  next30RangeForPeriod,
  yearRange,
  isFullCalendarYearRange,
  periodDayCount,
  productBucket,
  buildRevenueByProductRows,
  buildRevenueByProductFiveRows: buildRevenueByProductRows, // alias
  courseIncludableOfferingKeys,
  shiftRangeYears,
  monthlyCollectedGrossTrend,
  sumBookedDuesForRange,
  stockTotals,
  isStaffCustomLine,
  capPeriodOutstandingToBooked,
  reconcileBookingBalances,
  FinanceDataQualityError,
  parseCanonicalIntCents,
  sanitizeFinanceOffendingRecord,
  createFinanceDiagnostics,
  reportMalformedMonetary,
  reportMaterialBalanceDrift,
  withFinanceDiagnostics,
  toIntSoft,
  toInt,
};
