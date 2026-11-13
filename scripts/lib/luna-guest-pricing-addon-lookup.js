'use strict';

/**
 * Map Staff Settings Rentals + Services (Admin Pricing) into the catalog-service
 * matcher Luna already calls, and shape a pricing item for add-catalog-service.
 *
 * Tenant_services camps stay on lookup_catalog_service; this layer is the missing
 * Staff > Rentals / Staff > Services search (FLIPFLOPS €10/day).
 */

const {
  matchCatalogServices,
  buildCatalogServiceReply,
  phraseMatches,
} = require('./luna-guest-catalog-services');
const { splitRentalCode } = require('./wolfhouse-pricing-resolve');

function nightsBetween(checkIn, checkOut) {
  const a = Date.parse(String(checkIn || '') + 'T00:00:00Z');
  const b = Date.parse(String(checkOut || '') + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.round((b - a) / 86400000);
}

function extraKeywords(label, code) {
  const out = [];
  const add = (v) => {
    const s = String(v || '').trim();
    if (s && out.indexOf(s) === -1) out.push(s);
  };
  add(label);
  add(code);
  add(String(code || '').replace(/_/g, ' '));
  add(String(label || '').replace(/_/g, ' '));
  return out;
}

function pickRentalDayCents(rental) {
  const durations = Array.isArray(rental && rental.durations) ? rental.durations : [];
  const oneDay = durations.find((d) => d && (d.duration === '1_day' || d.duration === 'day'));
  const priced = oneDay || durations.find((d) => d && Number(d.amount_cents) > 0);
  return priced && Number(priced.amount_cents) > 0 ? Number(priced.amount_cents) : null;
}

function pickServiceCents(svc) {
  const price = svc && svc.price;
  if (price && Number(price.amount_cents) > 0) return Number(price.amount_cents);
  if (Number(svc && svc.price_cents) > 0) return Number(svc.price_cents);
  return null;
}

function staffSettingsAddOnsToCatalogRows(pricingView) {
  const view = pricingView || {};
  const rows = [];
  for (const rental of (view.rentals || [])) {
    if (!rental) continue;
    const cents = pickRentalDayCents(rental);
    if (cents == null) continue;
    const name = String(rental.label || rental.code || '').trim();
    if (!name) continue;
    rows.push({
      id: rental.id != null ? String(rental.id) : null,
      name,
      keywords: extraKeywords(name, rental.code),
      price_cents: cents,
      price_unit: 'per_day',
      per_guest: false,
      catalog_kind: 'rental',
      item_code: rental.code,
      active: true,
      luna_visible: true,
    });
  }
  for (const svc of (view.services || [])) {
    if (!svc) continue;
    const cents = pickServiceCents(svc);
    if (cents == null) continue;
    const name = String(svc.label || svc.code || '').trim();
    if (!name) continue;
    const unit = svc.price && svc.price.unit;
    rows.push({
      id: svc.id != null ? String(svc.id) : null,
      name,
      keywords: extraKeywords(name, svc.code),
      price_cents: cents,
      price_unit: unit === 'per_day' || unit === 'day' ? 'per_day' : 'per_stay',
      per_guest: false,
      catalog_kind: 'service',
      item_code: svc.code,
      active: true,
      luna_visible: true,
    });
  }
  return rows;
}

function attachPricingItemIds(pricingView, dbItems) {
  const items = Array.isArray(dbItems) ? dbItems : [];
  const idOf = (type, code) => {
    const row = items.find((it) => it && it.item_type === type && it.item_code === code);
    return row && row.id != null ? String(row.id) : null;
  };
  const view = pricingView || {};
  return {
    rentals: (view.rentals || []).map((r) => Object.assign({}, r, {
      id: r.id || idOf('rental', r.code),
    })),
    services: (view.services || []).map((s) => Object.assign({}, s, {
      id: s.id || idOf('service', s.code),
    })),
  };
}

function lookupStaffSettingsAddOn(messageText, catalogs, ctx) {
  const c = catalogs || {};
  const tenant = Array.isArray(c.tenantServices) ? c.tenantServices : [];
  const pricingRows = staffSettingsAddOnsToCatalogRows(c.pricingView);
  const matches = matchCatalogServices(messageText, pricingRows.concat(tenant));
  const top = matches[0] || null;
  if (!top) return null;
  const reply = buildCatalogServiceReply(top, ctx || {});
  return Object.assign({}, top, { reply });
}

function ruleAmountForItem(item, rules) {
  const type = item && item.item_type;
  const code = item && item.item_code;
  const list = Array.isArray(rules) ? rules : [];
  if (type === 'rental') {
    const oneDay = list.find((r) => r && r.item_type === 'rental'
      && r.active !== false
      && splitRentalCode(r.item_code).offering === code
      && (splitRentalCode(r.item_code).duration === '1_day'
        || splitRentalCode(r.item_code).duration === 'day'));
    const any = oneDay || list.find((r) => r && r.item_type === 'rental'
      && r.active !== false
      && splitRentalCode(r.item_code).offering === code
      && Number(r.amount_cents) > 0);
    return any && Number(any.amount_cents) > 0 ? Number(any.amount_cents) : null;
  }
  const found = list.find((r) => r && r.item_type === type && r.item_code === code
    && r.active !== false && Number(r.amount_cents) > 0);
  return found ? Number(found.amount_cents) : null;
}

function pricingItemToTenantServiceShape(item, rules) {
  if (!item || (item.item_type !== 'rental' && item.item_type !== 'service')) return null;
  const cents = ruleAmountForItem(item, rules);
  if (cents == null) return null;
  const isRental = item.item_type === 'rental';
  return {
    id: String(item.id),
    name: String(item.label || item.item_code),
    category: item.item_type,
    price_cents: cents,
    price_unit: isRental ? 'per_day' : 'per_stay',
    per_guest: false,
    start_date: null,
    end_date: null,
    catalog_kind: item.item_type,
    item_code: item.item_code,
  };
}

function planPricingAddonCharge({ item, rules, checkIn, checkOut, quantity }) {
  const shaped = pricingItemToTenantServiceShape(item, rules);
  if (!shaped) return { ok: false, reason: 'unpriced_item' };
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
  const nights = shaped.price_unit === 'per_day' ? nightsBetween(checkIn, checkOut) : 1;
  if (shaped.price_unit === 'per_day' && nights < 1) return { ok: false, reason: 'need_nights' };
  const amount_due_cents = shaped.price_cents * nights * qty;
  return {
    ok: true,
    amount_due_cents,
    unit_cents: shaped.price_cents,
    nights_charged: shaped.price_unit === 'per_day' ? nights : 1,
    quantity: qty,
    catalog_kind: shaped.catalog_kind,
    name: shaped.name,
  };
}

module.exports = {
  lookupStaffSettingsAddOn,
  staffSettingsAddOnsToCatalogRows,
  attachPricingItemIds,
  pricingItemToTenantServiceShape,
  planPricingAddonCharge,
  phraseMatches,
  nightsBetween,
};
