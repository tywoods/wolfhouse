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
      && /id\s*=\s*\$1::uuid/i.test(t);
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
    return /pg_advisory_xact_lock/i.test(t);
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
        }
        draft = null;
        tx = 'committed';
        return { rows: [], rowCount: 0 };
      }
      if (isRollback(text)) {
        draft = null;
        tx = 'rolled_back';
        return { rows: [], rowCount: 0 };
      }

      if (isProveClient(text)) {
        if (modes.clientThrow) {
          throw Object.assign(new Error(`${LEAK} client`), { code: 'XX000' });
        }
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
        const state = view();
        if (!state.locationActive || p[1] !== state.locationId || p[0] !== state.clientId) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ location_id: state.locationId }], rowCount: 1 };
      }

      if (isExistingLocation(text)) {
        if (Array.isArray(modes.byLocationRows)) {
          return { rows: modes.byLocationRows, rowCount: modes.byLocationRows.length };
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

      if (isAdvisory(text)) {
        return { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 };
      }

      if (isExistingAddress(text)) {
        if (Array.isArray(modes.byAddressRows)) {
          return { rows: modes.byAddressRows, rowCount: modes.byAddressRows.length };
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
        });
        state.endpointsByAddress.push({
          id: modes.insertId,
          public_address: p[2],
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
  assert.equal(texts[2], SQL_LOCK_ACTIVE_LOCATION);
  assert.deepEqual(fake.queries[2].params, [CLIENT_ID, LOCATION_ID]);
  assert.equal(texts[3], SQL_EXISTING_BY_LOCATION);
  assert.deepEqual(fake.queries[3].params, [CLIENT_ID, LOCATION_ID]);
  assert.equal(texts[4], SQL_ADVISORY_LOCK);
  assert.deepEqual(fake.queries[4].params, [CLIENT_ID, `ms-ep-prep-addr:${MAILBOX}`]);
  assert.equal(texts[5], SQL_EXISTING_BY_ADDRESS);
  assert.deepEqual(fake.queries[5].params, [CLIENT_ID, MAILBOX]);
  assert.equal(texts[6], SQL_INSERT_ENDPOINT);
  assert.deepEqual(fake.queries[6].params, [
    CLIENT_ID,
    LOCATION_ID,
    MAILBOX,
    FORCED_CAPABILITIES_JSON,
    ACTOR_ID,
  ]);
  assert.equal(texts[7], SQL_COMMIT);
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

  // Down: fail if null remains, drop named check, then SET NOT NULL.
  assert.match(down, /secret_ref IS NULL/);
  assert.match(down, /RAISE EXCEPTION/);
  assert.match(down, /DROP CONSTRAINT IF EXISTS tenant_channel_endpoints_secret_ref_null_policy/);
  assert.match(down, /ALTER COLUMN secret_ref SET NOT NULL/);
  // Order: null preflight before SET NOT NULL; constraint drop before SET NOT NULL.
  const downNullIdx = down.indexOf('secret_ref IS NULL');
  const downDropIdx = down.indexOf('DROP CONSTRAINT IF EXISTS tenant_channel_endpoints_secret_ref_null_policy');
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
