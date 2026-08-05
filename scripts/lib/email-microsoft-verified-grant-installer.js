'use strict';

/**
 * Stage 6 standalone atomic Microsoft verified-grant DB installer.
 *
 * Owns ONE short PostgreSQL transaction that atomically:
 *   1) locks the endpoint row FOR UPDATE
 *   2) inserts generation-1 active/clean sealed envelope into
 *      tenant_email_delegated_grants (actor audit)
 *   3) binds verified identity on the same endpoint (binding_status=verified)
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
 * @module email-microsoft-verified-grant-installer
 */

const {
  buildGrantEnvelopeAadV1,
  validateGrantEnvelopeRecordV1,
} = require('./email-grant-envelope-provider-contract');

const ERROR_CODE = 'MICROSOFT_VERIFIED_GRANT_INSTALLER_INVALID';
const ERROR_MESSAGE = 'Microsoft verified grant install failed.';
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
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_MAILBOX_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const ENVELOPE_COLS = 'envelope_version, aead_alg, kek_wrap_alg, kek_key_name, kek_key_version, nonce, ciphertext, auth_tag, wrapped_dek';

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

const SQL_UPDATE_ENDPOINT = `
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
     AND provider = 'microsoft_graph'
     AND auth_mode = 'delegated_authorization_code'
     AND connector_mode = 'microsoft_delegated_oauth'
     AND binding_status = $7
     AND public_address = $8
  RETURNING id, client_id, binding_status, provider_tenant_id, provider_principal_oid,
            provider_resource_id, mailbox_kind, mailbox_access_kind, public_address`;

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'MicrosoftVerifiedGrantInstallerError' });
  Object.defineProperty(error, 'code', { value: ERROR_CODE, enumerable: true });
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
 * providerTenantId: canonical UUID; principal: bounded OIDC text;
 * mailbox: already-canonical lowercase Graph form; displayName null|string.
 */
function snapshotAndValidateIdentity(value) {
  if (!exactFrozenData(value, IDENTITY_KEYS)) return null;
  const providerTenantId = ownData(value, 'providerTenantId');
  const providerPrincipalId = ownData(value, 'providerPrincipalId');
  const mailboxAddress = ownData(value, 'mailboxAddress');
  const displayName = ownData(value, 'displayName');

  if (!boundedOidcText(providerTenantId, PRINCIPAL_LIMIT) || !UUID_CANON.test(providerTenantId)) {
    return null;
  }
  if (!boundedOidcText(providerPrincipalId, PRINCIPAL_LIMIT)) return null;
  if (!isCanonicalGraphMailbox(mailboxAddress)) return null;
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
    providerTenantId,
    providerPrincipalId,
    mailboxAddress,
    displayName,
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

/**
 * One short TX. Pre-COMMIT failure → ROLLBACK. After COMMIT attempt is sent,
 * never ROLLBACK (commit outcome ambiguity → fixed sanitized failure).
 */
async function installInTransaction(client, snap) {
  let began = false;
  let commitSent = false;
  try {
    await client.query(SQL_BEGIN);
    began = true;

    const locked = await client.query(SQL_LOCK_ENDPOINT, [snap.clientId, snap.endpointId]);
    if (!locked || !Array.isArray(locked.rows) || locked.rows.length !== 1) {
      throw failure();
    }
    const row = locked.rows[0];
    if (row.provider !== 'microsoft_graph'
        || row.auth_mode !== 'delegated_authorization_code'
        || row.connector_mode !== 'microsoft_delegated_oauth') {
      throw failure();
    }
    if (row.binding_status == null || !ELIGIBLE_BINDING_SET.has(row.binding_status)) {
      // Reject null / verified / reauthorization_required / revoked (and unknowns).
      // Reconnect of already-verified endpoints is a separate future flow.
      throw failure();
    }
    // Canonical exact-equals: endpoint public_address must match verified mailbox.
    if (typeof row.public_address !== 'string'
        || row.public_address !== snap.identity.mailboxAddress) {
      throw failure();
    }

    const e = snap.envelope;
    const actor = snap.actorStaffUserId;
    const inserted = await client.query(SQL_INSERT_GRANT, [
      snap.clientId,
      snap.endpointId,
      snap.operationId,
      e.envelope_version,
      e.aead_alg,
      e.kek_wrap_alg,
      e.kek_key_name,
      e.kek_key_version,
      e.nonce,
      e.ciphertext,
      e.auth_tag,
      e.wrapped_dek,
      actor,
    ]);
    if (!inserted || !Array.isArray(inserted.rows) || inserted.rows.length !== 1) {
      throw failure();
    }
    const grantRow = inserted.rows[0];
    if (Number(grantRow.grant_generation) !== GRANT_GENERATION_INITIAL
        || grantRow.grant_status !== 'active'
        || grantRow.reconcile_state !== 'clean') {
      throw failure();
    }

    // provider_resource_id = providerPrincipalId (durable mailbox resource for ownership).
    const updated = await client.query(SQL_UPDATE_ENDPOINT, [
      snap.clientId,
      snap.endpointId,
      snap.identity.providerTenantId,
      snap.identity.providerPrincipalId,
      snap.identity.providerPrincipalId,
      actor,
      row.binding_status,
      snap.identity.mailboxAddress,
    ]);
    if (!updated || !Array.isArray(updated.rows) || updated.rows.length !== 1) {
      throw failure();
    }
    const ep = updated.rows[0];
    if (ep.binding_status !== 'verified'
        || ep.provider_tenant_id !== snap.identity.providerTenantId
        || ep.provider_principal_oid !== snap.identity.providerPrincipalId
        || ep.provider_resource_id !== snap.identity.providerPrincipalId
        || ep.mailbox_kind !== 'user'
        || ep.mailbox_access_kind !== 'own_user'
        || ep.public_address !== snap.identity.mailboxAddress) {
      throw failure();
    }

    commitSent = true;
    await client.query(SQL_COMMIT);
    began = false;
    commitSent = false;
    return INSTALLER_ACK;
  } catch (err) {
    if (commitSent) {
      // COMMIT dispatched; outcome unknown — never ROLLBACK after COMMIT attempt.
      throw failure();
    }
    if (began) await rollbackQuiet(client);
    const code = err && err.code != null ? String(err.code) : '';
    // SQLSTATE 23505 ownership / grant uniqueness conflict — sanitized.
    if (code === ERROR_CODE) throw err;
    throw failure();
  }
}

/**
 * @param {object} dependencies exact frozen { client } pinned transaction client
 * @returns {{ installVerifiedGrant: Function }} exact frozen single-use installer surface
 */
function createMicrosoftVerifiedGrantInstaller(dependencies) {
  let client;
  try {
    client = pinTransactionClient(dependencies);
    if (!client) throw failure();
  } catch {
    throw failure();
  }

  let used = false;
  async function installVerifiedGrant(input) {
    if (used) throw failure();
    used = true; // Atomic burn before input reflection, validation, await, or SQL.
    let snap;
    try {
      snap = snapshotAndValidateInstallInput(input);
      if (!snap) throw failure();
    } catch {
      throw failure();
    }

    try {
      return await installInTransaction(client, snap);
    } catch (err) {
      if (err && err.code === ERROR_CODE) throw err;
      throw failure();
    }
  }

  return Object.freeze({ installVerifiedGrant });
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
  createMicrosoftVerifiedGrantInstaller,
});
