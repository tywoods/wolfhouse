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
  meals: 'Meal',
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

const PACKAGE_LABELS = {
  uluwatu: 'Uluwatu',
  malibu: 'Malibu',
  waimea: 'Waimea',
};

function packageSummaryLabel(packageCode) {
  const c = trimStr(packageCode).toLowerCase();
  if (!c) return 'No Package';
  if (PACKAGE_LABELS[c]) return PACKAGE_LABELS[c];
  return c.charAt(0).toUpperCase() + c.slice(1).replace(/_/g, ' ');
}

function packageSummaryHeadline(packageCode, nights) {
  const n = nights != null ? Number(nights) : 0;
  const label = packageSummaryLabel(packageCode);
  return `${label} · ${n} night${n === 1 ? '' : 's'}`;
}

function packageDisplayName(packageCode) {
  const label = packageSummaryLabel(packageCode);
  if (label === 'No Package') return null;
  return label;
}

/**
 * @param {string|null} serviceDate
 * @param {string|null} checkIn
 * @param {string|null} checkOut
 * @param {string} [timezone]
 * @returns {boolean}
 */
function isServiceDateInStay(serviceDate, checkIn, checkOut, timezone = 'Europe/Madrid') {
  const d = normalizeBookingDateOnly(serviceDate, { timezone });
  if (!d) return false;
  const stayDates = buildStayDates(checkIn, checkOut, timezone);
  return stayDates.includes(d);
}

function formatPaidServiceSummaryLine(svc) {
  const parts = [svc.service_name || svc.service_type || 'Service'];
  const qty = Math.max(1, Number(svc.quantity) || 1);
  if (qty > 1) parts.push(`×${qty}`);
  if (svc.total_price_cents != null) {
    parts.push(`€${(Number(svc.total_price_cents) / 100).toFixed(2)}`);
  }
  return parts.join(' · ');
}

/**
 * CSS class for color-coded service pebbles (Staff drawer).
 *
 * @param {string|null} serviceType
 * @param {string|null} serviceName
 * @returns {string}
 */
function serviceColorClass(serviceType, serviceName) {
  const t = trimStr(serviceType).toLowerCase();
  const name = trimStr(serviceName).toLowerCase();
  if (t === 'soft_board' || /soft board|soft top/.test(name)) return 'bc-svc-color-softboard';
  if (t === 'hard_board' || t === 'surfboard' || /hard board/.test(name)) return 'bc-svc-color-board';
  if (t === 'wetsuit' || /wetsuit/.test(name)) return 'bc-svc-color-wetsuit';
  if (t === 'yoga' || /yoga/.test(name)) return 'bc-svc-color-yoga';
  if (/^meal|meals|dinner|breakfast/.test(t) || /\bmeal/.test(name)) return 'bc-svc-color-meal';
  if (/surf_lesson|lesson/.test(t) || /lesson/.test(name)) return 'bc-svc-color-lesson';
  return 'bc-svc-color-neutral';
}

/**
 * Aggregate unit-level rows into summary lines (e.g. Yoga ×3 · €45).
 *
 * @param {object[]} allServices
 * @returns {object[]}
 */
function buildPaidRequestedSummaryLines(allServices) {
  const groups = new Map();
  (allServices || []).forEach((svc) => {
    const key = `${svc.service_type || ''}|${svc.service_name || ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        service_type: svc.service_type,
        service_name: svc.service_name,
        quantity: 0,
        total_price_cents: 0,
        color_class: svc.color_class,
      });
    }
    const g = groups.get(key);
    g.quantity += Math.max(1, Number(svc.quantity) || 1);
    g.total_price_cents += Number(svc.total_price_cents) || 0;
  });
  return Array.from(groups.values()).map((g) => ({
    ...g,
    summary_line: formatPaidServiceSummaryLine(g),
  }));
}

/**
 * Split quantity>1 service rows into individual schedulable units (qty=1 each).
 * Skips rows with amount_paid_cents > 0 to avoid invoice/payment drift.
 *
 * @param {import('pg').PoolClient} pg
 * @param {string} clientSlug
 * @param {string} bookingId
 * @returns {Promise<number>} number of rows split
 */
async function splitMultiQuantityServiceRecords(pg, clientSlug, bookingId) {
  const r = await pg.query(
    `SELECT id::text AS id, client_slug, booking_id::text AS booking_id, booking_code, guest_name,
            service_type, service_date, quantity, status, payment_status,
            amount_due_cents, amount_paid_cents, source, notes, metadata
     FROM booking_service_records
     WHERE client_slug = $1 AND booking_id = $2::uuid AND quantity > 1
       AND COALESCE(amount_paid_cents, 0) = 0`,
    [clientSlug, bookingId],
  );
  if (!r.rows.length) return 0;

  await pg.query('BEGIN');
  try {
    let splitCount = 0;
    for (const row of r.rows) {
    const qty = Math.max(1, Number(row.quantity) || 1);
    if (qty <= 1) continue;
    const total = Number(row.amount_due_cents) || 0;
    const unitCents = Math.floor(total / qty);
    const firstUnitCents = total - unitCents * (qty - 1);
    let meta = parseMetadata(row.metadata);
    meta = { ...meta, split_from: row.id, split_at: new Date().toISOString() };

    await pg.query(
      `UPDATE booking_service_records
       SET quantity = 1, amount_due_cents = $1, metadata = $2::jsonb, updated_at = NOW()
       WHERE id = $3::uuid`,
      [firstUnitCents, JSON.stringify({ ...meta, split_unit: 1 }), row.id],
    );

    for (let i = 1; i < qty; i++) {
      const unitMeta = { ...meta, split_unit: i + 1 };
      await pg.query(
        `INSERT INTO booking_service_records (
           client_slug, booking_id, booking_code, guest_name,
           service_type, service_date, quantity, status,
           amount_due_cents, amount_paid_cents, payment_status,
           source, notes, metadata
         ) VALUES (
           $1, $2::uuid, $3, $4,
           $5, $6::date, 1, $7,
           $8, 0, $9,
           $10, $11, $12::jsonb
         )`,
        [
          row.client_slug || clientSlug,
          row.booking_id || bookingId,
          row.booking_code,
          row.guest_name,
          row.service_type,
          row.service_date,
          row.status || 'requested',
          unitCents,
          row.payment_status || 'not_requested',
          row.source || 'staff_manual',
          row.notes,
          JSON.stringify(unitMeta),
        ],
      );
    }
    splitCount += 1;
    }
    await pg.query('COMMIT');
    return splitCount;
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

function computeServicesTotalCents(allServices) {
  return (allServices || []).reduce(
    (sum, svc) => sum + (Number(svc.total_price_cents) || 0),
    0,
  );
}

/**
 * Distribute quantity across stay dates starting at startDate (Span Across Booking).
 *
 * @param {{ quantity: number, guestCount: number, checkIn: string, checkOut: string, startDate: string, timezone?: string }} opts
 * @returns {{ dates?: string[], error?: string }}
 */
function distributeSpanScheduleDates(opts = {}) {
  const quantity = Math.max(1, Number(opts.quantity) || 1);
  const guestCount = Math.max(1, Number(opts.guestCount) || 1);
  const timezone = opts.timezone || 'Europe/Madrid';
  const checkIn = normalizeBookingDateOnly(opts.checkIn, { timezone });
  const checkOut = normalizeBookingDateOnly(opts.checkOut, { timezone });
  const startDate = normalizeBookingDateOnly(opts.startDate, { timezone });
  const spanBlockMsg = 'Not enough stay dates from this start date. Choose an earlier start date or Schedule Later.';

  if (!startDate) {
    return { error: 'Start Date is required for Span Across Booking.' };
  }

  const stayDates = buildStayDates(checkIn, checkOut, timezone);
  const startIdx = stayDates.indexOf(startDate);
  if (startIdx < 0) {
    return { error: 'Start Date must be within the booking stay.' };
  }

  const availableDates = stayDates.slice(startIdx);
  const numDays = availableDates.length;
  if (numDays === 0) {
    return { error: spanBlockMsg };
  }

  const capacity = numDays * guestCount;
  if (quantity > capacity) {
    return { error: spanBlockMsg };
  }

  const perDay = new Array(numDays).fill(0);
  if (quantity === numDays * guestCount) {
    perDay.fill(guestCount);
  } else if (quantity < numDays) {
    for (let i = 0; i < quantity; i++) perDay[i] = 1;
  } else {
    const even = Math.floor(quantity / numDays);
    const rem = quantity % numDays;
    for (let i = 0; i < numDays; i++) {
      perDay[i] = even + (i < rem ? 1 : 0);
    }
  }

  const dates = [];
  for (let i = 0; i < numDays; i++) {
    for (let j = 0; j < perDay[i]; j++) {
      dates.push(availableDates[i]);
    }
  }
  return { dates };
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
  const serviceName = serviceTypeLabel(row);
  return {
    service_record_id: row.service_record_id || row.id || null,
    service_type: row.service_type || null,
    service_name: serviceName,
    service_date: serviceDate,
    quantity: qty,
    unit_price_cents: unit,
    total_price_cents: total,
    currency: 'EUR',
    status: row.status || null,
    payment_status: row.payment_status || null,
    included_in_package: meta.included_in_package === true,
    notes: row.notes || null,
    color_class: serviceColorClass(row.service_type, serviceName),
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
  const allServices = rows.map((row) => formatServiceRecordForSchedule(row, { timezone }));
  const paid_requested_services = buildPaidRequestedSummaryLines(allServices);
  const total_services_cents = computeServicesTotalCents(allServices);

  return {
    package_summary: {
      package_code: booking.package_code || null,
      package_name: packageDisplayName(booking.package_code),
      headline: packageSummaryHeadline(booking.package_code, nights),
      nights,
    },
    paid_requested_services,
    total_services_cents,
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
  buildPaidRequestedSummaryLines,
  computeServicesTotalCents,
  distributeSpanScheduleDates,
  formatServiceRecordForSchedule,
  formatPaidServiceSummaryLine,
  formatDateLabel,
  serviceTypeLabel,
  serviceColorClass,
  packageSummaryHeadline,
  packageSummaryLabel,
  isServiceDateInStay,
  addDaysToDateOnly,
  splitMultiQuantityServiceRecords,
};
