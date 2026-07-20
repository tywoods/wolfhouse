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

/**
 * Gate a tenant-specific bot route: principal must access the route's effective
 * tenant before any handler runs. Does not select body/query tenant (B07).
 * Open/dev mode (no staff auth / null user / auth_mode=open) preserves prior bypass.
 *
 * @param {{
 *   user?: object|null,
 *   authMode?: string|null,
 *   effectiveClientSlug?: string|null,
 *   staffAuthRequired?: boolean,
 *   canAccessClient?: (user: object, clientSlug: string) => boolean,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   reason: string,
 *   invoke_handler: boolean,
 *   effective_client_slug: string|null,
 * }}
 */
function evaluateStaffBotRouteTenantGate(input) {
  const src = input && typeof input === 'object' ? input : {};
  const staffAuthRequired = !!src.staffAuthRequired;
  const authMode = src.authMode == null ? '' : String(src.authMode).trim();
  const effective = trimSlug(src.effectiveClientSlug);
  const user = src.user || null;
  const canAccess = typeof src.canAccessClient === 'function'
    ? src.canAccessClient
    : null;

  if (!staffAuthRequired || authMode === 'open' || !user) {
    return {
      ok: true,
      reason: 'open_auth_bypass',
      invoke_handler: true,
      effective_client_slug: effective || null,
    };
  }

  if (!effective) {
    return {
      ok: false,
      reason: 'missing_effective_client_slug',
      invoke_handler: false,
      effective_client_slug: null,
    };
  }

  if (!canAccess || !canAccess(user, effective)) {
    return {
      ok: false,
      reason: 'bot_principal_tenant_denied',
      invoke_handler: false,
      effective_client_slug: effective,
    };
  }

  return {
    ok: true,
    reason: 'principal_tenant_allowed',
    invoke_handler: true,
    effective_client_slug: effective,
  };
}

/**
 * Common bot-route dispatch boundary: propagate principal into handler only when
 * the gate allows the route's effective tenant. On denial, handler is never called.
 *
 * @param {{
 *   user?: object|null,
 *   authMode?: string|null,
 *   effectiveClientSlug?: string|null,
 *   staffAuthRequired?: boolean,
 *   canAccessClient?: (user: object, clientSlug: string) => boolean,
 *   handler: (ctx: { user: object|null, authMode: string|null }) => *,
 *   onDenied?: (gate: object) => void,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   handler_called: boolean,
 *   reason: string,
 *   effective_client_slug: string|null,
 *   result: *|null,
 * }}
 */
function dispatchStaffBotRouteWithEffectiveTenant(input) {
  const src = input && typeof input === 'object' ? input : {};
  const gate = evaluateStaffBotRouteTenantGate(src);
  if (!gate.invoke_handler) {
    if (typeof src.onDenied === 'function') src.onDenied(gate);
    return {
      ok: false,
      handler_called: false,
      reason: gate.reason,
      effective_client_slug: gate.effective_client_slug,
      result: null,
    };
  }
  if (typeof src.handler !== 'function') {
    return {
      ok: false,
      handler_called: false,
      reason: 'missing_handler',
      effective_client_slug: gate.effective_client_slug,
      result: null,
    };
  }
  const result = src.handler({
    user: src.user || null,
    authMode: src.authMode == null ? null : src.authMode,
  });
  return {
    ok: true,
    handler_called: true,
    reason: gate.reason,
    effective_client_slug: gate.effective_client_slug,
    result,
  };
}

module.exports = {
  BOT_STAFF_USER_ID,
  BOT_ROLE,
  trimSlug,
  isPlausibleClientSlug,
  resolveStaffBotPrincipalClientSlug,
  buildStaffBotAuthPrincipal,
  isStaffBotInternalPrincipal,
  evaluateStaffBotRouteTenantGate,
  dispatchStaffBotRouteWithEffectiveTenant,
};
