'use strict';

const dns = require('node:dns');
const net = require('node:net');

/** Wolfhouse staff-staging SMTP/IMAP self-service connection owner. */
const VAULT_HOST = 'wh-staging-kv.vault.azure.net';
const MI_CLIENT_ID = '0dd41fa2-52c8-4e04-bc23-8aa462938c19';
const BUNDLE_SECRET_NAME = 'wolfhouse-email-imap-smtp-credentials';
const CONNECT_PATH = '/staff/admin/email-settings/smtp/connect';
const DISCONNECT_PATH = '/staff/admin/email-settings/smtp/disconnect';
const GENERIC_MESSAGE = 'Email connection failed.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_RE = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitizeError() {
  const error = new Error(GENERIC_MESSAGE);
  error.code = 'WOLFHOUSE_EMAIL_CONNECT_FAILED';
  Object.defineProperty(error, 'stack', { value: undefined });
  return error;
}

function exactTrue(env, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(env, key);
    return !!(descriptor && Object.hasOwn(descriptor, 'value')
      && !descriptor.get && !descriptor.set && descriptor.value === 'true');
  } catch (_) {
    return false;
  }
}

function isEnabled(env) {
  try {
    return !!(env && typeof env === 'object' && !Array.isArray(env)
      && env.LUNA_DEPLOYMENT === 'staff-staging'
      && exactTrue(env, 'WOLFHOUSE_EMAIL_SETTINGS_UI_ENABLED')
      && exactTrue(env, 'WOLFHOUSE_EMAIL_SMTP_CONNECT_ENABLED'));
  } catch (_) {
    return false;
  }
}

function createWolfhouseKvStore(deps = {}) {
  let credential = deps.credential;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;

  async function token() {
    if (!credential) {
      const { ManagedIdentityCredential } = require('@azure/identity');
      credential = new ManagedIdentityCredential(MI_CLIENT_ID);
    }
    const auth = await credential.getToken('https://vault.azure.net/.default');
    if (!auth || typeof auth.token !== 'string' || !auth.token) throw sanitizeError();
    return auth.token;
  }

  async function request(method, value) {
    if (typeof fetchImpl !== 'function') throw sanitizeError();
    try {
      const authorization = `Bearer ${await token()}`;
      const response = await fetchImpl(
        `https://${VAULT_HOST}/secrets/${BUNDLE_SECRET_NAME}?api-version=7.4`,
        {
          method,
          headers: {
            authorization,
            ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}),
          },
          body: method === 'PUT' ? JSON.stringify({ value }) : undefined,
          signal: AbortSignal.timeout(5000),
        },
      );
      if (method === 'GET' && response.status === 404) return null;
      if (!response.ok) throw new Error('vault_status');
      if (method === 'GET') {
        const body = await response.json();
        return body && typeof body.value === 'string' && body.value ? body.value : null;
      }
      const body = await response.json();
      const id = body && typeof body.id === 'string' ? body.id : '';
      const prefix = `https://${VAULT_HOST}/secrets/${BUNDLE_SECRET_NAME}/`;
      const version = id.startsWith(prefix) ? id.slice(prefix.length) : '';
      if (!/^[A-Za-z0-9-]+$/.test(version)) throw new Error('vault_version');
      return `kv:${BUNDLE_SECRET_NAME}/${version}`;
    } catch (_) {
      throw sanitizeError();
    }
  }

  return Object.freeze({
    readBundle: () => request('GET'),
    writeBundle(value) {
      if (typeof value !== 'string' || !value || value.length > 16384) throw sanitizeError();
      return request('PUT', value);
    },
  });
}

function isPublicAddress(address) {
  if (net.isIPv4(address)) {
    const p = address.split('.').map(Number);
    return !(p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224
      || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
      || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
      || (p[0] === 192 && p[1] === 168));
  }
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    // Only globally routable unicast (2000::/3) is eligible. This excludes
    // mapped IPv4, loopback, ULA/link-local, multicast and transition space.
    if (!/^[23]/.test(a)) return false;
    if (a.startsWith('2001:db8:')) return false;
    const parts = a.split(':');
    if (parts[0] === '2001' && Number.parseInt(parts[1] || '0', 16) < 0x200) return false;
    return true;
  }
  return false;
}

async function resolvePublicHost(host, lookup = (name) => dns.promises.lookup(name, { all: true, verbatim: true })) {
  try {
    const rows = await lookup(host);
    if (!Array.isArray(rows) || rows.length === 0 || rows.some((row) => !row || !isPublicAddress(row.address))) {
      throw sanitizeError();
    }
    return rows[0].address;
  } catch (_) {
    throw sanitizeError();
  }
}

function plainExactObject(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) return false;
    return keys.every((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      return !!(d && Object.hasOwn(d, 'value') && d.enumerable && !d.get && !d.set);
    });
  } catch (_) {
    return false;
  }
}

function validateProtocol(value, kind) {
  const keys = ['server', 'port', 'tls', 'user', 'password'];
  if (!plainExactObject(value, keys)) return null;
  if (typeof value.server !== 'string' || !HOST_RE.test(value.server)) return null;
  if (!Number.isInteger(value.port) || value.port !== (kind === 'smtp' ? 587 : 993)) return null;
  const tlsMode = String(value.tls || '').toLowerCase();
  if (kind === 'smtp' && tlsMode !== 'starttls') return null;
  if (kind === 'imap' && tlsMode !== 'tls') return null;
  if (typeof value.user !== 'string' || !value.user || value.user.length > 320 || /[\r\n]/.test(value.user)) return null;
  if (typeof value.password !== 'string' || !value.password || value.password.length > 4096) return null;
  return Object.freeze({
    host: value.server.toLowerCase(),
    port: value.port,
    tlsMode: kind === 'imap' ? 'imaps' : tlsMode,
    username: value.user,
    password: value.password,
  });
}

function validateConnect(input) {
  const keys = ['clientSlug', 'deployment', 'locationId', 'publicAddress', 'smtp', 'imap', 'actorStaffUserId', 'clientId'];
  if (!plainExactObject(input, keys)) return null;
  if (input.clientSlug !== 'wolfhouse-somo' || input.deployment !== 'staff-staging'
      || input.locationId !== 'wolfhouse-somo') return null;
  if (typeof input.publicAddress !== 'string' || input.publicAddress.length > 320
      || !EMAIL_RE.test(input.publicAddress)) return null;
  if (typeof input.actorStaffUserId !== 'string' || !UUID_RE.test(input.actorStaffUserId)
      || typeof input.clientId !== 'string' || !UUID_RE.test(input.clientId)) return null;
  const smtp = validateProtocol(input.smtp, 'smtp');
  const imap = validateProtocol(input.imap, 'imap');
  if (!smtp || !imap) return null;
  return Object.freeze({
    publicAddress: input.publicAddress.toLowerCase(),
    smtp,
    imap,
    actorStaffUserId: input.actorStaffUserId.toLowerCase(),
    clientId: input.clientId.toLowerCase(),
  });
}

function encodeBundle(valid) {
  return JSON.stringify({
    version: 1,
    smtp: valid.smtp,
    imap: valid.imap,
  });
}

function createWolfhouseEmailConnectService(deps) {
  if (!deps || !deps.kv || !deps.store || !deps.smtp || !deps.imap) throw sanitizeError();

  async function connect(input) {
    const valid = validateConnect(input);
    if (!valid || typeof deps.store.runExclusive !== 'function') throw sanitizeError();
    try {
      return await deps.store.runExclusive(Object.freeze({
        clientId: valid.clientId,
        locationId: 'wolfhouse-somo',
      }), async (lockedStore) => {
        // The DB advisory lock spans DNS, authentication, vault version creation and
        // endpoint publication, so concurrent connects cannot cross credentials/address.
        const resolver = deps.resolveHost || resolvePublicHost;
        const smtpCredentials = Object.freeze({ ...valid.smtp, connectHost: await resolver(valid.smtp.host) });
        const imapCredentials = Object.freeze({ ...valid.imap, connectHost: await resolver(valid.imap.host) });
        const smtpResult = await deps.smtp.authenticate(smtpCredentials);
        if (!smtpResult || smtpResult.ok !== true) throw sanitizeError();
        const imapResult = await deps.imap.authenticate(imapCredentials);
        if (!imapResult || imapResult.ok !== true) throw sanitizeError();

        // Every PUT creates an immutable KV version. Only the exact returned version is
        // transactionally published; a failed transaction can leave only an unreachable
        // encrypted version, never alter the prior endpoint's credentials.
        const secretRef = await deps.kv.writeBundle(encodeBundle(valid));
        if (typeof secretRef !== 'string' || !/^kv:wolfhouse-email-imap-smtp-credentials\/[A-Za-z0-9-]+$/.test(secretRef)) {
          throw sanitizeError();
        }
        const row = await lockedStore.publishConnected(Object.freeze({
          clientId: valid.clientId,
          locationId: 'wolfhouse-somo',
          publicAddress: valid.publicAddress,
          actorStaffUserId: valid.actorStaffUserId,
          secretRef,
        }));
        return Object.freeze({
          endpoint_id: row.endpointId,
          status: 'connected',
          provider: 'imap_smtp',
          smtp_verified: true,
          imap_verified: true,
          inbound_enabled: false,
          outbound_enabled: false,
          active: false,
          default_automation_mode: 'off',
        });
      });
    } catch (_) {
      throw sanitizeError();
    }
  }

  async function disconnect(input) {
    const keys = ['clientSlug', 'deployment', 'locationId', 'endpointId', 'actorStaffUserId', 'clientId'];
    if (!plainExactObject(input, keys)
        || input.clientSlug !== 'wolfhouse-somo' || input.deployment !== 'staff-staging'
        || input.locationId !== 'wolfhouse-somo' || !UUID_RE.test(String(input.endpointId || ''))
        || !UUID_RE.test(String(input.actorStaffUserId || '')) || !UUID_RE.test(String(input.clientId || ''))) {
      throw sanitizeError();
    }
    try {
      const row = await deps.store.runExclusive(Object.freeze({
        clientId: input.clientId.toLowerCase(),
        locationId: 'wolfhouse-somo',
      }), (lockedStore) => lockedStore.publishDisconnected(Object.freeze({
        clientId: input.clientId.toLowerCase(),
        locationId: 'wolfhouse-somo',
        endpointId: input.endpointId.toLowerCase(),
        actorStaffUserId: input.actorStaffUserId.toLowerCase(),
      })));
      // Credentials remain encrypted in Key Vault; no runtime path can use them after
      // the endpoint is transactionally disconnected. This avoids non-atomic KV delete.
      return Object.freeze({ endpoint_id: row.endpointId, status: 'disconnected', provider: 'imap_smtp' });
    } catch (_) {
      throw sanitizeError();
    }
  }

  return Object.freeze({ connect, disconnect });
}

module.exports = Object.freeze({
  VAULT_HOST,
  MI_CLIENT_ID,
  BUNDLE_SECRET_NAME,
  CONNECT_PATH,
  DISCONNECT_PATH,
  sanitizeError,
  isEnabled,
  validateConnect,
  resolvePublicHost,
  createWolfhouseKvStore,
  createWolfhouseEmailConnectService,
});
