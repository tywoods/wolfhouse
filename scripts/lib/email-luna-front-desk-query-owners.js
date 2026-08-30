'use strict';

/**
 * SAME-DESK-002 — email grounded-tool owners over the canonical Front Desk
 * catalog/quote services. No parallel booking/quote brain. Read-only.
 *
 * Empty lookup never selects the first offering. Quote/stock failure is
 * missing_fact (no catalog list-price fallback). Caller authority must match
 * the locked conversation location the factory was bound to.
 */

const {
  CATALOG_CHANNELS,
  buildSunsetCatalogCommand,
} = require('./luna-front-desk-catalog-service');
const {
  QUOTE_CHANNELS,
  buildSunsetQuoteCommand,
} = require('./luna-front-desk-quote-service');

const CATALOG_QUESTION = /\b(?:how\s+much|price|cost|precio|cuesta|cuanto|rent(?:al)?|hire|alquil|kayak|board|lesson|clase|tabla|pack|course|curso)\b/i;

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

function identityValues(offering) {
  return [
    asText(offering && offering.offering_id),
    asText(offering && offering.offering_key),
    asText(offering && offering.offering_item_code),
    asText(offering && offering.item_code),
    asText(offering && offering.label),
  ].filter(Boolean);
}

function paddedHay(value) {
  return ` ${asText(value).toLowerCase().replace(/[^a-z0-9áéíóúñü]+/g, ' ').trim()} `;
}

const GENERIC_OFFERING_WORDS = new Set([
  'rental', 'rentals', 'lesson', 'lessons', 'clase', 'clases', 'pack', 'course',
  'price', 'the', 'and', 'with', 'for', 'day', 'days', 'week', 'hour', 'hours',
  'half', 'full', 'item', 'offering', 'class', 'group', 'grupo',
]);

function offeringIdentityTokens(offering) {
  const tokens = [];
  for (const value of identityValues(offering)) {
    const lower = value.toLowerCase();
    tokens.push(lower);
    const words = lower.replace(/[_-]+/g, ' ').split(/\s+/)
      .filter((word) => word.length >= 4 && !GENERIC_OFFERING_WORDS.has(word));
    for (const word of words) tokens.push(word);
  }
  return tokens;
}

function offeringMatchesLookup(offering, lookup) {
  const needle = asText(lookup);
  if (!needle) return false;
  const exact = needle.toLowerCase();
  if (identityValues(offering).some((id) => id.toLowerCase() === exact)) return true;
  const hay = paddedHay(needle);
  return offeringIdentityTokens(offering).some((token) => (
    token.length >= 4 && hay.includes(` ${token} `)
  ));
}

function uniqueMatchingOffering(offerings, lookup, authority) {
  const needle = asText(lookup);
  if (!needle || !Array.isArray(offerings)) return null;
  const matches = offerings.filter((row) => (
    offeringMatchesLookup(row, needle) && catalogFactFromOffering(authority, row)
  ));
  return matches.length === 1 ? matches[0] : null;
}

function assertBoundAuthority(authority, expectedClientId, expectedLocationId) {
  if (!authority
      || asText(authority.client_id) !== expectedClientId
      || asText(authority.location_id) !== expectedLocationId) {
    const err = new Error('authority_location_mismatch');
    err.code = 'authority_location_mismatch';
    throw err;
  }
}

function createEmailLunaBoundedCatalogClassifier() {
  return function classifyIntent(input) {
    const src = input && typeof input === 'object' ? input : {};
    const subject = asText(src.subject);
    const body = asText(src.body_text);
    const text = `${subject}\n${body}`.trim();
    const language = src.language === 'es' ? 'es' : 'en';
    const authority = src.authority && typeof src.authority === 'object' ? src.authority : {};
    const base = {
      language,
      identity: 'matched',
      requested_location_id: asText(authority.location_id),
      explicit_human_request: false,
      attachment_interpretation_required: false,
      unsafe_transactional_request: false,
    };
    if (!text || !CATALOG_QUESTION.test(text)) {
      return {
        ...base,
        intent: 'unsupported_intent',
        intent_support: 'unsupported',
      };
    }
    return {
      ...base,
      intent: 'catalog_question',
      intent_support: 'supported',
      required_facts: ['catalog'],
      lookup: text,
    };
  };
}

function createEmailLunaFrontDeskQueryOwners(opts) {
  const src = opts && typeof opts === 'object' ? opts : {};
  const locationKey = asText(src.locationKey);
  const expectedClientId = asText(src.expectedClientId);
  const expectedLocationId = asText(src.expectedLocationId);
  const executeCatalog = src.executeCatalog;
  const executeQuote = src.executeQuote;
  const catalogExecOpts = src.catalogExecOpts || {};
  const quoteExecOpts = src.quoteExecOpts || src.catalogExecOpts || {};
  const now = src.now instanceof Date ? src.now : undefined;
  const defaultServiceDates = Array.isArray(src.defaultServiceDates)
    ? src.defaultServiceDates.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    : [];
  if (!locationKey
      || !expectedClientId
      || !expectedLocationId
      || typeof executeCatalog !== 'function'
      || typeof executeQuote !== 'function') {
    throw new TypeError('email_luna_front_desk_query_owners_invalid');
  }

  async function quoteOffering(authority, offeringId) {
    if (!offeringId) return null;
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
    let result;
    try {
      result = await Promise.resolve(executeQuote(cmd.command, quoteExecOpts));
    } catch {
      return null;
    }
    if (!result || result.ok !== true) return null;
    return quoteFactFromQuoteBody(authority, result.body);
  }

  async function catalog(authority, args) {
    assertBoundAuthority(authority, expectedClientId, expectedLocationId);
    const lookup = args && args.lookup;
    if (!asText(lookup)) return [];
    const cmd = buildSunsetCatalogCommand({
      channel: CATALOG_CHANNELS.LUNA_EMAIL,
      trustedLocationId: locationKey,
      transportBody: { require_db: true },
      now,
    });
    if (!cmd.ok) return [];
    let result;
    try {
      result = await Promise.resolve(executeCatalog(cmd.command, catalogExecOpts));
    } catch {
      return [];
    }
    if (!result || result.ok !== true) return [];
    const offerings = (result.body && Array.isArray(result.body.offerings))
      ? result.body.offerings
      : [];
    const match = uniqueMatchingOffering(offerings, lookup, authority);
    if (!match) return [];
    const quoted = await quoteOffering(
      authority,
      asText(match.offering_id) || asText(match.offering_item_code) || asText(match.item_code),
    );
    return quoted || [];
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
  createEmailLunaBoundedCatalogClassifier,
  catalogFactFromOffering,
  quoteFactFromQuoteBody,
  offeringMatchesLookup,
};
