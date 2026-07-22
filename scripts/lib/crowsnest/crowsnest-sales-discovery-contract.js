'use strict';

/**
 * Crowsnest Luna Sales — Discovery Source Contract (Chapter 7).
 *
 * Provider-neutral domain shapes for lead-discovery sources.
 * Manual adapter: crowsnest-sales-discovery-manual.js.
 * Maps dry-run adapter shell (Chapter 8): crowsnest-sales-discovery-maps.js
 * (fixture-only; still no live Maps HTTP / API key / SDK).
 * No Apollo / web search / external HTTP. No auto-create prospects.
 *
 * @typedef {object} DiscoveryCriteria
 * @property {string} [market]
 * @property {string} [category]
 * @property {string} [city]
 * @property {string} [country_code]
 * @property {string} [query]
 *
 * @typedef {object} ProposedProspectLocation
 * @property {string} city
 * @property {string} country_code
 *
 * @typedef {object} DiscoverySourceReference
 * @property {string} source_name
 * @property {string} external_id
 * @property {string} request_reference
 *
 * @typedef {object} ProposedProspect
 * @property {string} business_name
 * @property {string} website_url
 * @property {ProposedProspectLocation} location
 * @property {string} category
 * @property {DiscoverySourceReference} source_reference
 *
 * @typedef {object} DiscoveryProvenance
 * @property {string} source_name
 * @property {string} [external_id]
 * @property {string} retrieved_at
 * @property {string} source_url_or_request_reference
 * @property {string} result_status
 * @property {string} limitations
 * @property {string} confidence
 * @property {string} correlation_id
 *
 * Future adapters implement LeadSourceAdapter / DiscoverySourceAdapter:
 *   search(criteria: DiscoveryCriteria) -> Promise<ProposedProspect[]>
 * Manual Chapter 7 adapter does not implement live search — one operator proposal only.
 */

const SCHEMA_VERSION = 'crowsnest.sales.discovery.v1';

/** @type {readonly string[]} */
const KNOWN_PROPOSED_PROSPECT_KEYS = Object.freeze([
  'business_name',
  'website_url',
  'location',
  'category',
  'source_reference',
]);

/** @type {readonly string[]} */
const KNOWN_LOCATION_KEYS = Object.freeze(['city', 'country_code']);

/** @type {readonly string[]} */
const KNOWN_SOURCE_REFERENCE_KEYS = Object.freeze([
  'source_name',
  'external_id',
  'request_reference',
]);

/**
 * Rate / operator-safety controls for discovery adapters.
 * Manual adapter caps (Chapter 7). Maps dry-run uses MAPS_DISCOVERY_RATE_CONTROLS
 * in crowsnest-sales-discovery-maps.js. Live provider search remains forbidden.
 */
const DISCOVERY_RATE_CONTROLS = Object.freeze({
  max_proposals_per_adapt: 1,
  requires_operator_review: true,
  auto_create_prospects: false,
  live_provider_search_allowed: false,
});

/**
 * Quality gates for a normalized proposed prospect.
 */
const DISCOVERY_QUALITY_CONTROLS = Object.freeze({
  require_business_name_or_website: true,
  prefer_website_for_dedup: true,
  max_business_name_length: 200,
  max_website_url_length: 2000,
  max_category_length: 120,
  max_city_length: 120,
  max_country_code_length: 8,
  max_source_note_length: 500,
  allowed_confidence: Object.freeze(['low', 'medium', 'high']),
});

const PREVIEW_DISCLAIMER = 'Preview only — no prospect has been created.';

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(errors) {
  return { ok: false, errors: errors.slice() };
}

function pushError(errors, path, code) {
  errors.push(path ? `${path}: ${code}` : code);
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize a website URL to a registrable hostname-ish domain for dedup.
 * Pure string/URL parsing — no network.
 */
function normalizeWebsiteDomain(websiteUrl) {
  const raw = trimString(websiteUrl);
  if (!raw) return '';
  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const hostname = new URL(withProtocol).hostname || '';
    return hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Fingerprint for name + location when domain is absent.
 */
function nameLocationFingerprint(businessName, location) {
  const name = trimString(businessName).toLowerCase().replace(/\s+/g, ' ');
  const city = trimString(location && location.city).toLowerCase().replace(/\s+/g, ' ');
  const country = trimString(location && location.country_code).toUpperCase();
  if (!name) return '';
  return [name, city, country].filter(Boolean).join('|');
}

function assertClosedKeys(obj, allowed, path, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      pushError(errors, path ? `${path}.${key}` : key, 'unknown_field');
    }
  }
}

/**
 * Validate a normalized ProposedProspect (closed schema).
 * @param {object} proposal
 * @returns {{ ok: true, proposal: object } | { ok: false, errors: string[] }}
 */
function validateProposedProspect(proposal) {
  const errors = [];
  if (!isPlainObject(proposal)) {
    return fail(['proposed_prospect: must_be_object']);
  }
  assertClosedKeys(proposal, KNOWN_PROPOSED_PROSPECT_KEYS, '', errors);

  const businessName = trimString(proposal.business_name);
  const websiteUrl = trimString(proposal.website_url);
  if (typeof proposal.business_name !== 'string') {
    pushError(errors, 'business_name', 'required_string');
  } else if (businessName.length > DISCOVERY_QUALITY_CONTROLS.max_business_name_length) {
    pushError(errors, 'business_name', 'too_long');
  }

  if (typeof proposal.website_url !== 'string') {
    pushError(errors, 'website_url', 'required_string');
  } else if (websiteUrl.length > DISCOVERY_QUALITY_CONTROLS.max_website_url_length) {
    pushError(errors, 'website_url', 'too_long');
  }

  if (DISCOVERY_QUALITY_CONTROLS.require_business_name_or_website && !businessName && !websiteUrl) {
    pushError(errors, 'business_name', 'business_name_or_website_required');
    pushError(errors, 'website_url', 'business_name_or_website_required');
  }

  if (!isPlainObject(proposal.location)) {
    pushError(errors, 'location', 'must_be_object');
  } else {
    assertClosedKeys(proposal.location, KNOWN_LOCATION_KEYS, 'location', errors);
    if (typeof proposal.location.city !== 'string') {
      pushError(errors, 'location.city', 'required_string');
    } else if (proposal.location.city.length > DISCOVERY_QUALITY_CONTROLS.max_city_length) {
      pushError(errors, 'location.city', 'too_long');
    }
    if (typeof proposal.location.country_code !== 'string') {
      pushError(errors, 'location.country_code', 'required_string');
    } else if (proposal.location.country_code.length > DISCOVERY_QUALITY_CONTROLS.max_country_code_length) {
      pushError(errors, 'location.country_code', 'too_long');
    }
  }

  if (typeof proposal.category !== 'string') {
    pushError(errors, 'category', 'required_string');
  } else if (proposal.category.length > DISCOVERY_QUALITY_CONTROLS.max_category_length) {
    pushError(errors, 'category', 'too_long');
  }

  if (!isPlainObject(proposal.source_reference)) {
    pushError(errors, 'source_reference', 'must_be_object');
  } else {
    assertClosedKeys(proposal.source_reference, KNOWN_SOURCE_REFERENCE_KEYS, 'source_reference', errors);
    for (const key of KNOWN_SOURCE_REFERENCE_KEYS) {
      if (typeof proposal.source_reference[key] !== 'string') {
        pushError(errors, `source_reference.${key}`, 'required_string');
      }
    }
    if (
      typeof proposal.source_reference.source_name === 'string'
      && trimString(proposal.source_reference.source_name) === ''
    ) {
      pushError(errors, 'source_reference.source_name', 'required_non_empty_string');
    }
  }

  if (errors.length) return fail(errors);

  return {
    ok: true,
    proposal: {
      business_name: businessName,
      website_url: websiteUrl,
      location: {
        city: trimString(proposal.location.city),
        country_code: trimString(proposal.location.country_code).toUpperCase(),
      },
      category: trimString(proposal.category),
      source_reference: {
        source_name: trimString(proposal.source_reference.source_name),
        external_id: trimString(proposal.source_reference.external_id),
        request_reference: trimString(proposal.source_reference.request_reference),
      },
    },
  };
}

/**
 * Build provider-neutral provenance metadata for an adapter result.
 * @param {object} input
 * @returns {DiscoveryProvenance}
 */
function buildDiscoveryProvenance(input = {}) {
  const confidenceRaw = trimString(input.confidence).toLowerCase();
  const confidence = DISCOVERY_QUALITY_CONTROLS.allowed_confidence.includes(confidenceRaw)
    ? confidenceRaw
    : 'medium';
  return {
    source_name: trimString(input.source_name) || 'manual',
    external_id: trimString(input.external_id),
    retrieved_at: trimString(input.retrieved_at) || new Date().toISOString(),
    source_url_or_request_reference:
      trimString(input.source_url_or_request_reference)
      || trimString(input.request_reference)
      || 'operator-entry',
    result_status: trimString(input.result_status) || 'normalized',
    limitations: trimString(input.limitations) || 'Manual operator entry only; no live provider fetch.',
    confidence,
    correlation_id: trimString(input.correlation_id) || '',
  };
}

/**
 * Assess completeness signals for operator preview (not a lead score).
 */
function assessProposalQuality(proposal) {
  const hasName = Boolean(trimString(proposal && proposal.business_name));
  const hasWebsite = Boolean(trimString(proposal && proposal.website_url));
  const hasCity = Boolean(trimString(proposal && proposal.location && proposal.location.city));
  const hasCountry = Boolean(trimString(proposal && proposal.location && proposal.location.country_code));
  const hasCategory = Boolean(trimString(proposal && proposal.category));
  const signals = {
    has_business_name: hasName,
    has_website: hasWebsite,
    has_location: hasCity || hasCountry,
    has_category: hasCategory,
  };
  const present = Object.values(signals).filter(Boolean).length;
  let completeness = 'low';
  if (present >= 4) completeness = 'high';
  else if (present >= 2) completeness = 'medium';
  return {
    signals,
    completeness,
    limitations: hasWebsite
      ? ''
      : 'No website provided — domain dedup unavailable; name/location fingerprint used when possible.',
  };
}

/**
 * Deduplication *preview* against existing prospects. Never mutates or creates.
 * Match order: normalized domain, then name/location fingerprint.
 *
 * @param {{ proposal: object, existingProspects?: object[] }} input
 */
function previewDiscoveryDeduplication(input = {}) {
  const validated = validateProposedProspect(input.proposal);
  if (!validated.ok) {
    return { ok: false, errors: validated.errors, preview_only: true, prospect_created: false };
  }
  const proposal = validated.proposal;
  const existing = Array.isArray(input.existingProspects) ? input.existingProspects : [];
  const proposalDomain = normalizeWebsiteDomain(proposal.website_url);
  const proposalFingerprint = nameLocationFingerprint(proposal.business_name, proposal.location);
  const matches = [];

  for (const prospect of existing) {
    if (!prospect || typeof prospect !== 'object') continue;
    const prospectId = String(prospect.id || '');
    if (!prospectId) continue;
    const existingDomain = normalizeWebsiteDomain(prospect.website_url);
    if (proposalDomain && existingDomain && proposalDomain === existingDomain) {
      matches.push({
        prospect_id: prospectId,
        match_type: 'domain',
        reason: 'domain',
        canonical_name: String(prospect.canonical_name || ''),
        website_url: String(prospect.website_url || ''),
      });
      continue;
    }
    const existingLocation = {
      city: trimString(prospect.city || (prospect.location && prospect.location.city)),
      country_code: trimString(
        prospect.country_code || (prospect.location && prospect.location.country_code),
      ),
    };
    const existingFingerprint = nameLocationFingerprint(prospect.canonical_name, existingLocation);
    if (
      proposalFingerprint
      && existingFingerprint
      && proposalFingerprint === existingFingerprint
    ) {
      matches.push({
        prospect_id: prospectId,
        match_type: 'name_location_fingerprint',
        reason: 'name_location_fingerprint',
        canonical_name: String(prospect.canonical_name || ''),
        website_url: String(prospect.website_url || ''),
      });
    }
  }

  return {
    ok: true,
    preview_only: true,
    prospect_created: false,
    proposal_domain: proposalDomain,
    proposal_fingerprint: proposalFingerprint,
    matches,
    disclaimer: PREVIEW_DISCLAIMER,
  };
}

/**
 * Structural helper: a DiscoverySourceAdapter / LeadSourceAdapter must expose search.
 * Chapter 7 ships only the manual proposal adapter (no live search).
 */
function assertDiscoverySourceAdapterShape(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    return fail(['adapter: must_be_object']);
  }
  if (typeof adapter.search !== 'function') {
    return fail(['adapter.search: required_function']);
  }
  return { ok: true };
}

module.exports = {
  SCHEMA_VERSION,
  KNOWN_PROPOSED_PROSPECT_KEYS,
  KNOWN_LOCATION_KEYS,
  KNOWN_SOURCE_REFERENCE_KEYS,
  DISCOVERY_RATE_CONTROLS,
  DISCOVERY_QUALITY_CONTROLS,
  PREVIEW_DISCLAIMER,
  // Interface names retained for docs / Maps dry-run adapter (Chapter 8).
  LeadSourceAdapter: 'LeadSourceAdapter',
  DiscoverySourceAdapter: 'DiscoverySourceAdapter',
  assessProposalQuality,
  assertDiscoverySourceAdapterShape,
  buildDiscoveryProvenance,
  nameLocationFingerprint,
  normalizeWebsiteDomain,
  previewDiscoveryDeduplication,
  validateProposedProspect,
};
