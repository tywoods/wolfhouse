'use strict';

/**
 * Per-school Inbox channel routing config for Sunset tenant.
 * Placeholder values only — no production WhatsApp numbers or live secrets.
 *
 * tenant = sunset
 * location = sunset-somo | sunset-sardinero
 */

const {
  SUNSET_CLIENT_SLUG,
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

const PLACEHOLDER_PHONE_NUMBER_ID = {
  'sunset-somo': 'PLACEHOLDER_SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID',
  'sunset-sardinero': 'PLACEHOLDER_SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID',
};

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function envOrPlaceholder(env, envKey, fallback) {
  const src = env && typeof env === 'object' ? env : process.env;
  const raw = src[envKey];
  if (raw != null && String(raw).trim()) return String(raw).trim();
  return fallback;
}

function normalizePhoneDigits(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function normalizeInboxEmail(raw) {
  return trimStr(raw).toLowerCase();
}

function buildChannelEntry(locationId, env) {
  const id = normalizeSunsetLocationId(locationId);
  const meta = SUNSET_LOCATIONS.find((l) => l.id === id) || SUNSET_LOCATIONS[0];
  const envSuffix = id === 'sunset-sardinero' ? 'SARDINERO' : 'SOMO';
  return Object.freeze({
    location_id: id,
    display_name: meta.displayName,
    label_key: meta.labelKey,
    whatsapp_number: envOrPlaceholder(
      env,
      `SUNSET_${envSuffix}_WHATSAPP_NUMBER`,
      PLACEHOLDER_WHATSAPP[id],
    ),
    whatsapp_phone_number_id: envOrPlaceholder(
      env,
      `SUNSET_${envSuffix}_WHATSAPP_PHONE_NUMBER_ID`,
      PLACEHOLDER_PHONE_NUMBER_ID[id],
    ),
    email_address: envOrPlaceholder(
      env,
      `SUNSET_${envSuffix}_INBOX_EMAIL`,
      PLACEHOLDER_EMAIL[id],
    ),
    whatsapp_placeholder: PLACEHOLDER_WHATSAPP[id],
    email_placeholder: PLACEHOLDER_EMAIL[id],
    whatsapp_phone_number_id_placeholder: PLACEHOLDER_PHONE_NUMBER_ID[id],
  });
}

function resolveSunsetInboxChannelConfig(locationId, env) {
  return buildChannelEntry(locationId, env);
}

function resolveSunsetInboxChannelMap(env) {
  const out = {};
  for (const loc of SUNSET_LOCATIONS) {
    out[loc.id] = buildChannelEntry(loc.id, env);
  }
  return out;
}

function resolveSunsetLocationFromWhatsAppNumber(whatsappNumber, env) {
  const digits = normalizePhoneDigits(whatsappNumber);
  if (!digits) return null;
  for (const loc of SUNSET_LOCATIONS) {
    const entry = buildChannelEntry(loc.id, env);
    if (normalizePhoneDigits(entry.whatsapp_number) === digits) {
      return {
        location_id: loc.id,
        channel_location_source: 'whatsapp_number',
        fallback: false,
      };
    }
  }
  return null;
}

function resolveSunsetLocationFromPhoneNumberId(phoneNumberId, env) {
  const id = trimStr(phoneNumberId);
  if (!id) return null;
  for (const loc of SUNSET_LOCATIONS) {
    const entry = buildChannelEntry(loc.id, env);
    if (trimStr(entry.whatsapp_phone_number_id) === id) {
      return {
        location_id: loc.id,
        channel_location_source: 'config',
        fallback: false,
      };
    }
  }
  return null;
}

function resolveSunsetLocationFromInboxEmail(emailAddress, env) {
  const email = normalizeInboxEmail(emailAddress);
  if (!email) return null;
  for (const loc of SUNSET_LOCATIONS) {
    const entry = buildChannelEntry(loc.id, env);
    if (normalizeInboxEmail(entry.email_address) === email) {
      return {
        location_id: loc.id,
        channel_location_source: 'email',
        fallback: false,
      };
    }
  }
  return null;
}

/**
 * Resolve Sunset school from inbound channel identity (WhatsApp number, Meta phone_number_id, or inbox email).
 * Unknown/missing channel defaults to sunset-somo with fallback marker.
 *
 * @param {{ client_slug?: string, channel?: string, whatsapp_number?: string, phone_number_id?: string, inbox_email?: string, to_email?: string }} hints
 * @param {object} [env]
 */
function resolveSunsetLocationFromInboundChannel(hints, env) {
  const h = hints || {};
  const channel = trimStr(h.channel).toLowerCase();

  if (channel === 'email' || h.inbox_email || h.to_email) {
    const email = h.inbox_email || h.to_email;
    const fromEmail = resolveSunsetLocationFromInboxEmail(email, env);
    if (fromEmail) return fromEmail;
  }

  const fromNumber = resolveSunsetLocationFromWhatsAppNumber(h.whatsapp_number, env);
  if (fromNumber) return fromNumber;

  const fromPhoneNumberId = resolveSunsetLocationFromPhoneNumberId(h.phone_number_id, env);
  if (fromPhoneNumberId) return fromPhoneNumberId;

  return {
    location_id: DEFAULT_SUNSET_LOCATION_ID,
    channel_location_source: 'default',
    fallback: true,
  };
}

function isSunsetClientSlug(clientSlug) {
  return trimStr(clientSlug).toLowerCase() === SUNSET_CLIENT_SLUG;
}

/**
 * Merge inbound channel routing into conversation metadata for Sunset tenant.
 */
function mergeSunsetInboundLocationMetadata(metadata, channelHints, clientSlug, env) {
  if (!isSunsetClientSlug(clientSlug)) {
    return metadata && typeof metadata === 'object' ? { ...metadata } : {};
  }
  const resolved = resolveSunsetLocationFromInboundChannel(channelHints, env);
  const meta = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  meta.location_id = resolved.location_id;
  meta.channel_location_source = resolved.channel_location_source;
  if (resolved.fallback) meta.channel_location_fallback = true;
  else delete meta.channel_location_fallback;
  return meta;
}

function attachConversationChannelMetadata(metadata, locationId, channel, extras) {
  const meta = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  meta.location_id = normalizeSunsetLocationId(locationId || meta.location_id);
  if (channel) meta.channel = String(channel).trim().toLowerCase();
  const x = extras && typeof extras === 'object' ? extras : {};
  if (x.channel_location_source) meta.channel_location_source = x.channel_location_source;
  if (x.channel_location_fallback === true) meta.channel_location_fallback = true;
  return meta;
}

function extractSunsetChannelHintsFromNormalized(normalized) {
  const n = normalized || {};
  return {
    channel: trimStr(n.channel) || 'whatsapp',
    whatsapp_number: trimStr(n.receiving_whatsapp_number || n.display_phone_number || n.whatsapp_number) || null,
    phone_number_id: trimStr(n.phone_number_id) || null,
    inbox_email: trimStr(n.inbox_email || n.to_email || n.receiving_email) || null,
  };
}

module.exports = {
  SUNSET_CLIENT_SLUG,
  DEFAULT_SUNSET_LOCATION_ID,
  resolveSunsetInboxChannelConfig,
  resolveSunsetInboxChannelMap,
  resolveSunsetLocationFromWhatsAppNumber,
  resolveSunsetLocationFromPhoneNumberId,
  resolveSunsetLocationFromInboxEmail,
  resolveSunsetLocationFromInboundChannel,
  mergeSunsetInboundLocationMetadata,
  attachConversationChannelMetadata,
  extractSunsetChannelHintsFromNormalized,
  normalizePhoneDigits,
  normalizeInboxEmail,
};
