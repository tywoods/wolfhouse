'use strict';

/**
 * Wolfhouse Admin Pricing — season resolution and DB-over-config precedence.
 *
 * Pure functions only: no DB, no network, no fs beyond reading the pricing
 * fixture. The Admin API and (from phase 5) the quote calculator both resolve
 * prices through here so a staff edit and a guest quote can never disagree.
 *
 * Precedence is DB row first, JSON seed second. An empty overlay therefore
 * behaves exactly like today's config-only Wolfhouse.
 *
 * @module wolfhouse-pricing-resolve
 */

const fs = require('fs');
const path = require('path');

const WH_PRICING_CLIENT_SLUG = 'wolfhouse-somo';

const PRICING_CONFIG_PATH = path.join(
  __dirname, '..', '..', 'config', 'clients', 'wolfhouse-somo.pricing.json',
);

/** Add-on codes that are gear rentals; everything else in add_ons is a service. */
const CONFIG_RENTAL_ADDON_CODES = new Set([
  'wetsuit_rental',
  'soft_top_rental',
  'hard_board_rental',
  'wetsuit_soft_top_combo',
  'wetsuit_hard_board_combo',
]);

/** Default duration suffix for config-seeded rentals, which are all per-day. */
const DEFAULT_RENTAL_DURATION = '1_day';

const MONTH_LENGTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(month) {
  const m = Number(month);
  if (!Number.isInteger(m) || m < 1 || m > 12) return 0;
  return MONTH_LENGTHS[m - 1];
}

/** Ordinal position of a day within a non-leap-agnostic year, for range compares. */
function monthDayOrdinal(month, day) {
  return Number(month) * 100 + Number(day);
}

/**
 * True when a recurring day/month window covers the given month/day.
 * A window whose end sorts before its start wraps the year boundary, so
 * Nov 1 -> Feb 28 covers December and January.
 */
function seasonRangeCoversMonthDay(range, month, day) {
  if (!range) return false;
  const start = monthDayOrdinal(range.start_month, range.start_day);
  const end = monthDayOrdinal(range.end_month, range.end_day);
  const probe = monthDayOrdinal(month, day);
  if (start <= end) return probe >= start && probe <= end;
  return probe >= start || probe <= end;
}

function parseIsoDateParts(isoDate) {
  const text = String(isoDate || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return { year: Number(m[1]), month, day };
}

function seasonCoversDate(season, isoDate) {
  const parts = parseIsoDateParts(isoDate);
  if (!parts || !season || !Array.isArray(season.ranges)) return false;
  return season.ranges.some((r) => seasonRangeCoversMonthDay(r, parts.month, parts.day));
}

/**
 * Resolve which season owns a date. Highest priority wins; ties break on the
 * lower sort_order then the season code so the result is deterministic.
 *
 * Returns null when no season covers the date — the caller must then block and
 * hand off rather than fall back to any price.
 *
 * @param {object[]} seasons
 * @param {string} isoDate YYYY-MM-DD
 * @returns {object|null}
 */
function resolveSeasonForDate(seasons, isoDate) {
  if (!Array.isArray(seasons)) return null;
  const matches = seasons
    .filter((s) => s && s.active !== false && seasonCoversDate(s, isoDate));
  if (!matches.length) return null;
  matches.sort((a, b) => {
    const pa = Number(a.priority) || 0;
    const pb = Number(b.priority) || 0;
    if (pa !== pb) return pb - pa;
    const sa = Number(a.sort_order) || 0;
    const sb = Number(b.sort_order) || 0;
    if (sa !== sb) return sa - sb;
    return String(a.code).localeCompare(String(b.code));
  });
  return matches[0];
}

function loadPricingConfig() {
  return JSON.parse(fs.readFileSync(PRICING_CONFIG_PATH, 'utf8'));
}

/**
 * Convert the JSON seed's month-number seasons into recurring day/month ranges.
 * Consecutive months are not merged; one range per month keeps the mapping
 * obvious when an operator opens the season editor for the first time.
 */
function configSeasons(config) {
  const seasons = Array.isArray(config && config.seasons) ? config.seasons : [];
  return seasons.map((s, idx) => ({
    code: String(s.code),
    label: String(s.label || s.code),
    priority: Number(s.priority) || 0,
    bookable: s.bookable !== false,
    active: true,
    sort_order: idx,
    source: 'config',
    ranges: (Array.isArray(s.month_numbers) ? s.month_numbers : []).map((m) => ({
      start_month: Number(m),
      start_day: 1,
      end_month: Number(m),
      end_day: daysInMonth(m),
    })),
  }));
}

function rule(itemType, itemCode, seasonCode, unit, amountCents, extra) {
  return Object.assign({
    item_type: itemType,
    item_code: itemCode,
    season_code: seasonCode == null ? null : String(seasonCode),
    unit,
    amount_cents: Number(amountCents),
    currency: 'EUR',
    active: true,
    source: 'config',
  }, extra || {});
}

/** Flatten packages, supplements, deposits and add-ons into canonical rule rows. */
function configPricingRules(config) {
  const out = [];
  if (!config) return out;

  for (const pkg of (Array.isArray(config.packages) ? config.packages : [])) {
    const seasonal = pkg.seasonal_prices || {};
    for (const seasonCode of Object.keys(seasonal)) {
      const cents = seasonal[seasonCode] && seasonal[seasonCode].weekly_per_person_cents;
      if (!Number.isFinite(Number(cents))) continue;
      out.push(rule('package', pkg.code, seasonCode, 'per_person_per_week', cents, {
        label: pkg.name || pkg.code,
      }));
    }
  }

  const supplements = config.room_supplements || {};
  for (const roomType of Object.keys(supplements)) {
    if (roomType.startsWith('_')) continue;
    const supplement = supplements[roomType] || {};
    // Per-room is the charged form for double/private; shared carries only the
    // per-person key at zero. Keep shared in the catalog so Admin can show all
    // three room types instead of silently omitting the free one.
    const perRoom = supplement.per_room_per_night_cents;
    const perPerson = supplement.per_person_per_night_cents;
    if (Number.isFinite(Number(perRoom))) {
      out.push(rule('supplement', roomType, null, 'per_room_per_night', perRoom, {
        label: roomType,
      }));
    } else if (Number.isFinite(Number(perPerson))) {
      out.push(rule('supplement', roomType, null, 'per_person_per_night', perPerson, {
        label: roomType,
      }));
    }
  }

  const tiers = (config.deposits && config.deposits.tiers) || {};
  for (const tier of Object.keys(tiers)) {
    if (tier.startsWith('_')) continue;
    const cents = tiers[tier] && tiers[tier].amount_cents;
    if (!Number.isFinite(Number(cents))) continue;
    out.push(rule('deposit', tier, null, 'per_booking', cents, { label: tier }));
  }

  const addOns = config.add_ons || {};
  const seenServiceCodes = new Set();
  for (const code of Object.keys(addOns)) {
    if (code.startsWith('_')) continue;
    const addon = addOns[code] || {};
    const cents = Number.isFinite(Number(addon.price_cents))
      ? addon.price_cents
      : addon.price_cents_each;
    if (!Number.isFinite(Number(cents))) continue;

    if (CONFIG_RENTAL_ADDON_CODES.has(code)) {
      out.push(rule('rental', `${code}__${DEFAULT_RENTAL_DURATION}`, null, 'per_day', cents, {
        label: addon.name || code,
      }));
      continue;
    }
    // `meal` and `meals` are the same product duplicated in the fixture.
    const serviceCode = code === 'meals' ? 'meal' : code;
    if (seenServiceCodes.has(serviceCode)) continue;
    seenServiceCodes.add(serviceCode);
    out.push(rule('service', serviceCode, null, configServiceUnit(addon), cents, {
      label: addon.name || serviceCode,
    }));
  }

  return out;
}

function configServiceUnit(addon) {
  switch (String(addon && addon.pricing_unit || '').trim()) {
    case 'per_lesson': return 'per_lesson';
    case 'per_class': return 'per_class';
    case 'per_meal': return 'per_meal';
    case 'per_day': return 'per_day';
    default: return 'per_stay';
  }
}

/** Flatten the hardcoded transfer config into rule rows plus eligibility rows. */
function configTransferRules(transferConfig) {
  const rules = [];
  const eligibility = [];
  const airports = (transferConfig && transferConfig.airports) || [];
  const airportByCode = new Map(airports.map((a) => [a.code, a]));

  for (const r of ((transferConfig && transferConfig.rules) || [])) {
    const airport = airportByCode.get(r.airport_code) || {};
    eligibility.push({
      airport_code: r.airport_code,
      label: airport.label || r.airport_code,
      aliases: Array.isArray(airport.aliases) ? airport.aliases.slice() : [],
      requires_package: !!r.requires_package,
      included_when_package: !!r.included_when_package,
      min_guest_count: r.min_guest_count == null ? null : Number(r.min_guest_count),
      unavailable_no_package_message: r.unavailable_no_package_message || null,
      unavailable_below_min_group_message: r.unavailable_below_min_group_message || null,
      active: true,
      source: 'config',
    });
    // Explicit null checks: Number(null) is 0, so isFinite alone would read an
    // absent flat fare as a free transfer and never reach the per-person rate.
    if (r.flat_price_cents != null && Number.isFinite(Number(r.flat_price_cents))) {
      rules.push(rule('transfer', r.airport_code, null, 'flat', r.flat_price_cents, {
        label: airport.label || r.airport_code,
      }));
    } else if (r.per_person_extra_cents != null
      && Number.isFinite(Number(r.per_person_extra_cents))) {
      rules.push(rule('transfer', r.airport_code, null, 'per_person', r.per_person_extra_cents, {
        label: airport.label || r.airport_code,
      }));
    }
  }
  return { rules, eligibility };
}

function ruleKey(r) {
  return [r.item_type, r.item_code, r.season_code == null ? '' : r.season_code].join('\u0000');
}

/**
 * DB rows win over config seeds on identical (item_type, item_code, season_code).
 * Config rows with no DB counterpart survive, so a partially populated overlay
 * never blanks out the rest of the catalog.
 */
function mergePricingRules(configRules, dbRules) {
  const merged = new Map();
  for (const r of (Array.isArray(configRules) ? configRules : [])) {
    merged.set(ruleKey(r), Object.assign({}, r, { source: 'config' }));
  }
  for (const r of (Array.isArray(dbRules) ? dbRules : [])) {
    if (r && r.active === false) {
      merged.delete(ruleKey(r));
      continue;
    }
    merged.set(ruleKey(r), Object.assign({}, r, { source: 'db' }));
  }
  return Array.from(merged.values());
}

/** Same precedence for seasons: a DB season replaces the config season of that code. */
function mergeSeasons(configSeasonList, dbSeasonList) {
  const merged = new Map();
  for (const s of (Array.isArray(configSeasonList) ? configSeasonList : [])) {
    merged.set(String(s.code), Object.assign({}, s, { source: 'config' }));
  }
  for (const s of (Array.isArray(dbSeasonList) ? dbSeasonList : [])) {
    if (!s) continue;
    if (s.active === false) {
      merged.delete(String(s.code));
      continue;
    }
    merged.set(String(s.code), Object.assign({}, s, { source: 'db' }));
  }
  return Array.from(merged.values());
}

/**
 * Look up one price. Season-specific rows win over season-agnostic ones so a
 * package can be priced per season while a wetsuit stays flat all year.
 */
function lookupRule(rules, query) {
  if (!Array.isArray(rules) || !query) return null;
  const itemType = String(query.item_type || '');
  const itemCode = String(query.item_code || '');
  const seasonCode = query.season_code == null ? null : String(query.season_code);
  let fallback = null;
  for (const r of rules) {
    if (r.item_type !== itemType || r.item_code !== itemCode) continue;
    if (r.active === false) continue;
    if (seasonCode != null && r.season_code === seasonCode) return r;
    if (r.season_code == null) fallback = r;
  }
  return fallback;
}

/**
 * Resolve a package price for a check-in date.
 * Returns a blocked result rather than a price when the date falls outside every
 * season or lands in a season marked not bookable.
 */
function resolvePackagePriceForDate(ctx) {
  const { seasons, rules, packageCode, checkInDate } = ctx || {};
  const season = resolveSeasonForDate(seasons, checkInDate);
  if (!season) {
    return { ok: false, reason: 'no_season_for_date', date: checkInDate || null };
  }
  if (season.bookable === false) {
    return { ok: false, reason: 'season_not_bookable', season_code: season.code };
  }
  const found = lookupRule(rules, {
    item_type: 'package',
    item_code: packageCode,
    season_code: season.code,
  });
  if (!found) {
    return { ok: false, reason: 'no_price_for_season', season_code: season.code };
  }
  return {
    ok: true,
    season_code: season.code,
    amount_cents: found.amount_cents,
    currency: found.currency || 'EUR',
    unit: found.unit,
    source: found.source,
  };
}

/** Split a rental rule code such as `wetsuit_rental__1_day` into its two parts. */
function splitRentalCode(itemCode) {
  const text = String(itemCode || '');
  const idx = text.indexOf('__');
  if (idx === -1) return { offering: text, duration: null };
  return { offering: text.slice(0, idx), duration: text.slice(idx + 2) };
}

function priceOf(r) {
  return r ? {
    amount_cents: r.amount_cents,
    currency: r.currency || 'EUR',
    unit: r.unit,
    source: r.source || 'config',
  } : null;
}

/**
 * Assemble the payload the Admin Pricing portal renders, already merged.
 *
 * Every price carries a `source` of 'db' or 'config' so the UI can show which
 * numbers staff have customised and which are still the shipped defaults. Codes
 * are unioned across the config seed, the DB catalog and the DB prices, so an
 * item created by staff and an item shipped in JSON both appear.
 */
function buildAdminPricingView(input) {
  const {
    config, transferConfig, dbSeasons, dbRules, dbItems, dbTransferRules, writesEnabled,
  } = input || {};

  const seasons = mergeSeasons(configSeasons(config), dbSeasons);
  const seedTransfers = configTransferRules(transferConfig);
  const rules = mergePricingRules(
    configPricingRules(config).concat(seedTransfers.rules),
    dbRules,
  );
  const items = Array.isArray(dbItems) ? dbItems : [];

  const labels = new Map();
  for (const r of rules) if (r.label) labels.set(`${r.item_type}:${r.item_code}`, r.label);
  for (const it of items) labels.set(`${it.item_type}:${it.item_code}`, it.label);
  const labelFor = (type, code, fallback) => labels.get(`${type}:${code}`) || fallback || code;

  const codesFor = (type, extra) => {
    const set = new Set(extra || []);
    for (const it of items) if (it.item_type === type) set.add(it.item_code);
    for (const r of rules) {
      if (r.item_type !== type) continue;
      set.add(type === 'rental' ? splitRentalCode(r.item_code).offering : r.item_code);
    }
    return Array.from(set);
  };

  const packages = codesFor('package',
    (Array.isArray(config && config.packages) ? config.packages : []).map((p) => p.code),
  ).map((code) => ({
    code,
    label: labelFor('package', code),
    prices: seasons.map((s) => ({
      season_code: s.code,
      season_label: s.label,
      bookable: s.bookable !== false,
      price: priceOf(lookupRule(rules, {
        item_type: 'package', item_code: code, season_code: s.code,
      })),
    })),
  }));

  const rentals = codesFor('rental').map((offering) => ({
    code: offering,
    label: labelFor('rental', offering),
    durations: rules
      .filter((r) => r.item_type === 'rental' && splitRentalCode(r.item_code).offering === offering)
      .map((r) => Object.assign(
        { duration: splitRentalCode(r.item_code).duration, item_code: r.item_code },
        priceOf(r),
      )),
  }));

  const services = codesFor('service').map((code) => {
    const found = lookupRule(rules, { item_type: 'service', item_code: code });
    const item = items.find((it) => it.item_type === 'service' && it.item_code === code);
    return {
      code,
      label: labelFor('service', code),
      metadata: (item && item.metadata) || {},
      price: priceOf(found),
    };
  });

  const transferEligibility = new Map();
  for (const e of seedTransfers.eligibility) transferEligibility.set(e.airport_code, e);
  for (const e of (Array.isArray(dbTransferRules) ? dbTransferRules : [])) {
    transferEligibility.set(e.airport_code, Object.assign({}, e, { source: 'db' }));
  }
  const transfers = Array.from(transferEligibility.values()).map((e) => Object.assign({}, e, {
    price: priceOf(lookupRule(rules, { item_type: 'transfer', item_code: e.airport_code })),
  }));

  const extrasOf = (type) => rules
    .filter((r) => r.item_type === type)
    .map((r) => Object.assign({ code: r.item_code, label: labelFor(type, r.item_code) }, priceOf(r)));

  return {
    client_slug: WH_PRICING_CLIENT_SLUG,
    currency: (config && config.currency) || 'EUR',
    writes_enabled: !!writesEnabled,
    seasons: seasons.map((s) => ({
      code: s.code,
      label: s.label,
      priority: Number(s.priority) || 0,
      bookable: s.bookable !== false,
      ranges: Array.isArray(s.ranges) ? s.ranges : [],
      source: s.source || 'config',
    })),
    packages,
    rentals,
    services,
    transfers,
    extras: {
      deposits: extrasOf('deposit'),
      supplements: extrasOf('supplement'),
      addons: extrasOf('addon'),
    },
  };
}

module.exports = {
  WH_PRICING_CLIENT_SLUG,
  splitRentalCode,
  buildAdminPricingView,
  PRICING_CONFIG_PATH,
  CONFIG_RENTAL_ADDON_CODES,
  DEFAULT_RENTAL_DURATION,
  daysInMonth,
  monthDayOrdinal,
  seasonRangeCoversMonthDay,
  parseIsoDateParts,
  seasonCoversDate,
  resolveSeasonForDate,
  loadPricingConfig,
  configSeasons,
  configPricingRules,
  configTransferRules,
  mergePricingRules,
  mergeSeasons,
  lookupRule,
  resolvePackagePriceForDate,
};
