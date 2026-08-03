'use strict';

/**
 * Provider-neutral email mailbox adapter contract (Luna email Slice 1A).
 *
 * Defines and validates adapter identity / capabilities without importing any
 * provider SDK (Microsoft Graph, Gmail, IMAP/SMTP). Consumers must branch on
 * capability booleans, never on provider-specific field shapes.
 *
 * Credentials never belong in Git, Postgres product rows, logs, or prompts —
 * only opaque secret references may be stored (see validateEmailMailboxSecretRef).
 * Secrets are retrieved through an external secret provider by the adapter at
 * runtime; this module never resolves or returns secret values.
 *
 * Endpoint persistence is intentionally out of scope for Slice 1A: there is no
 * authoritative tenant/location parent relation yet, so this slice ships no DB
 * schema. Application validation below requires a trusted out-of-band
 * locationAuthority callback (second argument only — never from untrusted
 * input). Slice 1B must introduce/reuse an authoritative tenant-location
 * registry and composite FK before tenant_channel_endpoints can become
 * canonical.
 *
 * @module email-mailbox-adapter-contract
 */

const EMAIL_MAILBOX_PROVIDERS = Object.freeze([
  'microsoft_graph',
  'gmail_api',
  'imap_smtp',
]);

const EMAIL_MAILBOX_CAPABILITY_KEYS = Object.freeze([
  'push_notifications',
  'provider_threads',
  'remote_drafts',
  'reply',
  'reply_all',
  'forward',
  'attachments_metadata',
  'delivery_events',
]);

const EMAIL_AUTOMATION_MODES = Object.freeze([
  'automatic',
  'draft_only',
  'off',
]);

const EMAIL_CHANNEL = 'email';

/** Explicit secret-manager scheme allowlist (provider-neutral). */
const EMAIL_MAILBOX_SECRET_REF_SCHEMES = Object.freeze([
  'kv',
  'secret-ref',
]);

const PROVIDER_SET = new Set(EMAIL_MAILBOX_PROVIDERS);
const CAPABILITY_SET = new Set(EMAIL_MAILBOX_CAPABILITY_KEYS);
const AUTOMATION_SET = new Set(EMAIL_AUTOMATION_MODES);
const SECRET_SCHEME_SET = new Set(EMAIL_MAILBOX_SECRET_REF_SCHEMES);

/**
 * After scheme prefix: bounded non-whitespace safe reference body.
 * Allows path-like opaque labels without spaces or secret-looking punctuation.
 */
const SECRET_REF_BODY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;

/** Canonical location id: lowercase kebab token(s), no surrounding/internal whitespace. */
const LOCATION_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Public mailbox address — minimal shape; routing uniqueness is case-insensitive. */
const PUBLIC_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pattern-based detectors for values that look like raw credentials/tokens
 * rather than opaque secret-manager reference labels. Applied to unprefixed
 * input and to the reference body after an allowed scheme. These are shape
 * heuristics — not general-purpose entropy/secret scanning.
 */
const RAW_SECRET_PATTERNS = Object.freeze([
  /^sk-[A-Za-z0-9]{10,}/,
  /^sk-ant-[A-Za-z0-9_-]{10,}/,
  /^Bearer(?:\s+|[._-])/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /password\s*=/i,
  /^password[-_]/i,
  /client_secret\s*=/i,
  /api[_-]?key\s*=/i,
  // JWT-shaped: header starts with base64url of '{"' → eyJ… ; three dotted segments
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /^ya29\.[A-Za-z0-9._-]+/, // Google OAuth access-token shape
]);

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(error, details) {
  const out = { ok: false, error: String(error) };
  if (details !== undefined) out.details = details;
  return out;
}

function ok(value) {
  return value === undefined ? { ok: true } : { ok: true, value };
}

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * @param {unknown} providerId
 * @returns {{ok:true,value:string}|{ok:false,error:string}}
 */
function validateEmailMailboxProviderId(providerId) {
  if (typeof providerId !== 'string') {
    return fail('provider_id_invalid', { reason: 'must_be_string' });
  }
  const id = providerId.trim();
  if (!PROVIDER_SET.has(id)) {
    return fail('provider_id_unknown', { provider_id: id });
  }
  return ok(id);
}

/**
 * Strict allowlist + boolean-only capabilities. All keys required; unknown keys rejected.
 * @param {unknown} capabilities
 * @returns {{ok:true,value:Readonly<Record<string,boolean>>}|{ok:false,error:string}}
 */
function validateEmailMailboxCapabilities(capabilities) {
  if (!isPlainObject(capabilities)) {
    return fail('capabilities_invalid', { reason: 'must_be_object' });
  }
  const keys = Object.keys(capabilities);
  for (const key of keys) {
    if (!CAPABILITY_SET.has(key)) {
      return fail('capabilities_unknown_key', { key });
    }
  }
  for (const required of EMAIL_MAILBOX_CAPABILITY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(capabilities, required)) {
      return fail('capabilities_missing_key', { key: required });
    }
    const v = capabilities[required];
    if (v !== true && v !== false) {
      return fail('capabilities_non_boolean', { key: required });
    }
  }
  const frozen = {};
  for (const key of EMAIL_MAILBOX_CAPABILITY_KEYS) {
    frozen[key] = capabilities[key] === true;
  }
  return ok(Object.freeze(frozen));
}

/**
 * Normalize public mailbox address for case-insensitive uniqueness / routing.
 * Does not invent a default address.
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeEmailPublicAddress(raw) {
  return trimStr(raw).toLowerCase();
}

/**
 * Opaque secret reference only — never a raw credential/token/password.
 * Order: (1) exact scheme allowlist `kv:` | `secret-ref:`; (2) bounded
 * non-whitespace body grammar; (3) secret/token/password shape detectors on
 * the reference body (not only the full prefixed string). Adapters retrieve
 * values via an external secret provider; this validator never accepts secret
 * values and does not claim full entropy-based secret detection.
 *
 * @param {unknown} secretRef
 * @returns {{ok:true,value:string}|{ok:false,error:string}}
 */
function validateEmailMailboxSecretRef(secretRef) {
  if (typeof secretRef !== 'string') {
    return fail('secret_ref_invalid', { reason: 'must_be_string' });
  }
  if (!secretRef) {
    return fail('secret_ref_empty');
  }
  // Reject any whitespace (including surrounding) — storage form must be exact.
  if (/\s/.test(secretRef)) {
    return fail('secret_ref_whitespace');
  }

  const colon = secretRef.indexOf(':');
  if (colon <= 0) {
    // No scheme: still reject obvious raw credential shapes.
    for (const re of RAW_SECRET_PATTERNS) {
      if (re.test(secretRef)) {
        return fail('secret_ref_looks_like_raw_secret');
      }
    }
    return fail('secret_ref_scheme_missing');
  }
  const scheme = secretRef.slice(0, colon).toLowerCase();
  const body = secretRef.slice(colon + 1);

  if (!SECRET_SCHEME_SET.has(scheme)) {
    // Unknown scheme — also reject if the whole string looks like a raw secret
    // (e.g. password=foo:bar) before returning scheme_unknown.
    for (const re of RAW_SECRET_PATTERNS) {
      if (re.test(secretRef)) {
        return fail('secret_ref_looks_like_raw_secret');
      }
    }
    return fail('secret_ref_scheme_unknown', { scheme });
  }
  // Preserve exact scheme spelling from allowlist form (kv | secret-ref).
  if (secretRef.slice(0, colon) !== scheme) {
    return fail('secret_ref_scheme_case');
  }
  if (!body) {
    return fail('secret_ref_body_empty');
  }
  if (!SECRET_REF_BODY_RE.test(body)) {
    // Body grammar failed; still flag secret-looking bodies (e.g. api_key=...).
    for (const re of RAW_SECRET_PATTERNS) {
      if (re.test(body) || re.test(secretRef)) {
        return fail('secret_ref_looks_like_raw_secret');
      }
    }
    return fail('secret_ref_body_invalid');
  }

  // Allowed scheme + bounded body: scan the BODY for secret-looking shapes.
  for (const re of RAW_SECRET_PATTERNS) {
    if (re.test(body)) {
      return fail('secret_ref_looks_like_raw_secret');
    }
  }

  return ok(secretRef);
}

/**
 * Canonical lowercase kebab location id.
 * Rejects uppercase, surrounding/internal whitespace, empty, and malformed tokens.
 * @param {unknown} raw
 * @returns {{ok:true,value:string}|{ok:false,error:string}}
 */
function validateCanonicalLocationId(raw) {
  if (raw == null || typeof raw !== 'string') {
    return fail('location_id_required');
  }
  // Do not trim — surrounding whitespace is invalid, not normalized away.
  if (raw !== raw.trim() || /\s/.test(raw)) {
    return fail('location_id_invalid', { reason: 'whitespace' });
  }
  if (!raw) {
    return fail('location_id_required');
  }
  if (!LOCATION_ID_RE.test(raw)) {
    return fail('location_id_invalid', { reason: 'not_canonical_kebab' });
  }
  return ok(raw);
}

/**
 * Resolve whether the canonical (client_id, location_id) pair is authorized.
 * Authority must be a trusted callback:
 *   (clientId, locationId) => true | false | { ok: true } | { ok: false, error?, details? }
 * No authority / non-function → fail closed. Unknown / cross-tenant → fail closed.
 * Never accepts allowlists, resolvers, or authorization decisions from untrusted input.
 *
 * @param {string} clientId
 * @param {string} locationId
 * @param {unknown} authority
 * @returns {{ok:true}|{ok:false,error:string,details?:object}}
 */
function resolveTenantLocationAuthority(clientId, locationId, authority) {
  if (authority == null) {
    return fail('location_authority_required');
  }
  if (typeof authority !== 'function') {
    return fail('location_authority_invalid', { reason: 'must_be_function' });
  }

  let result;
  try {
    result = authority(clientId, locationId);
  } catch (err) {
    return fail('location_authority_error', {
      message: String(err && err.message ? err.message : err),
    });
  }
  if (result === true) return ok();
  if (result === false) {
    return fail('location_not_authorized', { client_id: clientId, location_id: locationId });
  }
  if (result && typeof result === 'object' && result.ok === true) return ok();
  if (result && typeof result === 'object' && result.ok === false) {
    return fail(
      result.error ? String(result.error) : 'location_not_authorized',
      { client_id: clientId, location_id: locationId, details: result.details },
    );
  }
  return fail('location_authority_invalid_result');
}

/**
 * Validate provider-neutral adapter identity (what an adapter instance claims).
 * @param {unknown} identity
 * @returns {{ok:true,value:object}|{ok:false,error:string}}
 */
function validateEmailMailboxAdapterIdentity(identity) {
  if (!isPlainObject(identity)) {
    return fail('adapter_identity_invalid', { reason: 'must_be_object' });
  }
  const provider = validateEmailMailboxProviderId(identity.provider);
  if (!provider.ok) return provider;

  const address = normalizeEmailPublicAddress(identity.public_address);
  if (!address || !PUBLIC_ADDRESS_RE.test(address)) {
    return fail('public_address_invalid');
  }

  const caps = validateEmailMailboxCapabilities(identity.capabilities);
  if (!caps.ok) return caps;

  return ok(Object.freeze({
    provider: provider.value,
    public_address: address,
    capabilities: caps.value,
  }));
}

/**
 * Application-layer validation for a future tenant_channel_endpoints write input.
 *
 * Fail-closed location handling:
 * - Untrusted endpoint fields are argument 1 (`input`).
 * - Trusted dependencies are argument 2 only, e.g. `{ locationAuthority }`.
 * - `locationAuthority` must be a callback
 *   `(client_id, location_id) => boolean | {ok,...}` evaluating the canonical pair.
 * - NEVER reads `location_authority`, allowlists, resolvers, or authorization
 *   decisions from `input`. Presence of `location_authority` on input is a
 *   forbidden field (callers must not believe it is honored).
 * - Absent/invalid second-argument authority → fail closed.
 * - Unknown and cross-tenant locations fail via the trusted callback.
 * - location_id must be canonical lowercase kebab; never defaulted.
 * - Validated output never includes authority or dependency values.
 *
 * Does not persist rows and does not depend on a DB registry (deferred to Slice 1B).
 *
 * @param {unknown} input untrusted endpoint write candidate
 * @param {{ locationAuthority?: function }} [deps] trusted out-of-band dependencies
 * @returns {{ok:true,value:object}|{ok:false,error:string}}
 */
function validateTenantChannelEndpointInput(input, deps) {
  if (!isPlainObject(input)) {
    return fail('endpoint_invalid', { reason: 'must_be_object' });
  }

  // Callers must not embed authority in input — reject so it is never "honored".
  if (Object.prototype.hasOwnProperty.call(input, 'location_authority')
      || Object.prototype.hasOwnProperty.call(input, 'locationAuthority')) {
    return fail('endpoint_forbidden_field', {
      field: Object.prototype.hasOwnProperty.call(input, 'location_authority')
        ? 'location_authority'
        : 'locationAuthority',
    });
  }

  const clientId = trimStr(input.client_id);
  if (!clientId || !UUID_RE.test(clientId)) {
    return fail('client_id_invalid');
  }

  const location = validateCanonicalLocationId(input.location_id);
  if (!location.ok) return location;
  const locationId = location.value;

  // Trusted authority only from deps (argument 2) — never from input.
  const locationAuthority = (deps && typeof deps === 'object' && !Array.isArray(deps))
    ? deps.locationAuthority
    : undefined;

  const authorized = resolveTenantLocationAuthority(
    clientId.toLowerCase(),
    locationId,
    locationAuthority,
  );
  if (!authorized.ok) return authorized;

  const channel = trimStr(input.channel).toLowerCase() || EMAIL_CHANNEL;
  if (channel !== EMAIL_CHANNEL) {
    return fail('channel_unsupported', { channel });
  }

  const provider = validateEmailMailboxProviderId(input.provider);
  if (!provider.ok) return provider;

  const publicAddress = normalizeEmailPublicAddress(input.public_address);
  if (!publicAddress || !PUBLIC_ADDRESS_RE.test(publicAddress)) {
    return fail('public_address_invalid');
  }

  const secretRef = validateEmailMailboxSecretRef(input.secret_ref);
  if (!secretRef.ok) return secretRef;

  let providerResourceId = null;
  if (input.provider_resource_id != null && input.provider_resource_id !== '') {
    if (typeof input.provider_resource_id !== 'string') {
      return fail('provider_resource_id_invalid');
    }
    providerResourceId = input.provider_resource_id.trim();
    if (!providerResourceId) {
      return fail('provider_resource_id_invalid');
    }
  }

  const caps = validateEmailMailboxCapabilities(input.capabilities);
  if (!caps.ok) return caps;

  const inbound = input.inbound_enabled;
  const outbound = input.outbound_enabled;
  const active = input.active;
  if (inbound !== true && inbound !== false) return fail('inbound_enabled_invalid');
  if (outbound !== true && outbound !== false) return fail('outbound_enabled_invalid');
  if (active !== true && active !== false) return fail('active_invalid');

  const mode = trimStr(input.default_automation_mode);
  if (!AUTOMATION_SET.has(mode)) {
    return fail('default_automation_mode_invalid', { mode });
  }

  // Output free of authority / dependency values.
  return ok(Object.freeze({
    client_id: clientId.toLowerCase(),
    location_id: locationId,
    channel: EMAIL_CHANNEL,
    provider: provider.value,
    public_address: publicAddress,
    secret_ref: secretRef.value,
    provider_resource_id: providerResourceId,
    capabilities: caps.value,
    inbound_enabled: inbound,
    outbound_enabled: outbound,
    default_automation_mode: mode,
    active,
  }));
}

module.exports = {
  EMAIL_MAILBOX_PROVIDERS,
  EMAIL_MAILBOX_CAPABILITY_KEYS,
  EMAIL_AUTOMATION_MODES,
  EMAIL_CHANNEL,
  EMAIL_MAILBOX_SECRET_REF_SCHEMES,
  validateEmailMailboxProviderId,
  validateEmailMailboxCapabilities,
  validateEmailMailboxAdapterIdentity,
  validateEmailMailboxSecretRef,
  normalizeEmailPublicAddress,
  validateCanonicalLocationId,
  validateTenantChannelEndpointInput,
};
