'use strict';

/**
 * FORTRESS Slice 15F — bind generic /staff/bot/* request tenant to bot principal.
 *
 * Closes B07: body/query/path aliases and hardcoded defaults must not override
 * the authenticated bot principal's client_slug. Explicit conflicts fail closed
 * before any handler/DB/provider work. Force-tenant routes stay path-forced.
 * Staff-session / open modes preserve request selection (+ omission → session
 * principal when present). Never hardcodes a tenant slug.
 */

const {
  trimSlug,
  isStaffBotInternalPrincipal,
  dispatchStaffBotRouteWithEffectiveTenant,
} = require('./staff-bot-principal-tenant-config');

const BODY_ALIAS_KEYS = ['client_slug', 'client'];
const QUERY_ALIAS_KEYS = ['client_slug', 'client'];

/**
 * Collect present tenant alias fields from body/query (including null,
 * undefined, empty strings, and non-strings). Key absence is omission.
 * @param {object|null|undefined} body
 * @param {object|null|undefined} query
 * @returns {Array<{ source: string, key: string, raw: * }>}
 */
function collectStaffBotRequestTenantAliases(body, query) {
  const out = [];
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const key of BODY_ALIAS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        out.push({ source: 'body', key, raw: body[key] });
      }
    }
  }
  if (query && typeof query === 'object' && !Array.isArray(query)) {
    for (const key of QUERY_ALIAS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(query, key)) {
        out.push({ source: 'query', key, raw: query[key] });
      }
    }
  }
  return out;
}

/**
 * Resolve the effective client_slug for a generic bot route request.
 *
 * @param {{
 *   authMode?: string|null,
 *   user?: object|null,
 *   principalClientSlug?: string|null,
 *   body?: object|null,
 *   query?: object|null,
 *   forceTenantSlug?: string|null,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   invoke_handler: boolean,
 *   reason: string,
 *   effective_client_slug: string|null,
 *   requested_client_slug: string|null,
 *   principal_client_slug: string|null,
 *   source: string|null,
 *   defer_default: boolean,
 * }}
 */
function resolveStaffBotRequestEffectiveTenant(input) {
  const src = input && typeof input === 'object' ? input : {};
  const authMode = src.authMode == null ? '' : String(src.authMode).trim();
  const force = trimSlug(src.forceTenantSlug);
  const principal = trimSlug(
    src.principalClientSlug != null
      ? src.principalClientSlug
      : (src.user && src.user.client_slug),
  );
  const aliases = collectStaffBotRequestTenantAliases(src.body, src.query);

  if (force) {
    return {
      ok: true,
      invoke_handler: true,
      reason: 'force_tenant',
      effective_client_slug: force,
      requested_client_slug: null,
      principal_client_slug: principal || null,
      source: 'path_force',
      defer_default: false,
    };
  }

  // Present alias keys: distinguish absence (omission) from explicit
  // null / undefined / empty / non-string — those fail closed. True omission
  // (key not collected) still falls through to the trusted principal.
  for (const alias of aliases) {
    const raw = alias.raw;
    const invalid = raw == null
      || typeof raw !== 'string'
      || raw.trim() === '';
    if (invalid) {
      return {
        ok: false,
        invoke_handler: false,
        reason: 'empty_request_tenant_alias',
        effective_client_slug: principal || null,
        requested_client_slug: typeof raw === 'string' ? raw.trim() : '',
        principal_client_slug: principal || null,
        source: `${alias.source}.${alias.key}`,
        defer_default: false,
      };
    }
  }

  const nonempty = [];
  for (const alias of aliases) {
    const trimmed = trimSlug(alias.raw);
    if (trimmed) nonempty.push(trimmed);
  }
  const unique = Array.from(new Set(nonempty));
  if (unique.length > 1) {
    return {
      ok: false,
      invoke_handler: false,
      reason: 'conflicting_request_tenant_aliases',
      effective_client_slug: principal || null,
      requested_client_slug: unique.join(','),
      principal_client_slug: principal || null,
      source: 'body_query',
      defer_default: false,
    };
  }
  const requested = unique[0] || null;

  const isBotPrincipal = authMode === 'bot_token'
    || isStaffBotInternalPrincipal(src.user);

  if (isBotPrincipal) {
    if (!principal) {
      return {
        ok: false,
        invoke_handler: false,
        reason: 'missing_principal_client_slug',
        effective_client_slug: null,
        requested_client_slug: requested,
        principal_client_slug: null,
        source: null,
        defer_default: false,
      };
    }
    if (requested && requested !== principal) {
      return {
        ok: false,
        invoke_handler: false,
        reason: 'request_tenant_conflict',
        effective_client_slug: principal,
        requested_client_slug: requested,
        principal_client_slug: principal,
        source: 'bot_principal',
        defer_default: false,
      };
    }
    return {
      ok: true,
      invoke_handler: true,
      reason: requested ? 'principal_tenant_matched' : 'principal_tenant_omission',
      effective_client_slug: principal,
      requested_client_slug: requested,
      principal_client_slug: principal,
      source: 'bot_principal',
      defer_default: false,
    };
  }

  // Staff session: preserve request selection; omission → session principal when set.
  if (authMode === 'session') {
    const effective = requested || principal || null;
    if (!effective) {
      return {
        ok: true,
        invoke_handler: true,
        reason: 'session_tenant_deferred',
        effective_client_slug: null,
        requested_client_slug: requested,
        principal_client_slug: principal || null,
        source: 'session',
        defer_default: true,
      };
    }
    return {
      ok: true,
      invoke_handler: true,
      reason: requested ? 'session_request_tenant' : 'session_principal_omission',
      effective_client_slug: effective,
      requested_client_slug: requested,
      principal_client_slug: principal || null,
      source: 'session',
      defer_default: false,
    };
  }

  // Open/dev: allow request alias; omission may defer to caller default (not hardcoded here).
  const openEffective = requested || principal || null;
  return {
    ok: true,
    invoke_handler: true,
    reason: 'open_auth',
    effective_client_slug: openEffective,
    requested_client_slug: requested,
    principal_client_slug: principal || null,
    source: 'open',
    defer_default: !openEffective,
  };
}

/**
 * Pin effective tenant onto req + cached body/query so handlers cannot be
 * overridden by stale aliases. Does not invent a hardcoded default.
 *
 * @param {object} req
 * @param {object|null} body
 * @param {object|null|undefined} query
 * @param {string} effectiveClientSlug
 */
function pinStaffBotRequestEffectiveTenant(req, body, query, effectiveClientSlug) {
  const slug = trimSlug(effectiveClientSlug);
  if (!slug || !req) return;
  req._botBoundClientSlug = slug;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    body.client_slug = slug;
    if (Object.prototype.hasOwnProperty.call(body, 'client')) {
      body.client = slug;
    }
    req._cachedBody = JSON.stringify(body);
  }
  if (query && typeof query === 'object' && !Array.isArray(query)) {
    if (Object.prototype.hasOwnProperty.call(query, 'client_slug')
      || Object.prototype.hasOwnProperty.call(query, 'client')) {
      query.client_slug = slug;
      query.client = slug;
    }
  }
}

/**
 * Resolve trusted client slug inside a bot handler after principal bind dispatch.
 * Prefer req._botBoundClientSlug. Never invent a hardcoded tenant; optional
 * legacyDefault is only for session/open defer paths still owned outside B07.
 *
 * @param {object|null|undefined} req
 * @param {object|null|undefined} body
 * @param {object|null|undefined} query
 * @param {string|null|undefined} legacyDefault
 * @returns {string}
 */
function resolveBotHandlerTrustedClientSlug(req, body, query, legacyDefault) {
  if (req && req._botBoundClientSlug) {
    return trimSlug(req._botBoundClientSlug);
  }
  const fromBody = body && typeof body === 'object'
    ? trimSlug(body.client_slug || body.client)
    : '';
  if (fromBody) return fromBody;
  const fromQuery = query && typeof query === 'object'
    ? trimSlug(query.client_slug || query.client)
    : '';
  if (fromQuery) return fromQuery;
  return trimSlug(legacyDefault);
}

/**
 * Common generic-bot dispatch: resolve request tenant from principal, fail
 * closed on conflict/empty aliases, pin effective slug, then invoke handler
 * only when principal ACL allows the effective tenant (15E gate).
 *
 * @param {{
 *   user?: object|null,
 *   authMode?: string|null,
 *   body?: object|null,
 *   query?: object|null,
 *   forceTenantSlug?: string|null,
 *   staffAuthRequired?: boolean,
 *   canAccessClient?: (user: object, clientSlug: string) => boolean,
 *   handler: (ctx: {
 *     user: object|null,
 *     authMode: string|null,
 *     effectiveClientSlug: string|null,
 *     resolveReason: string,
 *   }) => *,
 *   onDenied?: (gate: object) => void,
 * }} input
 */
function dispatchStaffBotRouteWithPrincipalRequestTenant(input) {
  const src = input && typeof input === 'object' ? input : {};
  const resolved = resolveStaffBotRequestEffectiveTenant({
    authMode: src.authMode,
    user: src.user,
    principalClientSlug: src.user && src.user.client_slug,
    body: src.body,
    query: src.query,
    forceTenantSlug: src.forceTenantSlug,
  });

  if (!resolved.ok || !resolved.invoke_handler) {
    if (typeof src.onDenied === 'function') {
      src.onDenied({
        reason: resolved.reason,
        effective_client_slug: resolved.effective_client_slug,
        requested_client_slug: resolved.requested_client_slug,
        principal_client_slug: resolved.principal_client_slug,
      });
    }
    return {
      ok: false,
      handler_called: false,
      reason: resolved.reason,
      effective_client_slug: resolved.effective_client_slug,
      requested_client_slug: resolved.requested_client_slug,
      result: null,
      resolve: resolved,
    };
  }

  const authMode = src.authMode == null ? '' : String(src.authMode).trim();
  const effectiveForGate = resolved.defer_default
    ? null
    : resolved.effective_client_slug;

  // Session/open: preserve prior handler assert/DEFAULT paths. Pin when we have an
  // effective slug, but do not apply bot-principal ACL gate here (B07 owns bot_token).
  const skipAclGate = authMode === 'session'
    || authMode === 'open'
    || resolved.defer_default
    || !effectiveForGate;

  if (skipAclGate) {
    if (typeof src.handler !== 'function') {
      return {
        ok: false,
        handler_called: false,
        reason: 'missing_handler',
        effective_client_slug: effectiveForGate,
        requested_client_slug: resolved.requested_client_slug,
        result: null,
        resolve: resolved,
      };
    }
    const result = src.handler({
      user: src.user || null,
      authMode: src.authMode == null ? null : src.authMode,
      effectiveClientSlug: effectiveForGate,
      resolveReason: resolved.reason,
    });
    return {
      ok: true,
      handler_called: true,
      reason: resolved.reason,
      effective_client_slug: effectiveForGate,
      requested_client_slug: resolved.requested_client_slug,
      result,
      resolve: resolved,
    };
  }

  return dispatchStaffBotRouteWithEffectiveTenant({
    user: src.user,
    authMode: src.authMode,
    effectiveClientSlug: effectiveForGate,
    staffAuthRequired: src.staffAuthRequired,
    canAccessClient: src.canAccessClient,
    onDenied: src.onDenied,
    handler: ({ user, authMode: mode }) => src.handler({
      user,
      authMode: mode,
      effectiveClientSlug: effectiveForGate,
      resolveReason: resolved.reason,
    }),
  });
}

module.exports = {
  BODY_ALIAS_KEYS,
  QUERY_ALIAS_KEYS,
  collectStaffBotRequestTenantAliases,
  resolveStaffBotRequestEffectiveTenant,
  pinStaffBotRequestEffectiveTenant,
  resolveBotHandlerTrustedClientSlug,
  dispatchStaffBotRouteWithPrincipalRequestTenant,
};
