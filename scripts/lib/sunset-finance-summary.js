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

function sumCollectedGrossForRange(datedPayments, range) {
  let collected = 0;
  for (const p of datedPayments) {
    if (inRange(p.date, range)) collected = checkedAdd(collected, p.amount);
  }
  return collected;
}

function monthlyCollectedGrossTrend(datedPayments, year) {
  const y = Number(year);
  if (!Number.isFinite(y)) return [];
  const rows = [];
  for (let month = 1; month <= 12; month += 1) {
    const range = monthRangeForYearMonth(y, month);
    const lyRange = shiftRangeYears(range, -1);
    rows.push({
      year: y,
      month,
      start: range.start,
      end: range.end,
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

  // Refunds bucketed by effective_date (DATE / YYYY-MM-DD) — same inclusive inRange as other series.
  const datedRefunds = refundRecords
    .map((r) => ({
      booking_id: r.booking_id,
      amount: toInt(r.amount_cents),
      date: r.effective_date != null ? String(r.effective_date).slice(0, 10) : '',
    }))
    .filter((r) => r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date));

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
      detail: stockKnown ? `${used}/${stockSum}` : (used ? `out ${used}` : '—'),
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
  const monthly_gross_trend = monthlyCollectedGrossTrend(datedPayments, chartYear);

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
    // Legacy top-level limitations — BYTE-COMPATIBLE with Slice 1 / redesign-s1 Seadog#4 (L1).
    // Do NOT flip net_collected_available in Slice 2.
    limitations: {
      net_collected_available: false,
      note: 'Collected is gross: refunds/reversals are not available until an authoritative refund ledger exists.',
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
  buildRevenueByProductRows,
  buildRevenueByProductFiveRows: buildRevenueByProductRows, // alias
  courseIncludableOfferingKeys,
  shiftRangeYears,
  stockTotals,
  isStaffCustomLine,
  reconcileBookingBalances,
  FinanceDataQualityError,
};
