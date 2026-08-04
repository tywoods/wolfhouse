'use strict';

/**
 * Sunset Admin Bookings tab (N1) — pure domain contracts.
 *
 * Status taxonomy, money arithmetic, filter predicates, CSV sanitization.
 * No DB, no HTTP, no Stripe. Integer cents only.
 *
 * Status chips (Bookings panel):
 *   paid | unpaid | partial | refunded | cancelled | hidden | refund_needed
 * "Deleted" is removed — never a status/tag/filter.
 * hidden = flag only cancelled bookings carry (declutter). Not a money status.
 * Default list includes cancelled (not greyed on panel); excludes hidden.
 * Soft retention:
 *   - cancel → status=cancelled
 *   - hide → bookings.hidden (+ legacy schedule_archived meta)
 *
 * Money:
 *   collected  = gross settled/collected payments (status paid)
 *   refunded   = Σ manual booking_refund_records.amount_cents
 *   net        = collected − refunded
 *   outstanding = max(charged − collected, 0)  // never below zero
 *
 * Export: parseListQuery caps interactive page size; export uses a dedicated
 * path with EXPORT_HARD_CAP (truthful truncated flag if exceeded).
 *
 * @module sunset-bookings-admin
 */

/** Interactive list page size hard cap (pagination). */
const LIST_MAX_LIMIT = 200;
/** Export safety cap — complete historical export for normal ops; above this we truncate truthfully. */
const EXPORT_HARD_CAP = 100000;

const STATUS = Object.freeze({
  PAID: 'paid',
  UNPAID: 'unpaid',
  PARTIAL: 'partial',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled',
  HIDDEN: 'hidden',
  REFUND_NEEDED: 'refund_needed',
});

/** @deprecated — "Deleted" removed; hidden is a flag, not a money status. */
const ARCHIVED_STATUSES = Object.freeze([STATUS.HIDDEN]);

const STATUS_PRECEDENCE = Object.freeze([
  STATUS.CANCELLED,
  STATUS.REFUNDED,
  STATUS.PAID,
  STATUS.PARTIAL,
  STATUS.UNPAID,
]);

class BookingsAdminError extends Error {
  constructor(code, message, status = 400) {
    super(message || code);
    this.name = 'BookingsAdminError';
    this.code = code;
    this.status = status;
  }
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, status: this.status };
  }
}

function toInt(value, label) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) n = Number(value);
  else if (typeof value === 'string' && /^-(?:[1-9][0-9]*)$/.test(value)) n = Number(value);
  else throw new BookingsAdminError('invalid_money', `invalid integer cents${label ? `: ${label}` : ''}`);
  if (!Number.isSafeInteger(n)) {
    throw new BookingsAdminError('invalid_money', `unsafe integer cents${label ? `: ${label}` : ''}`);
  }
  return n;
}

function checkedAdd(a, b) {
  const left = toInt(a);
  const right = toInt(b);
  if ((right > 0 && left > Number.MAX_SAFE_INTEGER - right)
    || (right < 0 && left < Number.MIN_SAFE_INTEGER - right)) {
    throw new BookingsAdminError('invalid_money', 'integer overflow');
  }
  return left + right;
}

function checkedSubtract(a, b) {
  return checkedAdd(a, -toInt(b));
}

function clampNonNegative(n) {
  const v = toInt(n);
  return v < 0 ? 0 : v;
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_e) {
      return {};
    }
  }
  return {};
}

function isTruthyMetaFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function isCancelledBookingStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return s === 'cancelled' || s === 'canceled';
}

/**
 * Hidden declutter flag (column or legacy schedule_archived*).
 * Only meaningful on cancelled bookings (enforced on write).
 */
function isHiddenBooking(booking) {
  if (!booking) return false;
  if (booking.hidden === true || booking.hidden === 'true' || booking.hidden === 1 || booking.hidden === '1') {
    return true;
  }
  const meta = parseMeta(booking.metadata);
  // Legacy schedule_archived maps to hidden.
  return isTruthyMetaFlag(meta.schedule_archived)
    || isTruthyMetaFlag(meta.schedule_archived_by_staff);
}


/** Default list exclusion = hidden only (cancelled stay visible). */
function isArchivedBooking(booking) {
  if (!booking) return false;
  return isHiddenBooking(booking);
}

/** Cancelled + collected > refunded → refund still needed. */
function bookingNeedsRefund(input) {
  const src = input || {};
  const booking = src.booking || src;
  if (!isCancelledBookingStatus(booking.status)) return false;
  const collected = clampNonNegative(src.collected_cents != null ? src.collected_cents : (booking.collected_cents != null ? booking.collected_cents : 0));
  const refunded = clampNonNegative(src.refunded_cents != null ? src.refunded_cents : (booking.refunded_cents != null ? booking.refunded_cents : 0));
  return collected > 0 && refunded < collected;
}

/**
 * Primary status for filters/CSV. No Deleted status exists.
 * Cancelled (incl. hidden) → cancelled; else money chips.
 */
function classifyBookingStatus(input) {
  const src = input || {};
  const booking = src.booking || src;
  const collected = clampNonNegative(src.collected_cents != null ? src.collected_cents : 0);
  const refunded = clampNonNegative(src.refunded_cents != null ? src.refunded_cents : 0);
  const charged = clampNonNegative(src.charged_cents != null ? src.charged_cents : 0);
  const outstanding = clampNonNegative(
    src.outstanding_cents != null
      ? src.outstanding_cents
      : checkedSubtract(charged, collected),
  );

  if (isCancelledBookingStatus(booking.status)) return STATUS.CANCELLED;

  const netCollected = checkedSubtract(collected, refunded);
  if (refunded > 0 && netCollected <= 0) return STATUS.REFUNDED;
  if (outstanding === 0 && (charged > 0 || collected > 0)) return STATUS.PAID;
  if (collected > 0 && outstanding > 0) return STATUS.PARTIAL;
  return STATUS.UNPAID;
}

/**
 * Multi-tags for Status column (Bookings panel).
 * Cancelled rows: Cancelled [+ Hidden] [+ Refund needed | Refunded].
 * Active rows: single money tag.
 */
function buildBookingStatusTags(input) {
  const src = input || {};
  const booking = src.booking || src;
  const money = {
    collected_cents: clampNonNegative(src.collected_cents != null ? src.collected_cents : 0),
    refunded_cents: clampNonNegative(src.refunded_cents != null ? src.refunded_cents : 0),
    charged_cents: clampNonNegative(src.charged_cents != null ? src.charged_cents : 0),
  };
  const tags = [];
  if (isCancelledBookingStatus(booking.status)) {
    tags.push(STATUS.CANCELLED);
    if (isHiddenBooking(booking)) tags.push(STATUS.HIDDEN);
    if (bookingNeedsRefund({ booking, ...money })) {
      tags.push(STATUS.REFUND_NEEDED);
    } else if (money.refunded_cents > 0 && money.collected_cents > 0
      && checkedSubtract(money.collected_cents, money.refunded_cents) <= 0) {
      tags.push(STATUS.REFUNDED);
    }
    return tags;
  }
  tags.push(classifyBookingStatus({ booking, ...money, outstanding_cents: src.outstanding_cents }));
  return tags;
}

function computeMoneyStory(input) {
  const src = input || {};
  const charged = clampNonNegative(src.charged_cents != null ? src.charged_cents : 0);
  const collected = clampNonNegative(src.collected_cents != null ? src.collected_cents : 0);
  const refunded = clampNonNegative(src.refunded_cents != null ? src.refunded_cents : 0);
  const net = checkedSubtract(collected, refunded);
  const outstanding = clampNonNegative(
    src.outstanding_cents != null
      ? src.outstanding_cents
      : checkedSubtract(charged, collected),
  );
  return {
    charged_cents: charged,
    collected_cents: collected,
    refunded_cents: refunded,
    net_cents: net,
    outstanding_cents: outstanding,
  };
}

/**
 * Summary over the full filtered set (not a page slice).
 */
function computeBookingsSummary(rows) {
  let bookingsCount = 0;
  let collected = 0;
  let refunded = 0;
  let outstanding = 0;
  for (const row of rows || []) {
    bookingsCount += 1;
    collected = checkedAdd(collected, row.collected_cents != null ? row.collected_cents : 0);
    refunded = checkedAdd(refunded, row.refunded_cents != null ? row.refunded_cents : 0);
    outstanding = checkedAdd(outstanding, row.outstanding_cents != null ? row.outstanding_cents : 0);
  }
  return {
    bookings_count: bookingsCount,
    collected_cents: collected,
    refunded_cents: refunded,
    net_cents: checkedSubtract(collected, refunded),
    outstanding_cents: clampNonNegative(outstanding),
  };
}

function normalizeSearch(q) {
  return String(q || '').trim().toLowerCase();
}

function digitsOnly(value) {
  return String(value || '').replace(/\D+/g, '');
}

function bookingMatchesSearch(row, q) {
  const needle = normalizeSearch(q);
  if (!needle) return true;
  const code = String(row.booking_code || '').toLowerCase();
  const guest = String(row.guest_name || '').toLowerCase();
  const phone = String(row.phone || '').toLowerCase();
  const phoneDigits = digitsOnly(row.phone);
  const needleDigits = digitsOnly(needle);
  if (code.includes(needle)) return true;
  if (guest.includes(needle)) return true;
  if (phone.includes(needle)) return true;
  if (needleDigits && phoneDigits.includes(needleDigits)) return true;
  return false;
}

function parseIsoDate(value) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/**
 * Date range matches when any service date falls in [from, to], or when no
 * service dates exist falls back to created_at (YYYY-MM-DD) / check_in.
 */
function bookingMatchesDateRange(row, dateFrom, dateTo) {
  const from = dateFrom ? parseIsoDate(dateFrom) : null;
  const to = dateTo ? parseIsoDate(dateTo) : null;
  if (!from && !to) return true;
  const dates = Array.isArray(row.service_dates) && row.service_dates.length
    ? row.service_dates.map(String)
    : [];
  if (!dates.length) {
    const fallback = parseIsoDate(row.service_date_start)
      || parseIsoDate(String(row.created_at || '').slice(0, 10))
      || parseIsoDate(row.check_in);
    if (!fallback) return false;
    dates.push(fallback);
  }
  return dates.some((d) => {
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}

function bookingMatchesStatus(row, statusFilter) {
  const want = String(statusFilter || '').trim().toLowerCase();
  if (!want || want === 'all') return true;
  // "Deleted" product path removed — unknown/deleted status matches nothing.
  if (want === 'deleted') return false;
  if (want === 'hidden') {
    return row.hidden === true || (Array.isArray(row.status_tags) && row.status_tags.includes(STATUS.HIDDEN));
  }
  if (want === 'cancelled' || want === 'canceled') {
    const cancelled = String(row.status || '').toLowerCase() === STATUS.CANCELLED
      || (Array.isArray(row.status_tags) && row.status_tags.includes(STATUS.CANCELLED));
    const hidden = row.hidden === true || (Array.isArray(row.status_tags) && row.status_tags.includes(STATUS.HIDDEN));
    return cancelled && !hidden;
  }
  if (want === 'refund_needed' || want === 'refund-needed') {
    return row.needs_refund === true
      || (Array.isArray(row.status_tags) && row.status_tags.includes(STATUS.REFUND_NEEDED));
  }
  if (want === 'refunded') {
    return String(row.status || '').toLowerCase() === STATUS.REFUNDED
      || (Array.isArray(row.status_tags) && row.status_tags.includes(STATUS.REFUNDED));
  }
  return String(row.status || '').toLowerCase() === want;
}

function bookingMatchesType(row, typeFilter) {
  const want = String(typeFilter || '').trim().toLowerCase();
  if (!want || want === 'all') return true;
  const types = Array.isArray(row.service_types)
    ? row.service_types.map((t) => String(t || '').toLowerCase())
    : [];
  if (types.includes(want)) return true;
  const what = String(row.what_summary || '').toLowerCase();
  return what.includes(want.replace(/_/g, ' '));
}

function bookingMatchesLocation(row, locationId) {
  const want = String(locationId || '').trim().toLowerCase();
  if (!want) return true;
  return String(row.location_id || '').trim().toLowerCase() === want;
}

/**
 * Apply list filters in pure space (used by tests + in-memory post-filter if needed).
 * Default excludes archived unless include_archived is true.
 */
function filterBookingRows(rows, filters) {
  const f = filters || {};
  const statusWant = String(f.status || '').trim().toLowerCase();
  const includeHidden = f.include_archived === true
    || f.include_archived === 1
    || f.include_archived === '1'
    || f.include_archived === 'true'
    || f.include_hidden === true
    || f.include_hidden === 1
    || f.include_hidden === '1'
    || f.include_hidden === 'true'
    || f.show_hidden === true
    || f.show_hidden === 1
    || f.show_hidden === '1'
    || f.show_hidden === 'true'
    || statusWant === 'hidden';
  return (rows || []).filter((row) => {
    const hidden = row.hidden === true
      || (Array.isArray(row.status_tags) && row.status_tags.includes(STATUS.HIDDEN));
    // Default All statuses: include cancelled, exclude hidden.
    // Hidden filter (or show_hidden): only hidden rows via status match.
    // status=deleted is ignored (no rows) — product path removed.
    if (statusWant === 'deleted') return false;
    if (statusWant === 'hidden') {
      if (!hidden) return false;
    } else if (!includeHidden && hidden) {
      return false;
    }
    if (!bookingMatchesSearch(row, f.q || f.search)) return false;
    if (!bookingMatchesDateRange(row, f.date_from || f.from, f.date_to || f.to)) return false;
    if (!bookingMatchesStatus(row, f.status)) return false;
    if (!bookingMatchesType(row, f.type || f.service_type)) return false;
    if (!bookingMatchesLocation(row, f.location || f.location_id)) return false;
    return true;
  });
}

function buildWhatSummary(services) {
  const labels = [];
  const seen = new Set();
  for (const svc of services || []) {
    if (!svc) continue;
    if (String(svc.status || '').toLowerCase() === 'cancelled') continue;
    const meta = parseMeta(svc.metadata);
    let label = meta.course_label
      || meta.label
      || meta.staff_ui_service_type
      || svc.service_type
      || '';
    label = String(label).replace(/_/g, ' ').trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels.join(' · ');
}

function serviceDateSpan(services) {
  const dates = [];
  for (const svc of services || []) {
    if (!svc) continue;
    if (String(svc.status || '').toLowerCase() === 'cancelled') continue;
    const d = svc.service_date != null ? String(svc.service_date).slice(0, 10) : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.push(d);
  }
  dates.sort();
  if (!dates.length) return { service_dates: [], service_date_start: null, service_date_end: null };
  return {
    service_dates: dates,
    service_date_start: dates[0],
    service_date_end: dates[dates.length - 1],
  };
}

function effectiveServiceDueCents(row) {
  const meta = parseMeta(row && row.metadata);
  const isCustom = meta.source === 'staff_custom_line'
    || meta.staff_custom_line === true
    || meta.component === 'staff_custom_line';
  if (isCustom && meta.amount_cents != null) return toInt(meta.amount_cents);
  return clampNonNegative(row && row.amount_due_cents != null ? row.amount_due_cents : 0);
}

function computeChargedCents(booking, services) {
  if (booking && booking.total_amount_cents != null && booking.total_amount_cents !== '') {
    return clampNonNegative(booking.total_amount_cents);
  }
  let sum = 0;
  for (const svc of services || []) {
    if (!svc) continue;
    if (String(svc.status || '').toLowerCase() === 'cancelled') continue;
    sum = checkedAdd(sum, effectiveServiceDueCents(svc));
  }
  return sum;
}

/**
 * Escape CSV cell; neutralize formula injection.
 * Strips leading whitespace/control chars before testing for = + - @
 * (Excel/Sheets treat "\t=cmd" as formula). Always prefixes formula-like cells.
 */
function csvEscapeCell(value) {
  let s = value == null ? '' : String(value);
  // Remove leading BOM / whitespace / C0 controls before formula detection.
  const stripped = s.replace(/^[\uFEFF\s\x00-\x1F\x7F]+/, '');
  if (/^[=+\-@]/.test(stripped) || /^[=+\-@]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatCentsEur(cents) {
  const n = toInt(cents || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

const CSV_COLUMNS = Object.freeze([
  'booking_code',
  'created_at',
  'guest_name',
  'phone',
  'service_date_start',
  'service_date_end',
  'what_summary',
  'total_cents',
  'paid_cents',
  'refunded_cents',
  'net_cents',
  'outstanding_cents',
  'status',
  'location_id',
  'archived',
]);

function rowsToCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows || []) {
    const money = computeMoneyStory(row);
    const cells = [
      row.booking_code,
      row.created_at,
      row.guest_name,
      row.phone,
      row.service_date_start,
      row.service_date_end,
      row.what_summary,
      money.charged_cents,
      money.collected_cents,
      money.refunded_cents,
      money.net_cents,
      money.outstanding_cents,
      row.status,
      row.location_id,
      row.archived ? 'true' : 'false',
    ].map(csvEscapeCell);
    lines.push(cells.join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Build a list/detail row from authoritative booking + related aggregates.
 */
function buildBookingListRow(input) {
  const src = input || {};
  const booking = src.booking || {};
  const services = src.services || [];
  const money = computeMoneyStory({
    charged_cents: src.charged_cents != null ? src.charged_cents : computeChargedCents(booking, services),
    collected_cents: src.collected_cents != null ? src.collected_cents : 0,
    refunded_cents: src.refunded_cents != null ? src.refunded_cents : 0,
    outstanding_cents: src.outstanding_cents,
  });
  const span = serviceDateSpan(services);
  const meta = parseMeta(booking.metadata);
  const locationId = String(
    src.location_id
    || meta.location_id
    || '',
  ).trim();
  const status = classifyBookingStatus({
    booking,
    ...money,
  });
  const hidden = isHiddenBooking(booking);
  const status_tags = buildBookingStatusTags({
    booking,
    collected_cents: money.collected_cents,
    refunded_cents: money.refunded_cents,
    charged_cents: money.charged_cents,
  });
  const needs_refund = bookingNeedsRefund({
    booking,
    collected_cents: money.collected_cents,
    refunded_cents: money.refunded_cents,
  });
  // Bookings panel never greys cancelled; archived retained only as hidden alias.
  const archived = hidden;
  const serviceTypes = [];
  for (const svc of services) {
    if (!svc || String(svc.status || '').toLowerCase() === 'cancelled') continue;
    const t = String(svc.service_type || '').toLowerCase();
    if (t && !serviceTypes.includes(t)) serviceTypes.push(t);
  }

  const items = (services || []).map((svc) => {
    const sm = parseMeta(svc.metadata);
    return {
      service_record_id: svc.service_record_id || svc.id || null,
      service_type: svc.service_type || null,
      service_date: svc.service_date || null,
      quantity: svc.quantity != null ? Number(svc.quantity) : 1,
      amount_due_cents: effectiveServiceDueCents(svc),
      status: svc.status || null,
      label: sm.course_label || sm.label || sm.staff_ui_service_type || svc.service_type || null,
    };
  });

  const createdBy = src.created_by
    || meta.created_by_staff
    || meta.created_by
    || booking.operator_name
    || booking.booking_source
    || null;

  return {
    booking_id: booking.booking_id || booking.id || src.booking_id || null,
    booking_code: booking.booking_code || src.booking_code || null,
    created_at: booking.created_at || src.created_at || null,
    guest_name: booking.guest_name || src.guest_name || null,
    phone: booking.phone || src.phone || null,
    check_in: booking.check_in || null,
    check_out: booking.check_out || null,
    ...span,
    what_summary: src.what_summary != null ? src.what_summary : buildWhatSummary(services),
    service_types: serviceTypes,
    total_cents: money.charged_cents,
    paid_cents: money.collected_cents,
    ...money,
    status,
    status_tags,
    hidden,
    needs_refund,
    archived,
    location_id: locationId || null,
    items,
    payment_story: {
      charged_cents: money.charged_cents,
      collected_cents: money.collected_cents,
      refunded_cents: money.refunded_cents,
      net_cents: money.net_cents,
    },
    refunds: Array.isArray(src.refunds) ? src.refunds : [],
    guest: src.guest || {
      name: booking.guest_name || null,
      phone: booking.phone || null,
      email: booking.email || null,
    },
    waiver: src.waiver || null,
    created_by: createdBy,
    booking_source: booking.booking_source || meta.source || null,
  };
}

/**
 * Validate a manual refund write payload (no Stripe).
 */
function validateRefundWriteInput(body) {
  const src = body || {};
  const amountRaw = src.amount_cents;
  let amount;
  try {
    amount = toInt(amountRaw, 'amount_cents');
  } catch (_e) {
    return { ok: false, error: 'amount_cents_invalid' };
  }
  if (!(amount > 0)) return { ok: false, error: 'amount_cents_must_be_positive' };

  const effectiveDate = parseIsoDate(src.effective_date);
  if (!effectiveDate) return { ok: false, error: 'effective_date_required' };

  const reason = String(src.reason || '').trim();
  if (!reason) return { ok: false, error: 'reason_required' };
  if (reason.length > 500) return { ok: false, error: 'reason_too_long' };

  const idempotencyKey = String(src.idempotency_key || '').trim();
  if (!idempotencyKey) return { ok: false, error: 'idempotency_key_required' };
  if (idempotencyKey.length > 128) return { ok: false, error: 'idempotency_key_too_long' };
  if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    return { ok: false, error: 'idempotency_key_invalid' };
  }

  return {
    ok: true,
    amount_cents: amount,
    effective_date: effectiveDate,
    reason,
    idempotency_key: idempotencyKey,
  };
}

/**
 * Idempotent retry is only valid when the prior record matches this semantic payload.
 * Mismatched booking/location/amount/date/reason → conflict (never return unrelated refund).
 */
function refundIdempotencyPayloadMatches(existing, expected) {
  if (!existing || !expected) return false;
  const amount = Number(existing.amount_cents);
  if (!Number.isFinite(amount) || amount !== Number(expected.amount_cents)) return false;
  if (String(existing.effective_date || '').slice(0, 10) !== String(expected.effective_date || '').slice(0, 10)) {
    return false;
  }
  if (String(existing.reason || '') !== String(expected.reason || '')) return false;
  if (String(existing.booking_id || '') !== String(expected.booking_id || '')) return false;
  if (String(existing.location_id || '').trim().toLowerCase()
    !== String(expected.location_id || '').trim().toLowerCase()) {
    return false;
  }
  return true;
}

/**
 * Fail closed when cumulative refunds would exceed collected gross.
 */
function assertRefundWithinCollected(collectedCents, existingRefundedCents, newAmountCents) {
  const collected = clampNonNegative(collectedCents);
  const existing = clampNonNegative(existingRefundedCents);
  const next = toInt(newAmountCents);
  if (!(next > 0)) throw new BookingsAdminError('amount_cents_must_be_positive', 'amount must be > 0', 400);
  const projected = checkedAdd(existing, next);
  if (projected > collected) {
    throw new BookingsAdminError(
      'refund_exceeds_collected',
      'recorded refunds cannot exceed collected gross for this booking',
      409,
    );
  }
  return {
    collected_cents: collected,
    existing_refunded_cents: existing,
    new_amount_cents: next,
    projected_refunded_cents: projected,
    remaining_refundable_cents: checkedSubtract(collected, existing),
  };
}

/**
 * @param {object} query
 * @param {{ mode?: 'list' | 'export' }} [opts]
 *   list  — interactive page, limit capped at LIST_MAX_LIMIT (default 50)
 *   export — no interactive pagination; hard cap EXPORT_HARD_CAP for safety
 */
function parseListQuery(query, opts) {
  const q = query || {};
  const mode = opts && opts.mode === 'export' ? 'export' : 'list';
  const maxLimit = mode === 'export' ? EXPORT_HARD_CAP : LIST_MAX_LIMIT;
  const defaultLimit = mode === 'export' ? EXPORT_HARD_CAP : 50;
  const limitRaw = q.limit != null ? Number(q.limit) : defaultLimit;
  const offsetRaw = q.offset != null ? Number(q.offset) : 0;
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), maxLimit)
    : defaultLimit;
  const offset = mode === 'export'
    ? 0
    : (Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0);
  const includeArchived = q.include_archived === true
    || q.include_archived === 1
    || q.include_archived === '1'
    || q.include_archived === 'true';
  return {
    q: String(q.q || q.search || '').trim(),
    date_from: parseIsoDate(q.date_from || q.from) || null,
    date_to: parseIsoDate(q.date_to || q.to) || null,
    status: String(q.status || '').trim().toLowerCase() || null,
    type: String(q.type || q.service_type || '').trim().toLowerCase() || null,
    include_archived: includeArchived,
    limit,
    offset,
    mode,
    max_limit: maxLimit,
  };
}

module.exports = {
  STATUS,
  ARCHIVED_STATUSES,
  STATUS_PRECEDENCE,
  CSV_COLUMNS,
  LIST_MAX_LIMIT,
  EXPORT_HARD_CAP,
  BookingsAdminError,
  toInt,
  checkedAdd,
  checkedSubtract,
  clampNonNegative,
  parseMeta,
  isTruthyMetaFlag,
  isHiddenBooking,
  isArchivedBooking,
  isCancelledBookingStatus,
  bookingNeedsRefund,
  buildBookingStatusTags,
  classifyBookingStatus,
  computeMoneyStory,
  computeBookingsSummary,
  filterBookingRows,
  bookingMatchesSearch,
  bookingMatchesDateRange,
  bookingMatchesStatus,
  bookingMatchesType,
  bookingMatchesLocation,
  buildWhatSummary,
  serviceDateSpan,
  effectiveServiceDueCents,
  computeChargedCents,
  csvEscapeCell,
  formatCentsEur,
  rowsToCsv,
  buildBookingListRow,
  validateRefundWriteInput,
  refundIdempotencyPayloadMatches,
  assertRefundWithinCollected,
  parseListQuery,
};
