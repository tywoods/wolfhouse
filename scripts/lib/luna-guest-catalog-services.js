'use strict';

/**
 * Luna guest catalog-services knowledge engine (Wolfhouse v3).
 *
 * Pure helpers — no DB, no GPT — so they unit-test offline. The pipeline passes in the
 * luna_visible tenant_services rows (loaded via tenant-services-writes.listServices) plus
 * the guest's tentative dates; this module decides:
 *   - which catalog service a guest message is about (keyword/name match), and
 *   - whether the guest's dates fall within the service's "camp" window, and
 *   - the grounded, composer-owned reply copy (what it is, running dates, extra cost).
 *
 * Behaviour spec: facts come from the catalog row only (name, notes_for_luna, start/end,
 * price). Cami may warm the wording but never invent prices/dates. See
 * docs/LUNA-GUEST-BEHAVIOR-SPEC.md.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateOnly(v) {
  if (!v) return null;
  // pg returns DATE columns as Date objects (UTC midnight); strings come from ::text casts.
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return DATE_RE.test(s) ? s : null;
}

function normalizeText(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Does `needle` (a catalog keyword / service name) appear as a whole token-run in `haystack`?
 * Both are normalized (lowercased, punctuation stripped) so "Jiu-Jitsu" matches "jiu jitsu".
 */
function phraseMatches(haystack, needle) {
  const h = normalizeText(haystack);
  const n = normalizeText(needle);
  if (!h || !n) return false;
  return (' ' + h + ' ').indexOf(' ' + n + ' ') !== -1;
}

/**
 * Find catalog services a guest message is about. Only luna_visible + active services are
 * eligible. Matches against each service's keywords first, then its name.
 * @returns {Array} matched service rows (best-effort order: keyword hits before name hits)
 */
function matchCatalogServices(messageText, services) {
  const text = String(messageText || '');
  if (!text.trim() || !Array.isArray(services)) return [];
  const byKeyword = [];
  const byName = [];
  for (const svc of services) {
    if (!svc || svc.active === false || svc.luna_visible === false) continue;
    const kws = Array.isArray(svc.keywords) ? svc.keywords : [];
    if (kws.some((kw) => phraseMatches(text, kw))) { byKeyword.push(svc); continue; }
    if (svc.name && phraseMatches(text, svc.name)) byName.push(svc);
  }
  return byKeyword.concat(byName);
}

function formatCampDates(startRaw, endRaw) {
  const start = dateOnly(startRaw);
  const end = dateOnly(endRaw);
  const fmt = (s) => {
    const [y, m, d] = s.split('-');
    return { day: String(Number(d)), mon: MONTHS[Number(m) - 1], year: y, m, y };
  };
  if (start && end) {
    const a = fmt(start);
    const b = fmt(end);
    if (a.m === b.m && a.y === b.y) return `${a.day}–${b.day} ${b.mon} ${b.year}`;
    if (a.y === b.y) return `${a.day} ${a.mon} – ${b.day} ${b.mon} ${b.year}`;
    return `${a.day} ${a.mon} ${a.year} – ${b.day} ${b.mon} ${b.year}`;
  }
  if (start) { const a = fmt(start); return `from ${a.day} ${a.mon} ${a.year}`; }
  if (end) { const b = fmt(end); return `until ${b.day} ${b.mon} ${b.year}`; }
  return null;
}

function formatPrice(priceCents, priceUnit, perGuest) {
  const eur = '€' + (Number(priceCents || 0) / 100).toFixed(2).replace(/\.00$/, '');
  const unit = priceUnit === 'per_day' ? '/day' : (priceUnit === 'per_stay' ? '/stay' : '');
  const per = perGuest === false ? '' : ' per guest';
  return `${eur}${unit}${per}`;
}

/**
 * Does the stay [checkIn, checkOut) let the guest attend a camp running [start, end] (nights)?
 * @returns {boolean|null} null when dates are unknown (can't decide); true when no window.
 */
function staysOverlapWindow(checkIn, checkOut, startRaw, endRaw) {
  const ci = dateOnly(checkIn);
  const co = dateOnly(checkOut);
  if (!ci || !co) return null;
  const start = dateOnly(startRaw);
  const end = dateOnly(endRaw);
  if (!start && !end) return true; // no window → always available
  const startsBeforeCampEnds = !end || ci <= end;      // arrives on/before the last camp night
  const endsAfterCampStarts = !start || co > start;     // leaves after the first camp night
  return startsBeforeCampEnds && endsAfterCampStarts;
}

/**
 * Build the grounded reply for a catalog-service inquiry. Composer-owned truth copy.
 * @param {object} service tenant_services row
 * @param {object} ctx { checkIn, checkOut, guestCount }
 * @returns {object} { matched, service_id, service_name, within_window, needs_date_shift, text, facts }
 */
function buildCatalogServiceReply(service, ctx) {
  const svc = service || {};
  const c = ctx || {};
  const name = svc.name || 'this experience';
  const dates = formatCampDates(svc.start_date, svc.end_date);
  const price = formatPrice(svc.price_cents, svc.price_unit, svc.per_guest);
  const notes = svc.notes_for_luna ? String(svc.notes_for_luna).trim() : '';
  const hasWindow = !!(dateOnly(svc.start_date) || dateOnly(svc.end_date));
  const within = staysOverlapWindow(c.checkIn, c.checkOut, svc.start_date, svc.end_date);
  const needsDateShift = hasWindow && within === false;
  const guestCount = Number(c.guestCount) || null;
  const groupPhrase = guestCount ? `all ${guestCount} guest${guestCount === 1 ? '' : 's'}` : 'your group';

  let text = '';
  if (dates) text = `Yes — we run a ${name} camp ${dates}.`;
  else text = `Yes — we offer ${name}.`;
  if (notes) text += ` ${notes}`;
  text += ` It's ${price}.`;

  if (needsDateShift) {
    const stay = formatCampDates(c.checkIn, c.checkOut);
    text += stay
      ? ` Your dates (${stay}) fall outside the camp — want me to move your stay to ${dates} so you can join, and add it for ${groupPhrase}?`
      : ` Your dates fall outside the camp — want me to move your stay to ${dates} so you can join, and add it for ${groupPhrase}?`;
  } else {
    text += ` Want me to add it for ${groupPhrase}?`;
  }

  return {
    matched: true,
    service_id: svc.id || null,
    service_name: name,
    within_window: within,
    needs_date_shift: needsDateShift,
    text,
    facts: {
      name,
      dates,
      price,
      notes,
      start_date: dateOnly(svc.start_date),
      end_date: dateOnly(svc.end_date),
      price_cents: svc.price_cents != null ? Number(svc.price_cents) : null,
      price_unit: svc.price_unit || null,
      per_guest: svc.per_guest !== false,
    },
  };
}

module.exports = {
  matchCatalogServices,
  buildCatalogServiceReply,
  staysOverlapWindow,
  formatCampDates,
  formatPrice,
  phraseMatches,
};
