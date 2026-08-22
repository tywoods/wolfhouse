'use strict';

/**
 * Sunset IMAP/SMTP identity register — EMAIL-SMTP-002.
 *
 * Transactionally inserts exactly one disabled `imap_smtp` endpoint for trusted
 * Sunset when the five approved opaque Key Vault secret *references* are
 * configured. No IMAP poll, SMTP socket, provider call, send, activation, or
 * secret material. Ack never includes secret_ref or mailbox echo beyond the
 * caller-supplied address already known to the route.
 *
 * Factory: exact frozen { client, env }. Pool rejected. Single-use.
 *
 * TX lock order (deadlock-free, fixed):
 *   BEGIN → prove Sunset clients row FOR UPDATE → active location FOR SHARE →
 *   location advisory (clientId + smtp-ep-reg-loc:) → existing-by-location
 *   (same canonical address → existing forced-disabled ack, zero INSERT;
 *   different address → fail, no alias) → address advisory
 *   (clientId + smtp-ep-reg-addr:) → existing-by-address → INSERT → COMMIT.
 *
 * Forced constants live in SQL text: channel, provider, opaque identity
 * secret_ref, inbound/outbound/active false, automation off, NULL identity
 * columns (imap_smtp must remain unclassified per 073).
 *
 * @module email-sunset-smtp-identity-register
 */

let intrinsicIsProxy;
try {
  intrinsicIsProxy = require('node:util').types.isProxy;
} catch {
  intrinsicIsProxy = null;
}

const {
  EMAIL_SMTP_IDENTITY_PATH,
  SUNSET_SMTP_IDENTITY_SECRET_REF,
  isSunsetEmailSmtpIdentityRegisterEnabled,
  evaluateSunsetSmtpSecretRefs,
} = require('./email-sunset-smtp-secret-ref-contract');
const {
  EMAIL_MAILBOX_CAPABILITY_KEYS,
  normalizeEmailPublicAddress,
  validateCanonicalLocationId,
  validateEmailMailboxSecretRef,
} = require('./email-mailbox-adapter-contract');

const ERROR_CODE = 'SUNSET_SMTP_IDENTITY_REGISTER_INVALID';
const ERROR_MESSAGE = 'Sunset SMTP identity register failed.';
const MISSING_SECRET_CODE = 'SUNSET_SMTP_SECRET_REFS_MISSING';
const DEPENDENCY_KEYS = Object.freeze(['client', 'env']);
const INPUT_KEYS = Object.freeze([
  'clientId',
  'locationId',
  'publicAddress',
  'actorStaffUserId',
]);
const ACK_KEYS = Object.freeze([
  'endpointId',
  'provider',
  'inbound_enabled',
  'outbound_enabled',
  'active',
  'default_automation_mode',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLIC_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROVIDER = 'imap_smtp';
const AUTOMATION_OFF = 'off';

const FORCED_CAPABILITIES = Object.freeze(
  EMAIL_MAILBOX_CAPABILITY_KEYS.reduce((acc, key) => {
    acc[key] = false;
    return acc;
  }, {}),
);
const FORCED_CAPABILITIES_JSON = JSON.stringify(FORCED_CAPABILITIES);

const SQL_BEGIN = 'BEGIN';
const SQL_COMMIT = 'COMMIT';
const SQL_ROLLBACK = 'ROLLBACK';
const SQL_PROVE_SUNSET_CLIENT = "SELECT id::text AS client_id FROM clients WHERE slug = 'sunset' AND id = $1::uuid LIMIT 1 FOR UPDATE";
const SQL_LOCK_ACTIVE_LOCATION = 'SELECT location_id FROM tenant_locations WHERE client_id = $1::uuid AND location_id = $2 AND active = true FOR SHARE';
const SQL_ADVISORY_LOCK = 'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))';
const LOCK_NS_LOCATION = 'smtp-ep-reg-loc:';
const LOCK_NS_ADDRESS = 'smtp-ep-reg-addr:';
const SQL_EXISTING_BY_LOCATION = "SELECT id, public_address, inbound_enabled, outbound_enabled, active, default_automation_mode FROM tenant_channel_endpoints WHERE client_id = $1::uuid AND location_id = $2 AND provider = 'imap_smtp' LIMIT 1 FOR UPDATE";
const SQL_UNREVOKE_EXISTING = "UPDATE tenant_channel_endpoints SET binding_status = NULL, smtp_health_verified_at = NULL, inbound_enabled = false, outbound_enabled = false, active = false, updated_at = NOW(), updated_by = $3::uuid WHERE id = $1::uuid AND client_id = $2::uuid AND provider = 'imap_smtp' RETURNING id";
const SQL_EXISTING_BY_ADDRESS = "SELECT id FROM tenant_channel_endpoints WHERE client_id = $1::uuid AND lower(public_address) = lower($2) AND provider = 'imap_smtp' LIMIT 1 FOR UPDATE";
const SQL_INSERT_ENDPOINT = `INSERT INTO tenant_channel_endpoints (
  client_id, location_id, channel, provider, public_address, secret_ref,
  provider_resource_id, capabilities, inbound_enabled, outbound_enabled,
  default_automation_mode, active, auth_mode, connector_mode,
  provider_tenant_id, provider_principal_oid, mailbox_kind, mailbox_access_kind,
  binding_status, created_by, updated_by
) VALUES (
  $1::uuid, $2, 'email', 'imap_smtp', $3,
  'secret-ref:email/smtp/sunset-staging', NULL, $4::jsonb,
  false, false, 'off', false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  $5::uuid, $5::uuid
) RETURNING id`.replace(/\s+/g, ' ').trim();

function failure() {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  return error;
}

function isProxyOrUnknown(value) {
  if (typeof intrinsicIsProxy !== 'function') return true;
  try { return intrinsicIsProxy(value) === true; } catch { return true; }
}

function ownValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function exactFrozenData(object, keys) {
  try {
    if (!object || Object.getPrototypeOf(object) !== Object.prototype || !Object.isFrozen(object)) {
      return false;
    }
    const actual = Reflect.ownKeys(object);
    return actual.length === keys.length && actual.every((key, index) => key === keys[index])
      && keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
      });
  } catch {
    return false;
  }
}

function missingSecretsError(names) {
  const list = Array.isArray(names) ? names.filter((name) => typeof name === 'string') : [];
  const error = new Error('missing_secret_names');
  error.code = MISSING_SECRET_CODE;
  error.missing_secret_names = Object.freeze(list.slice());
  return error;
}

function snapshotInput(input) {
  if (isProxyOrUnknown(input)) return null;
  if (!exactFrozenData(input, INPUT_KEYS)) return null;
  const values = INPUT_KEYS.map((key) => ownValue(input, key));
  const [clientId, locationId, rawAddress, actorStaffUserId] = values;
  if (!UUID.test(clientId) || !UUID.test(actorStaffUserId) || typeof rawAddress !== 'string') {
    return null;
  }
  const location = validateCanonicalLocationId(locationId);
  const publicAddress = normalizeEmailPublicAddress(rawAddress);
  if (!location.ok || !publicAddress || publicAddress.length > 320
      || !PUBLIC_ADDRESS_RE.test(publicAddress)) {
    return null;
  }
  return Object.freeze({
    clientId,
    locationId: location.value,
    publicAddress,
    actorStaffUserId,
  });
}

function rows(result) {
  return result && Array.isArray(result.rows) ? result.rows : null;
}

function one(result, key, expected) {
  const list = rows(result);
  if (!list || list.length !== 1) throw failure();
  const value = list[0] && list[0][key];
  if (value == null || (expected !== undefined && String(value).toLowerCase() !== expected)) {
    throw failure();
  }
  return String(value).toLowerCase();
}

function pinQuery(dependencies) {
  try {
    if (isProxyOrUnknown(dependencies)) throw failure();
    if (!exactFrozenData(dependencies, DEPENDENCY_KEYS)) throw failure();
    const client = ownValue(dependencies, 'client');
    const env = ownValue(dependencies, 'env');
    if (isProxyOrUnknown(client) || isProxyOrUnknown(env)) throw failure();
    if (!client || typeof client !== 'object' || Array.isArray(client)) throw failure();
    if (!env || typeof env !== 'object' || Array.isArray(env)) throw failure();
    const descriptor = Object.getOwnPropertyDescriptor(client, 'query');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
      throw failure();
    }
    if (typeof client.connect === 'function'
        || ['totalCount', 'idleCount', 'waitingCount'].some((k) => k in client)) {
      throw failure();
    }
    return {
      query: descriptor.value.bind(client),
      env,
    };
  } catch {
    throw failure();
  }
}

function disabledAck(endpointId) {
  return Object.freeze({
    endpointId,
    provider: PROVIDER,
    inbound_enabled: false,
    outbound_enabled: false,
    active: false,
    default_automation_mode: AUTOMATION_OFF,
  });
}

function createSunsetSmtpIdentityRegister(dependencies) {
  const pinned = pinQuery(dependencies);
  const query = pinned.query;
  const env = pinned.env;
  if (validateEmailMailboxSecretRef(SUNSET_SMTP_IDENTITY_SECRET_REF).ok !== true) {
    throw failure();
  }
  let used = false;

  async function registerDisabledImapSmtpIdentity(input) {
    if (used) throw failure();
    used = true;
    if (!isSunsetEmailSmtpIdentityRegisterEnabled(env)) throw failure();
    const secrets = evaluateSunsetSmtpSecretRefs(env);
    if (!secrets.ok) throw missingSecretsError(secrets.missing_secret_names);
    const data = snapshotInput(input);
    if (!data) throw failure();
    let began = false;
    let commitAttempted = false;
    try {
      await query(SQL_BEGIN);
      began = true;
      const clientId = one(await query(SQL_PROVE_SUNSET_CLIENT, [data.clientId]), 'client_id', data.clientId);
      one(await query(SQL_LOCK_ACTIVE_LOCATION, [clientId, data.locationId]), 'location_id', data.locationId);
      await query(SQL_ADVISORY_LOCK, [clientId, LOCK_NS_LOCATION + data.locationId]);
      const existingRows = rows(await query(SQL_EXISTING_BY_LOCATION, [clientId, data.locationId]));
      if (!existingRows) throw failure();
      if (existingRows.length === 1) {
        const existing = existingRows[0];
        const existingId = existing && existing.id != null ? String(existing.id).toLowerCase() : '';
        if (!UUID.test(existingId)) throw failure();
        const existingAddress = normalizeEmailPublicAddress(existing.public_address);
        if (!existingAddress || existingAddress !== data.publicAddress) throw failure();
        if (existing.inbound_enabled !== false
            || existing.outbound_enabled !== false
            || existing.active !== false
            || String(existing.default_automation_mode) !== AUTOMATION_OFF) {
          throw failure();
        }
        const reused = one(await query(SQL_UNREVOKE_EXISTING, [
          existingId,
          clientId,
          data.actorStaffUserId,
        ]), 'id', existingId);
        if (!reused) throw failure();
        commitAttempted = true;
        await query(SQL_COMMIT);
        return disabledAck(existingId);
      }
      if (existingRows.length !== 0) throw failure();
      await query(SQL_ADVISORY_LOCK, [clientId, LOCK_NS_ADDRESS + data.publicAddress]);
      if (rows(await query(SQL_EXISTING_BY_ADDRESS, [clientId, data.publicAddress]))?.length !== 0) {
        throw failure();
      }
      const endpointId = one(await query(SQL_INSERT_ENDPOINT, [
        clientId,
        data.locationId,
        data.publicAddress,
        FORCED_CAPABILITIES_JSON,
        data.actorStaffUserId,
      ]), 'id');
      if (!UUID.test(endpointId)) throw failure();
      commitAttempted = true;
      await query(SQL_COMMIT);
      return disabledAck(endpointId);
    } catch (err) {
      if (began && !commitAttempted) {
        try { await query(SQL_ROLLBACK); } catch { /* sanitized */ }
      }
      if (err && err.code === MISSING_SECRET_CODE) throw err;
      throw failure();
    }
  }

  return Object.freeze({ registerDisabledImapSmtpIdentity });
}

module.exports = Object.freeze({
  EMAIL_SMTP_IDENTITY_PATH,
  ERROR_CODE,
  ERROR_MESSAGE,
  MISSING_SECRET_CODE,
  INPUT_KEYS,
  ACK_KEYS,
  DEPENDENCY_KEYS,
  FORCED_CAPABILITIES,
  FORCED_CAPABILITIES_JSON,
  SQL_BEGIN,
  SQL_COMMIT,
  SQL_ROLLBACK,
  SQL_PROVE_SUNSET_CLIENT,
  SQL_LOCK_ACTIVE_LOCATION,
  SQL_ADVISORY_LOCK,
  LOCK_NS_LOCATION,
  LOCK_NS_ADDRESS,
  SQL_EXISTING_BY_LOCATION,
  SQL_EXISTING_BY_ADDRESS,
  SQL_INSERT_ENDPOINT,
  createSunsetSmtpIdentityRegister,
});
