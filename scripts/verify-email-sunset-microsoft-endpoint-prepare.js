'use strict';

/**
 * Hostile offline gate for Sunset Microsoft delegated endpoint prepare.
 *
 * RED/GREEN evidence for exact shapes/order/freeze, accessors/symbols/proxies/
 * prototypes/descriptors, mailbox Unicode/case/length, exact SQL/params/order,
 * wrong tenant/location/status, hostile clientId, duplicate/preexisting, insert
 * counts, rollback/commit ambiguity, invalid-first/concurrent/reentrant/single-use,
 * no partial endpoint on failure, no raw address/error logs.
 *
 * Also static migration 062 gates: named null-policy CHECK, preflight, down
 * safety (no silent global nullable).
 *
 * Does not exercise live OAuth, Azure, deploy, seed, sync, or send.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
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
  INSERT_RETURNING_KEYS,
  SQL_BEGIN,
  SQL_COMMIT,
  SQL_ROLLBACK,
  SQL_PROVE_SUNSET_CLIENT,
  SQL_LOCK_ACTIVE_LOCATION,
  SQL_EXISTING_BY_LOCATION,
  SQL_ADVISORY_LOCK,
  LOCK_NS_LOCATION,
  LOCK_NS_ADDRESS,
  SQL_EXISTING_BY_ADDRESS,
  SQL_INSERT_ENDPOINT,
  createSunsetMicrosoftEndpointPrepare,
} = require('./lib/email-sunset-microsoft-endpoint-prepare');

const ROOT = path.join(__dirname, '..');
const LIB_REL = 'scripts/lib/email-sunset-microsoft-endpoint-prepare.js';
const VERIFY_REL = 'scripts/verify-email-sunset-microsoft-endpoint-prepare.js';
const REGISTRY_REL = 'scripts/lib/email-tenant-channel-registry.js';
const MIG_UP_REL = 'database/migrations/062_tenant_channel_endpoint_secret_ref_nullable.sql';
const MIG_DOWN_REL = 'database/migrations/062_tenant_channel_endpoint_secret_ref_nullable_down.sql';
const MANIFEST_REL = 'database/migrations/canonical-manifest.json';

const LOCATION_ID = 'sunset-somo';
const ACTOR_ID = 'abcdef01-2345-4678-89ab-cdef01234567';
const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const HOSTILE_CLIENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENDPOINT_ID = '11111111-2222-4333-8444-555555555555';
const MAILBOX = 'front.desk@sunset.example';
const MAILBOX_UPPER = 'Front.Desk@Sunset.Example';
const LEAK_ADDR = 'LEAK-MAILBOX-DO-NOT-LOG@evil.example';
const LEAK = 'PREPARE-SECRET-DO-NOT-LEAK';

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

function failSanitized(error) {
  return error
    && error.code === ERROR_CODE
    && error.message === ERROR_MESSAGE
    && !String(error.message).includes(LEAK)
    && !String(error.message).includes(LEAK_ADDR)
    && !String(error.stack || '').includes(LEAK_ADDR)
    && !String(error).includes(LEAK_ADDR);
}

function assertNoSensitive(blob) {
  const s = typeof blob === 'string' ? blob : (() => {
    try { return JSON.stringify(blob); } catch { return String(blob); }
  })();
  assert.equal(s.includes(LEAK), false);
  assert.equal(s.includes(LEAK_ADDR), false);
  assert.equal(s.includes(MAILBOX_UPPER), false);
}

function goodInput(patch = {}) {
  const base = {
    clientId: CLIENT_ID,
    locationId: LOCATION_ID,
    publicAddress: MAILBOX,
    actorStaffUserId: ACTOR_ID,
  };
  return Object.freeze({ ...base, ...patch });
}

/**
 * Stateful fake pinned client: exact SQL order/params, commit/rollback,
 * preexisting location/address, insert counts, 23505, commit ambiguity,
 * hostile client prove (slug+id).
 */
function createFakePinnedClient(spec = {}) {
  const queries = [];
  let tx = 'idle';
  let committed = {
    clientId: CLIENT_ID,
    locationActive: spec.locationActive !== false,
    locationId: LOCATION_ID,
    endpointsByLocation: Array.isArray(spec.endpointsByLocation)
      ? spec.endpointsByLocation.slice()
      : [],
    endpointsByAddress: Array.isArray(spec.endpointsByAddress)
      ? spec.endpointsByAddress.slice()
      : [],
    inserted: null,
  };
  let draft = null;
  const modes = {
    clientRows: spec.clientRows,
    locationRows: spec.locationRows,
    byLocationRows: spec.byLocationRows,
    byAddressRows: spec.byAddressRows,
    insertRows: spec.insertRows,
    throwOn: spec.throwOn || null,
    commitThrow: spec.commitThrow === true,
    commitAmbiguous: spec.commitAmbiguous === true,
    beginThrow: spec.beginThrow === true,
    insertThrow: spec.insertThrow || null,
    clientThrow: spec.clientThrow || null,
    locationThrow: spec.locationThrow || null,
    insertId: spec.insertId || ENDPOINT_ID,
    /** When true, prove only matches when param clientId === committed.clientId. */
    proveOnlyExactClient: spec.proveOnlyExactClient !== false,
  };

  function isBegin(t) { return /^\s*BEGIN\b/i.test(t); }
  function isCommit(t) { return /^\s*COMMIT\b/i.test(t); }
  function isRollback(t) { return /^\s*ROLLBACK\b/i.test(t); }
  function isProveClient(t) {
    return /FROM\s+clients/i.test(t)
      && /slug\s*=\s*'sunset'/i.test(t)
      && /id\s*=\s*\$1::uuid/i.test(t)
      && /FOR\s+UPDATE/i.test(t);
  }
  function isLockLocation(t) {
    return /FROM\s+tenant_locations/i.test(t) && /FOR\s+SHARE/i.test(t);
  }
  function isExistingLocation(t) {
    return /FROM\s+tenant_channel_endpoints/i.test(t)
      && /location_id\s*=\s*\$2/i.test(t)
      && /FOR\s+UPDATE/i.test(t)
      && !/public_address/i.test(t);
  }
  function isAdvisory(t) {
    return /pg_advisory_xact_lock/i.test(t)
      && /hashtext\(\$1\)/i.test(t)
      && /hashtext\(\$2\)/i.test(t);
  }
  function isExistingAddress(t) {
    return /FROM\s+tenant_channel_endpoints/i.test(t)
      && /lower\(public_address\)/i.test(t)
      && /FOR\s+UPDATE/i.test(t);
  }
  function isInsert(t) {
    return /INSERT\s+INTO\s+tenant_channel_endpoints/i.test(t);
  }
  function view() {
    return draft || committed;
  }
  function ensureDraft() {
    if (!draft) {
      draft = {
        clientId: committed.clientId,
        locationActive: committed.locationActive,
        locationId: committed.locationId,
        endpointsByLocation: committed.endpointsByLocation.slice(),
        endpointsByAddress: committed.endpointsByAddress.slice(),
        inserted: committed.inserted ? { ...committed.inserted } : null,
      };
    }
    return draft;
  }

  /** Optional shared multi-TX scheduler (location/address advisory + client row pin). */
  const scheduler = spec.scheduler || null;
  const heldLocks = new Set();
  let clientRowHeld = false;

  async function acquireAdvisory(lockKey) {
    if (!scheduler) return;
    await scheduler.acquire(lockKey, heldLocks);
  }

  function releaseAllAdvisory() {
    if (!scheduler) return;
    for (const key of heldLocks) scheduler.release(key);
    heldLocks.clear();
  }

  async function pinClientRow() {
    if (!scheduler || !scheduler.pinClientRow) return;
    await scheduler.pinClientRow();
    clientRowHeld = true;
  }

  function unpinClientRow() {
    if (!scheduler || !scheduler.unpinClientRow || !clientRowHeld) return;
    scheduler.unpinClientRow();
    clientRowHeld = false;
  }

  const client = {
    async query(sql, params) {
      const text = String(sql || '');
      const p = Array.isArray(params) ? params.slice() : [];
      queries.push({ text, params: p, tx });

      if (modes.throwOn && modes.throwOn(text, p, tx)) {
        const err = new Error(`${LEAK} injected ${LEAK_ADDR}`);
        err.code = modes.throwOnCode || 'XX000';
        throw err;
      }

      if (isBegin(text)) {
        if (modes.beginThrow) {
          const err = new Error(`${LEAK} begin`);
          err.code = '08000';
          throw err;
        }
        if (tx === 'open') throw Object.assign(new Error('nested begin'), { code: '25001' });
        tx = 'open';
        draft = {
          clientId: committed.clientId,
          locationActive: committed.locationActive,
          locationId: committed.locationId,
          endpointsByLocation: committed.endpointsByLocation.slice(),
          endpointsByAddress: committed.endpointsByAddress.slice(),
          inserted: committed.inserted ? { ...committed.inserted } : null,
        };
        return { rows: [], rowCount: 0 };
      }
      if (isCommit(text)) {
        if (modes.commitAmbiguous) {
          const err = new Error(`${LEAK} commit ambiguous`);
          err.code = '57P01';
          throw err;
        }
        if (modes.commitThrow) {
          const err = new Error(`${LEAK} commit`);
          err.code = '08006';
          throw err;
        }
        if (draft) {
          committed = {
            clientId: draft.clientId,
            locationActive: draft.locationActive,
            locationId: draft.locationId,
            endpointsByLocation: draft.endpointsByLocation.slice(),
            endpointsByAddress: draft.endpointsByAddress.slice(),
            inserted: draft.inserted ? { ...draft.inserted } : null,
          };
          // Shared committed catalog for multi-factory proofs.
          if (scheduler && typeof scheduler.onCommit === 'function') {
            scheduler.onCommit(committed);
          }
        }
        draft = null;
        tx = 'committed';
        releaseAllAdvisory();
        unpinClientRow();
        return { rows: [], rowCount: 0 };
      }
      if (isRollback(text)) {
        draft = null;
        tx = 'rolled_back';
        releaseAllAdvisory();
        unpinClientRow();
        return { rows: [], rowCount: 0 };
      }

      if (isProveClient(text)) {
        if (modes.clientThrow) {
          throw Object.assign(new Error(`${LEAK} client`), { code: 'XX000' });
        }
        await pinClientRow();
        if (Array.isArray(modes.clientRows)) {
          return { rows: modes.clientRows, rowCount: modes.clientRows.length };
        }
        const want = String(p[0] || '').toLowerCase();
        if (modes.proveOnlyExactClient && want !== String(view().clientId).toLowerCase()) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{ client_id: view().clientId }],
          rowCount: 1,
        };
      }

      if (isLockLocation(text)) {
        if (modes.locationThrow) {
          throw Object.assign(new Error(`${LEAK} location`), { code: 'XX000' });
        }
        if (Array.isArray(modes.locationRows)) {
          return { rows: modes.locationRows, rowCount: modes.locationRows.length };
        }
        // Multi-location shared state: accept any active location listed on scheduler.
        if (scheduler && scheduler.isActiveLocation) {
          if (!scheduler.isActiveLocation(p[0], p[1])) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [{ location_id: p[1] }], rowCount: 1 };
        }
        const state = view();
        if (!state.locationActive || p[1] !== state.locationId || p[0] !== state.clientId) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ location_id: state.locationId }], rowCount: 1 };
      }

      if (isAdvisory(text)) {
        const lockKey = String(p[1] || '');
        await acquireAdvisory(lockKey);
        return { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 };
      }

      if (isExistingLocation(text)) {
        if (Array.isArray(modes.byLocationRows)) {
          return { rows: modes.byLocationRows, rowCount: modes.byLocationRows.length };
        }
        // Read shared catalog after location lock so concurrent loser observes winner.
        if (scheduler && scheduler.endpointsByLocation) {
          const hits = scheduler.endpointsByLocation.filter(
            (e) => e.client_id === p[0] && e.location_id === p[1],
          );
          return {
            rows: hits.map((e) => ({ id: e.id })),
            rowCount: hits.length,
          };
        }
        const state = view();
        const hits = state.endpointsByLocation.filter(
          (e) => e.location_id === p[1] || e.location_id == null,
        );
        return {
          rows: hits.map((e) => ({ id: e.id })),
          rowCount: hits.length,
        };
      }

      if (isExistingAddress(text)) {
        if (Array.isArray(modes.byAddressRows)) {
          return { rows: modes.byAddressRows, rowCount: modes.byAddressRows.length };
        }
        if (scheduler && scheduler.endpointsByAddress) {
          const addr = String(p[1] || '').toLowerCase();
          const hits = scheduler.endpointsByAddress.filter(
            (e) => e.client_id === p[0]
              && String(e.public_address || '').toLowerCase() === addr,
          );
          return {
            rows: hits.map((e) => ({ id: e.id })),
            rowCount: hits.length,
          };
        }
        const state = view();
        const addr = String(p[1] || '').toLowerCase();
        const hits = state.endpointsByAddress.filter(
          (e) => String(e.public_address || '').toLowerCase() === addr,
        );
        return {
          rows: hits.map((e) => ({ id: e.id })),
          rowCount: hits.length,
        };
      }

      if (isInsert(text)) {
        if (modes.insertThrow) {
          const err = modes.insertThrow instanceof Error
            ? modes.insertThrow
            : Object.assign(
              new Error(modes.insertThrow.message || `${LEAK} insert ${LEAK_ADDR}`),
              modes.insertThrow,
            );
          throw err;
        }
        if (Array.isArray(modes.insertRows)) {
          return { rows: modes.insertRows, rowCount: modes.insertRows.length };
        }
        const state = ensureDraft();
        if (state.inserted) {
          const err = new Error(`duplicate key ${LEAK_ADDR}`);
          err.code = '23505';
          throw err;
        }
        // Shared catalog: reject if another factory already reserved location/address.
        if (scheduler) {
          const locHit = (scheduler.endpointsByLocation || []).some(
            (e) => e.client_id === p[0] && e.location_id === p[1],
          );
          const addrHit = (scheduler.endpointsByAddress || []).some(
            (e) => e.client_id === p[0]
              && String(e.public_address || '').toLowerCase() === String(p[2] || '').toLowerCase(),
          );
          if (locHit || addrHit) {
            const err = new Error(`duplicate key ${LEAK_ADDR}`);
            err.code = '23505';
            throw err;
          }
        }
        state.inserted = {
          id: modes.insertId,
          client_id: p[0],
          location_id: p[1],
          public_address: p[2],
          capabilities: p[3],
          actor: p[4],
        };
        state.endpointsByLocation.push({
          id: modes.insertId,
          location_id: p[1],
          client_id: p[0],
        });
        state.endpointsByAddress.push({
          id: modes.insertId,
          public_address: p[2],
          client_id: p[0],
        });
        return { rows: [{ id: modes.insertId }], rowCount: 1 };
      }

      throw Object.assign(new Error(`unexpected SQL ${LEAK}`), { code: 'XX000' });
    },
  };

  return {
    client,
    queries,
    getCommitted: () => committed,
    getTx: () => tx,
    heldLocks,
  };
}

/**
 * Shared advisory-lock scheduler for multi-factory concurrency proofs.
 * Models transaction-scoped locks: acquire blocks until free; release on
 * commit/rollback. Optional client-row pin for FOR UPDATE slug-writer tests.
 */
function createSharedLockScheduler(options = {}) {
  const holders = new Map(); // lockKey -> owner token or true
  const waiters = new Map(); // lockKey -> [{ resolve }]
  const endpointsByLocation = [];
  const endpointsByAddress = [];
  const activeLocations = new Set(
    Array.isArray(options.activeLocations)
      ? options.activeLocations
      : [`${CLIENT_ID}::${LOCATION_ID}`],
  );
  let clientRowOwner = null;
  const clientRowWaiters = [];
  const events = [];

  function keyPair(clientId, locationId) {
    return `${clientId}::${locationId}`;
  }

  function acquire(lockKey, heldSet) {
    return new Promise((resolve) => {
      if (!holders.has(lockKey)) {
        holders.set(lockKey, true);
        heldSet.add(lockKey);
        events.push({ type: 'acquire', lockKey });
        resolve();
        return;
      }
      events.push({ type: 'wait', lockKey });
      if (!waiters.has(lockKey)) waiters.set(lockKey, []);
      waiters.get(lockKey).push({
        resolve: () => {
          holders.set(lockKey, true);
          heldSet.add(lockKey);
          events.push({ type: 'acquire', lockKey });
          resolve();
        },
      });
    });
  }

  function release(lockKey) {
    if (!holders.has(lockKey)) return;
    holders.delete(lockKey);
    events.push({ type: 'release', lockKey });
    const q = waiters.get(lockKey) || [];
    if (q.length > 0) {
      const next = q.shift();
      next.resolve();
    }
  }

  function pinClientRow() {
    return new Promise((resolve) => {
      if (!clientRowOwner) {
        clientRowOwner = true;
        events.push({ type: 'client_row_pin' });
        resolve();
        return;
      }
      events.push({ type: 'client_row_wait' });
      clientRowWaiters.push({
        resolve: () => {
          clientRowOwner = true;
          events.push({ type: 'client_row_pin' });
          resolve();
        },
      });
    });
  }

  function unpinClientRow() {
    if (!clientRowOwner) return;
    clientRowOwner = null;
    events.push({ type: 'client_row_unpin' });
    if (clientRowWaiters.length > 0) {
      const next = clientRowWaiters.shift();
      next.resolve();
    }
  }

  function onCommit(committed) {
    if (committed && committed.inserted) {
      const row = committed.inserted;
      endpointsByLocation.push({
        id: row.id,
        client_id: row.client_id,
        location_id: row.location_id,
      });
      endpointsByAddress.push({
        id: row.id,
        client_id: row.client_id,
        public_address: row.public_address,
      });
      events.push({ type: 'commit_insert', id: row.id, location_id: row.location_id });
    }
  }

  return {
    acquire,
    release,
    pinClientRow,
    unpinClientRow,
    onCommit,
    endpointsByLocation,
    endpointsByAddress,
    events,
    isActiveLocation(clientId, locationId) {
      return activeLocations.has(keyPair(clientId, locationId));
    },
    holders,
    isClientRowHeld: () => Boolean(clientRowOwner),
  };
}

// ── Contract surface ────────────────────────────────────────────────────────

test('exports exact frozen contract symbols and SQL constants', () => {
  assert.equal(ERROR_CODE, 'SUNSET_MS_ENDPOINT_PREPARE_INVALID');
  assert.equal(ERROR_MESSAGE, 'Sunset Microsoft endpoint prepare failed.');
  assert.equal(PREPARE_METHOD, 'prepareDisabledDelegatedEndpoint');
  assert.deepEqual([...DEPENDENCY_KEYS], ['client']);
  assert.deepEqual([...INPUT_KEYS], [
    'clientId',
    'locationId',
    'publicAddress',
    'actorStaffUserId',
  ]);
  assert.equal(INPUT_KEYS[0], 'clientId');
  assert.deepEqual([...ACK_KEYS], ['endpointId']);
  assert.equal(SUNSET_CLIENT_SLUG, 'sunset');
  assert.equal(PROVIDER, 'microsoft_graph');
  assert.equal(AUTH_MODE, 'delegated_authorization_code');
  assert.equal(CONNECTOR_MODE, 'microsoft_delegated_oauth');
  assert.equal(BINDING_STATUS, 'unverified_offline');
  assert.equal(CHANNEL, 'email');
  assert.equal(AUTOMATION_OFF, 'off');
  assert.deepEqual([...CLIENT_ROW_KEYS], ['client_id']);
  assert.deepEqual([...LOCATION_ROW_KEYS], ['location_id']);
  assert.deepEqual([...INSERT_RETURNING_KEYS], ['id']);
  assert.equal(SQL_BEGIN, 'BEGIN');
  assert.equal(SQL_COMMIT, 'COMMIT');
  assert.equal(SQL_ROLLBACK, 'ROLLBACK');
  assert.match(SQL_PROVE_SUNSET_CLIENT, /slug = 'sunset'/);
  assert.match(SQL_PROVE_SUNSET_CLIENT, /id = \$1::uuid/);
  // Trusted tenant pin: exact clients row FOR UPDATE through commit/rollback.
  assert.match(SQL_PROVE_SUNSET_CLIENT, /FOR UPDATE/);
  assert.equal(SQL_ADVISORY_LOCK, 'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))');
  assert.equal(LOCK_NS_LOCATION, 'ms-ep-prep-loc:');
  assert.equal(LOCK_NS_ADDRESS, 'ms-ep-prep-addr:');
  // No interpolated identifiers in advisory SQL (parameterized hashtext only).
  assert.equal(/ms-ep-prep/.test(SQL_ADVISORY_LOCK), false);
  assert.equal(/hashtext\s*\(\s*'/.test(SQL_ADVISORY_LOCK), false);
  assert.match(SQL_INSERT_ENDPOINT, /auth_mode/);
  assert.match(SQL_INSERT_ENDPOINT, /delegated_authorization_code/);
  assert.match(SQL_INSERT_ENDPOINT, /microsoft_delegated_oauth/);
  assert.match(SQL_INSERT_ENDPOINT, /unverified_offline/);
  assert.match(SQL_INSERT_ENDPOINT, /secret_ref/);
  // secret_ref NULL literal in VALUES (not a bound param for the secret).
  assert.match(SQL_INSERT_ENDPOINT, /NULL/);
  assert.equal(Object.keys(FORCED_CAPABILITIES).length, 8);
  for (const v of Object.values(FORCED_CAPABILITIES)) assert.equal(v, false);
  assert.equal(JSON.parse(FORCED_CAPABILITIES_JSON).reply, false);
  // No status/prepared ACK surface.
  const mod = require('./lib/email-sunset-microsoft-endpoint-prepare');
  assert.equal('PREPARE_ACK_STATUS' in mod, false);
  assert.equal(Object.prototype.hasOwnProperty.call(mod, 'PREPARE_ACK_STATUS'), false);
});

test('does not reuse or export generic registry creator', () => {
  const prepSrc = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
  assert.equal(prepSrc.includes('createDisabledTenantChannelEndpoint'), false);
  assert.equal(prepSrc.includes('email-tenant-channel-registry'), false);
  assert.equal(prepSrc.includes('require(\'./email-tenant-channel-registry\')'), false);
  const regSrc = fs.readFileSync(path.join(ROOT, REGISTRY_REL), 'utf8');
  // Registry creator remains legacy null auth_mode (INSERT column list omits identity modes).
  assert.match(regSrc, /async function createDisabledTenantChannelEndpoint/);
  const insertBlock = regSrc.slice(
    regSrc.indexOf('INSERT INTO tenant_channel_endpoints'),
    regSrc.indexOf('RETURNING id, client_id, location_id, channel, provider'),
  );
  assert.ok(insertBlock.length > 50);
  assert.equal(/auth_mode/.test(insertBlock), false);
  assert.equal(/connector_mode/.test(insertBlock), false);
  assert.equal(/binding_status/.test(insertBlock), false);
  // Generic registry still requires secret_ref (not weakened by 062).
  assert.match(regSrc, /secret_ref|secretRef/);
  assert.equal(/secret_ref\s*:\s*null/.test(regSrc), false);
});

// ── Happy path ──────────────────────────────────────────────────────────────

test('happy path: exact SQL order/params, forced flags, ack shape, no mailbox echo', async () => {
  const fake = createFakePinnedClient();
  const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
  const ack = await prep.prepareDisabledDelegatedEndpoint(goodInput({
    publicAddress: MAILBOX_UPPER,
  }));
  assert.equal(Object.isFrozen(ack), true);
  assert.deepEqual(Reflect.ownKeys(ack), ['endpointId']);
  assert.equal(ack.endpointId, ENDPOINT_ID);
  assert.equal('status' in ack, false);
  assertNoSensitive(ack);
  assert.equal(JSON.stringify(ack).includes(MAILBOX), false);
  assert.equal(JSON.stringify(ack).includes(MAILBOX_UPPER), false);

  const texts = fake.queries.map((q) => q.text);
  assert.equal(texts[0], SQL_BEGIN);
  assert.equal(texts[1], SQL_PROVE_SUNSET_CLIENT);
  assert.deepEqual(fake.queries[1].params, [CLIENT_ID]);
  assert.match(texts[1], /FOR UPDATE/);
  assert.equal(texts[2], SQL_LOCK_ACTIVE_LOCATION);
  assert.deepEqual(fake.queries[2].params, [CLIENT_ID, LOCATION_ID]);
  // Location advisory BEFORE existing-by-location (closes same-loc/diff-addr race).
  assert.equal(texts[3], SQL_ADVISORY_LOCK);
  assert.deepEqual(fake.queries[3].params, [CLIENT_ID, `${LOCK_NS_LOCATION}${LOCATION_ID}`]);
  assert.equal(texts[4], SQL_EXISTING_BY_LOCATION);
  assert.deepEqual(fake.queries[4].params, [CLIENT_ID, LOCATION_ID]);
  // Address advisory second (deterministic order: location then address).
  assert.equal(texts[5], SQL_ADVISORY_LOCK);
  assert.deepEqual(fake.queries[5].params, [CLIENT_ID, `${LOCK_NS_ADDRESS}${MAILBOX}`]);
  assert.equal(texts[6], SQL_EXISTING_BY_ADDRESS);
  assert.deepEqual(fake.queries[6].params, [CLIENT_ID, MAILBOX]);
  assert.equal(texts[7], SQL_INSERT_ENDPOINT);
  assert.deepEqual(fake.queries[7].params, [
    CLIENT_ID,
    LOCATION_ID,
    MAILBOX,
    FORCED_CAPABILITIES_JSON,
    ACTOR_ID,
  ]);
  assert.equal(texts[8], SQL_COMMIT);
  assert.equal(fake.getTx(), 'committed');
  assert.equal(fake.getCommitted().inserted.public_address, MAILBOX);
  assert.equal(fake.getCommitted().inserted.capabilities, FORCED_CAPABILITIES_JSON);
  assert.equal(fake.getCommitted().inserted.client_id, CLIENT_ID);
});

// ── Input hostility ─────────────────────────────────────────────────────────

test('rejects hostile input shapes (order, extras, accessors, symbols, prototypes, clientId)', async () => {
  const cases = [
    null,
    undefined,
    [],
    'string',
    Object.create(null),
    // missing clientId
    { locationId: LOCATION_ID, publicAddress: MAILBOX, actorStaffUserId: ACTOR_ID },
    // wrong order (clientId not first)
    {
      locationId: LOCATION_ID,
      publicAddress: MAILBOX,
      actorStaffUserId: ACTOR_ID,
      clientId: CLIENT_ID,
    },
    {
      clientId: CLIENT_ID,
      publicAddress: MAILBOX,
      locationId: LOCATION_ID,
      actorStaffUserId: ACTOR_ID,
    },
    {
      clientId: CLIENT_ID,
      locationId: LOCATION_ID,
      publicAddress: MAILBOX,
      actorStaffUserId: ACTOR_ID,
      extra: 1,
    },
    (() => {
      const o = {};
      Object.defineProperty(o, 'clientId', { get() { return CLIENT_ID; }, enumerable: true });
      o.locationId = LOCATION_ID;
      o.publicAddress = MAILBOX;
      o.actorStaffUserId = ACTOR_ID;
      return Object.freeze(o);
    })(),
    (() => {
      const o = {
        clientId: CLIENT_ID,
        locationId: LOCATION_ID,
        publicAddress: MAILBOX,
        actorStaffUserId: ACTOR_ID,
      };
      o[Symbol('x')] = 1;
      return Object.freeze(o);
    })(),
    Object.freeze(Object.assign(Object.create({ x: 1 }), {
      clientId: CLIENT_ID,
      locationId: LOCATION_ID,
      publicAddress: MAILBOX,
      actorStaffUserId: ACTOR_ID,
    })),
    Object.freeze({
      clientId: CLIENT_ID,
      locationId: LOCATION_ID,
      publicAddress: MAILBOX,
      actorStaffUserId: ACTOR_ID.toUpperCase(),
    }),
    Object.freeze({
      clientId: CLIENT_ID.toUpperCase(),
      locationId: LOCATION_ID,
      publicAddress: MAILBOX,
      actorStaffUserId: ACTOR_ID,
    }),
    Object.freeze({
      clientId: CLIENT_ID,
      locationId: 'Sunset-Somo',
      publicAddress: MAILBOX,
      actorStaffUserId: ACTOR_ID,
    }),
    Object.freeze({
      clientId: 'not-a-uuid',
      locationId: LOCATION_ID,
      publicAddress: MAILBOX,
      actorStaffUserId: ACTOR_ID,
    }),
  ];
  for (const bad of cases) {
    const fake = createFakePinnedClient();
    const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
    await assert.rejects(
      () => prep.prepareDisabledDelegatedEndpoint(bad),
      failSanitized,
    );
    assert.equal(fake.queries.length, 0, 'no SQL on invalid input');
  }
});

test('mailbox Unicode/case/length hostility', async () => {
  const badMailboxes = [
    '',
    '   ',
    'a@b',
    'no-at-sign.example',
    'a@',
    '@b.com',
    'a b@c.com',
    'a\u0000@b.com',
    'a@b.com\u007f',
    `a@${'b'.repeat(320)}.com`,
    `${'x'.repeat(330)}@e.com`,
    'front\uD800desk@sunset.example',
    'front\uDC00desk@sunset.example',
  ];
  badMailboxes.push(`${'a'.repeat(300)}@${'b'.repeat(30)}.com`);

  for (const publicAddress of badMailboxes) {
    const fake = createFakePinnedClient();
    const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
    await assert.rejects(
      () => prep.prepareDisabledDelegatedEndpoint(goodInput({ publicAddress })),
      failSanitized,
    );
    assert.equal(fake.queries.length, 0);
  }

  const fake = createFakePinnedClient();
  const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
  const ack = await prep.prepareDisabledDelegatedEndpoint(goodInput({
    publicAddress: '  Ada.Lovelace@Example.COM  ',
  }));
  assert.equal(ack.endpointId, ENDPOINT_ID);
  assert.equal(fake.getCommitted().inserted.public_address, 'ada.lovelace@example.com');
});

// ── Dependency / single-use ─────────────────────────────────────────────────

test('rejects pool-like and non-frozen deps; factory throws sanitized', () => {
  const pool = {
    query: async () => ({ rows: [] }),
    connect: async () => ({}),
    totalCount: 0,
  };
  assert.throws(
    () => createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: pool })),
    failSanitized,
  );
  assert.throws(
    () => createSunsetMicrosoftEndpointPrepare({ client: { query: async () => ({}) } }),
    failSanitized,
  );
  assert.throws(
    () => createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: { query: async () => ({}) }, extra: 1 })),
    failSanitized,
  );
});

test('single-use atomic burn: invalid-first, sequential second, concurrent, reentrant', async () => {
  {
    const fake = createFakePinnedClient();
    const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
    await assert.rejects(() => prep.prepareDisabledDelegatedEndpoint(null), failSanitized);
    assert.equal(fake.queries.length, 0);
    await assert.rejects(
      () => prep.prepareDisabledDelegatedEndpoint(goodInput()),
      failSanitized,
    );
    assert.equal(fake.queries.length, 0);
  }

  {
    const fake = createFakePinnedClient();
    const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
    await prep.prepareDisabledDelegatedEndpoint(goodInput());
    const n = fake.queries.length;
    await assert.rejects(
      () => prep.prepareDisabledDelegatedEndpoint(goodInput()),
      failSanitized,
    );
    assert.equal(fake.queries.length, n);
  }

  {
    const fake = createFakePinnedClient();
    const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
    const p1 = prep.prepareDisabledDelegatedEndpoint(goodInput());
    const p2 = prep.prepareDisabledDelegatedEndpoint(goodInput());
    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(failSanitized(rejected[0].reason), true);
  }

  {
    let reentered = false;
    let prep;
    const base = createFakePinnedClient();
    const wrapped = {
      async query(sql, params) {
        if (!reentered && /INSERT\s+INTO\s+tenant_channel_endpoints/i.test(String(sql))) {
          reentered = true;
          await assert.rejects(
            () => prep.prepareDisabledDelegatedEndpoint(goodInput()),
            failSanitized,
          );
        }
        return base.client.query(sql, params);
      },
    };
    prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: wrapped }));
    const ack = await prep.prepareDisabledDelegatedEndpoint(goodInput());
    assert.equal(ack.endpointId, ENDPOINT_ID);
    assert.equal(reentered, true);
  }
});

// ── Location / tenant / preexisting / hostile client ────────────────────────

test('rejects hostile wrong/cross-tenant clientId (prove fails, rollback, no insert)', async () => {
  const fake = createFakePinnedClient();
  const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
  await assert.rejects(
    () => prep.prepareDisabledDelegatedEndpoint(goodInput({ clientId: HOSTILE_CLIENT_ID })),
    failSanitized,
  );
  assert.equal(fake.getTx(), 'rolled_back');
  assert.equal(fake.getCommitted().inserted, null);
  assert.equal(fake.queries.some((q) => /INSERT/i.test(q.text)), false);
  // Prove SQL received hostile id as $1 (never trusted without slug match).
  const prove = fake.queries.find((q) => isProve(q.text));
  assert.ok(prove);
  assert.deepEqual(prove.params, [HOSTILE_CLIENT_ID]);
  function isProve(t) {
    return /FROM\s+clients/i.test(t) && /slug\s*=\s*'sunset'/i.test(t) && /id\s*=\s*\$1::uuid/i.test(t);
  }
});

test('rejects unknown/inactive location and missing sunset client (rollback, no insert)', async () => {
  {
    const fake = createFakePinnedClient({ locationActive: false });
    const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
    await assert.rejects(
      () => prep.prepareDisabledDelegatedEndpoint(goodInput()),
      failSanitized,
    );
    assert.equal(fake.getTx(), 'rolled_back');
    assert.equal(fake.getCommitted().inserted, null);
    assert.equal(fake.queries.some((q) => /INSERT/i.test(q.text)), false);
  }
  {
    const fake = createFakePinnedClient({ clientRows: [] });
    const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
    await assert.rejects(
      () => prep.prepareDisabledDelegatedEndpoint(goodInput()),
      failSanitized,
    );
    assert.equal(fake.getTx(), 'rolled_back');
    assert.equal(fake.getCommitted().inserted, null);
  }
  {
    const fake = createFakePinnedClient({
      clientRows: [
        { client_id: CLIENT_ID },
        { client_id: HOSTILE_CLIENT_ID },
      ],
    });
    const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
    await assert.rejects(
      () => prep.prepareDisabledDelegatedEndpoint(goodInput()),
      failSanitized,
    );
    assert.equal(fake.getCommitted().inserted, null);
  }
});

test('rejects preexisting endpoint same location or normalized address', async () => {
  {
    const fake = createFakePinnedClient({
      endpointsByLocation: [{ id: ENDPOINT_ID, location_id: LOCATION_ID }],
    });
    const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
    await assert.rejects(
      () => prep.prepareDisabledDelegatedEndpoint(goodInput()),
      failSanitized,
    );
    assert.equal(fake.getTx(), 'rolled_back');
    assert.equal(fake.getCommitted().inserted, null);
  }
  {
    const fake = createFakePinnedClient({
      endpointsByAddress: [{ id: ENDPOINT_ID, public_address: MAILBOX }],
    });
    const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
    await assert.rejects(
      () => prep.prepareDisabledDelegatedEndpoint(goodInput({
        publicAddress: MAILBOX_UPPER,
      })),
      failSanitized,
    );
    assert.equal(fake.getTx(), 'rolled_back');
    assert.equal(fake.getCommitted().inserted, null);
  }
});

test('SQLSTATE 23505 on insert → sanitized failure + rollback; no partial commit', async () => {
  const fake = createFakePinnedClient({
    insertThrow: Object.assign(new Error(`duplicate ${LEAK_ADDR}`), { code: '23505' }),
  });
  const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
  await assert.rejects(
    () => prep.prepareDisabledDelegatedEndpoint(goodInput()),
    failSanitized,
  );
  assert.equal(fake.getTx(), 'rolled_back');
  assert.equal(fake.getCommitted().inserted, null);
  const err = await prep.prepareDisabledDelegatedEndpoint(goodInput()).catch((e) => e);
  assert.equal(failSanitized(err), true);
});

test('insert row count not exactly one → rollback', async () => {
  {
    const fake = createFakePinnedClient({ insertRows: [] });
    const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
    await assert.rejects(
      () => prep.prepareDisabledDelegatedEndpoint(goodInput()),
      failSanitized,
    );
    assert.equal(fake.getTx(), 'rolled_back');
  }
  {
    const fake = createFakePinnedClient({
      insertRows: [{ id: ENDPOINT_ID }, { id: '22222222-2222-4222-8222-222222222222' }],
    });
    const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
    await assert.rejects(
      () => prep.prepareDisabledDelegatedEndpoint(goodInput()),
      failSanitized,
    );
    assert.equal(fake.getTx(), 'rolled_back');
  }
});

test('malformed driver rows (accessors/symbols/wrong keys) fail closed', async () => {
  const badClientRow = {};
  Object.defineProperty(badClientRow, 'client_id', {
    get() { return CLIENT_ID; },
    enumerable: true,
  });
  const fake = createFakePinnedClient({ clientRows: [badClientRow] });
  const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
  await assert.rejects(
    () => prep.prepareDisabledDelegatedEndpoint(goodInput()),
    failSanitized,
  );
  assert.equal(fake.getTx(), 'rolled_back');
});

test('commit ambiguity: never ROLLBACK after COMMIT attempt', async () => {
  const fake = createFakePinnedClient({ commitAmbiguous: true });
  const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
  await assert.rejects(
    () => prep.prepareDisabledDelegatedEndpoint(goodInput()),
    failSanitized,
  );
  const rollbacks = fake.queries.filter((q) => /^\s*ROLLBACK\b/i.test(q.text));
  assert.equal(rollbacks.length, 0);
  assert.equal(fake.queries.some((q) => /^\s*COMMIT\b/i.test(q.text)), true);
});

test('begin failure: no rollback attempt required; sanitized', async () => {
  const fake = createFakePinnedClient({ beginThrow: true });
  const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
  await assert.rejects(
    () => prep.prepareDisabledDelegatedEndpoint(goodInput()),
    failSanitized,
  );
  assert.equal(fake.getCommitted().inserted, null);
});

test('SQL text forces delegated modes and null identity/secret; no registry require', () => {
  assert.match(SQL_INSERT_ENDPOINT, /'delegated_authorization_code'/);
  assert.match(SQL_INSERT_ENDPOINT, /'microsoft_delegated_oauth'/);
  assert.match(SQL_INSERT_ENDPOINT, /'unverified_offline'/);
  assert.match(SQL_INSERT_ENDPOINT, /'microsoft_graph'/);
  assert.match(SQL_INSERT_ENDPOINT, /'email'/);
  assert.match(SQL_INSERT_ENDPOINT, /false,\s*false,\s*'off',\s*false/);
  const insertIdx = SQL_INSERT_ENDPOINT.indexOf('VALUES');
  const values = SQL_INSERT_ENDPOINT.slice(insertIdx);
  assert.match(values, /NULL,\s*NULL,\s*\$4::jsonb/);
});

test('error messages never include mailbox or raw SQL state text', async () => {
  const fake = createFakePinnedClient({
    insertThrow: Object.assign(new Error(`fail ${LEAK_ADDR} sqlstate`), { code: '23505' }),
  });
  const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));
  const err = await prep.prepareDisabledDelegatedEndpoint(goodInput({
    publicAddress: LEAK_ADDR.toLowerCase(),
  })).catch((e) => e);
  assert.equal(failSanitized(err), true);
  assertNoSensitive(err.message);
  assertNoSensitive(err.stack || '');
});

// ── Location/address advisory lock order + multi-factory concurrency ────────

test('advisory SQL is parameterized hashtext; location lock before existing-by-location', () => {
  assert.equal(SQL_ADVISORY_LOCK, 'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))');
  // No string-literal or identifier interpolation into advisory SQL.
  assert.equal(/hashtext\s*\(\s*'/.test(SQL_ADVISORY_LOCK), false);
  assert.equal(/ms-ep-prep/.test(SQL_ADVISORY_LOCK), false);
  const src = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
  // Location lock key construction uses LOCK_NS_LOCATION + locationId as $2 param.
  assert.match(src, /LOCK_NS_LOCATION/);
  assert.match(src, /LOCK_NS_ADDRESS/);
  // Order inside prepareInTransaction body only (const decls appear earlier).
  const fnStart = src.indexOf('async function prepareInTransaction');
  assert.ok(fnStart > 0);
  const body = src.slice(fnStart);
  const locLockIdx = body.indexOf('locationLockKey');
  const existLocCallIdx = body.indexOf('SQL_EXISTING_BY_LOCATION');
  const addrLockIdx = body.indexOf('addressLockKey');
  assert.ok(locLockIdx > 0, 'locationLockKey in prepareInTransaction');
  assert.ok(existLocCallIdx > locLockIdx, 'existing-by-location after location lock');
  assert.ok(addrLockIdx > existLocCallIdx, 'address lock after existing-by-location');
});

test('two independent factories, same location different addresses: only one commit', async () => {
  const scheduler = createSharedLockScheduler({
    activeLocations: [`${CLIENT_ID}::${LOCATION_ID}`],
  });
  const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const addrA = 'desk.a@sunset.example';
  const addrB = 'desk.b@sunset.example';

  const fakeA = createFakePinnedClient({ scheduler, insertId: idA });
  const fakeB = createFakePinnedClient({ scheduler, insertId: idB });
  const prepA = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fakeA.client }));
  const prepB = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fakeB.client }));

  // Interleave: start both; location lock serializes even with different addresses.
  const pA = prepA.prepareDisabledDelegatedEndpoint(goodInput({ publicAddress: addrA }));
  // Yield so A can take the location lock before B starts.
  await Promise.resolve();
  const pB = prepB.prepareDisabledDelegatedEndpoint(goodInput({ publicAddress: addrB }));
  const results = await Promise.allSettled([pA, pB]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one prepare commits');
  assert.equal(rejected.length, 1, 'loser rejects');
  assert.equal(failSanitized(rejected[0].reason), true);
  assert.equal(scheduler.endpointsByLocation.length, 1);
  assert.equal(scheduler.endpointsByLocation[0].location_id, LOCATION_ID);

  // Winner and loser both requested the same location lock key.
  const locKey = `${LOCK_NS_LOCATION}${LOCATION_ID}`;
  const waits = scheduler.events.filter((e) => e.type === 'wait' && e.lockKey === locKey);
  const acquires = scheduler.events.filter((e) => e.type === 'acquire' && e.lockKey === locKey);
  assert.ok(acquires.length >= 1);
  // Loser either waited on location lock or saw existing after winner committed.
  assert.ok(
    waits.length >= 1 || scheduler.events.some((e) => e.type === 'commit_insert'),
    'serialization via location lock or post-commit existing check',
  );

  // Loser rolled back (no second insert in shared catalog).
  const loserTx = [fakeA.getTx(), fakeB.getTx()].filter((t) => t === 'rolled_back');
  assert.equal(loserTx.length, 1);
  const winnerTx = [fakeA.getTx(), fakeB.getTx()].filter((t) => t === 'committed');
  assert.equal(winnerTx.length, 1);
});

test('different locations do not share location lock; both can commit', async () => {
  const locA = 'sunset-somo';
  const locB = 'sunset-other';
  const scheduler = createSharedLockScheduler({
    activeLocations: [`${CLIENT_ID}::${locA}`, `${CLIENT_ID}::${locB}`],
  });
  const idA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const idB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const fakeA = createFakePinnedClient({
    scheduler,
    insertId: idA,
    // per-client location id for non-scheduler path fallback
  });
  // Override committed location for single-location fallback is unused when scheduler is set.
  const fakeB = createFakePinnedClient({ scheduler, insertId: idB });
  const prepA = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fakeA.client }));
  const prepB = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fakeB.client }));

  const [rA, rB] = await Promise.all([
    prepA.prepareDisabledDelegatedEndpoint(goodInput({
      locationId: locA,
      publicAddress: 'a@sunset.example',
    })),
    prepB.prepareDisabledDelegatedEndpoint(goodInput({
      locationId: locB,
      publicAddress: 'b@sunset.example',
    })),
  ]);
  assert.equal(rA.endpointId, idA);
  assert.equal(rB.endpointId, idB);
  assert.equal(scheduler.endpointsByLocation.length, 2);

  const keyA = `${LOCK_NS_LOCATION}${locA}`;
  const keyB = `${LOCK_NS_LOCATION}${locB}`;
  assert.notEqual(keyA, keyB);
  // No wait on the other's location lock.
  const crossWaits = scheduler.events.filter(
    (e) => e.type === 'wait' && (e.lockKey === keyA || e.lockKey === keyB),
  );
  assert.equal(crossWaits.length, 0, 'distinct location locks never block each other');
});

test('same address across locations serializes on address lock and rejects loser', async () => {
  const locA = 'sunset-somo';
  const locB = 'sunset-other';
  const sharedAddr = 'shared.desk@sunset.example';
  const scheduler = createSharedLockScheduler({
    activeLocations: [`${CLIENT_ID}::${locA}`, `${CLIENT_ID}::${locB}`],
  });
  const idA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const idB = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const fakeA = createFakePinnedClient({ scheduler, insertId: idA });
  const fakeB = createFakePinnedClient({ scheduler, insertId: idB });
  const prepA = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fakeA.client }));
  const prepB = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fakeB.client }));

  const pA = prepA.prepareDisabledDelegatedEndpoint(goodInput({
    locationId: locA,
    publicAddress: sharedAddr,
  }));
  await Promise.resolve();
  const pB = prepB.prepareDisabledDelegatedEndpoint(goodInput({
    locationId: locB,
    publicAddress: sharedAddr,
  }));
  const results = await Promise.allSettled([pA, pB]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(failSanitized(rejected[0].reason), true);
  assert.equal(scheduler.endpointsByAddress.length, 1);
  assert.equal(
    String(scheduler.endpointsByAddress[0].public_address).toLowerCase(),
    sharedAddr,
  );

  const addrKey = `${LOCK_NS_ADDRESS}${sharedAddr}`;
  // Address lock key is shared; at least one waiter or post-commit reject path.
  assert.ok(
    scheduler.events.some((e) => e.lockKey === addrKey)
    || scheduler.events.some((e) => e.type === 'commit_insert'),
  );
});

test('optional real-PG concurrency proof is absent/unexecuted (do not claim stock PG ran)', () => {
  // Stock PostgreSQL concurrent prepare is not executed in this offline gate.
  // Shared-lock scheduler + exact SQL/order tests above are the CI evidence.
  // If a future prove-*-pg.js is added, it must report UNEXECUTED when PG is missing.
  const src = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
  // Domain module never opens a live PG pool/connection for concurrency proof.
  assert.equal(/\bnew\s+Pool\b/.test(src), false);
  assert.equal(/require\(['"]pg['"]\)/.test(src), false);
  assert.equal(/DATABASE_URL/.test(src), false);
  assert.equal(/postgres:\/\//.test(src), false);
  // This offline gate never connects; mark status without claiming stock PG ran.
  const realPgConcurrencyStatus = 'UNEXECUTED';
  assert.equal(realPgConcurrencyStatus, 'UNEXECUTED');
});

// ── Trusted tenant pin (FOR UPDATE clients row) ─────────────────────────────

test('SQL_PROVE_SUNSET_CLIENT locks exact clients row; concurrent slug writer blocked until end', async () => {
  assert.match(SQL_PROVE_SUNSET_CLIENT, /FROM\s+clients/i);
  assert.match(SQL_PROVE_SUNSET_CLIENT, /slug = 'sunset'/);
  assert.match(SQL_PROVE_SUNSET_CLIENT, /id = \$1::uuid/);
  assert.match(SQL_PROVE_SUNSET_CLIENT, /FOR UPDATE/);
  // FOR UPDATE appears after the WHERE predicates (row pin on matched row).
  const forUpdIdx = SQL_PROVE_SUNSET_CLIENT.indexOf('FOR UPDATE');
  const whereIdx = SQL_PROVE_SUNSET_CLIENT.indexOf('WHERE');
  assert.ok(forUpdIdx > whereIdx);

  const scheduler = createSharedLockScheduler();
  const fake = createFakePinnedClient({ scheduler });
  const prep = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: fake.client }));

  let slugWriterPassedDuringPrepare = false;
  let slugWriterResolvedAfter = false;
  let prepareReachedInsert = false;

  // Wrap client so we can inject a concurrent slug writer while prepare holds the pin.
  const baseQuery = fake.client.query.bind(fake.client);
  const wrapped = {
    async query(sql, params) {
      const text = String(sql || '');
      if (/INSERT\s+INTO\s+tenant_channel_endpoints/i.test(text) && !prepareReachedInsert) {
        prepareReachedInsert = true;
        assert.equal(scheduler.isClientRowHeld(), true, 'client row held at insert');
        // Concurrent slug writer tries UPDATE while prepare holds FOR UPDATE pin.
        let writerFinished = false;
        const writer = (async () => {
          await scheduler.pinClientRow(); // blocks until prepare unpins
          writerFinished = true;
          slugWriterResolvedAfter = true;
          scheduler.unpinClientRow();
        })();
        // Writer must not pass while prepare still holds the row.
        await Promise.resolve();
        await Promise.resolve();
        if (writerFinished) slugWriterPassedDuringPrepare = true;
        assert.equal(scheduler.isClientRowHeld(), true);
        assert.equal(writerFinished, false, 'slug writer blocked while prepare holds pin');
        const result = await baseQuery(sql, params);
        // Prepare still holds until COMMIT; writer still blocked.
        await Promise.resolve();
        assert.equal(writerFinished, false);
        // Stash writer so COMMIT can release and we can await it after prepare.
        wrapped._writer = writer;
        return result;
      }
      return baseQuery(sql, params);
    },
  };

  const surface = createSunsetMicrosoftEndpointPrepare(Object.freeze({ client: wrapped }));
  const ack = await surface.prepareDisabledDelegatedEndpoint(goodInput());
  assert.equal(ack.endpointId, ENDPOINT_ID);
  assert.equal(slugWriterPassedDuringPrepare, false);
  // After prepare commit, pin released; writer proceeds.
  if (wrapped._writer) await wrapped._writer;
  assert.equal(slugWriterResolvedAfter, true);
  assert.equal(scheduler.isClientRowHeld(), false);
  // Exact order: BEGIN → prove (FOR UPDATE) → …
  assert.equal(fake.queries[0].text, SQL_BEGIN);
  assert.equal(fake.queries[1].text, SQL_PROVE_SUNSET_CLIENT);
  assert.match(fake.queries[1].text, /FOR UPDATE/);
});

// ── Migration 062 static gates ──────────────────────────────────────────────

test('migration 062: named CHECK + preflight + down safety (static)', () => {
  const up = fs.readFileSync(path.join(ROOT, MIG_UP_REL), 'utf8');
  const down = fs.readFileSync(path.join(ROOT, MIG_DOWN_REL), 'utf8');

  // DROP NOT NULL only together with named fail-closed CHECK.
  assert.match(up, /ALTER COLUMN secret_ref DROP NOT NULL/);
  assert.match(up, /ADD CONSTRAINT tenant_channel_endpoints_secret_ref_null_policy/);
  assert.match(up, /tenant_channel_endpoints_secret_ref_null_policy/);

  // Delegated triple requires NULL secret_ref (all lifecycle — no binding_status filter).
  // IS NOT DISTINCT FROM closes NULL three-valued CHECK holes for legacy modes.
  assert.match(up, /provider = 'microsoft_graph'/);
  assert.match(up, /auth_mode IS NOT DISTINCT FROM 'delegated_authorization_code'/);
  assert.match(up, /connector_mode IS NOT DISTINCT FROM 'microsoft_delegated_oauth'/);
  assert.match(up, /\(secret_ref IS NULL\) = \(/);
  assert.equal(/binding_status/.test(up), false);

  // Preflight fails rather than silently permits invalid rows.
  assert.match(up, /RAISE EXCEPTION/);
  assert.match(up, /refuse silent permit|violate secret_ref nullability/i);
  assert.match(up, /IF EXISTS/);

  // Down: fail if null remains; DROP CONSTRAINT without IF EXISTS (drift fails);
  // then SET NOT NULL.
  assert.match(down, /secret_ref IS NULL/);
  assert.match(down, /RAISE EXCEPTION/);
  assert.match(down, /DROP CONSTRAINT\s+tenant_channel_endpoints_secret_ref_null_policy/);
  assert.equal(/DROP CONSTRAINT IF EXISTS/i.test(down), false);
  assert.match(down, /ALTER COLUMN secret_ref SET NOT NULL/);
  // Order: null preflight before SET NOT NULL; constraint drop before SET NOT NULL.
  const downNullIdx = down.indexOf('secret_ref IS NULL');
  const downDropIdx = down.indexOf('DROP CONSTRAINT tenant_channel_endpoints_secret_ref_null_policy');
  const downNotNullIdx = down.indexOf('ALTER COLUMN secret_ref SET NOT NULL');
  assert.ok(downNullIdx > 0 && downDropIdx > downNullIdx && downNotNullIdx > downDropIdx);

  // Not a global nullable free-for-all: CHECK encodes both sides of policy.
  assert.ok(up.includes('DROP NOT NULL'));
  assert.ok(up.includes('ADD CONSTRAINT'));
  // Up must not merely drop NOT NULL without the policy constraint.
  const dropIdx = up.indexOf('DROP NOT NULL');
  const checkIdx = up.indexOf('tenant_channel_endpoints_secret_ref_null_policy');
  assert.ok(checkIdx > 0);
  // Constraint definition appears after DROP (paired in same migration).
  assert.ok(up.indexOf('ADD CONSTRAINT tenant_channel_endpoints_secret_ref_null_policy') > dropIdx);

  // Manifest checksums match live files.
  const {
    checksumMigrationFile,
    CHECKSUM_MODE_CANONICAL_LF_V1,
    loadManifest,
    forwardEntries,
  } = require('./lib/migration-integrity');
  const manifest = loadManifest();
  const upEntry = manifest.entries.find((e) => e.id === '062_tenant_channel_endpoint_secret_ref_nullable');
  const downEntry = manifest.entries.find((e) => e.id === '062_tenant_channel_endpoint_secret_ref_nullable_down');
  assert.ok(upEntry && downEntry);
  const upHash = checksumMigrationFile(path.join(ROOT, MIG_UP_REL), CHECKSUM_MODE_CANONICAL_LF_V1);
  const downHash = checksumMigrationFile(path.join(ROOT, MIG_DOWN_REL), CHECKSUM_MODE_CANONICAL_LF_V1);
  assert.equal(upEntry.sha256, upHash.sha256);
  assert.equal(downEntry.sha256, downHash.sha256);
  assert.equal(upEntry.inForwardChain, true);
  assert.equal(downEntry.inForwardChain, false);
  const fwd = forwardEntries(manifest);
  assert.ok(fwd.some((e) => e.id === '062_tenant_channel_endpoint_secret_ref_nullable'));
  // Rationale mentions named CHECK / fail-closed.
  assert.match(upEntry.rationale, /CHECK|null_policy|fail/i);
});

test('migration 062 down: fails when expected constraint absent; succeeds only with constraint + no nulls', async () => {
  // Static contract: down has no IF EXISTS on DROP CONSTRAINT.
  const down = fs.readFileSync(path.join(ROOT, MIG_DOWN_REL), 'utf8');
  assert.equal(/DROP CONSTRAINT IF EXISTS/i.test(down), false);
  assert.match(down, /DROP CONSTRAINT\s+tenant_channel_endpoints_secret_ref_null_policy/);

  // Simulated proof (no claim of stock PG): missing constraint name → failure path.
  // Prefer PGlite when available; otherwise assert SQL shape only.
  let PGlite = null;
  try {
    PGlite = require('@electric-sql/pglite').PGlite;
  } catch {
    PGlite = null;
  }

  if (!PGlite) {
    // Exact SQL/order static only — do not claim real PG executed.
    assert.match(down, /RAISE EXCEPTION/);
    assert.match(down, /SET NOT NULL/);
    console.log('note - PGlite unavailable; down constraint-absent proof static only (not real PG)');
    return;
  }

  const db = new PGlite();
  await db.exec(`
    CREATE TABLE tenant_channel_endpoints (
      id uuid PRIMARY KEY,
      client_id uuid NOT NULL,
      location_id text NOT NULL,
      channel text NOT NULL DEFAULT 'email',
      provider text NOT NULL,
      public_address text,
      secret_ref text,
      provider_resource_id text,
      capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
      inbound_enabled boolean NOT NULL DEFAULT false,
      outbound_enabled boolean NOT NULL DEFAULT false,
      default_automation_mode text NOT NULL DEFAULT 'off',
      active boolean NOT NULL DEFAULT false,
      auth_mode text,
      connector_mode text,
      binding_status text
    );
  `);
  // No null rows, but constraint missing/renamed → DROP must fail (no IF EXISTS).
  let missingFailed = false;
  try {
    await db.exec(down);
  } catch (err) {
    missingFailed = true;
    const msg = String(err && err.message || err);
    assert.ok(
      /does not exist|constraint|tenant_channel_endpoints_secret_ref_null_policy/i.test(msg),
      `unexpected missing-constraint error: ${msg}`,
    );
  }
  assert.equal(missingFailed, true, 'down must fail when expected constraint is absent');
  try { await db.exec('ROLLBACK'); } catch { /* idle */ }

  // Present constraint + no null rows → down succeeds.
  await db.exec(`
    ALTER TABLE tenant_channel_endpoints
      ADD CONSTRAINT tenant_channel_endpoints_secret_ref_null_policy
      CHECK (
        (secret_ref IS NULL) = (
          provider = 'microsoft_graph'
          AND auth_mode IS NOT DISTINCT FROM 'delegated_authorization_code'
          AND connector_mode IS NOT DISTINCT FROM 'microsoft_delegated_oauth'
        )
      );
  `);
  await db.exec(down);
  // After down, NULL insert fails via NOT NULL.
  let nullRejected = false;
  try {
    await db.exec(`
      INSERT INTO tenant_channel_endpoints (
        id, client_id, location_id, provider, public_address, secret_ref
      ) VALUES (
        '11111111-1111-4111-8111-000000000001'::uuid,
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'::uuid,
        'loc-a', 'gmail_api', 'a@example.test', NULL
      )
    `);
  } catch {
    nullRejected = true;
  }
  assert.equal(nullRejected, true, 'post-down NOT NULL restored');
  await db.close();
});

// ── Source hygiene ──────────────────────────────────────────────────────────

test('source does not log addresses or raw errors', () => {
  const src = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
  assert.equal(/\bconsole\.(log|error|info|warn|debug)\b/.test(src), false);
  assert.equal(/err\.message/.test(src), false);
  assert.equal(/publicAddress/.test(src) && /console/.test(src), false);
  // No status/prepared ack surface in source.
  assert.equal(/PREPARE_ACK_STATUS/.test(src), false);
  assert.equal(/status:\s*PREPARE_ACK_STATUS|'prepared'/.test(src), false);
  assert.equal(/ACK_KEYS\s*=\s*Object\.freeze\(\[\s*['"]status['"]/.test(src), false);
});

test('package verify script is registered', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['verify:email-sunset-microsoft-endpoint-prepare'],
    'node scripts/verify-email-sunset-microsoft-endpoint-prepare.js',
  );
});

// ── Runner ──────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`ok - ${t.name}`);
    } catch (err) {
      failed += 1;
      console.error(`not ok - ${t.name}`);
      console.error(err);
    }
  }
  if (failed) {
    console.error(`FAIL ${failed}/${tests.length}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${tests.length} tests`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
