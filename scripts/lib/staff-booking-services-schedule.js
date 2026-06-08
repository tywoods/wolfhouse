/**
 * Phase 26g — Read-only booking services schedule grouping for Staff drawer.
 *
 * @module staff-booking-services-schedule
 */

'use strict';

const { normalizeBookingDateOnly } = require('./booking-transfers');

const SERVICE_TYPE_LABELS = {
  yoga: 'Yoga',
  meal: 'Meal',
  meals: 'Meals',
  surf_lesson: 'Surf lesson',
  wetsuit: 'Wetsuit',
  soft_board: 'Soft board',
  hard_board: 'Hard board',
  surfboard: 'Surfboard',
};

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function parseMetadata(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function addDaysToDateOnly(dateStr, deltaDays) {
  const s = trimStr(dateStr);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Half-open stay nights: check_in .. check_out-1 (checkout day excluded unless services exist).
 *
 * @param {string|null} checkIn
 * @param {string|null} checkOut
 * @param {string} [timezone]
 * @returns {string[]}
 */
function buildStayDates(checkIn, checkOut, timezone = 'Europe/Madrid') {
  const cin = normalizeBookingDateOnly(checkIn, { timezone });
  const cout = normalizeBookingDateOnly(checkOut, { timezone });
  if (!cin || !cout) return [];
  const nights = Math.round(
    (new Date(`${cout}T12:00:00Z`).getTime() - new Date(`${cin}T12:00:00Z`).getTime()) / 86400000,
  );
  const dates = [];
  for (let i = 0; i < Math.max(0, nights); i++) {
    const d = addDaysToDateOnly(cin, i);
    if (d) dates.push(d);
  }
  return dates;
}

function serviceTypeLabel(row) {
  const meta = parseMetadata(row.metadata);
  if (meta.staff_ui_service_type) {
    const ui = trimStr(meta.staff_ui_service_type);
    if (ui === 'soft_board') return 'Soft board';
    if (ui === 'hard_board') return 'Hard board';
    return SERVICE_TYPE_LABELS[ui] || ui.replace(/_/g, ' ');
  }
  const t = trimStr(row.service_type).toLowerCase();
  if (t === 'surfboard' && meta.board_variant === 'soft') return 'Soft board';
  if (t === 'surfboard' && meta.board_variant === 'hard') return 'Hard board';
  return SERVICE_TYPE_LABELS[t] || (t ? t.replace(/_/g, ' ') : '\u2014');
}

function packageDisplayName(packageCode) {
  const c = trimStr(packageCode);
  if (!c) return null;
  return c.charAt(0).toUpperCase() + c.slice(1).replace(/_/g, ' ') + ' package';
}

/**
 * @param {object} row
 * @param {{ timezone?: string }} [opts]
 * @returns {object}
 */
function formatServiceRecordForSchedule(row, opts = {}) {
  const timezone = opts.timezone || 'Europe/Madrid';
  const qty = Math.max(1, Number(row.quantity) || 1);
  const total = row.amount_due_cents != null ? Number(row.amount_due_cents) : null;
  const unit = total != null && qty > 0 ? Math.round(total / qty) : null;
  const meta = parseMetadata(row.metadata);
  const serviceDate = row.service_date
    ? normalizeBookingDateOnly(row.service_date, { timezone })
    : null;
  return {
    service_record_id: row.service_record_id || row.id || null,
    service_type: row.service_type || null,
    service_name: serviceTypeLabel(row),
    service_date: serviceDate,
    quantity: qty,
    unit_price_cents: unit,
    total_price_cents: total,
    currency: 'EUR',
    status: row.status || null,
    payment_status: row.payment_status || null,
    included_in_package: meta.included_in_package === true,
    notes: row.notes || null,
  };
}

function formatDateLabel(dateStr, timezone = 'Europe/Madrid') {
  const s = trimStr(dateStr);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  try {
    const d = new Date(`${s}T12:00:00Z`);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(d);
  } catch {
    return s;
  }
}

/**
 * @param {{ booking: object, serviceRecords: object[], timezone?: string }} opts
 * @returns {object}
 */
function buildBookingServicesSchedule(opts = {}) {
  const booking = opts.booking || {};
  const timezone = opts.timezone || 'Europe/Madrid';
  const rows = Array.isArray(opts.serviceRecords) ? opts.serviceRecords : [];
  const checkIn = normalizeBookingDateOnly(booking.check_in, { timezone });
  const checkOut = normalizeBookingDateOnly(booking.check_out, { timezone });
  const stayDates = buildStayDates(checkIn, checkOut, timezone);
  const staySet = new Set(stayDates);
  const byDate = {};
  const unscheduled = [];

  rows.forEach((row) => {
    const svc = formatServiceRecordForSchedule(row, { timezone });
    const d = svc.service_date;
    if (!d) {
      unscheduled.push(svc);
      return;
    }
    if (staySet.has(d) || d === checkOut) {
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(svc);
    } else {
      unscheduled.push(svc);
    }
  });

  const scheduleDates = stayDates.slice();
  if (checkOut && byDate[checkOut] && !staySet.has(checkOut)) {
    scheduleDates.push(checkOut);
  }

  const services_by_date = scheduleDates.map((date) => ({
    date,
    label: formatDateLabel(date, timezone),
    services: byDate[date] || [],
  }));

  let scheduledCount = 0;
  services_by_date.forEach((g) => { scheduledCount += g.services.length; });

  const nights = stayDates.length;

  return {
    package_summary: {
      package_code: booking.package_code || null,
      package_name: packageDisplayName(booking.package_code),
      nights,
      included_note: 'Package services shown below when scheduled.',
    },
    stay_dates: stayDates,
    check_in: checkIn,
    check_out: checkOut,
    services_by_date,
    unscheduled_services: unscheduled,
    totals: {
      scheduled_count: scheduledCount,
      unscheduled_count: unscheduled.length,
      record_count: rows.length,
    },
  };
}

module.exports = {
  buildStayDates,
  buildBookingServicesSchedule,
  formatServiceRecordForSchedule,
  formatDateLabel,
  serviceTypeLabel,
  addDaysToDateOnly,
};
