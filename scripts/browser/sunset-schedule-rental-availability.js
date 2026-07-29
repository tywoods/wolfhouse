/**
 * Sunset Schedule create — rental availability selector helpers (Slice 2).
 * Browser globals; also runnable under Node vm for offline gates.
 *
 * Derives sellable offerings from active location prices for a date-span duration.
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
  var category = String((price && price.category) || '').trim().toLowerCase();
  return category === 'rental';
}

/** No-lesson short rental pebbles only (never 2–7 days). */
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
  return 'schedule.type.boardRental';
}

function scheduleIsShortRentalDurationKey(key) {
  var k = String(key || '').trim();
  return !!SCHEDULE_SHORT_RENTAL_DURATION_SET[k]
    || k === '1_day'
    || /^[1-9][0-9]*_hours$/.test(k);
}

function scheduleShortRentalDurationSortValue(key) {
  var k = String(key || '').trim();
  var hourMatch = k.match(/^([1-9][0-9]*)_hours$/);
  if (hourMatch) return Number(hourMatch[1]);
  if (k === 'half_day') return 12;
  if (k === 'full_day' || k === '1_day') return 24;
  return Number.MAX_SAFE_INTEGER;
}

/** Pebble label key: 1_day → Full day in short-rental mode. */
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

function scheduleActiveRentalsForDuration(prices, durationKey, locationId) {
  var wantDuration = String(durationKey || '').trim();
  var exactByOffering = {};
  var genericBaseByOffering = {};
  var list = Array.isArray(prices) ? prices : [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (!scheduleRentalPriceIsSellable(p)) continue;
    if (!scheduleRentalPriceMatchesLocation(p, locationId)) continue;
    var id = scheduleParseRentalPriceIdentity(p);
    var isCanonical = SCHEDULE_CANONICAL_RENTAL_OFFERINGS.indexOf(id.offering_key) >= 0;
    var isGeneric = !isCanonical && scheduleIsGenericRentalOffering(p, id.offering_key);
    // Canonical always; generic catalog rentals (data-driven) when priced. The
    // full-day add-on and non-rental rows (lessons/packages) never qualify.
    if (!isCanonical && !isGeneric) continue;
    var offering = {
      offering_key: id.offering_key,
      duration_key: id.duration_key,
      amount_cents: scheduleRentalPriceAmountCents(p),
      label: scheduleRentalOfferingLabelFromPrice(p),
    };
    if (wantDuration && id.duration_key === wantDuration && !exactByOffering[id.offering_key]) {
      exactByOffering[id.offering_key] = offering;
    }
    // Generic items remain available for arbitrary calendar spans. When Admin has
    // no exact N-day special, carry the shortest configured short package through;
    // the authoritative server repeats that package once per selected calendar day.
    if (isGeneric && scheduleIsShortRentalDurationKey(id.duration_key)) {
      var prior = genericBaseByOffering[id.offering_key];
      if (!prior || scheduleShortRentalDurationSortValue(id.duration_key)
          < scheduleShortRentalDurationSortValue(prior.duration_key)) {
        genericBaseByOffering[id.offering_key] = offering;
      }
    }
  }
  var out = [];
  var keys = {};
  Object.keys(exactByOffering).forEach(function(key) { keys[key] = true; });
  Object.keys(genericBaseByOffering).forEach(function(key) { keys[key] = true; });
  Object.keys(keys).forEach(function(key) {
    var chosen = exactByOffering[key] || genericBaseByOffering[key];
    if (chosen) out.push(chosen);
  });
  out.sort(function(a, b) {
    var byLabel = String(a.label || a.offering_key).localeCompare(String(b.label || b.offering_key));
    return byLabel || String(a.offering_key).localeCompare(String(b.offering_key));
  });
  return out;
}

/** Active short-duration keys for one offering at a location (hour/half_day/1_day only). */
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
    if (!scheduleIsShortRentalDurationKey(id.duration_key)) continue;
    set[id.duration_key] = true;
  }
  return SCHEDULE_SHORT_RENTAL_DURATION_KEYS.filter(function(k) { return !!set[k]; });
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
    var qty = parseInt(row.quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) continue;
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
    scheduleIsShortRentalDurationKey: scheduleIsShortRentalDurationKey,
    scheduleShortRentalDurationLabelKey: scheduleShortRentalDurationLabelKey,
    scheduleShortRentalDurationFallbackLabel: scheduleShortRentalDurationFallbackLabel,
    scheduleRentalDurationKeyFromDates: scheduleRentalDurationKeyFromDates,
    scheduleParseRentalPriceIdentity: scheduleParseRentalPriceIdentity,
    scheduleRentalPriceAmountCents: scheduleRentalPriceAmountCents,
    scheduleRentalPriceIsSellable: scheduleRentalPriceIsSellable,
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
