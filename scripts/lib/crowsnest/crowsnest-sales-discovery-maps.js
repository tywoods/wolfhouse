'use strict';

/**
 * Google Maps discovery adapter shell (Luna Sales Chapter 8).
 *
 * Dry-run / test-fixture only. Normalizes Maps-*like* place records from local
 * fixtures into the Chapter 7 ProposedProspect contract.
 *
 * Does NOT call Google Maps, Places API, HTTP, scraping, or any Google SDK.
 * Does NOT read API keys. Does NOT auto-create prospects.
 */

const fs = require('fs');
const path = require('path');

const {
  SCHEMA_VERSION,
  assessProposalQuality,
  assertDiscoverySourceAdapterShape,
  buildDiscoveryProvenance,
  validateProposedProspect,
} = require('./crowsnest-sales-discovery-contract');

const SOURCE_NAME = 'google_maps_dry_run';
const DRY_RUN = true;
const UI_SAMPLE_DISCLAIMER = 'Sample / dry-run data only — not live Google Maps results.';

const MAPS_DISCOVERY_RATE_CONTROLS = Object.freeze({
  max_candidates_per_search: 10,
  requires_operator_review: true,
  auto_create_prospects: false,
  live_provider_search_allowed: false,
  dry_run_only: true,
});

/**
 * Pilot hospitality cities in Northern Spain (Cantabria / Asturias / Basque / Galicia north).
 * Matching is case-insensitive after accent folding.
 */
const NORTHERN_SPAIN_CITIES = Object.freeze([
  'somo',
  'santander',
  'suances',
  'liencres',
  'loredo',
  'isla',
  'noja',
  'laredo',
  'castro urdiales',
  'comillas',
  'san vicente de la barquera',
  'gijon',
  'oviedo',
  'aviles',
  'llanes',
  'cudillero',
  'bilbao',
  'san sebastian',
  'donostia',
  'zarautz',
  'getxo',
  'mundaka',
  'a coruna',
  'coruna',
]);

const DEFAULT_FIXTURE_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'fixtures',
  'crowsnest-sales-maps-discovery',
  'sample-places.json',
);

const KNOWN_CRITERIA_KEYS = Object.freeze([
  'market',
  'category',
  'city',
  'country_code',
  'countryCode',
  'query',
  'search_area',
  'searchArea',
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

function foldCityKey(value) {
  return trimString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isNorthernSpainCity(city) {
  const key = foldCityKey(city);
  if (!key) return false;
  return NORTHERN_SPAIN_CITIES.includes(key);
}

function isNorthernSpainLocation(location = {}) {
  const country = trimString(location.country_code || location.countryCode).toUpperCase();
  if (country && country !== 'ES') return false;
  return isNorthernSpainCity(location.city);
}

function readField(input, snake, camel) {
  if (!input || typeof input !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(input, snake) && input[snake] != null) {
    return trimString(input[snake]);
  }
  if (camel && Object.prototype.hasOwnProperty.call(input, camel) && input[camel] != null) {
    return trimString(input[camel]);
  }
  return '';
}

function categoryFromTypes(types) {
  if (!Array.isArray(types) || !types.length) return 'lodging';
  const preferred = types.find((t) => {
    const key = trimString(t).toLowerCase();
    return key && key !== 'point_of_interest' && key !== 'establishment';
  });
  return trimString(preferred || types[0]) || 'lodging';
}

function extractPlaceLocation(place) {
  const components = isPlainObject(place && place.address_components)
    ? place.address_components
    : {};
  const city = trimString(components.city)
    || trimString(place && place.vicinity)
    || trimString(place && place.city);
  const countryCode = trimString(components.country_code || components.countryCode)
    || trimString(place && place.country_code)
    || trimString(place && place.countryCode)
    || 'ES';
  return {
    city,
    country_code: countryCode.toUpperCase(),
  };
}

function buildSearchArea(criteria = {}) {
  const explicit = readField(criteria, 'search_area', 'searchArea');
  if (explicit) return explicit;
  const city = readField(criteria, 'city', 'city');
  const country = readField(criteria, 'country_code', 'countryCode').toUpperCase() || 'ES';
  if (city) return `${city}, ${country}`;
  return 'Northern Spain, ES';
}

/**
 * Load the dry-run Maps-like place catalog from disk (or an injected override for tests).
 * @param {{ fixturePath?: string, places?: object[] }} [options]
 */
function loadMapsDryRunPlaces(options = {}) {
  if (Array.isArray(options.places)) {
    return options.places.slice();
  }
  const fixturePath = options.fixturePath || DEFAULT_FIXTURE_PATH;
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (!raw || !Array.isArray(raw.places)) {
    throw new Error('maps_fixture: places_array_required');
  }
  return raw.places.slice();
}

/**
 * Normalize one Maps-like place into a ProposedProspect + provenance.
 * Preserves exact place_id and search_area in source_reference / provenance.
 *
 * @param {object} place
 * @param {{ search_area?: string, correlation_id?: string }} [context]
 */
function normalizeMapsPlace(place, context = {}) {
  if (!isPlainObject(place)) {
    return {
      ok: false,
      errors: ['place: must_be_object'],
      prospect_created: false,
      auto_created: false,
      dry_run: DRY_RUN,
    };
  }

  const placeId = trimString(place.place_id || place.placeId);
  if (!placeId) {
    return {
      ok: false,
      errors: ['place_id: required_non_empty_string'],
      prospect_created: false,
      auto_created: false,
      dry_run: DRY_RUN,
    };
  }

  const location = extractPlaceLocation(place);
  if (!isNorthernSpainLocation(location)) {
    return {
      ok: false,
      errors: ['location: outside_northern_spain_scope'],
      prospect_created: false,
      auto_created: false,
      dry_run: DRY_RUN,
      out_of_scope: true,
      place_id: placeId,
      location,
    };
  }

  const searchArea = trimString(context.search_area) || buildSearchArea({
    city: location.city,
    country_code: location.country_code,
  });

  const candidate = {
    business_name: trimString(place.name || place.business_name),
    website_url: trimString(place.website || place.website_url || place.url),
    location: {
      city: location.city,
      country_code: location.country_code,
    },
    category: categoryFromTypes(place.types) || trimString(place.category) || 'lodging',
    source_reference: {
      source_name: SOURCE_NAME,
      external_id: placeId,
      request_reference: searchArea,
    },
  };

  const validated = validateProposedProspect(candidate);
  if (!validated.ok) {
    return {
      ok: false,
      errors: validated.errors,
      prospect_created: false,
      auto_created: false,
      dry_run: DRY_RUN,
      place_id: placeId,
    };
  }

  const provenance = buildDiscoveryProvenance({
    source_name: SOURCE_NAME,
    external_id: placeId,
    request_reference: searchArea,
    source_url_or_request_reference: `maps-dry-run://search-area/${encodeURIComponent(searchArea)}#place/${encodeURIComponent(placeId)}`,
    result_status: 'normalized_dry_run',
    limitations:
      'Dry-run fixture adapter only; no live Google Maps HTTP, API key, SDK, or scraping. Sample data.',
    confidence: 'medium',
    correlation_id: trimString(context.correlation_id),
  });

  return {
    ok: true,
    schema_version: SCHEMA_VERSION,
    dry_run: DRY_RUN,
    sample_data: true,
    place_id: placeId,
    search_area: searchArea,
    proposal: validated.proposal,
    provenance,
    quality: assessProposalQuality(validated.proposal),
    prospect_created: false,
    auto_created: false,
    disclaimer: UI_SAMPLE_DISCLAIMER,
  };
}

function criteriaInNorthernSpainScope(criteria = {}) {
  const city = readField(criteria, 'city', 'city');
  const country = readField(criteria, 'country_code', 'countryCode').toUpperCase() || 'ES';
  const market = foldCityKey(readField(criteria, 'market', 'market'));

  if (country && country !== 'ES') {
    return { ok: false, reason: 'country_outside_northern_spain_scope' };
  }
  if (city) {
    if (!isNorthernSpainCity(city)) {
      return { ok: false, reason: 'city_outside_northern_spain_scope' };
    }
    return { ok: true };
  }
  if (market && market !== 'northern spain' && market !== 'northern_spain') {
    return { ok: false, reason: 'market_outside_northern_spain_scope' };
  }
  // Empty city with ES (or omitted) and northern_spain market / default — allowed.
  return { ok: true };
}

function placeMatchesCriteria(place, criteria = {}) {
  const location = extractPlaceLocation(place);
  const cityFilter = foldCityKey(readField(criteria, 'city', 'city'));
  if (cityFilter && foldCityKey(location.city) !== cityFilter) {
    return false;
  }

  const categoryFilter = foldCityKey(readField(criteria, 'category', 'category'));
  if (categoryFilter) {
    const types = Array.isArray(place.types) ? place.types.map((t) => foldCityKey(t)) : [];
    const placeCategory = foldCityKey(categoryFromTypes(place.types));
    if (!types.includes(categoryFilter) && placeCategory !== categoryFilter) {
      // soft match: lodging criteria matches hostel/surf_hostel types
      const lodgingFamily = categoryFilter === 'lodging'
        || categoryFilter === 'hostel'
        || categoryFilter === 'surf_hostel';
      const placeIsLodging = types.some((t) => t === 'lodging' || t === 'hostel' || t === 'surf_hostel')
        || placeCategory === 'lodging'
        || placeCategory === 'hostel'
        || placeCategory === 'surf_hostel';
      if (!(lodgingFamily && placeIsLodging)) {
        return false;
      }
    }
  }

  const query = foldCityKey(readField(criteria, 'query', 'query'));
  if (query) {
    const haystack = [
      place.name,
      place.website,
      location.city,
      ...(Array.isArray(place.types) ? place.types : []),
      place.formatted_address,
    ].map((part) => foldCityKey(part)).join(' ');
    if (!haystack.includes(query)) {
      return false;
    }
  }

  return true;
}

/**
 * DiscoverySourceAdapter.search — dry-run fixture search only.
 * @param {object} criteria
 * @param {{ fixturePath?: string, places?: object[] }} [options]
 */
function search(criteria = {}, options = {}) {
  if (!isPlainObject(criteria)) {
    return {
      ok: false,
      errors: ['criteria: must_be_object'],
      dry_run: DRY_RUN,
      sample_data: true,
      candidates: [],
      prospect_created: false,
      auto_created: false,
    };
  }

  const unknown = Object.keys(criteria).filter((key) => !KNOWN_CRITERIA_KEYS.includes(key));
  if (unknown.length) {
    return {
      ok: false,
      errors: unknown.map((key) => `${key}: unknown_field`),
      dry_run: DRY_RUN,
      sample_data: true,
      candidates: [],
      prospect_created: false,
      auto_created: false,
    };
  }

  const scope = criteriaInNorthernSpainScope(criteria);
  if (!scope.ok) {
    return {
      ok: false,
      errors: [`scope: ${scope.reason}`],
      dry_run: DRY_RUN,
      sample_data: true,
      candidates: [],
      prospect_created: false,
      auto_created: false,
      disclaimer: UI_SAMPLE_DISCLAIMER,
    };
  }

  const searchArea = buildSearchArea(criteria);
  let places;
  try {
    places = loadMapsDryRunPlaces(options);
  } catch (err) {
    return {
      ok: false,
      errors: [`fixture: ${err && err.message ? err.message : 'load_failed'}`],
      dry_run: DRY_RUN,
      sample_data: true,
      candidates: [],
      prospect_created: false,
      auto_created: false,
    };
  }

  let discardedOutOfScope = 0;
  const candidates = [];

  for (const place of places) {
    if (!isPlainObject(place)) continue;
    const location = extractPlaceLocation(place);
    if (!isNorthernSpainLocation(location)) {
      discardedOutOfScope += 1;
      continue;
    }
    if (!placeMatchesCriteria(place, criteria)) continue;

    const normalized = normalizeMapsPlace(place, { search_area: searchArea });
    if (!normalized.ok) continue;
    candidates.push(normalized);
    if (candidates.length >= MAPS_DISCOVERY_RATE_CONTROLS.max_candidates_per_search) {
      break;
    }
  }

  return {
    ok: true,
    schema_version: SCHEMA_VERSION,
    dry_run: DRY_RUN,
    sample_data: true,
    source_name: SOURCE_NAME,
    search_area: searchArea,
    criteria: {
      city: readField(criteria, 'city', 'city'),
      country_code: (readField(criteria, 'country_code', 'countryCode') || 'ES').toUpperCase(),
      category: readField(criteria, 'category', 'category'),
      query: readField(criteria, 'query', 'query'),
      market: readField(criteria, 'market', 'market') || 'northern_spain',
    },
    candidates,
    discarded_out_of_scope_count: discardedOutOfScope,
    prospect_created: false,
    auto_created: false,
    disclaimer: UI_SAMPLE_DISCLAIMER,
    rate_controls: MAPS_DISCOVERY_RATE_CONTROLS,
  };
}

/**
 * Resolve one fixture candidate by exact place_id (for explicit operator import).
 */
function resolveMapsFixtureCandidate(placeId, context = {}, options = {}) {
  const id = trimString(placeId);
  if (!id) {
    return {
      ok: false,
      errors: ['place_id: required_non_empty_string'],
      dry_run: DRY_RUN,
      prospect_created: false,
      auto_created: false,
    };
  }

  let places;
  try {
    places = loadMapsDryRunPlaces(options);
  } catch (err) {
    return {
      ok: false,
      errors: [`fixture: ${err && err.message ? err.message : 'load_failed'}`],
      dry_run: DRY_RUN,
      prospect_created: false,
      auto_created: false,
    };
  }

  const place = places.find((entry) => trimString(entry && (entry.place_id || entry.placeId)) === id);
  if (!place) {
    return {
      ok: false,
      errors: ['place_id: not_found_in_dry_run_fixture'],
      dry_run: DRY_RUN,
      prospect_created: false,
      auto_created: false,
    };
  }

  const searchArea = trimString(context.search_area) || buildSearchArea({
    city: extractPlaceLocation(place).city,
    country_code: extractPlaceLocation(place).country_code,
  });
  return normalizeMapsPlace(place, {
    search_area: searchArea,
    correlation_id: context.correlation_id,
  });
}

const mapsDiscoveryAdapter = Object.freeze({
  source_name: SOURCE_NAME,
  dry_run: DRY_RUN,
  search,
});

module.exports = {
  SOURCE_NAME,
  DRY_RUN,
  UI_SAMPLE_DISCLAIMER,
  MAPS_DISCOVERY_RATE_CONTROLS,
  NORTHERN_SPAIN_CITIES,
  DEFAULT_FIXTURE_PATH,
  assertDiscoverySourceAdapterShape,
  buildSearchArea,
  isNorthernSpainCity,
  isNorthernSpainLocation,
  loadMapsDryRunPlaces,
  mapsDiscoveryAdapter,
  normalizeMapsPlace,
  resolveMapsFixtureCandidate,
  search,
};
