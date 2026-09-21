'use strict';

const {
  CONNECT_PATH,
  DISCONNECT_PATH,
  createWolfhouseEmailConnectService,
  createWolfhouseKvStore,
  validateConnect,
} = require('./email-wolfhouse-smtp-imap-connect');
const { createSunsetSmtpStarttlsTransport } = require('./email-sunset-smtp-starttls-transport');
const { createSunsetImapImapsTransport } = require('./email-sunset-imap-imaps-transport');

const CLIENT_SLUG = 'wolfhouse-somo';
const LOCATION_ID = 'wolfhouse-somo';
const ALLOWED_ROLES = Object.freeze(['admin', 'owner']);
const SQL_LOCK = "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))";
const SQL_PROVE = "SELECT id::text FROM clients WHERE slug = 'wolfhouse-somo' AND id = $1::uuid LIMIT 1 FOR UPDATE";
const SQL_CONNECTED = `
WITH target AS (
  SELECT id
  FROM tenant_channel_endpoints
  WHERE client_id = $1::uuid
    AND location_id = 'wolfhouse-somo'
    AND provider = 'imap_smtp'
  ORDER BY id
  LIMIT 1
  FOR UPDATE
)
UPDATE tenant_channel_endpoints AS endpoint
SET public_address = $2,
    secret_ref = $3,
    smtp_health_verified_at = NOW(),
    imap_health_verified_at = NOW(),
    provider_resource_id = NULL,
    inbound_enabled = false,
    outbound_enabled = false,
    default_automation_mode = 'off',
    active = false,
    updated_by = $4::uuid,
    updated_at = NOW()
FROM target
WHERE endpoint.id = target.id
RETURNING endpoint.id::text`;
const SQL_SANITIZE_DUPLICATES = `
UPDATE tenant_channel_endpoints
SET secret_ref = NULL,
    smtp_health_verified_at = NULL,
    imap_health_verified_at = NULL,
    provider_resource_id = 'disconnected',
    inbound_enabled = false,
    outbound_enabled = false,
    default_automation_mode = 'off',
    active = false,
    updated_by = $3::uuid,
    updated_at = NOW()
WHERE client_id = $1::uuid
  AND location_id = 'wolfhouse-somo'
  AND provider = 'imap_smtp'
  AND id <> $2::uuid`;
const SQL_INSERT_CONNECTED = `
INSERT INTO tenant_channel_endpoints
  (client_id, location_id, channel, provider, public_address, secret_ref, capabilities,
   inbound_enabled, outbound_enabled, default_automation_mode, active,
   smtp_health_verified_at, imap_health_verified_at, created_by, updated_by)
VALUES
  ($1::uuid, 'wolfhouse-somo', 'email', 'imap_smtp', $2, $3, '{}'::jsonb,
   false, false, 'off', false, NOW(), NOW(), $4::uuid, $4::uuid)
RETURNING id::text`;
const SQL_DISCONNECTED = `
WITH requested AS (
  SELECT id
  FROM tenant_channel_endpoints
  WHERE client_id = $1::uuid
    AND id = $2::uuid
    AND location_id = 'wolfhouse-somo'
    AND provider = 'imap_smtp'
  LIMIT 1
  FOR UPDATE
)
UPDATE tenant_channel_endpoints AS endpoint
SET secret_ref = NULL,
    smtp_health_verified_at = NULL,
    imap_health_verified_at = NULL,
    provider_resource_id = 'disconnected',
    inbound_enabled = false,
    outbound_enabled = false,
    default_automation_mode = 'off',
    active = false,
    updated_by = $3::uuid,
    updated_at = NOW()
WHERE endpoint.client_id = $1::uuid
  AND endpoint.location_id = 'wolfhouse-somo'
  AND endpoint.provider = 'imap_smtp'
  AND EXISTS (SELECT 1 FROM requested)
RETURNING endpoint.id::text`;

function hasExactOwnDataKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && own.every((key) => typeof key === 'string' && keys.includes(key))
      && keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
      });
  } catch (_) {
    return false;
  }
}

function createStore(pg) {
  async function runExclusive(value, operation) {
    await pg.query('BEGIN');
    try {
      await pg.query(SQL_LOCK, [`${value.clientId}:wolfhouse-somo:imap_smtp`]);
      const proof = await pg.query(SQL_PROVE, [value.clientId]);
      if (!proof.rows || proof.rows.length !== 1) throw new Error('tenant_scope');
      const result = await operation(api);
      await pg.query('COMMIT');
      return result;
    } catch (error) {
      try { await pg.query('ROLLBACK'); } catch (_) { /* preserve original failure */ }
      throw error;
    }
  }

  async function publishConnected(value) {
    const args = [value.clientId, value.publicAddress, value.secretRef, value.actorStaffUserId];
    let result = await pg.query(SQL_CONNECTED, args);
    if (!result.rows || result.rows.length === 0) result = await pg.query(SQL_INSERT_CONNECTED, args);
    if (!result.rows || result.rows.length !== 1) throw new Error('endpoint_cardinality');
    const endpointId = String(result.rows[0].id);
    await pg.query(SQL_SANITIZE_DUPLICATES, [value.clientId, endpointId, value.actorStaffUserId]);
    return { endpointId };
  }

  async function publishDisconnected(value) {
    const result = await pg.query(SQL_DISCONNECTED,
      [value.clientId, value.endpointId, value.actorStaffUserId]);
    if (!result.rows || result.rows.length < 1
        || !result.rows.some((row) => String(row.id) === value.endpointId)) throw new Error('endpoint_cardinality');
    return { endpointId: value.endpointId };
  }

  const api = Object.freeze({ runExclusive, publishConnected, publishDisconnected });
  return api;
}

function createStaffWolfhouseEmailConnectRoutes(deps) {
  if (!deps || typeof deps.sendJSON !== 'function' || typeof deps.withPgClient !== 'function'
      || typeof deps.assertStaffClientAccess !== 'function'
      || typeof deps.authorizeAuthenticatedStaffRoute !== 'function') {
    throw new Error('wolfhouse_email_connect_routes_invalid_deps');
  }

  function authorize(user, pathname, res) {
    const role = user && typeof user.role === 'string' ? user.role : '';
    if (!user || user.client_slug !== CLIENT_SLUG || !ALLOWED_ROLES.includes(role)) {
      deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
      return false;
    }
    if (!deps.assertStaffClientAccess(user, CLIENT_SLUG, res)) return false;
    const authz = deps.authorizeAuthenticatedStaffRoute({
      clientSlug: CLIENT_SLUG,
      method: 'POST',
      pathname,
      env: deps.runtimeEnv,
    });
    if (!authz || authz.ok !== true) {
      deps.sendJSON(res, (authz && authz.status) || 403,
        (authz && authz.body) || { success: false, error: 'forbidden' });
      return false;
    }
    return true;
  }

  async function run(body, res, user, disconnect) {
    if (!authorize(user, disconnect ? DISCONNECT_PATH : CONNECT_PATH, res)) return;
    const expectedKeys = disconnect ? ['location_id', 'endpoint_id'] : ['location_id', 'public_address', 'smtp', 'imap'];
    if (!hasExactOwnDataKeys(body, expectedKeys)) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    const trustedInput = disconnect ? Object.freeze({
      clientSlug: CLIENT_SLUG,
      deployment: 'staff-staging',
      locationId: body.location_id,
      endpointId: body.endpoint_id,
      actorStaffUserId: user.staff_user_id,
      clientId: user.client_id,
    }) : Object.freeze({
      clientSlug: CLIENT_SLUG,
      deployment: 'staff-staging',
      locationId: body.location_id,
      publicAddress: body.public_address,
      smtp: body.smtp,
      imap: body.imap,
      actorStaffUserId: user.staff_user_id,
      clientId: user.client_id,
    });
    if (!disconnect && !validateConnect(trustedInput)) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    try {
      const result = await deps.withPgClient(async (pg) => {
        const smtpTransport = (deps.createSmtpTransport || createSunsetSmtpStarttlsTransport)();
        const imapTransport = (deps.createImapTransport || createSunsetImapImapsTransport)();
        const service = createWolfhouseEmailConnectService({
          kv: deps.kv || createWolfhouseKvStore(),
          store: createStore(pg),
          smtp: { authenticate: (credentials) => smtpTransport.verifySession(credentials) },
          imap: { authenticate: (credentials) => imapTransport.verifySession(credentials) },
          resolveHost: deps.resolveHost,
        });
        return disconnect ? service.disconnect(trustedInput) : service.connect(trustedInput);
      });
      return deps.sendJSON(res, 200, { success: true, ...result });
    } catch (_) {
      return deps.sendJSON(res, 502, { success: false, error: 'email_connection_failed' });
    }
  }

  return Object.freeze({
    handleConnect: (body, req, res, user) => run(body, res, user, false),
    handleDisconnect: (body, req, res, user) => run(body, res, user, true),
  });
}

module.exports = Object.freeze({
  SQL_LOCK,
  SQL_PROVE,
  SQL_CONNECTED,
  SQL_SANITIZE_DUPLICATES,
  SQL_INSERT_CONNECTED,
  SQL_DISCONNECTED,
  hasExactOwnDataKeys,
  createStore,
  createStaffWolfhouseEmailConnectRoutes,
});
