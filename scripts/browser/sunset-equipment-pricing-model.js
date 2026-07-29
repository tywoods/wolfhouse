/**
 * Sunset Equipment Pricing model (Slice 1) — pure data layer for the rebuilt,
 * groupless Admin Pricing tab. Turns the flat `tenant_price_rules` rental rows
 * into a flat list of equipment items, each with its price rows expressed in the
 * templatable (unit, count) duration model. NOTHING is dropped for being
 * "non-canonical" — board/wetsuit/bundle/sup and a brand-new kayak are all just
 * equipment items. Browser global + node-require compatible; no DOM, no network.
 */
'use strict';

(function (root, factory) {
  var api = factory(
    typeof require === 'function'
      ? require('./sunset-rental-duration-model')
      : root.SunsetRentalDurationModel
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SunsetEquipmentPricingModel = api; Object.assign(root, api); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (durationModel) {
  var parseRentalDurationKey = durationModel.parseRentalDurationKey;
  var formatRentalDuration = durationModel.formatRentalDuration;

  // The full-day equipment extension is a rental-category row but a dedicated
  // add-on, not a standalone equipment item — keep it out of the tab.
  var EXCLUDED_OFFERING_KEYS = { full_day_equipment_extension: true };

  function priceOfferingKey(p) {
    var code = String((p && (p.offering_key || p.item_code)) || '').trim().toLowerCase();
    var parts = code.split('__');
    return parts.length > 1 ? parts[0] : code;
  }
  function priceDurationKey(p) {
    var code = String((p && (p.offering_key || p.item_code)) || '').trim().toLowerCase();
    var parts = code.split('__');
    return parts.length > 1 ? parts.slice(1).join('__') : String((p && p.unit) || '').trim();
  }
  function priceAmountCents(p) {
    if (!p) return null;
    if (p.amount_cents != null && !isNaN(Number(p.amount_cents))) return Math.round(Number(p.amount_cents));
    if (p.amount != null && !isNaN(Number(p.amount))) return Math.round(Number(p.amount) * 100);
    return null;
  }
  function isRentalCategory(p) {
    return String((p && p.category) || '').trim().toLowerCase() === 'rental';
  }
  function humanizeOfferingKey(key) {
    return String(key || '').replace(/_rental$/, '').replace(/_/g, ' ')
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); }).trim();
  }

  // Canonical items float to the top in a friendly order; everything else sorts
  // alphabetically after them. There are NO groups — this is display order only.
  var CANONICAL_ORDER = ['board_rental', 'wetsuit_rental', 'board_and_suit_rental', 'sup_rental'];
  function offeringRank(key) {
    var i = CANONICAL_ORDER.indexOf(key);
    return i < 0 ? CANONICAL_ORDER.length : i;
  }
  function durationSortValue(uc) {
    if (!uc) return Number.MAX_SAFE_INTEGER;
    // hours before days; then by count.
    return (uc.unit === 'days' ? 100000 : 0) + uc.count;
  }

  /**
   * @param {Array} prices  cfg.prices (mixed categories)
   * @param {object} [opts] { includeInactive?:boolean } — default true (admin sees all)
   * @returns {Array<{offering_key, label, rows:Array<{pid,duration_key,unit,count,duration_label,amount_cents,active,invalid}>}>}
   */
  function buildEquipmentPricingList(prices, opts) {
    var list = Array.isArray(prices) ? prices : [];
    var byKey = {};
    var order = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!isRentalCategory(p)) continue;
      var key = priceOfferingKey(p);
      if (!key || EXCLUDED_OFFERING_KEYS[key]) continue;
      if (!byKey[key]) { byKey[key] = { offering_key: key, label: '', rows: [] }; order.push(key); }
      var item = byKey[key];
      var label = String((p && (p.label || p.display_name || p.offering_label)) || '').trim();
      if (label && (!item.label || item.label === humanizeOfferingKey(key))) item.label = label;
      var dk = priceDurationKey(p);
      var uc = parseRentalDurationKey(dk);
      item.rows.push({
        pid: (p && p.id) ? String(p.id) : null,
        duration_key: dk,
        unit: uc ? uc.unit : null,
        count: uc ? uc.count : null,
        duration_label: uc ? formatRentalDuration(uc.unit, uc.count) : String(dk),
        amount_cents: priceAmountCents(p),
        active: !(p && p.active === false),
        invalid: !uc,
      });
    }
    var out = [];
    for (var j = 0; j < order.length; j++) {
      var it = byKey[order[j]];
      if (!it.label) it.label = humanizeOfferingKey(it.offering_key);
      it.rows.sort(function (a, b) {
        return durationSortValue(a.unit ? { unit: a.unit, count: a.count } : null)
          - durationSortValue(b.unit ? { unit: b.unit, count: b.count } : null);
      });
      out.push(it);
    }
    out.sort(function (a, b) {
      var ra = offeringRank(a.offering_key), rb = offeringRank(b.offering_key);
      if (ra !== rb) return ra - rb;
      return String(a.label).localeCompare(String(b.label));
    });
    return out;
  }

  return {
    buildEquipmentPricingList: buildEquipmentPricingList,
    humanizeOfferingKey: humanizeOfferingKey,
  };
}));
