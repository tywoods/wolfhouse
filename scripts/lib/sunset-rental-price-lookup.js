'use strict';

/**
 * sunset-rental-price-lookup.js
 *
 * Pure Sunset rental price lookup from school-scoped admin config.
 * No DB, no network, no Stripe, no WhatsApp.
 */

const { resolveSunsetAdminConfigForLuna } = require('./sunset-luna-school-context');
const {
  normalizeSunsetLocationId,
  isSunsetLocationId,
  DEFAULT_SUNSET_LOCATION_ID,
} = require('./sunset-school-locations');
const { isSunsetAdminDbReadEnabled } = require('./tenant-business-config');
const locationStore = require('./sunset-admin-location-store');
const { activeRentalOfferingKeySet, isDocumentedActiveFlag } = require('./rental-offering-label');

const EXPECTED_TENANT = 'sunset';

const ITEM_ALIASES = {
  board: 'board_rental',
  surfboard: 'board_rental',
  board_rental: 'board_rental',
  wetsuit: 'wetsuit_rental',
  wetsuit_rental: 'wetsuit_rental',
  board_suit: 'board_and_suit_rental',
  'board+suit': 'board_and_suit_rental',
  'board+suit bundle': 'board_and_suit_rental',
  'board+wetsuit': 'board_and_suit_rental',
  'board+wetsuit bundle': 'board_and_suit_rental',
  'board and suit': 'board_and_suit_rental',
  'board and wetsuit': 'board_and_suit_rental',
  'board + suit': 'board_and_suit_rental',
  'board + wetsuit': 'board_and_suit_rental',
  board_and_suit: 'board_and_suit_rental',
  board_and_suit_rental: 'board_and_suit_rental',
  surfboard_wetsuit_rental: 'surfboard_wetsuit_rental',
  surfboard_wetsuit: 'surfboard_wetsuit_rental',
  board_and_wetsuit_rental: 'board_and_wetsuit_rental',
  bundle: 'board_and_suit_rental',
  sup: 'sup_rental',
  paddleboard: 'sup_rental',
  sup_rental: 'sup_rental',
};

const DURATION_ALIASES = {
  '1h': '1_hour',
  '1 hour': '1_hour',
  '1_hour': '1_hour',
  'half day': 'half_day',
  half_day: 'half_day',
  '1 day': '1_day',
  '1_day': '1_day',
  day: '1_day',
  '2 days': '2_days',
  '2_days': '2_days',
  '3 days': '3_days',
  '3_days': '3_days',
  '4 days': '4_days',
  '4_days': '4_days',
  '5 days': '5_days',
  '5_days': '5_days',
  '6 days': '6_days',
  '6_days': '6_days',
  '7 days': '7_days',
  '7_days': '7_days',
  week: '7_days',
};

function resolveItemCode(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return ITEM_ALIASES[key] || key;
}

/**
 * Board+suit catalog key family for pre-selection text/intent normalization only.
 * Do NOT use after a concrete Admin offering_key is selected (P0b exact SSoT) —
 * resolveGenericRentalPrice / lookupSunsetRentalPriceAsync are exact-key only.
 */
function rentalOfferingKeyCandidates(itemCode) {
  const base = resolveItemCode(itemCode);
  const out = [];
  const push = (k) => {
    const v = String(k || '').trim();
    if (v && !out.includes(v)) out.push(v);
  };
  push(base);
  push(itemCode);
  const bundleFamily = new Set([
    'board_and_suit_rental',
    'surfboard_wetsuit_rental',
    'board_and_wetsuit_rental',
  ]);
  if (bundleFamily.has(base) || bundleFamily.has(String(itemCode || '').trim())) {
    push('board_and_suit_rental');
    push('surfboard_wetsuit_rental');
    push('board_and_wetsuit_rental');
  }
  return out;
}

function resolveDurationKey(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return DURATION_ALIASES[key] || key;
}

function normalizeMatchText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[_+/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rentalBaseKeyFromPrice(offeringKey) {
  const key = String(offeringKey || '').trim();
  if (!key) return '';
  return key.includes('__') ? key.split('__')[0] : key;
}

/**
 * Live rental menu from admin config prices (+ optional rental_offerings).
 * Never invents items/durations that are not configured.
 * When Admin rental identities exist they are the allowlist: disabled,
 * foreign-tenant, and leftover public-site bundle keys are excluded.
 */
function listConfiguredRentalOfferings(adminCfg, opts) {
  const byKey = new Map();
  const prices = adminCfg && Array.isArray(adminCfg.prices) ? adminCfg.prices : [];
  const offeringsList = adminCfg && Array.isArray(adminCfg.rental_offerings)
    ? adminCfg.rental_offerings
    : null;
  const liveKeys = activeRentalOfferingKeySet(offeringsList, {
    clientSlug: (opts && opts.clientSlug) || EXPECTED_TENANT,
    locationId: opts && opts.locationId,
  });
  const identityRows = Array.isArray(offeringsList) ? offeringsList : [];

  function acceptKey(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key || /full_day_equipment/i.test(key)) return false;
    if (!liveKeys) return true;
    const base = rentalBaseKeyFromPrice(key);
    return liveKeys.has(key) || liveKeys.has(base);
  }

  if (liveKeys) {
    for (const o of identityRows) {
      if (!o || !isDocumentedActiveFlag(o.active)) continue;
      const key = String(o.offering_key || o.key || '').trim();
      if (!acceptKey(key) || !liveKeys.has(key)) continue;
      byKey.set(key, {
        offering_key: key,
        label: String(o.label || o.display_name || key).trim(),
        durations: [],
        duration_set: new Set(),
      });
    }
  }

  for (const p of prices) {
    if (!p) continue;
    const cat = String(p.category || p.item_type || '').toLowerCase();
    const offeringKey = String(p.offering_key || '').trim();
    if (!offeringKey) continue;
    // Rental price rows only; skip full-day addon and non-rentals.
    if (cat && cat !== 'rental' && cat !== 'rentals') continue;
    if (/full_day_equipment/i.test(offeringKey)) continue;
    if (p.active === false) continue;
    if (p.addon === true && /full_day/i.test(offeringKey)) continue;
    const baseKey = rentalBaseKeyFromPrice(offeringKey);
    if (!acceptKey(offeringKey) && !acceptKey(baseKey)) continue;
    const menuKey = liveKeys && liveKeys.has(baseKey) ? baseKey : offeringKey;
    if (liveKeys && !liveKeys.has(menuKey)) continue;
    const unit = resolveDurationKey(p.unit || p.duration || p.window || '');
    if (!unit && !offeringKey.includes('__')) continue;
    const duration = unit || resolveDurationKey(offeringKey.split('__').slice(1).join('__'));
    if (!duration) continue;
    let entry = byKey.get(menuKey);
    if (!entry) {
      if (liveKeys) continue;
      entry = {
        offering_key: menuKey,
        label: String(p.label || p.display_name || menuKey).trim(),
        durations: [],
        duration_set: new Set(),
      };
      byKey.set(menuKey, entry);
    }
    if (!entry.duration_set.has(duration)) {
      entry.duration_set.add(duration);
      entry.durations.push(duration);
    }
    if ((!entry.label || entry.label === menuKey) && (p.label || p.display_name)) {
      entry.label = String(p.label || p.display_name).trim();
    }
  }
  if (!liveKeys) {
    for (const o of identityRows) {
      if (!o || !isDocumentedActiveFlag(o.active)) continue;
      const key = String(o.offering_key || o.key || '').trim();
      if (!key || /full_day_equipment/i.test(key)) continue;
      if (!byKey.has(key)) {
        byKey.set(key, {
          offering_key: key,
          label: String(o.label || o.display_name || key).trim(),
          durations: [],
          duration_set: new Set(),
        });
      } else if (o.label || o.display_name) {
        byKey.get(key).label = String(o.label || o.display_name).trim();
      }
    }
  }
  return Array.from(byKey.values()).map((e) => ({
    offering_key: e.offering_key,
    label: e.label,
    durations: e.durations.slice(),
  }));
}

function isConfiguredRentalItem(adminCfg, itemCode) {
  const code = String(itemCode || '').trim();
  if (!code) return false;
  const knownAlias = Object.values(ITEM_ALIASES).includes(code);
  const offerings = listConfiguredRentalOfferings(adminCfg);
  if (offerings.some((o) => o.offering_key === code)) return true;
  // Alias-only fallback only when no identity catalog was supplied (bootstrap).
  // Empty live allowlist means Admin returned zero rentals — do not invent aliases.
  const liveKeys = activeRentalOfferingKeySet(
    adminCfg && Array.isArray(adminCfg.rental_offerings) ? adminCfg.rental_offerings : null,
  );
  if (liveKeys) return false;
  if (!offerings.length && knownAlias) return true;
  return false;
}

/**
 * Match guest free text to a configured rental offering + duration.
 * Prefer longest label/key hits; never invent unconfigured items.
 */
function matchRentalFromMessage(messageText, adminCfg, opts) {
  const options = opts || {};
  const t = normalizeMatchText(messageText);
  const offerings = listConfiguredRentalOfferings(adminCfg);
  const liveKeys = activeRentalOfferingKeySet(
    adminCfg && Array.isArray(adminCfg.rental_offerings) ? adminCfg.rental_offerings : null,
  );
  if (!offerings.length) {
    if (liveKeys) {
      return {
        ok: false,
        item: null,
        duration: null,
        source: 'catalog',
        offerings,
      };
    }
    // Bootstrap offline: allow classic alias match only when no catalog rows.
    const aliased = resolveItemCode(t);
    // try alias keywords
    let item = null;
    const aliasPairs = [
      [/board\s*(and|&|\+)\s*(suit|wetsuit)|bundle/, 'board_and_suit_rental'],
      [/\bwetsuit\b|\bneopren\b|\bmuta\b/, 'wetsuit_rental'],
      [/\bsup\b|\bpaddle\s*board\b/, 'sup_rental'],
      [/\bboard\b|\bsurfboard\b|\btabla\b/, 'board_rental'],
    ];
    for (const [re, code] of aliasPairs) {
      if (re.test(t)) { item = code; break; }
    }
    let duration = null;
    for (const [label, key] of Object.entries(DURATION_ALIASES)) {
      const needle = normalizeMatchText(label);
      if (needle && t.includes(needle)) { duration = key; break; }
    }
    if (!duration && /\b1\s*h(?:our)?\b|\buna\s+hora\b/.test(t)) duration = '1_hour';
    if (!duration && /\bhalf\s*day\b|\bmedio\s+d[ií]a\b/.test(t)) duration = 'half_day';
    if (!duration && /\b7\s*days?\b|\bweek\b|\bsemana\b/.test(t)) duration = '7_days';
    if (!duration && /\b5\s*days?\b/.test(t)) duration = '5_days';
    if (!duration && /\b2\s*days?\b|\bdos\s+d[ií]as\b/.test(t)) duration = '2_days';
    if (!duration) duration = options.default_duration || null;
    return {
      ok: Boolean(item),
      item: item || null,
      duration: duration || null,
      source: 'alias_bootstrap',
      offerings,
    };
  }

  // Score offerings by label / key presence in message.
  let best = null;
  let bestScore = 0;
  for (const o of offerings) {
    const keyNorm = normalizeMatchText(o.offering_key.replace(/_rental$/i, '').replace(/_/g, ' '));
    const labelNorm = normalizeMatchText(o.label);
    let score = 0;
    if (labelNorm && t.includes(labelNorm)) score = Math.max(score, labelNorm.length + 40);
    if (keyNorm && t.includes(keyNorm)) score = Math.max(score, keyNorm.length + 20);
    // token overlap for multi-word labels
    const tokens = labelNorm.split(' ').filter((w) => w.length > 2 && !['the', 'and', 'for', 'with'].includes(w));
    let tokHits = 0;
    for (const tok of tokens) {
      if (t.includes(tok)) tokHits += 1;
    }
    if (tokens.length && tokHits === tokens.length) score = Math.max(score, labelNorm.length + 8);
    // synonym boosts mapped only if that offering exists
    if (o.offering_key === 'board_and_suit_rental' && /board\s*(and|&|\+)\s*(suit|wetsuit)|bundle/.test(t)) {
      score = Math.max(score, 50);
    }
    if (o.offering_key === 'wetsuit_rental' && /\bwetsuit\b|\bneopren\b|\bmuta\b/.test(t)) {
      score = Math.max(score, 40);
    }
    if (o.offering_key === 'board_rental' && /\b(?:surfboard|tabla)\b/.test(t)
      && !/board\s*(and|&|\+)\s*(suit|wetsuit)/.test(t)
      && !/\bfoil\b/.test(t)) {
      score = Math.max(score, 30);
    } else if (o.offering_key === 'board_rental' && /\bboard\b/.test(t)
      && !/board\s*(and|&|\+)\s*(suit|wetsuit)/.test(t)
      && !/\bfoil\s+board\b|\bsoft\s+top\b|\bhard\s+board\b/.test(t)) {
      score = Math.max(score, 18);
    }
    if (o.offering_key === 'sup_rental' && /\bsup\b|\bpaddle\s*board\b/.test(t)) {
      score = Math.max(score, 45);
    }
    // any offering_key as whole word
    const keyToken = o.offering_key.replace(/_rental$/i, '');
    if (keyToken && new RegExp(`\\b${keyToken.replace(/_/g, '[_\\s]*')}\\b`, 'i').test(t)) {
      score = Math.max(score, 25);
    }
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }

  let duration = null;
  // Prefer durations that exist on the matched offering (or any offering).
  const durationPool = best && best.durations.length
    ? best.durations
    : Array.from(new Set(offerings.flatMap((o) => o.durations)));
  const durationNeedles = [
    [/\b1\s*h(?:our)?\b|\buna\s+hora\b|\b1_hour\b/, '1_hour'],
    [/\bhalf\s*day\b|\bmedio\s+d[ií]a\b|\bhalf_day\b/, 'half_day'],
    [/\b7\s*days?\b|\bweek\b|\bsemana\b|\b7_days\b/, '7_days'],
    [/\b5\s*days?\b|\b5_days\b/, '5_days'],
    [/\b3\s*days?\b|\b3_days\b/, '3_days'],
    [/\b2\s*days?\b|\bdos\s+d[ií]as\b|\b2_days\b/, '2_days'],
    [/\b1\s*days?\b|\bfull\s*day\b|\b1_day\b|\bun\s+d[ií]a\b/, '1_day'],
  ];
  for (const [re, key] of durationNeedles) {
    if (re.test(t) && durationPool.includes(key)) {
      duration = key;
      break;
    }
  }
  if (!duration && options.default_duration && durationPool.includes(options.default_duration)) {
    duration = options.default_duration;
  }

  return {
    ok: Boolean(best && bestScore > 0),
    item: best && bestScore > 0 ? best.offering_key : null,
    duration,
    label: best && bestScore > 0 ? best.label : null,
    source: 'catalog',
    offerings,
    match_score: bestScore,
  };
}

function buildRentalAvailabilitySummary(lang, schoolName, adminCfg) {
  const offerings = listConfiguredRentalOfferings(adminCfg);
  if (!offerings.length) {
    if (lang === 'es') {
      return `En ${schoolName} no tengo el catálogo de alquiler cargado todavía. ¿Qué necesitas y para cuándo?`;
    }
    return `At ${schoolName} I don't have the rental catalogue loaded yet. What do you need and for how long?`;
  }
  const lines = offerings.map((o) => {
    const durs = (o.durations || []).map((d) => d.replace(/_/g, ' ')).join(', ');
    return durs ? `${o.label} (${durs})` : o.label;
  });
  if (lang === 'es') {
    return `En ${schoolName} ahora mismo alquilamos: ${lines.join('; ')}. ¿Cuál te interesa y para cuánto tiempo?`;
  }
  return `At ${schoolName} we currently rent: ${lines.join('; ')}. Which one do you need and for how long?`;
}

/**
 * Shared unit-price row resolver for Sunset rentals (quote + create).
 *
 * Primary match (config / live quote shape): bare offering_key + unit/duration
 * as separate fields — e.g. offering_key=bike_rental, unit=1_day.
 *
 * Secondary: compound offering_key/item_code = offering__duration when prices
 * were projected from tenant_price_rules via mapPriceRows (offering_key is the
 * full item_code; unit is only the billing grain).
 *
 * Never invents a row. Callers own amount extraction and fail-closed rules.
 */
function findAdminPriceRule(adminCfg, itemCode, durationKey) {
  const prices = adminCfg && Array.isArray(adminCfg.prices) ? adminCfg.prices : [];
  const item = String(itemCode || '').trim();
  const duration = String(durationKey || '').trim();
  if (!item || !duration) return null;

  // 1) Bare offering_key + duration-as-unit (quote-proven config shape).
  const primary = prices.find((p) => {
    if (!p || p.active === false) return false;
    const offering = String(p.offering_key || '').trim();
    const unit = String(p.unit || p.duration || p.window || '').trim();
    return offering === item && unit === duration;
  });
  if (primary) return primary;

  // 2) Compound item_code on offering_key or item_code (DB mapPriceRows shape).
  const compound = `${item}__${duration}`;
  const secondary = prices.find((p) => {
    if (!p || p.active === false) return false;
    const offering = String(p.offering_key || '').trim();
    const code = String(p.item_code || '').trim();
    return offering === compound || code === compound;
  });
  if (secondary) return secondary;

  // 3) If caller already passed a compound key, match it directly.
  if (item.includes('__')) {
    const direct = prices.find((p) => {
      if (!p || p.active === false) return false;
      const offering = String(p.offering_key || '').trim();
      const code = String(p.item_code || '').trim();
      const unit = String(p.unit || p.duration || p.window || '').trim();
      if (offering === item || code === item) return true;
      // bare left-side + duration field
      const bare = item.slice(0, item.lastIndexOf('__'));
      const dur = item.slice(item.lastIndexOf('__') + 2);
      return offering === bare && (unit === dur || unit === duration);
    });
    if (direct) return direct;
  }

  // 4) Soft display_name fallback (legacy seed rows).
  return prices.find((p) => {
    if (!p || p.active === false) return false;
    return String(p.offering_key || '').trim() === item
      && String(p.display_name || p.label || '').toLowerCase().includes(duration.replace(/_/g, ' '));
  }) || null;
}

/**
 * Amount cents from a findAdminPriceRule row (EUR amount or amount_cents).
 * Standalone rental authority requires a positive owner price — 0/negative
 * return null so callers fail closed as price_not_configured. CE included €0
 * is owned by equipment_options, not this helper.
 */
function adminPriceRuleAmountCents(rule) {
  if (!rule) return null;
  if (Number.isFinite(Number(rule.amount_cents))) {
    const n = Math.round(Number(rule.amount_cents));
    return n > 0 ? n : null;
  }
  if (rule.amount != null && Number.isFinite(Number(rule.amount))) {
    const n = Math.round(Number(rule.amount) * 100);
    return n > 0 ? n : null;
  }
  return null;
}

function lookupSunsetRentalPrice(opts) {
  const options = opts || {};
  const rawSlug = options.client_slug;
  const clientSlug = (rawSlug != null) ? String(rawSlug).trim() : EXPECTED_TENANT;
  const rawItem = String(options.item || '').trim();
  const duration = resolveDurationKey(options.duration);
  const requireConfirmed = options.require_confirmed !== false;

  if (clientSlug !== EXPECTED_TENANT) {
    return {
      ok: false,
      reason: 'tenant_mismatch',
      client_slug: clientSlug,
      expected_tenant: EXPECTED_TENANT,
    };
  }

  // Mirror async: omitted location may default Somo; explicitly supplied
  // null/empty/unknown must fail unknown_location (never silent Somo default).
  const locationExplicit = Object.prototype.hasOwnProperty.call(options, 'location_id');
  const rawLoc = options.location_id;
  if (locationExplicit) {
    if (rawLoc == null || String(rawLoc).trim() === '' || !isSunsetLocationId(rawLoc)) {
      return {
        ok: false,
        reason: 'unknown_location',
        client_slug: clientSlug,
        location_id: rawLoc == null ? rawLoc : String(rawLoc).trim(),
      };
    }
  }
  const locationId = locationExplicit
    ? normalizeSunsetLocationId(rawLoc)
    : DEFAULT_SUNSET_LOCATION_ID;

  const adminCfg = resolveSunsetAdminConfigForLuna(clientSlug, locationId);
  if (!adminCfg || adminCfg.ok === false) {
    return {
      ok: false,
      reason: 'config_not_found',
      client_slug: clientSlug,
      location_id: locationId,
    };
  }

  // Public/free-text boundary: resolveItemCode normalizes historical phrases
  // (e.g. "board+suit bundle") to a catalog key. Exact configured keys map to
  // themselves and never rewrite one configured key to another.
  const itemCode = resolveItemCode(rawItem);
  // Accept any item that is live in admin config — not only the static alias table.
  if (!isConfiguredRentalItem(adminCfg, itemCode)) {
    return { ok: false, reason: 'unknown_item', client_slug: clientSlug, tenant_id: clientSlug, location_id: locationId, item: itemCode, duration };
  }
  if (!duration) {
    return { ok: false, reason: 'price_not_configured', client_slug: clientSlug, tenant_id: clientSlug, location_id: locationId, item: itemCode, duration };
  }
  const rule = findAdminPriceRule(adminCfg, itemCode, duration);
  if (!rule) {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
    };
  }

  // Config-backed rules expose amount in EUR; DB-backed rules expose
  // amount_cents. Positive owner cents only — <=0 is unpriced standalone.
  const amountCents = adminPriceRuleAmountCents(rule);
  if (amountCents == null || !Number.isFinite(amountCents) || amountCents <= 0) {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
    };
  }

  const pricingStatus = String(rule.pricing_status || rule.status || 'confirmed').trim();
  const liveQuoteAllowed = pricingStatus === 'confirmed';

  if (requireConfirmed && !liveQuoteAllowed) {
    return {
      ok: false,
      reason: 'price_unverified',
      client_slug: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
      pricing_status: pricingStatus,
      live_quote_allowed: false,
    };
  }

  return {
    ok: true,
    client_slug: clientSlug,
    tenant_id: clientSlug,
    location_id: locationId,
    location_label: adminCfg.location_label,
    item: itemCode,
    duration,
    amount_cents: amountCents,
    amount_eur: amountCents / 100,
    currency: rule.currency || 'EUR',
    pricing_status: pricingStatus,
    live_quote_allowed: liveQuoteAllowed,
    source: rule.seed_source || rule.source || 'admin_config',
    source_url: rule.seed_source_url || null,
  };
}

function resolveRentalBillingUnit(durationKey) {
  const key = String(durationKey || '').trim();
  // Hour packages (generic N_hours + legacy 1_hour/2_hours/half_day) bill per session.
  if (/hour|half_day|lesson/i.test(key)) return 'session';
  // Generic positive N_days (+ 1_day / full_day) share billing grain "day".
  if (key === '1_day' || key === 'full_day' || /^[1-9][0-9]*_days$/.test(key)) return 'day';
  return null;
}

async function defaultLoadRentalRule(params) {
  const { loadTenantPriceRuleFromDb } = require('./tenant-business-config');
  if (params.pgClient) {
    return loadTenantPriceRuleFromDb(params.pgClient, params);
  }
  const { withPgClient } = require('./pg-connect');
  return withPgClient((client) => loadTenantPriceRuleFromDb(client, params));
}

/**
 * Async, DB-authoritative rental price lookup for LIVE Staff API / tool paths.
 *
 * Fail-closed ownership for live Admin pricing (ALL prices from Admin tab):
 *   - SUNSET_ADMIN_DB_READ_ENABLED off → pure baseline/config (bootstrap/offline only).
 *   - flag on: tenant+location scoped tenant_price_rules row is sole price owner.
 *   - DB rule found (valid cents) → return it (source=db, source_url=null).
 *   - table exists, no rule → fail closed (price_not_configured); NEVER the
 *                             stale public_site baseline seed.
 *   - null response or tables_missing while DB-read is on → fail closed
 *     (price_lookup_failed); NEVER baseline/public_site cents. Baseline is
 *     allowed ONLY when the DB-read feature flag is OFF.
 *   - location mismatch / invalid location / query error → fail closed;
 *     never silent baseline merge while live DB-read mode is on.
 *
 * @param {object} opts client_slug, item, duration, location_id, require_confirmed,
 *                       plus optional pgClient / loadRule (test injection).
 */
async function lookupSunsetRentalPriceAsync(opts) {
  const options = opts || {};
  const rawSlug = options.client_slug;
  const clientSlug = (rawSlug != null) ? String(rawSlug).trim() : EXPECTED_TENANT;
  const rawItem = String(options.item || '').trim();
  const duration = resolveDurationKey(options.duration);
  const requireConfirmed = options.require_confirmed !== false;

  if (clientSlug !== EXPECTED_TENANT) {
    return { ok: false, reason: 'tenant_mismatch', client_slug: clientSlug, expected_tenant: EXPECTED_TENANT };
  }

  // Distinguish omitted location (fixed-ingress Somo default) from explicitly
  // supplied null/empty/invalid values, which must fail closed.
  const locationExplicit = Object.prototype.hasOwnProperty.call(options, 'location_id');
  const rawLoc = options.location_id;
  if (locationExplicit) {
    if (rawLoc == null || String(rawLoc).trim() === '' || !isSunsetLocationId(rawLoc)) {
      return {
        ok: false,
        reason: 'unknown_location',
        client_slug: clientSlug,
        location_id: rawLoc == null ? rawLoc : String(rawLoc).trim(),
      };
    }
  }
  const locationId = locationExplicit
    ? normalizeSunsetLocationId(rawLoc)
    : DEFAULT_SUNSET_LOCATION_ID;

  const itemCode = resolveItemCode(rawItem);
  // Allow catalog offering keys beyond the static alias table; DB/config fail-closed if unknown.
  const aliasKnown = Object.values(ITEM_ALIASES).includes(itemCode);
  const looksLikeOfferingKey = /^[a-z][a-z0-9_]*$/.test(itemCode) && !itemCode.includes('__');
  if (!aliasKnown && !looksLikeOfferingKey) {
    return { ok: false, reason: 'unknown_item', client_slug: clientSlug, tenant_id: clientSlug, location_id: locationId, item: itemCode, duration };
  }
  if (!duration) {
    return { ok: false, reason: 'price_not_configured', client_slug: clientSlug, tenant_id: clientSlug, location_id: locationId, item: itemCode, duration };
  }

  // Flag off → baseline/config path (preview & bootstrap only). Never a live fallback.
  if (!isSunsetAdminDbReadEnabled()) {
    return lookupSunsetRentalPrice({
      client_slug: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
      require_confirmed: requireConfirmed,
    });
  }

  const billingUnit = resolveRentalBillingUnit(duration);
  if (!billingUnit) {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
      source: 'db',
    };
  }

  const loadRule = options.loadRule || defaultLoadRentalRule;
  // Concrete selection: exact offering_key only. Alias-family expansion used to
  // conceal borrowed board_and_suit / surfboard_wetsuit identities (P0b).
  // Pre-selection text still uses resolveItemCode / matchRentalFromMessage.
  let dbRes;
  const resolvedItemCode = itemCode;
  try {
    dbRes = await loadRule({
      clientSlug,
      locationId,
      itemType: 'rental',
      itemCode,
      duration,
      billingUnit,
      pgClient: options.pgClient,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'price_lookup_failed',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
      detail: (err && err.message) ? err.message : 'db_error',
    };
  }

  // DB-read mode: null / tables_missing fail closed — never baseline/public_site cents.
  if (!dbRes || dbRes.status === 'tables_missing') {
    return {
      ok: false,
      reason: 'price_lookup_failed',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
      detail: !dbRes ? 'null_response' : 'tables_missing',
    };
  }

  if (dbRes.status !== 'found') {
    const failClosed = dbRes.status === 'billing_unit_required'
      || dbRes.status === 'location_scope_unavailable'
      || dbRes.status === 'invalid_location'
      || dbRes.status === 'not_found';
    if (!failClosed) {
      return {
        ok: false,
        reason: 'price_lookup_failed',
        client_slug: clientSlug,
        tenant_id: clientSlug,
        location_id: locationId,
        item: itemCode,
        duration,
        detail: dbRes.status,
      };
    }
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
      source: 'db',
    };
  }

  const amountCents = Math.round(Number(dbRes.amount_cents));
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      item: itemCode,
      duration,
      source: 'db',
    };
  }

  const effectiveLoc = dbRes.location_id || locationId;
  return {
    ok: true,
    client_slug: clientSlug,
    tenant_id: clientSlug,
    location_id: effectiveLoc,
    location_label: locationStore.resolveLocationLabel(effectiveLoc),
    item: resolvedItemCode,
    duration,
    amount_cents: amountCents,
    amount_eur: amountCents / 100,
    currency: dbRes.currency || 'EUR',
    // Owner-managed portal rules are authoritative → always live-quotable.
    pricing_status: 'confirmed',
    live_quote_allowed: true,
    source: 'db',
    source_url: null,
  };
}

const FULL_DAY_EQUIPMENT_ADDON_KEY = 'full_day_equipment_extension';
const FULL_DAY_EQUIPMENT_ADDON_DURATION = 'day';
const FULL_DAY_EQUIPMENT_ADDON_BILLING_UNIT = 'day';
const FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE = `${FULL_DAY_EQUIPMENT_ADDON_KEY}__${FULL_DAY_EQUIPMENT_ADDON_DURATION}`;

// Read the active state + config/DB price for the full-day equipment add-on, school-scoped.
// Sync baseline path only — live Staff Create/Edit must use the async DB-authoritative
// variant when SUNSET_ADMIN_DB_READ_ENABLED is on. Baseline is allowed ONLY when that
// flag is off; the async path never falls back to this helper under DB-read mode.
// Fail-closed on unknown tenant/location, missing/disabled price.
function lookupSunsetFullDayEquipmentAddon(opts) {
  const options = opts || {};
  const rawSlug = options.client_slug;
  const clientSlug = (rawSlug != null) ? String(rawSlug).trim() : EXPECTED_TENANT;
  const locationId = normalizeSunsetLocationId(options.location_id || DEFAULT_SUNSET_LOCATION_ID);

  if (clientSlug !== EXPECTED_TENANT) {
    return { ok: false, reason: 'tenant_mismatch', client_slug: clientSlug, expected_tenant: EXPECTED_TENANT };
  }
  const adminCfg = resolveSunsetAdminConfigForLuna(clientSlug, locationId);
  if (!adminCfg || adminCfg.ok === false) {
    return { ok: false, reason: 'config_not_found', client_slug: clientSlug, location_id: locationId };
  }
  const prices = Array.isArray(adminCfg.prices) ? adminCfg.prices : [];
  const rule = prices.find((p) => {
    if (!p || p.active === false) return false;
    if (String(p.category || '').toLowerCase() !== 'rental') return false;
    const key = String(p.offering_key || p.item_code || '');
    const unit = String(p.unit || '');
    return (key === FULL_DAY_EQUIPMENT_ADDON_KEY && (!unit || unit === FULL_DAY_EQUIPMENT_ADDON_DURATION))
      || key === FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE;
  });
  if (!rule) {
    return {
      ok: false, reason: 'addon_disabled', client_slug: clientSlug, location_id: locationId,
      addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY, active: false,
    };
  }
  let amountCents = null;
  if (rule.amount_cents != null && Number.isFinite(Number(rule.amount_cents))) amountCents = Math.round(Number(rule.amount_cents));
  else if (rule.amount != null && Number.isFinite(Number(rule.amount))) amountCents = Math.round(Number(rule.amount) * 100);
  if (amountCents == null || amountCents <= 0) {
    return {
      ok: false, reason: 'price_not_configured', client_slug: clientSlug, location_id: locationId,
      addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
    };
  }
  return {
    ok: true,
    client_slug: clientSlug,
    tenant_id: clientSlug,
    location_id: locationId,
    location_label: adminCfg.location_label,
    addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
    active: true,
    billing_unit: 'person_per_day',
    unit: FULL_DAY_EQUIPMENT_ADDON_DURATION,
    amount_cents: amountCents,
    amount_eur: amountCents / 100,
    currency: rule.currency || 'EUR',
    source: rule.source === 'db' ? 'db' : 'admin_config',
  };
}

/**
 * Async, DB-authoritative full-day equipment add-on price lookup for LIVE paths.
 *
 * Fail-closed ownership for Create/Edit Admin pricing:
 *   - SUNSET_ADMIN_DB_READ_ENABLED off → pure baseline/config (bootstrap/offline only).
 *   - flag on: tenant+location scoped tenant_price_rules row is sole price owner.
 *   - DB found active valid cents → exact cents (source=db); never client/static merge.
 *   - row missing/disabled/invalid, location mismatch, query error → fail closed;
 *     never silent baseline/config merge fallback while live DB-read mode is on.
 *   - null response or tables_missing while DB-read is on → fail closed
 *     (price_lookup_failed / stable reason); NEVER baseline cents. Baseline is
 *     allowed ONLY when the DB-read feature flag is OFF.
 *
 * Admin row identity: item_type=rental, item_code=full_day_equipment_extension__day,
 * unit=day (billing grain), location_id exact.
 */
async function lookupSunsetFullDayEquipmentAddonAsync(opts) {
  const options = opts || {};
  const rawSlug = options.client_slug;
  const clientSlug = (rawSlug != null) ? String(rawSlug).trim() : EXPECTED_TENANT;

  if (clientSlug !== EXPECTED_TENANT) {
    return { ok: false, reason: 'tenant_mismatch', client_slug: clientSlug, expected_tenant: EXPECTED_TENANT };
  }

  // Distinguish omitted location (fixed-ingress Somo default) from explicitly
  // supplied null/empty/invalid values, which must fail closed.
  const locationExplicit = Object.prototype.hasOwnProperty.call(options, 'location_id');
  const rawLoc = options.location_id;
  if (locationExplicit) {
    if (rawLoc == null || String(rawLoc).trim() === '' || !isSunsetLocationId(rawLoc)) {
      return {
        ok: false,
        reason: 'unknown_location',
        client_slug: clientSlug,
        location_id: rawLoc == null ? rawLoc : String(rawLoc).trim(),
        addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
      };
    }
  }
  const locationId = locationExplicit
    ? normalizeSunsetLocationId(rawLoc)
    : DEFAULT_SUNSET_LOCATION_ID;

  // Flag off → baseline/config path (preview & bootstrap only). Never a live fallback.
  if (!isSunsetAdminDbReadEnabled()) {
    return lookupSunsetFullDayEquipmentAddon({
      client_slug: clientSlug,
      location_id: locationId,
    });
  }

  const loadRule = options.loadRule || defaultLoadRentalRule;
  let dbRes;
  try {
    dbRes = await loadRule({
      clientSlug,
      locationId,
      itemType: 'rental',
      // Offering key + duration → persisted full_day_equipment_extension__day.
      itemCode: FULL_DAY_EQUIPMENT_ADDON_KEY,
      duration: FULL_DAY_EQUIPMENT_ADDON_DURATION,
      billingUnit: FULL_DAY_EQUIPMENT_ADDON_BILLING_UNIT,
      pgClient: options.pgClient,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'price_lookup_failed',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
      detail: (err && err.message) ? err.message : 'db_error',
    };
  }

  // DB-read mode: null / tables_missing fail closed — never baseline cents.
  if (!dbRes || dbRes.status === 'tables_missing') {
    return {
      ok: false,
      reason: 'price_lookup_failed',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
      detail: !dbRes ? 'null_response' : 'tables_missing',
    };
  }

  if (dbRes.status !== 'found') {
    const failClosed = dbRes.status === 'billing_unit_required'
      || dbRes.status === 'location_scope_unavailable'
      || dbRes.status === 'invalid_location'
      || dbRes.status === 'not_found';
    if (!failClosed) {
      return {
        ok: false,
        reason: 'price_lookup_failed',
        client_slug: clientSlug,
        tenant_id: clientSlug,
        location_id: locationId,
        addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
        detail: dbRes.status,
      };
    }
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
      source: 'db',
    };
  }

  const amountCents = Math.round(Number(dbRes.amount_cents));
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      tenant_id: clientSlug,
      location_id: locationId,
      addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
      source: 'db',
    };
  }

  const effectiveLoc = dbRes.location_id || locationId;
  return {
    ok: true,
    client_slug: clientSlug,
    tenant_id: clientSlug,
    location_id: effectiveLoc,
    location_label: locationStore.resolveLocationLabel(effectiveLoc),
    addon_key: FULL_DAY_EQUIPMENT_ADDON_KEY,
    active: true,
    billing_unit: 'person_per_day',
    unit: FULL_DAY_EQUIPMENT_ADDON_DURATION,
    amount_cents: amountCents,
    amount_eur: amountCents / 100,
    currency: dbRes.currency || 'EUR',
    pricing_status: 'confirmed',
    live_quote_allowed: true,
    source: 'db',
    source_url: null,
  };
}

module.exports = {
  lookupSunsetRentalPrice,
  lookupSunsetRentalPriceAsync,
  lookupSunsetFullDayEquipmentAddon,
  lookupSunsetFullDayEquipmentAddonAsync,
  FULL_DAY_EQUIPMENT_ADDON_KEY,
  FULL_DAY_EQUIPMENT_ADDON_ITEM_CODE,
  ITEM_ALIASES,
  DURATION_ALIASES,
  resolveRentalBillingUnit,
  resolveDurationKey,
  resolveItemCode,
  rentalOfferingKeyCandidates,
  listConfiguredRentalOfferings,
  isConfiguredRentalItem,
  matchRentalFromMessage,
  buildRentalAvailabilitySummary,
  findAdminPriceRule,
  adminPriceRuleAmountCents,
};
