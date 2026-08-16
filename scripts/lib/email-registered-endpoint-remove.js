'use strict';

/**
 * Remove a Sunset registered-but-not-connected mailbox endpoint.
 * Deletes the leftover tenant_channel_endpoints row when there is no grant.
 * Used by Admin Email Disconnect/Remove for partial OAuth leftovers.
 *
 * @module email-registered-endpoint-remove
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const PROVIDER_MODE = Object.freeze({
  microsoft_graph: Object.freeze({
    provider: 'microsoft_graph',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
  }),
  gmail_api: Object.freeze({
    provider: 'gmail_api',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'google_delegated_oauth',
  }),
});

/**
 * Trusted resolve + delete for registered-not-connected endpoints.
 * Params: [location_id, endpoint_id].
 * Requires Sunset + active location + delegated modes + unverified binding +
 * non-empty address + no delegated grant row.
 */
const SQL_DELETE_REGISTERED_NOT_CONNECTED = `
WITH target AS (
  SELECT e.client_id, e.id AS endpoint_id
    FROM clients c
    INNER JOIN tenant_locations l
      ON l.client_id = c.id
    INNER JOIN tenant_channel_endpoints e
      ON e.client_id = c.id
     AND e.location_id = l.location_id
     AND e.id = $2::uuid
    LEFT JOIN tenant_email_delegated_grants g
      ON g.client_id = c.id
     AND g.endpoint_id = e.id
   WHERE c.slug = 'sunset'
     AND l.location_id = $1
     AND l.active = true
     AND e.provider = $3
     AND e.auth_mode = $4
     AND e.connector_mode = $5
     AND e.binding_status IN ('unverified_offline', 'pending_manual_validation')
     AND e.public_address IS NOT NULL
     AND btrim(e.public_address) <> ''
     AND g.endpoint_id IS NULL
)
DELETE FROM tenant_channel_endpoints e
  USING target t
 WHERE e.client_id = t.client_id
   AND e.id = t.endpoint_id
RETURNING e.id::text AS endpoint_id`.replace(/\s+/g, ' ').trim();

function ownData(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function snapshotRemoveInput(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const locationId = ownData(input, 'locationId');
    const endpointId = ownData(input, 'endpointId');
    const provider = ownData(input, 'provider');
    if (typeof locationId !== 'string' || !LOCATION_RE.test(locationId)) return null;
    if (typeof endpointId !== 'string' || !UUID_RE.test(endpointId)) return null;
    if (provider !== 'microsoft_graph' && provider !== 'gmail_api') return null;
    return Object.freeze({
      locationId,
      endpointId: endpointId.toLowerCase(),
      provider,
    });
  } catch {
    return null;
  }
}

function publicRemovedResult() {
  return Object.freeze({
    status: 'disconnected',
    grant_generation: null,
    grant_status: null,
    reconcile_state: null,
  });
}

/**
 * Attempt to delete a registered-not-connected endpoint.
 * @returns {Promise<{ kind: 'removed', result: object }
 *   | { kind: 'not_applicable' }
 *   | { kind: 'error' }>}
 */
async function tryRemoveRegisteredNotConnectedEndpoint(pgClient, input) {
  try {
    if (!pgClient || typeof pgClient.query !== 'function') return { kind: 'error' };
    const snap = snapshotRemoveInput(input);
    if (!snap) return { kind: 'error' };
    const mode = PROVIDER_MODE[snap.provider];
    if (!mode) return { kind: 'error' };
    const deleted = await pgClient.query(SQL_DELETE_REGISTERED_NOT_CONNECTED, [
      snap.locationId,
      snap.endpointId,
      mode.provider,
      mode.auth_mode,
      mode.connector_mode,
    ]);
    if (!deleted || !Array.isArray(deleted.rows)) return { kind: 'error' };
    if (deleted.rows.length === 0) return { kind: 'not_applicable' };
    if (deleted.rows.length !== 1) return { kind: 'error' };
    const rowId = deleted.rows[0] && deleted.rows[0].endpoint_id;
    if (typeof rowId !== 'string' || rowId.toLowerCase() !== snap.endpointId) {
      return { kind: 'error' };
    }
    return Object.freeze({ kind: 'removed', result: publicRemovedResult() });
  } catch (_) {
    return { kind: 'error' };
  }
}

module.exports = Object.freeze({
  SQL_DELETE_REGISTERED_NOT_CONNECTED,
  PROVIDER_MODE,
  tryRemoveRegisteredNotConnectedEndpoint,
  publicRemovedResult,
});
