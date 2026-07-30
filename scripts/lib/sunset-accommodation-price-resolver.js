'use strict';

/**
 * Sunset employee-managed Accommodation — pure date/range/price math.
 *
 * Half-open stays and season windows: [check_in, check_out).
 * Occupied nights = every calendar date d with check_in <= d < check_out.
 * Each occupied night is priced by the single covering season range.
 * Adjacent ranges allowed; overlapping ranges rejected.
 * Server owns money — never trust client cents.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TITLE = 120;
const MAX_RANGES = 64;
const MAX_AMOUNT_CENTS = 100000000; // €1,000,000.00 hard ceiling
const MAX_STAY_NIGHTS = 366;
const MAX_STAYS = 20;
const MAX_CLIENT_STAY_ID = 64;

const STAFF_ACCOMMODATION_SOURCE = 'staff_accommodation';
const STAFF_ACCOMMODATION_COMPONENT = 'staff_accommodation';

const ACCOMMODATION_CLIENT_MONEY_KEYS = Object.freeze([
  'amount_cents', 'total_cents', 'nightly_cents', 'unit_amount_cents',
  'amount_eur', 'total_eur', 'price', 'nightly_breakdown', 'season_groups',
]);

function isIsoDate(raw) {
  const s = String(raw == null ? '' : raw).trim().slice(0, 10);
  if (!ISO_DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map((n) => Number(n));
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && (dt.getUTCMonth() + 1) === m && dt.getUTCDate() === d;
}

function parseIsoUtc(iso) {
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split('-').map((n) => Number(n));
  return new Date(Date.UTC(y, m - 1, d));
}

function formatIsoUtc(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDaysIso(iso, days) {
  const dt = parseIsoUtc(iso);
  dt.setUTCDate(dt.getUTCDate() + days);
  return formatIsoUtc(dt);
}

function compareIso(a, b) {
  return String(a).slice(0, 10).localeCompare(String(b).slice(0, 10));
}

/**
 * Occupied nights for half-open [checkIn, checkOut).
 * @returns {{ ok:true, nights:string[] } | { ok:false, error:string, reason_code:string }}
 */
function occupiedNights(checkIn, checkOut) {
  if (!isIsoDate(checkIn)) {
    return { ok: false, error: 'check_in must be YYYY-MM-DD', reason_code: 'accommodation_check_in_invalid' };
  }
  if (!isIsoDate(checkOut)) {
    return { ok: false, error: 'check_out must be YYYY-MM-DD', reason_code: 'accommodation_check_out_invalid' };
  }
  if (compareIso(checkOut, checkIn) <= 0) {
    return {
      ok: false,
      error: 'check_out must be after check_in',
      reason_code: 'accommodation_date_order',
    };
  }
  const nights = [];
  let cur = String(checkIn).slice(0, 10);
  const end = String(checkOut).slice(0, 10);
  while (compareIso(cur, end) < 0) {
    nights.push(cur);
    if (nights.length > MAX_STAY_NIGHTS) {
      return {
        ok: false,
        error: `Accommodation stay exceeds ${MAX_STAY_NIGHTS} nights`,
        reason_code: 'accommodation_stay_too_long',
      };
    }
    cur = addDaysIso(cur, 1);
  }
  if (!nights.length) {
    return {
      ok: false,
      error: 'Accommodation requires at least one occupied night',
      reason_code: 'accommodation_zero_nights',
    };
  }
  return { ok: true, nights };
}

/**
 * Normalize + validate admin season ranges. Overlaps rejected; adjacent OK.
 * Shape: { id?, title, check_in, check_out, amount_cents, currency? }
 */
function normalizeAccommodationRanges(raw) {
  if (raw == null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'ranges must be an array', reason_code: 'accommodation_ranges_invalid' };
  }
  if (raw.length > MAX_RANGES) {
    return {
      ok: false,
      error: `ranges max ${MAX_RANGES}`,
      reason_code: 'accommodation_ranges_too_many',
    };
  }
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = raw[i];
    if (!row || typeof row !== 'object') {
      return {
        ok: false,
        error: `ranges[${i}] must be an object`,
        reason_code: 'accommodation_range_invalid',
      };
    }
    const title = String(row.title != null ? row.title : '').trim();
    if (!title) {
      return {
        ok: false,
        error: `ranges[${i}].title is required`,
        reason_code: 'accommodation_title_required',
      };
    }
    if (title.length > MAX_TITLE) {
      return {
        ok: false,
        error: `ranges[${i}].title max ${MAX_TITLE} chars`,
        reason_code: 'accommodation_title_too_long',
      };
    }
    const checkIn = String(row.check_in != null ? row.check_in : '').trim().slice(0, 10);
    const checkOut = String(row.check_out != null ? row.check_out : '').trim().slice(0, 10);
    if (!isIsoDate(checkIn)) {
      return {
        ok: false,
        error: `ranges[${i}].check_in must be YYYY-MM-DD`,
        reason_code: 'accommodation_check_in_invalid',
      };
    }
    if (!isIsoDate(checkOut)) {
      return {
        ok: false,
        error: `ranges[${i}].check_out must be YYYY-MM-DD`,
        reason_code: 'accommodation_check_out_invalid',
      };
    }
    if (compareIso(checkOut, checkIn) <= 0) {
      return {
        ok: false,
        error: `ranges[${i}]: check_out must be after check_in`,
        reason_code: 'accommodation_date_order',
      };
    }
    // Reject fractional numerics and non-integer strings — never parseInt/truncate.
    const centsRaw = row.amount_cents;
    let cents = null;
    if (typeof centsRaw === 'number') {
      if (Number.isInteger(centsRaw) && Number.isSafeInteger(centsRaw)) cents = centsRaw;
    } else if (typeof centsRaw === 'string') {
      const s = centsRaw.trim();
      // Integer digits only (optional leading +). No decimals, no exponent.
      if (/^\+?\d+$/.test(s)) {
        const n = Number(s);
        if (Number.isSafeInteger(n)) cents = n;
      }
    }
    if (cents == null || !Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_AMOUNT_CENTS) {
      return {
        ok: false,
        error: `ranges[${i}].amount_cents must be a positive safe integer`,
        reason_code: 'accommodation_amount_invalid',
      };
    }
    const currency = String(row.currency != null ? row.currency : 'EUR').trim().toUpperCase() || 'EUR';
    if (!/^[A-Z]{3}$/.test(currency)) {
      return {
        ok: false,
        error: `ranges[${i}].currency must be ISO-4217`,
        reason_code: 'accommodation_currency_invalid',
      };
    }
    const id = row.id != null ? String(row.id).trim() : null;
    out.push({
      id: id || null,
      title,
      check_in: checkIn,
      check_out: checkOut,
      amount_cents: cents,
      currency,
      sort_order: Number.isInteger(Number(row.sort_order)) ? Number(row.sort_order) : i,
    });
  }

  // Sort by check_in then check_out for overlap scan.
  const sorted = out.slice().sort((a, b) => {
    const c = compareIso(a.check_in, b.check_in);
    if (c) return c;
    return compareIso(a.check_out, b.check_out);
  });
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    // Half-open: prev.check_out == cur.check_in is adjacent (allowed).
    // Overlap when prev.check_out > cur.check_in.
    if (compareIso(prev.check_out, cur.check_in) > 0) {
      return {
        ok: false,
        error: `Season ranges overlap: "${prev.title}" [${prev.check_in}, ${prev.check_out}) and "${cur.title}" [${cur.check_in}, ${cur.check_out})`,
        reason_code: 'accommodation_ranges_overlap',
        overlap: {
          a: { title: prev.title, check_in: prev.check_in, check_out: prev.check_out },
          b: { title: cur.title, check_in: cur.check_in, check_out: cur.check_out },
        },
      };
    }
  }
  return { ok: true, value: out };
}

function rangeCoversNight(range, nightIso) {
  if (!range) return false;
  return compareIso(nightIso, range.check_in) >= 0
    && compareIso(nightIso, range.check_out) < 0;
}

function findCoveringRange(ranges, nightIso) {
  for (const r of ranges || []) {
    if (rangeCoversNight(r, nightIso)) return r;
  }
  return null;
}

/**
 * Collapse consecutive uncovered nights into human spans for error messages.
 * e.g. ['2026-07-01','2026-07-02','2026-07-05'] → '2026-07-01–2026-07-02, 2026-07-05'
 */
function formatUncoveredSpan(uncoveredNights) {
  const nights = (uncoveredNights || []).map((d) => String(d).slice(0, 10)).filter(isIsoDate);
  if (!nights.length) return '';
  nights.sort(compareIso);
  const spans = [];
  let start = nights[0];
  let prev = nights[0];
  for (let i = 1; i < nights.length; i += 1) {
    const n = nights[i];
    if (addDaysIso(prev, 1) === n) {
      prev = n;
      continue;
    }
    spans.push(start === prev ? start : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  spans.push(start === prev ? start : `${start}–${prev}`);
  return spans.join(', ');
}

function uncoveredErrorMessage(uncoveredNights) {
  const span = formatUncoveredSpan(uncoveredNights);
  if (!span) {
    return 'Accommodation dates include nights with no seasonal price configured.';
  }
  if (uncoveredNights.length === 1) {
    return `No accommodation price covers ${span}. Add a seasonal range or change the dates.`;
  }
  return `No accommodation price covers ${span}. Add seasonal ranges or change the dates.`;
}

/**
 * Price a stay against normalized active ranges.
 * @returns {{ ok:true, check_in, check_out, nights, nightly_breakdown, season_groups, total_cents, currency }
 *         | { ok:false, error, reason_code, uncovered_nights? }}
 */
function priceAccommodationStay({ ranges, checkIn, checkOut, currency } = {}) {
  const nightsRes = occupiedNights(checkIn, checkOut);
  if (!nightsRes.ok) return nightsRes;
  const active = Array.isArray(ranges) ? ranges : [];
  const nightly_breakdown = [];
  const uncovered = [];
  let total = 0;
  const cur = String(currency || (active[0] && active[0].currency) || 'EUR').trim().toUpperCase() || 'EUR';

  for (const night of nightsRes.nights) {
    const range = findCoveringRange(active, night);
    if (!range) {
      uncovered.push(night);
      continue;
    }
    const cents = Number(range.amount_cents);
    if (!Number.isSafeInteger(cents) || cents <= 0) {
      uncovered.push(night);
      continue;
    }
    total += cents;
    if (!Number.isSafeInteger(total)) {
      return {
        ok: false,
        error: 'Accommodation total overflow',
        reason_code: 'accommodation_total_overflow',
      };
    }
    nightly_breakdown.push({
      date: night,
      range_id: range.id || null,
      title: range.title,
      amount_cents: cents,
      currency: range.currency || cur,
    });
  }

  if (uncovered.length) {
    return {
      ok: false,
      error: uncoveredErrorMessage(uncovered),
      reason_code: 'accommodation_uncovered_nights',
      uncovered_nights: uncovered,
      uncovered_span: formatUncoveredSpan(uncovered),
    };
  }

  // Group consecutive same-title / same-nightly-rate nights for display.
  const season_groups = [];
  for (const row of nightly_breakdown) {
    const last = season_groups[season_groups.length - 1];
    if (
      last
      && last.title === row.title
      && last.nightly_cents === row.amount_cents
      && addDaysIso(last.last_night, 1) === row.date
    ) {
      last.nights += 1;
      last.last_night = row.date;
      last.subtotal_cents += row.amount_cents;
      last.check_out = addDaysIso(row.date, 1);
    } else {
      season_groups.push({
        title: row.title,
        range_id: row.range_id,
        nights: 1,
        first_night: row.date,
        last_night: row.date,
        check_in: row.date,
        check_out: addDaysIso(row.date, 1),
        nightly_cents: row.amount_cents,
        subtotal_cents: row.amount_cents,
        currency: row.currency || cur,
      });
    }
  }

  return {
    ok: true,
    check_in: String(checkIn).slice(0, 10),
    check_out: String(checkOut).slice(0, 10),
    nights: nightsRes.nights.length,
    occupied_nights: nightsRes.nights.slice(),
    nightly_breakdown,
    season_groups,
    total_cents: total,
    currency: cur,
    component: STAFF_ACCOMMODATION_COMPONENT,
    source: STAFF_ACCOMMODATION_SOURCE,
  };
}

function rejectClientMoneyFields(obj, pathPrefix) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  for (const k of ACCOMMODATION_CLIENT_MONEY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) {
      return {
        ok: false,
        error: `${pathPrefix}.${k} must not be supplied by the client`,
        reason_code: 'accommodation_client_money_forbidden',
      };
    }
  }
  return null;
}

/**
 * Normalize one stay identity (dates only). Money never accepted.
 * @returns {{ ok:true, value:{ client_stay_id?, check_in, check_out, nights } } | { ok:false, ... }}
 */
function normalizeAccommodationStay(raw, index) {
  const path = Number.isInteger(index) ? `accommodation.stays[${index}]` : 'accommodation';
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      error: `${path} must be an object`,
      reason_code: 'accommodation_stay_invalid',
    };
  }
  const moneyErr = rejectClientMoneyFields(raw, path);
  if (moneyErr) return moneyErr;

  const checkIn = String(raw.check_in != null ? raw.check_in : '').trim().slice(0, 10);
  const checkOut = String(raw.check_out != null ? raw.check_out : '').trim().slice(0, 10);
  const nightsRes = occupiedNights(checkIn, checkOut);
  if (!nightsRes.ok) return nightsRes;

  let clientStayId = null;
  if (raw.client_stay_id != null && String(raw.client_stay_id).trim() !== '') {
    clientStayId = String(raw.client_stay_id).trim().slice(0, MAX_CLIENT_STAY_ID);
    if (!clientStayId) {
      return {
        ok: false,
        error: `${path}.client_stay_id is invalid`,
        reason_code: 'accommodation_client_stay_id_invalid',
      };
    }
  }

  return {
    ok: true,
    value: {
      client_stay_id: clientStayId,
      check_in: checkIn,
      check_out: checkOut,
      nights: nightsRes.nights.length,
    },
  };
}

/**
 * Half-open stay overlap: prev.check_out > cur.check_in.
 * Adjacent (prev.check_out === cur.check_in) allowed.
 */
function findOverlappingAccommodationStays(stays) {
  const list = (Array.isArray(stays) ? stays : []).map((s, i) => ({
    index: i,
    check_in: String(s && s.check_in || '').slice(0, 10),
    check_out: String(s && s.check_out || '').slice(0, 10),
  })).filter((s) => s.check_in && s.check_out);
  const sorted = list.slice().sort((a, b) => {
    const c = compareIso(a.check_in, b.check_in);
    if (c) return c;
    return compareIso(a.check_out, b.check_out);
  });
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (compareIso(prev.check_out, cur.check_in) > 0) {
      return {
        a: prev,
        b: cur,
        error: `Accommodation stays overlap: [${prev.check_in}, ${prev.check_out}) and [${cur.check_in}, ${cur.check_out})`,
        reason_code: 'accommodation_stays_overlap',
      };
    }
  }
  return null;
}

/**
 * Deterministic stay order for fingerprint / persistence / quote.
 * Sort by check_in, check_out, then client_stay_id.
 */
function sortAccommodationStays(stays) {
  return (Array.isArray(stays) ? stays.slice() : []).sort((a, b) => {
    const cIn = compareIso(a.check_in, b.check_in);
    if (cIn) return cIn;
    const cOut = compareIso(a.check_out, b.check_out);
    if (cOut) return cOut;
    return String(a.client_stay_id || '').localeCompare(String(b.client_stay_id || ''));
  });
}

/**
 * Build canonical multi-stay selection from already-normalized stays.
 * Mirrors first stay at top-level for singular backward-compat readers.
 */
function buildAccommodationSelectionValue(stays) {
  const ordered = sortAccommodationStays(stays);
  if (!ordered.length) return null;
  const first = ordered[0];
  return {
    enabled: true,
    stays: ordered.map((s) => ({
      client_stay_id: s.client_stay_id || null,
      check_in: s.check_in,
      check_out: s.check_out,
      nights: s.nights,
    })),
    // Singular mirror (first stay) — legacy Create/Edit readers + tests.
    check_in: first.check_in,
    check_out: first.check_out,
    nights: first.nights,
  };
}

/**
 * Extract stay list from any accepted wire shape without full normalize.
 * Used by UI helpers / fingerprint when selection already normalized.
 */
function accommodationStaysFromSelection(sel) {
  if (!sel || sel.enabled === false) return [];
  if (Array.isArray(sel.stays) && sel.stays.length) {
    return sel.stays.map((s) => ({
      client_stay_id: s.client_stay_id || null,
      check_in: String(s.check_in || '').slice(0, 10),
      check_out: String(s.check_out || '').slice(0, 10),
      nights: Number(s.nights) || 0,
    })).filter((s) => s.check_in && s.check_out);
  }
  // Singular legacy shape.
  if (sel.check_in && sel.check_out) {
    return [{
      client_stay_id: sel.client_stay_id || null,
      check_in: String(sel.check_in).slice(0, 10),
      check_out: String(sel.check_out).slice(0, 10),
      nights: Number(sel.nights) || 0,
    }];
  }
  return [];
}

/**
 * Client wire selection: identity + dates only. Money never accepted.
 *
 * Accepted shapes (backward compatible):
 *  - Singular: { enabled: true, check_in, check_out }
 *  - Multi:    { enabled: true, stays: [{ client_stay_id?, check_in, check_out }, ...] }
 *  - Array:    [{ check_in, check_out }, ...]
 *  - Remove:   null | false | { enabled: false } | { stays: [] }
 */
function normalizeAccommodationSelection(raw) {
  if (raw == null || raw === '' || raw === false) {
    return { ok: true, skip: true, value: null };
  }

  // Array of stays at the top level.
  if (Array.isArray(raw)) {
    if (!raw.length) return { ok: true, skip: true, value: null };
    if (raw.length > MAX_STAYS) {
      return {
        ok: false,
        error: `accommodation stays max ${MAX_STAYS}`,
        reason_code: 'accommodation_stays_too_many',
      };
    }
    const stays = [];
    for (let i = 0; i < raw.length; i += 1) {
      const one = normalizeAccommodationStay(raw[i], i);
      if (!one.ok) return one;
      stays.push(one.value);
    }
    const overlap = findOverlappingAccommodationStays(stays);
    if (overlap) {
      return {
        ok: false,
        error: overlap.error,
        reason_code: overlap.reason_code,
        overlap: {
          a: { check_in: overlap.a.check_in, check_out: overlap.a.check_out },
          b: { check_in: overlap.b.check_in, check_out: overlap.b.check_out },
        },
      };
    }
    return { ok: true, skip: false, value: buildAccommodationSelectionValue(stays) };
  }

  if (typeof raw !== 'object') {
    return {
      ok: false,
      error: 'accommodation must be an object',
      reason_code: 'accommodation_invalid',
    };
  }
  if (raw.enabled === false || raw.enabled === 'false' || raw.enabled === 0) {
    return { ok: true, skip: true, value: null };
  }

  // Reject top-level client money.
  const topMoney = rejectClientMoneyFields(raw, 'accommodation');
  if (topMoney) return topMoney;

  // Multi-stay collection.
  if (Array.isArray(raw.stays)) {
    if (!raw.stays.length) return { ok: true, skip: true, value: null };
    if (raw.stays.length > MAX_STAYS) {
      return {
        ok: false,
        error: `accommodation stays max ${MAX_STAYS}`,
        reason_code: 'accommodation_stays_too_many',
      };
    }
    const stays = [];
    for (let i = 0; i < raw.stays.length; i += 1) {
      const one = normalizeAccommodationStay(raw.stays[i], i);
      if (!one.ok) return one;
      stays.push(one.value);
    }
    const overlap = findOverlappingAccommodationStays(stays);
    if (overlap) {
      return {
        ok: false,
        error: overlap.error,
        reason_code: overlap.reason_code,
        overlap: {
          a: { check_in: overlap.a.check_in, check_out: overlap.a.check_out },
          b: { check_in: overlap.b.check_in, check_out: overlap.b.check_out },
        },
      };
    }
    return { ok: true, skip: false, value: buildAccommodationSelectionValue(stays) };
  }

  // Singular: presence of check_in/check_out without enabled:false means selected.
  const enabled = raw.enabled === true || raw.enabled === 'true' || raw.enabled === 1
    || (raw.check_in != null && raw.check_out != null);
  if (!enabled) return { ok: true, skip: true, value: null };

  const one = normalizeAccommodationStay(raw, null);
  if (!one.ok) return one;
  return { ok: true, skip: false, value: buildAccommodationSelectionValue([one.value]) };
}

/**
 * Deterministic fingerprint for quote/intent equality.
 * Always multi-stay shape so singular + one-element collection compare equal.
 */
function accommodationForIntentFingerprint(sel) {
  if (sel == null || sel === false || sel === '') return null;
  // Accept already-normalized or raw wire; never throw on bad input for fingerprint.
  let stays = [];
  if (sel && typeof sel === 'object') {
    if (sel.enabled === false) return null;
    stays = accommodationStaysFromSelection(sel);
    if (!stays.length && (sel.check_in || (Array.isArray(sel.stays) && sel.stays.length))) {
      const norm = normalizeAccommodationSelection(sel);
      if (!norm.ok || norm.skip || !norm.value) return null;
      stays = accommodationStaysFromSelection(norm.value);
    }
  }
  if (!stays.length) return null;
  const ordered = sortAccommodationStays(stays).map((s) => ({
    check_in: String(s.check_in || '').slice(0, 10),
    check_out: String(s.check_out || '').slice(0, 10),
  }));
  return { enabled: true, stays: ordered };
}

/**
 * Seed Create/Edit accommodation stay from main booking date range.
 * Half-open: multi-day uses date_to as exclusive checkout; same-day (or
 * inverted/missing checkout) becomes a valid one-night stay (check_out = +1 day).
 * Timezone-safe via UTC ISO day arithmetic (addDaysIso).
 */
function defaultAccommodationStayFromBookingDates(dateFrom, dateTo) {
  const checkIn = String(dateFrom != null ? dateFrom : '').trim().slice(0, 10);
  let checkOut = String(
    dateTo != null && String(dateTo).trim() !== '' ? dateTo : dateFrom || '',
  ).trim().slice(0, 10);
  if (!checkIn || !isIsoDate(checkIn)) {
    return { enabled: true, check_in: checkIn, check_out: checkOut };
  }
  if (!checkOut || !isIsoDate(checkOut) || compareIso(checkOut, checkIn) <= 0) {
    checkOut = addDaysIso(checkIn, 1);
  }
  return { enabled: true, check_in: checkIn, check_out: checkOut };
}

function isStaffAccommodationMeta(meta) {
  if (!meta || typeof meta !== 'object') return false;
  return meta.source === STAFF_ACCOMMODATION_SOURCE
    || meta.staff_accommodation === true
    || meta.component === STAFF_ACCOMMODATION_COMPONENT;
}

function buildAccommodationQuoteLine(priced, currency, stayIdentity) {
  const cur = currency || priced.currency || 'EUR';
  const groups = Array.isArray(priced.season_groups) ? priced.season_groups : [];
  const label = groups.length === 1
    ? `Accommodation · ${groups[0].title} · ${priced.nights} night${priced.nights === 1 ? '' : 's'}`
    : `Accommodation · ${priced.nights} night${priced.nights === 1 ? '' : 's'}`;
  const clientStayId = stayIdentity && stayIdentity.client_stay_id
    ? String(stayIdentity.client_stay_id).trim().slice(0, MAX_CLIENT_STAY_ID)
    : (priced.client_stay_id ? String(priced.client_stay_id).trim().slice(0, MAX_CLIENT_STAY_ID) : null);
  return {
    component: STAFF_ACCOMMODATION_COMPONENT,
    offering_id: STAFF_ACCOMMODATION_COMPONENT,
    offering_item_code: STAFF_ACCOMMODATION_COMPONENT,
    label,
    quantity: 1,
    unit_amount_cents: priced.total_cents,
    total_cents: priced.total_cents,
    currency: cur,
    price_source: STAFF_ACCOMMODATION_SOURCE,
    billing_unit: 'stay',
    billing_mode: 'staff_accommodation',
    client_stay_id: clientStayId || null,
    check_in: priced.check_in,
    check_out: priced.check_out,
    nights: priced.nights,
    season_groups: groups,
    nightly_breakdown: priced.nightly_breakdown,
    staff_accommodation: true,
  };
}

function formatAccommodationBookingCard(meta, amountDueCents) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const checkIn = String(m.check_in || '').slice(0, 10);
  const checkOut = String(m.check_out || '').slice(0, 10);
  const nights = Number(m.nights) || (Array.isArray(m.occupied_nights) ? m.occupied_nights.length : 0);
  const total = m.total_cents != null
    ? Number(m.total_cents)
    : (m.amount_cents != null ? Number(m.amount_cents) : Number(amountDueCents) || 0);
  const groups = Array.isArray(m.season_groups) ? m.season_groups : [];
  const breakdownLines = groups.map((g) => ({
    title: String(g.title || ''),
    nights: Number(g.nights) || 0,
    nightly_cents: Number(g.nightly_cents) || 0,
    subtotal_cents: Number(g.subtotal_cents) || 0,
    check_in: String(g.check_in || g.first_night || '').slice(0, 10),
    check_out: String(g.check_out || '').slice(0, 10),
  }));
  return {
    kind: 'staff_accommodation',
    label: 'Accommodation',
    client_stay_id: m.client_stay_id ? String(m.client_stay_id) : null,
    check_in: checkIn,
    check_out: checkOut,
    nights,
    season_groups: breakdownLines,
    total_cents: Number.isSafeInteger(total) ? total : 0,
    currency: String(m.currency || 'EUR').toUpperCase() || 'EUR',
  };
}

module.exports = {
  ISO_DATE_RE,
  MAX_TITLE,
  MAX_RANGES,
  MAX_AMOUNT_CENTS,
  MAX_STAY_NIGHTS,
  MAX_STAYS,
  MAX_CLIENT_STAY_ID,
  STAFF_ACCOMMODATION_SOURCE,
  STAFF_ACCOMMODATION_COMPONENT,
  ACCOMMODATION_CLIENT_MONEY_KEYS,
  isIsoDate,
  parseIsoUtc,
  formatIsoUtc,
  addDaysIso,
  compareIso,
  occupiedNights,
  normalizeAccommodationRanges,
  rangeCoversNight,
  findCoveringRange,
  formatUncoveredSpan,
  uncoveredErrorMessage,
  priceAccommodationStay,
  defaultAccommodationStayFromBookingDates,
  normalizeAccommodationStay,
  findOverlappingAccommodationStays,
  sortAccommodationStays,
  buildAccommodationSelectionValue,
  accommodationStaysFromSelection,
  normalizeAccommodationSelection,
  accommodationForIntentFingerprint,
  isStaffAccommodationMeta,
  buildAccommodationQuoteLine,
  formatAccommodationBookingCard,
};
