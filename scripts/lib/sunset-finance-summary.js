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

function toInt(value) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value)) n = Number(value);
  else throw new FinanceDataQualityError();
  if (!Number.isSafeInteger(n)) throw new FinanceDataQualityError();
  return n;
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
 * Effective per-row due. Discounts cannot be stored as negative amount_due_cents
 * (DB CHECK >= 0), so staff custom commercial lines carry the signed authoritative
 * value in metadata.amount_cents — matching readPersistedServiceDueCents().
 */
function effectiveServiceDueCents(row) {
  const md = (row && row.metadata) || {};
  if (isStaffCustomLine(md) && md.amount_cents != null) {
    return toInt(md.amount_cents);
  }
  return toInt(row && row.amount_due_cents);
}

function authoritativeTotalByBooking(bookings, bsr) {
  const fallback = new Map();
  for (const row of bsr) {
    fallback.set(row.booking_id, checkedAdd(fallback.get(row.booking_id) || 0, effectiveServiceDueCents(row)));
  }
  return new Map(bookings.map((booking) => [
    booking.booking_id,
    booking.total_amount_cents == null
      ? (fallback.get(booking.booking_id) || 0)
      : toInt(booking.total_amount_cents),
  ]));
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

function yearRange(dateStr) {
  const y = Number(String(dateStr).slice(0, 4));
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

function shiftRangeYears(range, years) {
  const shift = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return `${y + years}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
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

function productBucket(serviceType) {
  const t = String(serviceType || '').toLowerCase();
  if (t === 'surf_lesson') return 'lessons';
  if (t === 'surfboard') return 'boards';
  if (t === 'wetsuit') return 'wetsuits';
  return 'retail'; // yoga, meal, addon_service, unknown
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
    const isBoard = /board|surfboard|sup/.test(key) && !/wetsuit|suit/.test(key);
    const isSuit = /wetsuit|wet suit|suit/.test(key) && !/board_and_suit|board\+suit|bundle/.test(key);
    const isBundle = /board_and_suit|bundle|board\+wetsuit|board and/.test(key);
    if (isBoard || isBundle) {
      boards = boardsSet ? boards + n : n;
      boardsSet = true;
    }
    if (isSuit || isBundle) {
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

  if (granularity === 'custom' && view.start && view.end && view.start <= view.end) {
    return { granularity, range: { start: view.start, end: view.end }, today };
  }

  const anchor = (view.anchor && /^\d{4}-\d{2}-\d{2}$/.test(view.anchor)) ? view.anchor : today;
  if (granularity === 'day') {
    return { granularity: 'day', range: { start: anchor, end: anchor }, today };
  }
  if (granularity === 'year') {
    return { granularity: 'year', range: yearRange(anchor), today };
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
 * @param {Array<{booking_id,amount_paid_cents,paid_at}>} [args.pending_refund_payments]
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
  const pendingRefundPayments = Array.isArray(args && args.pending_refund_payments)
    ? args.pending_refund_payments
    : [];
  const rentalStock = Array.isArray(args && args.rental_stock) ? args.rental_stock : [];
  const surfPacks = Array.isArray(args && args.surf_packs) ? args.surf_packs : [];

  const totalByBooking = authoritativeTotalByBooking(bookings, bsr);

  // Cumulative paid per booking (balance is total − ALL scoped paid, not period-scoped).
  const paidByBooking = new Map();
  for (const p of payments) {
    paidByBooking.set(p.booking_id, checkedAdd(paidByBooking.get(p.booking_id) || 0, p.amount_paid_cents));
  }
  function bookingBalance(bookingId) {
    return Math.max(0, checkedSubtract(totalByBooking.get(bookingId) || 0, paidByBooking.get(bookingId) || 0));
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
  const datedPayments = payments
    .filter((p) => p.paid_at != null)
    .map((p) => ({ booking_id: p.booking_id, amount: toInt(p.amount_paid_cents), date: zonedDateString(p.paid_at, timeZone) }));

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

  // Pending refund = SUM paid on cancelled bookings (liability proxy; net stays = gross).
  let pending_refund_cents = 0;
  for (const p of pendingRefundPayments) {
    pending_refund_cents = checkedAdd(pending_refund_cents, p.amount_paid_cents);
  }

  const gross = primaryStats.collected_gross_cents;
  const net_collected_cents = gross; // Slice 1: net = gross until completed refunds exist
  const completed_refunds_cents = 0;

  // Pipeline
  const next30Range = { start: today, end: addDays(today, 29) };
  let next_30_days_cents = 0;
  for (const r of datedBsr) {
    if (inRange(r.service_date, next30Range)) next_30_days_cents = checkedAdd(next_30_days_cents, r.due);
  }

  // Latest service_date per booking (for aging + delivered-unpaid)
  const lastServiceByBooking = new Map();
  for (const r of datedBsr) {
    const prev = lastServiceByBooking.get(r.booking_id);
    if (!prev || r.service_date > prev) lastServiceByBooking.set(r.booking_id, r.service_date);
  }

  let delivered_unpaid_cents = 0;
  let delivered_unpaid_bookings = 0;
  let due_soon_cents = 0;
  let overdue_cents = 0;
  let outstanding_bookings = 0;
  // Outstanding aging over bookings that appear in the primary range (same set as outstanding).
  const qualifyingPrimary = new Set();
  for (const r of datedBsr) if (inRange(r.service_date, primaryRange)) qualifyingPrimary.add(r.booking_id);
  for (const bookingId of qualifyingPrimary) {
    const bal = bookingBalance(bookingId);
    if (bal <= 0) continue;
    outstanding_bookings += 1;
    const last = lastServiceByBooking.get(bookingId);
    if (!last) {
      due_soon_cents = checkedAdd(due_soon_cents, bal);
      continue;
    }
    // days_past = today - last (positive when last is in the past)
    const daysPast = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(last + 'T00:00:00Z')) / 86400000);
    if (daysPast > 7) overdue_cents = checkedAdd(overdue_cents, bal);
    else due_soon_cents = checkedAdd(due_soon_cents, bal);
  }
  // Delivered unpaid: any booking with balance and last service before today (global ops view).
  for (const [bookingId, last] of lastServiceByBooking.entries()) {
    const bal = bookingBalance(bookingId);
    if (bal <= 0) continue;
    if (last < today) {
      delivered_unpaid_cents = checkedAdd(delivered_unpaid_cents, bal);
      delivered_unpaid_bookings += 1;
    }
  }

  // Product revenue (BSR recognition by service_date in primary range)
  const product = {
    lessons: { cents: 0, label: 'Surf lessons' },
    boards: { cents: 0, label: 'Board rental' },
    wetsuits: { cents: 0, label: 'Wetsuit rental' },
    retail: { cents: 0, label: 'Retail / other' },
  };
  for (const r of datedBsr) {
    if (!inRange(r.service_date, primaryRange)) continue;
    const bucket = productBucket(r.service_type);
    product[bucket].cents = checkedAdd(product[bucket].cents, r.due);
  }
  const productTotal = Object.values(product).reduce((a, p) => checkedAdd(a, p.cents), 0);
  const revenue_by_product = Object.keys(product).map((key) => {
    const p = product[key];
    const pct = productTotal > 0 ? Math.round((1000 * p.cents) / productTotal) / 10 : 0;
    return { key, label: p.label, cents: p.cents, pct };
  });

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
      pending_refund_cents,
      pending_refund_label: 'estimated_from_cancellations',
      // Net = gross in Slice 1
      net_equals_gross: true,
      vs_prior_pct: deltaPct(net_collected_cents, priorStats.collected_gross_cents),
      vs_yoy_pct: deltaPct(net_collected_cents, yoyStats.collected_gross_cents),
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
      outstanding_cents: primaryStats.outstanding_cents,
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
    },
    daily_gross_trend,
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
    limitations: {
      net_collected_available: false,
      pending_refund_estimated_from_cancellations: true,
      note: 'Net equals gross in Slice 1. Pending refund = paid cents on cancelled bookings (estimated). Completed refunds/chargebacks still need a ledger.',
    },
  };
}

/**
 * Data-quality reconciliation: the paid-payment ledger is the cash authority, so
 * Outstanding is computed from the persisted total, or the full effective BSR-line
 * total only when that aggregate is absent, then subtracts the authoritative paid
 * ledger and clamps at zero. Persisted
 * bookings.balance_due_cents is operational state that SHOULD equal that. This
 * surfaces any material disagreement so the staging reconciliation (and a
 * fail-closed test) can catch drift before it reaches money figures.
 *
 * @param {object} args
 * @param {Array<{booking_id,total_amount_cents,balance_due_cents}>} args.bookings
 * @param {Array<{booking_id,amount_due_cents,metadata}>} args.bsr
 * @param {Array<{booking_id,amount_paid_cents}>} args.payments  (scoped paid payments)
 * @param {number} [args.toleranceCents=0]  materiality threshold (integer cents)
 * @returns {{ checked:number, discrepancies:Array, material:boolean }}
 */
function reconcileBookingBalances(args) {
  const bookings = Array.isArray(args && args.bookings) ? args.bookings : [];
  const bsr = Array.isArray(args && args.bsr) ? args.bsr : [];
  const payments = Array.isArray(args && args.payments) ? args.payments : [];
  const tolerance = Number.isFinite(args && args.toleranceCents) ? Math.abs(Math.trunc(args.toleranceCents)) : 0;

  const paidByBooking = new Map();
  for (const p of payments) {
    paidByBooking.set(p.booking_id, checkedAdd(paidByBooking.get(p.booking_id) || 0, p.amount_paid_cents));
  }

  const discrepancies = [];
  const totalByBooking = authoritativeTotalByBooking(bookings, bsr);
  for (const b of bookings) {
    if (b.balance_due_cents == null) continue; // nothing persisted to reconcile against
    const computed = Math.max(0, checkedSubtract(totalByBooking.get(b.booking_id), paidByBooking.get(b.booking_id) || 0));
    const persisted = toInt(b.balance_due_cents);
    const delta = checkedSubtract(computed, persisted);
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
  resolvePrimaryRange,
  productBucket,
  isStaffCustomLine,
  reconcileBookingBalances,
  FinanceDataQualityError,
};
