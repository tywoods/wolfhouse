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

function parseIsoDateStrict(value) {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { ok: false, reason: 'invalid_iso_format' };
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!isValidGregorianDate(year, month, day)) {
    return { ok: false, reason: 'invalid_calendar_date', needs_clarification: true };
  }
  return { ok: true, iso: toIsoDate(year, month, day), explicit_year: true };
}

function parseNamedGuestDate(text, refDate) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, reason: 'empty_date' };
  const explicitYear = parseExplicitYear(raw);
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
    let year = explicitYear;
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
    const resolvedYear = year || inferSunsetGuestYear(month, day, refDate);
    const iso = toIsoDate(resolvedYear, month, day);
    if (!iso) {
      return { ok: false, reason: 'invalid_calendar_date', needs_clarification: true, month, day, year: resolvedYear };
    }
    const ref = madridCalendarParts(refDate);
    if (year && year < ref.year) {
      return { ok: false, reason: 'explicit_past_year', needs_clarification: true, iso };
    }
    return {
      ok: true,
      iso,
      explicit_year: !!year,
      inferred_year: !year,
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
function normalizeSunsetGuestDateField(value, refDate) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, reason: 'empty_date' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return parseIsoDateStrict(raw);
  return parseNamedGuestDate(raw, refDate);
}

function normalizeDateList(values, refDate) {
  const out = [];
  for (const value of values || []) {
    const parsed = normalizeSunsetGuestDateField(value, refDate);
    if (!parsed.ok) return parsed;
    out.push(parsed.iso);
  }
  return { ok: true, dates: out };
}

/**
 * Normalize booking-create body date fields in place (returns new body).
 */
function normalizeSunsetBookingDatesInBody(body, refDate) {
  const b = body && typeof body === 'object' ? { ...body } : {};
  const ref = refDate || new Date();

  if (b.service_date != null && String(b.service_date).trim() && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.service_date).trim())) {
    const parsed = normalizeSunsetGuestDateField(b.service_date, ref);
    if (!parsed.ok) return { ok: false, body: b, ...parsed };
    b.service_date = parsed.iso;
  }

  if (Array.isArray(b.service_dates)) {
    const normalized = [];
    for (const d of b.service_dates) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '').trim())) {
        const strict = parseIsoDateStrict(d);
        if (!strict.ok) return { ok: false, body: b, ...strict };
        normalized.push(strict.iso);
        continue;
      }
      const parsed = normalizeSunsetGuestDateField(d, ref);
      if (!parsed.ok) return { ok: false, body: b, ...parsed };
      normalized.push(parsed.iso);
    }
    b.service_dates = normalized;
  }

  for (const key of ['date_from', 'date_to']) {
    if (b[key] != null && String(b[key]).trim() && !/^\d{4}-\d{2}-\d{2}$/.test(String(b[key]).trim())) {
      const parsed = normalizeSunsetGuestDateField(b[key], ref);
      if (!parsed.ok) return { ok: false, body: b, ...parsed };
      b[key] = parsed.iso;
    }
  }

  if (b.components && b.components.private_lesson && Array.isArray(b.components.private_lesson.sessions)) {
    const sessions = b.components.private_lesson.sessions.map((s) => ({ ...s }));
    for (const session of sessions) {
      if (session.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(session.date).trim())) {
        const parsed = normalizeSunsetGuestDateField(session.date, ref);
        if (!parsed.ok) return { ok: false, body: b, ...parsed };
        session.date = parsed.iso;
      }
    }
    b.components = { ...b.components, private_lesson: { ...b.components.private_lesson, sessions } };
  }

  return { ok: true, body: b };
}

module.exports = {
  MADRID_TZ,
  madridCalendarParts,
  inferSunsetGuestYear,
  normalizeSunsetGuestDateField,
  normalizeSunsetBookingDatesInBody,
  parseNamedGuestDate,
  isValidGregorianDate,
};
