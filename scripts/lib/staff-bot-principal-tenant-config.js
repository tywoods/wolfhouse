'use strict';

/**
 * FORTRESS Slice 15E — authoritative Staff API bot-token principal tenant binding.
 *
 * Derives the single runtime client_slug that an authenticated internal bot
 * principal may carry. Never trusts request body/query/path as tenant authority
 * (that remains B07). Never hardcodes any tenant slug.
 *
 * Priority:
 *   1. LUNA_BOT_CLIENT_SLUG (dedicated, preferred)
 *   2. DEFAULT_CLIENT_SLUG only when nonempty (compat fallback)
 *   3. If both set and conflict → fail closed
 *   4. If neither set → fail closed
 *   5. Optional knownClientSlugs allowlist → fail closed when unresolved slug absent
 */

const BOT_STAFF_USER_ID = 'luna-bot-internal';
const BOT_ROLE = 'operator';

function trimSlug(v) {
  if (v == null) return '';
  return String(v).trim();
}

function isPlausibleClientSlug(slug) {
  // Baseline slugs are lowercase kebab tokens (e.g. tenant-location).
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @returns {{
 *   ok: boolean,
 *   client_slug: string|null,
 *   reason: string,
 *   source: string|null,
 * }}
 */
function resolveStaffBotPrincipalClientSlug(env) {
  const src = env || process.env || {};
  const botSlug = trimSlug(src.LUNA_BOT_CLIENT_SLUG);
  const defaultSlug = trimSlug(src.DEFAULT_CLIENT_SLUG);

  if (botSlug && defaultSlug && botSlug !== defaultSlug) {
    return {
      ok: false,
      client_slug: null,
      reason: 'conflicting_runtime_client_slugs',
      source: null,
    };
  }

  const chosen = botSlug || defaultSlug;
  const source = botSlug
    ? 'LUNA_BOT_CLIENT_SLUG'
    : (defaultSlug ? 'DEFAULT_CLIENT_SLUG' : null);

  if (!chosen) {
    return {
      ok: false,
      client_slug: null,
      reason: 'missing_runtime_client_slug',
      source: null,
    };
  }

  if (!isPlausibleClientSlug(chosen)) {
    return {
      ok: false,
      client_slug: null,
      reason: 'invalid_runtime_client_slug',
      source,
    };
  }

  return {
    ok: true,
    client_slug: chosen,
    reason: botSlug ? 'luna_bot_client_slug' : 'default_client_slug_compat',
    source,
  };
}

/**
 * Build the authenticated bot principal, fail-closed on missing/invalid/unknown tenant.
 *
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @param {{ knownClientSlugs?: string[] }} [options]
 * @returns {{
 *   ok: boolean,
 *   user: { role: string, staff_user_id: string, client_slug: string }|null,
 *   reason: string,
 *   source: string|null,
 * }}
 */
function buildStaffBotAuthPrincipal(env, options) {
  const resolved = resolveStaffBotPrincipalClientSlug(env);
  if (!resolved.ok) {
    return {
      ok: false,
      user: null,
      reason: resolved.reason,
      source: resolved.source,
    };
  }

  const known = options && Array.isArray(options.knownClientSlugs)
    ? options.knownClientSlugs.map((s) => trimSlug(s)).filter(Boolean)
    : null;

  if (known && known.length > 0 && !known.includes(resolved.client_slug)) {
    return {
      ok: false,
      user: null,
      reason: 'unknown_runtime_client_slug',
      source: resolved.source,
    };
  }

  return {
    ok: true,
    user: {
      role: BOT_ROLE,
      staff_user_id: BOT_STAFF_USER_ID,
      client_slug: resolved.client_slug,
    },
    reason: resolved.reason,
    source: resolved.source,
  };
}

function isStaffBotInternalPrincipal(user) {
  return !!(user && user.staff_user_id === BOT_STAFF_USER_ID);
}

module.exports = {
  BOT_STAFF_USER_ID,
  BOT_ROLE,
  trimSlug,
  isPlausibleClientSlug,
  resolveStaffBotPrincipalClientSlug,
  buildStaffBotAuthPrincipal,
  isStaffBotInternalPrincipal,
};
