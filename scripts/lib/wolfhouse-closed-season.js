'use strict';

/** Staff Pricing seasons are the only open/closed truth. */
const { resolveSeasonForDate } = require('./wolfhouse-pricing-resolve');
const { buildBotClosedSeasonReply } = require('./bot-guest-safe-copy');
const MS_DAY = 86400000;

function madridTodayIso(now) {
  const d = now instanceof Date ? now : (now ? new Date(now) : new Date());
  if (Number.isNaN(d.getTime())) return madridTodayIso(new Date());
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function parseIso(iso) {
  const text = String(iso || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const d = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function toIso(date) { return date.toISOString().slice(0, 10); }
function addDaysIso(iso, days) {
  const d = parseIso(iso); if (!d) return null;
  d.setUTCDate(d.getUTCDate() + days); return toIso(d);
}
function nightsBetween(checkIn, checkOut) {
  const a = parseIso(checkIn); const b = parseIso(checkOut);
  return a && b ? Math.round((b.getTime() - a.getTime()) / MS_DAY) : 0;
}
function eachStayNight(checkIn, checkOut, fn) {
  const nights = nightsBetween(checkIn, checkOut);
  for (let i = 0; i < nights; i += 1) if (fn(addDaysIso(checkIn, i)) === false) return false;
  return true;
}
function analyzeClosedSeasonStay(seasons, checkIn, checkOut) {
  const closedNights = []; const openNights = [];
  eachStayNight(checkIn, checkOut, (iso) => {
    const season = resolveSeasonForDate(seasons, iso);
    (season && season.bookable === false ? closedNights : openNights).push(iso);
    return true;
  });
  const firstClosed = closedNights[0] || null;
  const prefixCheckout = firstClosed && openNights[0] === checkIn ? firstClosed : null;
  return {
    closed_nights: closedNights,
    open_nights: openNights,
    fully_closed: closedNights.length > 0 && openNights.length === 0,
    partial_open_dates: prefixCheckout ? { check_in: checkIn, check_out: prefixCheckout, closed_from: firstClosed } : null,
  };
}
function stayHitsClosedSeason(seasons, checkIn, checkOut) {
  if (!Array.isArray(seasons) || !seasons.length || nightsBetween(checkIn, checkOut) < 1) return false;
  return analyzeClosedSeasonStay(seasons, checkIn, checkOut).closed_nights.length > 0;
}
function stayFullyBookable(seasons, checkIn, checkOut) {
  if (!Array.isArray(seasons) || !seasons.length || nightsBetween(checkIn, checkOut) < 1) return false;
  let ok = true;
  eachStayNight(checkIn, checkOut, (iso) => {
    const season = resolveSeasonForDate(seasons, iso);
    if (!season || season.bookable === false) { ok = false; return false; }
    return true;
  });
  return ok;
}
function findNearestOpenStay(seasons, checkIn, checkOut, todayIso) {
  const nights = nightsBetween(checkIn, checkOut);
  if (nights < 1 || !Array.isArray(seasons) || !seasons.length) return null;
  const today = String(todayIso || madridTodayIso()); let best = null;
  for (let delta = -400; delta <= 400; delta += 1) {
    const nci = addDaysIso(checkIn, delta); const nco = addDaysIso(nci, nights);
    if (!nci || nci < today || !stayFullyBookable(seasons, nci, nco)) continue;
    const score = Math.abs(delta);
    if (!best || score < best.score || (score === best.score && delta > 0 && best.delta < 0)) best = { check_in: nci, check_out: nco, score, delta };
  }
  return best ? { check_in: best.check_in, check_out: best.check_out } : null;
}
function findSeasonReopensOn(seasons, fromIso, todayIso) {
  const start = String(fromIso || '') > String(todayIso || '') ? String(fromIso) : String(todayIso || fromIso || '');
  for (let delta = 0; delta <= 800; delta += 1) {
    const iso = addDaysIso(start, delta); const season = iso && resolveSeasonForDate(seasons, iso);
    if (season && season.bookable !== false) return iso;
  }
  return null;
}
function closedSeasonGuestCopy(language, nearestOpenDates, extra = {}) {
  return buildBotClosedSeasonReply({ language, nearest_open_dates: nearestOpenDates, ...extra }).guest_safe_next_action;
}
function evaluateClosedSeasonStay(seasons, checkIn, checkOut, language, todayIso, opts = {}) {
  if (!stayHitsClosedSeason(seasons, checkIn, checkOut)) return {
    closed_season: false, date_rule_ok: true, next_action: null, guest_safe_next_action: null,
    nearest_open_dates: null, selected_bed_codes: [],
  };
  const analysis = analyzeClosedSeasonStay(seasons, checkIn, checkOut);
  const nearestCandidate = findNearestOpenStay(seasons, checkIn, checkOut, todayIso);
  const nearestOpenDates = opts.capacity_verified === true ? nearestCandidate : null;
  const seasonReopensOn = findSeasonReopensOn(seasons, checkIn, todayIso || madridTodayIso());
  const copyArgs = { season_reopens_on: seasonReopensOn, partial_open_dates: analysis.partial_open_dates };
  return {
    closed_season: true, date_rule_ok: false, next_action: 'closed_season',
    guest_safe_next_action: closedSeasonGuestCopy(language, nearestOpenDates, copyArgs),
    nearest_open_dates: nearestOpenDates, nearest_open_candidate: nearestCandidate,
    season_reopens_on: seasonReopensOn, closed_nights: analysis.closed_nights,
    partial_open_dates: analysis.partial_open_dates, selected_bed_codes: [],
  };
}
async function loadClosedSeasonCatalog(pg, clientSlug) {
  if (String(clientSlug || '').trim() !== 'wolfhouse-somo' || !pg || typeof pg.query !== 'function') return [];
  try {
    const rows = await require('./wolfhouse-pricing-store').loadSeasons(pg, clientSlug);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    if (err && (err.code === '42P01' || /tenant_scope_violation/.test(String(err.message || '')))) return [];
    throw err;
  }
}
async function evaluateClosedSeason(pg, opts = {}) {
  const seasons = await loadClosedSeasonCatalog(pg, opts.clientSlug);
  return evaluateClosedSeasonStay(seasons, opts.checkIn, opts.checkOut, opts.language, opts.todayIso || madridTodayIso(), opts);
}
module.exports = {
  madridTodayIso, stayHitsClosedSeason, stayFullyBookable, analyzeClosedSeasonStay,
  findNearestOpenStay, findSeasonReopensOn, closedSeasonGuestCopy, evaluateClosedSeasonStay,
  loadClosedSeasonCatalog, evaluateClosedSeason,
};
