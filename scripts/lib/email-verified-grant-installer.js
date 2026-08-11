'use strict';

/**
 * Provider-neutral atomic Microsoft/Gmail verified-grant DB installer.
 *
 * Owns ONE short PostgreSQL transaction that atomically:
 *   1) locks the endpoint row FOR UPDATE
 *   2) performs the two mutations in provider-safe order: Microsoft inserts the
 *      grant then binds the endpoint; Gmail binds first so its immediate grant
 *      guard accepts the insert
 *   3) validates exact RETURNING rows for both mutations before commit
 *
 * Receives exact frozen install payload from the verified-grant custody adapter
 * (INSTALL_KEYS order). No tokens, no AAD bytes, no routes/callback/Azure/live.
 *
 * AAD policy: rebuilds canonical gen-1 AAD identity (client+endpoint+generation+
 * operation) only as far as the envelope contract permits — proving those four
 * fields form a valid AAD. AAD is NOT stored on the envelope row. The custody
 * adapter is responsible for ciphertext AAD binding at seal time; this installer
 * atomically binds durable row identity (ids + verified identity columns). Never
 * trust envelope material beyond operation_id match.
 *
 * Factory takes exact frozen deps { client } where client is a pinned transaction
 * client (query only surface required; pool/connect counters rejected). Returns
 * exact frozen { installVerifiedGrant }. Single-use atomic burn at entry of
 * installVerifiedGrant (before input reflection/validation/SQL): first call
 * (even malformed/hostile) burns the installer; concurrent/reentrant/second
 * attempts fail sanitized with zero further SQL. One fixed sanitized thrown error.
 *
 * Preflight is provider-discriminated before any SQL: Microsoft tenant/principal
 * identifiers remain canonical lowercase hyphenated UUIDs; Gmail requires the
 * canonical Google issuer and a case-sensitive 1–255 ASCII `sub`. The accepted
 * principal is written to both provider_principal_oid and provider_resource_id.
 *
 * Driver rows: every SELECT/RETURNING row is validated as exact own-data keys
 * (SQL textual order constants; exact set, safe prototype, no accessors/symbols/
 * extras) and snapshotted into a fresh frozen record before later use. Lock
 * eligibility + UPDATE CAS use only snapshot.bindingStatus (never reread the
 * mutable driver row).
 *
 * @module email-verified-grant-installer
 */

const {
  buildGrantEnvelopeAadV1,
  validateGrantEnvelopeRecordV1,
} = require('./email-grant-envelope-provider-contract');

const ERROR_CODE = 'EMAIL_VERIFIED_GRANT_INSTALLER_INVALID';
const ERROR_MESSAGE = 'Email verified grant install failed.';
const MICROSOFT_ERROR = Object.freeze({
  code: 'MICROSOFT_VERIFIED_GRANT_INSTALLER_INVALID',
  message: 'Microsoft verified grant install failed.',
  name: 'MicrosoftVerifiedGrantInstallerError',
});
const NEUTRAL_ERROR = Object.freeze({
  code: ERROR_CODE, message: ERROR_MESSAGE, name: 'EmailVerifiedGrantInstallerError',
});
const GRANT_GENERATION_INITIAL = 1;
const INSTALLER_METHOD = 'installVerifiedGrant';
const INSTALLER_ACK_STATUS = 'installed';
const INSTALLER_ACK = Object.freeze({ status: INSTALLER_ACK_STATUS });

const DEPENDENCY_KEYS = Object.freeze(['client']);
/** Exact install input key order — matches custody adapter INSTALL_KEYS. */
const INSTALL_KEYS = Object.freeze([
  'clientId',
  'endpointId',
  'operationId',
  'actorStaffUserId',
  'identity',
  'envelope',
]);
const IDENTITY_KEYS = Object.freeze([
  'providerTenantId',
  'providerPrincipalId',
  'mailboxAddress',
  'displayName',
]);

/** Initial-only eligible binding statuses (reconnect is a separate future flow). */
const ELIGIBLE_BINDING_STATUSES = Object.freeze([
  'unverified_offline',
  'pending_manual_validation',
]);
const ELIGIBLE_BINDING_SET = new Set(ELIGIBLE_BINDING_STATUSES);

const TOKEN_AND_AAD_KEYS = Object.freeze([
  'accessToken', 'refreshToken', 'idToken', 'access_token', 'refresh_token',
  'id_token', 'aad', 'authorization_code', 'code', 'token', 'client_secret',
  'envelopeProvider',
]);

const PRINCIPAL_LIMIT = 256;
const MAILBOX_MIN = 3;
const MAILBOX_MAX = 254;
/** Same canonical lowercase hyphenated UUID grammar as migration 058 provider_*_shape. */
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_MAILBOX_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_SUB_RE = /^[\x21-\x7e]{1,255}$/;
const PROVIDERS = Object.freeze({
  microsoft: Object.freeze({
    provider: 'microsoft_graph', authMode: 'delegated_authorization_code',
    connectorMode: 'microsoft_delegated_oauth',
  }),
  gmail: Object.freeze({
    provider: 'gmail_api', authMode: 'delegated_authorization_code',
    connectorMode: 'google_delegated_oauth',
  }),
});

const ENVELOPE_COLS = 'envelope_version, aead_alg, kek_wrap_alg, kek_key_name, kek_key_version, nonce, ciphertext, auth_tag, wrapped_dek';

/**
 * Exact own-data key sets for driver rows (SQL textual order). node-postgres assigns
 * keys in SELECT/RETURNING field order; we enforce exact set membership (no extras/
 * symbols/accessors) rather than fragile Reflect.ownKeys order equality, while
 * keeping these constants aligned with SQL text for maintainable assertions.
 */
const LOCK_ROW_KEYS = Object.freeze([
  'id', 'client_id', 'provider', 'auth_mode', 'connector_mode', 'binding_status', 'public_address',
]);
const GRANT_RETURNING_KEYS = Object.freeze([
  'client_id', 'endpoint_id', 'grant_generation', 'grant_status', 'reconcile_state',
]);
const UPDATE_RETURNING_KEYS = Object.freeze([
  'id', 'client_id', 'binding_status', 'provider_tenant_id', 'provider_principal_oid',
  'provider_resource_id', 'mailbox_kind', 'mailbox_access_kind', 'public_address',
]);
const LOCK_ROW_KEY_SET = new Set(LOCK_ROW_KEYS);
const GRANT_RETURNING_KEY_SET = new Set(GRANT_RETURNING_KEYS);
const UPDATE_RETURNING_KEY_SET = new Set(UPDATE_RETURNING_KEYS);

const SQL_BEGIN = 'BEGIN';
const SQL_COMMIT = 'COMMIT';
const SQL_ROLLBACK = 'ROLLBACK';

const SQL_LOCK_ENDPOINT = `
  SELECT id, client_id, provider, auth_mode, connector_mode, binding_status, public_address
    FROM tenant_channel_endpoints
   WHERE client_id = $1 AND id = $2
   FOR UPDATE`;

const SQL_INSERT_GRANT = `
  INSERT INTO tenant_email_delegated_grants (
    client_id, endpoint_id, grant_generation, grant_status, last_operation_id, reconcile_state,
    ${ENVELOPE_COLS}, created_by, updated_by
  ) VALUES ($1,$2,1,'active',$3,'clean',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
  RETURNING client_id, endpoint_id, grant_generation, grant_status, reconcile_state`;

function sqlUpdateEndpoint(provider) {
  return `
  UPDATE tenant_channel_endpoints
     SET provider_tenant_id = $3,
         provider_principal_oid = $4,
         provider_resource_id = $5,
         mailbox_kind = 'user',
         mailbox_access_kind = 'own_user',
         binding_status = 'verified',
         updated_by = $6,
         updated_at = NOW()
   WHERE client_id = $1
     AND id = $2
     AND provider = '${provider.provider}'
     AND auth_mode = 'delegated_authorization_code'
     AND connector_mode = '${provider.connectorMode}'
     AND binding_status = $7
     AND public_address = $8
  RETURNING id, client_id, binding_status, provider_tenant_id, provider_principal_oid,
            provider_resource_id, mailbox_kind, mailbox_access_kind, public_address`;
}

function failure(errorIdentity = NEUTRAL_ERROR) {
  const error = new Error(errorIdentity.message);
  Object.defineProperty(error, 'name', { value: errorIdentity.name });
  Object.defineProperty(error, 'code', { value: errorIdentity.code, enumerable: true });
  return Object.freeze(error);
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
    if (!object || Object.getPrototypeOf(object) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(object);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
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

function exactFrozenData(object, keys) {
  return Boolean(object && Object.isFrozen(object) && exactPlainData(object, keys));
}

/**
 * Exact own-data DB row surface for node-postgres SELECT/RETURNING rows.
 * Safe prototypes only (Object.prototype or null — pg prebuild uses null then
 * spreads to Object.prototype). Exact key *set* (no order equality dependency),
 * no symbols/accessors/extras. Values read via own data descriptors only.
 * @param {unknown} row
 * @param {readonly string[]} keys SQL textual order constant
 * @param {Set<string>} keySet
 * @returns {object|null} plain snapshot of own data values, or null
 */
function snapshotExactOwnDataRow(row, keys, keySet) {
  try {
    if (!row || typeof row !== 'object') return null;
    const proto = Object.getPrototypeOf(row);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(row);
    if (actual.length !== keys.length) return null;
    for (const key of actual) {
      if (typeof key !== 'string' || !keySet.has(key)) return null;
    }
    const out = Object.create(null);
    for (const key of keys) {
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
    return out;
  } catch {
    return null;
  }
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function boundedOidcText(value, max) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && !hasUnpairedSurrogate(value)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isCanonicalUuid(value) {
  return typeof value === 'string' && UUID_CANON.test(value);
}

function isCanonicalGraphMailbox(value) {
  if (typeof value !== 'string'
      || value.length < MAILBOX_MIN
      || value.length > MAILBOX_MAX
      || /[\u0000-\u001f\u007f]/.test(value)) {
    return false;
  }
  if (value !== value.trim() || value !== value.toLowerCase()) return false;
  if (!CANONICAL_MAILBOX_RE.test(value) || value.includes('..')) return false;
  return true;
}

function isCanonicalGmailAddress(value) {
  if (typeof value !== 'string' || value.length < MAILBOX_MIN || value.length > MAILBOX_MAX
      || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const folded = value.toLowerCase();
  return CANONICAL_MAILBOX_RE.test(folded) && !folded.includes('..');
}

/**
 * Pool exposes connect + connection counters; a pinned Client does not share
 * that surface. Reject pools so install cannot open nested connections.
 */
function looksLikePgPool(obj) {
  return Boolean(
    obj
    && typeof obj === 'object'
    && typeof obj.connect === 'function'
    && (typeof obj.totalCount === 'number'
      || typeof obj.idleCount === 'number'
      || typeof obj.waitingCount === 'number'),
  );
}

function independentBufferCopy(source) {
  const copy = Buffer.alloc(source.length);
  source.copy(copy);
  return copy;
}

function hasForbiddenTokenOrAadKeys(object) {
  if (!object || typeof object !== 'object') return false;
  try {
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key === 'symbol') return true;
      if (TOKEN_AND_AAD_KEYS.includes(key)) return true;
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * Snapshot + validate exact frozen identity (custody adapter shape).
 * Microsoft keeps canonical UUID tenant/principal and lowercase Graph mailbox
 * semantics. Gmail keeps the canonical issuer, exact case-sensitive ASCII `sub`,
 * and a syntactically canonical mailbox address whose original case is preserved.
 * The principal is written to both principal/resource columns; displayName is
 * null|string and is never persisted here.
 */
function snapshotAndValidateIdentity(value) {
  if (!exactFrozenData(value, IDENTITY_KEYS)) return null;
  const providerTenantId = ownData(value, 'providerTenantId');
  const providerPrincipalId = ownData(value, 'providerPrincipalId');
  const mailboxAddress = ownData(value, 'mailboxAddress');
  const displayName = ownData(value, 'displayName');

  let providerKey;
  if (isCanonicalUuid(providerTenantId)
      && boundedOidcText(providerPrincipalId, PRINCIPAL_LIMIT)
      && isCanonicalUuid(providerPrincipalId)
      && isCanonicalGraphMailbox(mailboxAddress)) {
    providerKey = 'microsoft';
  } else if (providerTenantId === GOOGLE_ISSUER
      && typeof providerPrincipalId === 'string'
      && GOOGLE_SUB_RE.test(providerPrincipalId)
      && isCanonicalGmailAddress(mailboxAddress)) {
    providerKey = 'gmail';
  } else {
    return null;
  }
  if (displayName !== null) {
    if (typeof displayName !== 'string'
        || displayName.length < 1
        || displayName.length > PRINCIPAL_LIMIT
        || /[\u0000-\u001f\u007f]/.test(displayName)
        || hasUnpairedSurrogate(displayName)) {
      return null;
    }
  }
  return Object.freeze({
    providerKey,
    providerTenantId,
    providerPrincipalId,
    mailboxAddress,
    displayName,
  });
}

/**
 * Snapshot lock-row observations once into a fresh frozen record.
 * Never reread the mutable driver row after this returns.
 */
function snapshotAndValidateLockRow(row, clientId, endpointId) {
  const own = snapshotExactOwnDataRow(row, LOCK_ROW_KEYS, LOCK_ROW_KEY_SET);
  if (!own) return null;
  if (own.id !== endpointId || own.client_id !== clientId) return null;
  if (typeof own.provider !== 'string'
      || typeof own.auth_mode !== 'string'
      || typeof own.connector_mode !== 'string') {
    return null;
  }
  // binding_status may be null (ineligible); public_address must be string when compared later.
  if (own.binding_status != null && typeof own.binding_status !== 'string') return null;
  if (own.public_address != null && typeof own.public_address !== 'string') return null;
  return Object.freeze({
    id: own.id,
    clientId: own.client_id,
    provider: own.provider,
    authMode: own.auth_mode,
    connectorMode: own.connector_mode,
    bindingStatus: own.binding_status,
    publicAddress: own.public_address,
  });
}

/**
 * INSERT RETURNING: exact keys; require returned client/endpoint exact + gen-1 state.
 */
function snapshotAndValidateGrantReturning(row, clientId, endpointId) {
  const own = snapshotExactOwnDataRow(row, GRANT_RETURNING_KEYS, GRANT_RETURNING_KEY_SET);
  if (!own) return null;
  if (own.client_id !== clientId || own.endpoint_id !== endpointId) return null;
  if (Number(own.grant_generation) !== GRANT_GENERATION_INITIAL
      || own.grant_status !== 'active'
      || own.reconcile_state !== 'clean') {
    return null;
  }
  return Object.freeze({
    clientId: own.client_id,
    endpointId: own.endpoint_id,
    grantGeneration: GRANT_GENERATION_INITIAL,
    grantStatus: 'active',
    reconcileState: 'clean',
  });
}

/**
 * UPDATE RETURNING: exact keys/order as SQL; require id/client_id exact + identity/state.
 */
function snapshotAndValidateUpdateReturning(row, snap) {
  const own = snapshotExactOwnDataRow(row, UPDATE_RETURNING_KEYS, UPDATE_RETURNING_KEY_SET);
  if (!own) return null;
  if (own.id !== snap.endpointId || own.client_id !== snap.clientId) return null;
  if (own.binding_status !== 'verified'
      || own.provider_tenant_id !== snap.identity.providerTenantId
      || own.provider_principal_oid !== snap.identity.providerPrincipalId
      || own.provider_resource_id !== snap.identity.providerPrincipalId
      || own.mailbox_kind !== 'user'
      || own.mailbox_access_kind !== 'own_user'
      || own.public_address !== snap.identity.mailboxAddress) {
    return null;
  }
  return Object.freeze({
    id: own.id,
    clientId: own.client_id,
    bindingStatus: 'verified',
    providerTenantId: own.provider_tenant_id,
    providerPrincipalOid: own.provider_principal_oid,
    providerResourceId: own.provider_resource_id,
    mailboxKind: 'user',
    mailboxAccessKind: 'own_user',
    publicAddress: own.public_address,
  });
}

/**
 * Snapshot + validate exact frozen install input before any SQL.
 * Fresh envelope validation (independent buffer copies). operation match.
 * Rebuild gen-1 AAD identity as far as the envelope contract permits.
 */
function snapshotAndValidateInstallInput(input) {
  if (!exactFrozenData(input, INSTALL_KEYS)) return null;
  if (hasForbiddenTokenOrAadKeys(input)) return null;

  const clientId = ownData(input, 'clientId');
  const endpointId = ownData(input, 'endpointId');
  const operationId = ownData(input, 'operationId');
  const actorStaffUserId = ownData(input, 'actorStaffUserId');
  const identityRaw = ownData(input, 'identity');
  const envelopeRaw = ownData(input, 'envelope');

  if (!isCanonicalUuid(clientId) || !isCanonicalUuid(endpointId) || !isCanonicalUuid(operationId)) {
    return null;
  }
  if (actorStaffUserId !== null && !isCanonicalUuid(actorStaffUserId)) return null;

  const identity = snapshotAndValidateIdentity(identityRaw);
  if (!identity) return null;
  if (hasForbiddenTokenOrAadKeys(identity)) return null;

  let env;
  try {
    env = validateGrantEnvelopeRecordV1(envelopeRaw);
  } catch {
    return null;
  }
  if (!env || !env.ok) return null;
  if (env.value.operation_id !== operationId) return null;

  // Prove gen-1 AAD identity fields are well-formed. AAD bytes are not stored;
  // adapter owns ciphertext AAD; installer binds durable row identity.
  let aad;
  try {
    aad = buildGrantEnvelopeAadV1({
      clientId,
      endpointId,
      grantGeneration: GRANT_GENERATION_INITIAL,
      operationId,
    });
  } catch {
    return null;
  }
  if (!Buffer.isBuffer(aad) || aad.length < 1) return null;

  const envelope = Object.freeze({
    envelope_version: env.value.envelope_version,
    aead_alg: env.value.aead_alg,
    kek_wrap_alg: env.value.kek_wrap_alg,
    kek_key_name: env.value.kek_key_name,
    kek_key_version: env.value.kek_key_version,
    nonce: independentBufferCopy(env.value.nonce),
    ciphertext: independentBufferCopy(env.value.ciphertext),
    auth_tag: independentBufferCopy(env.value.auth_tag),
    wrapped_dek: independentBufferCopy(env.value.wrapped_dek),
    operation_id: env.value.operation_id,
  });

  return Object.freeze({
    clientId,
    endpointId,
    operationId,
    actorStaffUserId,
    identity,
    envelope,
  });
}

function pinTransactionClient(dependencies) {
  if (!exactFrozenData(dependencies, DEPENDENCY_KEYS)) return null;
  const client = ownData(dependencies, 'client');
  if (!client || typeof client !== 'object') return null;
  if (typeof client.query !== 'function') return null;
  if (looksLikePgPool(client)) return null;
  // Reject explicit pool/connect-only dependency surfaces smuggled as client.
  if (typeof client.connect === 'function'
      && typeof client.query === 'function'
      && (Object.prototype.hasOwnProperty.call(client, 'totalCount')
        || Object.prototype.hasOwnProperty.call(client, 'idleCount')
        || Object.prototype.hasOwnProperty.call(client, 'waitingCount'))) {
    return null;
  }
  return client;
}

async function rollbackQuiet(client) {
  try {
    await client.query(SQL_ROLLBACK);
  } catch {
    /* sanitized: never leak rollback errors */
  }
}

async function insertGrant(client, snap, errorIdentity) {
  const e = snap.envelope;
  const actor = snap.actorStaffUserId;
  const inserted = await client.query(SQL_INSERT_GRANT, [
    snap.clientId, snap.endpointId, snap.operationId, e.envelope_version, e.aead_alg,
    e.kek_wrap_alg, e.kek_key_name, e.kek_key_version, e.nonce, e.ciphertext,
    e.auth_tag, e.wrapped_dek, actor,
  ]);
  if (!inserted || !Array.isArray(inserted.rows) || inserted.rows.length !== 1) {
    throw failure(errorIdentity);
  }
  if (!snapshotAndValidateGrantReturning(inserted.rows[0], snap.clientId, snap.endpointId)) {
    throw failure(errorIdentity);
  }
}

async function updateEndpoint(client, snap, lockSnap, provider, errorIdentity) {
  const actor = snap.actorStaffUserId;
  const updated = await client.query(sqlUpdateEndpoint(provider), [
    snap.clientId, snap.endpointId, snap.identity.providerTenantId,
    snap.identity.providerPrincipalId, snap.identity.providerPrincipalId, actor,
    lockSnap.bindingStatus, snap.identity.mailboxAddress,
  ]);
  if (!updated || !Array.isArray(updated.rows) || updated.rows.length !== 1
      || !snapshotAndValidateUpdateReturning(updated.rows[0], snap)) throw failure(errorIdentity);
}

/**
 * One short TX. Pre-COMMIT failure → ROLLBACK. After COMMIT attempt is sent,
 * never ROLLBACK (commit outcome ambiguity → fixed sanitized failure).
 */
async function installInTransaction(client, snap, allowedProviderKeys, errorIdentity) {
  let began = false;
  let commitSent = false;
  try {
    await client.query(SQL_BEGIN);
    began = true;
    const locked = await client.query(SQL_LOCK_ENDPOINT, [snap.clientId, snap.endpointId]);
    if (!locked || !Array.isArray(locked.rows) || locked.rows.length !== 1) throw failure(errorIdentity);
    const lockSnap = snapshotAndValidateLockRow(locked.rows[0], snap.clientId, snap.endpointId);
    const provider = PROVIDERS[snap.identity.providerKey];
    if (!lockSnap || !provider || !allowedProviderKeys.has(snap.identity.providerKey)
        || lockSnap.provider !== provider.provider || lockSnap.authMode !== provider.authMode
        || lockSnap.connectorMode !== provider.connectorMode) throw failure(errorIdentity);
    if (lockSnap.bindingStatus == null || !ELIGIBLE_BINDING_SET.has(lockSnap.bindingStatus)) {
      throw failure(errorIdentity);
    }
    if (typeof lockSnap.publicAddress !== 'string'
        || lockSnap.publicAddress !== snap.identity.mailboxAddress) throw failure(errorIdentity);

    if (snap.identity.providerKey === 'gmail') {
      await updateEndpoint(client, snap, lockSnap, provider, errorIdentity);
      await insertGrant(client, snap, errorIdentity);
    } else {
      // Preserve the Microsoft install's existing INSERT → UPDATE statement order.
      await insertGrant(client, snap, errorIdentity);
      await updateEndpoint(client, snap, lockSnap, provider, errorIdentity);
    }
    commitSent = true;
    await client.query(SQL_COMMIT);
    began = false;
    commitSent = false;
    return INSTALLER_ACK;
  } catch (err) {
    if (commitSent) throw failure(errorIdentity);
    if (began) await rollbackQuiet(client);
    if (err && err.code === errorIdentity.code) throw err;
    throw failure(errorIdentity);
  }
}

function createVerifiedGrantInstallerInternal(dependencies, allowedProviderKeys, errorIdentity) {
  let client;
  try {
    client = pinTransactionClient(dependencies);
    if (!client) throw failure(errorIdentity);
  } catch {
    throw failure(errorIdentity);
  }
  let used = false;
  async function installVerifiedGrant(input) {
    if (used) throw failure(errorIdentity);
    used = true;
    let snap;
    try {
      snap = snapshotAndValidateInstallInput(input);
      if (!snap) throw failure(errorIdentity);
    } catch {
      throw failure(errorIdentity);
    }
    try {
      return await installInTransaction(client, snap, allowedProviderKeys, errorIdentity);
    } catch (err) {
      if (err && err.code === errorIdentity.code) throw err;
      throw failure(errorIdentity);
    }
  }
  return Object.freeze({ installVerifiedGrant });
}

const ALL_PROVIDER_KEYS = new Set(['microsoft', 'gmail']);
const MICROSOFT_PROVIDER_KEYS = new Set(['microsoft']);
function createVerifiedGrantInstaller(dependencies) {
  return createVerifiedGrantInstallerInternal(dependencies, ALL_PROVIDER_KEYS, NEUTRAL_ERROR);
}
function createMicrosoftOnlyVerifiedGrantInstaller(dependencies) {
  return createVerifiedGrantInstallerInternal(dependencies, MICROSOFT_PROVIDER_KEYS, MICROSOFT_ERROR);
}

module.exports = Object.freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  GRANT_GENERATION_INITIAL,
  INSTALLER_METHOD,
  INSTALLER_ACK_STATUS,
  INSTALLER_ACK,
  INSTALL_KEYS,
  IDENTITY_KEYS,
  DEPENDENCY_KEYS,
  ELIGIBLE_BINDING_STATUSES,
  LOCK_ROW_KEYS,
  GRANT_RETURNING_KEYS,
  UPDATE_RETURNING_KEYS,
  createVerifiedGrantInstaller,
  createMicrosoftOnlyVerifiedGrantInstaller,
});
