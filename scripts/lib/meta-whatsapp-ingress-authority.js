'use strict';

/**
 * FORTRESS Slice 15H — Meta WhatsApp ingress authority policy (B02).
 *
 * Source-only, default-off. When explicitly enabled AND routing config is
 * present on tenant_channel_shadow:
 *   - known phone_number_id → resolver client_slug + location_id are live-
 *     authoritative (override legacy options/default client_slug)
 *   - unknown / missing / ambiguous / conflicting channel identities →
 *     fail closed (invoke_downstream=false) before withPgClient / draft /
 *     send / DB / owner / demo work
 *
 * When disabled, or when enabled but routing config is absent, preserve
 * current shadow-only behavior exactly (no live slug switch, no hard block).
 *
 * Never hardcodes a tenant slug. Never enables itself from deployment config
 * in this slice — activation remains an operator env flip.
 *
 * Implements the frozen 15G2 acceptance boundary
 * (15H_meta_ingress_authority_enforce_before_pg). Deferred 15G tip must not
 * be merged; this module is the clean replacement from master.
 */

const AUTHORITY_ENV_KEY = 'META_WHATSAPP_INGRESS_AUTHORITY';
const AUTHORITY_TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>|null|undefined} env
 * @returns {boolean}
 */
function isMetaWhatsAppIngressAuthorityEnabled(env) {
  const src = env || {};
  const raw = trimStr(src[AUTHORITY_ENV_KEY]);
  if (!raw) return false;
  return AUTHORITY_TRUTHY.has(raw.toLowerCase());
}

/**
 * Classify whether authority mode is active for this normalized payload.
 * Active only when the policy flag is on AND shadow reports routing present.
 *
 * @param {object|null|undefined} normalized
 * @param {object} [options]
 * @param {object} [options.env]
 * @returns {{
 *   ok: boolean,
 *   authority_enabled: boolean,
 *   authority_active: boolean,
 *   invoke_downstream: boolean,
 *   blocked: boolean,
 *   reason: string,
 *   client_slug: string|null,
 *   location_id: string|null,
 *   legacy_client_slug: string|null,
 *   legacy_slug_conflict: boolean,
 *   phone_number_id: string|null,
 * }}
 */
function resolveMetaWhatsAppIngressAuthority(normalized, options = {}) {
  const env = options.env || process.env || {};
  const norm = normalized && typeof normalized === 'object' ? normalized : {};
  const shadow = norm.tenant_channel_shadow && typeof norm.tenant_channel_shadow === 'object'
    ? norm.tenant_channel_shadow
    : null;
  const legacyClientSlug = trimStr(norm.client_slug) || null;
  const phoneNumberId = trimStr(norm.phone_number_id)
    || (shadow && trimStr(shadow.phone_number_id))
    || null;

  const authorityEnabled = isMetaWhatsAppIngressAuthorityEnabled(env);

  if (!authorityEnabled) {
    return {
      ok: true,
      authority_enabled: false,
      authority_active: false,
      invoke_downstream: true,
      blocked: false,
      reason: 'authority_policy_disabled',
      client_slug: legacyClientSlug,
      location_id: trimStr(norm.location_id) || null,
      legacy_client_slug: legacyClientSlug,
      legacy_slug_conflict: false,
      phone_number_id: phoneNumberId,
    };
  }

  const routingPresent = !!(shadow && shadow.routing_config_enabled === true);
  if (!routingPresent) {
    return {
      ok: true,
      authority_enabled: true,
      authority_active: false,
      invoke_downstream: true,
      blocked: false,
      reason: 'authority_inactive_routing_absent',
      client_slug: legacyClientSlug,
      location_id: trimStr(norm.location_id) || null,
      legacy_client_slug: legacyClientSlug,
      legacy_slug_conflict: false,
      phone_number_id: phoneNumberId,
    };
  }

  // Authority ACTIVE — phone_number_id resolution is the only live tenant source.
  if (!phoneNumberId) {
    return {
      ok: false,
      authority_enabled: true,
      authority_active: true,
      invoke_downstream: false,
      blocked: true,
      reason: 'missing_phone_number_id',
      client_slug: null,
      location_id: null,
      legacy_client_slug: legacyClientSlug,
      legacy_slug_conflict: false,
      phone_number_id: null,
    };
  }

  const shadowBlocked = shadow.channel_resolution_blocked === true;
  const shadowReason = trimStr(shadow.channel_resolution_reason) || null;
  const shadowSlug = trimStr(shadow.client_slug) || null;
  const shadowLocation = trimStr(shadow.location_id) || null;

  if (shadowBlocked || shadowReason === 'unknown_channel_identity') {
    return {
      ok: false,
      authority_enabled: true,
      authority_active: true,
      invoke_downstream: false,
      blocked: true,
      reason: shadowReason || 'unknown_channel_identity',
      client_slug: null,
      location_id: null,
      legacy_client_slug: legacyClientSlug,
      legacy_slug_conflict: false,
      phone_number_id: phoneNumberId,
    };
  }

  if (shadowReason === 'missing_phone_number_id') {
    return {
      ok: false,
      authority_enabled: true,
      authority_active: true,
      invoke_downstream: false,
      blocked: true,
      reason: 'missing_phone_number_id',
      client_slug: null,
      location_id: null,
      legacy_client_slug: legacyClientSlug,
      legacy_slug_conflict: false,
      phone_number_id: phoneNumberId,
    };
  }

  // Ambiguous: routing says resolved (not blocked) but identity incomplete.
  if (!shadowSlug || !shadowLocation) {
    return {
      ok: false,
      authority_enabled: true,
      authority_active: true,
      invoke_downstream: false,
      blocked: true,
      reason: 'ambiguous_channel_identity',
      client_slug: shadowSlug,
      location_id: shadowLocation,
      legacy_client_slug: legacyClientSlug,
      legacy_slug_conflict: false,
      phone_number_id: phoneNumberId,
    };
  }

  // Conflicting: shadow claims a resolved tenant while also carrying a block
  // reason, or registry ownership fails when a registry is supplied.
  if (shadowReason && shadowReason !== 'routing_config_absent') {
    return {
      ok: false,
      authority_enabled: true,
      authority_active: true,
      invoke_downstream: false,
      blocked: true,
      reason: 'conflicting_channel_identity',
      client_slug: shadowSlug,
      location_id: shadowLocation,
      legacy_client_slug: legacyClientSlug,
      legacy_slug_conflict: false,
      phone_number_id: phoneNumberId,
    };
  }

  const registry = options.registry || null;
  if (registry && registry.bySlug) {
    const client = registry.bySlug[shadowSlug];
    if (!client || !client.location_ids || !client.location_ids.has(shadowLocation)) {
      return {
        ok: false,
        authority_enabled: true,
        authority_active: true,
        invoke_downstream: false,
        blocked: true,
        reason: 'conflicting_channel_identity',
        client_slug: shadowSlug,
        location_id: shadowLocation,
        legacy_client_slug: legacyClientSlug,
        legacy_slug_conflict: false,
        phone_number_id: phoneNumberId,
      };
    }
  }

  const legacySlugConflict = !!(
    legacyClientSlug
    && shadowSlug
    && legacyClientSlug !== shadowSlug
  );

  return {
    ok: true,
    authority_enabled: true,
    authority_active: true,
    invoke_downstream: true,
    blocked: false,
    reason: 'phone_number_id_authoritative',
    client_slug: shadowSlug,
    location_id: shadowLocation,
    legacy_client_slug: legacyClientSlug,
    legacy_slug_conflict: legacySlugConflict,
    phone_number_id: phoneNumberId,
  };
}

/**
 * Apply authority decision onto a normalized Meta webhook object.
 * Disabled / routing-absent paths return the input object unchanged
 * (plus an explicit ingress_authority record when authority was considered).
 *
 * @param {object} normalized
 * @param {object} [options]
 * @returns {object}
 */
function applyMetaWhatsAppIngressAuthority(normalized, options = {}) {
  if (!normalized || typeof normalized !== 'object') return normalized;

  const decision = resolveMetaWhatsAppIngressAuthority(normalized, options);

  // Fully disabled → preserve shadow-only normalize output exactly (no new
  // fields, no live slug/location mutation).
  if (!decision.authority_enabled) {
    return normalized;
  }

  const ingressAuthority = {
    enabled: decision.authority_enabled,
    active: decision.authority_active,
    blocked: decision.blocked,
    reason: decision.reason,
    invoke_downstream: decision.invoke_downstream,
    source: decision.authority_active ? 'phone_number_id' : null,
    legacy_client_slug: decision.legacy_client_slug,
    legacy_slug_conflict: decision.legacy_slug_conflict === true,
    phone_number_id: decision.phone_number_id,
  };

  // Enabled but routing absent → still shadow-only for live tenant fields.
  if (!decision.authority_active) {
    return {
      ...normalized,
      ingress_authority: ingressAuthority,
    };
  }

  if (decision.blocked) {
    return {
      ...normalized,
      ingress_authority: ingressAuthority,
      // Do not switch live tenant on a blocked identity.
    };
  }

  return {
    ...normalized,
    client_slug: decision.client_slug,
    location_id: decision.location_id,
    ingress_authority: {
      ...ingressAuthority,
      client_slug: decision.client_slug,
      location_id: decision.location_id,
    },
  };
}

/**
 * True when normalize/inbound must skip draft, send, and DB persistence.
 * @param {object|null|undefined} normalized
 */
function shouldBlockMetaWhatsAppIngressDownstream(normalized) {
  const ia = normalized && normalized.ingress_authority;
  return !!(ia && ia.active === true && ia.blocked === true && ia.invoke_downstream === false);
}

/**
 * FORTRESS 15G2 / 15H — REPLAY_IDENTITY_COMPARE_REJECT_FILL.
 * Compare stored nonempty client_slug/location_id with authoritative identity;
 * reject conflicts; fill legacy-missing location in the response without
 * rewriting stored history.
 *
 * @param {object|null|undefined} storedNormalized
 * @param {object|null|undefined} authoritativeNormalized
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   response_normalized?: object,
 *   history_rewritten: boolean,
 *   filled_legacy_missing_location?: boolean,
 * }}
 */
function resolveReplayNormalizedIdentity(storedNormalized, authoritativeNormalized) {
  const stored = storedNormalized && typeof storedNormalized === 'object' ? storedNormalized : {};
  const auth = authoritativeNormalized && typeof authoritativeNormalized === 'object'
    ? authoritativeNormalized
    : {};

  const storedSlug = trimStr(stored.client_slug);
  const authSlug = trimStr(auth.client_slug);
  const storedLoc = trimStr(stored.location_id);
  const authLoc = trimStr(auth.location_id);

  if (storedSlug && authSlug && storedSlug !== authSlug) {
    return {
      ok: false,
      reason: 'replay_client_slug_conflict',
      history_rewritten: false,
      stored_client_slug: storedSlug,
      authoritative_client_slug: authSlug,
    };
  }
  if (storedLoc && authLoc && storedLoc !== authLoc) {
    return {
      ok: false,
      reason: 'replay_location_id_conflict',
      history_rewritten: false,
      stored_location_id: storedLoc,
      authoritative_location_id: authLoc,
    };
  }

  const responseNormalized = { ...stored };
  if (authSlug) {
    responseNormalized.client_slug = authSlug;
  }
  if (!storedLoc && authLoc) {
    responseNormalized.location_id = authLoc;
  } else if (storedLoc) {
    responseNormalized.location_id = storedLoc;
  }

  return {
    ok: true,
    response_normalized: responseNormalized,
    history_rewritten: false,
    filled_legacy_missing_location: !storedLoc && !!authLoc,
  };
}

/**
 * Attach effective normalized identity onto a thrown/returned failure shape
 * (FORTRESS 15G2 ERROR_IDENTITY_STRUCTURED_EFFECTIVE_NORMALIZED).
 *
 * @param {Error|object|string} err
 * @param {object} effectiveNormalized
 * @returns {Error}
 */
function attachEffectiveNormalizedToError(err, effectiveNormalized) {
  const base = err instanceof Error ? err : new Error(err == null ? 'meta_whatsapp_ingress_downstream_error' : String(err));
  if (base.effective_normalized == null && effectiveNormalized && typeof effectiveNormalized === 'object') {
    base.effective_normalized = effectiveNormalized;
  }
  if (base.name === 'Error' && !(err instanceof Error)) {
    base.name = 'MetaWhatsAppIngressDownstreamError';
  }
  return base;
}

module.exports = {
  AUTHORITY_ENV_KEY,
  isMetaWhatsAppIngressAuthorityEnabled,
  resolveMetaWhatsAppIngressAuthority,
  applyMetaWhatsAppIngressAuthority,
  shouldBlockMetaWhatsAppIngressDownstream,
  resolveReplayNormalizedIdentity,
  attachEffectiveNormalizedToError,
};
