'use strict';

/**
 * Sunset Microsoft delegated endpoint prepare — Stage 6 onboarding prerequisite.
 *
 * Narrow domain boundary that transactionally inserts exactly one disabled
 * Microsoft delegated OAuth endpoint for trusted Sunset before OAuth start.
 *
 * Intentionally separate from the generic registry disabled-endpoint creator
 * (legacy null auth_mode path) — must not reuse or weaken that surface.
 * No OAuth start/callback, activation, sync, send, Azure, network, or secret
 * material. No mailbox echo in the ack.
 *
 * Factory: exact frozen { client } pinned transaction client (pool rejected).
 * Returns exact frozen single-use { prepareDisabledDelegatedEndpoint }.
 * First call (even malformed) burns the surface; concurrent/reentrant/second
 * attempts fail sanitized with zero further SQL.
 *
 * Domain input (exact frozen ordered): clientId, locationId, publicAddress,
 * actorStaffUserId. Route resolves trusted Sunset client UUID and passes it;
 * domain never trusts body client — validates canonical UUID and proves
 * slug=sunset + id exact before any tenant-scoped write.
 *
 * Domain ack (exact frozen): { endpointId } only — no status/prepared.
 *
 * Rollback/commit ambiguity: pre-COMMIT failure → ROLLBACK; after COMMIT is
 * sent, never ROLLBACK (installer discipline).
 *
 * TX lock order (deadlock-free, fixed):
 *   BEGIN → prove Sunset clients row FOR UPDATE → active location FOR SHARE →
 *   location advisory (clientId + ms-ep-prep-loc:) → existing-by-location →
 *   address advisory (clientId + ms-ep-prep-addr:) → existing-by-address →
 *   INSERT → COMMIT.
 * Location advisory runs before the existing-by-location check so independent
 * prepares for the same client/location serialize even with different addresses.
 * Advisory locks use parameterized hashtext($1), hashtext($2) only.
 *
 * @module email-sunset-microsoft-endpoint-prepare
 */

const {
  EMAIL_MAILBOX_CAPABILITY_KEYS,
  normalizeEmailPublicAddress,
  validateCanonicalLocationId,
} = require('./email-mailbox-adapter-contract');

const ERROR_CODE = 'SUNSET_MS_ENDPOINT_PREPARE_INVALID';
const ERROR_MESSAGE = 'Sunset Microsoft endpoint prepare failed.';
const PREPARE_METHOD = 'prepareDisabledDelegatedEndpoint';

const DEPENDENCY_KEYS = Object.freeze(['client']);
/** Exact ordered domain input keys (descriptor-safe snapshot). clientId first. */
const INPUT_KEYS = Object.freeze([
  'clientId',
  'locationId',
  'publicAddress',
  'actorStaffUserId',
]);
/** Exact ordered domain ack keys (endpointId only; no status/mailbox). */
const ACK_KEYS = Object.freeze(['endpointId']);

const SUNSET_CLIENT_SLUG = 'sunset';
const PROVIDER = 'microsoft_graph';
const AUTH_MODE = 'delegated_authorization_code';
const CONNECTOR_MODE = 'microsoft_delegated_oauth';
const BINDING_STATUS = 'unverified_offline';
const CHANNEL = 'email';
const AUTOMATION_OFF = 'off';

const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLIC_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAILBOX_MIN = 3;
const MAILBOX_MAX = 320;

/** Exact eight capability keys, all forced false (SQL textual order). */
const FORCED_CAPABILITIES = Object.freeze(
  EMAIL_MAILBOX_CAPABILITY_KEYS.reduce((acc, key) => {
    acc[key] = false;
    return acc;
  }, {}),
);
const FORCED_CAPABILITIES_JSON = JSON.stringify(FORCED_CAPABILITIES);

const CLIENT_ROW_KEYS = Object.freeze(['client_id']);
const CLIENT_ROW_KEY_SET = new Set(CLIENT_ROW_KEYS);
const LOCATION_ROW_KEYS = Object.freeze(['location_id']);
const LOCATION_ROW_KEY_SET = new Set(LOCATION_ROW_KEYS);
const EXISTING_ROW_KEYS = Object.freeze(['id']);
const EXISTING_ROW_KEY_SET = new Set(EXISTING_ROW_KEYS);
const INSERT_RETURNING_KEYS = Object.freeze(['id']);
const INSERT_RETURNING_KEY_SET = new Set(INSERT_RETURNING_KEYS);

const SQL_BEGIN = 'BEGIN';
const SQL_COMMIT = 'COMMIT';
const SQL_ROLLBACK = 'ROLLBACK';

/**
 * Prove trusted Sunset client: slug pinned + exact id param.
 * FOR UPDATE pins the exact clients row so concurrent slug/id mutation
 * that needs UPDATE is blocked until this TX commits or rolls back.
 * Never trust caller client without this join. Params: [clientId].
 */
const SQL_PROVE_SUNSET_CLIENT = `
  SELECT id::text AS client_id
    FROM clients
   WHERE slug = 'sunset'
     AND id = $1::uuid
   LIMIT 1
   FOR UPDATE`.replace(/\s+/g, ' ').trim();

/** Active exact location under trusted client; FOR SHARE. Params: [clientId, locationId]. */
const SQL_LOCK_ACTIVE_LOCATION = `
  SELECT location_id
    FROM tenant_locations
   WHERE client_id = $1::uuid
     AND location_id = $2
     AND active = true
   FOR SHARE`.replace(/\s+/g, ' ').trim();

/**
 * Transaction-scoped advisory lock (parameterized hashtext pair).
 * Used twice in fixed order: location reservation first, address second.
 * Params: [clientId, lockKey] — never interpolate identifiers into SQL.
 */
const SQL_ADVISORY_LOCK = 'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))';

/** Canonical namespace prefixes for advisory lock key ($2). clientId is always $1. */
const LOCK_NS_LOCATION = 'ms-ep-prep-loc:';
const LOCK_NS_ADDRESS = 'ms-ep-prep-addr:';

/** Existing endpoint for same client+location. Params: [clientId, locationId]. */
const SQL_EXISTING_BY_LOCATION = `
  SELECT id
    FROM tenant_channel_endpoints
   WHERE client_id = $1::uuid
     AND location_id = $2
   LIMIT 1
   FOR UPDATE`.replace(/\s+/g, ' ').trim();

/** Existing endpoint for same tenant normalized address. Params: [clientId, address]. */
const SQL_EXISTING_BY_ADDRESS = `
  SELECT id
    FROM tenant_channel_endpoints
   WHERE client_id = $1::uuid
     AND lower(public_address) = lower($2)
   LIMIT 1
   FOR UPDATE`.replace(/\s+/g, ' ').trim();

/**
 * Insert one disabled delegated Microsoft endpoint.
 * Params order is fixed and hostile-tested:
 *  $1 client_id, $2 location_id, $3 public_address, $4 capabilities jsonb,
 *  $5 actor (created_by + updated_by)
 * Forced constants live in SQL text (not caller params): channel, provider,
 * auth_mode, connector_mode, binding_status, null identity/secret fields,
 * inbound/outbound/active false, automation off.
 */
const SQL_INSERT_ENDPOINT = `
  INSERT INTO tenant_channel_endpoints (
    client_id,
    location_id,
    channel,
    provider,
    public_address,
    secret_ref,
    provider_resource_id,
    capabilities,
    inbound_enabled,
    outbound_enabled,
    default_automation_mode,
    active,
    auth_mode,
    connector_mode,
    provider_tenant_id,
    provider_principal_oid,
    mailbox_kind,
    mailbox_access_kind,
    binding_status,
    created_by,
    updated_by
  ) VALUES (
    $1::uuid,
    $2,
    'email',
    'microsoft_graph',
    $3,
    NULL,
    NULL,
    $4::jsonb,
    false,
    false,
    'off',
    false,
    'delegated_authorization_code',
    'microsoft_delegated_oauth',
    NULL,
    NULL,
    NULL,
    NULL,
    'unverified_offline',
    $5::uuid,
    $5::uuid
  )
  RETURNING id`.replace(/\s+/g, ' ').trim();

function failure() {
  const error = new Error(ERROR_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'SunsetMicrosoftEndpointPrepareError' });
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

function isCanonicalUuid(value) {
  return typeof value === 'string' && UUID_CANON.test(value);
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

/**
 * Exact own-data DB row surface (Object.prototype or null; exact key set;
 * enumerable data descriptors only). Values read once into a fresh record.
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

function snapshotQueryRows(result) {
  try {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    const rowsDesc = Object.getOwnPropertyDescriptor(result, 'rows');
    if (!rowsDesc
        || !Object.prototype.hasOwnProperty.call(rowsDesc, 'value')
        || rowsDesc.get
        || rowsDesc.set
        || !Array.isArray(rowsDesc.value)) {
      return null;
    }
    return rowsDesc.value;
  } catch {
    return null;
  }
}

/**
 * Canonical mailbox: lowercase + trim via shared normalizer; exact shape + length;
 * reject unpaired surrogates / C0 controls. Input must already be a string.
 */
function canonicalizeMailbox(raw) {
  if (typeof raw !== 'string') return null;
  if (hasUnpairedSurrogate(raw) || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const normalized = normalizeEmailPublicAddress(raw);
  if (!normalized
      || normalized.length < MAILBOX_MIN
      || normalized.length > MAILBOX_MAX
      || !PUBLIC_ADDRESS_RE.test(normalized)
      || normalized !== normalized.toLowerCase()
      || normalized !== normalized.trim()) {
    return null;
  }
  return normalized;
}

/**
 * Exact frozen ordered own-data snapshot of domain input.
 * clientId first: canonical lowercase UUID (route-resolved Sunset; re-proved in TX).
 * locationId: canonical kebab location; publicAddress: raw string (canonicalized later);
 * actorStaffUserId: canonical lowercase UUID.
 */
function snapshotAndValidateInput(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(input);
    if (actual.length !== INPUT_KEYS.length) return null;
    for (let i = 0; i < INPUT_KEYS.length; i += 1) {
      if (actual[i] !== INPUT_KEYS[i] || typeof actual[i] !== 'string') return null;
    }
    const out = Object.create(null);
    for (const key of INPUT_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
        return null;
      }
      out[key] = descriptor.value;
    }
    if (typeof out.clientId !== 'string' || !isCanonicalUuid(out.clientId)) {
      return null;
    }
    const location = validateCanonicalLocationId(out.locationId);
    if (!location.ok) return null;
    const mailbox = canonicalizeMailbox(out.publicAddress);
    if (!mailbox) return null;
    if (typeof out.actorStaffUserId !== 'string' || !isCanonicalUuid(out.actorStaffUserId)) {
      return null;
    }
    return Object.freeze({
      clientId: out.clientId,
      locationId: location.value,
      publicAddress: mailbox,
      actorStaffUserId: out.actorStaffUserId,
    });
  } catch {
    return null;
  }
}

function pinTransactionClient(dependencies) {
  if (!exactFrozenData(dependencies, DEPENDENCY_KEYS)) return null;
  const client = ownData(dependencies, 'client');
  if (!client || typeof client !== 'object') return null;
  if (typeof client.query !== 'function') return null;
  if (looksLikePgPool(client)) return null;
  if (typeof client.connect === 'function'
      && typeof client.query === 'function'
      && (Object.prototype.hasOwnProperty.call(client, 'totalCount')
        || Object.prototype.hasOwnProperty.call(client, 'idleCount')
        || Object.prototype.hasOwnProperty.call(client, 'waitingCount'))) {
    return null;
  }
  return client;
}

/**
 * Pin a single-use query surface over the transaction client.
 * After burn, any further query throws sanitized failure (no passthrough).
 */
function pinSingleUseQuerySurface(client) {
  let burned = false;
  return Object.freeze({
    async query(sql, params) {
      if (burned) throw failure();
      return client.query(sql, params);
    },
    burn() {
      burned = true;
    },
    isBurned() {
      return burned;
    },
  });
}

async function rollbackQuiet(client) {
  try {
    await client.query(SQL_ROLLBACK);
  } catch {
    /* sanitized: never leak rollback errors */
  }
}

function buildAck(endpointId) {
  return Object.freeze({
    endpointId,
  });
}

/**
 * One short TX. Pre-COMMIT failure → ROLLBACK. After COMMIT attempt is sent,
 * never ROLLBACK (commit outcome ambiguity → fixed sanitized failure).
 */
async function prepareInTransaction(client, snap) {
  let began = false;
  let commitSent = false;
  try {
    await client.query(SQL_BEGIN);
    began = true;

    // 1) Prove route-supplied clientId is the trusted Sunset slug+id exact.
    //    Never trust body client; hostile wrong/cross-tenant client rejects.
    const clientRes = await client.query(SQL_PROVE_SUNSET_CLIENT, [snap.clientId]);
    const clientRows = snapshotQueryRows(clientRes);
    if (!clientRows || clientRows.length !== 1) throw failure();
    const clientOwn = snapshotExactOwnDataRow(
      clientRows[0],
      CLIENT_ROW_KEYS,
      CLIENT_ROW_KEY_SET,
    );
    if (!clientOwn || clientOwn.client_id == null) throw failure();
    const clientId = String(clientOwn.client_id).toLowerCase();
    if (!isCanonicalUuid(clientId) || clientId !== snap.clientId) throw failure();

    // 2) Active exact location under that proven client.
    const locRes = await client.query(SQL_LOCK_ACTIVE_LOCATION, [
      clientId,
      snap.locationId,
    ]);
    const locRows = snapshotQueryRows(locRes);
    if (!locRows || locRows.length !== 1) throw failure();
    const locOwn = snapshotExactOwnDataRow(
      locRows[0],
      LOCATION_ROW_KEYS,
      LOCATION_ROW_KEY_SET,
    );
    if (!locOwn || locOwn.location_id !== snap.locationId) throw failure();

    // 3) Location reservation advisory lock BEFORE existing-by-location check.
    //    Same client+location serializes even when addresses differ (closes the
    //    same-location/different-address race). Parameterized hashtext only.
    //    Order is fixed: location lock first, address lock second (no deadlock).
    const locationLockKey = `${LOCK_NS_LOCATION}${snap.locationId}`;
    await client.query(SQL_ADVISORY_LOCK, [clientId, locationLockKey]);

    // 4) Reject preexisting endpoint for same client+location.
    const byLoc = await client.query(SQL_EXISTING_BY_LOCATION, [
      clientId,
      snap.locationId,
    ]);
    const byLocRows = snapshotQueryRows(byLoc);
    if (!byLocRows) throw failure();
    if (byLocRows.length > 0) {
      // Malformed row still means conflict path — reject without leaking address.
      throw failure();
    }

    // 5) Address reservation advisory lock (second; after location lock).
    const addressLockKey = `${LOCK_NS_ADDRESS}${snap.publicAddress}`;
    await client.query(SQL_ADVISORY_LOCK, [clientId, addressLockKey]);

    const byAddr = await client.query(SQL_EXISTING_BY_ADDRESS, [
      clientId,
      snap.publicAddress,
    ]);
    const byAddrRows = snapshotQueryRows(byAddr);
    if (!byAddrRows) throw failure();
    if (byAddrRows.length > 0) throw failure();

    // 6) Insert exactly one disabled delegated row; identity/secret null.
    const inserted = await client.query(SQL_INSERT_ENDPOINT, [
      clientId,
      snap.locationId,
      snap.publicAddress,
      FORCED_CAPABILITIES_JSON,
      snap.actorStaffUserId,
    ]);
    const insRows = snapshotQueryRows(inserted);
    if (!insRows || insRows.length !== 1) throw failure();
    const insOwn = snapshotExactOwnDataRow(
      insRows[0],
      INSERT_RETURNING_KEYS,
      INSERT_RETURNING_KEY_SET,
    );
    if (!insOwn || !isCanonicalUuid(String(insOwn.id))) throw failure();
    const endpointId = String(insOwn.id).toLowerCase();
    if (!isCanonicalUuid(endpointId)) throw failure();

    commitSent = true;
    await client.query(SQL_COMMIT);
    began = false;
    commitSent = false;
    return buildAck(endpointId);
  } catch (err) {
    if (commitSent) {
      // COMMIT dispatched; outcome unknown — never ROLLBACK after COMMIT attempt.
      throw failure();
    }
    if (began) await rollbackQuiet(client);
    const code = err && err.code != null ? String(err.code) : '';
    if (code === ERROR_CODE) throw err;
    // SQLSTATE 23505 unique race — sanitized (no address / raw PG message).
    throw failure();
  }
}

/**
 * @param {object} dependencies exact frozen { client } pinned transaction client
 * @returns {{ prepareDisabledDelegatedEndpoint: Function }} exact frozen single-use surface
 */
function createSunsetMicrosoftEndpointPrepare(dependencies) {
  let client;
  try {
    client = pinTransactionClient(dependencies);
    if (!client) throw failure();
  } catch {
    throw failure();
  }

  const surface = pinSingleUseQuerySurface(client);
  let used = false;

  async function prepareDisabledDelegatedEndpoint(input) {
    if (used) throw failure();
    used = true; // Atomic burn before input reflection, validation, await, or SQL.

    let snap;
    try {
      snap = snapshotAndValidateInput(input);
      if (!snap) throw failure();
    } catch {
      throw failure();
    }

    try {
      return await prepareInTransaction(surface, snap);
    } catch (err) {
      // Burn query surface so a later reuse cannot observe partial state.
      try { surface.burn(); } catch { /* ignore */ }
      if (err && err.code === ERROR_CODE) throw err;
      throw failure();
    }
  }

  return Object.freeze({ prepareDisabledDelegatedEndpoint });
}

module.exports = Object.freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  PREPARE_METHOD,
  DEPENDENCY_KEYS,
  INPUT_KEYS,
  ACK_KEYS,
  SUNSET_CLIENT_SLUG,
  PROVIDER,
  AUTH_MODE,
  CONNECTOR_MODE,
  BINDING_STATUS,
  CHANNEL,
  AUTOMATION_OFF,
  FORCED_CAPABILITIES,
  FORCED_CAPABILITIES_JSON,
  CLIENT_ROW_KEYS,
  LOCATION_ROW_KEYS,
  EXISTING_ROW_KEYS,
  INSERT_RETURNING_KEYS,
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
  createSunsetMicrosoftEndpointPrepare,
});
