'use strict';

/**
 * Sunset guest date intake — omitted-year resolution in Europe/Madrid.
 * Deterministic normalization at the Sunset booking/tool boundary.
 */

const MONTH_MAP = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
  april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const MADRID_TZ = 'Europe/Madrid';
const DEFAULT_MAX_BOOKING_HORIZON_DAYS = 730;
const MAX_BOOKING_HORIZON_DAYS = 3650;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function madridCalendarParts(refDate) {
  const d = refDate instanceof Date ? refDate : new Date(refDate || Date.now());
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MADRID_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const bag = {};
  for (const p of parts) {
    if (p.type !== 'literal') bag[p.type] = Number(p.value);
  }
  return { year: bag.year, month: bag.month, day: bag.day };
}

function isoToComparable(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

function madridTodayComparable(refDate) {
  const ref = madridCalendarParts(refDate);
  return ref.year * 10000 + ref.month * 100 + ref.day;
}

function addDaysToIso(iso, days) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function resolveSunsetMaxBookingHorizonDays(envValue) {
  const raw = envValue != null ? envValue : process.env.SUNSET_MAX_BOOKING_HORIZON_DAYS;
  if (raw == null || raw === '') return DEFAULT_MAX_BOOKING_HORIZON_DAYS;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_MAX_BOOKING_HORIZON_DAYS;
  const parsed = parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BOOKING_HORIZON_DAYS) {
    return DEFAULT_MAX_BOOKING_HORIZON_DAYS;
  }
  return parsed;
}

function madridHorizonIso(refDate, horizonDays) {
  const ref = madridCalendarParts(refDate);
  const todayIso = `${ref.year}-${pad2(ref.month)}-${pad2(ref.day)}`;
  return addDaysToIso(todayIso, horizonDays);
}

function isValidGregorianDate(year, month, day) {
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

function inferSunsetGuestYear(month, day, refDate) {
  const ref = madridCalendarParts(refDate);
  if (month > ref.month || (month === ref.month && day >= ref.day)) return ref.year;
  return ref.year + 1;
}

function monthFromName(name) {
  return MONTH_MAP[String(name || '').toLowerCase()] || null;
}

function parseExplicitYear(text) {
  const m = String(text || '').match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

function toIsoDate(year, month, day) {
  if (!isValidGregorianDate(year, month, day)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function validateSunsetGuestDateBounds(iso, refDate, opts) {
  opts = opts || {};
  const comparable = isoToComparable(iso);
  const today = madridTodayComparable(refDate);
  if (comparable == null) {
    return { ok: false, reason: 'invalid_iso_format' };
  }
  if (opts.explicit && comparable < today) {
    return { ok: false, reason: 'explicit_past_date', needs_clarification: true, iso };
  }
  const horizonDays = resolveSunsetMaxBookingHorizonDays(opts.horizonDays);
  const horizonIso = madridHorizonIso(refDate, horizonDays);
  const horizonComparable = isoToComparable(horizonIso);
  if (comparable > horizonComparable) {
    return {
      ok: false,
      reason: 'booking_horizon_exceeded',
      needs_clarification: true,
      iso,
      horizon_days: horizonDays,
      max_date: horizonIso,
    };
  }
  return { ok: true, iso, horizon_days: horizonDays, max_date: horizonIso };
}

function parseIsoDateStrict(value, refDate, opts) {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { ok: false, reason: 'invalid_iso_format' };
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!isValidGregorianDate(year, month, day)) {
    return { ok: false, reason: 'invalid_calendar_date', needs_clarification: true };
  }
  const iso = toIsoDate(year, month, day);
  const bounded = validateSunsetGuestDateBounds(iso, refDate, { ...opts, explicit: true });
  if (!bounded.ok) return bounded;
  return { ok: true, iso, explicit_year: true, ...bounded };
}

function parseNamedGuestDate(text, refDate, opts) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, reason: 'empty_date' };
  const explicitYearInText = parseExplicitYear(raw);
  const patterns = [
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-záéíóúüñ]+)(?:,?\s+(20\d{2}))?\b/i,
    /\b([a-záéíóúüñ]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/i,
    /\b(\d{1,2})\s+de\s+([a-záéíóúüñ]+)(?:,?\s+(20\d{2}))?\b/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (!m) continue;
    let day;
    let monthName;
    let year = explicitYearInText;
    if (/^\d/.test(m[1])) {
      day = Number(m[1]);
      monthName = m[2];
      if (m[3]) year = Number(m[3]);
    } else {
      monthName = m[1];
      day = Number(m[2]);
      if (m[3]) year = Number(m[3]);
    }
    const month = monthFromName(monthName);
    if (!month) continue;
    const explicitYear = !!year;
    const resolvedYear = year || inferSunsetGuestYear(month, day, refDate);
    const iso = toIsoDate(resolvedYear, month, day);
    if (!iso) {
      return { ok: false, reason: 'invalid_calendar_date', needs_clarification: true, month, day, year: resolvedYear };
    }
    const bounded = validateSunsetGuestDateBounds(iso, refDate, {
      ...opts,
      explicit: explicitYear,
    });
    if (!bounded.ok) return bounded;
    return {
      ok: true,
      iso,
      explicit_year: explicitYear,
      inferred_year: !explicitYear,
      month,
      day,
      year: resolvedYear,
    };
  }
  return { ok: false, reason: 'unrecognized_date' };
}

/**
 * Normalize one guest date field to canonical YYYY-MM-DD.
 */
function normalizeSunsetGuestDateField(value, refDate, opts) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, reason: 'empty_date' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return parseIsoDateStrict(raw, refDate, opts);
  return parseNamedGuestDate(raw, refDate, opts);
}

function normalizeDateList(values, refDate, opts) {
  const out = [];
  for (const value of values || []) {
    const parsed = normalizeSunsetGuestDateField(value, refDate, opts);
    if (!parsed.ok) return parsed;
    out.push(parsed.iso);
  }
  return { ok: true, dates: out };
}

function validateDateRangeBounds(dateFrom, dateTo, refDate, opts) {
  const fromParsed = parseIsoDateStrict(dateFrom, refDate, opts);
  if (!fromParsed.ok) return fromParsed;
  const toParsed = parseIsoDateStrict(dateTo, refDate, opts);
  if (!toParsed.ok) return toParsed;
  if (isoToComparable(toParsed.iso) < isoToComparable(fromParsed.iso)) {
    return { ok: false, reason: 'date_range_invalid', needs_clarification: true };
  }
  return { ok: true, date_from: fromParsed.iso, date_to: toParsed.iso };
}

/**
 * Normalize booking-create body date fields in place (returns new body).
 */
function normalizeSunsetBookingDatesInBody(body, refDate, opts) {
  const b = body && typeof body === 'object' ? { ...body } : {};
  const ref = refDate || new Date();

  if (b.service_date != null && String(b.service_date).trim()) {
    const parsed = normalizeSunsetGuestDateField(b.service_date, ref, opts);
    if (!parsed.ok) return { ok: false, body: b, ...parsed };
    b.service_date = parsed.iso;
  }

  if (Array.isArray(b.service_dates)) {
    const normalized = [];
    for (const d of b.service_dates) {
      const parsed = normalizeSunsetGuestDateField(d, ref, opts);
      if (!parsed.ok) return { ok: false, body: b, ...parsed };
      normalized.push(parsed.iso);
    }
    b.service_dates = normalized;
  }

  for (const key of ['date_from', 'date_to']) {
    if (b[key] != null && String(b[key]).trim()) {
      const parsed = normalizeSunsetGuestDateField(b[key], ref, opts);
      if (!parsed.ok) return { ok: false, body: b, ...parsed };
      b[key] = parsed.iso;
    }
  }

  if (b.date_from && b.date_to) {
    const range = validateDateRangeBounds(b.date_from, b.date_to, ref, opts);
    if (!range.ok) return { ok: false, body: b, ...range };
  }

  if (b.components && b.components.private_lesson && Array.isArray(b.components.private_lesson.sessions)) {
    const sessions = b.components.private_lesson.sessions.map((s) => ({ ...s }));
    for (const session of sessions) {
      if (session.date) {
        const parsed = normalizeSunsetGuestDateField(session.date, ref, opts);
        if (!parsed.ok) return { ok: false, body: b, ...parsed };
        session.date = parsed.iso;
      }
    }
    b.components = { ...b.components, private_lesson: { ...b.components.private_lesson, sessions } };
  }

  if (b.components && b.components.full_day_equipment_extension) {
    const addon = { ...b.components.full_day_equipment_extension };
    if (Array.isArray(addon.dates)) {
      const normalizedDates = [];
      for (const entry of addon.dates) {
        const e = entry && typeof entry === 'object' ? entry : {};
        const parsed = normalizeSunsetGuestDateField(e.date, ref, opts);
        if (!parsed.ok) return { ok: false, body: b, ...parsed };
        normalizedDates.push({
          date: parsed.iso,
          quantity: e.quantity != null ? e.quantity : e.people,
        });
      }
      addon.dates = normalizedDates;
      b.components = { ...b.components, full_day_equipment_extension: addon };
    } else if (addon.dates && typeof addon.dates === 'object') {
      const nextDates = {};
      for (const [rawDate, qty] of Object.entries(addon.dates)) {
        const parsed = normalizeSunsetGuestDateField(rawDate, ref, opts);
        if (!parsed.ok) return { ok: false, body: b, ...parsed };
        nextDates[parsed.iso] = qty;
      }
      addon.dates = nextDates;
      b.components = { ...b.components, full_day_equipment_extension: addon };
    }
  }

  return { ok: true, body: b };
}

module.exports = {
  MADRID_TZ,
  DEFAULT_MAX_BOOKING_HORIZON_DAYS,
  MAX_BOOKING_HORIZON_DAYS,
  madridCalendarParts,
  inferSunsetGuestYear,
  resolveSunsetMaxBookingHorizonDays,
  validateSunsetGuestDateBounds,
  normalizeSunsetGuestDateField,
  normalizeSunsetBookingDatesInBody,
  parseNamedGuestDate,
  parseIsoDateStrict,
  isValidGregorianDate,
  madridHorizonIso,
};
