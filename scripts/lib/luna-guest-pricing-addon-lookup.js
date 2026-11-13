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
  const picked = pickRentalPrice(rental);
  return picked ? picked.cents : null;
}

function isDayDuration(duration) {
  const d = String(duration || '').toLowerCase();
  return d === '1_day' || d === 'day';
}

function isHalfDayDuration(duration) {
  const d = String(duration || '').toLowerCase();
  return d === 'half_day' || d === '0.5_day' || d === 'half-day';
}

function durationToPriceUnit(duration) {
  if (isDayDuration(duration)) return 'per_day';
  if (isHalfDayDuration(duration)) return 'per_half_day';
  return 'per_stay';
}

function pickRentalPrice(rental) {
  const durations = Array.isArray(rental && rental.durations) ? rental.durations : [];
  const priced = (d) => d && Number(d.amount_cents) > 0;
  const oneDay = durations.find((d) => priced(d) && isDayDuration(d.duration));
  if (oneDay) return { cents: Number(oneDay.amount_cents), unit: 'per_day', duration: oneDay.duration };
  const half = durations.find((d) => priced(d) && isHalfDayDuration(d.duration));
  if (half) return { cents: Number(half.amount_cents), unit: 'per_half_day', duration: half.duration };
  const any = durations.find(priced);
  if (!any) return null;
  return {
    cents: Number(any.amount_cents),
    unit: durationToPriceUnit(any.duration),
    duration: any.duration,
  };
}

function pickServiceCents(svc) {
  const price = svc && svc.price;
  if (price && Number(price.amount_cents) > 0) return Number(price.amount_cents);
  if (Number(svc && svc.price_cents) > 0) return Number(svc.price_cents);
  return null;
}

function serviceUnitFromPrice(unit) {
  const u = String(unit || '').toLowerCase();
  if (u === 'per_day' || u === 'day') return 'per_day';
  if (u === 'per_half_day' || u === 'half_day' || u === 'half-day') return 'per_half_day';
  return 'per_stay';
}

function staffSettingsAddOnsToCatalogRows(pricingView) {
  const view = pricingView || {};
  const rows = [];
  for (const rental of (view.rentals || [])) {
    if (!rental) continue;
    const picked = pickRentalPrice(rental);
    if (!picked) continue;
    const name = String(rental.label || rental.code || '').trim();
    if (!name) continue;
    rows.push({
      id: rental.id != null ? String(rental.id) : null,
      name,
      keywords: extraKeywords(name, rental.code),
      price_cents: picked.cents,
      price_unit: picked.unit,
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
      price_unit: serviceUnitFromPrice(unit),
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

function ruleForItem(item, rules) {
  const type = item && item.item_type;
  const code = item && item.item_code;
  const list = Array.isArray(rules) ? rules : [];
  if (type === 'rental') {
    const offering = (r) => r && r.item_type === 'rental'
      && r.active !== false
      && splitRentalCode(r.item_code).offering === code
      && Number(r.amount_cents) > 0;
    const oneDay = list.find((r) => offering(r) && isDayDuration(splitRentalCode(r.item_code).duration));
    const half = list.find((r) => offering(r) && isHalfDayDuration(splitRentalCode(r.item_code).duration));
    const any = oneDay || half || list.find(offering);
    if (!any) return null;
    const duration = splitRentalCode(any.item_code).duration;
    return { cents: Number(any.amount_cents), unit: durationToPriceUnit(duration) };
  }
  const found = list.find((r) => r && r.item_type === type && r.item_code === code
    && r.active !== false && Number(r.amount_cents) > 0);
  if (!found) return null;
  return { cents: Number(found.amount_cents), unit: serviceUnitFromPrice(found.unit) };
}

function pricingItemToTenantServiceShape(item, rules) {
  if (!item || (item.item_type !== 'rental' && item.item_type !== 'service')) return null;
  const picked = ruleForItem(item, rules);
  if (!picked) return null;
  return {
    id: String(item.id),
    name: String(item.label || item.item_code),
    category: item.item_type,
    price_cents: picked.cents,
    price_unit: picked.unit,
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
  return chargeStaffSettingsAddon(shaped, {
    quantity,
    stayNights: nightsBetween(checkIn, checkOut),
  });
}

function chargeStaffSettingsAddon(svcRow, { quantity, stayNights } = {}) {
  if (!svcRow) return { ok: false, reason: 'unpriced_item' };
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
  const perDay = svcRow.price_unit === 'per_day';
  const nights = perDay ? Math.max(0, Math.floor(Number(stayNights) || 0)) : 1;
  if (perDay && nights < 1) return { ok: false, reason: 'need_nights' };
  return {
    ok: true,
    amount_due_cents: Math.round(Number(svcRow.price_cents || 0) * nights * qty),
    unit_cents: Number(svcRow.price_cents || 0),
    nights_charged: nights,
    quantity: qty,
    catalog_kind: svcRow.catalog_kind,
    name: svcRow.name,
  };
}

module.exports = {
  lookupStaffSettingsAddOn,
  staffSettingsAddOnsToCatalogRows,
  attachPricingItemIds,
  pricingItemToTenantServiceShape,
  planPricingAddonCharge,
  chargeStaffSettingsAddon,
  phraseMatches,
  nightsBetween,
};
