/**
 * Sunset Schedule create — rental availability selector helpers (Slice 2).
 * Browser globals; also runnable under Node vm for offline gates.
 *
 * Derives sellable offerings from active location prices for a date-span duration.
 * Does not own quote resolution or booking writes.
 */
'use strict';

var SCHEDULE_CANONICAL_RENTAL_OFFERINGS = ['board_rental', 'wetsuit_rental', 'board_and_suit_rental'];

function scheduleRentalOfferingLabelKey(offeringKey) {
  var key = String(offeringKey || '');
  if (key === 'board_rental') return 'schedule.type.boardRental';
  if (key === 'wetsuit_rental') return 'schedule.type.wetsuitRental';
  if (key === 'board_and_suit_rental') return 'schedule.ops.rentalBoth';
  return 'schedule.type.boardRental';
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

function scheduleActiveRentalsForDuration(prices, durationKey, locationId) {
  var wantDuration = String(durationKey || '').trim();
  var wantLoc = locationId != null ? String(locationId).trim() : '';
  var out = [];
  var seen = {};
  var list = Array.isArray(prices) ? prices : [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (!scheduleRentalPriceIsSellable(p)) continue;
    if (wantLoc && p.location_id != null && String(p.location_id).trim()
      && String(p.location_id).trim() !== wantLoc) {
      continue;
    }
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

function scheduleSerializeRentalsSelection(selection, durationKey) {
  var dur = String(durationKey || '').trim();
  var rentals = [];
  var list = Array.isArray(selection) ? selection : [];
  for (var i = 0; i < list.length; i++) {
    var row = list[i];
    if (!row || !row.offering_key) continue;
    if (SCHEDULE_CANONICAL_RENTAL_OFFERINGS.indexOf(row.offering_key) < 0) continue;
    var qty = parseInt(row.quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) continue;
    rentals.push({
      offering_key: row.offering_key,
      duration_key: String(row.duration_key || dur).trim(),
      quantity: qty,
    });
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
    scheduleRentalOfferingLabelKey: scheduleRentalOfferingLabelKey,
    scheduleRentalDurationKeyFromDates: scheduleRentalDurationKeyFromDates,
    scheduleParseRentalPriceIdentity: scheduleParseRentalPriceIdentity,
    scheduleRentalPriceAmountCents: scheduleRentalPriceAmountCents,
    scheduleRentalPriceIsSellable: scheduleRentalPriceIsSellable,
    scheduleActiveRentalsForDuration: scheduleActiveRentalsForDuration,
    scheduleRentalOfferingsMode: scheduleRentalOfferingsMode,
    scheduleApplyRentalMutualExclusion: scheduleApplyRentalMutualExclusion,
    scheduleSerializeRentalsSelection: scheduleSerializeRentalsSelection,
    scheduleRentalsToLegacyComponents: scheduleRentalsToLegacyComponents,
  };
}
