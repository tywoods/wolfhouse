'use strict';

/**
 * Manual discovery source adapter (Luna Sales Chapter 7).
 *
 * Adapts one operator-entered proposal into a normalized ProposedProspect.
 * Does not call Google Maps, Apollo, web search, or any external API.
 * Does not create prospects — preview/import orchestration lives in crowsnest-sales.js.
 */

const {
  DISCOVERY_QUALITY_CONTROLS,
  DISCOVERY_RATE_CONTROLS,
  SCHEMA_VERSION,
  assessProposalQuality,
  buildDiscoveryProvenance,
  validateProposedProspect,
} = require('./crowsnest-sales-discovery-contract');

const SOURCE_NAME = 'manual';

const KNOWN_INPUT_KEYS = Object.freeze([
  'business_name',
  'businessName',
  'website_url',
  'websiteUrl',
  'city',
  'country_code',
  'countryCode',
  'category',
  'source_note',
  'sourceNote',
  'external_id',
  'externalId',
  'correlation_id',
  'correlationId',
]);

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readField(input, snake, camel) {
  if (!input || typeof input !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(input, snake) && input[snake] != null) {
    return trimString(input[snake]);
  }
  if (Object.prototype.hasOwnProperty.call(input, camel) && input[camel] != null) {
    return trimString(input[camel]);
  }
  return '';
}

/**
 * Adapt a single manual operator proposal into the discovery contract shape.
 * @param {object} input
 * @returns {{ ok: true, proposal: object, provenance: object, quality: object, schema_version: string, prospect_created: false, auto_created: false }
 *   | { ok: false, errors: string[], prospect_created: false, auto_created: false }}
 */
function adaptManualDiscoveryProposal(input = {}) {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: ['input: must_be_object'],
      prospect_created: false,
      auto_created: false,
    };
  }

  const unknown = Object.keys(input).filter((key) => !KNOWN_INPUT_KEYS.includes(key));
  if (unknown.length) {
    return {
      ok: false,
      errors: unknown.map((key) => `${key}: unknown_field`),
      prospect_created: false,
      auto_created: false,
    };
  }

  if (DISCOVERY_RATE_CONTROLS.max_proposals_per_adapt !== 1) {
    return {
      ok: false,
      errors: ['rate_controls: max_proposals_per_adapt_must_be_1'],
      prospect_created: false,
      auto_created: false,
    };
  }

  const businessName = readField(input, 'business_name', 'businessName');
  const websiteUrl = readField(input, 'website_url', 'websiteUrl');
  const city = readField(input, 'city', 'city');
  const countryCode = readField(input, 'country_code', 'countryCode');
  const category = readField(input, 'category', 'category');
  const sourceNote = readField(input, 'source_note', 'sourceNote');
  const externalId = readField(input, 'external_id', 'externalId');
  const correlationId = readField(input, 'correlation_id', 'correlationId');

  if (!businessName && !websiteUrl) {
    return {
      ok: false,
      errors: [
        'business_name: business_name_or_website_required',
        'website_url: business_name_or_website_required',
      ],
      prospect_created: false,
      auto_created: false,
    };
  }

  if (businessName.length > DISCOVERY_QUALITY_CONTROLS.max_business_name_length) {
    return {
      ok: false,
      errors: ['business_name: too_long'],
      prospect_created: false,
      auto_created: false,
    };
  }
  if (websiteUrl.length > DISCOVERY_QUALITY_CONTROLS.max_website_url_length) {
    return {
      ok: false,
      errors: ['website_url: too_long'],
      prospect_created: false,
      auto_created: false,
    };
  }
  if (city.length > DISCOVERY_QUALITY_CONTROLS.max_city_length) {
    return {
      ok: false,
      errors: ['city: too_long'],
      prospect_created: false,
      auto_created: false,
    };
  }
  if (countryCode.length > DISCOVERY_QUALITY_CONTROLS.max_country_code_length) {
    return {
      ok: false,
      errors: ['country_code: too_long'],
      prospect_created: false,
      auto_created: false,
    };
  }
  if (category.length > DISCOVERY_QUALITY_CONTROLS.max_category_length) {
    return {
      ok: false,
      errors: ['category: too_long'],
      prospect_created: false,
      auto_created: false,
    };
  }
  if (sourceNote.length > DISCOVERY_QUALITY_CONTROLS.max_source_note_length) {
    return {
      ok: false,
      errors: ['source_note: too_long'],
      prospect_created: false,
      auto_created: false,
    };
  }

  const requestReference = sourceNote || 'operator-entry';
  const candidate = {
    business_name: businessName,
    website_url: websiteUrl,
    location: {
      city,
      country_code: countryCode,
    },
    category,
    source_reference: {
      source_name: SOURCE_NAME,
      external_id: externalId,
      request_reference: requestReference,
    },
  };

  const validated = validateProposedProspect(candidate);
  if (!validated.ok) {
    return {
      ok: false,
      errors: validated.errors,
      prospect_created: false,
      auto_created: false,
    };
  }

  const provenance = buildDiscoveryProvenance({
    source_name: SOURCE_NAME,
    external_id: externalId,
    request_reference: requestReference,
    source_url_or_request_reference: requestReference,
    result_status: 'normalized',
    limitations: 'Manual operator entry only; no live provider fetch.',
    confidence: 'high',
    correlation_id: correlationId,
  });

  return {
    ok: true,
    schema_version: SCHEMA_VERSION,
    proposal: validated.proposal,
    provenance,
    quality: assessProposalQuality(validated.proposal),
    prospect_created: false,
    auto_created: false,
  };
}

module.exports = {
  SOURCE_NAME,
  adaptManualDiscoveryProposal,
};
