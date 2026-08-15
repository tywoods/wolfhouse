'use strict';

/**
 * Authority resolver for JIT Microsoft message-content reads.
 *
 * Reloads exact client/location/event/endpoint/provider/mailbox/message
 * authority from inbound events + verified Sunset Microsoft endpoint.
 * Callers cannot supply Graph IDs or tokens. Gmail is excluded.
 */

const util = require('node:util');

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const getPrototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INPUT_KEYS = freeze(['clientId', 'locationId', 'eventId']);
const ISSUED_KEYS = freeze([
  'clientId', 'locationId', 'eventId', 'endpointId',
  'provider', 'providerMailboxId', 'providerMessageId',
]);

const SQL_RESOLVE_CURRENT_MESSAGE_CONTENT_AUTHORITY = `
SELECT ev.client_id::text AS "clientId",
       ev.location_id::text AS "locationId",
       ev.id::text AS "eventId",
       ev.endpoint_id::text AS "endpointId",
       ev.provider AS provider,
       ev.provider_mailbox_id AS "providerMailboxId",
       ev.provider_message_id AS "providerMessageId"
  FROM tenant_email_inbound_events ev
 INNER JOIN tenant_email_inbound_inbox_projections p
    ON p.client_id = ev.client_id
   AND p.inbound_event_id = ev.id
   AND p.location_id = ev.location_id
   AND p.endpoint_id = ev.endpoint_id
   AND p.provider = ev.provider
   AND p.provider_mailbox_id = ev.provider_mailbox_id
   AND p.provider_message_id = ev.provider_message_id
 INNER JOIN conversations c
    ON c.client_id = p.client_id
   AND c.id = p.conversation_id
 INNER JOIN tenant_locations loc
    ON loc.client_id = ev.client_id AND loc.id = ev.location_id
 INNER JOIN tenant_channel_endpoints ep
    ON ep.client_id = ev.client_id AND ep.id = ev.endpoint_id
   AND ep.location_id = loc.location_id
   AND ep.channel = 'email'
   AND ep.provider = 'microsoft_graph'
   AND ep.auth_mode = 'delegated_authorization_code'
   AND ep.connector_mode = 'microsoft_delegated_oauth'
   AND ep.mailbox_access_kind = 'own_user'
   AND ep.mailbox_kind = 'user'
   AND ep.binding_status = 'verified'
   AND ep.public_address IS NOT NULL AND btrim(ep.public_address) <> ''
   AND ep.provider_resource_id IS NOT NULL AND btrim(ep.provider_resource_id) <> ''
   AND ep.provider_resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND ev.provider_mailbox_id = ep.provider_resource_id
 INNER JOIN tenant_email_delegated_grants g
    ON g.client_id = ev.client_id AND g.endpoint_id = ev.endpoint_id
 WHERE ev.client_id = $1::uuid
   AND ev.location_id = $2::uuid
   AND ev.id = $3::uuid
   AND ev.provider = 'microsoft_graph'
   AND loc.location_id = 'sunset-somo'
   AND ev.id = (
     SELECT p2.inbound_event_id
       FROM tenant_email_inbound_inbox_projections p2
       INNER JOIN tenant_email_inbound_events ev2
         ON ev2.client_id = p2.client_id AND ev2.id = p2.inbound_event_id
      WHERE p2.client_id = ev.client_id
        AND p2.conversation_id = p.conversation_id
      ORDER BY ev2.received_at DESC, ev2.id DESC
      LIMIT 1
   )
 LIMIT 1`.replace(/\s+/g, ' ').trim();

function fail() {
  const error = new Error('authority_bound_current_message_content_failed');
  error.code = 'authority_bound_current_message_content_failed';
  return error;
}

function ownData(value, key) {
  try {
    const descriptor = getDescriptor(value, key);
    return descriptor && hasOwn(descriptor, 'value') && !descriptor.get && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function uuid(value) {
  return typeof value === 'string' && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

function opaqueId(value) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 2048
    && !/[\x00-\x1f\x7f]/.test(value)
    && !/[\uD800-\uDFFF]/.test(value)
    && value !== '.'
    && value !== '..';
}

function snapshotInput(input) {
  if (!input || typeof input !== 'object' || isProxy(input) || Array.isArray(input)
      || getPrototypeOf(input) !== Object.prototype) {
    return null;
  }
  const keys = ownKeys(input);
  if (keys.length !== INPUT_KEYS.length) return null;
  const out = {};
  for (const key of INPUT_KEYS) {
    if (!keys.includes(key)) return null;
    const value = uuid(ownData(input, key));
    if (!value) return null;
    out[key] = value;
  }
  return freeze(out);
}

function snapshotRow(row, expected) {
  if (!row || typeof row !== 'object' || isProxy(row) || Array.isArray(row)) return null;
  const clientId = uuid(ownData(row, 'clientId'));
  const locationId = uuid(ownData(row, 'locationId'));
  const eventId = uuid(ownData(row, 'eventId'));
  const endpointId = uuid(ownData(row, 'endpointId'));
  const provider = ownData(row, 'provider');
  const providerMailboxId = uuid(ownData(row, 'providerMailboxId'));
  const providerMessageId = ownData(row, 'providerMessageId');
  if (!clientId || clientId !== expected.clientId
      || !locationId || locationId !== expected.locationId
      || !eventId || eventId !== expected.eventId
      || !endpointId || provider !== 'microsoft_graph'
      || !providerMailboxId || !opaqueId(providerMessageId)) {
    return null;
  }
  const issued = {};
  issued.clientId = clientId;
  issued.locationId = locationId;
  issued.eventId = eventId;
  issued.endpointId = endpointId;
  issued.provider = 'microsoft_graph';
  issued.providerMailboxId = providerMailboxId;
  issued.providerMessageId = providerMessageId;
  return issued;
}

function createCurrentMessageContentAuthorityResolver(deps) {
  if (!deps || typeof deps !== 'object' || isProxy(deps) || Array.isArray(deps)
      || typeof deps.db !== 'object' || typeof deps.db.query !== 'function') {
    throw fail();
  }
  const db = deps.db;

  return function buildAuthorityResolver(issue) {
    if (typeof issue !== 'function' || isProxy(issue)) throw fail();

    return async function resolveAuthority(input) {
      const ids = snapshotInput(input);
      if (!ids) throw fail();
      let result;
      try {
        result = await db.query(SQL_RESOLVE_CURRENT_MESSAGE_CONTENT_AUTHORITY, [
          ids.clientId, ids.locationId, ids.eventId,
        ]);
      } catch {
        throw fail();
      }
      if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) throw fail();
      const bag = snapshotRow(result.rows[0], ids);
      if (!bag) throw fail();
      return issue(bag);
    };
  };
}

module.exports = freeze({
  INPUT_KEYS,
  ISSUED_KEYS,
  SQL_RESOLVE_CURRENT_MESSAGE_CONTENT_AUTHORITY,
  createCurrentMessageContentAuthorityResolver,
});
