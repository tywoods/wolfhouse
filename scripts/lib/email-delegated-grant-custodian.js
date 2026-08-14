'use strict';

/**
 * Slice 2F-A: durable delegated refresh-grant custodian repository.
 * Dedicated tenant_email_delegated_grants; pinned {client} writes; short TX only
 * (no TX across I/O — seal/open and MS exchange stay OUTSIDE transactions).
 * Lease TTL via SQL clock_timestamp(). Public DTOs omit secrets/envelope/lease tokens.
 * openDelegatedGrantUnderLease re-reads under short pinned TX then opens AFTER COMMIT.
 * withTxn: pre-COMMIT → ROLLBACK; COMMIT sent then reject → commit_outcome_unknown.
 *
 * Unwired delegated read-authority resolve (repository only): one SELECT join of
 * tenant_locations + tenant_channel_endpoints + tenant_email_delegated_grants for
 * exact client/location/endpoint with verified Microsoft delegated own-user binding.
 * Returns a frozen internal DTO (providerMailboxId from endpoint.provider_resource_id).
 * Not wired into public status, read-health, routes, transport, or runtime composition.
 *
 * @module email-delegated-grant-custodian
 */

const crypto = require('crypto');
const util = require('util');
const {
  validateGrantEnvelopeRecordV1,
  validateEmailGrantEnvelopeProvider,
  buildGrantEnvelopeAadV1,
  snapshotOwnDataProps,
} = require('./email-grant-envelope-provider-contract');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Canonical lowercase hyphenated UUID (migration 058 provider_*_shape). */
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL_REAUTH_REASONS = Object.freeze([
  'invalid_grant', 'revocation', 'policy', 'consent_loss',
]);
const RECONCILE_STATES = Object.freeze([
  'clean', 'ms_response_uncertain', 'rewrap_pending', 'needs_operator',
]);
const RECONCILE_DETAIL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MIN_TTL = 5;
const MAX_TTL = 3600;
const DEFAULT_TTL = 60;

/**
 * Unwired internal read-authority resolve. Not public status / read-health /
 * routes / transport / runtime composition.
 */
const EMAIL_DELEGATED_READ_AUTHORITY_RUNTIME_WIRED = false;

// Module-init pins for delegated read-authority hostile surfaces.
// Ambient util.types.isProxy monkeypatches after load must not weaken detection.
const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;
/** Expected intrinsic Array.prototype for driver rows arrays (this realm at init). */
const PINNED_ARRAY_PROTOTYPE = Array.prototype;

/** Exact ordered own-data input keys for resolveDelegatedReadAuthority. */
const DELEGATED_READ_AUTHORITY_INPUT_KEYS = Object.freeze([
  'clientId',
  'locationId',
  'endpointId',
]);

/**
 * Frozen internal DTO keys only. Never public_address or provider_principal_oid.
 * providerMailboxId is always endpoint.provider_resource_id (resource id wins).
 * Public resolve deliberately omits providerTenantId (local-only binding field).
 */
const DELEGATED_READ_AUTHORITY_DTO_KEYS = Object.freeze([
  'clientId',
  'locationId',
  'endpointId',
  'provider',
  'providerMailboxId',
  'bindingStatus',
]);

/**
 * Local-only binding DTO keys (includes private provider_tenant_id row field).
 * Used by createDelegatedReadAuthorityBindingVerifier and delta composition —
 * never public status / routes / read-health.
 */
const DELEGATED_READ_AUTHORITY_BINDING_DTO_KEYS = Object.freeze([
  'clientId',
  'locationId',
  'endpointId',
  'provider',
  'providerMailboxId',
  'providerTenantId',
  'bindingStatus',
]);

/** Exact ordered verifyBinding input keys (PR408 authorityVerifier contract). */
const DELEGATED_READ_AUTHORITY_BINDING_VERIFY_KEYS = Object.freeze([
  'clientId',
  'locationId',
  'endpointId',
  'providerTenantId',
  'providerMailboxId',
]);

/** Driver-row own-data key set (SQL textual order). */
const DELEGATED_READ_AUTHORITY_ROW_KEYS = Object.freeze([
  'client_id',
  'location_id',
  'endpoint_id',
  'provider',
  'channel',
  'auth_mode',
  'connector_mode',
  'binding_status',
  'provider_tenant_id',
  'provider_resource_id',
  'provider_principal_oid',
  'mailbox_kind',
  'mailbox_access_kind',
  'public_address',
  'grant_client_id',
  'grant_endpoint_id',
]);
const DELEGATED_READ_AUTHORITY_ROW_KEY_SET = new Set(DELEGATED_READ_AUTHORITY_ROW_KEYS);

const ENVELOPE_COLS = 'envelope_version, aead_alg, kek_wrap_alg, kek_key_name, kek_key_version, nonce, ciphertext, auth_tag, wrapped_dek';
const SQL_LOCK_GRANT = `
  SELECT g.*, e.binding_status AS endpoint_binding_status
    FROM tenant_email_delegated_grants g
    INNER JOIN tenant_channel_endpoints e
      ON e.id = g.endpoint_id AND e.client_id = g.client_id
   WHERE g.client_id = $1 AND g.endpoint_id = $2
   FOR UPDATE OF g`;
const SQL_LOCK_ENDPOINT = `
  SELECT id, client_id, provider, auth_mode, connector_mode, binding_status,
         provider_tenant_id, provider_principal_oid, provider_resource_id,
         mailbox_kind, mailbox_access_kind
    FROM tenant_channel_endpoints
   WHERE client_id = $1 AND id = $2 FOR UPDATE`;
// Shared promote/rewrap CAS: advance generation + write envelope under unexpired lease.
const SQL_COMMIT_ENVELOPE = `
  UPDATE tenant_email_delegated_grants
     SET grant_generation=$3, grant_status='active',
         grant_lease_owner=NULL, grant_lease_token=NULL, grant_lease_until=NULL,
         last_operation_id=$4, envelope_version=$5, aead_alg=$6, kek_wrap_alg=$7,
         kek_key_name=$8, kek_key_version=$9, nonce=$10, ciphertext=$11, auth_tag=$12,
         wrapped_dek=$13, reconcile_state='clean', reconcile_detail_code=NULL, updated_at=NOW()
   WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$14
     AND grant_lease_token=$15::uuid AND grant_status='lease_held'
     AND grant_lease_until > clock_timestamp()
   RETURNING client_id, endpoint_id, grant_generation, grant_status, reconcile_state`;

/**
 * One parameterized SELECT/join: tenant_locations + tenant_channel_endpoints +
 * tenant_email_delegated_grants on exact client/location/endpoint. Requires
 * channel=email and one closed delegated provider tuple: Microsoft Graph with
 * canonical UUID tenant/resource, or Gmail with the canonical Google issuer and
 * an exact printable-ASCII principal/resource sub. Both require verified,
 * user/own_user, and exact grant ownership.
 * Params: $1 client_id, $2 location_id (tenant_locations.id UUID), $3 endpoint_id.
 */
const SQL_RESOLVE_DELEGATED_READ_AUTHORITY = `
  SELECT e.client_id::text AS client_id,
         tl.id::text AS location_id,
         e.id::text AS endpoint_id,
         e.provider,
         e.channel,
         e.auth_mode,
         e.connector_mode,
         e.binding_status,
         e.provider_tenant_id,
         e.provider_resource_id,
         e.provider_principal_oid,
         e.mailbox_kind,
         e.mailbox_access_kind,
         e.public_address,
         g.client_id::text AS grant_client_id,
         g.endpoint_id::text AS grant_endpoint_id
    FROM tenant_channel_endpoints e
   INNER JOIN tenant_locations tl
      ON tl.client_id = e.client_id
     AND tl.location_id = e.location_id
   INNER JOIN tenant_email_delegated_grants g
      ON g.client_id = e.client_id
     AND g.endpoint_id = e.id
   WHERE e.client_id = $1::uuid
     AND tl.id = $2::uuid
     AND e.id = $3::uuid
     AND e.channel = 'email'
     AND e.auth_mode = 'delegated_authorization_code'
     AND e.binding_status = 'verified'
     AND e.mailbox_kind = 'user'
     AND e.mailbox_access_kind = 'own_user'
     AND COALESCE((
       (e.provider = 'microsoft_graph'
        AND e.connector_mode = 'microsoft_delegated_oauth'
        AND e.provider_tenant_id IS NOT NULL
        AND e.provider_resource_id IS NOT NULL)
       OR
       (e.provider = 'gmail_api'
        AND e.connector_mode = 'google_delegated_oauth'
        AND e.provider_tenant_id COLLATE "C" = 'https://accounts.google.com'
        AND e.provider_principal_oid IS NOT NULL
        AND e.provider_resource_id IS NOT NULL
        AND e.provider_principal_oid COLLATE "C" = e.provider_resource_id COLLATE "C"
        AND char_length(e.provider_resource_id) BETWEEN 1 AND 255
        AND e.provider_resource_id COLLATE "C" ~ '^[!-~]+$')
     ), FALSE)
     AND g.client_id = e.client_id
     AND g.endpoint_id = e.id`.replace(/\s+/g, ' ').trim();

function fail(error, details) {
  const out = { ok: false, error: String(error) };
  if (details !== undefined) out.details = Object.freeze({ ...details });
  return Object.freeze(out);
}
function ok(value) {
  return value === undefined ? Object.freeze({ ok: true }) : Object.freeze({ ok: true, value });
}
function looksLikePgPool(obj) {
  return Boolean(obj && typeof obj === 'object' && typeof obj.connect === 'function'
    && (typeof obj.totalCount === 'number' || typeof obj.idleCount === 'number'
      || typeof obj.waitingCount === 'number'));
}
function requireTransactionClient(deps) {
  if (!deps || typeof deps !== 'object' || deps.client == null) return fail('transaction_client_required');
  if (typeof deps.client !== 'object' || typeof deps.client.query !== 'function') {
    return fail('transaction_client_invalid', { reason: 'query_function_required' });
  }
  if (looksLikePgPool(deps.client)) return fail('transaction_client_invalid', { reason: 'pool_not_allowed' });
  return ok(deps.client);
}
function requireDb(deps) {
  if (!deps || typeof deps !== 'object') return fail('db_required');
  const db = deps.db != null ? deps.db : deps.client;
  if (!db || typeof db.query !== 'function') return fail('db_required');
  return ok(db);
}
async function rollbackQuiet(client) {
  try { await client.query('ROLLBACK'); } catch (_) { /* */ }
}
function parseUuid(raw, field) {
  if (raw == null || typeof raw !== 'string') return fail(`${field}_invalid`, { reason: 'must_be_string' });
  const v = raw.trim().toLowerCase();
  if (!v || !UUID_RE.test(v)) return fail(`${field}_invalid`);
  return ok(v);
}
function parseWorkerId(raw) {
  if (typeof raw !== 'string') return fail('worker_id_invalid');
  const v = raw.trim();
  if (v.length < 1 || v.length > 128 || /\s/.test(v)) return fail('worker_id_invalid');
  return ok(v);
}
function parseTtl(raw) {
  const n = raw == null ? DEFAULT_TTL : Number(raw);
  if (!Number.isInteger(n) || n < MIN_TTL || n > MAX_TTL) return fail('ttl_invalid');
  return ok(n);
}
function parseGen(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fail('generation_invalid');
  return ok(n);
}
function dbErr() { return fail('db_error'); }

/**
 * Custodian-local closed applicability classifier. Driver rows are treated as a
 * hostile surface: reject proxies/accessors/reflection failures and observe each
 * required field exactly once. Microsoft intentionally retains its historical
 * three-field mode tuple; Gmail additionally requires the complete G2c identity.
 */
function isDelegatedGrantCustodyEndpoint(row) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row) || isProxySurface(row)) return false;
    const own = Object.create(null);
    const snapshot = (keys) => {
      for (const key of keys) {
        const d = Object.getOwnPropertyDescriptor(row, key);
        if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set) return false;
        own[key] = d.value;
      }
      return true;
    };
    if (!snapshot(['provider', 'auth_mode', 'connector_mode'])) return false;
    if (own.provider === 'microsoft_graph') {
      return own.auth_mode === 'delegated_authorization_code'
        && own.connector_mode === 'microsoft_delegated_oauth';
    }
    if (!snapshot([
      'binding_status', 'provider_tenant_id', 'provider_principal_oid',
      'provider_resource_id', 'mailbox_kind', 'mailbox_access_kind',
    ])) return false;
    if (own.provider !== 'gmail_api'
        || own.auth_mode !== 'delegated_authorization_code'
        || own.connector_mode !== 'google_delegated_oauth'
        || own.binding_status !== 'verified'
        || own.provider_tenant_id !== 'https://accounts.google.com'
        || own.mailbox_kind !== 'user'
        || own.mailbox_access_kind !== 'own_user') return false;
    const principal = own.provider_principal_oid;
    const resource = own.provider_resource_id;
    return typeof principal === 'string' && typeof resource === 'string'
      && principal.length >= 1 && principal.length <= 255
      && /^[!-~]+$/.test(principal) && principal === resource;
  } catch (_) {
    return false;
  }
}

function toPublicGrantStatusDto(row) {
  if (!row) {
    return Object.freeze({
      grant_present: false, grant_generation: null, grant_status: null,
      reconcile_state: null, has_active_lease: false,
    });
  }
  return Object.freeze({
    grant_present: true,
    endpoint_id: row.endpoint_id,
    client_id: row.client_id,
    grant_generation: Number(row.grant_generation),
    grant_status: row.grant_status,
    reconcile_state: row.reconcile_state,
    has_active_lease: row.grant_status === 'lease_held' && row.grant_lease_token != null,
  });
}

/** Private lease handle — ids + token + trusted scope_version; never envelope material. */
function toPrivateLeaseHandle(row) {
  // scope_version is non-secret custody policy key for phase-aware refresh.
  // Missing/null rows fail closed at the refresh classifier (uncertain).
  let scopeVersion = null;
  if (typeof row.scope_version === 'string') {
    scopeVersion = row.scope_version;
  }
  return Object.freeze({
    client_id: row.client_id,
    endpoint_id: row.endpoint_id,
    grant_generation: Number(row.grant_generation),
    lease_token: row.grant_lease_token,
    lease_until: row.grant_lease_until,
    last_operation_id: row.last_operation_id,
    scope_version: scopeVersion,
  });
}

function envelopeFromAuthoritativeRow(row) {
  return {
    envelope_version: row.envelope_version,
    aead_alg: row.aead_alg,
    kek_wrap_alg: row.kek_wrap_alg,
    kek_key_name: row.kek_key_name,
    kek_key_version: row.kek_key_version,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    auth_tag: row.auth_tag,
    wrapped_dek: row.wrapped_dek,
    operation_id: row.last_operation_id,
  };
}

/** Short TX: pre-COMMIT → ROLLBACK; COMMIT sent then reject → commit_outcome_unknown. */
async function withTxn(client, fn) {
  let began = false;
  let commitSent = false;
  try {
    await client.query('BEGIN');
    began = true;
    const result = await fn();
    if (result && result.ok === false) {
      await client.query('ROLLBACK');
      began = false;
      return result;
    }
    commitSent = true;
    await client.query('COMMIT');
    began = false;
    commitSent = false;
    return result;
  } catch (err) {
    if (commitSent) {
      // COMMIT dispatched; outcome unknown — do not ROLLBACK or claim restored state.
      return fail('commit_outcome_unknown');
    }
    if (began) await rollbackQuiet(client);
    const code = err && err.code ? String(err.code) : '';
    if (code === '23505') return fail('grant_already_exists');
    if (code === '23514') return fail('grant_custody_not_applicable');
    return dbErr();
  }
}

function idsFrom(input, fields) {
  let snap;
  try {
    snap = snapshotOwnDataProps(input == null ? {} : input);
  } catch {
    return fail('input_invalid', { reason: 'reflection_failed' });
  }
  if (!snap.ok) {
    return fail('input_invalid', {
      reason: snap.reason === 'reflection_failed' ? 'reflection_failed' : snap.reason,
    });
  }
  const out = { snap: snap.value };
  if (fields.includes('clientId')) {
    out.clientId = parseUuid(snap.value.clientId, 'client_id');
    if (!out.clientId.ok) return out.clientId;
  }
  if (fields.includes('endpointId')) {
    out.endpointId = parseUuid(snap.value.endpointId, 'endpoint_id');
    if (!out.endpointId.ok) return out.endpointId;
  }
  return out;
}

/** Require pinned client + ids + leaseToken + expectedGeneration. */
function requireLeaseCasInput(input, deps) {
  const cc = requireTransactionClient(deps);
  if (!cc.ok) return cc;
  const ids = idsFrom(input, ['clientId', 'endpointId']);
  if (ids.ok === false) return ids;
  const leaseToken = parseUuid(ids.snap.leaseToken, 'lease_token');
  if (!leaseToken.ok) return leaseToken;
  const expected = parseGen(ids.snap.expectedGeneration);
  if (!expected.ok) return expected;
  return { ok: true, client: cc.value, ids, leaseToken, expected, snap: ids.snap };
}

/** Validate envelope + operation_id match for promote/rewrap. */
function requireEnvelopeOp(snap, errCode) {
  const opId = parseUuid(snap.operationId, 'operation_id');
  if (!opId.ok) return opId;
  const env = validateGrantEnvelopeRecordV1(snap.envelope);
  if (!env.ok) return env;
  if (env.value.operation_id !== opId.value) return fail(errCode, { reason: 'operation_id_mismatch' });
  return { ok: true, opId, env: env.value };
}

function envelopeCommitParams(clientId, endpointId, expected, opId, e, leaseToken) {
  return [
    clientId, endpointId, expected + 1, opId,
    e.envelope_version, e.aead_alg, e.kek_wrap_alg, e.kek_key_name, e.kek_key_version,
    e.nonce, e.ciphertext, e.auth_tag, e.wrapped_dek, expected, leaseToken,
  ];
}

async function installInitialDelegatedGrant(input, deps) {
  const cc = requireTransactionClient(deps);
  if (!cc.ok) return cc;
  const ids = idsFrom(input, ['clientId', 'endpointId']);
  if (ids.ok === false) return ids;
  const opId = parseUuid(ids.snap.operationId, 'operation_id');
  if (!opId.ok) return opId;
  const env = validateGrantEnvelopeRecordV1(ids.snap.envelope);
  if (!env.ok) return env;
  if (env.value.operation_id !== opId.value) return fail('install_input_invalid', { reason: 'operation_id_mismatch' });
  let actor = null;
  if (ids.snap.actorStaffUserId != null) {
    const a = parseUuid(ids.snap.actorStaffUserId, 'actor_staff_user_id');
    if (!a.ok) return a;
    actor = a.value;
  }
  const e = env.value;
  return withTxn(cc.value, async () => {
    const ep = await cc.value.query(SQL_LOCK_ENDPOINT, [ids.clientId.value, ids.endpointId.value]);
    if (!ep.rows || ep.rows.length !== 1) return fail('endpoint_not_found');
    const row = ep.rows[0];
    if (!isDelegatedGrantCustodyEndpoint(row)) {
      return fail('grant_custody_not_applicable');
    }
    const ins = await cc.value.query(
      `INSERT INTO tenant_email_delegated_grants (
         client_id, endpoint_id, grant_generation, grant_status, last_operation_id, reconcile_state,
         ${ENVELOPE_COLS}, created_by, updated_by
       ) VALUES ($1,$2,1,'active',$3,'clean',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
       RETURNING client_id, endpoint_id, grant_generation, grant_status, reconcile_state`,
      [
        ids.clientId.value, ids.endpointId.value, opId.value,
        e.envelope_version, e.aead_alg, e.kek_wrap_alg, e.kek_key_name, e.kek_key_version,
        e.nonce, e.ciphertext, e.auth_tag, e.wrapped_dek, actor,
      ],
    );
    return ok(toPublicGrantStatusDto(ins.rows[0]));
  });
}

async function tryAcquireDelegatedGrantLease(input, deps) {
  const cc = requireTransactionClient(deps);
  if (!cc.ok) return cc;
  const ids = idsFrom(input, ['clientId', 'endpointId']);
  if (ids.ok === false) return ids;
  const workerId = parseWorkerId(ids.snap.workerId);
  if (!workerId.ok) return workerId;
  const ttl = parseTtl(ids.snap.ttlSeconds);
  if (!ttl.ok) return ttl;
  const leaseToken = crypto.randomUUID();
  return withTxn(cc.value, async () => {
    const res = await cc.value.query(SQL_LOCK_GRANT, [ids.clientId.value, ids.endpointId.value]);
    if (!res.rows || res.rows.length !== 1) return fail('grant_not_found');
    const g = res.rows[0];
    if (g.grant_status === 'reauthorization_required' || g.grant_status === 'revoked') {
      return fail('grant_reauthorization_required');
    }
    if (g.grant_status === 'lease_held') {
      const exp = await cc.value.query(
        `SELECT (grant_lease_until IS NOT NULL AND grant_lease_until < clock_timestamp()) AS expired
           FROM tenant_email_delegated_grants WHERE client_id=$1 AND endpoint_id=$2`,
        [ids.clientId.value, ids.endpointId.value],
      );
      if (!(exp.rows[0] && exp.rows[0].expired === true)) return fail('lease_held_by_other');
    } else if (g.grant_status !== 'active') {
      return fail('grant_status_invalid');
    }
    const upd = await cc.value.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_status='lease_held', grant_lease_owner=$3, grant_lease_token=$4::uuid,
              grant_lease_until=clock_timestamp()+($5::text||' seconds')::interval, updated_at=NOW()
        WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$6
          AND (grant_status='active'
               OR (grant_status='lease_held' AND grant_lease_until < clock_timestamp()))
        RETURNING *`,
      [ids.clientId.value, ids.endpointId.value, workerId.value, leaseToken, String(ttl.value), g.grant_generation],
    );
    if (!upd.rows || upd.rows.length !== 1) return fail('lease_acquire_conflict');
    return ok(toPrivateLeaseHandle(upd.rows[0]));
  });
}

async function renewDelegatedGrantLease(input, deps) {
  const cas = requireLeaseCasInput(input, deps);
  if (!cas.ok) return cas;
  const ttl = parseTtl(cas.snap.ttlSeconds);
  if (!ttl.ok) return ttl;
  return withTxn(cas.client, async () => {
    const upd = await cas.client.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_lease_until=clock_timestamp()+($5::text||' seconds')::interval, updated_at=NOW()
        WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$3
          AND grant_lease_token=$4::uuid AND grant_status='lease_held'
          AND grant_lease_until > clock_timestamp()
        RETURNING grant_generation, grant_status`,
      [cas.ids.clientId.value, cas.ids.endpointId.value, cas.expected.value, cas.leaseToken.value, String(ttl.value)],
    );
    if (!upd.rows || upd.rows.length !== 1) return fail('lease_fenced');
    return ok(Object.freeze({
      grant_generation: Number(upd.rows[0].grant_generation),
      grant_status: upd.rows[0].grant_status,
      renewed: true,
    }));
  });
}

/**
 * Open under held lease: re-read row in short pinned TX (token+gen+unexpired);
 * envelope from row only; provider open after COMMIT. Stale handles skip provider.
 */
async function openDelegatedGrantUnderLease(input, deps) {
  const cc = requireTransactionClient(deps);
  if (!cc.ok) return cc;
  const prov = validateEmailGrantEnvelopeProvider(deps && deps.envelopeProvider);
  if (!prov.ok) return prov;

  let clientId;
  let endpointId;
  let leaseToken;
  let gen;
  const ids = idsFrom(input, ['clientId', 'endpointId']);
  if (ids.ok !== false) {
    clientId = ids.clientId;
    endpointId = ids.endpointId;
    leaseToken = parseUuid(
      ids.snap.leaseToken != null ? ids.snap.leaseToken : ids.snap.lease_token, 'lease_token',
    );
    gen = parseGen(
      ids.snap.expectedGeneration != null ? ids.snap.expectedGeneration : ids.snap.grant_generation,
    );
  } else {
    // CamelCase ids failed — try private-handle snake_case shape.
    let snap;
    try {
      snap = snapshotOwnDataProps(input == null ? {} : input);
    } catch {
      return fail('open_handle_invalid', { reason: 'reflection_failed' });
    }
    if (!snap.ok) {
      return fail('open_handle_invalid', {
        reason: snap.reason === 'reflection_failed' ? 'reflection_failed' : snap.reason,
      });
    }
    clientId = parseUuid(snap.value.client_id, 'client_id');
    endpointId = parseUuid(snap.value.endpoint_id, 'endpoint_id');
    leaseToken = parseUuid(snap.value.lease_token, 'lease_token');
    gen = parseGen(snap.value.grant_generation);
  }
  if (!clientId.ok) return clientId;
  if (!endpointId.ok) return endpointId;
  if (!leaseToken.ok) return leaseToken;
  if (!gen.ok) return gen;

  let envelopeSnap = null;
  let aadGen = gen.value;
  let aadOp = null;

  const txResult = await withTxn(cc.value, async () => {
    const res = await cc.value.query(
      `SELECT client_id, endpoint_id, grant_generation, grant_status,
              grant_lease_token, grant_lease_until, last_operation_id,
              ${ENVELOPE_COLS}
         FROM tenant_email_delegated_grants
        WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$3
          AND grant_lease_token=$4::uuid AND grant_status='lease_held'
          AND grant_lease_until > clock_timestamp()
        FOR UPDATE`,
      [clientId.value, endpointId.value, gen.value, leaseToken.value],
    );
    if (!res.rows || res.rows.length !== 1) return fail('lease_fenced');
    const row = res.rows[0];
    const env = validateGrantEnvelopeRecordV1(envelopeFromAuthoritativeRow(row));
    if (!env.ok) return fail('envelope_record_invalid', { reason: 'authoritative_row' });
    envelopeSnap = env.value;
    aadGen = Number(row.grant_generation);
    aadOp = String(row.last_operation_id).trim().toLowerCase();
    return ok();
  });
  if (!txResult.ok) return txResult;

  // Outside TX — provider open only after successful lease re-read + COMMIT.
  let aad;
  try {
    aad = buildGrantEnvelopeAadV1({
      clientId: clientId.value,
      endpointId: endpointId.value,
      grantGeneration: aadGen,
      operationId: aadOp,
    });
  } catch (_) {
    return fail('aad_invalid');
  }
  try {
    const material = await prov.value.openGrantPayload({ envelope: envelopeSnap, aad });
    let matSnap;
    try {
      matSnap = snapshotOwnDataProps(material == null ? {} : material);
    } catch {
      return fail('envelope_open_failed');
    }
    if (!matSnap.ok || typeof matSnap.value.refresh_token !== 'string'
      || !matSnap.value.refresh_token) {
      return fail('envelope_open_failed');
    }
    return ok(Object.freeze({ refresh_token: matSnap.value.refresh_token }));
  } catch (_) {
    return fail('envelope_open_failed');
  }
}

async function commitDelegatedGrantRotation(input, deps) {
  const cas = requireLeaseCasInput(input, deps);
  if (!cas.ok) return cas;
  const envOp = requireEnvelopeOp(cas.snap, 'commit_input_invalid');
  if (!envOp.ok) return envOp;
  return withTxn(cas.client, async () => {
    const upd = await cas.client.query(
      SQL_COMMIT_ENVELOPE,
      envelopeCommitParams(
        cas.ids.clientId.value, cas.ids.endpointId.value, cas.expected.value,
        envOp.opId.value, envOp.env, cas.leaseToken.value,
      ),
    );
    if (!upd.rows || upd.rows.length !== 1) return fail('generation_conflict');
    return ok(toPublicGrantStatusDto(upd.rows[0]));
  });
}

/** Terminal revoke under exact held unexpired lease + generation CAS. */
async function markDelegatedGrantRevoked(input, deps) {
  const cas = requireLeaseCasInput(input, deps);
  if (!cas.ok) return cas;
  const operationId = typeof cas.snap.operationId === 'string' ? cas.snap.operationId : '';
  if (!UUID_RE.test(operationId)) return fail('operation_id_invalid');
  return withTxn(cas.client, async () => {
    const upd = await cas.client.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_status='revoked',
              grant_lease_owner=NULL, grant_lease_token=NULL, grant_lease_until=NULL,
              reconcile_state='needs_operator', reconcile_detail_code='revocation',
              last_operation_id=$5, updated_at=NOW()
        WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$3
          AND grant_lease_token=$4::uuid AND grant_status='lease_held'
          AND grant_lease_until > clock_timestamp()
        RETURNING grant_generation, grant_status, reconcile_state`,
      [cas.ids.clientId.value, cas.ids.endpointId.value, cas.expected.value, cas.leaseToken.value, operationId],
    );
    if (!upd.rows || upd.rows.length !== 1) return fail('lease_fenced');
    await cas.client.query(
      `UPDATE tenant_channel_endpoints
          SET binding_status='revoked',
              active=false,
              inbound_enabled=false,
              outbound_enabled=false,
              default_automation_mode='off',
              updated_at=NOW()
        WHERE client_id=$1 AND id=$2`,
      [cas.ids.clientId.value, cas.ids.endpointId.value],
    );
    return ok(Object.freeze({
      grant_present: true,
      grant_status: 'revoked',
      grant_generation: Number(upd.rows[0].grant_generation),
      reconcile_state: upd.rows[0].reconcile_state,
    }));
  });
}

/** Terminal reauth under exact held unexpired lease + generation CAS. */
async function markDelegatedGrantReauthorizationRequired(input, deps) {
  const cas = requireLeaseCasInput(input, deps);
  if (!cas.ok) return cas;
  const reason = typeof cas.snap.reason === 'string' ? cas.snap.reason : '';
  if (!TERMINAL_REAUTH_REASONS.includes(reason)) return fail('reauth_reason_invalid');
  return withTxn(cas.client, async () => {
    const locked = await cas.client.query(SQL_LOCK_GRANT, [cas.ids.clientId.value, cas.ids.endpointId.value]);
    if (!locked.rows || locked.rows.length !== 1) return fail('grant_not_found');
    const g = locked.rows[0];
    const upd = await cas.client.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_status='reauthorization_required',
              grant_lease_owner=NULL, grant_lease_token=NULL, grant_lease_until=NULL,
              reconcile_state='needs_operator', reconcile_detail_code=$5, updated_at=NOW()
        WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$3
          AND grant_lease_token=$4::uuid AND grant_status='lease_held'
          AND grant_lease_until > clock_timestamp()
        RETURNING grant_generation, grant_status`,
      [cas.ids.clientId.value, cas.ids.endpointId.value, cas.expected.value, cas.leaseToken.value, reason],
    );
    if (!upd.rows || upd.rows.length !== 1) return fail('lease_fenced');
    if (g.endpoint_binding_status === 'verified' || g.endpoint_binding_status === 'reauthorization_required') {
      await cas.client.query(
        `UPDATE tenant_channel_endpoints SET binding_status='reauthorization_required', updated_at=NOW()
          WHERE client_id=$1 AND id=$2`,
        [cas.ids.clientId.value, cas.ids.endpointId.value],
      );
    }
    return ok(Object.freeze({
      grant_present: true, grant_status: 'reauthorization_required',
      grant_generation: Number(upd.rows[0].grant_generation), reason,
    }));
  });
}

/** Abort lease: owner may clear even if expired; reassigned token → lease_fenced. */
async function abortDelegatedGrantLease(input, deps) {
  const cas = requireLeaseCasInput(input, deps);
  if (!cas.ok) return cas;
  return withTxn(cas.client, async () => {
    // No unexpired predicate — owner may clear expired own lease.
    const upd = await cas.client.query(
      `UPDATE tenant_email_delegated_grants
          SET grant_status='active', grant_lease_owner=NULL, grant_lease_token=NULL,
              grant_lease_until=NULL, updated_at=NOW()
        WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$3
          AND grant_lease_token=$4::uuid AND grant_status='lease_held'
        RETURNING client_id, endpoint_id, grant_generation, grant_status, reconcile_state`,
      [cas.ids.clientId.value, cas.ids.endpointId.value, cas.expected.value, cas.leaseToken.value],
    );
    if (!upd.rows || upd.rows.length !== 1) return fail('lease_fenced');
    return ok(toPublicGrantStatusDto(upd.rows[0]));
  });
}

/** Reconcile under exact held unexpired lease + generation CAS. */
async function markDelegatedGrantReconciliation(input, deps) {
  const cas = requireLeaseCasInput(input, deps);
  if (!cas.ok) return cas;
  const state = cas.snap.reconcileState;
  if (!RECONCILE_STATES.includes(state)) return fail('reconcile_state_invalid');
  let detail = null;
  if (state === 'clean') {
    if (cas.snap.reconcileDetailCode != null) {
      return fail('reconcile_detail_invalid', { reason: 'clean_requires_null_detail' });
    }
  } else if (typeof cas.snap.reconcileDetailCode !== 'string'
    || !RECONCILE_DETAIL_RE.test(cas.snap.reconcileDetailCode)) {
    return fail('reconcile_detail_invalid', { reason: 'non_clean_requires_detail' });
  } else {
    detail = cas.snap.reconcileDetailCode;
  }
  return withTxn(cas.client, async () => {
    const upd = await cas.client.query(
      `UPDATE tenant_email_delegated_grants
          SET reconcile_state=$3, reconcile_detail_code=$4, updated_at=NOW()
        WHERE client_id=$1 AND endpoint_id=$2 AND grant_generation=$5
          AND grant_lease_token=$6::uuid AND grant_status='lease_held'
          AND grant_lease_until > clock_timestamp()
        RETURNING client_id, endpoint_id, grant_generation, grant_status, reconcile_state`,
      [cas.ids.clientId.value, cas.ids.endpointId.value, state, detail, cas.expected.value, cas.leaseToken.value],
    );
    if (!upd.rows || upd.rows.length !== 1) return fail('lease_fenced');
    return ok(toPublicGrantStatusDto(upd.rows[0]));
  });
}

async function listDelegatedGrantsNeedingReconciliation(input, deps) {
  const dbc = requireDb(deps);
  if (!dbc.ok) return dbc;
  const ids = idsFrom(input, ['clientId']);
  if (ids.ok === false) return ids;
  try {
    const res = await dbc.value.query(
      `SELECT client_id, endpoint_id, grant_generation, grant_status, reconcile_state
         FROM tenant_email_delegated_grants
        WHERE client_id=$1 AND reconcile_state <> 'clean' ORDER BY endpoint_id`,
      [ids.clientId.value],
    );
    return ok(Object.freeze((res.rows || []).map((r) => toPublicGrantStatusDto(r))));
  } catch (_) { return dbErr(); }
}

/** Rewrap under held unexpired lease; advances generation (stale overwrite fails). */
async function commitDelegatedGrantRewrap(input, deps) {
  const cas = requireLeaseCasInput(input, deps);
  if (!cas.ok) return cas;
  const envOp = requireEnvelopeOp(cas.snap, 'rewrap_input_invalid');
  if (!envOp.ok) return envOp;
  return withTxn(cas.client, async () => {
    const upd = await cas.client.query(
      SQL_COMMIT_ENVELOPE,
      envelopeCommitParams(
        cas.ids.clientId.value, cas.ids.endpointId.value, cas.expected.value,
        envOp.opId.value, envOp.env, cas.leaseToken.value,
      ),
    );
    if (!upd.rows || upd.rows.length !== 1) return fail('generation_conflict');
    return ok(toPublicGrantStatusDto(upd.rows[0]));
  });
}

async function getDelegatedGrantPublicStatus(input, deps) {
  const dbc = requireDb(deps);
  if (!dbc.ok) return dbc;
  const ids = idsFrom(input, ['clientId', 'endpointId']);
  if (ids.ok === false) return ids;
  try {
    const res = await dbc.value.query(
      `SELECT client_id, endpoint_id, grant_generation, grant_status, reconcile_state, grant_lease_token
         FROM tenant_email_delegated_grants WHERE client_id=$1 AND endpoint_id=$2`,
      [ids.clientId.value, ids.endpointId.value],
    );
    if (!res.rows || res.rows.length === 0) return ok(toPublicGrantStatusDto(null));
    return ok(toPublicGrantStatusDto(res.rows[0]));
  } catch (_) { return dbErr(); }
}

function failReadAuthority(error) {
  // Sanitized only — never embed row values, addresses, principals, secrets,
  // dependency exception messages, or attacker-controlled strings.
  return Object.freeze({ ok: false, error: String(error) });
}

/**
 * Module-init pinned native util.types.isProxy via Reflect.apply.
 * Missing pin / throw → fail closed (treat as proxy). Does not invoke
 * application traps on the value (isProxy is a native brand check).
 */
function isProxySurface(value) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

/**
 * Exact ordered own-data snapshot of resolve input.
 * Order: type checks → pinned proxy rejection → prototype → ownKeys →
 * enumerable own data descriptors once. Never reread caller.
 */
function snapshotExactReadAuthorityInput(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    if (isProxySurface(input)) return null;
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(input);
    if (actual.length !== DELEGATED_READ_AUTHORITY_INPUT_KEYS.length) return null;
    for (let i = 0; i < DELEGATED_READ_AUTHORITY_INPUT_KEYS.length; i += 1) {
      if (actual[i] !== DELEGATED_READ_AUTHORITY_INPUT_KEYS[i]) return null;
    }
    const out = Object.create(null);
    for (const key of DELEGATED_READ_AUTHORITY_INPUT_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
        return null;
      }
      out[key] = descriptor.value;
    }
    return Object.freeze(out);
  } catch {
    return null;
  }
}

function parseCanonicalUuid(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v || !UUID_CANON.test(v)) return null;
  return v;
}

/**
 * Resolve query without instance [[Get]] (avoids hostile own accessors).
 * Own data function descriptor wins; else prototype-chain data function
 * (genuine node-postgres Client/Pool put query on the prototype, often
 * non-enumerable). Own accessor / non-function → reject. Proxies rejected
 * before any prototype/descriptor walk.
 */
function resolveReadAuthorityQueryMethod(surface) {
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

/**
 * Sanitized dependency resolution for read-authority.
 * Reads deps.db / deps.client via own data descriptors only (never [[Get]]).
 * Prefer db when own data and non-null; else client. Rejects proxies on deps
 * and on the db/client surface before any method resolution.
 *
 * @returns {{ok:true,surface:object,query:Function}|{ok:false,error:string}}
 */
function resolveReadAuthorityDb(deps) {
  try {
    if (deps == null || typeof deps !== 'object') {
      return { ok: false, error: 'db_required' };
    }
    if (isProxySurface(deps)) {
      return { ok: false, error: 'db_required' };
    }

    let dbValue;
    let hasDb = false;
    const dbDesc = Object.getOwnPropertyDescriptor(deps, 'db');
    if (dbDesc) {
      if (!Object.prototype.hasOwnProperty.call(dbDesc, 'value')
          || dbDesc.get
          || dbDesc.set) {
        return { ok: false, error: 'db_required' };
      }
      hasDb = true;
      dbValue = dbDesc.value;
    }

    let clientValue;
    let hasClient = false;
    const clientDesc = Object.getOwnPropertyDescriptor(deps, 'client');
    if (clientDesc) {
      if (!Object.prototype.hasOwnProperty.call(clientDesc, 'value')
          || clientDesc.get
          || clientDesc.set) {
        return { ok: false, error: 'db_required' };
      }
      hasClient = true;
      clientValue = clientDesc.value;
    }

    // Match prior requireDb preference: db when present and non-null, else client.
    const surface = (hasDb && dbValue != null)
      ? dbValue
      : (hasClient ? clientValue : null);
    if (!surface || typeof surface !== 'object') {
      return { ok: false, error: 'db_required' };
    }
    if (isProxySurface(surface)) {
      return { ok: false, error: 'db_required' };
    }

    const query = resolveReadAuthorityQueryMethod(surface);
    if (typeof query !== 'function') {
      return { ok: false, error: 'db_required' };
    }
    return { ok: true, surface, query };
  } catch {
    return { ok: false, error: 'db_required' };
  }
}

/**
 * Snapshot + validate exact own-data driver row (SQL textual key set).
 * Re-validates ownership/provider identity/modes/status after SQL; never trusts
 * SQL alone.
 * public_address and provider_principal_oid are observed once and discarded —
 * never mapped into the internal DTO. providerMailboxId always uses resource_id.
 *
 * Order: type → pinned proxy → prototype → ownKeys → enumerable own data
 * descriptors once. Rejects nonenumerable/accessor/symbol/extra/inherited/proxy.
 */
function snapshotAndValidateReadAuthorityRow(row, expected) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    if (isProxySurface(row)) return null;
    const proto = Object.getPrototypeOf(row);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(row);
    if (actual.length !== DELEGATED_READ_AUTHORITY_ROW_KEYS.length) return null;
    for (const key of actual) {
      if (typeof key !== 'string' || !DELEGATED_READ_AUTHORITY_ROW_KEY_SET.has(key)) {
        return null;
      }
    }
    const own = Object.create(null);
    for (const key of DELEGATED_READ_AUTHORITY_ROW_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
        return null;
      }
      own[key] = descriptor.value;
    }

    if (own.client_id !== expected.clientId
        || own.location_id !== expected.locationId
        || own.endpoint_id !== expected.endpointId) {
      return null;
    }
    if (own.grant_client_id !== expected.clientId
        || own.grant_endpoint_id !== expected.endpointId) {
      return null;
    }
    if (own.channel !== 'email'
        || own.auth_mode !== 'delegated_authorization_code'
        || own.binding_status !== 'verified'
        || own.mailbox_kind !== 'user'
        || own.mailbox_access_kind !== 'own_user') {
      return null;
    }
    let provider;
    if (own.provider === 'microsoft_graph') {
      if (own.connector_mode !== 'microsoft_delegated_oauth'
          || typeof own.provider_tenant_id !== 'string'
          || !UUID_CANON.test(own.provider_tenant_id)
          || typeof own.provider_resource_id !== 'string'
          || !UUID_CANON.test(own.provider_resource_id)) {
        return null;
      }
      // Microsoft principal may be null or differ; resource_id always wins.
      if (own.provider_principal_oid != null
          && typeof own.provider_principal_oid !== 'string') {
        return null;
      }
      provider = 'microsoft_graph';
    } else if (own.provider === 'gmail_api') {
      if (own.connector_mode !== 'google_delegated_oauth'
          || own.provider_tenant_id !== 'https://accounts.google.com'
          || typeof own.provider_principal_oid !== 'string'
          || typeof own.provider_resource_id !== 'string'
          || own.provider_principal_oid !== own.provider_resource_id
          || !/^[\x21-\x7e]{1,255}$/.test(own.provider_resource_id)) {
        return null;
      }
      provider = 'gmail_api';
    } else {
      return null;
    }
    if (own.public_address != null && typeof own.public_address !== 'string') {
      return null;
    }

    // Fresh frozen local binding — includes private provider_tenant_id for
    // seal/init/verifyBinding. Public resolve strips providerTenantId.
    // Never principal/address.
    return Object.freeze({
      clientId: expected.clientId,
      locationId: expected.locationId,
      endpointId: expected.endpointId,
      provider,
      providerMailboxId: own.provider_resource_id,
      providerTenantId: own.provider_tenant_id,
      bindingStatus: 'verified',
    });
  } catch {
    return null;
  }
}

/** Public resolve DTO — exact DELEGATED_READ_AUTHORITY_DTO_KEYS (no tenant). */
function toPublicReadAuthorityDto(binding) {
  return Object.freeze({
    clientId: binding.clientId,
    locationId: binding.locationId,
    endpointId: binding.endpointId,
    provider: binding.provider,
    providerMailboxId: binding.providerMailboxId,
    bindingStatus: binding.bindingStatus,
  });
}

/**
 * One-read descriptor snapshot of a pg-style QueryResult for read-authority.
 *
 * Root: accept realistic node-postgres Result prototypes (Result.prototype)
 * as well as ordinary Object.prototype / null-proto bags. Never trust
 * inherited properties — inspect own data descriptors only. Ordinary pg
 * Result metadata (command, rowCount, oid, fields, …) may appear as own
 * data; exactly one own data `rows` descriptor is captured once.
 * Accessors/symbols on the root → invalid. Proxies rejected first.
 *
 * Rows: actual Array with module-init intrinsic Array.prototype; dense exact
 * shape (indices 0..n-1 then length); length via own data descriptor once;
 * each index enumerable own data once. Empty / one / multi / invalid kinds.
 *
 * @returns {{kind:'empty'}|{kind:'one',row:unknown}|{kind:'multi'}|{kind:'invalid'}}
 */
function snapshotReadAuthorityQueryResult(result) {
  try {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return Object.freeze({ kind: 'invalid' });
    }
    if (isProxySurface(result)) {
      return Object.freeze({ kind: 'invalid' });
    }
    // Intentionally no Object.prototype|null-only rootProto gate: production
    // node-postgres returns Result instances whose prototype is Result.prototype.
    // Own-data inspection below is the sole trust boundary for rows/metadata.

    const rootKeys = Reflect.ownKeys(result);
    let rowsDesc = null;
    for (let i = 0; i < rootKeys.length; i += 1) {
      const key = rootKeys[i];
      if (typeof key === 'symbol') {
        return Object.freeze({ kind: 'invalid' });
      }
      const desc = Object.getOwnPropertyDescriptor(result, key);
      if (!desc
          || !Object.prototype.hasOwnProperty.call(desc, 'value')
          || desc.get
          || desc.set) {
        return Object.freeze({ kind: 'invalid' });
      }
      if (key === 'rows') {
        if (rowsDesc) return Object.freeze({ kind: 'invalid' });
        rowsDesc = desc;
      }
      // Other own data keys: permitted as ordinary pg Result metadata (unused).
    }
    if (!rowsDesc) return Object.freeze({ kind: 'invalid' });

    const rows = rowsDesc.value;
    if (!Array.isArray(rows)) return Object.freeze({ kind: 'invalid' });
    if (isProxySurface(rows)) return Object.freeze({ kind: 'invalid' });
    // After pinned proxy rejection and before any element/property use:
    // require the expected intrinsic Array.prototype exactly.
    let rowsProto;
    try {
      rowsProto = Object.getPrototypeOf(rows);
    } catch {
      return Object.freeze({ kind: 'invalid' });
    }
    if (rowsProto !== PINNED_ARRAY_PROTOTYPE) {
      return Object.freeze({ kind: 'invalid' });
    }

    const rowKeys = Reflect.ownKeys(rows);
    for (let i = 0; i < rowKeys.length; i += 1) {
      if (typeof rowKeys[i] === 'symbol') {
        return Object.freeze({ kind: 'invalid' });
      }
    }

    // Length: exact own data descriptor once — never a direct property get.
    // Array length is non-enumerable by design; do not require enumerable.
    const lengthDesc = Object.getOwnPropertyDescriptor(rows, 'length');
    if (!lengthDesc
        || !Object.prototype.hasOwnProperty.call(lengthDesc, 'value')
        || lengthDesc.get
        || lengthDesc.set
        || typeof lengthDesc.value !== 'number'
        || !Number.isInteger(lengthDesc.value)
        || lengthDesc.value < 0) {
      return Object.freeze({ kind: 'invalid' });
    }
    const n = lengthDesc.value;

    // Dense exact shape: indices '0'..'n-1' then 'length' (ordinary arrays).
    if (rowKeys.length !== n + 1) {
      return Object.freeze({ kind: 'invalid' });
    }
    for (let i = 0; i < n; i += 1) {
      if (rowKeys[i] !== String(i)) {
        return Object.freeze({ kind: 'invalid' });
      }
    }
    if (rowKeys[n] !== 'length') {
      return Object.freeze({ kind: 'invalid' });
    }

    if (n === 0) {
      return Object.freeze({ kind: 'empty' });
    }

    if (n === 1) {
      const indexDesc = Object.getOwnPropertyDescriptor(rows, '0');
      if (!indexDesc
          || !Object.prototype.hasOwnProperty.call(indexDesc, 'value')
          || indexDesc.get
          || indexDesc.set
          || !indexDesc.enumerable) {
        return Object.freeze({ kind: 'invalid' });
      }
      return Object.freeze({ kind: 'one', row: indexDesc.value });
    }

    // Multi-row: confirm each index is enumerable own data once (no element use).
    for (let i = 0; i < n; i += 1) {
      const indexDesc = Object.getOwnPropertyDescriptor(rows, String(i));
      if (!indexDesc
          || !Object.prototype.hasOwnProperty.call(indexDesc, 'value')
          || indexDesc.get
          || indexDesc.set
          || !indexDesc.enumerable) {
        return Object.freeze({ kind: 'invalid' });
      }
    }
    return Object.freeze({ kind: 'multi' });
  } catch {
    return Object.freeze({ kind: 'invalid' });
  }
}

/**
 * Shared load of verified delegated read authority binding.
 * Exact same SQL + row validation as public resolve. Returns local-only
 * binding DTO including private provider_tenant_id (providerTenantId).
 * Never public_address / provider_principal_oid / secrets.
 *
 * @returns {Promise<{ok:true,value:object}|{ok:false,error:string}>}
 */
async function loadDelegatedReadAuthorityBinding(input, deps) {
  try {
    const snap = snapshotExactReadAuthorityInput(input);
    if (!snap) return failReadAuthority('input_invalid');

    const clientId = parseCanonicalUuid(snap.clientId);
    const locationId = parseCanonicalUuid(snap.locationId);
    const endpointId = parseCanonicalUuid(snap.endpointId);
    if (!clientId || !locationId || !endpointId) {
      return failReadAuthority('input_invalid');
    }

    const dbc = resolveReadAuthorityDb(deps);
    if (!dbc.ok) return failReadAuthority(dbc.error || 'db_required');

    let pending;
    try {
      pending = Reflect.apply(
        dbc.query,
        dbc.surface,
        [SQL_RESOLVE_DELEGATED_READ_AUTHORITY, [clientId, locationId, endpointId]],
      );
    } catch (_) {
      return failReadAuthority('db_error');
    }

    // Sync proxy return only: reject before await so no thenable probe runs.
    // Genuine node-postgres returns a real Promise (not a Proxy) — preserved.
    // A Promise that later fulfills to a proxy is out of scope for zero-trap
    // claims (assimilation necessarily reads `then`).
    if (pending != null
        && (typeof pending === 'object' || typeof pending === 'function')
        && isProxySurface(pending)) {
      return failReadAuthority('db_error');
    }

    let res;
    try {
      res = await pending;
    } catch (_) {
      // Planted throws / driver rejection → frozen sanitized only.
      return failReadAuthority('db_error');
    }

    // Post-await: snapshotReadAuthorityQueryResult rejects proxies via pinned
    // isProxy before any prototype/key/descriptor/rows application ops.
    const shaped = snapshotReadAuthorityQueryResult(res);
    if (shaped.kind === 'empty') {
      return failReadAuthority('delegated_read_authority_unresolved');
    }
    if (shaped.kind === 'multi') {
      return failReadAuthority('delegated_read_authority_ambiguous');
    }
    if (shaped.kind !== 'one') {
      // Invalid result/rows shape (accessor, proxy, sparse, wrong prototype, …).
      return failReadAuthority('db_error');
    }

    const binding = snapshotAndValidateReadAuthorityRow(shaped.row, {
      clientId,
      locationId,
      endpointId,
    });
    if (!binding) return failReadAuthority('delegated_read_authority_unresolved');
    return ok(binding);
  } catch (_) {
    // Any unexpected reflection/driver throw → sanitized only; never rethrow.
    return failReadAuthority('db_error');
  }
}

/**
 * UNWIRED repository resolve of delegated email read authority.
 *
 * Exact own-data input `{ clientId, locationId, endpointId }` only (UUID strings).
 * One parameterized SELECT/join of locations + endpoints + grants. Returns one
 * frozen internal DTO (public keys only — no providerTenantId); never
 * public_address / provider_principal_oid / secrets. Sanitized failures only.
 *
 * Hostile / threat-model boundary (honest): see loadDelegatedReadAuthorityBinding.
 *
 * Not exposed via getDelegatedGrantPublicStatus, read-health, routes, transport,
 * or runtime composition (`EMAIL_DELEGATED_READ_AUTHORITY_RUNTIME_WIRED = false`).
 *
 * @param {{ clientId: string, locationId: string, endpointId: string }} input
 * @param {{ db?: object, client?: object }} deps
 * @returns {Promise<{ok:true,value:object}|{ok:false,error:string}>}
 */
async function resolveDelegatedReadAuthority(input, deps) {
  const loaded = await loadDelegatedReadAuthorityBinding(input, deps);
  if (!loaded.ok) return loaded;
  // Strip private providerTenantId — public DTO keys stay byte-compatible.
  return ok(toPublicReadAuthorityDto(loaded.value));
}

/**
 * Local-only binding resolve (includes private providerTenantId from
 * provider_tenant_id row field). Same SQL/row semantics as
 * resolveDelegatedReadAuthority. For delta seal/init/composition only —
 * never public status/routes/read-health.
 *
 * @param {{ clientId: string, locationId: string, endpointId: string }} input
 * @param {{ db?: object, client?: object }} deps
 * @returns {Promise<{ok:true,value:object}|{ok:false,error:string}>}
 */
async function resolveDelegatedReadAuthorityBinding(input, deps) {
  return loadDelegatedReadAuthorityBinding(input, deps);
}

/**
 * Factory-fixed trusted authority-verifier for PR408 beginNextGeneration.
 * Reuses exact SQL_RESOLVE_DELEGATED_READ_AUTHORITY + row validation; matches
 * private provider_tenant_id and provider_resource_id against binding input.
 * Caller cannot self-assert with a boolean. No second SQL dialect.
 *
 * @param {{ db: object }} deps
 * @returns {Readonly<{ verifyBinding: Function }>}
 */
function createDelegatedReadAuthorityBindingVerifier(deps) {
  let dbSurface;
  try {
    if (deps == null || typeof deps !== 'object' || Array.isArray(deps)) {
      throw new Error('authority_binding_verifier_deps_invalid');
    }
    if (isProxySurface(deps)) {
      throw new Error('authority_binding_verifier_deps_invalid');
    }
    const dbc = resolveReadAuthorityDb(deps);
    if (!dbc.ok) throw new Error('authority_binding_verifier_db_required');
    // Pin minimal frozen db adapter so verifyBinding never re-reads caller deps.
    dbSurface = Object.freeze({
      query(...args) {
        return Reflect.apply(dbc.query, dbc.surface, args);
      },
    });
  } catch (_) {
    const error = new Error('Delegated read authority binding verifier failed.');
    Object.defineProperty(error, 'name', {
      value: 'DelegatedReadAuthorityBindingVerifierError',
    });
    Object.defineProperty(error, 'code', {
      value: 'authority_binding_verifier_invalid',
      enumerable: true,
    });
    throw Object.freeze(error);
  }

  async function verifyBinding(binding) {
    try {
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
        return Object.freeze({ ok: false, error: 'authority_not_verified' });
      }
      if (isProxySurface(binding)) {
        return Object.freeze({ ok: false, error: 'authority_not_verified' });
      }
      // Exact own-data verify keys (PR408 beginNextGeneration binding shape).
      const actual = Reflect.ownKeys(binding);
      if (actual.length !== DELEGATED_READ_AUTHORITY_BINDING_VERIFY_KEYS.length) {
        return Object.freeze({ ok: false, error: 'authority_not_verified' });
      }
      const snap = Object.create(null);
      for (const key of DELEGATED_READ_AUTHORITY_BINDING_VERIFY_KEYS) {
        if (!actual.includes(key)) {
          return Object.freeze({ ok: false, error: 'authority_not_verified' });
        }
        const desc = Object.getOwnPropertyDescriptor(binding, key);
        if (!desc
            || !Object.prototype.hasOwnProperty.call(desc, 'value')
            || desc.get
            || desc.set) {
          return Object.freeze({ ok: false, error: 'authority_not_verified' });
        }
        snap[key] = desc.value;
      }
      const clientId = parseCanonicalUuid(snap.clientId);
      const locationId = parseCanonicalUuid(snap.locationId);
      const endpointId = parseCanonicalUuid(snap.endpointId);
      const providerTenantId = parseCanonicalUuid(snap.providerTenantId);
      const providerMailboxId = parseCanonicalUuid(snap.providerMailboxId);
      if (!clientId || !locationId || !endpointId
          || !providerTenantId || !providerMailboxId) {
        return Object.freeze({ ok: false, error: 'authority_not_verified' });
      }

      const loaded = await loadDelegatedReadAuthorityBinding(
        Object.freeze({ clientId, locationId, endpointId }),
        Object.freeze({ db: dbSurface }),
      );
      if (!loaded.ok || !loaded.value) {
        return Object.freeze({ ok: false, error: 'authority_not_verified' });
      }
      const row = loaded.value;
      if (row.clientId !== clientId
          || row.locationId !== locationId
          || row.endpointId !== endpointId
          || row.providerTenantId !== providerTenantId
          || row.providerMailboxId !== providerMailboxId
          || row.provider !== 'microsoft_graph'
          || row.bindingStatus !== 'verified') {
        return Object.freeze({ ok: false, error: 'authority_not_verified' });
      }
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          clientId,
          locationId,
          endpointId,
          providerTenantId,
          providerMailboxId,
        }),
      });
    } catch (_) {
      return Object.freeze({ ok: false, error: 'authority_not_verified' });
    }
  }

  return Object.freeze({ verifyBinding });
}

module.exports = {
  installInitialDelegatedGrant,
  tryAcquireDelegatedGrantLease,
  renewDelegatedGrantLease,
  openDelegatedGrantUnderLease,
  commitDelegatedGrantRotation,
  markDelegatedGrantReauthorizationRequired,
  markDelegatedGrantRevoked,
  abortDelegatedGrantLease,
  markDelegatedGrantReconciliation,
  listDelegatedGrantsNeedingReconciliation,
  commitDelegatedGrantRewrap,
  getDelegatedGrantPublicStatus,
  resolveDelegatedReadAuthority,
  resolveDelegatedReadAuthorityBinding,
  createDelegatedReadAuthorityBindingVerifier,
  toPublicGrantStatusDto,
  toPrivateLeaseHandle,
  withTxn,
  TERMINAL_REAUTH_REASONS,
  RECONCILE_STATES,
  EMAIL_DELEGATED_READ_AUTHORITY_RUNTIME_WIRED,
  DELEGATED_READ_AUTHORITY_INPUT_KEYS,
  DELEGATED_READ_AUTHORITY_DTO_KEYS,
  DELEGATED_READ_AUTHORITY_BINDING_DTO_KEYS,
  DELEGATED_READ_AUTHORITY_BINDING_VERIFY_KEYS,
  DELEGATED_READ_AUTHORITY_ROW_KEYS,
  SQL_RESOLVE_DELEGATED_READ_AUTHORITY,
};
