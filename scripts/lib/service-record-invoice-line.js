'use strict';

const fs = require('fs');
const path = require('path');

const {
  formatRentalPeopleDaysLine,
  resolveRentalPeopleFromMeta,
} = require('./rental-breakdown-text');

const DEFAULT_PRICING_PATH = path.join(
  __dirname,
  '../../config/clients/wolfhouse-somo.pricing.json',
);

function parseServiceRecordMetadata(meta) {
  if (!meta) return {};
  if (typeof meta === 'string') {
    try {
      return JSON.parse(meta);
    } catch {
      return {};
    }
  }
  return meta;
}

function wolfhouseRentalDayRatesFromPricing(pricingConfig) {
  const addons = (pricingConfig && pricingConfig.add_ons) || {};
  return {
    wetsuit_rental: Number(addons.wetsuit_rental?.price_cents) || 500,
    soft_top_rental: Number(addons.soft_top_rental?.price_cents) || 1500,
    hard_board_rental: Number(addons.hard_board_rental?.price_cents) || 2000,
    wetsuit_soft_top_combo: Number(addons.wetsuit_soft_top_combo?.price_cents) || 1500,
    wetsuit_hard_board_combo: Number(addons.wetsuit_hard_board_combo?.price_cents) || 2000,
  };
}

let cachedRates = null;

function loadWolfhouseRentalDayRates(pricingPath = DEFAULT_PRICING_PATH) {
  if (cachedRates) return cachedRates;
  const cfg = JSON.parse(fs.readFileSync(pricingPath, 'utf8'));
  cachedRates = wolfhouseRentalDayRatesFromPricing(cfg);
  return cachedRates;
}

function resetWolfhouseRentalDayRatesCache() {
  cachedRates = null;
}

/**
 * Invoice/Payments display quantity for rental rows.
 * Uses rental_days only when the row is an aggregated span (quantity === rental_days).
 */
function resolveRentalInvoiceDisplayQty({ quantity, serviceType, metadata }) {
  const meta = parseServiceRecordMetadata(metadata);
  const qty = quantity != null ? Number(quantity) : null;
  if (serviceType !== 'wetsuit' && serviceType !== 'surfboard') {
    return qty != null && qty > 0 ? qty : null;
  }
  const spanDays = meta.rental_days != null ? Number(meta.rental_days) : null;
  if (qty != null && spanDays != null && qty === spanDays && qty > 0) {
    return spanDays;
  }
  if (qty != null && qty > 0) return qty;
  if (spanDays != null && spanDays > 0) return spanDays;
  return null;
}

function resolveBoardRentalRateCents(meta, rates) {
  const code = meta.pricing_addon_code || meta.source_addon_code || meta.source_quote_line_code;
  if (code === 'hard_board_rental' || code === 'wetsuit_hard_board_combo') {
    return rates.hard_board_rental;
  }
  if (code === 'soft_top_rental' || code === 'wetsuit_soft_top_combo') {
    return rates.soft_top_rental;
  }
  if (meta.board_variant === 'hard' || meta.staff_ui_service_type === 'hard_board') {
    return rates.hard_board_rental;
  }
  if (meta.board_variant === 'soft' || meta.staff_ui_service_type === 'soft_board') {
    return rates.soft_top_rental;
  }
  return null;
}

/**
 * Configured day-rate for wetsuit/surfboard invoice lines (not derived from amount/qty when inconsistent).
 */
function resolveRentalInvoiceUnitCents({
  serviceType,
  metadata,
  totalCents,
  displayQty,
  rates,
}) {
  const meta = parseServiceRecordMetadata(metadata);
  const rateTable = rates || loadWolfhouseRentalDayRates();

  if (meta.unit_cents != null && Number(meta.unit_cents) >= 0) {
    return Number(meta.unit_cents);
  }

  if (serviceType === 'wetsuit') {
    if (meta.combo_part === 'wetsuit') return 0;
    const code = meta.pricing_addon_code || meta.source_addon_code || meta.source_quote_line_code;
    if (code === 'wetsuit_rental') return rateTable.wetsuit_rental;
    if (Number(totalCents) === 0) return 0;
    return rateTable.wetsuit_rental;
  }

  if (serviceType === 'surfboard') {
    const boardRate = resolveBoardRentalRateCents(meta, rateTable);
    if (boardRate != null) return boardRate;
  }

  if (
    totalCents != null
    && displayQty != null
    && displayQty > 0
    && Number(totalCents) >= 0
    && Number(totalCents) % displayQty === 0
  ) {
    return Number(totalCents) / displayQty;
  }
  return null;
}

function normalizeSplitRentalMetadata(meta, serviceType) {
  const next = { ...(meta || {}) };
  if (serviceType !== 'wetsuit' && serviceType !== 'surfboard') return next;
  const span = Number(next.rental_days) || 0;
  if (span > 1) {
    next.rental_span_days = span;
    next.rental_days = 1;
  }
  return next;
}

function formatEurCents(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return null;
  return `\u20ac${(Number(cents) / 100).toFixed(2)}`;
}

function formatServiceRecordInvoiceLineText(sr, opts = {}) {
  const meta = parseServiceRecordMetadata(sr.metadata);
  const label = opts.typeLabel
    ? opts.typeLabel(sr.service_type, meta)
    : (sr.service_type || '\u2014');
  const billable = opts.billableCents
    ? opts.billableCents(sr)
    : (sr.amount_due_cents != null ? Number(sr.amount_due_cents) : 0);
  const displayQty = resolveRentalInvoiceDisplayQty({
    quantity: sr.quantity,
    serviceType: sr.service_type,
    metadata: meta,
  });
  const totalCents = billable;
  const rentalPeople = resolveRentalPeopleFromMeta(meta, sr.quantity, sr.service_type);
  const rentalDays = meta.rental_days != null ? Number(meta.rental_days) : displayQty;

  if (totalCents == null || (totalCents === 0 && sr.amount_due_cents == null)) {
    return `${label} \u2014 Not available`;
  }

  if (
    (sr.service_type === 'wetsuit' || sr.service_type === 'surfboard')
    && rentalDays != null && rentalDays > 0
    && rentalPeople != null && rentalPeople > 0
  ) {
    if (totalCents === 0 && meta.combo_part === 'wetsuit') {
      return formatRentalPeopleDaysLine({
        label,
        days: rentalDays,
        people: rentalPeople,
        totalCents: 0,
        freeNote: 'free with board 🤙',
      });
    }
    return formatRentalPeopleDaysLine({
      label,
      days: rentalDays,
      people: rentalPeople,
      totalCents,
    });
  }

  const unitLabel = opts.unitLabel ? opts.unitLabel(sr.service_type) : null;
  const unitCents = resolveRentalInvoiceUnitCents({
    serviceType: sr.service_type,
    metadata: meta,
    totalCents,
    displayQty,
    rates: opts.rates,
  });

  if (displayQty != null && displayQty > 0 && totalCents >= 0) {
    if (unitLabel && unitCents != null) {
      return `${label} \u2014 ${displayQty} ${unitLabel} \u00d7 ${formatEurCents(unitCents)} = ${formatEurCents(totalCents)}`;
    }
    return `${label} \u2014 ${displayQty} \u00d7 ${formatEurCents(totalCents)} = ${formatEurCents(totalCents)}`;
  }
  return `${label} \u2014 ${formatEurCents(totalCents)}`;
}

module.exports = {
  parseServiceRecordMetadata,
  wolfhouseRentalDayRatesFromPricing,
  loadWolfhouseRentalDayRates,
  resetWolfhouseRentalDayRatesCache,
  resolveRentalInvoiceDisplayQty,
  resolveRentalInvoiceUnitCents,
  normalizeSplitRentalMetadata,
  formatServiceRecordInvoiceLineText,
};
