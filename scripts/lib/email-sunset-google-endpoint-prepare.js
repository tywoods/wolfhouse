'use strict';

let intrinsicIsProxy;
try {
  intrinsicIsProxy = require('node:util').types.isProxy;
} catch {
  intrinsicIsProxy = null;
}

const {
  normalizeEmailPublicAddress,
  validateCanonicalLocationId,
} = require('./email-mailbox-adapter-contract');

const ERROR_CODE = 'SUNSET_GOOGLE_ENDPOINT_PREPARE_INVALID';
const ERROR_MESSAGE = 'Sunset Google endpoint prepare failed.';
const INPUT_KEYS = Object.freeze(['clientId', 'locationId', 'publicAddress', 'actorStaffUserId']);
const ACK_KEYS = Object.freeze(['endpointId']);
const FORCED_CAPABILITIES = Object.freeze({
  push_notifications: false,
  provider_threads: true,
  remote_drafts: true,
  reply: true,
  reply_all: true,
  forward: true,
  attachments_metadata: true,
  delivery_events: false,
});
const FORCED_CAPABILITIES_JSON = JSON.stringify(FORCED_CAPABILITIES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SQL_BEGIN = 'BEGIN';
const SQL_COMMIT = 'COMMIT';
const SQL_ROLLBACK = 'ROLLBACK';
const SQL_PROVE_SUNSET_CLIENT = "SELECT id::text AS client_id FROM clients WHERE slug = 'sunset' AND id = $1::uuid LIMIT 1 FOR UPDATE";
const SQL_LOCK_ACTIVE_LOCATION = 'SELECT location_id FROM tenant_locations WHERE client_id = $1::uuid AND location_id = $2 AND active = true FOR SHARE';
const SQL_ADVISORY_LOCK = 'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))';
const LOCK_NS_LOCATION = 'google-ep-prep-loc:';
const LOCK_NS_ADDRESS = 'google-ep-prep-addr:';
const SQL_EXISTING_BY_LOCATION = "SELECT id FROM tenant_channel_endpoints WHERE client_id = $1::uuid AND location_id = $2 AND provider = 'gmail_api' LIMIT 1 FOR UPDATE";
const SQL_EXISTING_BY_ADDRESS = "SELECT id FROM tenant_channel_endpoints WHERE client_id = $1::uuid AND lower(public_address) = lower($2) AND provider = 'gmail_api' LIMIT 1 FOR UPDATE";
const SQL_INSERT_ENDPOINT = `INSERT INTO tenant_channel_endpoints (
  client_id, location_id, channel, provider, public_address, secret_ref,
  provider_resource_id, capabilities, inbound_enabled, outbound_enabled,
  default_automation_mode, active, auth_mode, connector_mode,
  provider_tenant_id, provider_principal_oid, mailbox_kind, mailbox_access_kind,
  binding_status, created_by, updated_by
) VALUES (
  $1::uuid, $2, 'email', 'gmail_api', $3,
  'secret-ref:email/google/sunset-staging-oauth-client', NULL, $4::jsonb,
  false, false, 'off', false, 'delegated_authorization_code',
  'google_delegated_oauth', NULL, NULL, NULL, NULL, 'unverified_offline',
  $5::uuid, $5::uuid
) RETURNING id`.replace(/\s+/g, ' ').trim();

function failure() {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  return error;
}
function isProxyOrUnknown(value) {
  if (typeof intrinsicIsProxy !== 'function') return true;
  try { return intrinsicIsProxy(value); } catch { return true; }
}
function ownValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function exactFrozenData(object, keys) {
  try {
    if (!object || Object.getPrototypeOf(object) !== Object.prototype || !Object.isFrozen(object)) return false;
    const actual = Reflect.ownKeys(object);
    return actual.length === keys.length && actual.every((key, index) => key === keys[index])
      && keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
      });
  } catch { return false; }
}
function snapshotInput(input) {
  if (isProxyOrUnknown(input)) return null;
  if (!exactFrozenData(input, INPUT_KEYS)) return null;
  const values = INPUT_KEYS.map((key) => ownValue(input, key));
  const [clientId, locationId, rawAddress, actorStaffUserId] = values;
  if (!UUID.test(clientId) || !UUID.test(actorStaffUserId) || typeof rawAddress !== 'string') return null;
  const location = validateCanonicalLocationId(locationId);
  const publicAddress = normalizeEmailPublicAddress(rawAddress);
  if (!location.ok || !publicAddress || publicAddress.length > 320
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(publicAddress)) return null;
  return Object.freeze({ clientId, locationId: location.value, publicAddress, actorStaffUserId });
}
function rows(result) {
  return result && Array.isArray(result.rows) ? result.rows : null; // native pg Result
}
function one(result, key, expected) {
  const list = rows(result);
  if (!list || list.length !== 1) throw failure();
  const value = list[0] && list[0][key];
  if (value == null || (expected !== undefined && String(value).toLowerCase() !== expected)) throw failure();
  return String(value).toLowerCase();
}
function pinQuery(dependencies) {
  try {
    if (isProxyOrUnknown(dependencies)) throw failure();
    if (!exactFrozenData(dependencies, ['client'])) throw failure();
    const client = ownValue(dependencies, 'client');
    if (isProxyOrUnknown(client)) throw failure();
    if (!client || typeof client !== 'object' || Array.isArray(client)) throw failure();
    const descriptor = Object.getOwnPropertyDescriptor(client, 'query');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') throw failure();
    if (typeof client.connect === 'function' || ['totalCount', 'idleCount', 'waitingCount'].some((k) => k in client)) throw failure();
    return descriptor.value.bind(client); // sole selection and receiver binding
  } catch { throw failure(); }
}

function createSunsetGoogleEndpointPrepare(dependencies) {
  const query = pinQuery(dependencies);
  let used = false;
  async function prepareDisabledDelegatedEndpoint(input) {
    if (used) throw failure();
    used = true;
    const data = snapshotInput(input);
    if (!data) throw failure();
    let began = false;
    let commitAttempted = false;
    try {
      await query(SQL_BEGIN); began = true;
      const clientId = one(await query(SQL_PROVE_SUNSET_CLIENT, [data.clientId]), 'client_id', data.clientId);
      one(await query(SQL_LOCK_ACTIVE_LOCATION, [clientId, data.locationId]), 'location_id', data.locationId);
      await query(SQL_ADVISORY_LOCK, [clientId, LOCK_NS_LOCATION + data.locationId]);
      if (rows(await query(SQL_EXISTING_BY_LOCATION, [clientId, data.locationId]))?.length !== 0) throw failure();
      await query(SQL_ADVISORY_LOCK, [clientId, LOCK_NS_ADDRESS + data.publicAddress]);
      if (rows(await query(SQL_EXISTING_BY_ADDRESS, [clientId, data.publicAddress]))?.length !== 0) throw failure();
      const endpointId = one(await query(SQL_INSERT_ENDPOINT, [
        clientId, data.locationId, data.publicAddress, FORCED_CAPABILITIES_JSON, data.actorStaffUserId,
      ]), 'id');
      if (!UUID.test(endpointId)) throw failure();
      commitAttempted = true;
      await query(SQL_COMMIT);
      return Object.freeze({ endpointId });
    } catch {
      if (began && !commitAttempted) { try { await query(SQL_ROLLBACK); } catch { /* sanitized */ } }
      throw failure();
    }
  }
  return Object.freeze({ prepareDisabledDelegatedEndpoint });
}

module.exports = Object.freeze({
  ERROR_CODE, ERROR_MESSAGE, INPUT_KEYS, ACK_KEYS, FORCED_CAPABILITIES,
  FORCED_CAPABILITIES_JSON, SQL_BEGIN, SQL_COMMIT, SQL_ROLLBACK,
  SQL_PROVE_SUNSET_CLIENT, SQL_LOCK_ACTIVE_LOCATION, SQL_ADVISORY_LOCK,
  LOCK_NS_LOCATION, LOCK_NS_ADDRESS, SQL_EXISTING_BY_LOCATION,
  SQL_EXISTING_BY_ADDRESS, SQL_INSERT_ENDPOINT, createSunsetGoogleEndpointPrepare,
});
