/**
 * Sunset Equipment Pricing model (Slice 1) — pure data layer for the rebuilt,
 * groupless Admin Pricing tab. Turns the flat `tenant_price_rules` rental rows
 * into a flat list of equipment items, each with its price rows expressed in the
 * templatable (unit, count) duration model. NOTHING is dropped for being
 * "non-canonical" — board/wetsuit/bundle/sup and a brand-new kayak are all just
 * equipment items. Browser global + node-require compatible; no DOM, no network.
 *
 * Interop: this file is injected (concatenated) into the admin page AFTER
 * sunset-rental-duration-model.js, so in the browser its functions
 * (parseRentalDurationKey / formatRentalDuration) are globals; under Node we
 * require them. Emits its own functions as globals when injected.
 */
'use strict';

var __EPM_DM = (typeof require === 'function') ? require('./sunset-rental-duration-model') : null;
function __epmParseDuration(key) {
  return __EPM_DM ? __EPM_DM.parseRentalDurationKey(key) : parseRentalDurationKey(key);
}
function __epmFormatDuration(unit, count) {
  return __EPM_DM ? __EPM_DM.formatRentalDuration(unit, count) : formatRentalDuration(unit, count);
}

// The full-day equipment extension is a rental-category row but a dedicated
// add-on, not a standalone equipment item — keep it out of the tab.
var EQUIPMENT_EXCLUDED_OFFERING_KEYS = { full_day_equipment_extension: true };

function equipmentPriceOfferingKey(p) {
  var code = String((p && (p.offering_key || p.item_code)) || '').trim().toLowerCase();
  var parts = code.split('__');
  return parts.length > 1 ? parts[0] : code;
}
function equipmentPriceDurationKey(p) {
  var code = String((p && (p.offering_key || p.item_code)) || '').trim().toLowerCase();
  var parts = code.split('__');
  return parts.length > 1 ? parts.slice(1).join('__') : String((p && p.unit) || '').trim();
}
function equipmentPriceAmountCents(p) {
  if (!p) return null;
  if (p.amount_cents != null && !isNaN(Number(p.amount_cents))) return Math.round(Number(p.amount_cents));
  if (p.amount != null && !isNaN(Number(p.amount))) return Math.round(Number(p.amount) * 100);
  return null;
}
function equipmentIsRentalCategory(p) {
  return String((p && p.category) || '').trim().toLowerCase() === 'rental';
}
function humanizeOfferingKey(key) {
  return String(key || '').replace(/_rental$/, '').replace(/_/g, ' ')
    .replace(/\b\w/g, function (c) { return c.toUpperCase(); }).trim();
}

function equipmentDurationSortValue(unit, count) {
  if (!unit) return Number.MAX_SAFE_INTEGER;
  return (unit === 'days' ? 100000 : 0) + count; // hours before days, then count
}

/**
 * @param {Array} prices  cfg.prices (mixed categories)
 * @returns {Array<{offering_key, label, rows:Array<{pid,duration_key,unit,count,duration_label,amount_cents,active,invalid}>}>}
 */
function buildEquipmentPricingList(prices) {
  var list = Array.isArray(prices) ? prices : [];
  var byKey = {};
  var order = [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (!equipmentIsRentalCategory(p)) continue;
    // Inactive rows are treated as removed — the groupless tab has no "availability"
    // concept, so a deleted price disappears uniformly (canonical items no longer
    // linger grayed-out the way the old group UI kept them).
    if (p && p.active === false) continue;
    var key = equipmentPriceOfferingKey(p);
    if (!key || EQUIPMENT_EXCLUDED_OFFERING_KEYS[key]) continue;
    if (!byKey[key]) { byKey[key] = { offering_key: key, label: '', rows: [] }; order.push(key); }
    var item = byKey[key];
    var label = String((p && (p.label || p.display_name || p.offering_label)) || '').trim();
    if (label && (!item.label || item.label === humanizeOfferingKey(key))) item.label = label;
    var dk = equipmentPriceDurationKey(p);
    var uc = __epmParseDuration(dk);
    item.rows.push({
      pid: (p && p.id) ? String(p.id) : null,
      duration_key: dk,
      unit: uc ? uc.unit : null,
      count: uc ? uc.count : null,
      duration_label: uc ? __epmFormatDuration(uc.unit, uc.count) : String(dk),
      amount_cents: equipmentPriceAmountCents(p),
      active: !(p && p.active === false),
      invalid: !uc,
    });
  }
  var out = [];
  for (var j = 0; j < order.length; j++) {
    var it = byKey[order[j]];
    if (!it.label) it.label = humanizeOfferingKey(it.offering_key);
    it.rows.sort(function (a, b) {
      return equipmentDurationSortValue(a.unit, a.count) - equipmentDurationSortValue(b.unit, b.count);
    });
    out.push(it);
  }
  out.sort(function (a, b) {
    var byLabel = String(a.label).localeCompare(String(b.label));
    return byLabel || String(a.offering_key).localeCompare(String(b.offering_key));
  });
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildEquipmentPricingList: buildEquipmentPricingList,
    humanizeOfferingKey: humanizeOfferingKey,
  };
}
