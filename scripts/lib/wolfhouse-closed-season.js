'use strict';

/**
 * Closed-season gate for Wolfhouse availability.
 * Staff Pricing seasons (wh_pricing_seasons + ranges) are the only truth.
 * No hard-coded months.
 */

const { resolveSeasonForDate } = require('./wolfhouse-pricing-resolve');
const { buildBotClosedSeasonReply } = require('./bot-guest-safe-copy');

const MS_DAY = 86400000;

function madridTodayIso(now) {
  const d = now instanceof Date ? now : (now ? new Date(now) : new Date());
  if (Number.isNaN(d.getTime())) return madridTodayIso(new Date());
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function parseIso(iso) {
  const text = String(iso || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const d = new Date(text + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

function addDaysIso(iso, days) {
  const d = parseIso(iso);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

function nightsBetween(checkIn, checkOut) {
  const a = parseIso(checkIn);
  const b = parseIso(checkOut);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / MS_DAY);
}

function eachStayNight(checkIn, checkOut, fn) {
  const nights = nightsBetween(checkIn, checkOut);
  for (let i = 0; i < nights; i += 1) {
    const iso = addDaysIso(checkIn, i);
    if (fn(iso) === false) return false;
  }
  return true;
}

function stayHitsClosedSeason(seasons, checkIn, checkOut) {
  if (!Array.isArray(seasons) || !seasons.length) return false;
  if (nightsBetween(checkIn, checkOut) < 1) return false;
  let hit = false;
  eachStayNight(checkIn, checkOut, (iso) => {
    const season = resolveSeasonForDate(seasons, iso);
    if (season && season.bookable === false) {
      hit = true;
      return false;
    }
    return true;
  });
  return hit;
}

function stayFullyBookable(seasons, checkIn, checkOut) {
  if (!Array.isArray(seasons) || !seasons.length) return false;
  if (nightsBetween(checkIn, checkOut) < 1) return false;
  let ok = true;
  eachStayNight(checkIn, checkOut, (iso) => {
    const season = resolveSeasonForDate(seasons, iso);
    if (!season || season.bookable === false) {
      ok = false;
      return false;
    }
    return true;
  });
  return ok;
}

function findNearestOpenStay(seasons, checkIn, checkOut, todayIso) {
  const nights = nightsBetween(checkIn, checkOut);
  if (nights < 1 || !Array.isArray(seasons) || !seasons.length) return null;
  const today = String(todayIso || madridTodayIso());
  let best = null;
  for (let delta = -400; delta <= 400; delta += 1) {
    const nci = addDaysIso(checkIn, delta);
    const nco = addDaysIso(nci, nights);
    if (!nci || nci < today) continue;
    if (!stayFullyBookable(seasons, nci, nco)) continue;
    const score = Math.abs(delta);
    if (
      !best
      || score < best.score
      || (score === best.score && delta > 0 && best.delta < 0)
    ) {
      best = { check_in: nci, check_out: nco, score, delta };
    }
  }
  return best ? { check_in: best.check_in, check_out: best.check_out } : null;
}

function closedSeasonGuestCopy(language, nearestOpenDates) {
  return buildBotClosedSeasonReply({ language, nearest_open_dates: nearestOpenDates }).guest_safe_next_action;
}

function evaluateClosedSeasonStay(seasons, checkIn, checkOut, language, todayIso) {
  const closed = stayHitsClosedSeason(seasons, checkIn, checkOut);
  if (!closed) {
    return {
      closed_season: false,
      date_rule_ok: true,
      next_action: null,
      guest_safe_next_action: null,
      nearest_open_dates: null,
      selected_bed_codes: [],
    };
  }
  const nearestOpenDates = findNearestOpenStay(seasons, checkIn, checkOut, todayIso);
  return {
    closed_season: true,
    date_rule_ok: false,
    next_action: 'closed_season',
    guest_safe_next_action: closedSeasonGuestCopy(language, nearestOpenDates),
    nearest_open_dates: nearestOpenDates,
    selected_bed_codes: [],
  };
}

async function loadClosedSeasonCatalog(pg, clientSlug) {
  if (String(clientSlug || '').trim() !== 'wolfhouse-somo') return [];
  if (!pg || typeof pg.query !== 'function') return [];
  try {
    const { loadSeasons } = require('./wolfhouse-pricing-store');
    const rows = await loadSeasons(pg, clientSlug);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    if (err && (err.code === '42P01' || /tenant_scope_violation/.test(String(err.message || '')))) {
      return [];
    }
    throw err;
  }
}

async function evaluateClosedSeason(pg, opts) {
  opts = opts || {};
  const seasons = await loadClosedSeasonCatalog(pg, opts.clientSlug);
  return evaluateClosedSeasonStay(seasons, opts.checkIn, opts.checkOut, opts.language, opts.todayIso || madridTodayIso());
}

module.exports = {
  madridTodayIso,
  stayHitsClosedSeason,
  stayFullyBookable,
  findNearestOpenStay,
  closedSeasonGuestCopy,
  evaluateClosedSeasonStay,
  loadClosedSeasonCatalog,
  evaluateClosedSeason,
};
