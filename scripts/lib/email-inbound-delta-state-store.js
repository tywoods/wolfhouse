'use strict';

/**
 * Microsoft Graph messages-delta durable state + page-commit store (offline).
 *
 * - Migration 064 `tenant_email_inbound_delta_states` owns sealed cursor + phase
 *   + ingestion_generation (independent of OAuth grant-custody rotation) + DB-clock lease.
 * - `commitPageEvents` is the ONLY page-commit owner: no network/crypto inside the
 *   exclusive-client transaction. Caller supplies already-validated canonical
 *   envelopes/tombstones and an already-sealed successor cursor envelope.
 * - Inserts reuse migration-063 event identity via `SQL_INSERT_EVENT` from
 *   `email-inbound-event-store` (ON CONFLICT DO NOTHING; arrival-capture only).
 * - Seal/open reuse injected envelope provider (AES-256-GCM + wrapped DEK).
 *   Cursor package is sealed as opaque grant-package body (never plaintext in DB).
 * - AAD binds client+endpoint+provider+tenant+mailbox+generation+query_version+
 *   cursor_kind so rebind/generation/query-version change fails closed.
 * - Public status omits cursor, lease token, mailbox/tenant identities, envelopes/PII.
 * - Import-inert: no routes/runtime/cron/network/send/draft.
 *
 * @module email-inbound-delta-state-store
 */

const util = require('util');
const crypto = require('crypto');
const { URL: NODE_URL } = require('node:url');

const {
  validateInboundEmailEnvelope,
  EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN,
} = require('./email-inbound-envelope-contract');
const {
  SQL_INSERT_EVENT,
} = require('./email-inbound-event-store');
const {
  validateGrantEnvelopeRecordV1,
  validateEmailGrantEnvelopeProvider,
  ENVELOPE_RECORD_KEYS,
  zeroizeBuffer,
  snapshotOwnDataProps,
} = require('./email-grant-envelope-provider-contract');

const FAILURE_CODE = 'inbound_delta_state_failed';
const FAILURE_MESSAGE = 'Inbound email delta state operation failed.';

/** Store module is not wired into routes/startup/pollers by itself. */
const EMAIL_INBOUND_DELTA_STATE_RUNTIME_WIRED = false;

/** This module is the reviewed page-commit owner for delta pages. */
const EMAIL_INBOUND_DELTA_STATE_PAGE_COMMIT_OWNER = true;

/** Must never log cursor URLs, envelopes, or envelope field values (PII). */
const EMAIL_INBOUND_DELTA_STATE_LOGGING_FORBIDDEN =
  EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN === true;

const PHASES = Object.freeze(['initial', 'tracking', 'reset_required', 'paused']);
const CURSOR_KINDS = Object.freeze(['nextLink', 'deltaLink']);
const PROVIDER = 'microsoft_graph';

const STORE_DEPENDENCY_KEYS = Object.freeze(['withTransactionClient']);
const STORE_WITH_PROVIDER_KEYS = Object.freeze(['withTransactionClient', 'envelopeProvider']);
const PUBLIC_STATUS_KEYS = Object.freeze([
  'state_present',
  'phase',
  'ingestion_generation',
  'query_version',
  'state_version',
  'has_active_lease',
  'has_sealed_cursor',
  'cursor_kind',
  'reset_reason',
]);

const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_BATCH = 50;
const MAX_CURSOR_URL_BYTES = 8192;
const MIN_TTL = 5;
const MAX_TTL = 3600;
const DEFAULT_TTL = 60;
const CURSOR_PKG_PREFIX = 'EMAIL_DELTA_CURSOR_PKG_V1\n';
const AAD_VERSION = 'v1';

const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;
const PINNED_ARRAY_PROTOTYPE = Array.prototype;

/**
 * Module-init pins for Graph cursor URL boundary validation.
 * Ambient global URL / post-load prototype monkeypatches must not weaken checks.
 * Never live property reads; only Reflect.construct + pinned prototype getters.
 */
const PINNED_URL = typeof NODE_URL === 'function' ? NODE_URL : null;
const PINNED_URL_PROTOTYPE = PINNED_URL && PINNED_URL.prototype
  ? PINNED_URL.prototype
  : null;

function pinUrlGetter(name) {
  try {
    if (!PINNED_URL_PROTOTYPE) return null;
    const descriptor = Object.getOwnPropertyDescriptor(PINNED_URL_PROTOTYPE, name);
    if (!descriptor
        || typeof descriptor.get !== 'function'
        || Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return null;
    }
    return descriptor.get;
  } catch {
    return null;
  }
}

const PINNED_URL_GET_PROTOCOL = pinUrlGetter('protocol');
const PINNED_URL_GET_USERNAME = pinUrlGetter('username');
const PINNED_URL_GET_PASSWORD = pinUrlGetter('password');
const PINNED_URL_GET_HOSTNAME = pinUrlGetter('hostname');
const PINNED_URL_GET_PORT = pinUrlGetter('port');
const PINNED_URL_GET_PATHNAME = pinUrlGetter('pathname');
const PINNED_URL_GET_HASH = pinUrlGetter('hash');

const PINNED_URL_INTRINSICS_READY = Boolean(
  PINNED_URL
  && PINNED_URL_PROTOTYPE
  && PINNED_URL_GET_PROTOCOL
  && PINNED_URL_GET_USERNAME
  && PINNED_URL_GET_PASSWORD
  && PINNED_URL_GET_HOSTNAME
  && PINNED_URL_GET_PORT
  && PINNED_URL_GET_PATHNAME
  && PINNED_URL_GET_HASH,
);

function applyPinnedUrlGetter(url, getter) {
  if (typeof getter !== 'function') return undefined;
  try {
    return Reflect.apply(getter, url, []);
  } catch {
    return undefined;
  }
}

/**
 * Construct URL via module-init-pinned node:url constructor only.
 * Rejects proxy constructor/input before construction (zero trap hits).
 */
function constructPinnedUrl(value) {
  try {
    if (!PINNED_URL_INTRINSICS_READY) return null;
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return null;
    try {
      if (Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [PINNED_URL]) === true) {
        return null;
      }
    } catch {
      return null;
    }
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      try {
        if (Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true) {
          return null;
        }
      } catch {
        return null;
      }
    }
    let url;
    try {
      url = Reflect.construct(PINNED_URL, [value]);
    } catch {
      return null;
    }
    try {
      if (Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [url]) === true) {
        return null;
      }
    } catch {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

const SQL_LOCK_CURRENT = `
SELECT *
  FROM tenant_email_inbound_delta_states
 WHERE client_id = $1::uuid
   AND endpoint_id = $2::uuid
   AND is_current = true
 FOR UPDATE
`.replace(/\s+/g, ' ').trim();

const SQL_INSERT_INITIAL = `
INSERT INTO tenant_email_inbound_delta_states (
  client_id, location_id, endpoint_id,
  provider, provider_tenant_id, provider_mailbox_id,
  ingestion_generation, query_version, is_current,
  phase, state_version
) VALUES (
  $1::uuid, $2::uuid, $3::uuid,
  $4, $5, $6,
  1, $7::bigint, true,
  'initial', 1
)
RETURNING client_id, endpoint_id, ingestion_generation, query_version, phase, state_version
`.replace(/\s+/g, ' ').trim();

const SQL_CAS_LEASE_ACQUIRE = `
UPDATE tenant_email_inbound_delta_states
   SET lease_owner = $3,
       lease_token = $4::uuid,
       lease_until = clock_timestamp() + ($5::text || ' seconds')::interval,
       state_version = state_version + 1,
       updated_at = NOW()
 WHERE client_id = $1::uuid
   AND endpoint_id = $2::uuid
   AND is_current = true
   AND ingestion_generation = $6::bigint
   AND state_version = $7::bigint
   AND phase IN ('initial', 'tracking', 'paused')
   AND (
     lease_token IS NULL
     OR lease_until < clock_timestamp()
   )
 RETURNING client_id, endpoint_id, ingestion_generation, state_version,
           lease_owner, lease_token, lease_until, phase, query_version
`.replace(/\s+/g, ' ').trim();

const SQL_CAS_LEASE_RENEW = `
UPDATE tenant_email_inbound_delta_states
   SET lease_until = clock_timestamp() + ($5::text || ' seconds')::interval,
       state_version = state_version + 1,
       updated_at = NOW()
 WHERE client_id = $1::uuid
   AND endpoint_id = $2::uuid
   AND is_current = true
   AND ingestion_generation = $3::bigint
   AND state_version = $4::bigint
   AND lease_token = $6::uuid
   AND lease_until > clock_timestamp()
 RETURNING client_id, endpoint_id, ingestion_generation, state_version,
           lease_owner, lease_token, lease_until, phase, query_version
`.replace(/\s+/g, ' ').trim();

const SQL_CAS_LEASE_RELEASE = `
UPDATE tenant_email_inbound_delta_states
   SET lease_owner = NULL,
       lease_token = NULL,
       lease_until = NULL,
       state_version = state_version + 1,
       updated_at = NOW()
 WHERE client_id = $1::uuid
   AND endpoint_id = $2::uuid
   AND is_current = true
   AND ingestion_generation = $3::bigint
   AND state_version = $4::bigint
   AND lease_token = $5::uuid
 RETURNING client_id, endpoint_id, ingestion_generation, state_version, phase
`.replace(/\s+/g, ' ').trim();

const SQL_CAS_COMMIT_CURSOR = `
UPDATE tenant_email_inbound_delta_states
   SET cursor_kind = $8,
       envelope_version = $9,
       aead_alg = $10,
       kek_wrap_alg = $11,
       kek_key_name = $12,
       kek_key_version = $13,
       nonce = $14,
       ciphertext = $15,
       auth_tag = $16,
       wrapped_dek = $17,
       cursor_operation_id = $18::uuid,
       phase = $19,
       state_version = state_version + 1,
       reset_reason = NULL,
       updated_at = NOW()
 WHERE client_id = $1::uuid
   AND endpoint_id = $2::uuid
   AND is_current = true
   AND ingestion_generation = $3::bigint
   AND state_version = $4::bigint
   AND lease_token = $5::uuid
   AND lease_until > clock_timestamp()
   AND provider_mailbox_id = $6
   AND query_version = $7::bigint
   AND phase IN ('initial', 'tracking')
 RETURNING client_id, endpoint_id, ingestion_generation, state_version,
           phase, query_version, cursor_kind
`.replace(/\s+/g, ' ').trim();

const SQL_CAS_RESET_REQUIRED = `
UPDATE tenant_email_inbound_delta_states
   SET phase = 'reset_required',
       reset_reason = $5,
       state_version = state_version + 1,
       lease_owner = NULL,
       lease_token = NULL,
       lease_until = NULL,
       updated_at = NOW()
 WHERE client_id = $1::uuid
   AND endpoint_id = $2::uuid
   AND is_current = true
   AND ingestion_generation = $3::bigint
   AND state_version = $4::bigint
 RETURNING client_id, endpoint_id, ingestion_generation, state_version, phase, reset_reason
`.replace(/\s+/g, ' ').trim();

const SQL_DEMOTE_CURRENT = `
UPDATE tenant_email_inbound_delta_states
   SET is_current = false,
       lease_owner = NULL,
       lease_token = NULL,
       lease_until = NULL,
       state_version = state_version + 1,
       updated_at = NOW()
 WHERE client_id = $1::uuid
   AND endpoint_id = $2::uuid
   AND is_current = true
   AND ingestion_generation = $3::bigint
   AND state_version = $4::bigint
 RETURNING ingestion_generation, state_version
`.replace(/\s+/g, ' ').trim();

const SQL_INSERT_NEXT_GENERATION = `
INSERT INTO tenant_email_inbound_delta_states (
  client_id, location_id, endpoint_id,
  provider, provider_tenant_id, provider_mailbox_id,
  ingestion_generation, query_version, is_current,
  phase, state_version
) VALUES (
  $1::uuid, $2::uuid, $3::uuid,
  $4, $5, $6,
  $7::bigint, $8::bigint, true,
  'initial', 1
)
RETURNING client_id, endpoint_id, ingestion_generation, query_version, phase, state_version
`.replace(/\s+/g, ' ').trim();

const SQL_PUBLIC_STATUS = `
SELECT phase, ingestion_generation, query_version, state_version,
       (lease_token IS NOT NULL AND lease_until > clock_timestamp()) AS has_active_lease,
       (cursor_kind IS NOT NULL) AS has_sealed_cursor,
       cursor_kind, reset_reason
  FROM tenant_email_inbound_delta_states
 WHERE client_id = $1::uuid
   AND endpoint_id = $2::uuid
   AND is_current = true
`.replace(/\s+/g, ' ').trim();

function failure(code) {
  const error = new Error(FAILURE_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'InboundEmailDeltaStateError' });
  Object.defineProperty(error, 'code', {
    value: typeof code === 'string' && code ? code : FAILURE_CODE,
    enumerable: true,
  });
  return Object.freeze(error);
}

function fail(error) {
  return Object.freeze({
    ok: false,
    error: typeof error === 'string' && error ? error : FAILURE_CODE,
  });
}

function ok(value) {
  return value === undefined
    ? Object.freeze({ ok: true })
    : Object.freeze({ ok: true, value });
}

function isProxySurface(value) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function ownData(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor
      && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      && !descriptor.get
      && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function exactPlainData(object, keys) {
  try {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
    if (isProxySurface(object)) return false;
    if (Object.getPrototypeOf(object) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(object);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string'
          || DANGEROUS_KEYS.has(key)
          || !keys.includes(key))) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return Boolean(
        descriptor
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && descriptor.enumerable
        && !descriptor.get
        && !descriptor.set,
      );
    });
  } catch {
    return false;
  }
}

function parseUuid(raw, field) {
  if (raw == null || typeof raw !== 'string') return fail(`${field}_invalid`);
  const v = raw.trim().toLowerCase();
  if (!v || !UUID_CANON.test(v) || v !== raw.trim().toLowerCase()) return fail(`${field}_invalid`);
  return ok(v);
}

function parseWorkerId(raw) {
  if (typeof raw !== 'string') return fail('worker_id_invalid');
  const v = raw.trim();
  if (v.length < 1 || v.length > 128 || /\s/.test(v) || v !== raw.trim()) {
    return fail('worker_id_invalid');
  }
  return ok(v);
}

function parseTtl(raw) {
  const n = raw == null ? DEFAULT_TTL : Number(raw);
  if (!Number.isInteger(n) || n < MIN_TTL || n > MAX_TTL) return fail('ttl_invalid');
  return ok(n);
}

function parsePositiveBigIntish(raw, field) {
  if (typeof raw === 'bigint') {
    if (raw < 1n) return fail(`${field}_invalid`);
    return ok(raw);
  }
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 1 || raw > Number.MAX_SAFE_INTEGER) {
      return fail(`${field}_invalid`);
    }
    return ok(BigInt(raw));
  }
  if (typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw)) {
    try {
      const n = BigInt(raw);
      if (n < 1n) return fail(`${field}_invalid`);
      return ok(n);
    } catch {
      return fail(`${field}_invalid`);
    }
  }
  return fail(`${field}_invalid`);
}

function parsePhase(raw) {
  if (typeof raw !== 'string' || !PHASES.includes(raw)) return fail('phase_invalid');
  return ok(raw);
}

function parseCursorKind(raw) {
  if (typeof raw !== 'string' || !CURSOR_KINDS.includes(raw)) return fail('cursor_kind_invalid');
  return ok(raw);
}

function parseResetReason(raw) {
  if (typeof raw !== 'string') return fail('reset_reason_invalid');
  const v = raw.trim();
  if (v.length < 1 || v.length > 128 || !/^[a-z][a-z0-9_]*$/.test(v) || v !== raw.trim()) {
    return fail('reset_reason_invalid');
  }
  return ok(v);
}

/**
 * Canonical AAD for sealed Graph cursor capabilities.
 * Binds ciphertext to trusted state identity + cursor_kind.
 */
function buildDeltaCursorEnvelopeAadV1({
  clientId,
  endpointId,
  provider,
  providerTenantId,
  providerMailboxId,
  ingestionGeneration,
  queryVersion,
  cursorKind,
}) {
  if (!UUID_CANON.test(String(clientId).trim().toLowerCase())) {
    throw new Error('aad_identity_invalid');
  }
  if (!UUID_CANON.test(String(endpointId).trim().toLowerCase())) {
    throw new Error('aad_identity_invalid');
  }
  if (provider !== PROVIDER) throw new Error('aad_provider_invalid');
  if (!UUID_CANON.test(String(providerTenantId).trim().toLowerCase())) {
    throw new Error('aad_tenant_invalid');
  }
  if (!UUID_CANON.test(String(providerMailboxId).trim().toLowerCase())) {
    throw new Error('aad_mailbox_invalid');
  }
  if (!CURSOR_KINDS.includes(cursorKind)) throw new Error('aad_cursor_kind_invalid');
  const gen = typeof ingestionGeneration === 'bigint'
    ? ingestionGeneration
    : BigInt(ingestionGeneration);
  const qv = typeof queryVersion === 'bigint' ? queryVersion : BigInt(queryVersion);
  if (gen < 1n || qv < 1n) throw new Error('aad_generation_invalid');
  return Buffer.from([
    AAD_VERSION,
    'delta_cursor_aad_v1',
    `client_id=${String(clientId).trim().toLowerCase()}`,
    `endpoint_id=${String(endpointId).trim().toLowerCase()}`,
    `provider=${PROVIDER}`,
    `provider_tenant_id=${String(providerTenantId).trim().toLowerCase()}`,
    `provider_mailbox_id=${String(providerMailboxId).trim().toLowerCase()}`,
    `ingestion_generation=${gen.toString(10)}`,
    `query_version=${qv.toString(10)}`,
    `cursor_kind=${cursorKind}`,
  ].join('\n'), 'utf8');
}

function parseDeltaCursorEnvelopeAadV1(aad) {
  try {
    if (!Buffer.isBuffer(aad) || aad.length < 1 || aad.length > 4096) {
      return fail('aad_invalid');
    }
    const text = aad.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(aad) || /[\r\0]/.test(text)) {
      return fail('aad_invalid');
    }
    const lines = text.split('\n');
    if (lines.length !== 10 || lines[0] !== AAD_VERSION || lines[1] !== 'delta_cursor_aad_v1') {
      return fail('aad_invalid');
    }
    const field = (line, key) => {
      const p = `${key}=`;
      if (typeof line !== 'string' || !line.startsWith(p)) return null;
      const v = line.slice(p.length);
      return v.length > 0 ? v : null;
    };
    const clientId = field(lines[2], 'client_id');
    const endpointId = field(lines[3], 'endpoint_id');
    const provider = field(lines[4], 'provider');
    const providerTenantId = field(lines[5], 'provider_tenant_id');
    const providerMailboxId = field(lines[6], 'provider_mailbox_id');
    const genStr = field(lines[7], 'ingestion_generation');
    const qvStr = field(lines[8], 'query_version');
    const cursorKind = field(lines[9], 'cursor_kind');
    if (!clientId || !endpointId || !provider || !providerTenantId || !providerMailboxId
        || !genStr || !qvStr || !cursorKind
        || !UUID_CANON.test(clientId) || !UUID_CANON.test(endpointId)
        || !UUID_CANON.test(providerTenantId) || !UUID_CANON.test(providerMailboxId)
        || provider !== PROVIDER || !CURSOR_KINDS.includes(cursorKind)
        || !/^[1-9][0-9]*$/.test(genStr) || !/^[1-9][0-9]*$/.test(qvStr)) {
      return fail('aad_invalid');
    }
    const rebuilt = buildDeltaCursorEnvelopeAadV1({
      clientId,
      endpointId,
      provider,
      providerTenantId,
      providerMailboxId,
      ingestionGeneration: BigInt(genStr),
      queryVersion: BigInt(qvStr),
      cursorKind,
    });
    if (!rebuilt.equals(aad)) return fail('aad_invalid');
    return ok(Object.freeze({
      client_id: clientId,
      endpoint_id: endpointId,
      provider,
      provider_tenant_id: providerTenantId,
      provider_mailbox_id: providerMailboxId,
      ingestion_generation: BigInt(genStr),
      query_version: BigInt(qvStr),
      cursor_kind: cursorKind,
    }));
  } catch {
    return fail('aad_invalid');
  }
}

/**
 * Encode sealed-cursor package body (single grant-package string; no newlines in body).
 * Kind and URL separated by ASCII unit separator so URL may contain '='.
 */
function encodeDeltaCursorPackageV1(cursorKind, cursorUrl) {
  if (!CURSOR_KINDS.includes(cursorKind)) return fail('cursor_package_invalid');
  if (typeof cursorUrl !== 'string' || cursorUrl.length < 1) return fail('cursor_package_invalid');
  if (cursorUrl.includes('\0') || /[\r\n]/.test(cursorUrl)) return fail('cursor_package_invalid');
  if (!validateGraphCursorUrlBoundary(cursorUrl).ok) return fail('cursor_package_invalid');
  const body = `cursor_kind=${cursorKind}\u001fcursor_url=${cursorUrl}`;
  const buf = Buffer.from(`${CURSOR_PKG_PREFIX}${body}\n`, 'utf8');
  if (buf.length > MAX_CURSOR_URL_BYTES + 64) return fail('cursor_package_invalid');
  return ok(buf);
}

function decodeDeltaCursorPackageV1(plaintext) {
  if (!Buffer.isBuffer(plaintext) || plaintext.length < 1 || plaintext.length > MAX_CURSOR_URL_BYTES + 64) {
    return fail('cursor_package_invalid');
  }
  const text = plaintext.toString('utf8');
  if (!text.startsWith(CURSOR_PKG_PREFIX) || !text.endsWith('\n')) {
    return fail('cursor_package_invalid');
  }
  const body = text.slice(CURSOR_PKG_PREFIX.length, -1);
  if (body.includes('\n') || body.includes('\0')) return fail('cursor_package_invalid');
  const parts = body.split('\u001f');
  if (parts.length !== 2) return fail('cursor_package_invalid');
  if (!parts[0].startsWith('cursor_kind=') || !parts[1].startsWith('cursor_url=')) {
    return fail('cursor_package_invalid');
  }
  const cursorKind = parts[0].slice('cursor_kind='.length);
  const cursorUrl = parts[1].slice('cursor_url='.length);
  if (!CURSOR_KINDS.includes(cursorKind) || !cursorUrl) return fail('cursor_package_invalid');
  if (!validateGraphCursorUrlBoundary(cursorUrl).ok) return fail('cursor_package_invalid');
  return ok(Object.freeze({ cursor_kind: cursorKind, cursor_url: cursorUrl }));
}

/**
 * Strict Graph continuation URL shape check (boundary only; not a full nextLink owner).
 * Fail closed on non-https, wrong host, userinfo/hash, oversized, non-string.
 * Uses module-init-pinned node:url constructor + prototype getters only — never ambient
 * global URL and never live property reads (post-load monkeypatch resistant).
 */
function validateGraphCursorUrlBoundary(cursorUrl) {
  try {
    if (typeof cursorUrl !== 'string' || cursorUrl.length < 1 || cursorUrl.length > MAX_CURSOR_URL_BYTES) {
      return fail('cursor_url_invalid');
    }
    // Primitives are never proxies; isProxySurface fail-closed only if pin missing.
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) {
      return fail('cursor_url_invalid');
    }
    if (!PINNED_URL_INTRINSICS_READY) return fail('cursor_url_invalid');
    const u = constructPinnedUrl(cursorUrl);
    if (!u) return fail('cursor_url_invalid');
    const protocol = applyPinnedUrlGetter(u, PINNED_URL_GET_PROTOCOL);
    const username = applyPinnedUrlGetter(u, PINNED_URL_GET_USERNAME);
    const password = applyPinnedUrlGetter(u, PINNED_URL_GET_PASSWORD);
    const hostname = applyPinnedUrlGetter(u, PINNED_URL_GET_HOSTNAME);
    const port = applyPinnedUrlGetter(u, PINNED_URL_GET_PORT);
    const pathname = applyPinnedUrlGetter(u, PINNED_URL_GET_PATHNAME);
    const hash = applyPinnedUrlGetter(u, PINNED_URL_GET_HASH);
    if (typeof protocol !== 'string'
        || typeof username !== 'string'
        || typeof password !== 'string'
        || typeof hostname !== 'string'
        || typeof port !== 'string'
        || typeof pathname !== 'string'
        || typeof hash !== 'string') {
      return fail('cursor_url_invalid');
    }
    if (protocol !== 'https:') return fail('cursor_url_invalid');
    if (username || password || hash) return fail('cursor_url_invalid');
    if (hostname !== 'graph.microsoft.com') return fail('cursor_url_invalid');
    if (port && port !== '443') return fail('cursor_url_invalid');
    if (!pathname.startsWith('/v1.0/')) return fail('cursor_url_invalid');
    return ok(cursorUrl);
  } catch {
    return fail('cursor_url_invalid');
  }
}

function resolvePgLikeQueryMethod(surface) {
  try {
    if (!surface || (typeof surface !== 'object' && typeof surface !== 'function')) {
      return null;
    }
    if (isProxySurface(surface)) return null;
    const own = Object.getOwnPropertyDescriptor(surface, 'query');
    if (own) {
      if (Object.prototype.hasOwnProperty.call(own, 'value')
          && typeof own.value === 'function'
          && !own.get
          && !own.set) {
        return own.value;
      }
      return null;
    }
    let proto = Object.getPrototypeOf(surface);
    let depth = 0;
    while (proto && proto !== Object.prototype && depth < 8) {
      if (isProxySurface(proto)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'query');
      if (descriptor) {
        if (Object.prototype.hasOwnProperty.call(descriptor, 'value')
            && typeof descriptor.value === 'function'
            && !descriptor.get
            && !descriptor.set) {
          return descriptor.value;
        }
        return null;
      }
      proto = Object.getPrototypeOf(proto);
      depth += 1;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveExclusiveClient(client) {
  try {
    if (client == null || (typeof client !== 'object' && typeof client !== 'function')) {
      return null;
    }
    if (isProxySurface(client)) return null;
    const capturedQuery = resolvePgLikeQueryMethod(client);
    if (typeof capturedQuery !== 'function' || isProxySurface(capturedQuery)) return null;
    const trustedReceiver = client;
    return Object.freeze({
      query(...args) {
        return Reflect.apply(capturedQuery, trustedReceiver, args);
      },
    });
  } catch {
    return null;
  }
}

function resolveWithTransactionClient(raw) {
  try {
    if (typeof raw !== 'function' || isProxySurface(raw)) return null;
    const captured = raw;
    return async function pinnedWithTransactionClient(work) {
      if (typeof work !== 'function' || isProxySurface(work)) {
        throw failure();
      }
      return Reflect.apply(captured, undefined, [
        async function exclusiveLoan(client) {
          const exclusive = resolveExclusiveClient(client);
          if (!exclusive) throw failure();
          return work(exclusive);
        },
      ]);
    };
  } catch {
    return null;
  }
}

async function attemptRollback(client) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // no rollback claim
  }
}

/**
 * Short exclusive TX: pre-COMMIT failure → ROLLBACK; COMMIT sent then reject →
 * exact sanitized commit_outcome_unknown (never retry/claim rollback).
 */
async function withTxn(client, fn) {
  let begun = false;
  let commitSent = false;
  try {
    await client.query('BEGIN');
    begun = true;
    const result = await fn();
    if (result && result.ok === false) {
      await client.query('ROLLBACK');
      begun = false;
      return result;
    }
    commitSent = true;
    await client.query('COMMIT');
    begun = false;
    commitSent = false;
    return result;
  } catch {
    if (commitSent) {
      return fail('inbound_delta_state_commit_outcome_unknown');
    }
    if (begun) await attemptRollback(client);
    return fail('inbound_delta_state_write_failed');
  }
}

function snapshotIds(input, fields) {
  const snap = snapshotOwnDataProps(input == null ? {} : input);
  if (!snap.ok) return fail('input_invalid');
  const out = { snap: snap.value };
  for (const f of fields) {
    if (f === 'clientId') {
      out.clientId = parseUuid(snap.value.clientId, 'client_id');
      if (!out.clientId.ok) return out.clientId;
    } else if (f === 'locationId') {
      out.locationId = parseUuid(snap.value.locationId, 'location_id');
      if (!out.locationId.ok) return out.locationId;
    } else if (f === 'endpointId') {
      out.endpointId = parseUuid(snap.value.endpointId, 'endpoint_id');
      if (!out.endpointId.ok) return out.endpointId;
    } else if (f === 'leaseToken') {
      out.leaseToken = parseUuid(snap.value.leaseToken, 'lease_token');
      if (!out.leaseToken.ok) return out.leaseToken;
    } else if (f === 'expectedGeneration') {
      out.expectedGeneration = parsePositiveBigIntish(
        snap.value.expectedGeneration, 'ingestion_generation',
      );
      if (!out.expectedGeneration.ok) return out.expectedGeneration;
    } else if (f === 'expectedStateVersion') {
      out.expectedStateVersion = parsePositiveBigIntish(
        snap.value.expectedStateVersion, 'state_version',
      );
      if (!out.expectedStateVersion.ok) return out.expectedStateVersion;
    }
  }
  return out;
}

function acceptEnvelopeArray(value) {
  try {
    if (value == null) return Object.freeze([]);
    if (typeof value !== 'object' || isProxySurface(value) || !Array.isArray(value)) return null;
    if (Object.getPrototypeOf(value) !== PINNED_ARRAY_PROTOTYPE) return null;
    const len = value.length;
    if (typeof len !== 'number' || !Number.isInteger(len) || len < 0 || len > MAX_BATCH) {
      return null;
    }
    for (let i = 0; i < len; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) return null;
    }
    return value;
  } catch {
    return null;
  }
}

function prepareCanonicalBatch(rawEnvelopes, expectedMailbox) {
  const arr = acceptEnvelopeArray(rawEnvelopes);
  if (!arr) return { ok: false };
  const prepared = new Array(arr.length);
  for (let i = 0; i < arr.length; i += 1) {
    const v = validateInboundEmailEnvelope(arr[i]);
    if (!v.ok) return { ok: false };
    if (v.value.provider !== PROVIDER) return { ok: false };
    if (v.value.provider_mailbox_id !== expectedMailbox) return { ok: false };
    prepared[i] = v.value;
  }
  return { ok: true, envelopes: Object.freeze(prepared.slice()) };
}

/**
 * Tombstones: exact identity keys only. No synthetic event rows.
 * Own-data keys: provider, provider_mailbox_id, provider_message_id.
 */
function prepareTombstones(raw, expectedMailbox) {
  const arr = acceptEnvelopeArray(raw);
  if (!arr) return { ok: false };
  const out = [];
  const idKeys = Object.freeze(['provider', 'provider_mailbox_id', 'provider_message_id']);
  for (let i = 0; i < arr.length; i += 1) {
    if (!exactPlainData(arr[i], idKeys) && !(Object.isFrozen(arr[i]) && exactPlainData(arr[i], idKeys))) {
      // allow frozen or plain exact
      const snap = snapshotOwnDataProps(arr[i]);
      if (!snap.ok) return { ok: false };
      const keys = Object.keys(snap.value);
      if (keys.length !== 3 || keys.some((k) => !idKeys.includes(k))) return { ok: false };
      const provider = snap.value.provider;
      const mailbox = snap.value.provider_mailbox_id;
      const messageId = snap.value.provider_message_id;
      if (provider !== PROVIDER || mailbox !== expectedMailbox) return { ok: false };
      if (typeof messageId !== 'string' || messageId.length < 1 || messageId.length > 2048) {
        return { ok: false };
      }
      out.push(Object.freeze({
        provider, provider_mailbox_id: mailbox, provider_message_id: messageId,
      }));
      continue;
    }
    const provider = ownData(arr[i], 'provider');
    const mailbox = ownData(arr[i], 'provider_mailbox_id');
    const messageId = ownData(arr[i], 'provider_message_id');
    if (provider !== PROVIDER || mailbox !== expectedMailbox) return { ok: false };
    if (typeof messageId !== 'string' || messageId.length < 1 || messageId.length > 2048) {
      return { ok: false };
    }
    out.push(Object.freeze({
      provider, provider_mailbox_id: mailbox, provider_message_id: messageId,
    }));
  }
  return { ok: true, tombstones: Object.freeze(out) };
}

function validateSealedSuccessor(raw) {
  const snap = snapshotOwnDataProps(raw == null ? {} : raw);
  if (!snap.ok) return fail('successor_cursor_invalid');
  const keys = Object.keys(snap.value);
  if (keys.length !== 2
      || !keys.includes('cursor_kind')
      || !keys.includes('envelope')) {
    return fail('successor_cursor_invalid');
  }
  const kind = parseCursorKind(snap.value.cursor_kind);
  if (!kind.ok) return kind;
  const env = validateGrantEnvelopeRecordV1(snap.value.envelope);
  if (!env.ok) return fail('successor_cursor_invalid');
  return ok(Object.freeze({
    cursor_kind: kind.value,
    envelope: env.value,
  }));
}

function buildInsertParams(authority, envelope) {
  return [
    authority.clientId,
    authority.locationId,
    authority.endpointId,
    envelope.provider,
    envelope.provider_mailbox_id,
    envelope.provider_message_id,
    envelope.received_at,
    envelope.subject,
    envelope.sender_display_name,
    envelope.sender_address,
    envelope.is_read,
    envelope.conversation_id,
    envelope.internet_message_id,
  ];
}

function toPrivateLeaseHandle(row) {
  return Object.freeze({
    client_id: String(row.client_id),
    endpoint_id: String(row.endpoint_id),
    ingestion_generation: Number(row.ingestion_generation),
    state_version: Number(row.state_version),
    lease_token: String(row.lease_token),
    lease_until: row.lease_until,
    phase: row.phase,
    query_version: Number(row.query_version),
  });
}

function toPublicStatus(row) {
  if (!row) {
    return Object.freeze({
      state_present: false,
      phase: null,
      ingestion_generation: null,
      query_version: null,
      state_version: null,
      has_active_lease: false,
      has_sealed_cursor: false,
      cursor_kind: null,
      reset_reason: null,
    });
  }
  return Object.freeze({
    state_present: true,
    phase: row.phase,
    ingestion_generation: Number(row.ingestion_generation),
    query_version: Number(row.query_version),
    state_version: Number(row.state_version),
    has_active_lease: row.has_active_lease === true,
    has_sealed_cursor: row.has_sealed_cursor === true,
    cursor_kind: row.cursor_kind == null ? null : String(row.cursor_kind),
    reset_reason: row.reset_reason == null ? null : String(row.reset_reason),
  });
}

function envelopeColumnsFromRecord(env) {
  return [
    env.envelope_version,
    env.aead_alg,
    env.kek_wrap_alg,
    env.kek_key_name,
    env.kek_key_version,
    env.nonce,
    env.ciphertext,
    env.auth_tag,
    env.wrapped_dek,
    env.operation_id,
  ];
}

/**
 * Coerce driver bytea (Buffer | Uint8Array | {type:'Buffer',data}) to Buffer.
 * Fail closed on unknown shapes — never invent ciphertext.
 */
function asOwnedBuffer(value) {
  try {
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (value && typeof value === 'object'
        && value.type === 'Buffer'
        && Array.isArray(value.data)) {
      return Buffer.from(value.data);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Normalize a sealed envelope row/record so bytea fields are Buffers and
 * operation_id is a canonical UUID string (cursor_operation_id alias accepted).
 */
function normalizeSealedEnvelopeRecord(raw) {
  const snap = snapshotOwnDataProps(raw == null ? {} : raw);
  if (!snap.ok) return fail('successor_cursor_invalid');
  const s = snap.value;
  const op = s.operation_id != null ? s.operation_id : s.cursor_operation_id;
  const nonce = asOwnedBuffer(s.nonce);
  const ciphertext = asOwnedBuffer(s.ciphertext);
  const authTag = asOwnedBuffer(s.auth_tag);
  const wrappedDek = asOwnedBuffer(s.wrapped_dek);
  if (!nonce || !ciphertext || !authTag || !wrappedDek) {
    return fail('successor_cursor_invalid');
  }
  return validateGrantEnvelopeRecordV1(Object.freeze({
    envelope_version: s.envelope_version,
    aead_alg: s.aead_alg,
    kek_wrap_alg: s.kek_wrap_alg,
    kek_key_name: s.kek_key_name,
    kek_key_version: s.kek_key_version,
    nonce,
    ciphertext,
    auth_tag: authTag,
    wrapped_dek: wrappedDek,
    operation_id: typeof op === 'string' ? op : String(op || ''),
  }));
}

/**
 * Seal Graph nextLink/deltaLink via existing envelope provider (OUTSIDE txn).
 * Cursor package is base64url-wrapped as the grant-package refresh_token body so
 * both fake and Azure KV openGrantPayload reverse it without a second crypto owner.
 * Strict URL validation at this boundary; DB only stores sealed envelope.
 */
async function sealDeltaCursorCompatible(envelopeProvider, input) {
  try {
    const snap = snapshotOwnDataProps(input == null ? {} : input);
    if (!snap.ok) return fail('seal_input_invalid');
    const s = snap.value;
    const clientId = parseUuid(s.clientId, 'client_id');
    if (!clientId.ok) return clientId;
    const endpointId = parseUuid(s.endpointId, 'endpoint_id');
    if (!endpointId.ok) return endpointId;
    const providerTenantId = parseUuid(s.providerTenantId, 'provider_tenant_id');
    if (!providerTenantId.ok) return providerTenantId;
    const providerMailboxId = parseUuid(s.providerMailboxId, 'provider_mailbox_id');
    if (!providerMailboxId.ok) return providerMailboxId;
    const gen = parsePositiveBigIntish(s.ingestionGeneration, 'ingestion_generation');
    if (!gen.ok) return gen;
    const qv = parsePositiveBigIntish(s.queryVersion, 'query_version');
    if (!qv.ok) return qv;
    const kind = parseCursorKind(s.cursorKind);
    if (!kind.ok) return kind;
    const urlCheck = validateGraphCursorUrlBoundary(s.cursorUrl);
    if (!urlCheck.ok) return urlCheck;
    const operationId = parseUuid(s.operationId, 'operation_id');
    if (!operationId.ok) return operationId;

    const aad = buildDeltaCursorEnvelopeAadV1({
      clientId: clientId.value,
      endpointId: endpointId.value,
      provider: PROVIDER,
      providerTenantId: providerTenantId.value,
      providerMailboxId: providerMailboxId.value,
      ingestionGeneration: gen.value,
      queryVersion: qv.value,
      cursorKind: kind.value,
    });
    const pkg = encodeDeltaCursorPackageV1(kind.value, urlCheck.value);
    if (!pkg.ok) return pkg;
    const asRefreshBody = pkg.value.toString('base64url');
    let envelope;
    try {
      envelope = await envelopeProvider.sealGrantPayload(Object.freeze({
        refresh_token: asRefreshBody,
        aad,
        operation_id: operationId.value,
      }));
    } catch {
      return fail('cursor_seal_failed');
    }
    const v = validateGrantEnvelopeRecordV1(envelope);
    if (!v.ok) return fail('cursor_seal_failed');
    zeroizeBuffer(pkg.value);
    return ok(Object.freeze({
      cursor_kind: kind.value,
      envelope: v.value,
    }));
  } catch {
    return fail('cursor_seal_failed');
  }
}

/** @deprecated alias — sole seal path is grant-package-compatible. */
const sealDeltaCursor = sealDeltaCursorCompatible;

/**
 * Open sealed cursor under AAD identity (OUTSIDE short DB txn after lease re-check).
 * Wrong AAD (tenant/mailbox/generation/query_version/cursor_kind) fails closed.
 */
async function openSealedDeltaCursor(envelopeProvider, input) {
  try {
    const snap = snapshotOwnDataProps(input == null ? {} : input);
    if (!snap.ok) return fail('open_input_invalid');
    const s = snap.value;
    const clientId = parseUuid(s.clientId, 'client_id');
    if (!clientId.ok) return clientId;
    const endpointId = parseUuid(s.endpointId, 'endpoint_id');
    if (!endpointId.ok) return endpointId;
    const providerTenantId = parseUuid(s.providerTenantId, 'provider_tenant_id');
    if (!providerTenantId.ok) return providerTenantId;
    const providerMailboxId = parseUuid(s.providerMailboxId, 'provider_mailbox_id');
    if (!providerMailboxId.ok) return providerMailboxId;
    const gen = parsePositiveBigIntish(s.ingestionGeneration, 'ingestion_generation');
    if (!gen.ok) return gen;
    const qv = parsePositiveBigIntish(s.queryVersion, 'query_version');
    if (!qv.ok) return qv;
    const kind = parseCursorKind(s.cursorKind);
    if (!kind.ok) return kind;
    const env = normalizeSealedEnvelopeRecord(s.envelope);
    if (!env.ok) return fail('cursor_open_failed');

    const aad = buildDeltaCursorEnvelopeAadV1({
      clientId: clientId.value,
      endpointId: endpointId.value,
      provider: PROVIDER,
      providerTenantId: providerTenantId.value,
      providerMailboxId: providerMailboxId.value,
      ingestionGeneration: gen.value,
      queryVersion: qv.value,
      cursorKind: kind.value,
    });

    let opened;
    try {
      opened = await envelopeProvider.openGrantPayload(Object.freeze({
        envelope: env.value,
        aad,
      }));
    } catch {
      return fail('cursor_open_failed');
    }
    if (!opened || typeof opened.refresh_token !== 'string') {
      return fail('cursor_open_failed');
    }
    let raw;
    try {
      raw = Buffer.from(opened.refresh_token, 'base64url');
    } catch {
      return fail('cursor_open_failed');
    }
    const decoded = decodeDeltaCursorPackageV1(raw);
    zeroizeBuffer(raw);
    if (!decoded.ok) return fail('cursor_open_failed');
    if (decoded.value.cursor_kind !== kind.value) return fail('cursor_open_failed');
    const urlCheck = validateGraphCursorUrlBoundary(decoded.value.cursor_url);
    if (!urlCheck.ok) return fail('cursor_open_failed');
    return ok(Object.freeze({
      cursor_kind: kind.value,
      cursor_url: urlCheck.value,
    }));
  } catch {
    return fail('cursor_open_failed');
  }
}

function createInboundEmailDeltaStateStore(deps) {
  let withTransactionClient;
  let envelopeProvider = null;
  try {
    if (deps == null || typeof deps !== 'object' || Array.isArray(deps)) throw failure();
    if (isProxySurface(deps)) throw failure();
    const snap = snapshotOwnDataProps(deps);
    if (!snap.ok) throw failure();
    const keySet = new Set(Object.keys(snap.value));
    if (!keySet.has('withTransactionClient')) throw failure();
    for (const k of keySet) {
      if (k !== 'withTransactionClient' && k !== 'envelopeProvider') throw failure();
    }
    withTransactionClient = resolveWithTransactionClient(snap.value.withTransactionClient);
    if (!withTransactionClient) throw failure();
    if (keySet.has('envelopeProvider')) {
      if (isProxySurface(snap.value.envelopeProvider)) throw failure();
      const vp = validateEmailGrantEnvelopeProvider(snap.value.envelopeProvider);
      if (!vp.ok) throw failure();
      envelopeProvider = vp.value;
    }
  } catch (err) {
    if (err && err.code === FAILURE_CODE) throw err;
    throw failure();
  }

  async function runExclusive(work) {
    try {
      return await withTransactionClient(async (client) => work(client));
    } catch (err) {
      if (err && err.code === FAILURE_CODE) {
        return fail(FAILURE_CODE);
      }
      return fail('inbound_delta_state_write_failed');
    }
  }

  async function initializeState(input) {
    const ids = snapshotIds(input, ['clientId', 'locationId', 'endpointId']);
    if (ids.ok === false) return ids;
    const tenant = parseUuid(ids.snap.providerTenantId, 'provider_tenant_id');
    if (!tenant.ok) return tenant;
    const mailbox = parseUuid(ids.snap.providerMailboxId, 'provider_mailbox_id');
    if (!mailbox.ok) return mailbox;
    const qv = parsePositiveBigIntish(
      ids.snap.queryVersion == null ? 1 : ids.snap.queryVersion,
      'query_version',
    );
    if (!qv.ok) return qv;

    return runExclusive(async (client) => withTxn(client, async () => {
      const existing = await client.query(SQL_LOCK_CURRENT, [
        ids.clientId.value, ids.endpointId.value,
      ]);
      if (existing.rows && existing.rows.length > 0) {
        return fail('delta_state_already_exists');
      }
      const ins = await client.query(SQL_INSERT_INITIAL, [
        ids.clientId.value,
        ids.locationId.value,
        ids.endpointId.value,
        PROVIDER,
        tenant.value,
        mailbox.value,
        qv.value.toString(10),
      ]);
      if (!ins.rows || ins.rows.length !== 1) return fail('inbound_delta_state_write_failed');
      const row = ins.rows[0];
      return ok(Object.freeze({
        client_id: String(row.client_id),
        endpoint_id: String(row.endpoint_id),
        ingestion_generation: Number(row.ingestion_generation),
        query_version: Number(row.query_version),
        phase: row.phase,
        state_version: Number(row.state_version),
      }));
    }));
  }

  async function acquireLease(input) {
    const ids = snapshotIds(input, ['clientId', 'endpointId']);
    if (ids.ok === false) return ids;
    const workerId = parseWorkerId(ids.snap.workerId);
    if (!workerId.ok) return workerId;
    const ttl = parseTtl(ids.snap.ttlSeconds);
    if (!ttl.ok) return ttl;
    const gen = parsePositiveBigIntish(ids.snap.expectedGeneration, 'ingestion_generation');
    if (!gen.ok) return gen;
    const sv = parsePositiveBigIntish(ids.snap.expectedStateVersion, 'state_version');
    if (!sv.ok) return sv;
    const leaseToken = crypto.randomUUID();

    return runExclusive(async (client) => withTxn(client, async () => {
      const locked = await client.query(SQL_LOCK_CURRENT, [
        ids.clientId.value, ids.endpointId.value,
      ]);
      if (!locked.rows || locked.rows.length !== 1) return fail('delta_state_not_found');
      const row = locked.rows[0];
      if (Number(row.ingestion_generation) !== Number(gen.value)) {
        return fail('generation_mismatch');
      }
      if (Number(row.state_version) !== Number(sv.value)) {
        return fail('state_version_mismatch');
      }
      if (row.phase === 'reset_required') return fail('reset_required');
      const upd = await client.query(SQL_CAS_LEASE_ACQUIRE, [
        ids.clientId.value,
        ids.endpointId.value,
        workerId.value,
        leaseToken,
        String(ttl.value),
        gen.value.toString(10),
        sv.value.toString(10),
      ]);
      if (!upd.rows || upd.rows.length !== 1) return fail('lease_acquire_conflict');
      return ok(toPrivateLeaseHandle(upd.rows[0]));
    }));
  }

  async function renewLease(input) {
    const ids = snapshotIds(input, [
      'clientId', 'endpointId', 'leaseToken', 'expectedGeneration', 'expectedStateVersion',
    ]);
    if (ids.ok === false) return ids;
    const ttl = parseTtl(ids.snap.ttlSeconds);
    if (!ttl.ok) return ttl;

    return runExclusive(async (client) => withTxn(client, async () => {
      const upd = await client.query(SQL_CAS_LEASE_RENEW, [
        ids.clientId.value,
        ids.endpointId.value,
        ids.expectedGeneration.value.toString(10),
        ids.expectedStateVersion.value.toString(10),
        String(ttl.value),
        ids.leaseToken.value,
      ]);
      if (!upd.rows || upd.rows.length !== 1) return fail('lease_fenced');
      return ok(toPrivateLeaseHandle(upd.rows[0]));
    }));
  }

  async function releaseLease(input) {
    const ids = snapshotIds(input, [
      'clientId', 'endpointId', 'leaseToken', 'expectedGeneration', 'expectedStateVersion',
    ]);
    if (ids.ok === false) return ids;

    return runExclusive(async (client) => withTxn(client, async () => {
      const upd = await client.query(SQL_CAS_LEASE_RELEASE, [
        ids.clientId.value,
        ids.endpointId.value,
        ids.expectedGeneration.value.toString(10),
        ids.expectedStateVersion.value.toString(10),
        ids.leaseToken.value,
      ]);
      if (!upd.rows || upd.rows.length !== 1) return fail('lease_fenced');
      return ok(Object.freeze({
        client_id: String(upd.rows[0].client_id),
        endpoint_id: String(upd.rows[0].endpoint_id),
        ingestion_generation: Number(upd.rows[0].ingestion_generation),
        state_version: Number(upd.rows[0].state_version),
        phase: upd.rows[0].phase,
      }));
    }));
  }

  /**
   * Open cursor under a valid unexpired lease. Short TX re-checks lease + identity,
   * then opens sealed envelope AFTER COMMIT (no crypto inside txn).
   */
  async function openCursor(input) {
    if (!envelopeProvider) return fail('envelope_provider_required');
    const ids = snapshotIds(input, [
      'clientId', 'endpointId', 'leaseToken', 'expectedGeneration', 'expectedStateVersion',
    ]);
    if (ids.ok === false) return ids;

    const loaded = await runExclusive(async (client) => withTxn(client, async () => {
      const locked = await client.query(SQL_LOCK_CURRENT, [
        ids.clientId.value, ids.endpointId.value,
      ]);
      if (!locked.rows || locked.rows.length !== 1) return fail('delta_state_not_found');
      const row = locked.rows[0];
      if (Number(row.ingestion_generation) !== Number(ids.expectedGeneration.value)) {
        return fail('generation_mismatch');
      }
      if (Number(row.state_version) !== Number(ids.expectedStateVersion.value)) {
        return fail('state_version_mismatch');
      }
      if (String(row.lease_token) !== ids.leaseToken.value) return fail('lease_fenced');
      // re-check unexpired via SQL
      const live = await client.query(
        `SELECT (lease_until IS NOT NULL AND lease_until > clock_timestamp()) AS ok
           FROM tenant_email_inbound_delta_states
          WHERE client_id = $1::uuid AND endpoint_id = $2::uuid AND is_current = true
            AND lease_token = $3::uuid`,
        [ids.clientId.value, ids.endpointId.value, ids.leaseToken.value],
      );
      if (!live.rows || live.rows[0].ok !== true) return fail('lease_expired');
      if (row.phase === 'reset_required') return fail('reset_required');
      if (row.cursor_kind == null) {
        return ok(Object.freeze({
          kind: 'none',
          phase: row.phase,
          provider_tenant_id: String(row.provider_tenant_id),
          provider_mailbox_id: String(row.provider_mailbox_id),
          query_version: Number(row.query_version),
          ingestion_generation: Number(row.ingestion_generation),
        }));
      }
      // Copy sealed material for post-commit open (no plaintext URL yet).
      // Coerce driver bytea so open path never depends on Buffer vs Uint8Array.
      const nonce = asOwnedBuffer(row.nonce);
      const ciphertext = asOwnedBuffer(row.ciphertext);
      const authTag = asOwnedBuffer(row.auth_tag);
      const wrappedDek = asOwnedBuffer(row.wrapped_dek);
      if (!nonce || !ciphertext || !authTag || !wrappedDek) {
        return fail('cursor_open_failed');
      }
      return ok(Object.freeze({
        kind: 'sealed',
        phase: row.phase,
        cursor_kind: String(row.cursor_kind),
        provider_tenant_id: String(row.provider_tenant_id).toLowerCase(),
        provider_mailbox_id: String(row.provider_mailbox_id).toLowerCase(),
        query_version: Number(row.query_version),
        ingestion_generation: Number(row.ingestion_generation),
        envelope: Object.freeze({
          envelope_version: row.envelope_version,
          aead_alg: row.aead_alg,
          kek_wrap_alg: row.kek_wrap_alg,
          kek_key_name: row.kek_key_name,
          kek_key_version: row.kek_key_version,
          nonce,
          ciphertext,
          auth_tag: authTag,
          wrapped_dek: wrappedDek,
          operation_id: String(row.cursor_operation_id).toLowerCase(),
        }),
      }));
    }));

    if (!loaded.ok) return loaded;
    if (loaded.value.kind === 'none') {
      return ok(Object.freeze({
        cursor_present: false,
        phase: loaded.value.phase,
        cursor_kind: null,
        // never return mailbox/tenant on public surfaces — this is private open handle
        cursor_url: null,
      }));
    }

    const opened = await openSealedDeltaCursor(envelopeProvider, Object.freeze({
      clientId: ids.clientId.value,
      endpointId: ids.endpointId.value,
      providerTenantId: loaded.value.provider_tenant_id,
      providerMailboxId: loaded.value.provider_mailbox_id,
      ingestionGeneration: loaded.value.ingestion_generation,
      queryVersion: loaded.value.query_version,
      cursorKind: loaded.value.cursor_kind,
      envelope: loaded.value.envelope,
    }));
    if (!opened.ok) return opened;
    return ok(Object.freeze({
      cursor_present: true,
      phase: loaded.value.phase,
      cursor_kind: opened.value.cursor_kind,
      cursor_url: opened.value.cursor_url,
    }));
  }

  /**
   * ONLY page-commit owner. No network/crypto inside transaction.
   * Caller supplies validated envelopes/tombstones + sealed successor cursor.
   * Duplicate-only / tombstone-only pages still advance cursor + state_version.
   */
  async function commitPageEvents(input) {
    const ids = snapshotIds(input, [
      'clientId', 'locationId', 'endpointId', 'leaseToken',
      'expectedGeneration', 'expectedStateVersion',
    ]);
    if (ids.ok === false) return ids;
    const mailbox = parseUuid(ids.snap.providerMailboxId, 'provider_mailbox_id');
    if (!mailbox.ok) return mailbox;
    const qv = parsePositiveBigIntish(ids.snap.queryVersion, 'query_version');
    if (!qv.ok) return qv;

    const prepared = prepareCanonicalBatch(ids.snap.envelopes, mailbox.value);
    if (!prepared.ok) return fail('page_batch_invalid');
    const tombs = prepareTombstones(
      ids.snap.tombstones == null ? [] : ids.snap.tombstones,
      mailbox.value,
    );
    if (!tombs.ok) return fail('page_tombstones_invalid');
    const successor = validateSealedSuccessor(ids.snap.successorCursor);
    if (!successor.ok) return successor;

    return runExclusive(async (client) => withTxn(client, async () => {
      const locked = await client.query(SQL_LOCK_CURRENT, [
        ids.clientId.value, ids.endpointId.value,
      ]);
      if (!locked.rows || locked.rows.length !== 1) return fail('delta_state_not_found');
      const row = locked.rows[0];
      if (String(row.client_id) !== ids.clientId.value) return fail('authority_mismatch');
      if (String(row.endpoint_id) !== ids.endpointId.value) return fail('authority_mismatch');
      if (String(row.location_id) !== ids.locationId.value) return fail('authority_mismatch');
      if (Number(row.ingestion_generation) !== Number(ids.expectedGeneration.value)) {
        return fail('generation_mismatch');
      }
      if (Number(row.state_version) !== Number(ids.expectedStateVersion.value)) {
        return fail('state_version_mismatch');
      }
      if (String(row.lease_token) !== ids.leaseToken.value) return fail('lease_fenced');
      if (String(row.provider_mailbox_id) !== mailbox.value) return fail('mailbox_mismatch');
      if (Number(row.query_version) !== Number(qv.value)) return fail('query_version_mismatch');
      if (row.phase === 'reset_required' || row.phase === 'paused') {
        return fail(row.phase === 'reset_required' ? 'reset_required' : 'phase_paused');
      }

      const authority = Object.freeze({
        clientId: ids.clientId.value,
        locationId: ids.locationId.value,
        endpointId: ids.endpointId.value,
      });

      // Arrival-capture inserts only; tombstones create no synthetic events.
      for (let i = 0; i < prepared.envelopes.length; i += 1) {
        await client.query(
          SQL_INSERT_EVENT,
          buildInsertParams(authority, prepared.envelopes[i]),
        );
      }
      // tombstones intentionally not inserted

      // nextLink during bootstrap stays initial; deltaLink always tracking.
      const finalPhase = successor.value.cursor_kind === 'deltaLink'
        ? 'tracking'
        : (row.phase === 'tracking' ? 'tracking' : 'initial');

      const env = successor.value.envelope;
      const cols = envelopeColumnsFromRecord(env);
      const upd = await client.query(SQL_CAS_COMMIT_CURSOR, [
        ids.clientId.value,
        ids.endpointId.value,
        ids.expectedGeneration.value.toString(10),
        ids.expectedStateVersion.value.toString(10),
        ids.leaseToken.value,
        mailbox.value,
        qv.value.toString(10),
        successor.value.cursor_kind,
        cols[0], cols[1], cols[2], cols[3], cols[4],
        cols[5], cols[6], cols[7], cols[8], cols[9],
        finalPhase,
      ]);
      if (!upd.rows || upd.rows.length !== 1) {
        // CAS failure must roll back inserts too (withTxn rolls back on ok:false).
        return fail('commit_cas_conflict');
      }
      return ok(Object.freeze({
        client_id: String(upd.rows[0].client_id),
        endpoint_id: String(upd.rows[0].endpoint_id),
        ingestion_generation: Number(upd.rows[0].ingestion_generation),
        state_version: Number(upd.rows[0].state_version),
        phase: upd.rows[0].phase,
        query_version: Number(upd.rows[0].query_version),
        cursor_kind: upd.rows[0].cursor_kind,
        envelopes_presented: prepared.envelopes.length,
        tombstones_presented: tombs.tombstones.length,
      }));
    }));
  }

  async function markResetRequired(input) {
    const ids = snapshotIds(input, [
      'clientId', 'endpointId', 'expectedGeneration', 'expectedStateVersion',
    ]);
    if (ids.ok === false) return ids;
    const reason = parseResetReason(ids.snap.reason);
    if (!reason.ok) return reason;

    return runExclusive(async (client) => withTxn(client, async () => {
      const upd = await client.query(SQL_CAS_RESET_REQUIRED, [
        ids.clientId.value,
        ids.endpointId.value,
        ids.expectedGeneration.value.toString(10),
        ids.expectedStateVersion.value.toString(10),
        reason.value,
      ]);
      if (!upd.rows || upd.rows.length !== 1) return fail('reset_cas_conflict');
      return ok(Object.freeze({
        client_id: String(upd.rows[0].client_id),
        endpoint_id: String(upd.rows[0].endpoint_id),
        ingestion_generation: Number(upd.rows[0].ingestion_generation),
        state_version: Number(upd.rows[0].state_version),
        phase: upd.rows[0].phase,
        reset_reason: upd.rows[0].reset_reason,
      }));
    }));
  }

  /**
   * Explicit reset/rebind: demote current generation, insert generation+1 as current.
   * Preserves old state/events. Only verified authority snapshot may become current.
   * Grant refresh must not call this.
   */
  async function beginNextGeneration(input) {
    const ids = snapshotIds(input, [
      'clientId', 'locationId', 'endpointId',
      'expectedGeneration', 'expectedStateVersion',
    ]);
    if (ids.ok === false) return ids;
    const tenant = parseUuid(ids.snap.providerTenantId, 'provider_tenant_id');
    if (!tenant.ok) return tenant;
    const mailbox = parseUuid(ids.snap.providerMailboxId, 'provider_mailbox_id');
    if (!mailbox.ok) return mailbox;
    const qv = parsePositiveBigIntish(ids.snap.queryVersion, 'query_version');
    if (!qv.ok) return qv;
    // verifiedAuthority must be exact own-data true
    if (ids.snap.verifiedAuthority !== true) return fail('authority_not_verified');

    return runExclusive(async (client) => withTxn(client, async () => {
      const demoted = await client.query(SQL_DEMOTE_CURRENT, [
        ids.clientId.value,
        ids.endpointId.value,
        ids.expectedGeneration.value.toString(10),
        ids.expectedStateVersion.value.toString(10),
      ]);
      if (!demoted.rows || demoted.rows.length !== 1) return fail('generation_cas_conflict');
      const nextGen = Number(demoted.rows[0].ingestion_generation) + 1;
      const ins = await client.query(SQL_INSERT_NEXT_GENERATION, [
        ids.clientId.value,
        ids.locationId.value,
        ids.endpointId.value,
        PROVIDER,
        tenant.value,
        mailbox.value,
        String(nextGen),
        qv.value.toString(10),
      ]);
      if (!ins.rows || ins.rows.length !== 1) return fail('inbound_delta_state_write_failed');
      const row = ins.rows[0];
      return ok(Object.freeze({
        client_id: String(row.client_id),
        endpoint_id: String(row.endpoint_id),
        ingestion_generation: Number(row.ingestion_generation),
        query_version: Number(row.query_version),
        phase: row.phase,
        state_version: Number(row.state_version),
        previous_generation: Number(demoted.rows[0].ingestion_generation),
      }));
    }));
  }

  async function getPublicStatus(input) {
    const ids = snapshotIds(input, ['clientId', 'endpointId']);
    if (ids.ok === false) return ids;
    return runExclusive(async (client) => {
      try {
        const r = await client.query(SQL_PUBLIC_STATUS, [
          ids.clientId.value, ids.endpointId.value,
        ]);
        if (!r.rows || r.rows.length === 0) return ok(toPublicStatus(null));
        return ok(toPublicStatus(r.rows[0]));
      } catch {
        return fail('inbound_delta_state_write_failed');
      }
    });
  }

  return Object.freeze({
    initializeState,
    acquireLease,
    renewLease,
    releaseLease,
    openCursor,
    commitPageEvents,
    markResetRequired,
    beginNextGeneration,
    getPublicStatus,
    sealDeltaCursor: envelopeProvider
      ? (input) => sealDeltaCursorCompatible(envelopeProvider, input)
      : async () => fail('envelope_provider_required'),
  });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  FAILURE_MESSAGE,
  EMAIL_INBOUND_DELTA_STATE_RUNTIME_WIRED,
  EMAIL_INBOUND_DELTA_STATE_PAGE_COMMIT_OWNER,
  EMAIL_INBOUND_DELTA_STATE_LOGGING_FORBIDDEN,
  PHASES,
  CURSOR_KINDS,
  PROVIDER,
  PUBLIC_STATUS_KEYS,
  STORE_DEPENDENCY_KEYS,
  STORE_WITH_PROVIDER_KEYS,
  ENVELOPE_RECORD_KEYS,
  SQL_INSERT_EVENT,
  SQL_LOCK_CURRENT,
  buildDeltaCursorEnvelopeAadV1,
  parseDeltaCursorEnvelopeAadV1,
  encodeDeltaCursorPackageV1,
  decodeDeltaCursorPackageV1,
  validateGraphCursorUrlBoundary,
  sealDeltaCursorCompatible,
  openSealedDeltaCursor,
  createInboundEmailDeltaStateStore,
  // test helpers
  resolveWithTransactionClient,
  resolveExclusiveClient,
  prepareCanonicalBatch,
  prepareTombstones,
  validateSealedSuccessor,
});
