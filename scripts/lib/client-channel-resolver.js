'use strict';

/**
 * Multi-client inbound channel → tenant resolver (read-only spine).
 *
 * Maps stable channel identifiers (Meta WhatsApp phone_number_id, email inbox
 * destination) to client_slug + location_id using config/clients/clients.json
 * and a channel routing map. Unknown identities return blocked — never Wolfhouse.
 *
 * @module client-channel-resolver
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_REGISTRY_PATH = path.join(__dirname, '..', '..', 'config', 'clients', 'clients.json');
const DEFAULT_CHANNEL_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'clients', 'channel-routing.sample.json');

const SUPPORTED_CHANNELS = new Set(['whatsapp', 'email']);
const BLOCKED_UNKNOWN = Object.freeze({
  blocked: true,
  reason: 'unknown_channel_identity',
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizeEmail(raw) {
  return trimStr(raw).toLowerCase();
}

/**
 * @param {object} [options]
 * @param {string} [options.registryPath]
 * @returns {{ clients: object[], bySlug: Record<string, object>, locationOwner: Record<string, string> }}
 */
function loadClientRegistry(options = {}) {
  const filePath = options.registryPath || DEFAULT_REGISTRY_PATH;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`loadClientRegistry: cannot read ${filePath}: ${err.message}`);
  }
  const clients = Array.isArray(parsed.clients) ? parsed.clients : [];
  const bySlug = {};
  const locationOwner = {};

  for (const client of clients) {
    const slug = trimStr(client && client.client_slug);
    if (!slug) continue;
    const locations = [];
    for (const loc of (client.locations || [])) {
      const locationId = trimStr(loc && loc.location_id);
      if (!locationId) continue;
      locations.push(locationId);
      locationOwner[locationId] = slug;
    }
    bySlug[slug] = {
      client_slug: slug,
      display_name: client.display_name || slug,
      locations,
      location_ids: new Set(locations),
    };
  }

  return { clients, bySlug, locationOwner };
}

/**
 * @param {object} registry
 * @param {{ client_slug?: string, location_id?: string }} route
 * @param {string} label
 */
function validateRouteAgainstRegistry(registry, route, label) {
  const clientSlug = trimStr(route && route.client_slug);
  const locationId = trimStr(route && route.location_id);
  if (!clientSlug || !locationId) {
    throw new Error(`${label}: client_slug and location_id are required`);
  }
  const client = registry.bySlug[clientSlug];
  if (!client) {
    throw new Error(`${label}: unknown client_slug "${clientSlug}"`);
  }
  if (!client.location_ids.has(locationId)) {
    throw new Error(`${label}: location_id "${locationId}" does not belong to client "${clientSlug}"`);
  }
  return { client_slug: clientSlug, location_id: locationId };
}

/**
 * Normalize inbound channel identity fields for lookup.
 * @param {object} input
 * @returns {{ channel: string|null, phone_number_id?: string, to?: string }}
 */
function normalizeChannelIdentity(input) {
  const src = input && typeof input === 'object' ? input : {};
  const channel = trimStr(src.channel).toLowerCase();

  if (channel === 'whatsapp') {
    const phoneNumberId = trimStr(src.phone_number_id)
      || trimStr(src.to)
      || trimStr(src.recipient);
    return { channel: 'whatsapp', phone_number_id: phoneNumberId };
  }

  if (channel === 'email') {
    const to = normalizeEmail(src.to || src.recipient);
    return { channel: 'email', to };
  }

  return { channel: channel || null };
}

/**
 * @param {ReturnType<typeof loadClientRegistry>} registry
 * @param {object} channelConfig
 * @returns {{ resolve: Function, whatsappRoutes: number, emailRoutes: number }}
 */
function buildChannelResolver(registry, channelConfig) {
  const cfg = channelConfig && typeof channelConfig === 'object' ? channelConfig : {};
  const whatsappMap = new Map();
  const emailMap = new Map();

  const waIds = cfg.whatsapp_phone_number_ids && typeof cfg.whatsapp_phone_number_ids === 'object'
    ? cfg.whatsapp_phone_number_ids
    : {};
  for (const [rawId, route] of Object.entries(waIds)) {
    const phoneNumberId = trimStr(rawId);
    if (!phoneNumberId) continue;
    if (whatsappMap.has(phoneNumberId)) {
      throw new Error(`duplicate channel identity: whatsapp phone_number_id "${phoneNumberId}"`);
    }
    const validated = validateRouteAgainstRegistry(
      registry,
      route,
      `whatsapp_phone_number_ids.${phoneNumberId}`,
    );
    whatsappMap.set(phoneNumberId, { ...validated, source: 'phone_number_id' });
  }

  const emailTo = cfg.email_to && typeof cfg.email_to === 'object' ? cfg.email_to : {};
  for (const [rawAddr, route] of Object.entries(emailTo)) {
    const email = normalizeEmail(rawAddr);
    if (!email) continue;
    if (emailMap.has(email)) {
      throw new Error(`duplicate channel identity: email_to "${email}"`);
    }
    const validated = validateRouteAgainstRegistry(registry, route, `email_to.${email}`);
    emailMap.set(email, { ...validated, source: 'email_to' });
  }

  function resolve(identity) {
    if (!identity || !SUPPORTED_CHANNELS.has(identity.channel)) return null;

    if (identity.channel === 'whatsapp') {
      const phoneNumberId = trimStr(identity.phone_number_id);
      if (!phoneNumberId) return null;
      return whatsappMap.get(phoneNumberId) || null;
    }

    if (identity.channel === 'email') {
      const to = normalizeEmail(identity.to);
      if (!to) return null;
      return emailMap.get(to) || null;
    }

    return null;
  }

  return {
    resolve,
    whatsappRoutes: whatsappMap.size,
    emailRoutes: emailMap.size,
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.channelConfigPath]
 * @returns {object}
 */
function loadChannelRoutingConfig(options = {}) {
  const filePath = options.channelConfigPath || DEFAULT_CHANNEL_CONFIG_PATH;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`loadChannelRoutingConfig: cannot read ${filePath}: ${err.message}`);
  }
}

/**
 * Resolve inbound channel identity → tenant (client_slug + location_id).
 * Unknown/unmapped identities return blocked — never default to Wolfhouse.
 *
 * @param {object} input
 * @param {object} [options]
 * @param {ReturnType<typeof loadClientRegistry>} [options.registry]
 * @param {object} [options.channelConfig]
 * @param {ReturnType<typeof buildChannelResolver>} [options.resolver]
 * @returns {object}
 */
function resolveInboundTenant(input, options = {}) {
  const registry = options.registry || loadClientRegistry(options);
  const channelConfig = options.channelConfig != null
    ? options.channelConfig
    : loadChannelRoutingConfig(options);
  const resolver = options.resolver || buildChannelResolver(registry, channelConfig);
  const identity = normalizeChannelIdentity(input);

  if (!identity.channel || !SUPPORTED_CHANNELS.has(identity.channel)) {
    return { ...BLOCKED_UNKNOWN };
  }

  const hit = resolver.resolve(identity);
  if (!hit) {
    return { ...BLOCKED_UNKNOWN };
  }

  return {
    blocked: false,
    client_slug: hit.client_slug,
    location_id: hit.location_id,
    source: hit.source,
    confidence: 'exact',
  };
}

module.exports = {
  DEFAULT_REGISTRY_PATH,
  DEFAULT_CHANNEL_CONFIG_PATH,
  SUPPORTED_CHANNELS,
  BLOCKED_UNKNOWN,
  loadClientRegistry,
  loadChannelRoutingConfig,
  normalizeChannelIdentity,
  validateRouteAgainstRegistry,
  buildChannelResolver,
  resolveInboundTenant,
};
