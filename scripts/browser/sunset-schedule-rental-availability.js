/**
 * Sunset Schedule create — rental availability selector helpers (Slice 2).
 * Browser globals; also runnable under Node vm for offline gates.
 *
 * Canonical projection joins enabled rental_offerings identity to active positive
 * rental price rows. Duration packages are generic positive N_hours / N_days
 * (plus legacy half_day / full_day / 1_hour / 2_hours read-compat). Per-item
 * duration ownership — never a shared multi-item duration intersection.
 * Does not own quote resolution or booking writes.
 */
'use strict';

var SCHEDULE_CANONICAL_RENTAL_OFFERINGS = ['board_rental', 'wetsuit_rental', 'board_and_suit_rental'];

// The full-day equipment extension is a rental-category price row but a dedicated
// add-on flow, never a picker offering — always excluded from the generic lane.
var SCHEDULE_FULL_DAY_EQUIPMENT_OFFERING = 'full_day_equipment_extension';

// A price-cache row is a generic (non-canonical) rentable offering when it is
// item_type/category 'rental' and not the full-day add-on. Data-driven so admin
// catalog offerings (e.g. kayak_rental) appear without a code change. The server
// GENERIC_RENTAL_CREATE_ENABLED flag remains the authority on submit.
function scheduleIsGenericRentalOffering(price, offeringKey) {
  var key = String(offeringKey || '').trim();
  if (!key || SCHEDULE_CANONICAL_RENTAL_OFFERINGS.indexOf(key) >= 0) return false;
  if (key === SCHEDULE_FULL_DAY_EQUIPMENT_OFFERING) return false;
  var category = String((price && price.category) || price.item_type || '').trim().toLowerCase();
  return category === 'rental';
}

/** Legacy short-key set retained for historical pebble helpers only. */
var SCHEDULE_SHORT_RENTAL_DURATION_KEYS = ['1_hour', '2_hours', 'half_day', 'full_day'];
var SCHEDULE_SHORT_RENTAL_DURATION_SET = {
  '1_hour': true,
  '2_hours': true,
  half_day: true,
  full_day: true,
};

function scheduleRentalOfferingLabelKey(offeringKey) {
  var key = String(offeringKey || '');
  if (key === 'board_rental') return 'schedule.type.boardRental';
  if (key === 'wetsuit_rental') return 'schedule.type.wetsuitRental';
  if (key === 'board_and_suit_rental') return 'schedule.ops.rentalBoth';
  // Arbitrary catalog items have no fixed i18n key — callers use projected label.
  return '';
}

/** Human label from offering key when catalog label missing (never board fallback). */
function scheduleHumanizeRentalOfferingKey(offeringKey) {
  var key = String(offeringKey || '').trim();
  if (!key) return '';
  return key.replace(/_rental$/i, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, function(c) {
    return c.toUpperCase();
  });
}

function scheduleIsHourRentalDurationKey(key) {
  var k = String(key || '').trim();
  if (!k) return false;
  if (k === 'half_day' || k === '1_hour' || k === '2_hours') return true;
  return /^[1-9][0-9]*_hours?$/.test(k);
}

function scheduleIsDayRentalDurationKey(key) {
  var k = String(key || '').trim();
  if (!k) return false;
  if (k === '1_day' || k === 'full_day') return true;
  return /^[1-9][0-9]*_days$/.test(k);
}

function scheduleIsShortRentalDurationKey(key) {
  var k = String(key || '').trim();
  // Legacy short pebbles: fixed set + generic N_hours. 1_day is the inclusive
  // full-day span identity (not a short pebble key).
  return !!SCHEDULE_SHORT_RENTAL_DURATION_SET[k]
    || scheduleIsHourRentalDurationKey(k);
}

function scheduleShortRentalDurationSortValue(key) {
  var k = String(key || '').trim();
  var hourMatch = k.match(/^([1-9][0-9]*)_hours?$/);
  if (hourMatch) return Number(hourMatch[1]);
  if (k === 'half_day') return 12;
  if (k === 'full_day' || k === '1_day') return 24;
  var dayMatch = k.match(/^([1-9][0-9]*)_days$/);
  if (dayMatch) return 24 * Number(dayMatch[1]);
  return Number.MAX_SAFE_INTEGER;
}

/** Duration sort: hours first (by hours), then 1_day, then multi-day packages. */
function scheduleRentalDurationSortValue(key) {
  var k = String(key || '').trim();
  if (scheduleIsHourRentalDurationKey(k)) return scheduleShortRentalDurationSortValue(k);
  if (k === '1_day' || k === 'full_day') return 1000;
  var dayMatch = k.match(/^([1-9][0-9]*)_days$/);
  if (dayMatch) return 1000 + Number(dayMatch[1]);
  return Number.MAX_SAFE_INTEGER;
}

/** Pebble/legacy label key. Generic N_hours / N_days use admin.period.* or format. */
function scheduleShortRentalDurationLabelKey(durationKey) {
  var k = String(durationKey || '').trim();
  if (k === 'full_day') return 'schedule.create.rentalDuration.fullDay';
  if (k === '1_hour') return 'schedule.create.rentalDuration.1Hour';
  if (k === '2_hours') return 'schedule.create.rentalDuration.2Hours';
  if (k === 'half_day') return 'schedule.create.rentalDuration.halfDay';
  return 'admin.period.' + k;
}

function scheduleShortRentalDurationFallbackLabel(durationKey) {
  var k = String(durationKey || '').trim();
  if (k === 'full_day') return 'Full day';
  if (k === '1_hour') return '1 hour';
  if (k === '2_hours') return '2 hours';
  if (k === 'half_day') return 'Half day';
  if (k === '1_day') return '1 day';
  var hm = k.match(/^([1-9][0-9]*)_hours?$/);
  if (hm) {
    var hn = Number(hm[1]);
    return hn === 1 ? '1 hour' : (hn + ' hours');
  }
  var dm = k.match(/^([1-9][0-9]*)_days$/);
  if (dm) {
    var dn = Number(dm[1]);
    return dn === 1 ? '1 day' : (dn + ' days');
  }
  return k;
}

function scheduleRentalDurationKeyFromDates(dateFrom, dateTo, enumerateDatesFn) {
  var enumFn = typeof enumerateDatesFn === 'function'
    ? enumerateDatesFn
    : (typeof scheduleEnumerateDates === 'function' ? scheduleEnumerateDates : null);
  if (!enumFn) return null;
  var from = String(dateFrom || '').slice(0, 10);
  var to = String(dateTo || dateFrom || '').slice(0, 10);
  if (!from) return null;
  var dates = enumFn(from, to || from) || [];
  var n = dates.length;
  if (n < 1) return null;
  if (n === 1) return '1_day';
  return String(n) + '_days';
}

function scheduleParseRentalPriceIdentity(price) {
  var raw = String((price && (price.offering_key || price.item_code)) || '').trim();
  var parts = raw.split('__');
  if (parts.length >= 2) {
    return { offering_key: parts[0], duration_key: parts.slice(1).join('__') };
  }
  return {
    offering_key: raw,
    duration_key: String((price && price.unit) || '').trim(),
  };
}

function scheduleRentalPriceAmountCents(price) {
  if (!price) return null;
  if (price.amount_cents != null && !isNaN(Number(price.amount_cents))) {
    return Math.round(Number(price.amount_cents));
  }
  if (price.amount != null && !isNaN(Number(price.amount))) {
    return Math.round(Number(price.amount) * 100);
  }
  return null;
}

function scheduleRentalOfferingLabelFromPrice(price) {
  return String((price && (price.label || price.offering_label)) || '').trim();
}

function scheduleRentalPriceIsSellable(price) {
  if (!price || price.active === false) return false;
  var cents = scheduleRentalPriceAmountCents(price);
  return cents != null && cents > 0;
}

function scheduleRentalPriceMatchesLocation(price, locationId) {
  var wantLoc = locationId != null ? String(locationId).trim() : '';
  var wantClient = (typeof getClient === 'function') ? String(getClient() || '').trim() : '';
  var rowClientSlug = String((price && price.client_slug) || '').trim();
  var rowTenant = String((price && price.tenant) || '').trim();
  // Config payloads are tenant-scoped, but reject hostile/misjoined foreign
  // identity fields independently instead of allowing one matching alias to
  // mask the other and become the customer-facing label.
  if (wantClient && ((rowClientSlug && rowClientSlug !== wantClient) || (rowTenant && rowTenant !== wantClient))) return false;
  if (!wantLoc) return true;
  if (!price || price.location_id == null || !String(price.location_id).trim()) return false;
  return String(price.location_id).trim() === wantLoc;
}

/**
 * Compatible duration packages for a calendar span.
 * - One day (1_day): all active N_hours (+ legacy half/1h/2h) plus 1_day.
 * - Multi-day (N_days): exact active N_days is the ONLY selectable duration when
 *   present; only when exact is absent may active 1_day be offered for per-date
 *   repeat. Hour packages are never offered across multi-day ranges.
 */
function scheduleCompatibleRentalDurationKeys(activeDurationKeys, dateDurationKey) {
  var want = String(dateDurationKey || '').trim();
  var list = Array.isArray(activeDurationKeys) ? activeDurationKeys : [];
  var set = {};
  list.forEach(function(k) {
    var key = String(k || '').trim();
    if (key) set[key] = true;
  });
  var out = [];
  var multiDay = want && want !== '1_day' && /^[1-9][0-9]*_days$/.test(want);
  if (!multiDay) {
    // Single-day span: hour packages + 1_day (full_day folds into 1_day display identity).
    Object.keys(set).forEach(function(k) {
      if (scheduleIsHourRentalDurationKey(k)) out.push(k);
      else if (k === '1_day' || k === 'full_day') {
        if (out.indexOf('1_day') < 0) out.push('1_day');
      }
    });
  } else {
    // Exact active N_days is exclusive. Only when it is absent may 1_day be
    // selected (and repeated once per date on the server). Never hour packages.
    if (set[want]) {
      out.push(want);
    } else if (set['1_day'] || set.full_day) {
      out.push('1_day');
    }
  }
  out.sort(function(a, b) {
    return scheduleRentalDurationSortValue(a) - scheduleRentalDurationSortValue(b);
  });
  return out;
}

/**
 * Display label for a rental identity. Catalog label wins; historical board/
 * wetsuit i18n only for those keys; never "Surfboard" for Towel/etc.
 */
function scheduleRentalOfferingDisplayLabel(offeringKey, catalogLabel, translateFn) {
  var key = String(offeringKey || '').trim();
  var catalog = String(catalogLabel || '').trim();
  if (catalog && catalog !== key && catalog.indexOf(key + '__') !== 0) return catalog;
  var i18nKey = scheduleRentalOfferingLabelKey(key);
  if (i18nKey && typeof translateFn === 'function') {
    var t = translateFn(i18nKey);
    if (t && t !== i18nKey) return t;
  }
  if (key === 'board_rental') return 'Surfboard';
  if (key === 'wetsuit_rental') return 'Wetsuit';
  if (key === 'board_and_suit_rental') return 'Board and wetsuit';
  return scheduleHumanizeRentalOfferingKey(key);
}

/**
 * Canonical standalone rental projection for Schedule Create/Edit.
 * Joins enabled tenant/location rental_offerings identity to active positive
 * rental price rows. Returns per-item duration options for the selected span.
 *
 * @param {{
 *   offerings?: Array,
 *   prices?: Array,
 *   locationId?: string,
 *   clientSlug?: string,
 *   dateDurationKey?: string,
 *   dayCount?: number,
 * }} opts
 * @returns {Array<{offering_key,label,durations:Array<{duration_key,amount_cents,label}>}>}
 */
function scheduleProjectStandaloneRentals(opts) {
  var o = opts || {};
  var locationId = o.locationId != null ? String(o.locationId).trim() : '';
  var clientSlug = o.clientSlug != null ? String(o.clientSlug).trim() : '';
  var dateDurationKey = String(o.dateDurationKey || '').trim();
  if (!dateDurationKey) {
    var dayCount = Number(o.dayCount);
    if (Number.isInteger(dayCount) && dayCount > 1) dateDurationKey = String(dayCount) + '_days';
    else dateDurationKey = '1_day';
  }
  var prices = Array.isArray(o.prices) ? o.prices : [];
  var rawOfferings = Array.isArray(o.offerings) ? o.offerings : null;

  // Enabled identity map when catalog is provided. Empty catalog → no new selectables
  // (fail closed; historical rows are handled by Edit compatibility only).
  var identityByKey = null;
  if (rawOfferings) {
    identityByKey = {};
    for (var oi = 0; oi < rawOfferings.length; oi++) {
      var off = rawOfferings[oi];
      if (!off || off.active === false) continue;
      var okKey = String(off.offering_key || '').trim();
      if (!okKey || okKey === SCHEDULE_FULL_DAY_EQUIPMENT_OFFERING) continue;
      if (clientSlug) {
        var offClient = String(off.client_slug || off.tenant || '').trim();
        if (offClient && offClient !== clientSlug) continue;
      }
      // Prefer exact location; allow client-wide (null location) rows.
      var offLoc = off.location_id != null ? String(off.location_id).trim() : '';
      if (locationId && offLoc && offLoc !== locationId) continue;
      if (!identityByKey[okKey]) {
        identityByKey[okKey] = {
          offering_key: okKey,
          label: String(off.label || '').trim() || scheduleHumanizeRentalOfferingKey(okKey),
          excludes: Array.isArray(off.excludes) ? off.excludes.slice() : [],
        };
      }
    }
  }

  // Collect sellable durations per offering from prices (authoritative money).
  var byKey = {};
  for (var i = 0; i < prices.length; i++) {
    var p = prices[i];
    if (!scheduleRentalPriceIsSellable(p)) continue;
    if (!scheduleRentalPriceMatchesLocation(p, locationId)) continue;
    if (clientSlug) {
      var priceClient = String(p.client_slug || p.tenant || '').trim();
      if (priceClient && priceClient !== clientSlug) continue;
    }
    var id = scheduleParseRentalPriceIdentity(p);
    var key = String(id.offering_key || '').trim();
    if (!key || key === SCHEDULE_FULL_DAY_EQUIPMENT_OFFERING) continue;
    var isCanonical = SCHEDULE_CANONICAL_RENTAL_OFFERINGS.indexOf(key) >= 0;
    var isGeneric = !isCanonical && scheduleIsGenericRentalOffering(p, key);
    if (!isCanonical && !isGeneric) continue;
    // When identity catalog is present, only enabled identities are newly selectable.
    if (identityByKey && !identityByKey[key]) continue;
    var dur = String(id.duration_key || '').trim();
    if (!dur) continue;
    // Normalize full_day → 1_day for selection identity (legacy fold).
    var durKey = dur === 'full_day' ? '1_day' : dur;
    if (!scheduleIsHourRentalDurationKey(durKey) && !scheduleIsDayRentalDurationKey(durKey)
      && durKey !== '1_day') {
      // Unknown non-generic duration shapes are ignored for new selection.
      if (!scheduleIsShortRentalDurationKey(durKey)) continue;
    }
    if (!byKey[key]) {
      var labelFromId = identityByKey && identityByKey[key] ? identityByKey[key].label : '';
      var labelFromPrice = scheduleRentalOfferingLabelFromPrice(p);
      if (labelFromPrice === key || labelFromPrice.indexOf(key + '__') === 0) labelFromPrice = '';
      byKey[key] = {
        offering_key: key,
        label: labelFromId || labelFromPrice || scheduleHumanizeRentalOfferingKey(key),
        _durationMap: {},
      };
    }
    var cents = scheduleRentalPriceAmountCents(p);
    if (cents == null || cents <= 0) continue;
    // Prefer first positive row; do not overwrite with a later lower/higher.
    if (!byKey[key]._durationMap[durKey]) {
      byKey[key]._durationMap[durKey] = {
        duration_key: durKey,
        amount_cents: cents,
        label: scheduleShortRentalDurationFallbackLabel(durKey),
      };
    }
  }

  var projected = [];
  Object.keys(byKey).forEach(function(key) {
    var item = byKey[key];
    var activeKeys = Object.keys(item._durationMap);
    var compatible = scheduleCompatibleRentalDurationKeys(activeKeys, dateDurationKey);
    if (!compatible.length) return;
    var durations = compatible.map(function(dk) {
      return item._durationMap[dk] || {
        duration_key: dk,
        amount_cents: item._durationMap['1_day'] ? item._durationMap['1_day'].amount_cents : null,
        label: scheduleShortRentalDurationFallbackLabel(dk),
      };
    }).filter(function(d) {
      return d && d.amount_cents != null && d.amount_cents > 0;
    });
    if (!durations.length) return;
    projected.push({
      offering_key: item.offering_key,
      label: item.label,
      durations: durations,
      // Convenience: first compatible duration for initial row render.
      duration_key: durations[0].duration_key,
      amount_cents: durations[0].amount_cents,
      duration_keys: durations.map(function(d) { return d.duration_key; }),
    });
  });

  projected.sort(function(a, b) {
    var byLabel = String(a.label || a.offering_key).localeCompare(String(b.label || b.offering_key));
    return byLabel || String(a.offering_key).localeCompare(String(b.offering_key));
  });
  return projected;
}

function scheduleActiveRentalsForDuration(prices, durationKey, locationId) {
  // Compatibility wrapper: project without identity catalog (price-driven only),
  // then collapse each offering to the preferred duration for the span.
  var projected = scheduleProjectStandaloneRentals({
    offerings: null,
    prices: prices,
    locationId: locationId,
    dateDurationKey: durationKey,
  });
  return projected.map(function(o) {
    var preferred = null;
    var want = String(durationKey || '').trim();
    for (var i = 0; i < o.durations.length; i++) {
      if (o.durations[i].duration_key === want) {
        preferred = o.durations[i];
        break;
      }
    }
    if (!preferred) preferred = o.durations[0];
    return {
      offering_key: o.offering_key,
      duration_key: preferred.duration_key,
      amount_cents: preferred.amount_cents,
      label: o.label,
    };
  });
}

/**
 * Active single-day-compatible duration keys for one offering at a location.
 * Data-driven: all active hour packages + 1_day/full_day (no fixed product enumeration).
 * Preserves stored key identity (full_day stays full_day) for legacy pebble paths.
 */
function scheduleActiveShortDurationKeysForOffering(prices, offeringKey, locationId) {
  var want = String(offeringKey || '').trim();
  var set = {};
  var list = Array.isArray(prices) ? prices : [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (!scheduleRentalPriceIsSellable(p)) continue;
    if (!scheduleRentalPriceMatchesLocation(p, locationId)) continue;
    var id = scheduleParseRentalPriceIdentity(p);
    if (id.offering_key !== want) continue;
    var dk = String(id.duration_key || '').trim();
    // Single-day compatible only (hours + 1_day/full_day); multi-day packages excluded.
    if (!scheduleIsHourRentalDurationKey(dk) && dk !== '1_day' && dk !== 'full_day') continue;
    set[dk] = true;
  }
  return Object.keys(set).sort(function(a, b) {
    return scheduleRentalDurationSortValue(a) - scheduleRentalDurationSortValue(b);
  });
}

/**
 * Intersection of active short durations on Surfboard and Wetsuit catalogs.
 * Used for No-lesson combined Board and wetsuit duration pebbles.
 */
function scheduleCommonShortRentalDurationKeys(prices, locationId) {
  var board = scheduleActiveShortDurationKeysForOffering(prices, 'board_rental', locationId);
  var suit = scheduleActiveShortDurationKeysForOffering(prices, 'wetsuit_rental', locationId);
  var suitSet = {};
  for (var i = 0; i < suit.length; i++) suitSet[suit[i]] = true;
  return board.filter(function(k) { return !!suitSet[k]; });
}

/** Offerings that have at least one sellable short row (No-lesson short mode). */
function scheduleActiveShortRentalOfferings(prices, locationId) {
  var out = [];
  var byKey = {};
  var list = Array.isArray(prices) ? prices : [];
  for (var i = 0; i < list.length; i++) {
    var row = list[i];
    if (!scheduleRentalPriceIsSellable(row)) continue;
    if (!scheduleRentalPriceMatchesLocation(row, locationId)) continue;
    var id = scheduleParseRentalPriceIdentity(row);
    var isCanonical = SCHEDULE_CANONICAL_RENTAL_OFFERINGS.indexOf(id.offering_key) >= 0;
    if (!isCanonical && !scheduleIsGenericRentalOffering(row, id.offering_key)) continue;
    if (!scheduleIsShortRentalDurationKey(id.duration_key)) continue;
    if (!byKey[id.offering_key]) {
      byKey[id.offering_key] = { offering_key: id.offering_key, duration_keys: [], label: '' };
      out.push(byKey[id.offering_key]);
    }
    if (byKey[id.offering_key].duration_keys.indexOf(id.duration_key) < 0) {
      byKey[id.offering_key].duration_keys.push(id.duration_key);
    }
    var label = scheduleRentalOfferingLabelFromPrice(row);
    if (label && !byKey[id.offering_key].label) byKey[id.offering_key].label = label;
  }
  out.forEach(function(item) {
    item.duration_keys.sort(function(a, b) {
      return scheduleShortRentalDurationSortValue(a) - scheduleShortRentalDurationSortValue(b);
    });
  });
  out.sort(function(a, b) {
    var byLabel = String(a.label || a.offering_key).localeCompare(String(b.label || b.offering_key));
    return byLabel || String(a.offering_key).localeCompare(String(b.offering_key));
  });
  return out;
}

/**
 * Admin fail-closed: board + wetsuit must expose the exact same active short-duration
 * key set among 1_hour / half_day / 1_day. Amounts may differ. Bundles ignored.
 * @returns {{ ok: true } | { ok: false, error: string, missing_board: string[], missing_wetsuit: string[] }}
 */
function scheduleAssertBoardWetsuitShortDurationParity(prices, locationId) {
  var board = scheduleActiveShortDurationKeysForOffering(prices, 'board_rental', locationId);
  var suit = scheduleActiveShortDurationKeysForOffering(prices, 'wetsuit_rental', locationId);
  var boardSet = {};
  var suitSet = {};
  for (var i = 0; i < board.length; i++) boardSet[board[i]] = true;
  for (var j = 0; j < suit.length; j++) suitSet[suit[j]] = true;
  var missingBoard = suit.filter(function(k) { return !boardSet[k]; });
  var missingSuit = board.filter(function(k) { return !suitSet[k]; });
  if (!missingBoard.length && !missingSuit.length) {
    return { ok: true, board_keys: board, wetsuit_keys: suit };
  }
  var parts = [];
  if (missingBoard.length) {
    parts.push('Surfboard missing: ' + missingBoard.join(', '));
  }
  if (missingSuit.length) {
    parts.push('Wetsuit missing: ' + missingSuit.join(', '));
  }
  return {
    ok: false,
    error: 'Surfboard and Wetsuit short durations must match ('
      + parts.join('; ')
      + '). Active short keys among 1_hour/half_day/1_day must be identical.',
    missing_board: missingBoard,
    missing_wetsuit: missingSuit,
    board_keys: board,
    wetsuit_keys: suit,
  };
}

function scheduleRentalOfferingsMode(activeOfferings) {
  var set = {};
  (activeOfferings || []).forEach(function(o) {
    if (o && o.offering_key) set[o.offering_key] = true;
  });
  var board = !!set.board_rental;
  var wetsuit = !!set.wetsuit_rental;
  var bundle = !!set.board_and_suit_rental;
  var genericCount = 0;
  Object.keys(set).forEach(function(k) {
    if (SCHEDULE_CANONICAL_RENTAL_OFFERINGS.indexOf(k) < 0) genericCount += 1;
  });
  var count = (board ? 1 : 0) + (wetsuit ? 1 : 0) + (bundle ? 1 : 0);
  // No canonical offerings: generic-only renders as an independent checklist
  // ('separate_only'); truly empty stays 'none'. Canonical modes below are
  // unchanged, so generic offerings ride alongside without altering bundle UX.
  if (count === 0) return genericCount > 0 ? 'separate_only' : 'none';
  if (bundle && !board && !wetsuit) return 'bundle_only';
  if (!bundle && (board || wetsuit)) return 'separate_only';
  return 'all_three';
}

function scheduleApplyRentalMutualExclusion(selectedKeys, toggledKey, checked) {
  var next = {};
  (selectedKeys || []).forEach(function(k) { next[k] = true; });
  var key = String(toggledKey || '');
  if (checked) {
    next[key] = true;
    if (key === 'board_and_suit_rental') {
      delete next.board_rental;
      delete next.wetsuit_rental;
    } else if (key === 'board_rental' || key === 'wetsuit_rental') {
      delete next.board_and_suit_rental;
    }
  } else {
    delete next[key];
  }
  return Object.keys(next);
}

function scheduleSerializeRentalsSelection(selection, durationKey, opts) {
  var dur = String(durationKey || '').trim();
  var options = opts || {};
  var expandCombinedShort = options.expandCombinedShort === true
    && scheduleIsShortRentalDurationKey(dur);
  // Allowlist of known generic catalog offering_keys the drawer rendered. Only
  // these pass through; unknown non-canonical keys are dropped (fail-closed).
  var genericAllow = {};
  var allowList = Array.isArray(options.genericOfferingKeys) ? options.genericOfferingKeys : [];
  for (var gi = 0; gi < allowList.length; gi++) {
    var gk = String(allowList[gi] || '').trim();
    if (gk) genericAllow[gk] = true;
  }
  var rentals = [];
  var list = Array.isArray(selection) ? selection : [];
  var hasBoard = false;
  var hasSuit = false;
  var hasBundle = false;
  var bundleQty = null;
  for (var i = 0; i < list.length; i++) {
    var row = list[i];
    if (!row || !row.offering_key) continue;
    // Physical equipment units 1..99 — independent of guest/surfer count.
    // Reject fractions/NaN/strings that parseInt would silently truncate (e.g. 2.5 → 2).
    var qtyRaw = row.quantity;
    var qty = typeof qtyRaw === 'number' ? qtyRaw : Number(qtyRaw);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) continue;
    var key = row.offering_key;
    var rowDur = String(row.duration_key || dur).trim();
    // Generic (non-canonical) catalog offerings pass through verbatim — no legacy
    // board/wetsuit component expansion — but only when allowlisted by the drawer.
    // Unknown keys are dropped; the server prices + persists the accepted ones.
    if (SCHEDULE_CANONICAL_RENTAL_OFFERINGS.indexOf(key) < 0) {
      if (key !== SCHEDULE_FULL_DAY_EQUIPMENT_OFFERING && genericAllow[key]) {
        rentals.push({ offering_key: key, duration_key: rowDur, quantity: qty });
      }
      continue;
    }
    if (expandCombinedShort && key === 'board_and_suit_rental' && scheduleIsShortRentalDurationKey(rowDur)) {
      hasBundle = true;
      bundleQty = qty;
      continue;
    }
    if (key === 'board_rental') hasBoard = true;
    if (key === 'wetsuit_rental') hasSuit = true;
    rentals.push({
      offering_key: key,
      duration_key: rowDur,
      quantity: qty,
    });
  }
  // No-lesson combined: one pebble controls both components — quote Surfboard + Wetsuit sum.
  if (expandCombinedShort && hasBundle && !hasBoard && !hasSuit && bundleQty != null) {
    rentals.push(
      { offering_key: 'board_rental', duration_key: dur, quantity: bundleQty },
      { offering_key: 'wetsuit_rental', duration_key: dur, quantity: bundleQty },
    );
  }
  return rentals;
}

function scheduleRentalsToLegacyComponents(rentals) {
  var components = {};
  (rentals || []).forEach(function(r) {
    if (!r || !r.offering_key) return;
    var qty = parseInt(r.quantity, 10) || 1;
    if (r.offering_key === 'board_rental') {
      components.surfboard = { quantity: qty };
    } else if (r.offering_key === 'wetsuit_rental') {
      components.wetsuit = { quantity: qty };
    } else if (r.offering_key === 'board_and_suit_rental') {
      components.surfboard = { quantity: qty };
      components.wetsuit = { quantity: qty };
    }
  });
  return components;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCHEDULE_CANONICAL_RENTAL_OFFERINGS: SCHEDULE_CANONICAL_RENTAL_OFFERINGS,
    SCHEDULE_FULL_DAY_EQUIPMENT_OFFERING: SCHEDULE_FULL_DAY_EQUIPMENT_OFFERING,
    SCHEDULE_SHORT_RENTAL_DURATION_KEYS: SCHEDULE_SHORT_RENTAL_DURATION_KEYS,
    scheduleIsGenericRentalOffering: scheduleIsGenericRentalOffering,
    scheduleRentalOfferingLabelKey: scheduleRentalOfferingLabelKey,
    scheduleRentalOfferingDisplayLabel: scheduleRentalOfferingDisplayLabel,
    scheduleHumanizeRentalOfferingKey: scheduleHumanizeRentalOfferingKey,
    scheduleIsHourRentalDurationKey: scheduleIsHourRentalDurationKey,
    scheduleIsDayRentalDurationKey: scheduleIsDayRentalDurationKey,
    scheduleIsShortRentalDurationKey: scheduleIsShortRentalDurationKey,
    scheduleShortRentalDurationLabelKey: scheduleShortRentalDurationLabelKey,
    scheduleShortRentalDurationFallbackLabel: scheduleShortRentalDurationFallbackLabel,
    scheduleRentalDurationSortValue: scheduleRentalDurationSortValue,
    scheduleRentalDurationKeyFromDates: scheduleRentalDurationKeyFromDates,
    scheduleParseRentalPriceIdentity: scheduleParseRentalPriceIdentity,
    scheduleRentalPriceAmountCents: scheduleRentalPriceAmountCents,
    scheduleRentalPriceIsSellable: scheduleRentalPriceIsSellable,
    scheduleCompatibleRentalDurationKeys: scheduleCompatibleRentalDurationKeys,
    scheduleProjectStandaloneRentals: scheduleProjectStandaloneRentals,
    // Alias used by Create/Edit + focused Slice 2 verifier.
    scheduleProjectStandaloneRentalCatalog: scheduleProjectStandaloneRentals,
    scheduleActiveRentalsForDuration: scheduleActiveRentalsForDuration,
    scheduleActiveShortDurationKeysForOffering: scheduleActiveShortDurationKeysForOffering,
    scheduleCommonShortRentalDurationKeys: scheduleCommonShortRentalDurationKeys,
    scheduleActiveShortRentalOfferings: scheduleActiveShortRentalOfferings,
    scheduleAssertBoardWetsuitShortDurationParity: scheduleAssertBoardWetsuitShortDurationParity,
    scheduleRentalOfferingsMode: scheduleRentalOfferingsMode,
    scheduleApplyRentalMutualExclusion: scheduleApplyRentalMutualExclusion,
    scheduleSerializeRentalsSelection: scheduleSerializeRentalsSelection,
    scheduleRentalsToLegacyComponents: scheduleRentalsToLegacyComponents,
  };
}
