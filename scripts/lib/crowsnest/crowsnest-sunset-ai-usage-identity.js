'use strict';

/**
 * Sunset Hermes staging — Crowsnest AI-usage canonical identity resolver (Slice B1).
 *
 * Pure, fail-closed, dormant by default. Reads only injected process-env-shaped
 * objects for the dedicated CROWSNEST_AI_USAGE_* keys. Never logs identity values,
 * never falls back to Luna tenant env aliases, staff portal default-client env,
 * phone, URL, request, message, or provider data, and does not call network, DB,
 * Azure, ledger, or observer code.
 *
 * Future B2 observer may inject the frozen ok:true result; B1 does not wire it.
 */

const ENV_CLIENT_SLUG = 'CROWSNEST_AI_USAGE_CLIENT_SLUG';
const ENV_TENANT_ID = 'CROWSNEST_AI_USAGE_TENANT_ID';

/** Same opaque-id rule as crowsnest-ai-usage-contract SAFE_ID_RE. */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const SECRET_VALUE_RES = Object.freeze([
  /^sk-[A-Za-z0-9]{10,}/,
  /^sk-ant-[A-Za-z0-9_-]{10,}/,
  /^Bearer\s+/i,
  /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
]);

/** Logical Sunset slug — never accepted as canonical AI-usage identity. */
const FORBIDDEN_LOGICAL_SLUG = 'sunset';

const ALLOWED_OPTION_KEYS = Object.freeze(['env']);

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function unavailable(reason) {
  return Object.freeze({ ok: false, reason });
}

function isSafeOpaqueId(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (value !== value.trim()) return false;
  if (!SAFE_ID_RE.test(value)) return false;
  for (const re of SECRET_VALUE_RES) {
    if (re.test(value)) return false;
  }
  return true;
}

function readEnvString(env, key) {
  if (!Object.prototype.hasOwnProperty.call(env, key)) {
    return { present: false };
  }
  const desc = Object.getOwnPropertyDescriptor(env, key);
  if (!desc || 'get' in desc || 'set' in desc) {
    return { present: false, unsafe: true };
  }
  return { present: true, value: desc.value };
}

/**
 * Resolve immutable Sunset Hermes Crowsnest AI-usage identity from injected env.
 *
 * @param {unknown} options Closed object: `{ env }` only. `env` must be a plain
 *   object of own data properties (typically a slice of process.env). No aliases.
 * @returns {Readonly<{ ok: true, client_slug: string, tenant_id: string }> |
 *   Readonly<{ ok: false, reason: string }>}
 */
function resolveSunsetHermesAiUsageIdentity(options) {
  if (!isPlainObject(options)) {
    return unavailable('identity_unavailable');
  }
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTION_KEYS.includes(key)) {
      return unavailable('untrusted_input_rejected');
    }
  }
  if (!Object.prototype.hasOwnProperty.call(options, 'env') || !isPlainObject(options.env)) {
    return unavailable('identity_unavailable');
  }

  const env = options.env;
  const clientRead = readEnvString(env, ENV_CLIENT_SLUG);
  const tenantRead = readEnvString(env, ENV_TENANT_ID);

  if (clientRead.unsafe || tenantRead.unsafe) {
    return unavailable('identity_unavailable');
  }
  if (!clientRead.present) {
    return unavailable('missing_client_slug');
  }
  if (!tenantRead.present) {
    return unavailable('missing_tenant_id');
  }

  const clientSlug = clientRead.value;
  const tenantId = tenantRead.value;

  if (typeof clientSlug !== 'string' || clientSlug.trim() === '') {
    return unavailable('missing_client_slug');
  }
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    return unavailable('missing_tenant_id');
  }
  if (clientSlug !== clientSlug.trim() || tenantId !== tenantId.trim()) {
    return unavailable('malformed_identity');
  }
  if (!isSafeOpaqueId(clientSlug) || !isSafeOpaqueId(tenantId)) {
    return unavailable('malformed_identity');
  }
  if (
    clientSlug === FORBIDDEN_LOGICAL_SLUG
    || tenantId === FORBIDDEN_LOGICAL_SLUG
  ) {
    return unavailable('logical_slug_forbidden');
  }
  if (clientSlug === tenantId) {
    return unavailable('identity_fields_must_differ');
  }

  return Object.freeze({
    ok: true,
    client_slug: clientSlug,
    tenant_id: tenantId,
  });
}

module.exports = Object.freeze({
  ENV_CLIENT_SLUG,
  ENV_TENANT_ID,
  FORBIDDEN_LOGICAL_SLUG,
  SAFE_ID_RE,
  resolveSunsetHermesAiUsageIdentity,
});
