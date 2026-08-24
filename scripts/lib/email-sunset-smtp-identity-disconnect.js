'use strict';

/**
 * Sunset IMAP/SMTP identity disconnect — EMAIL-SMTP-004.
 *
 * Removes the imap_smtp identity. Does not set binding_status (073 forbids
 * it for IMAP). No secret material, no socket, no send.
 *
 * @module email-sunset-smtp-identity-disconnect
 */

const {
  EMAIL_SMTP_DISCONNECT_PATH,
  isSunsetEmailSmtpIdentityRegisterEnabled,
} = require('./email-sunset-smtp-secret-ref-contract');
const { validateCanonicalLocationId } = require('./email-mailbox-adapter-contract');

const ERROR_CODE = 'SUNSET_SMTP_IDENTITY_DISCONNECT_INVALID';
const ERROR_MESSAGE = 'Sunset SMTP identity disconnect failed.';
const DEPENDENCY_KEYS = Object.freeze(['client', 'env']);
const INPUT_KEYS = Object.freeze(['clientId', 'locationId', 'endpointId', 'actorStaffUserId']);
const ACK_KEYS = Object.freeze(['endpointId', 'status']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SQL_BEGIN = 'BEGIN';
const SQL_COMMIT = 'COMMIT';
const SQL_ROLLBACK = 'ROLLBACK';
const SQL_PROVE_SUNSET_CLIENT = "SELECT id::text AS client_id FROM clients WHERE slug = 'sunset' AND id = $1::uuid LIMIT 1 FOR UPDATE";
const SQL_LOCK_ACTIVE_LOCATION = 'SELECT location_id FROM tenant_locations WHERE client_id = $1::uuid AND location_id = $2 AND active = true FOR SHARE';
const SQL_LOCK_ENDPOINT = "SELECT id::text AS endpoint_id FROM tenant_channel_endpoints WHERE id = $1::uuid AND client_id = $2::uuid AND location_id = $3 AND provider = 'imap_smtp' LIMIT 1 FOR UPDATE";
// imap_smtp must keep binding_status NULL (073). Disconnect deletes the identity.
const SQL_CLEAR_IMAP_CURSORS = 'DELETE FROM tenant_email_imap_fetch_cursors WHERE client_id = $1::uuid AND endpoint_id = $2::uuid';
const SQL_CLEAR_INBOX_PROJECTIONS = 'DELETE FROM tenant_email_inbound_inbox_projections WHERE client_id = $1::uuid AND endpoint_id = $2::uuid';
const SQL_CLEAR_DELTA_STATES = 'DELETE FROM tenant_email_inbound_delta_states WHERE client_id = $1::uuid AND endpoint_id = $2::uuid';
const SQL_CLEAR_INBOUND_EVENTS = 'DELETE FROM tenant_email_inbound_events WHERE client_id = $1::uuid AND endpoint_id = $2::uuid';
const SQL_CLEAR_OUTBOUND_JOURNAL = 'DELETE FROM tenant_email_outbound_send_journal WHERE client_id = $1::uuid AND endpoint_id = $2::uuid';
const SQL_CLEAR_REPLY_APPROVALS = 'DELETE FROM tenant_email_reply_approvals WHERE client_id = $1::uuid AND endpoint_id = $2::uuid';
const SQL_CLEAR_GRANTS = 'DELETE FROM tenant_email_delegated_grants WHERE client_id = $1::uuid AND endpoint_id = $2::uuid';
const SQL_CLEAR_OAUTH_TX = 'DELETE FROM tenant_email_oauth_transactions WHERE client_id = $1::uuid AND endpoint_id = $2::uuid';
const SQL_CLEAR_RECOVERY = 'DELETE FROM tenant_email_delta_recovery_operations WHERE client_id = $1::uuid AND endpoint_id = $2::uuid';
const SQL_CLEAR_POLICY_AUDIT = 'DELETE FROM tenant_email_luna_policy_audit WHERE client_id = $1::uuid AND endpoint_id = $2::uuid';
const SQL_DELETE_ENDPOINT = "DELETE FROM tenant_channel_endpoints WHERE id = $1::uuid AND client_id = $2::uuid AND location_id = $3 AND provider = 'imap_smtp' RETURNING id::text AS endpoint_id";

function failure() {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  return error;
}

function ownValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function snapshotInput(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(input);
    if (actual.length !== INPUT_KEYS.length) return null;
    for (let i = 0; i < INPUT_KEYS.length; i += 1) {
      if (actual[i] !== INPUT_KEYS[i]) return null;
    }
    const clientId = String(ownValue(input, 'clientId') || '').toLowerCase();
    const endpointId = String(ownValue(input, 'endpointId') || '').toLowerCase();
    const actor = String(ownValue(input, 'actorStaffUserId') || '').toLowerCase();
    const locationId = ownValue(input, 'locationId');
    if (!UUID.test(clientId) || !UUID.test(endpointId) || !UUID.test(actor)) return null;
    if (validateCanonicalLocationId(locationId).ok !== true) return null;
    return Object.freeze({
      clientId,
      locationId: String(locationId),
      endpointId,
      actorStaffUserId: actor,
    });
  } catch (_) {
    return null;
  }
}

function one(result, key, expected) {
  const rows = result && Array.isArray(result.rows) ? result.rows : null;
  if (!rows || rows.length !== 1 || !rows[0]) return null;
  const value = rows[0][key];
  if (value == null) return null;
  const text = String(value).toLowerCase();
  if (expected != null && text !== String(expected).toLowerCase()) return null;
  return text;
}

function createSunsetSmtpIdentityDisconnect(dependencies) {
  if (!dependencies || typeof dependencies !== 'object') throw failure();
  if (!Object.isFrozen(dependencies)) throw failure();
  const client = ownValue(dependencies, 'client');
  const env = ownValue(dependencies, 'env');
  if (!client || typeof client.query !== 'function') throw failure();
  if (!env || typeof env !== 'object') throw failure();
  const query = client.query.bind(client);
  let used = false;

  async function disconnectImapSmtpIdentity(input) {
    if (used) throw failure();
    used = true;
    if (!isSunsetEmailSmtpIdentityRegisterEnabled(env)) throw failure();
    const data = snapshotInput(input);
    if (!data) throw failure();
    let began = false;
    let commitAttempted = false;
    try {
      await query(SQL_BEGIN);
      began = true;
      const clientId = one(await query(SQL_PROVE_SUNSET_CLIENT, [data.clientId]), 'client_id', data.clientId);
      if (!clientId) throw failure();
      if (!one(await query(SQL_LOCK_ACTIVE_LOCATION, [clientId, data.locationId]), 'location_id', data.locationId)) {
        throw failure();
      }
      if (!one(await query(SQL_LOCK_ENDPOINT, [data.endpointId, clientId, data.locationId]), 'endpoint_id', data.endpointId)) {
        throw failure();
      }
      const childParams = [clientId, data.endpointId];
      await query(SQL_CLEAR_IMAP_CURSORS, childParams);
      await query(SQL_CLEAR_INBOX_PROJECTIONS, childParams);
      await query(SQL_CLEAR_DELTA_STATES, childParams);
      await query(SQL_CLEAR_INBOUND_EVENTS, childParams);
      await query(SQL_CLEAR_OUTBOUND_JOURNAL, childParams);
      await query(SQL_CLEAR_REPLY_APPROVALS, childParams);
      await query(SQL_CLEAR_GRANTS, childParams);
      await query(SQL_CLEAR_OAUTH_TX, childParams);
      await query(SQL_CLEAR_RECOVERY, childParams);
      await query(SQL_CLEAR_POLICY_AUDIT, childParams);
      const removed = one(
        await query(SQL_DELETE_ENDPOINT, [data.endpointId, clientId, data.locationId]),
        'endpoint_id',
        data.endpointId,
      );
      if (!removed) throw failure();
      commitAttempted = true;
      await query(SQL_COMMIT);
      return Object.freeze({ endpointId: removed, status: 'disconnected' });
    } catch (err) {
      if (began && !commitAttempted) {
        try { await query(SQL_ROLLBACK); } catch { /* sanitized */ }
      }
      throw failure();
    }
  }

  return Object.freeze({ disconnectImapSmtpIdentity });
}

module.exports = Object.freeze({
  EMAIL_SMTP_DISCONNECT_PATH,
  ERROR_CODE,
  ERROR_MESSAGE,
  DEPENDENCY_KEYS,
  INPUT_KEYS,
  ACK_KEYS,
  createSunsetSmtpIdentityDisconnect,
});
