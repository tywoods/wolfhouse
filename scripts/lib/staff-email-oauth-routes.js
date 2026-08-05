'use strict';

const https = require('https');
const crypto = require('crypto');
const {
  createMicrosoftOAuthTransactionService,
  createPostgresOAuthTransactionRepository,
  isStartEnabled,
  isCallbackEnabled,
  INPUT_KEYS,
} = require('./email-microsoft-oauth-transaction-service');
const {
  createSunsetStagingMicrosoftOAuthCallbackRuntime,
  DEPENDENCY_KEYS,
  DEPENDENCY_KEYS_WITH_ENVELOPE,
} = require('./email-microsoft-oauth-sunset-staging-runtime-composition');

const OAUTH_START_PATH = '/staff/admin/email-settings/oauth/microsoft/start';
const OAUTH_CALLBACK_PATH = '/staff/email/oauth/microsoft/callback';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One tenant-safe resolve: Sunset client + active location + exact eligible
 * Microsoft delegated endpoint. Ambiguity / missing → zero or multi rows.
 * Filters match transaction INSERT eligibility (provider/auth/connector/status)
 * and require public_address present.
 */
const SQL_RESOLVE_START_BINDING = `
SELECT c.id::text AS client_id,
       l.id::text AS location_id,
       e.id::text AS endpoint_id
  FROM clients c
  INNER JOIN tenant_locations l
    ON l.client_id = c.id
  INNER JOIN tenant_channel_endpoints e
    ON e.client_id = c.id
   AND e.location_id = l.location_id
 WHERE c.slug = 'sunset'
   AND l.location_id = $1
   AND l.active = true
   AND e.provider = 'microsoft_graph'
   AND e.auth_mode = 'delegated_authorization_code'
   AND e.connector_mode = 'microsoft_delegated_oauth'
   AND e.binding_status IN ('unverified_offline', 'pending_manual_validation')
   AND e.public_address IS NOT NULL
   AND btrim(e.public_address) <> ''`.replace(/\s+/g, ' ').trim();

function validBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) {
    return false;
  }
  const keys = Object.keys(body);
  return keys.length === 1
    && keys[0] === 'location_id'
    && typeof body.location_id === 'string'
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.location_id);
}

function nativeRuntimeSurfaces(deps) {
  // Optional test injection of natives / envelope without env production bypass.
  const injectedHttps = deps && deps.oauthHttps;
  const injectedCrypto = deps && deps.oauthCrypto;
  const injectedTimers = deps && deps.oauthTimers;
  const httpsSurface = injectedHttps || Object.freeze({
    request(...args) {
      return Reflect.apply(https.request, https, args);
    },
  });
  const cryptoSurface = injectedCrypto || Object.freeze({
    createPublicKey(...args) {
      return Reflect.apply(crypto.createPublicKey, crypto, args);
    },
    verify(...args) {
      return Reflect.apply(crypto.verify, crypto, args);
    },
  });
  const timersSurface = injectedTimers || Object.freeze({
    setTimeout(...args) {
      return Reflect.apply(setTimeout, globalThis, args);
    },
    clearTimeout(...args) {
      return Reflect.apply(clearTimeout, globalThis, args);
    },
  });
  return Object.freeze({
    https: httpsSurface,
    crypto: cryptoSurface,
    timers: timersSurface,
  });
}

function buildCallbackRuntime(env, pg, deps) {
  const natives = nativeRuntimeSurfaces(deps);
  const envelopeProvider = deps && deps.oauthEnvelopeProvider;
  if (envelopeProvider !== undefined) {
    return createSunsetStagingMicrosoftOAuthCallbackRuntime(Object.freeze({
      env,
      pgClient: pg,
      https: natives.https,
      crypto: natives.crypto,
      timers: natives.timers,
      envelopeProvider,
    }));
  }
  return createSunsetStagingMicrosoftOAuthCallbackRuntime(Object.freeze({
    env,
    pgClient: pg,
    https: natives.https,
    crypto: natives.crypto,
    timers: natives.timers,
  }));
}

function createStaffEmailOAuthRoutes(deps) {
  const env = deps.runtimeEnv || process.env;

  async function handleStart(body, req, res, user) {
    if (!isStartEnabled(env)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    if (!user || user.client_slug !== 'sunset'
        || !UUID_RE.test(user.staff_user_id || '')
        || !UUID_RE.test(user.session_id || '')) {
      return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    }
    if (!deps.assertStaffClientAccess(user, 'sunset', res)) return;
    const authz = deps.authorizeAuthenticatedStaffRoute({
      clientSlug: 'sunset',
      method: 'POST',
      pathname: OAUTH_START_PATH,
      env,
    });
    if (!authz.ok) {
      return deps.sendJSON(res, authz.status || 403, authz.body || { success: false, error: 'forbidden' });
    }
    if (!validBody(body)) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    try {
      return await deps.withPgClient(async (pg) => {
        const found = await pg.query(SQL_RESOLVE_START_BINDING, [body.location_id]);
        const rows = found && found.rows;
        if (!rows || rows.length === 0) {
          return deps.sendJSON(res, 404, { success: false, error: 'location_not_found' });
        }
        if (rows.length !== 1) {
          // Ambiguous eligible endpoints — fail closed, no transaction insert.
          return deps.sendJSON(res, 503, { success: false, error: 'oauth_start_unavailable' });
        }
        const row = rows[0];
        if (!row
            || typeof row.client_id !== 'string'
            || typeof row.location_id !== 'string'
            || typeof row.endpoint_id !== 'string'
            || !UUID_RE.test(row.client_id)
            || !UUID_RE.test(row.location_id)
            || !UUID_RE.test(row.endpoint_id)) {
          return deps.sendJSON(res, 503, { success: false, error: 'oauth_start_unavailable' });
        }
        // Exact ordered transaction start INPUT_KEYS (endpointId third).
        const startInput = {
          clientId: row.client_id,
          locationId: row.location_id,
          endpointId: row.endpoint_id,
          staffUserId: user.staff_user_id,
          authSessionId: user.session_id,
        };
        // Maintain exact key order for service snapshot contract.
        const ordered = {};
        for (const key of INPUT_KEYS) ordered[key] = startInput[key];
        const service = createMicrosoftOAuthTransactionService({
          repository: createPostgresOAuthTransactionRepository(pg),
          env,
        });
        const dto = await service.start(ordered);
        return deps.sendJSON(res, 200, dto);
      });
    } catch (_) {
      return deps.sendJSON(res, 503, { success: false, error: 'oauth_start_unavailable' });
    }
  }

  function terminal(res, statusCode, status) {
    const messages = {
      authorization_received: 'Authorization response received. You may close this window.',
      authorization_declined: 'Authorization was declined. You may close this window.',
      invalid_or_expired: 'This authorization request could not be accepted.',
    };
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>Authorization status</title></head>`
      + `<body><main><h1>Authorization status</h1><p>${messages[status] || messages.invalid_or_expired}</p>`
      + `</main></body></html>`,
    );
  }

  async function handleCallback(query, req, res, user) {
    if (!isCallbackEnabled(env)) {
      return terminal(res, 404, 'invalid_or_expired');
    }
    if (!user || user.client_slug !== 'sunset'
        || !UUID_RE.test(user.client_id || '')
        || !UUID_RE.test(user.session_id || '')) {
      return terminal(res, 400, 'invalid_or_expired');
    }
    try {
      const result = await deps.withPgClient(async (pg) => {
        // Completing callback only when flag true (gate above). Concrete
        // merged completion chain via runtime factory — not legacy receive-only
        // service. Construction fails closed if readiness missing.
        const service = buildCallbackRuntime(env, pg, deps);
        return service.accept(query, {
          clientId: user.client_id,
          authSessionId: user.session_id,
        });
      });
      return terminal(
        res,
        result && result.status === 'invalid_or_expired' ? 400 : 200,
        result && result.status ? result.status : 'invalid_or_expired',
      );
    } catch (_) {
      return terminal(res, 400, 'invalid_or_expired');
    }
  }

  return Object.freeze({ handleStart, handleCallback });
}

module.exports = {
  OAUTH_START_PATH,
  OAUTH_CALLBACK_PATH,
  SQL_RESOLVE_START_BINDING,
  validBody,
  createStaffEmailOAuthRoutes,
  // Re-export readiness key constants for offline verifiers (no secrets).
  RUNTIME_DEPENDENCY_KEYS: DEPENDENCY_KEYS,
  RUNTIME_DEPENDENCY_KEYS_WITH_ENVELOPE: DEPENDENCY_KEYS_WITH_ENVELOPE,
};
