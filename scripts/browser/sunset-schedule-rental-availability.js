/**
 * Sunset Schedule create — rental availability selector helpers (Slice 2).
 * Browser globals; also runnable under Node vm for offline gates.
 *
 * Derives sellable offerings from active location prices for a date-span duration.
 * Does not own quote resolution or booking writes.
 */
'use strict';

var SCHEDULE_CANONICAL_RENTAL_OFFERINGS = ['board_rental', 'wetsuit_rental', 'board_and_suit_rental'];

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
  return !!SCHEDULE_SHORT_RENTAL_DURATION_SET[String(key || '').trim()];
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

function scheduleRentalPriceIsSellable(price) {
  if (!price || price.active === false) return false;
  var cents = scheduleRentalPriceAmountCents(price);
  return cents != null && cents > 0;
}

function scheduleRentalPriceMatchesLocation(price, locationId) {
  var wantLoc = locationId != null ? String(locationId).trim() : '';
  if (!wantLoc || !price || price.location_id == null || !String(price.location_id).trim()) {
    return true;
  }
  return String(price.location_id).trim() === wantLoc;
}

function scheduleActiveRentalsForDuration(prices, durationKey, locationId) {
  var wantDuration = String(durationKey || '').trim();
  var out = [];
  var seen = {};
  var list = Array.isArray(prices) ? prices : [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (!scheduleRentalPriceIsSellable(p)) continue;
    if (!scheduleRentalPriceMatchesLocation(p, locationId)) continue;
    var id = scheduleParseRentalPriceIdentity(p);
    if (SCHEDULE_CANONICAL_RENTAL_OFFERINGS.indexOf(id.offering_key) < 0) continue;
    if (!wantDuration || id.duration_key !== wantDuration) continue;
    if (seen[id.offering_key]) continue;
    seen[id.offering_key] = true;
    out.push({
      offering_key: id.offering_key,
      duration_key: id.duration_key,
      amount_cents: scheduleRentalPriceAmountCents(p),
    });
  }
  // Stable order: board, wetsuit, bundle
  out.sort(function(a, b) {
    return SCHEDULE_CANONICAL_RENTAL_OFFERINGS.indexOf(a.offering_key)
      - SCHEDULE_CANONICAL_RENTAL_OFFERINGS.indexOf(b.offering_key);
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
  var seen = {};
  for (var i = 0; i < SCHEDULE_CANONICAL_RENTAL_OFFERINGS.length; i++) {
    var key = SCHEDULE_CANONICAL_RENTAL_OFFERINGS[i];
    var shorts = scheduleActiveShortDurationKeysForOffering(prices, key, locationId);
    if (!shorts.length) continue;
    if (seen[key]) continue;
    seen[key] = true;
    out.push({ offering_key: key, duration_keys: shorts });
  }
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
  var count = (board ? 1 : 0) + (wetsuit ? 1 : 0) + (bundle ? 1 : 0);
  if (count === 0) return 'none';
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
  var rentals = [];
  var list = Array.isArray(selection) ? selection : [];
  var hasBoard = false;
  var hasSuit = false;
  var hasBundle = false;
  var bundleQty = null;
  for (var i = 0; i < list.length; i++) {
    var row = list[i];
    if (!row || !row.offering_key) continue;
    if (SCHEDULE_CANONICAL_RENTAL_OFFERINGS.indexOf(row.offering_key) < 0) continue;
    var qty = parseInt(row.quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) continue;
    var key = row.offering_key;
    var rowDur = String(row.duration_key || dur).trim();
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
    SCHEDULE_SHORT_RENTAL_DURATION_KEYS: SCHEDULE_SHORT_RENTAL_DURATION_KEYS,
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
