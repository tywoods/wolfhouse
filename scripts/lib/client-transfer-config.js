/**
 * Phase 26b — Generic client airport transfer config (multi-client).
 *
 * Wolfhouse rules live as config data only — engine logic reads config, never branches on SDR/BIO.
 *
 * @module client-transfer-config
 */

'use strict';

const EMPTY_CONFIG = Object.freeze({
  client_slug: '',
  currency: 'EUR',
  timezone: 'UTC',
  airports: Object.freeze([]),
  rules: Object.freeze([]),
});

/** @type {Record<string, object>} */
const CLIENT_TRANSFER_CONFIGS = Object.freeze({
  'wolfhouse-somo': Object.freeze({
    client_slug: 'wolfhouse-somo',
    currency: 'EUR',
    timezone: 'Europe/Madrid',
    airports: Object.freeze([
      Object.freeze({ code: 'SDR', label: 'Santander', iata: 'SDR', aliases: Object.freeze(['santander']) }),
      Object.freeze({ code: 'BIO', label: 'Bilbao', iata: 'BIO', aliases: Object.freeze(['bilbao']) }),
    ]),
    rules: Object.freeze([
      Object.freeze({
        airport_code: 'SDR',
        requires_package: false,
        min_guest_count: null,
        included_when_package: true,
        flat_price_cents: 2500,
        per_person_extra_cents: null,
        unavailable_no_package_message: null,
        unavailable_below_min_group_message: null,
      }),
      Object.freeze({
        airport_code: 'BIO',
        requires_package: true,
        min_guest_count: 4,
        included_when_package: false,
        flat_price_cents: null,
        per_person_extra_cents: 1500,
        unavailable_no_package_message:
          'Bilbao transfer is only available for package bookings. We recommend the bus from Bilbao.',
        unavailable_below_min_group_message:
          'Bilbao transfer is normally available for groups of 4 or more. Use Exception Override to save a manual exception.',
      }),
    ]),
  }),
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function cloneConfig(cfg) {
  if (!cfg) return { ...EMPTY_CONFIG, airports: [], rules: [] };
  return {
    client_slug: cfg.client_slug,
    currency: cfg.currency,
    timezone: cfg.timezone,
    airports: cfg.airports.map((a) => ({ ...a, aliases: a.aliases ? [...a.aliases] : [] })),
    rules: cfg.rules.map((r) => ({ ...r })),
  };
}

/**
 * @param {string} clientSlug
 * @returns {object}
 */
function getClientTransferConfig(clientSlug) {
  const slug = trimStr(clientSlug);
  return cloneConfig(CLIENT_TRANSFER_CONFIGS[slug] || null);
}

/**
 * @param {string} clientSlug
 * @returns {object[]}
 */
function getClientAirports(clientSlug) {
  return getClientTransferConfig(clientSlug).airports;
}

/**
 * @param {string} clientSlug
 * @param {string} airportCode
 * @returns {object|null}
 */
function getClientAirportOption(clientSlug, airportCode) {
  const code = normalizeAirportCode(clientSlug, airportCode);
  if (!code) return null;
  return getClientAirports(clientSlug).find((a) => a.code === code) || null;
}

/**
 * Resolve airport code from code, IATA, or label alias (case-insensitive).
 *
 * @param {string} clientSlug
 * @param {string} input
 * @returns {string|null}
 */
function normalizeAirportCode(clientSlug, input) {
  const raw = trimStr(input);
  if (!raw) return null;
  const upper = raw.toUpperCase();
  const lower = raw.toLowerCase();
  for (const airport of getClientAirports(clientSlug)) {
    if (airport.code === upper || airport.iata === upper) return airport.code;
    if (airport.label && airport.label.toLowerCase() === lower) return airport.code;
    if (Array.isArray(airport.aliases) && airport.aliases.includes(lower)) return airport.code;
  }
  return null;
}

/**
 * @param {string} clientSlug
 * @returns {object[]}
 */
function getTransferRules(clientSlug) {
  return getClientTransferConfig(clientSlug).rules;
}

/**
 * @param {string} clientSlug
 * @param {string} airportCode
 * @returns {object|null}
 */
function getTransferRuleForAirport(clientSlug, airportCode) {
  const code = normalizeAirportCode(clientSlug, airportCode);
  if (!code) return null;
  return getTransferRules(clientSlug).find((r) => r.airport_code === code) || null;
}

module.exports = {
  CLIENT_TRANSFER_CONFIGS,
  EMPTY_CONFIG,
  getClientTransferConfig,
  getClientAirports,
  getClientAirportOption,
  normalizeAirportCode,
  getTransferRules,
  getTransferRuleForAirport,
};
