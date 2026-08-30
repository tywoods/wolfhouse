'use strict';

/**
 * SAME-DESK-002 — email grounded-tool owners over the canonical Front Desk
 * catalog/quote services. No parallel booking/quote brain. Read-only.
 */

const {
  CATALOG_CHANNELS,
  buildSunsetCatalogCommand,
} = require('./luna-front-desk-catalog-service');
const {
  QUOTE_CHANNELS,
  buildSunsetQuoteCommand,
} = require('./luna-front-desk-quote-service');

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function catalogFactFromOffering(authority, offering) {
  if (!offering || offering.active === false) return null;
  const amount = offering.unit_amount_cents != null
    ? offering.unit_amount_cents
    : (offering.price && offering.price.amount_cents);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const label = asText(offering.label);
  const item = asText(offering.offering_id)
    || asText(offering.offering_item_code)
    || asText(offering.item_code)
    || asText(offering.offering_key);
  if (!label || !item) return null;
  return {
    fact: 'catalog',
    status: 'found',
    client_id: authority.client_id,
    location_id: authority.location_id,
    item,
    label,
    currency: asText(offering.currency) || 'EUR',
    amount_cents: amount,
    active: true,
  };
}

function quoteFactFromQuoteBody(authority, body) {
  if (!body || body.success !== true) return null;
  const amount = body.total_cents != null ? body.total_cents : body.unit_amount_cents;
  const label = asText(body.label);
  const item = asText(body.offering_id) || asText(body.offering_item_code);
  if (!label || !item || !Number.isSafeInteger(amount) || amount <= 0) return null;
  return {
    fact: 'catalog',
    status: 'found',
    client_id: authority.client_id,
    location_id: authority.location_id,
    item,
    label,
    currency: asText(body.currency) || 'EUR',
    amount_cents: amount,
    active: true,
  };
}

function offeringMatchesLookup(offering, lookup) {
  const needle = asText(lookup);
  if (!needle) return true;
  return asText(offering.offering_id) === needle
    || asText(offering.offering_key) === needle
    || asText(offering.offering_item_code) === needle
    || asText(offering.item_code) === needle
    || asText(offering.label) === needle;
}

function createEmailLunaFrontDeskQueryOwners(opts) {
  const src = opts && typeof opts === 'object' ? opts : {};
  const locationKey = asText(src.locationKey);
  const executeCatalog = src.executeCatalog;
  const executeQuote = src.executeQuote;
  const catalogExecOpts = src.catalogExecOpts || {};
  const quoteExecOpts = src.quoteExecOpts || src.catalogExecOpts || {};
  const now = src.now instanceof Date ? src.now : undefined;
  const defaultServiceDates = Array.isArray(src.defaultServiceDates)
    ? src.defaultServiceDates.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    : [];
  if (!locationKey || typeof executeCatalog !== 'function') {
    throw new TypeError('email_luna_front_desk_query_owners_invalid');
  }

  async function quoteOffering(authority, offeringId) {
    if (typeof executeQuote !== 'function' || !offeringId) return null;
    const cmd = buildSunsetQuoteCommand({
      channel: QUOTE_CHANNELS.LUNA_EMAIL,
      trustedLocationId: locationKey,
      transportBody: {
        require_db: true,
        offering_id: offeringId,
        quantity: 1,
        ...(defaultServiceDates.length ? { service_dates: defaultServiceDates } : {}),
      },
      now,
    });
    if (!cmd.ok) return null;
    const result = await Promise.resolve(executeQuote(cmd.command, quoteExecOpts));
    if (!result || result.ok !== true) return null;
    return quoteFactFromQuoteBody(authority, result.body);
  }

  async function catalog(authority, args) {
    const cmd = buildSunsetCatalogCommand({
      channel: CATALOG_CHANNELS.LUNA_EMAIL,
      trustedLocationId: locationKey,
      transportBody: { require_db: true },
      now,
    });
    if (!cmd.ok) return [];
    const result = await Promise.resolve(executeCatalog(cmd.command, catalogExecOpts));
    if (!result || result.ok !== true) return [];
    const offerings = (result.body && Array.isArray(result.body.offerings))
      ? result.body.offerings
      : [];
    const lookup = args && args.lookup;
    const match = offerings.find((row) => offeringMatchesLookup(row, lookup)
      && catalogFactFromOffering(authority, row));
    const quoted = match
      ? await quoteOffering(
        authority,
        asText(match.offering_id) || asText(match.offering_item_code) || asText(match.item_code),
      )
      : null;
    if (quoted) return quoted;
    const fact = catalogFactFromOffering(authority, match);
    return fact ? fact : [];
  }

  async function missing() {
    return [];
  }

  return Object.freeze({
    catalog,
    availability: missing,
    policy: missing,
    booking: missing,
    payment: missing,
  });
}

module.exports = {
  createEmailLunaFrontDeskQueryOwners,
  catalogFactFromOffering,
  quoteFactFromQuoteBody,
};
