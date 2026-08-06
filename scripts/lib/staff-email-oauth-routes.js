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
} = require('./email-microsoft-oauth-sunset-staging-runtime-composition');

const OAUTH_START_PATH = '/staff/admin/email-settings/oauth/microsoft/start';
const OAUTH_CALLBACK_PATH = '/staff/email/oauth/microsoft/callback';
/** Canonical lowercase UUID (start body endpoint_id + ordinary SQL row ids). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Session/staff UUIDs may arrive mixed-case from auth surface. */
const UUID_RE_CI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Exact ordered own-data start body keys (location_id then endpoint_id). */
const START_BODY_KEYS = Object.freeze(['location_id', 'endpoint_id']);
/** Exact ordered own-data resolve SQL row keys (matches SELECT aliases / order). */
const RESOLVE_ROW_KEYS = Object.freeze(['client_id', 'location_id', 'endpoint_id']);
const RESOLVE_ROW_KEY_SET = new Set(RESOLVE_ROW_KEYS);

/**
 * One tenant-safe resolve: Sunset client + active location + exact eligible
 * Microsoft delegated endpoint by explicit endpoint_id. Zero rows on miss;
 * multi-row must not occur under PK but is still fail-closed.
 * Filters match transaction INSERT eligibility (provider/auth/connector/status)
 * and require public_address present. Params: [location_id, endpoint_id].
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
   AND e.id = $2::uuid
 WHERE c.slug = 'sunset'
   AND l.location_id = $1
   AND l.active = true
   AND e.provider = 'microsoft_graph'
   AND e.auth_mode = 'delegated_authorization_code'
   AND e.connector_mode = 'microsoft_delegated_oauth'
   AND e.binding_status IN ('unverified_offline', 'pending_manual_validation')
   AND e.public_address IS NOT NULL
   AND btrim(e.public_address) <> ''`.replace(/\s+/g, ' ').trim();

/**
 * Descriptor-safe start body snapshot: all reflection once.
 * Exact ordered own-data { location_id, endpoint_id } only —
 * no symbols/accessors/extras/unsafe protos. Each descriptor value is read
 * exactly once; returns a fresh frozen snapshot or null.
 * Never re-reads the caller after return (handler must not validate-then-reread).
 */
function snapshotStartBody(body) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const proto = Object.getPrototypeOf(body);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(body);
    if (actual.length !== START_BODY_KEYS.length) return null;
    for (let i = 0; i < START_BODY_KEYS.length; i += 1) {
      if (actual[i] !== START_BODY_KEYS[i] || typeof actual[i] !== 'string') return null;
    }
    const out = Object.create(null);
    for (const key of START_BODY_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(body, key);
      if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
        return null;
      }
      // Read descriptor.value exactly once per key.
      out[key] = descriptor.value;
    }
    if (typeof out.location_id !== 'string' || !LOCATION_SLUG_RE.test(out.location_id)) {
      return null;
    }
    if (typeof out.endpoint_id !== 'string' || !UUID_RE.test(out.endpoint_id)) {
      return null;
    }
    // Canonical lowercase UUID only (reject uppercase mixed forms).
    if (out.endpoint_id !== out.endpoint_id.toLowerCase()) return null;
    return Object.freeze({
      location_id: out.location_id,
      endpoint_id: out.endpoint_id,
    });
  } catch {
    return null;
  }
}

/** Compatibility wrapper — never use for validate-then-reread in the handler. */
function validBody(body) {
  return Boolean(snapshotStartBody(body));
}

/**
 * Exact own-data resolve row surface: Object.prototype or null only;
 * exact ordered keys client_id, location_id, endpoint_id; enumerable data
 * descriptors only; each value read once. Returns fresh frozen null-proto
 * record or null.
 */
function snapshotExactResolveRow(row) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const proto = Object.getPrototypeOf(row);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(row);
    if (actual.length !== RESOLVE_ROW_KEYS.length) return null;
    for (let i = 0; i < RESOLVE_ROW_KEYS.length; i += 1) {
      if (actual[i] !== RESOLVE_ROW_KEYS[i] || typeof actual[i] !== 'string') return null;
      if (!RESOLVE_ROW_KEY_SET.has(actual[i])) return null;
    }
    const out = Object.create(null);
    for (const key of RESOLVE_ROW_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
        return null;
      }
      out[key] = descriptor.value;
    }
    if (typeof out.client_id !== 'string' || !UUID_RE.test(out.client_id)
        || out.client_id !== out.client_id.toLowerCase()) {
      return null;
    }
    if (typeof out.location_id !== 'string' || !UUID_RE.test(out.location_id)
        || out.location_id !== out.location_id.toLowerCase()) {
      return null;
    }
    if (typeof out.endpoint_id !== 'string' || !UUID_RE.test(out.endpoint_id)
        || out.endpoint_id !== out.endpoint_id.toLowerCase()) {
      return null;
    }
    return Object.freeze({
      client_id: out.client_id,
      location_id: out.location_id,
      endpoint_id: out.endpoint_id,
    });
  } catch {
    return null;
  }
}

/**
 * Snapshot resolver query result before use.
 * - result.rows must be an ordinary Array (Array.prototype), no symbol/extra keys
 * - empty ordinary array → { kind: 'empty' } (404 path)
 * - exact one-element ordinary array → snapshot row or { kind: 'invalid' }
 * - multi-row / proxy / hostile → { kind: 'invalid' } (503, no insert)
 * Never re-reads result.rows or the row after return.
 */
function snapshotResolveQueryResult(result) {
  try {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return Object.freeze({ kind: 'invalid' });
    }
    const rowsDesc = Object.getOwnPropertyDescriptor(result, 'rows');
    if (!rowsDesc
        || !Object.prototype.hasOwnProperty.call(rowsDesc, 'value')
        || rowsDesc.get
        || rowsDesc.set) {
      return Object.freeze({ kind: 'invalid' });
    }
    const rows = rowsDesc.value;
    if (!Array.isArray(rows)) return Object.freeze({ kind: 'invalid' });
    const rowsProto = Object.getPrototypeOf(rows);
    if (rowsProto !== Array.prototype) return Object.freeze({ kind: 'invalid' });
    for (const key of Reflect.ownKeys(rows)) {
      if (typeof key === 'symbol') return Object.freeze({ kind: 'invalid' });
      if (key === 'length') continue;
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return Object.freeze({ kind: 'invalid' });
    }
    if (typeof rows.length !== 'number' || rows.length < 0) {
      return Object.freeze({ kind: 'invalid' });
    }
    if (rows.length === 0) return Object.freeze({ kind: 'empty' });
    if (rows.length !== 1) return Object.freeze({ kind: 'invalid' });

    const indexDesc = Object.getOwnPropertyDescriptor(rows, '0');
    if (!indexDesc
        || !Object.prototype.hasOwnProperty.call(indexDesc, 'value')
        || indexDesc.get
        || indexDesc.set) {
      return Object.freeze({ kind: 'invalid' });
    }
    const rowSnap = snapshotExactResolveRow(indexDesc.value);
    if (!rowSnap) return Object.freeze({ kind: 'invalid' });
    return Object.freeze({ kind: 'one', row: rowSnap });
  } catch {
    return Object.freeze({ kind: 'invalid' });
  }
}

/**
 * Production native surfaces only: always wrap node:https, node:crypto, and
 * global timers captured at module load / call. Route deps cannot substitute
 * Microsoft network or crypto (no injectable native dependency keys).
 */
function productionNativeSurfaces() {
  return Object.freeze({
    https: Object.freeze({
      request(...args) {
        return Reflect.apply(https.request, https, args);
      },
    }),
    crypto: Object.freeze({
      createPublicKey(...args) {
        return Reflect.apply(crypto.createPublicKey, crypto, args);
      },
      verify(...args) {
        return Reflect.apply(crypto.verify, crypto, args);
      },
    }),
    timers: Object.freeze({
      setTimeout(...args) {
        return Reflect.apply(setTimeout, globalThis, args);
      },
      clearTimeout(...args) {
        return Reflect.apply(clearTimeout, globalThis, args);
      },
    }),
  });
}

function buildCallbackRuntime(env, pg) {
  const natives = productionNativeSurfaces();
  // Production-only dependency bag: always Azure KV Sunset staging envelope
  // from validated env. Route deps cannot substitute the envelope surface.
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
        || !UUID_RE_CI.test(user.staff_user_id || '')
        || !UUID_RE_CI.test(user.session_id || '')) {
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
    // Exactly one descriptor-safe snapshot; never validate then reread body.
    const bodySnap = snapshotStartBody(body);
    if (!bodySnap) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    try {
      return await deps.withPgClient(async (pg) => {
        const found = await pg.query(SQL_RESOLVE_START_BINDING, [
          bodySnap.location_id,
          bodySnap.endpoint_id,
        ]);
        // Snapshot query result once; never re-read found.rows / row fields.
        const resolved = snapshotResolveQueryResult(found);
        if (resolved.kind === 'empty') {
          return deps.sendJSON(res, 404, { success: false, error: 'location_not_found' });
        }
        if (resolved.kind !== 'one') {
          // Ambiguous / multi-row / proxy / hostile row — fail closed, no insert.
          return deps.sendJSON(res, 503, { success: false, error: 'oauth_start_unavailable' });
        }
        const rowSnap = resolved.row;
        // Endpoint must equal body snapshot; location consistency is via SQL
        // params (slug $1 + endpoint $2) plus row UUIDs from that join.
        if (rowSnap.endpoint_id !== bodySnap.endpoint_id) {
          return deps.sendJSON(res, 503, { success: false, error: 'oauth_start_unavailable' });
        }
        // Exact ordered transaction start INPUT_KEYS (endpointId third).
        // Use only frozen row + body snapshots — never re-read driver row.
        const startInput = {
          clientId: rowSnap.client_id,
          locationId: rowSnap.location_id,
          endpointId: rowSnap.endpoint_id,
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
        || !UUID_RE_CI.test(user.client_id || '')
        || !UUID_RE_CI.test(user.session_id || '')) {
      return terminal(res, 400, 'invalid_or_expired');
    }
    try {
      const result = await deps.withPgClient(async (pg) => {
        // Completing callback only when flag true (gate above). Concrete
        // merged completion chain via runtime factory — not legacy receive-only
        // service. Construction fails closed if readiness missing.
        // Natives always from production wrap of node:https / node:crypto /
        // global timers — never route DI substitution.
        const service = buildCallbackRuntime(env, pg);
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
  START_BODY_KEYS,
  RESOLVE_ROW_KEYS,
  validBody,
  snapshotStartBody,
  createStaffEmailOAuthRoutes,
  // Re-export production dependency key constant for offline verifiers (no secrets).
  RUNTIME_DEPENDENCY_KEYS: DEPENDENCY_KEYS,
};
