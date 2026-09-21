'use strict';

/**
 * Wolfhouse mailbox endpoint prepare/register (WOLFHOUSE-EMAIL-001).
 *
 * Inserts one disabled Microsoft / Gmail / IMAP-SMTP endpoint for trusted
 * wolfhouse-somo. Never proves or writes Sunset. inbound/outbound/active stay
 * false. Secret refs are Wolfhouse-owned — not sunset-staging.
 *
 * @module email-wolfhouse-endpoint-prepare
 */

const {
  SQL_PROVE_WOLFHOUSE_CLIENT,
  WOLFHOUSE_MS_SECRET_REF,
  WOLFHOUSE_GOOGLE_SECRET_REF,
  WOLFHOUSE_SMTP_IDENTITY_SECRET_REF,
} = require('./email-wolfhouse-tenant');
const {
  EMAIL_MAILBOX_CAPABILITY_KEYS,
  normalizeEmailPublicAddress,
} = require('./email-mailbox-adapter-contract');

const ERROR_CODE = 'WOLFHOUSE_ENDPOINT_PREPARE_INVALID';
const ERROR_MESSAGE = 'Wolfhouse email endpoint prepare failed.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INPUT_KEYS = Object.freeze(['clientId', 'locationId', 'publicAddress', 'actorStaffUserId']);

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
const SQL_LOCK_ACTIVE_LOCATION = `
  SELECT location_id
    FROM tenant_locations
   WHERE client_id = $1::uuid
     AND location_id = $2
     AND active = true
   FOR SHARE`.replace(/\s+/g, ' ').trim();
const SQL_ADVISORY_LOCK = 'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))';

const PROVIDER_SQL = Object.freeze({
  microsoft_graph: Object.freeze({
    lockNs: 'wh-ms-ep-prep-loc:',
    addrNs: 'wh-ms-ep-prep-addr:',
    existing: `SELECT id FROM tenant_channel_endpoints WHERE client_id = $1::uuid AND location_id = $2 AND provider = 'microsoft_graph' LIMIT 1 FOR UPDATE`,
    existingAddr: `SELECT id FROM tenant_channel_endpoints WHERE client_id = $1::uuid AND lower(public_address) = lower($2) AND provider = 'microsoft_graph' LIMIT 1 FOR UPDATE`,
    insert: `INSERT INTO tenant_channel_endpoints (
  client_id, location_id, channel, provider, public_address, secret_ref,
  provider_resource_id, capabilities, inbound_enabled, outbound_enabled,
  default_automation_mode, active, auth_mode, connector_mode,
  provider_tenant_id, provider_principal_oid, mailbox_kind, mailbox_access_kind,
  binding_status, created_by, updated_by
) VALUES (
  $1::uuid, $2, 'email', 'microsoft_graph', $3,
  NULL, NULL, $4::jsonb,
  false, false, 'off', false, 'delegated_authorization_code',
  'microsoft_delegated_oauth', NULL, NULL, NULL, NULL, 'unverified_offline',
  $5::uuid, $5::uuid
) RETURNING id`.replace(/\s+/g, ' ').trim(),
    secretRef: null,
  }),
  gmail_api: Object.freeze({
    lockNs: 'wh-google-ep-prep-loc:',
    addrNs: 'wh-google-ep-prep-addr:',
    existing: `SELECT id FROM tenant_channel_endpoints WHERE client_id = $1::uuid AND location_id = $2 AND provider = 'gmail_api' LIMIT 1 FOR UPDATE`,
    existingAddr: `SELECT id FROM tenant_channel_endpoints WHERE client_id = $1::uuid AND lower(public_address) = lower($2) AND provider = 'gmail_api' LIMIT 1 FOR UPDATE`,
    insert: `INSERT INTO tenant_channel_endpoints (
  client_id, location_id, channel, provider, public_address, secret_ref,
  provider_resource_id, capabilities, inbound_enabled, outbound_enabled,
  default_automation_mode, active, auth_mode, connector_mode,
  provider_tenant_id, provider_principal_oid, mailbox_kind, mailbox_access_kind,
  binding_status, created_by, updated_by
) VALUES (
  $1::uuid, $2, 'email', 'gmail_api', $3,
  '${WOLFHOUSE_GOOGLE_SECRET_REF}', NULL, $4::jsonb,
  false, false, 'off', false, 'delegated_authorization_code',
  'google_delegated_oauth', NULL, NULL, NULL, NULL, 'unverified_offline',
  $5::uuid, $5::uuid
) RETURNING id`.replace(/\s+/g, ' ').trim(),
    secretRef: WOLFHOUSE_GOOGLE_SECRET_REF,
  }),
  imap_smtp: Object.freeze({
    lockNs: 'wh-smtp-ep-reg-loc:',
    addrNs: 'wh-smtp-ep-reg-addr:',
    existing: `SELECT id FROM tenant_channel_endpoints WHERE client_id = $1::uuid AND location_id = $2 AND provider = 'imap_smtp' LIMIT 1 FOR UPDATE`,
    existingAddr: `SELECT id FROM tenant_channel_endpoints WHERE client_id = $1::uuid AND lower(public_address) = lower($2) AND provider = 'imap_smtp' LIMIT 1 FOR UPDATE`,
    insert: `INSERT INTO tenant_channel_endpoints (
  client_id, location_id, channel, provider, public_address, secret_ref,
  provider_resource_id, capabilities, inbound_enabled, outbound_enabled,
  default_automation_mode, active, auth_mode, connector_mode,
  provider_tenant_id, provider_principal_oid, mailbox_kind, mailbox_access_kind,
  binding_status, created_by, updated_by
) VALUES (
  $1::uuid, $2, 'email', 'imap_smtp', $3,
  '${WOLFHOUSE_SMTP_IDENTITY_SECRET_REF}', NULL, $4::jsonb,
  false, false, 'off', false, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  $5::uuid, $5::uuid
) RETURNING id`.replace(/\s+/g, ' ').trim(),
    secretRef: WOLFHOUSE_SMTP_IDENTITY_SECRET_REF,
  }),
});

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
    const out = {};
    for (const key of INPUT_KEYS) {
      const value = ownValue(input, key);
      if (typeof value !== 'string') return null;
      out[key] = value;
    }
    if (!UUID.test(out.clientId) || !UUID.test(out.actorStaffUserId)) return null;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(out.locationId)) return null;
    const address = normalizeEmailPublicAddress(out.publicAddress);
    if (typeof address !== 'string' || !address) return null;
    out.publicAddress = address;
    out.clientId = out.clientId.toLowerCase();
    out.actorStaffUserId = out.actorStaffUserId.toLowerCase();
    return Object.freeze(out);
  } catch (_) {
    return null;
  }
}

function createWolfhouseEndpointPrepare(dependencies, provider) {
  const spec = PROVIDER_SQL[provider];
  if (!spec) throw failure();
  const client = dependencies && dependencies.client;
  if (!client || typeof client.query !== 'function') throw failure();
  let used = false;

  async function prepareDisabledEndpoint(input) {
    if (used) throw failure();
    used = true;
    const snap = snapshotInput(input);
    if (!snap) throw failure();
    let began = false;
    try {
      await client.query(SQL_BEGIN);
      began = true;
      const proved = await client.query(SQL_PROVE_WOLFHOUSE_CLIENT, [snap.clientId]);
      if (!proved || !proved.rows || proved.rows.length !== 1) throw failure();
      if (String(proved.rows[0].client_id).toLowerCase() !== snap.clientId) throw failure();
      const loc = await client.query(SQL_LOCK_ACTIVE_LOCATION, [snap.clientId, snap.locationId]);
      if (!loc || !loc.rows || loc.rows.length !== 1) throw failure();
      await client.query(SQL_ADVISORY_LOCK, [snap.clientId, spec.lockNs + snap.locationId]);
      const existing = await client.query(spec.existing, [snap.clientId, snap.locationId]);
      if (existing && existing.rows && existing.rows.length === 1 && existing.rows[0].id) {
        const existingId = String(existing.rows[0].id);
        await client.query(SQL_COMMIT);
        began = false;
        return Object.freeze({ endpointId: existingId });
      }
      await client.query(SQL_ADVISORY_LOCK, [snap.clientId, spec.addrNs + snap.publicAddress]);
      const byAddr = await client.query(spec.existingAddr, [snap.clientId, snap.publicAddress]);
      if (byAddr && byAddr.rows && byAddr.rows.length) throw failure();
      const inserted = await client.query(spec.insert, [
        snap.clientId,
        snap.locationId,
        snap.publicAddress,
        FORCED_CAPABILITIES_JSON,
        snap.actorStaffUserId,
      ]);
      if (!inserted || !inserted.rows || inserted.rows.length !== 1) throw failure();
      const endpointId = String(inserted.rows[0].id);
      if (!UUID.test(endpointId)) throw failure();
      await client.query(SQL_COMMIT);
      began = false;
      return Object.freeze({ endpointId });
    } catch (err) {
      if (began) {
        try { await client.query(SQL_ROLLBACK); } catch (_) { /* ignore */ }
      }
      throw err && err.code === ERROR_CODE ? err : failure();
    }
  }

  if (provider === 'imap_smtp') {
    return Object.freeze({ registerDisabledImapSmtpIdentity: prepareDisabledEndpoint });
  }
  return Object.freeze({ prepareDisabledDelegatedEndpoint: prepareDisabledEndpoint });
}

function createWolfhouseMicrosoftEndpointPrepare(dependencies) {
  return createWolfhouseEndpointPrepare(dependencies, 'microsoft_graph');
}
function createWolfhouseGoogleEndpointPrepare(dependencies) {
  return createWolfhouseEndpointPrepare(dependencies, 'gmail_api');
}
function createWolfhouseSmtpIdentityRegister(dependencies) {
  return createWolfhouseEndpointPrepare(dependencies, 'imap_smtp');
}

module.exports = Object.freeze({
  ERROR_CODE,
  SQL_PROVE_WOLFHOUSE_CLIENT,
  WOLFHOUSE_MS_SECRET_REF,
  WOLFHOUSE_GOOGLE_SECRET_REF,
  WOLFHOUSE_SMTP_IDENTITY_SECRET_REF,
  createWolfhouseMicrosoftEndpointPrepare,
  createWolfhouseGoogleEndpointPrepare,
  createWolfhouseSmtpIdentityRegister,
});
