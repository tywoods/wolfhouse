'use strict';

/**
 * Per-school Inbox channel routing config for Sunset tenant.
 * Placeholder values only — no production WhatsApp numbers or live secrets.
 *
 * tenant = sunset
 * location = sunset-somo | sunset-sardinero
 */

const {
  SUNSET_LOCATIONS,
  DEFAULT_SUNSET_LOCATION_ID,
  normalizeSunsetLocationId,
} = require('./sunset-school-locations');

const PLACEHOLDER_WHATSAPP = {
  'sunset-somo': 'PLACEHOLDER_SUNSET_SOMO_WHATSAPP',
  'sunset-sardinero': 'PLACEHOLDER_SUNSET_SARDINERO_WHATSAPP',
};

const PLACEHOLDER_EMAIL = {
  'sunset-somo': 'PLACEHOLDER_SUNSET_SOMO_INBOX_EMAIL',
  'sunset-sardinero': 'PLACEHOLDER_SUNSET_SARDINERO_INBOX_EMAIL',
};

function envOrPlaceholder(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw != null && String(raw).trim()) return String(raw).trim();
  return fallback;
}

function buildChannelEntry(locationId) {
  const id = normalizeSunsetLocationId(locationId);
  const meta = SUNSET_LOCATIONS.find((l) => l.id === id) || SUNSET_LOCATIONS[0];
  const envSuffix = id === 'sunset-sardinero' ? 'SARDINERO' : 'SOMO';
  return Object.freeze({
    location_id: id,
    display_name: meta.displayName,
    label_key: meta.labelKey,
    whatsapp_number: envOrPlaceholder(
      `SUNSET_${envSuffix}_WHATSAPP_NUMBER`,
      PLACEHOLDER_WHATSAPP[id],
    ),
    email_address: envOrPlaceholder(
      `SUNSET_${envSuffix}_INBOX_EMAIL`,
      PLACEHOLDER_EMAIL[id],
    ),
    whatsapp_placeholder: PLACEHOLDER_WHATSAPP[id],
    email_placeholder: PLACEHOLDER_EMAIL[id],
  });
}

function resolveSunsetInboxChannelConfig(locationId) {
  return buildChannelEntry(locationId);
}

function resolveSunsetInboxChannelMap() {
  const out = {};
  for (const loc of SUNSET_LOCATIONS) {
    out[loc.id] = buildChannelEntry(loc.id);
  }
  return out;
}

function attachConversationChannelMetadata(metadata, locationId, channel) {
  const meta = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  meta.location_id = normalizeSunsetLocationId(locationId || meta.location_id);
  if (channel) meta.channel = String(channel).trim().toLowerCase();
  return meta;
}

module.exports = {
  DEFAULT_SUNSET_LOCATION_ID,
  resolveSunsetInboxChannelConfig,
  resolveSunsetInboxChannelMap,
  attachConversationChannelMetadata,
};
