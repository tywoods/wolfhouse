'use strict';

/**
 * Microsoft Graph messages-delta durable state + page-commit store (offline).
 *
 * - Migration 064 `tenant_email_inbound_delta_states` owns sealed cursor + phase
 *   + ingestion_generation (independent of OAuth grant-custody rotation) + DB-clock lease.
 * - `commitPageEvents` is the ONLY page-commit owner: cryptographically opens and
 *   validates the successor envelope **before** the short exclusive-client TX
 *   (no network/crypto inside TX). Caller supplies already-validated canonical
 *   envelopes/tombstones and an already-sealed successor cursor envelope.
 *   Page operation id is the sealed successor envelope.operation_id (generated
 *   before seal/commit; internal only — never public result/log/metric).
 *   Inside one exclusive-client TX: authority re-verify → claim/validate
 *   page_commit journal (worker actor sunset-email-delta-worker) → idempotent
 *   event inserts → cursor CAS with same operation id → complete committed
 *   journal outcome → one COMMIT. Same operation id exact retry replays the
 *   persisted committed result with zero event/state mutation. COMMIT dispatch
 *   ambiguity → inbound_delta_state_commit_outcome_unknown (no release/retry/
 *   guessed rollback). Mismatch actor/endpoint/fences/kind → conflict.
 * - Inserts reuse migration-063 event identity via `SQL_INSERT_EVENT` from
 *   `email-inbound-event-store` (ON CONFLICT DO NOTHING; arrival-capture only).
 * - Seal/open reuse injected envelope provider (AES-256-GCM + wrapped DEK).
 *   Cursor package is sealed as opaque grant-package body (never plaintext in DB).
 * - Strict authority-bound messages-delta URL validation: https graph.microsoft.com
 *   default/443, no userinfo/hash, exact v1.0 users/{mailbox}/messages/delta path,
 *   exact continuation token for cursorKind (nextLink→$skiptoken, deltaLink→$deltatoken).
 * - AAD binds client+endpoint+provider+tenant+mailbox+generation+query_version+
 *   cursor_kind so rebind/generation/query-version change fails closed.
 * - query_version is the production-exact text constant ms_messages_delta_v1
 *   (not BIGINT; not caller-chosen). Parser accepts omitted or that exact value
 *   only; migration CHECK pins the same constant. Future contract changes require
 *   a deliberate code+migration version bump together.
 * - ingestion_generation / state_version bounded to JS MAX_SAFE_INTEGER.
 * - openCursor: lease read → crypto outside TX → second DB-clock lease/token/
 *   generation/state_version revalidation immediately before releasing plaintext.
 * - beginNextGeneration consumes a factory-fixed authority-verifier capability
 *   (caller cannot self-assert with a boolean). Injected adapter reuses existing
 *   authority resolver without importing/wiring runtime.
 * - Module-private demote/insert SQL primitive is never exported. The authority-
 *   bearing store object returned by `createInboundEmailDeltaStateStore` exposes
 *   `advanceGenerationOnExclusiveClient`, which **unavoidably re-invokes the
 *   factory-fixed authorityVerifier before any state SQL** (including forged
 *   direct calls), binds canonical client/location/endpoint/provider tenant/
 *   mailbox + expected generation/state version, and runs demote/insert on the
 *   supplied exclusive client with **no** nested BEGIN/COMMIT/checkout/release.
 *   Public `beginNextGeneration` calls the same factory-bound path inside its
 *   exclusive withTxn wrapper and remains behavior-compatible. Recovery journal
 *   (065) receives the factory store object capability (never imports the raw
 *   private primitive) so claim + authority re-verify + demote/insert + journal
 *   completion share ONE outer transaction/client.
 * - One-current invariant: partial unique is at-most-one; owner demote+insert never
 *   leaves zero current; no public delete API. (DB trigger not required solely for
 *   unauthorized direct SQL.)
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
const GRAPH_HOST = 'graph.microsoft.com';
const GRAPH_API_VERSION = 'v1.0';
/**
 * Production-exact text identifier of the messages-delta query contract.
 * Must stay byte-identical to migration 064 CHECK
 * tenant_email_inbound_delta_states_query_version_exact.
 * Future contract changes require deliberate code+migration version bump —
 * never accept caller-chosen strings.
 */
const DEFAULT_QUERY_VERSION = 'ms_messages_delta_v1';
/** JS Number.MAX_SAFE_INTEGER — generations never fence beyond this. */
const MAX_SAFE_GENERATION = Number.MAX_SAFE_INTEGER;

/**
 * Source-pinned worker actor for page_commit journal attribution (migration 066).
 * Distinct from lease worker_id; journal CHECK requires this exact value.
 */
const PAGE_COMMIT_WORKER_ID = 'sunset-email-delta-worker';

const STORE_DEPENDENCY_KEYS = Object.freeze(['withTransactionClient']);
const STORE_WITH_PROVIDER_KEYS = Object.freeze([
  'withTransactionClient',
  'envelopeProvider',
  'authorityVerifier',
]);
const AUTHORITY_VERIFIER_KEYS = Object.freeze(['verifyBinding']);
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
const MAX_TOKEN_BYTES = 4096;
const MIN_TTL = 5;
const MAX_TTL = 3600;
const DEFAULT_TTL = 60;
const CURSOR_PKG_PREFIX = 'EMAIL_DELTA_CURSOR_PKG_V1\n';
const AAD_VERSION = 'v1';
const SKIPTOKEN_KEY = '$skiptoken';
const DELTATOKEN_KEY = '$deltatoken';

/* ── Module-init pins (URL + security/reflection intrinsics) ───────────────
 * Ambient global/prototype/monkeypatches after load must not weaken hostile
 * boundary checks. Never live property reads on untrusted surfaces when a pin
 * exists; only Reflect.construct / Reflect.apply + pinned prototype getters.
 */
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;
const PINNED_ARRAY_PROTOTYPE = Array.prototype;
const PINNED_OBJECT_PROTOTYPE = Object.prototype;
const PINNED_REFLECT_APPLY = typeof Reflect.apply === 'function' ? Reflect.apply : null;
const PINNED_REFLECT_CONSTRUCT = typeof Reflect.construct === 'function' ? Reflect.construct : null;
const PINNED_REFLECT_OWN_KEYS = typeof Reflect.ownKeys === 'function' ? Reflect.ownKeys : null;
const PINNED_GET_OWN_PROPERTY_DESCRIPTOR =
  typeof Object.getOwnPropertyDescriptor === 'function' ? Object.getOwnPropertyDescriptor : null;
const PINNED_GET_PROTOTYPE_OF =
  typeof Object.getPrototypeOf === 'function' ? Object.getPrototypeOf : null;
const PINNED_HAS_OWN =
  typeof Object.prototype.hasOwnProperty === 'function'
    ? Object.prototype.hasOwnProperty
    : null;

const PINNED_URL = typeof NODE_URL === 'function' ? NODE_URL : null;
const PINNED_URL_PROTOTYPE = PINNED_URL && PINNED_URL.prototype
  ? PINNED_URL.prototype
  : null;

function pinUrlGetter(name) {
  try {
    if (!PINNED_URL_PROTOTYPE || !PINNED_GET_OWN_PROPERTY_DESCRIPTOR) return null;
    const descriptor = PINNED_GET_OWN_PROPERTY_DESCRIPTOR.call(Object, PINNED_URL_PROTOTYPE, name);
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
const PINNED_URL_GET_HOST = pinUrlGetter('host');
const PINNED_URL_GET_PORT = pinUrlGetter('port');
const PINNED_URL_GET_PATHNAME = pinUrlGetter('pathname');
const PINNED_URL_GET_SEARCH = pinUrlGetter('search');
const PINNED_URL_GET_HASH = pinUrlGetter('hash');

const PINNED_URL_INTRINSICS_READY = Boolean(
  PINNED_URL
  && PINNED_URL_PROTOTYPE
  && PINNED_URL_GET_PROTOCOL
  && PINNED_URL_GET_USERNAME
  && PINNED_URL_GET_PASSWORD
  && PINNED_URL_GET_HOSTNAME
  && PINNED_URL_GET_HOST
  && PINNED_URL_GET_PORT
  && PINNED_URL_GET_PATHNAME
  && PINNED_URL_GET_SEARCH
  && PINNED_URL_GET_HASH
  && PINNED_REFLECT_APPLY
  && PINNED_REFLECT_CONSTRUCT
  && PINNED_IS_PROXY
  && PINNED_UTIL_TYPES
  && PINNED_GET_OWN_PROPERTY_DESCRIPTOR
  && PINNED_GET_PROTOTYPE_OF
  && PINNED_REFLECT_OWN_KEYS
  && PINNED_HAS_OWN,
);

function applyPinnedUrlGetter(url, getter) {
  if (typeof getter !== 'function' || !PINNED_REFLECT_APPLY) return undefined;
  try {
    return PINNED_REFLECT_APPLY.call(Reflect, getter, url, []);
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
    try {
      if (PINNED_REFLECT_APPLY.call(Reflect, PINNED_IS_PROXY, PINNED_UTIL_TYPES, [PINNED_URL]) === true) {
        return null;
      }
    } catch {
      return null;
    }
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      try {
        if (PINNED_REFLECT_APPLY.call(Reflect, PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true) {
          return null;
        }
      } catch {
        return null;
      }
    }
    let url;
    try {
      url = PINNED_REFLECT_CONSTRUCT.call(Reflect, PINNED_URL, [value]);
    } catch {
      return null;
    }
    try {
      if (PINNED_REFLECT_APPLY.call(Reflect, PINNED_IS_PROXY, PINNED_UTIL_TYPES, [url]) === true) {
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

function readPinnedUrlComponents(url) {
  try {
    const protocol = applyPinnedUrlGetter(url, PINNED_URL_GET_PROTOCOL);
    const username = applyPinnedUrlGetter(url, PINNED_URL_GET_USERNAME);
    const password = applyPinnedUrlGetter(url, PINNED_URL_GET_PASSWORD);
    const hostname = applyPinnedUrlGetter(url, PINNED_URL_GET_HOSTNAME);
    const host = applyPinnedUrlGetter(url, PINNED_URL_GET_HOST);
    const port = applyPinnedUrlGetter(url, PINNED_URL_GET_PORT);
    const pathname = applyPinnedUrlGetter(url, PINNED_URL_GET_PATHNAME);
    const search = applyPinnedUrlGetter(url, PINNED_URL_GET_SEARCH);
    const hash = applyPinnedUrlGetter(url, PINNED_URL_GET_HASH);
    if (typeof protocol !== 'string'
        || typeof username !== 'string'
        || typeof password !== 'string'
        || typeof hostname !== 'string'
        || typeof host !== 'string'
        || typeof port !== 'string'
        || typeof pathname !== 'string'
        || typeof search !== 'string'
        || typeof hash !== 'string') {
      return null;
    }
    return Object.freeze({
      protocol, username, password, hostname, host, port, pathname, search, hash,
    });
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
  1, $7, true,
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
   SET cursor_kind = $9,
       envelope_version = $10,
       aead_alg = $11,
       kek_wrap_alg = $12,
       kek_key_name = $13,
       kek_key_version = $14,
       nonce = $15,
       ciphertext = $16,
       auth_tag = $17,
       wrapped_dek = $18,
       cursor_operation_id = $19::uuid,
       phase = $20,
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
   AND provider_tenant_id = $6
   AND provider_mailbox_id = $7
   AND query_version = $8
   AND phase IN ('initial', 'tracking')
 RETURNING client_id, endpoint_id, ingestion_generation, state_version,
           phase, query_version, cursor_kind
`.replace(/\s+/g, ' ').trim();

/* ── page_commit journal SQL (migration 066; same exclusive TX as events/cursor) ── */
const SQL_PAGE_COMMIT_SELECT_FOR_UPDATE = `
SELECT operation_id, client_id, location_id, endpoint_id,
       actor_staff_user_id, actor_kind, worker_id,
       operation_kind, requested_generation, requested_state_version,
       target_operation_id, outcome,
       result_generation, result_state_version, result_phase
  FROM tenant_email_delta_recovery_operations
 WHERE operation_id = $1::uuid
 FOR UPDATE
`.replace(/\s+/g, ' ').trim();

const SQL_PAGE_COMMIT_INSERT_CLAIMED = `
INSERT INTO tenant_email_delta_recovery_operations (
  operation_id, client_id, location_id, endpoint_id,
  actor_staff_user_id, actor_kind, worker_id,
  operation_kind, requested_generation, requested_state_version,
  target_operation_id, outcome
) VALUES (
  $1::uuid, $2::uuid, $3::uuid, $4::uuid,
  NULL, 'worker', $5,
  'page_commit', $6::bigint, $7::bigint,
  NULL, 'claimed'
)
ON CONFLICT (operation_id) DO NOTHING
RETURNING operation_id
`.replace(/\s+/g, ' ').trim();

const SQL_PAGE_COMMIT_COMPLETE_COMMITTED = `
UPDATE tenant_email_delta_recovery_operations
   SET outcome = 'committed',
       result_generation = $2::bigint,
       result_state_version = $3::bigint,
       result_phase = $4,
       updated_at = NOW()
 WHERE operation_id = $1::uuid
   AND outcome = 'claimed'
   AND operation_kind = 'page_commit'
 RETURNING operation_id, operation_kind, outcome,
           result_generation, result_state_version, result_phase
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
  $7::bigint, $8, true,
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

/** Post-crypto lease fence: same token + gen + state_version still unexpired. */
const SQL_REVALIDATE_LEASE = `
SELECT (lease_token IS NOT NULL
        AND lease_token = $3::uuid
        AND lease_until IS NOT NULL
        AND lease_until > clock_timestamp()
        AND ingestion_generation = $4::bigint
        AND state_version = $5::bigint) AS ok
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
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES || !PINNED_REFLECT_APPLY) {
      return true;
    }
    return PINNED_REFLECT_APPLY.call(Reflect, PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function ownData(object, key) {
  try {
    if (!PINNED_GET_OWN_PROPERTY_DESCRIPTOR || !PINNED_HAS_OWN) return undefined;
    const descriptor = PINNED_GET_OWN_PROPERTY_DESCRIPTOR.call(Object, object, key);
    return descriptor
      && PINNED_HAS_OWN.call(descriptor, 'value')
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
    if (!PINNED_GET_PROTOTYPE_OF || !PINNED_REFLECT_OWN_KEYS || !PINNED_GET_OWN_PROPERTY_DESCRIPTOR) {
      return false;
    }
    if (PINNED_GET_PROTOTYPE_OF.call(Object, object) !== PINNED_OBJECT_PROTOTYPE) return false;
    const actual = PINNED_REFLECT_OWN_KEYS.call(Reflect, object);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string'
          || DANGEROUS_KEYS.has(key)
          || !keys.includes(key))) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = PINNED_GET_OWN_PROPERTY_DESCRIPTOR.call(Object, object, key);
      return Boolean(
        descriptor
        && PINNED_HAS_OWN.call(descriptor, 'value')
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

/**
 * Parse positive integer bounded to JS MAX_SAFE_INTEGER (no bigint precision risk).
 * Accepts number or canonical decimal string only.
 */
function parsePositiveSafeInt(raw, field) {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 1 || raw > MAX_SAFE_GENERATION) {
      return fail(`${field}_invalid`);
    }
    return ok(raw);
  }
  if (typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw)) {
    if (raw.length > 16) return fail(`${field}_invalid`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_SAFE_GENERATION) {
      return fail(`${field}_invalid`);
    }
    if (String(n) !== raw) return fail(`${field}_invalid`);
    return ok(n);
  }
  // Explicit bigint only when within safe range (no silent Number truncation).
  if (typeof raw === 'bigint') {
    if (raw < 1n || raw > BigInt(MAX_SAFE_GENERATION)) return fail(`${field}_invalid`);
    return ok(Number(raw));
  }
  return fail(`${field}_invalid`);
}

/**
 * Production query-contract id (not BIGINT, not caller-chosen).
 * Accepts omitted (null/undefined) → DEFAULT_QUERY_VERSION, or the exact
 * constant only. Every other value (shape-valid alternate, trim, case) fails.
 */
function parseQueryVersion(raw) {
  if (raw == null) return ok(DEFAULT_QUERY_VERSION);
  if (typeof raw !== 'string') return fail('query_version_invalid');
  if (raw !== DEFAULT_QUERY_VERSION) return fail('query_version_invalid');
  return ok(DEFAULT_QUERY_VERSION);
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

function hasUnpairedSurrogate(s) {
  try {
    if (typeof s !== 'string') return true;
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        if (i + 1 >= s.length) return true;
        const low = s.charCodeAt(i + 1);
        if (low < 0xDC00 || low > 0xDFFF) return true;
        i += 1;
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Parse messages-delta continuation query on raw + decoded surfaces.
 * Rejects duplicates, encoded-key confusion, empty segments, unpaired surrogates.
 */
function parseDeltaQueryParamsStrict(search) {
  try {
    if (typeof search !== 'string') return { ok: false };
    const raw = search.startsWith('?') ? search.slice(1) : search;
    const params = new Map();
    if (raw.length === 0) return { ok: true, params };
    const parts = raw.split('&');
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part.length < 1) return { ok: false };
      const eq = part.indexOf('=');
      const keyEnc = eq === -1 ? part : part.slice(0, eq);
      const valEnc = eq === -1 ? '' : part.slice(eq + 1);
      if (keyEnc.length < 1) return { ok: false };
      let key;
      let val;
      try {
        key = decodeURIComponent(keyEnc.replace(/\+/g, ' '));
        val = decodeURIComponent(valEnc.replace(/\+/g, ' '));
      } catch {
        return { ok: false };
      }
      if (typeof key !== 'string' || key.length < 1 || hasUnpairedSurrogate(key)) {
        return { ok: false };
      }
      if (typeof val !== 'string' || hasUnpairedSurrogate(val)) {
        return { ok: false };
      }
      // Required token keys must appear as exact raw literals (no %24skiptoken).
      if (key === SKIPTOKEN_KEY || key === DELTATOKEN_KEY) {
        if (keyEnc !== key) return { ok: false };
      } else if (keyEnc !== key) {
        return { ok: false };
      }
      if (params.has(key)) return { ok: false };
      params.set(key, val);
    }
    return { ok: true, params };
  } catch {
    return { ok: false };
  }
}

/**
 * Strict authority-bound Graph messages-delta continuation URL validation.
 *
 * - bounded primitive string only
 * - module-init-pinned node:url construct + prototype getters
 * - https; graph.microsoft.com default/443; no userinfo/hash
 * - exact API version v1.0
 * - exact path /v1.0/users/{canonicalMailboxUuid}/messages/delta
 * - exact continuation query allowlist: one token of the correct form for
 *   cursorKind (nextLink→$skiptoken, deltaLink→$deltatoken)
 * - reject missing/duplicate/mixed tokens, wrong mailbox/path/resource,
 *   $filter/unknown query, token-kind mismatch
 */
function validateMessagesDeltaCursorUrl(cursorUrl, binding) {
  try {
    if (typeof cursorUrl !== 'string'
        || cursorUrl.length < 1
        || cursorUrl.length > MAX_CURSOR_URL_BYTES
        || hasUnpairedSurrogate(cursorUrl)) {
      return fail('cursor_url_invalid');
    }
    if (!PINNED_URL_INTRINSICS_READY) return fail('cursor_url_invalid');
    if (!binding || typeof binding !== 'object') return fail('cursor_url_invalid');
    const mailbox = typeof binding.providerMailboxId === 'string'
      ? binding.providerMailboxId.trim().toLowerCase()
      : '';
    const cursorKind = binding.cursorKind;
    if (!UUID_CANON.test(mailbox) || !CURSOR_KINDS.includes(cursorKind)) {
      return fail('cursor_url_invalid');
    }
    // Reject path-confusion encodings before URL normalization collapses them.
    if (/\.\.|%2e|%2f|%5c|\\/i.test(cursorUrl)) {
      return fail('cursor_url_invalid');
    }
    const u = constructPinnedUrl(cursorUrl);
    if (!u) return fail('cursor_url_invalid');
    const parts = readPinnedUrlComponents(u);
    if (!parts) return fail('cursor_url_invalid');
    if (parts.protocol !== 'https:') return fail('cursor_url_invalid');
    if (parts.hostname !== GRAPH_HOST) return fail('cursor_url_invalid');
    if (parts.host !== GRAPH_HOST && parts.host !== `${GRAPH_HOST}:443`) {
      return fail('cursor_url_invalid');
    }
    if (parts.username || parts.password || parts.hash) return fail('cursor_url_invalid');
    if (parts.port && parts.port !== '443') return fail('cursor_url_invalid');
    const expectedPath = `/${GRAPH_API_VERSION}/users/${mailbox}/messages/delta`;
    if (parts.pathname !== expectedPath) return fail('cursor_url_invalid');
    // Exact path must appear as contiguous substring of the raw URL.
    if (!cursorUrl.includes(expectedPath)) return fail('cursor_url_invalid');
    // Reject /me or other resources.
    if (/\/me(\/|$)/i.test(parts.pathname)) return fail('cursor_url_invalid');

    const parsed = parseDeltaQueryParamsStrict(parts.search);
    if (!parsed.ok) return fail('cursor_url_invalid');
    const params = parsed.params;
    if (params.size !== 1) return fail('cursor_url_invalid');
    const expectedKey = cursorKind === 'nextLink' ? SKIPTOKEN_KEY : DELTATOKEN_KEY;
    const forbiddenKey = cursorKind === 'nextLink' ? DELTATOKEN_KEY : SKIPTOKEN_KEY;
    if (!params.has(expectedKey) || params.has(forbiddenKey)) {
      return fail('cursor_url_invalid');
    }
    // Reject filter / unknown query keys (size===1 + expectedKey already enforces).
    if (params.has('$filter') || params.has('$select') || params.has('$top') || params.has('$orderby')) {
      return fail('cursor_url_invalid');
    }
    const token = params.get(expectedKey);
    if (typeof token !== 'string'
        || token.length < 1
        || token.length > MAX_TOKEN_BYTES
        || hasUnpairedSurrogate(token)) {
      return fail('cursor_url_invalid');
    }
    return ok(cursorUrl);
  } catch {
    return fail('cursor_url_invalid');
  }
}

/**
 * @deprecated name retained for export compatibility; requires mailbox+kind binding.
 * Prefer validateMessagesDeltaCursorUrl.
 */
function validateGraphCursorUrlBoundary(cursorUrl, binding) {
  return validateMessagesDeltaCursorUrl(cursorUrl, binding);
}

/**
 * Canonical AAD for sealed Graph cursor capabilities.
 * Binds ciphertext to trusted state identity + cursor_kind.
 * query_version is the production-exact constant (omitted or ms_messages_delta_v1).
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
  const genParsed = parsePositiveSafeInt(ingestionGeneration, 'ingestion_generation');
  if (!genParsed.ok) throw new Error('aad_generation_invalid');
  const qvParsed = parseQueryVersion(queryVersion);
  if (!qvParsed.ok) throw new Error('aad_query_version_invalid');
  return Buffer.from([
    AAD_VERSION,
    'delta_cursor_aad_v1',
    `client_id=${String(clientId).trim().toLowerCase()}`,
    `endpoint_id=${String(endpointId).trim().toLowerCase()}`,
    `provider=${PROVIDER}`,
    `provider_tenant_id=${String(providerTenantId).trim().toLowerCase()}`,
    `provider_mailbox_id=${String(providerMailboxId).trim().toLowerCase()}`,
    `ingestion_generation=${String(genParsed.value)}`,
    `query_version=${qvParsed.value}`,
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
        || !/^[1-9][0-9]*$/.test(genStr) || qvStr !== DEFAULT_QUERY_VERSION) {
      return fail('aad_invalid');
    }
    const gen = parsePositiveSafeInt(genStr, 'ingestion_generation');
    if (!gen.ok) return fail('aad_invalid');
    const rebuilt = buildDeltaCursorEnvelopeAadV1({
      clientId,
      endpointId,
      provider,
      providerTenantId,
      providerMailboxId,
      ingestionGeneration: gen.value,
      queryVersion: qvStr,
      cursorKind,
    });
    if (!rebuilt.equals(aad)) return fail('aad_invalid');
    return ok(Object.freeze({
      client_id: clientId,
      endpoint_id: endpointId,
      provider,
      provider_tenant_id: providerTenantId,
      provider_mailbox_id: providerMailboxId,
      ingestion_generation: gen.value,
      query_version: qvStr,
      cursor_kind: cursorKind,
    }));
  } catch {
    return fail('aad_invalid');
  }
}

/**
 * Encode sealed-cursor package body. Kind+URL separated by ASCII unit separator.
 * Validates with mailbox+kind (not a generic host check).
 */
function encodeDeltaCursorPackageV1(cursorKind, cursorUrl, providerMailboxId) {
  if (!CURSOR_KINDS.includes(cursorKind)) return fail('cursor_package_invalid');
  if (typeof cursorUrl !== 'string' || cursorUrl.length < 1) return fail('cursor_package_invalid');
  if (cursorUrl.includes('\0') || /[\r\n]/.test(cursorUrl)) return fail('cursor_package_invalid');
  const mailbox = parseUuid(providerMailboxId, 'provider_mailbox_id');
  if (!mailbox.ok) return fail('cursor_package_invalid');
  if (!validateMessagesDeltaCursorUrl(cursorUrl, {
    providerMailboxId: mailbox.value,
    cursorKind,
  }).ok) {
    return fail('cursor_package_invalid');
  }
  const body = `cursor_kind=${cursorKind}\u001fcursor_url=${cursorUrl}`;
  const buf = Buffer.from(`${CURSOR_PKG_PREFIX}${body}\n`, 'utf8');
  if (buf.length > MAX_CURSOR_URL_BYTES + 64) return fail('cursor_package_invalid');
  return ok(buf);
}

function decodeDeltaCursorPackageV1(plaintext, providerMailboxId) {
  if (!Buffer.isBuffer(plaintext) || plaintext.length < 1 || plaintext.length > MAX_CURSOR_URL_BYTES + 64) {
    return fail('cursor_package_invalid');
  }
  const mailbox = parseUuid(providerMailboxId, 'provider_mailbox_id');
  if (!mailbox.ok) return fail('cursor_package_invalid');
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
  if (!validateMessagesDeltaCursorUrl(cursorUrl, {
    providerMailboxId: mailbox.value,
    cursorKind,
  }).ok) {
    return fail('cursor_package_invalid');
  }
  return ok(Object.freeze({ cursor_kind: cursorKind, cursor_url: cursorUrl }));
}

function resolvePgLikeQueryMethod(surface) {
  try {
    if (!surface || (typeof surface !== 'object' && typeof surface !== 'function')) {
      return null;
    }
    if (isProxySurface(surface)) return null;
    if (!PINNED_GET_OWN_PROPERTY_DESCRIPTOR || !PINNED_GET_PROTOTYPE_OF || !PINNED_HAS_OWN) {
      return null;
    }
    const own = PINNED_GET_OWN_PROPERTY_DESCRIPTOR.call(Object, surface, 'query');
    if (own) {
      if (PINNED_HAS_OWN.call(own, 'value')
          && typeof own.value === 'function'
          && !own.get
          && !own.set) {
        return own.value;
      }
      return null;
    }
    let proto = PINNED_GET_PROTOTYPE_OF.call(Object, surface);
    let depth = 0;
    while (proto && proto !== PINNED_OBJECT_PROTOTYPE && depth < 8) {
      if (isProxySurface(proto)) return null;
      const descriptor = PINNED_GET_OWN_PROPERTY_DESCRIPTOR.call(Object, proto, 'query');
      if (descriptor) {
        if (PINNED_HAS_OWN.call(descriptor, 'value')
            && typeof descriptor.value === 'function'
            && !descriptor.get
            && !descriptor.set) {
          return descriptor.value;
        }
        return null;
      }
      proto = PINNED_GET_PROTOTYPE_OF.call(Object, proto);
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
        return PINNED_REFLECT_APPLY.call(Reflect, capturedQuery, trustedReceiver, args);
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
      return PINNED_REFLECT_APPLY.call(Reflect, captured, undefined, [
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

/**
 * Factory-fixed trusted authority-verifier capability.
 * Exact/proxy-safe/snapshotted — caller cannot self-assert authority.
 * Reuses existing authority resolver via injected adapter (no runtime import).
 */
function resolveAuthorityVerifier(raw) {
  try {
    if (raw == null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw) || isProxySurface(raw)) return null;
    if (!exactPlainData(raw, AUTHORITY_VERIFIER_KEYS)
        && !(Object.isFrozen(raw) && exactPlainData(raw, AUTHORITY_VERIFIER_KEYS))) {
      // allow frozen own-data exact keys
      const snap = snapshotOwnDataProps(raw);
      if (!snap.ok) return null;
      const keys = Object.keys(snap.value);
      if (keys.length !== 1 || keys[0] !== 'verifyBinding') return null;
      if (typeof snap.value.verifyBinding !== 'function'
          || isProxySurface(snap.value.verifyBinding)) {
        return null;
      }
      const captured = snap.value.verifyBinding;
      return Object.freeze({
        async verifyBinding(input) {
          return PINNED_REFLECT_APPLY.call(Reflect, captured, undefined, [input]);
        },
      });
    }
    const fn = ownData(raw, 'verifyBinding');
    if (typeof fn !== 'function' || isProxySurface(fn)) return null;
    const captured = fn;
    return Object.freeze({
      async verifyBinding(input) {
        return PINNED_REFLECT_APPLY.call(Reflect, captured, undefined, [input]);
      },
    });
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

function pageCommitInputsMatchRow(row, expected) {
  try {
    if (String(row.client_id).toLowerCase() !== expected.clientId) return false;
    if (String(row.location_id).toLowerCase() !== expected.locationId) return false;
    if (String(row.endpoint_id).toLowerCase() !== expected.endpointId) return false;
    if (String(row.operation_kind) !== 'page_commit') return false;
    if (String(row.actor_kind) !== 'worker') return false;
    if (row.actor_staff_user_id != null) return false;
    if (String(row.worker_id) !== expected.workerId) return false;
    const rg = coerceSafeIntField(row.requested_generation);
    const rsv = coerceSafeIntField(row.requested_state_version);
    if (rg !== expected.requestedGeneration) return false;
    if (rsv !== expected.requestedStateVersion) return false;
    if (row.target_operation_id != null) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Claim-or-replay page_commit journal attribution on an exclusive client.
 * Same operation id + matching actor/endpoint/fences → replay committed result.
 * Mismatch → operation_id_conflict. Stuck claimed → conflict.
 */
async function claimOrReplayPageCommit(exclusive, expected) {
  const existing = await exclusive.query(SQL_PAGE_COMMIT_SELECT_FOR_UPDATE, [
    expected.operationId,
  ]);
  if (existing.rows && existing.rows.length === 1) {
    const row = existing.rows[0];
    if (!pageCommitInputsMatchRow(row, expected)) {
      return fail('operation_id_conflict');
    }
    if (String(row.outcome) === 'claimed') {
      return fail('operation_id_conflict');
    }
    return ok(Object.freeze({ kind: 'replay', row }));
  }

  const ins = await exclusive.query(SQL_PAGE_COMMIT_INSERT_CLAIMED, [
    expected.operationId,
    expected.clientId,
    expected.locationId,
    expected.endpointId,
    expected.workerId,
    String(expected.requestedGeneration),
    String(expected.requestedStateVersion),
  ]);
  if (ins.rows && ins.rows.length === 1) {
    return ok(Object.freeze({ kind: 'claimed' }));
  }

  const raced = await exclusive.query(SQL_PAGE_COMMIT_SELECT_FOR_UPDATE, [
    expected.operationId,
  ]);
  if (!raced.rows || raced.rows.length !== 1) {
    return fail('inbound_delta_state_write_failed');
  }
  const row = raced.rows[0];
  if (!pageCommitInputsMatchRow(row, expected)) {
    return fail('operation_id_conflict');
  }
  if (String(row.outcome) === 'claimed') {
    return fail('operation_id_conflict');
  }
  return ok(Object.freeze({ kind: 'replay', row }));
}

async function verifyAuthorityBinding(authorityVerifier, binding) {
  let verified;
  try {
    verified = await authorityVerifier.verifyBinding(binding);
  } catch {
    return fail('authority_not_verified');
  }
  if (!verified || verified.ok !== true) return fail('authority_not_verified');
  if (verified.value && typeof verified.value === 'object') {
    const v = verified.value;
    if (String(v.clientId || '').toLowerCase() !== binding.clientId
        || String(v.locationId || '').toLowerCase() !== binding.locationId
        || String(v.endpointId || '').toLowerCase() !== binding.endpointId
        || String(v.providerTenantId || '').toLowerCase() !== binding.providerTenantId
        || String(v.providerMailboxId || '').toLowerCase() !== binding.providerMailboxId) {
      return fail('authority_not_verified');
    }
  }
  return ok(true);
}

function pageCommitReplayResult(row, preparedCount, tombCount, cursorKind, queryVersion, ids) {
  const gen = coerceSafeIntField(row.result_generation);
  const sv = coerceSafeIntField(row.result_state_version);
  if (gen == null || sv == null || row.result_phase == null) {
    return fail('inbound_delta_state_write_failed');
  }
  return ok(Object.freeze({
    client_id: ids.clientId,
    endpoint_id: ids.endpointId,
    ingestion_generation: gen,
    state_version: sv,
    phase: String(row.result_phase),
    query_version: queryVersion,
    cursor_kind: cursorKind,
    envelopes_presented: preparedCount,
    tombstones_presented: tombCount,
  }));
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
      out.expectedGeneration = parsePositiveSafeInt(
        snap.value.expectedGeneration, 'ingestion_generation',
      );
      if (!out.expectedGeneration.ok) return out.expectedGeneration;
    } else if (f === 'expectedStateVersion') {
      out.expectedStateVersion = parsePositiveSafeInt(
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
    if (PINNED_GET_PROTOTYPE_OF.call(Object, value) !== PINNED_ARRAY_PROTOTYPE) return null;
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

function coerceSafeIntField(raw) {
  const p = parsePositiveSafeInt(
    typeof raw === 'bigint' ? raw : (typeof raw === 'number' ? raw : String(raw)),
    'field',
  );
  return p.ok ? p.value : null;
}

function toPrivateLeaseHandle(row) {
  const gen = coerceSafeIntField(row.ingestion_generation);
  const sv = coerceSafeIntField(row.state_version);
  if (gen == null || sv == null) {
    throw failure();
  }
  return Object.freeze({
    client_id: String(row.client_id),
    endpoint_id: String(row.endpoint_id),
    ingestion_generation: gen,
    state_version: sv,
    lease_token: String(row.lease_token),
    lease_until: row.lease_until,
    phase: row.phase,
    query_version: String(row.query_version),
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
  const gen = coerceSafeIntField(row.ingestion_generation);
  const sv = coerceSafeIntField(row.state_version);
  return Object.freeze({
    state_present: true,
    phase: row.phase,
    ingestion_generation: gen,
    query_version: row.query_version == null ? null : String(row.query_version),
    state_version: sv,
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
 * Strict authority-bound URL validation at this boundary with mailbox+kind.
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
    const gen = parsePositiveSafeInt(s.ingestionGeneration, 'ingestion_generation');
    if (!gen.ok) return gen;
    const qv = parseQueryVersion(s.queryVersion);
    if (!qv.ok) return qv;
    const kind = parseCursorKind(s.cursorKind);
    if (!kind.ok) return kind;
    const urlCheck = validateMessagesDeltaCursorUrl(s.cursorUrl, {
      providerMailboxId: providerMailboxId.value,
      cursorKind: kind.value,
    });
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
    const pkg = encodeDeltaCursorPackageV1(kind.value, urlCheck.value, providerMailboxId.value);
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
 * Open sealed cursor under AAD identity (OUTSIDE short DB txn).
 * Wrong AAD (client/endpoint/tenant/mailbox/generation/query_version/cursor_kind)
 * fails closed. URL revalidated with mailbox+kind.
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
    const gen = parsePositiveSafeInt(s.ingestionGeneration, 'ingestion_generation');
    if (!gen.ok) return gen;
    const qv = parseQueryVersion(s.queryVersion);
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
    const decoded = decodeDeltaCursorPackageV1(raw, providerMailboxId.value);
    zeroizeBuffer(raw);
    if (!decoded.ok) return fail('cursor_open_failed');
    if (decoded.value.cursor_kind !== kind.value) return fail('cursor_open_failed');
    const urlCheck = validateMessagesDeltaCursorUrl(decoded.value.cursor_url, {
      providerMailboxId: providerMailboxId.value,
      cursorKind: kind.value,
    });
    if (!urlCheck.ok) return fail('cursor_open_failed');
    return ok(Object.freeze({
      cursor_kind: kind.value,
      cursor_url: urlCheck.value,
    }));
  } catch {
    return fail('cursor_open_failed');
  }
}

/**
 * Module-private demote-current + insert generation+1 on an exclusive client.
 * Not exported. No authority check — only callable from the factory-bound
 * authority-bearing path after factory-fixed authorityVerifier succeeds.
 *
 * - No BEGIN / COMMIT / ROLLBACK
 * - No pool checkout / release
 * - Preserves old generation; no cursor copy onto the new generation
 *
 * @param {{query: Function}} exclusive exclusive loan client (already resolved)
 * @param {object} params exact canonical UUID / safe-int fence fields
 * @returns {Promise<{ok:true,value:object}|{ok:false,error:string}>}
 */
async function demoteAndInsertNextGenerationOnExclusiveClient(exclusive, params) {
  try {
    const demoted = await exclusive.query(SQL_DEMOTE_CURRENT, [
      params.clientId,
      params.endpointId,
      String(params.expectedGeneration),
      String(params.expectedStateVersion),
    ]);
    if (!demoted.rows || demoted.rows.length !== 1) return fail('generation_cas_conflict');
    const prevGen = coerceSafeIntField(demoted.rows[0].ingestion_generation);
    if (prevGen == null || prevGen >= MAX_SAFE_GENERATION) {
      return fail('ingestion_generation_invalid');
    }
    const nextGen = prevGen + 1;
    const ins = await exclusive.query(SQL_INSERT_NEXT_GENERATION, [
      params.clientId,
      params.locationId,
      params.endpointId,
      PROVIDER,
      params.providerTenantId,
      params.providerMailboxId,
      String(nextGen),
      params.queryVersion,
    ]);
    if (!ins.rows || ins.rows.length !== 1) return fail('inbound_delta_state_write_failed');
    const row = ins.rows[0];
    const gen = coerceSafeIntField(row.ingestion_generation);
    const sv = coerceSafeIntField(row.state_version);
    if (gen == null || sv == null) return fail('inbound_delta_state_write_failed');
    return ok(Object.freeze({
      client_id: String(row.client_id),
      endpoint_id: String(row.endpoint_id),
      ingestion_generation: gen,
      query_version: String(row.query_version),
      phase: row.phase,
      state_version: sv,
      previous_generation: prevGen,
    }));
  } catch {
    return fail('inbound_delta_state_write_failed');
  }
}

function createInboundEmailDeltaStateStore(deps) {
  let withTransactionClient;
  let envelopeProvider = null;
  let authorityVerifier = null;
  try {
    if (deps == null || typeof deps !== 'object' || Array.isArray(deps)) throw failure();
    if (isProxySurface(deps)) throw failure();
    const snap = snapshotOwnDataProps(deps);
    if (!snap.ok) throw failure();
    const keySet = new Set(Object.keys(snap.value));
    if (!keySet.has('withTransactionClient')) throw failure();
    for (const k of keySet) {
      if (k !== 'withTransactionClient'
          && k !== 'envelopeProvider'
          && k !== 'authorityVerifier') {
        throw failure();
      }
    }
    withTransactionClient = resolveWithTransactionClient(snap.value.withTransactionClient);
    if (!withTransactionClient) throw failure();
    if (keySet.has('envelopeProvider')) {
      if (isProxySurface(snap.value.envelopeProvider)) throw failure();
      const vp = validateEmailGrantEnvelopeProvider(snap.value.envelopeProvider);
      if (!vp.ok) throw failure();
      envelopeProvider = vp.value;
    }
    if (keySet.has('authorityVerifier')) {
      authorityVerifier = resolveAuthorityVerifier(snap.value.authorityVerifier);
      if (!authorityVerifier) throw failure();
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
    const qv = parseQueryVersion(
      ids.snap.queryVersion == null ? DEFAULT_QUERY_VERSION : ids.snap.queryVersion,
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
        qv.value,
      ]);
      if (!ins.rows || ins.rows.length !== 1) return fail('inbound_delta_state_write_failed');
      const row = ins.rows[0];
      const gen = coerceSafeIntField(row.ingestion_generation);
      const sv = coerceSafeIntField(row.state_version);
      if (gen == null || sv == null) return fail('inbound_delta_state_write_failed');
      return ok(Object.freeze({
        client_id: String(row.client_id),
        endpoint_id: String(row.endpoint_id),
        ingestion_generation: gen,
        query_version: String(row.query_version),
        phase: row.phase,
        state_version: sv,
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
    const gen = parsePositiveSafeInt(ids.snap.expectedGeneration, 'ingestion_generation');
    if (!gen.ok) return gen;
    const sv = parsePositiveSafeInt(ids.snap.expectedStateVersion, 'state_version');
    if (!sv.ok) return sv;
    const leaseToken = crypto.randomUUID();

    return runExclusive(async (client) => withTxn(client, async () => {
      const locked = await client.query(SQL_LOCK_CURRENT, [
        ids.clientId.value, ids.endpointId.value,
      ]);
      if (!locked.rows || locked.rows.length !== 1) return fail('delta_state_not_found');
      const row = locked.rows[0];
      const rowGen = coerceSafeIntField(row.ingestion_generation);
      const rowSv = coerceSafeIntField(row.state_version);
      if (rowGen == null || rowSv == null) return fail('inbound_delta_state_write_failed');
      if (rowGen !== gen.value) return fail('generation_mismatch');
      if (rowSv !== sv.value) return fail('state_version_mismatch');
      if (row.phase === 'reset_required') return fail('reset_required');
      const upd = await client.query(SQL_CAS_LEASE_ACQUIRE, [
        ids.clientId.value,
        ids.endpointId.value,
        workerId.value,
        leaseToken,
        String(ttl.value),
        String(gen.value),
        String(sv.value),
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
        String(ids.expectedGeneration.value),
        String(ids.expectedStateVersion.value),
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
        String(ids.expectedGeneration.value),
        String(ids.expectedStateVersion.value),
        ids.leaseToken.value,
      ]);
      if (!upd.rows || upd.rows.length !== 1) return fail('lease_fenced');
      const gen = coerceSafeIntField(upd.rows[0].ingestion_generation);
      const sv = coerceSafeIntField(upd.rows[0].state_version);
      if (gen == null || sv == null) return fail('inbound_delta_state_write_failed');
      return ok(Object.freeze({
        client_id: String(upd.rows[0].client_id),
        endpoint_id: String(upd.rows[0].endpoint_id),
        ingestion_generation: gen,
        state_version: sv,
        phase: upd.rows[0].phase,
      }));
    }));
  }

  /**
   * Open cursor under a valid unexpired lease.
   * 1) First TX: lease/CAS state read (copy sealed material).
   * 2) Crypto open OUTSIDE TX.
   * 3) Second TX: revalidate lease token + DB-clock expiry + generation +
   *    state_version immediately before releasing plaintext.
   * Stale/expired/reacquired lease → no cursor.
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
      const rowGen = coerceSafeIntField(row.ingestion_generation);
      const rowSv = coerceSafeIntField(row.state_version);
      if (rowGen == null || rowSv == null) return fail('inbound_delta_state_write_failed');
      if (rowGen !== ids.expectedGeneration.value) return fail('generation_mismatch');
      if (rowSv !== ids.expectedStateVersion.value) return fail('state_version_mismatch');
      if (String(row.lease_token) !== ids.leaseToken.value) return fail('lease_fenced');
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
        }));
      }
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
        query_version: String(row.query_version),
        ingestion_generation: rowGen,
        state_version: rowSv,
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
        cursor_url: null,
      }));
    }

    // Crypto OUTSIDE any transaction.
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

    // Second DB-clock lease fence immediately before releasing plaintext.
    const revalidated = await runExclusive(async (client) => withTxn(client, async () => {
      const r = await client.query(SQL_REVALIDATE_LEASE, [
        ids.clientId.value,
        ids.endpointId.value,
        ids.leaseToken.value,
        String(ids.expectedGeneration.value),
        String(ids.expectedStateVersion.value),
      ]);
      if (!r.rows || r.rows.length !== 1 || r.rows[0].ok !== true) {
        return fail('lease_fenced');
      }
      return ok(true);
    }));
    if (!revalidated.ok) {
      // Scrub plaintext; never release cursor after stale/expired/reacquired lease.
      return fail(revalidated.error === 'lease_fenced' ? 'lease_fenced' : revalidated.error);
    }

    return ok(Object.freeze({
      cursor_present: true,
      phase: loaded.value.phase,
      cursor_kind: opened.value.cursor_kind,
      cursor_url: opened.value.cursor_url,
    }));
  }

  /**
   * ONLY page-commit owner.
   * BEFORE TX: cryptographically open + validate successor against exact AAD
   * (client+endpoint+provider tenant+mailbox+ingestion generation+query version+
   * cursor kind) and strict messages-delta URL; scrub plaintext. Authority
   * precheck. Page operation id = successor envelope.operation_id (internal).
   * THEN one exclusive-client TX (no crypto/network inside):
   *   authority re-verify → claim/validate page_commit journal → event inserts
   *   → cursor CAS (same operation id) → complete committed journal → COMMIT.
   * Same operation id exact retry replays persisted committed result (zero
   * event/state mutation). COMMIT dispatch ambiguity →
   * inbound_delta_state_commit_outcome_unknown. Hostile sealed successors →
   * zero inserts / zero cursor advance / zero journal.
   * Public result never includes operation_id.
   */
  async function commitPageEvents(input) {
    if (!envelopeProvider) return fail('envelope_provider_required');
    if (!authorityVerifier) return fail('authority_verifier_required');
    const ids = snapshotIds(input, [
      'clientId', 'locationId', 'endpointId', 'leaseToken',
      'expectedGeneration', 'expectedStateVersion',
    ]);
    if (ids.ok === false) return ids;
    const tenant = parseUuid(ids.snap.providerTenantId, 'provider_tenant_id');
    if (!tenant.ok) return tenant;
    const mailbox = parseUuid(ids.snap.providerMailboxId, 'provider_mailbox_id');
    if (!mailbox.ok) return mailbox;
    const qv = parseQueryVersion(ids.snap.queryVersion);
    if (!qv.ok) return qv;

    if (Object.prototype.hasOwnProperty.call(ids.snap, 'verifiedAuthority')) {
      return fail('authority_not_verified');
    }

    const prepared = prepareCanonicalBatch(ids.snap.envelopes, mailbox.value);
    if (!prepared.ok) return fail('page_batch_invalid');
    const tombs = prepareTombstones(
      ids.snap.tombstones == null ? [] : ids.snap.tombstones,
      mailbox.value,
    );
    if (!tombs.ok) return fail('page_tombstones_invalid');
    const successor = validateSealedSuccessor(ids.snap.successorCursor);
    if (!successor.ok) return successor;

    // Page operation id from sealed successor (generated before seal; internal).
    const operationId = parseUuid(
      successor.value.envelope.operation_id, 'operation_id',
    );
    if (!operationId.ok) return fail('operation_id_invalid');

    // Cryptographic open + strict URL validate BEFORE any durable write TX.
    const opened = await openSealedDeltaCursor(envelopeProvider, Object.freeze({
      clientId: ids.clientId.value,
      endpointId: ids.endpointId.value,
      providerTenantId: tenant.value,
      providerMailboxId: mailbox.value,
      ingestionGeneration: ids.expectedGeneration.value,
      queryVersion: qv.value,
      cursorKind: successor.value.cursor_kind,
      envelope: successor.value.envelope,
    }));
    if (!opened.ok) {
      // Zero inserts / zero cursor advance — never enter TX with hostile seal.
      return fail('successor_cursor_rejected');
    }
    // Plaintext was validated then discarded — TX installs sealed envelope only.
    // (cursor_url from open is intentionally not retained past this point.)

    const binding = Object.freeze({
      clientId: ids.clientId.value,
      locationId: ids.locationId.value,
      endpointId: ids.endpointId.value,
      providerTenantId: tenant.value,
      providerMailboxId: mailbox.value,
    });
    const authPre = await verifyAuthorityBinding(authorityVerifier, binding);
    if (!authPre.ok) return authPre;

    const journalExpected = Object.freeze({
      operationId: operationId.value,
      clientId: ids.clientId.value,
      locationId: ids.locationId.value,
      endpointId: ids.endpointId.value,
      workerId: PAGE_COMMIT_WORKER_ID,
      requestedGeneration: ids.expectedGeneration.value,
      requestedStateVersion: ids.expectedStateVersion.value,
    });

    return runExclusive(async (client) => withTxn(client, async () => {
      // Authority re-verify at mutation boundary (fail closed → full ROLLBACK).
      const authTx = await verifyAuthorityBinding(authorityVerifier, binding);
      if (!authTx.ok) return fail('authority_not_verified');

      // Claim / validate page_commit journal attribution (same exclusive client).
      const claim = await claimOrReplayPageCommit(client, journalExpected);
      if (!claim.ok) return claim;
      if (claim.value.kind === 'replay') {
        // Exact same-ID retry: return persisted committed fences; zero mutation.
        if (String(claim.value.row.outcome) !== 'committed') {
          return fail('operation_id_conflict');
        }
        return pageCommitReplayResult(
          claim.value.row,
          prepared.envelopes.length,
          tombs.tombstones.length,
          successor.value.cursor_kind,
          qv.value,
          Object.freeze({
            clientId: ids.clientId.value,
            endpointId: ids.endpointId.value,
          }),
        );
      }

      const locked = await client.query(SQL_LOCK_CURRENT, [
        ids.clientId.value, ids.endpointId.value,
      ]);
      if (!locked.rows || locked.rows.length !== 1) return fail('delta_state_not_found');
      const row = locked.rows[0];
      if (String(row.client_id).toLowerCase() !== ids.clientId.value) {
        return fail('authority_mismatch');
      }
      if (String(row.endpoint_id).toLowerCase() !== ids.endpointId.value) {
        return fail('authority_mismatch');
      }
      if (String(row.location_id).toLowerCase() !== ids.locationId.value) {
        return fail('authority_mismatch');
      }
      const rowGen = coerceSafeIntField(row.ingestion_generation);
      const rowSv = coerceSafeIntField(row.state_version);
      if (rowGen == null || rowSv == null) return fail('inbound_delta_state_write_failed');
      if (rowGen !== ids.expectedGeneration.value) return fail('generation_mismatch');
      if (rowSv !== ids.expectedStateVersion.value) return fail('state_version_mismatch');
      if (String(row.lease_token) !== ids.leaseToken.value) return fail('lease_fenced');
      if (String(row.provider_tenant_id).toLowerCase() !== tenant.value) {
        return fail('tenant_mismatch');
      }
      if (String(row.provider_mailbox_id).toLowerCase() !== mailbox.value) {
        return fail('mailbox_mismatch');
      }
      if (String(row.query_version) !== qv.value) return fail('query_version_mismatch');
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

      // nextLink during bootstrap stays initial; deltaLink always tracking.
      const finalPhase = successor.value.cursor_kind === 'deltaLink'
        ? 'tracking'
        : (row.phase === 'tracking' ? 'tracking' : 'initial');

      const env = successor.value.envelope;
      // Cursor CAS uses the same page operation id (envelope.operation_id).
      if (String(env.operation_id).toLowerCase() !== operationId.value) {
        return fail('operation_id_invalid');
      }
      const cols = envelopeColumnsFromRecord(env);
      const upd = await client.query(SQL_CAS_COMMIT_CURSOR, [
        ids.clientId.value,
        ids.endpointId.value,
        String(ids.expectedGeneration.value),
        String(ids.expectedStateVersion.value),
        ids.leaseToken.value,
        tenant.value,
        mailbox.value,
        qv.value,
        successor.value.cursor_kind,
        cols[0], cols[1], cols[2], cols[3], cols[4],
        cols[5], cols[6], cols[7], cols[8], cols[9],
        finalPhase,
      ]);
      if (!upd.rows || upd.rows.length !== 1) {
        return fail('commit_cas_conflict');
      }
      const outGen = coerceSafeIntField(upd.rows[0].ingestion_generation);
      const outSv = coerceSafeIntField(upd.rows[0].state_version);
      if (outGen == null || outSv == null) return fail('inbound_delta_state_write_failed');

      // Complete page_commit journal committed (same operation id / TX).
      const done = await client.query(SQL_PAGE_COMMIT_COMPLETE_COMMITTED, [
        operationId.value,
        String(outGen),
        String(outSv),
        upd.rows[0].phase,
      ]);
      if (!done.rows || done.rows.length !== 1) {
        return fail('inbound_delta_state_write_failed');
      }

      // Public result: never includes operation_id / worker / journal fields.
      return ok(Object.freeze({
        client_id: String(upd.rows[0].client_id),
        endpoint_id: String(upd.rows[0].endpoint_id),
        ingestion_generation: outGen,
        state_version: outSv,
        phase: upd.rows[0].phase,
        query_version: String(upd.rows[0].query_version),
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
        String(ids.expectedGeneration.value),
        String(ids.expectedStateVersion.value),
        reason.value,
      ]);
      if (!upd.rows || upd.rows.length !== 1) return fail('reset_cas_conflict');
      const gen = coerceSafeIntField(upd.rows[0].ingestion_generation);
      const sv = coerceSafeIntField(upd.rows[0].state_version);
      if (gen == null || sv == null) return fail('inbound_delta_state_write_failed');
      return ok(Object.freeze({
        client_id: String(upd.rows[0].client_id),
        endpoint_id: String(upd.rows[0].endpoint_id),
        ingestion_generation: gen,
        state_version: sv,
        phase: upd.rows[0].phase,
        reset_reason: upd.rows[0].reset_reason,
      }));
    }));
  }

  /**
   * Shared authority-bound generation advance on an already-loaned exclusive
   * client. Factory-fixed authorityVerifier is invoked/reverified BEFORE any
   * state SQL (including forged direct calls). No BEGIN/COMMIT/release.
   * Private demote/insert runs only after authority succeeds.
   *
   * Exact own-data input:
   *   exclusiveClient, clientId, locationId, endpointId,
   *   expectedGeneration, expectedStateVersion,
   *   providerTenantId, providerMailboxId, queryVersion?
   * Rejects caller verifiedAuthority boolean. No generic client-only helper.
   */
  async function advanceGenerationOnExclusiveClient(input) {
    if (!authorityVerifier) return fail('authority_verifier_required');
    if (input == null || typeof input !== 'object' || Array.isArray(input)) {
      return fail('input_invalid');
    }
    if (isProxySurface(input)) return fail('input_invalid');
    const snap = snapshotOwnDataProps(input);
    if (!snap.ok) return fail('input_invalid');

    // Reject any caller self-assert boolean — verifier capability is authority.
    if (Object.prototype.hasOwnProperty.call(snap.value, 'verifiedAuthority')) {
      return fail('authority_not_verified');
    }

    const exclusive = resolveExclusiveClient(snap.value.exclusiveClient);
    if (!exclusive) return fail('inbound_delta_state_write_failed');

    const clientId = parseUuid(snap.value.clientId, 'client_id');
    if (!clientId.ok) return clientId;
    const locationId = parseUuid(snap.value.locationId, 'location_id');
    if (!locationId.ok) return locationId;
    const endpointId = parseUuid(snap.value.endpointId, 'endpoint_id');
    if (!endpointId.ok) return endpointId;
    const tenant = parseUuid(snap.value.providerTenantId, 'provider_tenant_id');
    if (!tenant.ok) return tenant;
    const mailbox = parseUuid(snap.value.providerMailboxId, 'provider_mailbox_id');
    if (!mailbox.ok) return mailbox;
    const expectedGeneration = parsePositiveSafeInt(
      snap.value.expectedGeneration, 'ingestion_generation',
    );
    if (!expectedGeneration.ok) return expectedGeneration;
    const expectedStateVersion = parsePositiveSafeInt(
      snap.value.expectedStateVersion, 'state_version',
    );
    if (!expectedStateVersion.ok) return expectedStateVersion;
    const qv = parseQueryVersion(
      snap.value.queryVersion == null ? DEFAULT_QUERY_VERSION : snap.value.queryVersion,
    );
    if (!qv.ok) return qv;

    const binding = Object.freeze({
      clientId: clientId.value,
      locationId: locationId.value,
      endpointId: endpointId.value,
      providerTenantId: tenant.value,
      providerMailboxId: mailbox.value,
    });
    let verified;
    try {
      verified = await authorityVerifier.verifyBinding(binding);
    } catch {
      return fail('authority_not_verified');
    }
    if (!verified || verified.ok !== true) return fail('authority_not_verified');
    // Optional exact re-bind check if verifier returns a value DTO.
    if (verified.value && typeof verified.value === 'object') {
      const v = verified.value;
      if (String(v.clientId || '').toLowerCase() !== binding.clientId
          || String(v.locationId || '').toLowerCase() !== binding.locationId
          || String(v.endpointId || '').toLowerCase() !== binding.endpointId
          || String(v.providerTenantId || '').toLowerCase() !== binding.providerTenantId
          || String(v.providerMailboxId || '').toLowerCase() !== binding.providerMailboxId) {
        return fail('authority_not_verified');
      }
    }

    // Authority succeeded — only now touch state SQL on the exclusive client.
    return demoteAndInsertNextGenerationOnExclusiveClient(exclusive, Object.freeze({
      clientId: clientId.value,
      locationId: locationId.value,
      endpointId: endpointId.value,
      expectedGeneration: expectedGeneration.value,
      expectedStateVersion: expectedStateVersion.value,
      providerTenantId: tenant.value,
      providerMailboxId: mailbox.value,
      queryVersion: qv.value,
    }));
  }

  /**
   * Explicit reset/rebind: demote current generation, insert generation+1 as current.
   * Preserves old state/events. Calls the same factory-bound exclusive-client path
   * (authorityVerifier re-verify before any state SQL) inside exclusive withTxn.
   * Caller boolean self-assert is not accepted. Grant refresh must not call this.
   * Maintains one-current invariant (demote then insert; never zero current).
   */
  async function beginNextGeneration(input) {
    if (!authorityVerifier) return fail('authority_verifier_required');
    if (input == null || typeof input !== 'object' || Array.isArray(input)) {
      return fail('input_invalid');
    }
    if (isProxySurface(input)) return fail('input_invalid');
    const snap = snapshotOwnDataProps(input);
    if (!snap.ok) return fail('input_invalid');

    // Reject any caller self-assert boolean before opening a TX.
    if (Object.prototype.hasOwnProperty.call(snap.value, 'verifiedAuthority')) {
      return fail('authority_not_verified');
    }
    // beginNextGeneration owns TX/checkout; reject smuggled exclusive client.
    if (Object.prototype.hasOwnProperty.call(snap.value, 'exclusiveClient')) {
      return fail('input_invalid');
    }

    const ids = snapshotIds(input, [
      'clientId', 'locationId', 'endpointId',
      'expectedGeneration', 'expectedStateVersion',
    ]);
    if (ids.ok === false) return ids;
    const tenant = parseUuid(ids.snap.providerTenantId, 'provider_tenant_id');
    if (!tenant.ok) return tenant;
    const mailbox = parseUuid(ids.snap.providerMailboxId, 'provider_mailbox_id');
    if (!mailbox.ok) return mailbox;
    const qv = parseQueryVersion(ids.snap.queryVersion);
    if (!qv.ok) return qv;

    return runExclusive(async (client) => withTxn(client, async () => (
      advanceGenerationOnExclusiveClient(Object.freeze({
        exclusiveClient: client,
        clientId: ids.clientId.value,
        locationId: ids.locationId.value,
        endpointId: ids.endpointId.value,
        expectedGeneration: ids.expectedGeneration.value,
        expectedStateVersion: ids.expectedStateVersion.value,
        providerTenantId: tenant.value,
        providerMailboxId: mailbox.value,
        queryVersion: qv.value,
      }))
    )));
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
    /**
     * Authority-bearing exclusive-client generation advance (no BEGIN/COMMIT).
     * Factory-fixed authorityVerifier re-verified before any state SQL.
     */
    advanceGenerationOnExclusiveClient,
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
  GRAPH_HOST,
  GRAPH_API_VERSION,
  DEFAULT_QUERY_VERSION,
  MAX_SAFE_GENERATION,
  PAGE_COMMIT_WORKER_ID,
  PUBLIC_STATUS_KEYS,
  STORE_DEPENDENCY_KEYS,
  STORE_WITH_PROVIDER_KEYS,
  AUTHORITY_VERIFIER_KEYS,
  ENVELOPE_RECORD_KEYS,
  SQL_INSERT_EVENT,
  SQL_LOCK_CURRENT,
  SQL_PUBLIC_STATUS,
  SQL_REVALIDATE_LEASE,
  buildDeltaCursorEnvelopeAadV1,
  parseDeltaCursorEnvelopeAadV1,
  encodeDeltaCursorPackageV1,
  decodeDeltaCursorPackageV1,
  validateMessagesDeltaCursorUrl,
  validateGraphCursorUrlBoundary,
  sealDeltaCursorCompatible,
  openSealedDeltaCursor,
  createInboundEmailDeltaStateStore,
  // Raw demote/insert primitive is module-private only — never exported.
  // Exclusive-client generation advance is only on the factory store object
  // (authorityVerifier re-verify before any state SQL).
  SQL_DEMOTE_CURRENT,
  SQL_INSERT_NEXT_GENERATION,
  // test helpers
  resolveWithTransactionClient,
  resolveExclusiveClient,
  resolveAuthorityVerifier,
  prepareCanonicalBatch,
  prepareTombstones,
  validateSealedSuccessor,
  parseQueryVersion,
  parsePositiveSafeInt,
});
