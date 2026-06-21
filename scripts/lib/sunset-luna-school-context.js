'use strict';

/**
 * Sunset Luna / Staff API school context helpers.
 * Tenant = sunset; locations = sunset-somo (Sunset) | sunset-sardinero (elSardi).
 * Wolfhouse callers must remain unchanged — guard every export with isSunsetClientSlug.
 */

const {
  SUNSET_CLIENT_SLUG,
  DEFAULT_SUNSET_LOCATION_ID,
  SUNSET_LOCATIONS,
  normalizeSunsetLocationId,
  resolveConversationLocationId,
} = require('./sunset-school-locations');
const { resolveSunsetInboxChannelConfig } = require('./sunset-inbox-channel-config');
const { resolveTenantBusinessConfig } = require('./tenant-business-config');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return { ...raw };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function isSunsetClientSlug(clientSlug) {
  return trimStr(clientSlug).toLowerCase() === SUNSET_CLIENT_SLUG;
}

function resolveSunsetSchoolDisplayName(locationId) {
  const id = normalizeSunsetLocationId(locationId);
  const loc = SUNSET_LOCATIONS.find((l) => l.id === id);
  return loc ? loc.displayName : SUNSET_LOCATIONS[0].displayName;
}

function buildSunsetSchoolChannelMeta(locationId, env) {
  const channel = resolveSunsetInboxChannelConfig(locationId, env);
  return {
    location_id: channel.location_id,
    display_name: channel.display_name,
    label_key: channel.label_key,
    whatsapp_configured: !String(channel.whatsapp_number || '').startsWith('PLACEHOLDER'),
    email_configured: !String(channel.email_address || '').startsWith('PLACEHOLDER'),
    channel_placeholders: {
      whatsapp_number: channel.whatsapp_placeholder,
      email_address: channel.email_placeholder,
      whatsapp_phone_number_id: channel.whatsapp_phone_number_id_placeholder,
    },
  };
}

function buildSunsetSchoolContext(locationId, env) {
  const id = normalizeSunsetLocationId(locationId);
  const channel = buildSunsetSchoolChannelMeta(id, env);
  return {
    client_slug: SUNSET_CLIENT_SLUG,
    location_id: id,
    school_display_name: channel.display_name,
    label_key: channel.label_key,
    channel: channel,
  };
}

function resolveSunsetLocationFromSources(sources) {
  const src = sources || {};
  if (src.location_id) return normalizeSunsetLocationId(src.location_id);
  if (src.school_context && src.school_context.location_id) {
    return normalizeSunsetLocationId(src.school_context.location_id);
  }
  if (src.conversation_metadata) {
    return resolveConversationLocationId(src.conversation_metadata);
  }
  if (src.metadata) return resolveConversationLocationId(src.metadata);
  return DEFAULT_SUNSET_LOCATION_ID;
}

function resolveSunsetSchoolContextForGuest(guestContext, env) {
  const loc = resolveSunsetLocationFromSources(guestContext);
  return buildSunsetSchoolContext(loc, env);
}

function attachSunsetSchoolToGuestContext(guestContext, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const clientSlug = trimStr(opts.client_slug || (guestContext && guestContext.client_slug));
  if (!isSunsetClientSlug(clientSlug)) return guestContext || {};

  const locationId = resolveSunsetLocationFromSources({
    location_id: opts.location_id,
    school_context: guestContext && guestContext.school_context,
    conversation_metadata: opts.conversation_metadata,
    metadata: opts.metadata,
  });
  const school = buildSunsetSchoolContext(locationId, env);

  return {
    ...(guestContext || {}),
    client_slug: SUNSET_CLIENT_SLUG,
    location_id: school.location_id,
    school_context: school,
  };
}

async function loadSunsetSchoolContextFromConversation(pg, clientSlug, conversationId, env) {
  if (!pg || !isSunsetClientSlug(clientSlug) || !conversationId) return null;
  const r = await pg.query(
    `SELECT conv.metadata
       FROM conversations conv
       INNER JOIN clients c ON c.id = conv.client_id
      WHERE c.slug = $1 AND conv.id = $2::uuid
      LIMIT 1`,
    [SUNSET_CLIENT_SLUG, conversationId],
  );
  if (!r.rows[0]) return null;
  const meta = parseMetadata(r.rows[0].metadata);
  return buildSunsetSchoolContext(resolveConversationLocationId(meta), env);
}

function resolveSunsetAdminConfigForLuna(clientSlug, locationId) {
  if (!isSunsetClientSlug(clientSlug)) return null;
  const loc = normalizeSunsetLocationId(locationId);
  return resolveTenantBusinessConfig(SUNSET_CLIENT_SLUG, loc);
}

function enrichToolContextWithSunsetSchool(ctx) {
  const base = ctx || {};
  if (!isSunsetClientSlug(base.client_slug)) return base;

  const school = base.school_context
    || resolveSunsetSchoolContextForGuest(base.prior_guest_context || base, base.env);
  return {
    ...base,
    client_slug: SUNSET_CLIENT_SLUG,
    location_id: school.location_id,
    school_context: school,
  };
}

function withSunsetLocationIdOnPayload(payload, clientSlug, locationId) {
  if (!isSunsetClientSlug(clientSlug)) return payload || {};
  const out = { ...(payload || {}) };
  out.client_slug = SUNSET_CLIENT_SLUG;
  out.location_id = normalizeSunsetLocationId(
    locationId || out.location_id || DEFAULT_SUNSET_LOCATION_ID,
  );
  return out;
}

function buildSunsetSchoolPromptHint(schoolContext) {
  const sc = schoolContext || {};
  const name = sc.school_display_name || resolveSunsetSchoolDisplayName(sc.location_id);
  const loc = normalizeSunsetLocationId(sc.location_id);
  return [
    `School: ${name} (location_id=${loc}).`,
    'Use this school name when referring to the location.',
    'Prices, lesson times, and capacity must come from admin config/tools for this location_id only.',
    'Do not mix Sunset (Somo) and elSardi context.',
  ].join(' ');
}

function slimSunsetSchoolContextForChain(schoolContext) {
  if (!schoolContext) return null;
  return {
    location_id: schoolContext.location_id,
    school_display_name: schoolContext.school_display_name,
    label_key: schoolContext.label_key,
  };
}

function appendSunsetAskLunaLocationFilter(baseSql, locationId, paramIndex) {
  const loc = normalizeSunsetLocationId(locationId);
  const sql = String(baseSql || '').trim();
  if (!sql) return { sql, params: [] };
  const clause = ` AND COALESCE(metadata->>'location_id', '${DEFAULT_SUNSET_LOCATION_ID}') = $${paramIndex}`;
  return { sql: `${sql}${clause}`, locationParam: loc };
}

function buildSunsetAskLunaQueryParams(clientSlug, baseParams, locationId) {
  if (!isSunsetClientSlug(clientSlug)) {
    return { sqlSuffix: '', params: baseParams || [] };
  }
  const loc = normalizeSunsetLocationId(locationId);
  return {
    sqlSuffix: ` AND COALESCE(metadata->>'location_id', '${DEFAULT_SUNSET_LOCATION_ID}') = $${(baseParams || []).length + 1}`,
    params: [...(baseParams || []), loc],
  };
}

module.exports = {
  SUNSET_CLIENT_SLUG,
  DEFAULT_SUNSET_LOCATION_ID,
  isSunsetClientSlug,
  resolveSunsetSchoolDisplayName,
  buildSunsetSchoolContext,
  buildSunsetSchoolChannelMeta,
  resolveSunsetLocationFromSources,
  resolveSunsetSchoolContextForGuest,
  attachSunsetSchoolToGuestContext,
  loadSunsetSchoolContextFromConversation,
  resolveSunsetAdminConfigForLuna,
  enrichToolContextWithSunsetSchool,
  withSunsetLocationIdOnPayload,
  buildSunsetSchoolPromptHint,
  slimSunsetSchoolContextForChain,
  appendSunsetAskLunaLocationFilter,
  buildSunsetAskLunaQueryParams,
};
