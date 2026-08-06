'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  validBody,
  snapshotStartBody,
  snapshotResolveQueryResult,
  createStaffEmailOAuthRoutes,
  OAUTH_START_PATH,
  OAUTH_CALLBACK_PATH,
  SQL_RESOLVE_START_BINDING,
  START_BODY_KEYS,
  RESOLVE_ROW_KEYS,
} = require('./lib/staff-email-oauth-routes');

const LOCATION_SLUG = 'sunset-somo';
const ENDPOINT_ID = '55555555-5555-5555-5555-555555555555';
const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const LOCATION_UUID = '22222222-2222-2222-2222-222222222222';
const OTHER_ENDPOINT = '66666666-6666-6666-6666-666666666666';
const ids = {
  staff_user_id: '33333333-3333-3333-3333-333333333333',
  session_id: '44444444-4444-4444-4444-444444444444',
  client_id: CLIENT_ID,
  client_slug: 'sunset',
};

function startBody(overrides = {}) {
  const body = {};
  body.location_id = Object.prototype.hasOwnProperty.call(overrides, 'location_id')
    ? overrides.location_id
    : LOCATION_SLUG;
  body.endpoint_id = Object.prototype.hasOwnProperty.call(overrides, 'endpoint_id')
    ? overrides.endpoint_id
    : ENDPOINT_ID;
  return body;
}

function goodRow(overrides = {}) {
  const row = {};
  row.client_id = Object.prototype.hasOwnProperty.call(overrides, 'client_id')
    ? overrides.client_id
    : CLIENT_ID;
  row.location_id = Object.prototype.hasOwnProperty.call(overrides, 'location_id')
    ? overrides.location_id
    : LOCATION_UUID;
  row.endpoint_id = Object.prototype.hasOwnProperty.call(overrides, 'endpoint_id')
    ? overrides.endpoint_id
    : ENDPOINT_ID;
  return row;
}

function res() { return { status: null, body: null }; }
function sendJSON(r, s, b) { r.status = s; r.body = b; return b; }

const env = {
  LUNA_EMAIL_OAUTH_START_ENABLED: 'true',
  LUNA_DEPLOYMENT: 'sunset-staging',
  LUNA_EMAIL_OAUTH_CLIENT_ID: '55555555-5555-5555-5555-555555555555',
};

function routesWithQuery(queryImpl, extra = {}) {
  return createStaffEmailOAuthRoutes({
    runtimeEnv: env,
    sendJSON,
    assertStaffClientAccess() { return true; },
    authorizeAuthenticatedStaffRoute() { return { ok: true }; },
    withPgClient: (fn) => fn({ query: queryImpl }),
    ...extra,
  });
}

(async () => {
  assert.strictEqual(OAUTH_START_PATH, '/staff/admin/email-settings/oauth/microsoft/start');
  assert.strictEqual(OAUTH_CALLBACK_PATH, '/staff/email/oauth/microsoft/callback');
  assert.deepStrictEqual([...START_BODY_KEYS], ['location_id', 'endpoint_id']);
  assert.deepStrictEqual([...RESOLVE_ROW_KEYS], ['client_id', 'location_id', 'endpoint_id']);
  assert.strictEqual(validBody(startBody()), true);
  assert.strictEqual(validBody({ location_id: LOCATION_SLUG }), false);
  assert.strictEqual(validBody({ endpoint_id: ENDPOINT_ID, location_id: LOCATION_SLUG }), false); // wrong order
  assert.strictEqual(validBody({
    location_id: LOCATION_SLUG,
    endpoint_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'.toUpperCase(),
  }), false);

  const snap = snapshotStartBody(startBody());
  assert.ok(snap);
  assert.strictEqual(Object.isFrozen(snap), true);
  assert.strictEqual(snap.location_id, LOCATION_SLUG);
  assert.strictEqual(snap.endpoint_id, ENDPOINT_ID);
  assert.strictEqual(validBody(startBody()), Boolean(snapshotStartBody(startBody())));

  // Hostile bodies: wrong/missing/extra/accessor/symbol/proxy
  const accessor = {};
  Object.defineProperty(accessor, 'location_id', {
    enumerable: true,
    get() { return LOCATION_SLUG; },
  });
  Object.defineProperty(accessor, 'endpoint_id', {
    enumerable: true,
    get() { return ENDPOINT_ID; },
  });
  const withSymbol = startBody();
  withSymbol[Symbol('x')] = 'evil';
  for (const body of [
    {},
    { location_id: LOCATION_SLUG },
    { location_id: LOCATION_SLUG, endpoint_id: ENDPOINT_ID, extra: 'evil' },
    Object.create({ location_id: LOCATION_SLUG, endpoint_id: ENDPOINT_ID }),
    [],
    null,
    accessor,
    withSymbol,
    { location_id: 'NOT_CANONICAL', endpoint_id: ENDPOINT_ID },
    { location_id: LOCATION_SLUG, endpoint_id: 'not-a-uuid' },
  ]) {
    assert.strictEqual(validBody(body), false, `expected reject for ${JSON.stringify(body && Object.keys(body || {}))}`);
    assert.strictEqual(snapshotStartBody(body), null);
  }

  // ── (1) Proxy whose descriptor values change across calls ────────────────
  // Prove requested IDs cannot change and descriptors are each read once.
  {
    let locationDescReads = 0;
    let endpointDescReads = 0;
    const target = startBody();
    const flippingProxy = new Proxy(target, {
      getPrototypeOf() { return Object.prototype; },
      ownKeys() { return ['location_id', 'endpoint_id']; },
      getOwnPropertyDescriptor(_t, prop) {
        if (prop === 'location_id') {
          locationDescReads += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            // First read: good; subsequent reads would flip — snapshot must not re-read.
            value: locationDescReads === 1 ? LOCATION_SLUG : 'evil-location-slug',
          };
        }
        if (prop === 'endpoint_id') {
          endpointDescReads += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: endpointDescReads === 1 ? ENDPOINT_ID : OTHER_ENDPOINT,
          };
        }
        return undefined;
      },
      get(t, p) {
        // Direct property get must not be the snapshot path.
        if (p === 'endpoint_id') return OTHER_ENDPOINT;
        if (p === 'location_id') return 'evil-location-slug';
        return t[p];
      },
    });

    const once = snapshotStartBody(flippingProxy);
    assert.ok(once, 'first snapshot accepts first descriptor values');
    assert.strictEqual(once.location_id, LOCATION_SLUG);
    assert.strictEqual(once.endpoint_id, ENDPOINT_ID);
    assert.strictEqual(locationDescReads, 1, 'location_id descriptor read exactly once');
    assert.strictEqual(endpointDescReads, 1, 'endpoint_id descriptor read exactly once');

    // Second snapshot sees flipped descriptors → must not return first IDs as if revalidated then reread.
    const second = snapshotStartBody(flippingProxy);
    // After first full pass, counters are 2 on second call — values flipped → reject or different.
    // If it somehow accepted flipped evil values, they must not equal good IDs.
    if (second) {
      assert.notStrictEqual(second.endpoint_id, ENDPOINT_ID);
    }
    assert.strictEqual(locationDescReads, 2);
    assert.strictEqual(endpointDescReads, 2);

    // Handler path: one snapshot only; SQL params are first-read IDs; zero re-read of body.
    locationDescReads = 0;
    endpointDescReads = 0;
    const handlerProxy = new Proxy(target, {
      getPrototypeOf() { return Object.prototype; },
      ownKeys() { return ['location_id', 'endpoint_id']; },
      getOwnPropertyDescriptor(_t, prop) {
        if (prop === 'location_id') {
          locationDescReads += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: locationDescReads === 1 ? LOCATION_SLUG : 'evil-location-slug',
          };
        }
        if (prop === 'endpoint_id') {
          endpointDescReads += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: endpointDescReads === 1 ? ENDPOINT_ID : OTHER_ENDPOINT,
          };
        }
        return undefined;
      },
      get() { throw new Error('direct get must not be used after snapshot'); },
    });

    let sawParams = null;
    let inserts = 0;
    const rProxy = res();
    const routesProxy = routesWithQuery(async (sql, params) => {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.includes('FROM clients c') || n === SQL_RESOLVE_START_BINDING) {
        sawParams = params;
        return { rows: [goodRow()] };
      }
      inserts += 1;
      assert.strictEqual(params[4], ENDPOINT_ID, 'insert uses snapshotted endpoint only');
      return { rows: [{ expires_at: new Date(Date.now() + 600000) }] };
    });
    await routesProxy.handleStart(handlerProxy, null, rProxy, ids);
    assert.strictEqual(rProxy.status, 200);
    assert.deepStrictEqual(sawParams, [LOCATION_SLUG, ENDPOINT_ID]);
    assert.strictEqual(inserts, 1);
    assert.strictEqual(locationDescReads, 1, 'handler reads location descriptor once');
    assert.strictEqual(endpointDescReads, 1, 'handler reads endpoint descriptor once');
  }

  // Disabled: zero dependency construction / effects
  let touched = false;
  let r = res();
  let routes = createStaffEmailOAuthRoutes({
    runtimeEnv: {},
    sendJSON,
    assertStaffClientAccess() { touched = true; },
    withPgClient() { touched = true; },
  });
  await routes.handleStart(startBody(), null, r, ids);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(touched, false);

  // Missing eligible endpoint binding → 404 location_not_found
  r = res();
  let resolveParams = null;
  routes = routesWithQuery(async (sql, params) => {
    resolveParams = params;
    return { rows: [] };
  });
  await routes.handleStart(startBody({ location_id: 'foreign' }), null, r, ids);
  assert.strictEqual(r.status, 404);
  assert.deepStrictEqual(resolveParams, ['foreign', ENDPOINT_ID]);

  // Exact single binding row → start succeeds (create path mocked)
  r = res();
  let sawStartInsert = false;
  let sawResolveParams = null;
  routes = routesWithQuery(async (sql, params) => {
    const n = String(sql).replace(/\s+/g, ' ').trim();
    if (n.includes('FROM clients c') || n === SQL_RESOLVE_START_BINDING) {
      sawResolveParams = params;
      return { rows: [goodRow()] };
    }
    sawStartInsert = true;
    assert.strictEqual(params[4], ENDPOINT_ID); // endpointId
    return { rows: [{ expires_at: new Date(Date.now() + 600000) }] };
  });
  await routes.handleStart(startBody(), null, r, ids);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(typeof r.body.authorization_url, 'string');
  assert.ok(sawStartInsert);
  assert.deepStrictEqual(sawResolveParams, [LOCATION_SLUG, ENDPOINT_ID]);

  // Ambiguous rows → 503, no insert
  r = res();
  let inserts = 0;
  routes = routesWithQuery(async (sql) => {
    if (String(sql).includes('FROM clients c') || String(sql) === SQL_RESOLVE_START_BINDING) {
      return { rows: [goodRow(), goodRow()] };
    }
    inserts += 1;
    return { rows: [{}] };
  });
  await routes.handleStart(startBody(), null, r, ids);
  assert.strictEqual(r.status, 503);
  assert.deepStrictEqual(r.body, { success: false, error: 'oauth_start_unavailable' });
  assert.strictEqual(inserts, 0);

  // Cross-location endpoint: SQL returns empty (endpoint not at location)
  r = res();
  inserts = 0;
  routes = routesWithQuery(async () => {
    inserts += 1;
    return { rows: [] };
  });
  await routes.handleStart(startBody({ endpoint_id: OTHER_ENDPOINT }), null, r, ids);
  assert.strictEqual(r.status, 404);
  // only resolve query, no insert
  assert.strictEqual(inserts, 1);

  // Mismatched row endpoint_id → 503 no insert
  r = res();
  inserts = 0;
  routes = routesWithQuery(async (sql) => {
    if (String(sql).includes('FROM clients c') || String(sql) === SQL_RESOLVE_START_BINDING) {
      return { rows: [goodRow({ endpoint_id: OTHER_ENDPOINT })] };
    }
    inserts += 1;
    return { rows: [{}] };
  });
  await routes.handleStart(startBody(), null, r, ids);
  assert.strictEqual(r.status, 503);
  assert.strictEqual(inserts, 0);

  r = res();
  await routes.handleStart(startBody(), null, r, { ...ids, client_slug: 'wolfhouse' });
  assert.strictEqual(r.status, 403);

  // Hostile body: zero insert
  r = res();
  let pgCalls = 0;
  routes = createStaffEmailOAuthRoutes({
    runtimeEnv: env,
    sendJSON,
    assertStaffClientAccess() { return true; },
    authorizeAuthenticatedStaffRoute() { return { ok: true }; },
    withPgClient: (fn) => {
      pgCalls += 1;
      return fn({ query: async () => ({ rows: [] }) });
    },
  });
  await routes.handleStart({ location_id: LOCATION_SLUG, extra: 'evil' }, null, r, ids);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(pgCalls, 0);

  // ── (2) Strict resolve row snapshot hostility ────────────────────────────
  async function assertRejectResolve(label, queryResult) {
    const rr = res();
    let ins = 0;
    const routesH = routesWithQuery(async (sql) => {
      if (String(sql).includes('FROM clients c') || String(sql) === SQL_RESOLVE_START_BINDING) {
        return queryResult;
      }
      ins += 1;
      return { rows: [{ expires_at: new Date() }] };
    });
    await routesH.handleStart(startBody(), null, rr, ids);
    assert.strictEqual(rr.status, 503, label);
    assert.deepStrictEqual(rr.body, { success: false, error: 'oauth_start_unavailable' }, label);
    assert.strictEqual(ins, 0, `${label}: zero insert`);
    assert.ok(!JSON.stringify(rr.body).includes(OTHER_ENDPOINT), `${label}: sanitized`);
  }

  // Row accessor getters rejected
  {
    const row = {};
    for (const key of RESOLVE_ROW_KEYS) {
      const base = goodRow()[key];
      Object.defineProperty(row, key, {
        enumerable: true,
        get() { return base; },
      });
    }
    await assertRejectResolve('row accessors', { rows: [row] });
  }

  // Descriptor flips after first read — snapshot reads once; second value never used.
  // If first values are good, start may succeed using first-read only.
  {
    const reads = { client_id: 0, location_id: 0, endpoint_id: 0 };
    const flipping = {};
    for (const key of RESOLVE_ROW_KEYS) {
      Object.defineProperty(flipping, key, {
        enumerable: true,
        configurable: true,
        get() {
          // accessors rejected
          return goodRow()[key];
        },
      });
    }
    // Value-descriptor flipping via Proxy on the row
    const rowTarget = goodRow();
    const flippingRow = new Proxy(rowTarget, {
      getPrototypeOf() { return Object.prototype; },
      ownKeys() { return ['client_id', 'location_id', 'endpoint_id']; },
      getOwnPropertyDescriptor(_t, prop) {
        if (!RESOLVE_ROW_KEYS.includes(prop)) return undefined;
        reads[prop] += 1;
        const good = goodRow()[prop];
        const evil = prop === 'endpoint_id' ? OTHER_ENDPOINT
          : prop === 'client_id' ? '99999999-9999-9999-9999-999999999999'
            : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: reads[prop] === 1 ? good : evil,
        };
      },
      get() { throw new Error('direct row get forbidden'); },
    });

    let insertEndpoint = null;
    let ins = 0;
    const rr = res();
    const routesFlip = routesWithQuery(async (sql, params) => {
      if (String(sql).includes('FROM clients c') || String(sql) === SQL_RESOLVE_START_BINDING) {
        return { rows: [flippingRow] };
      }
      ins += 1;
      insertEndpoint = params[4];
      return { rows: [{ expires_at: new Date(Date.now() + 600000) }] };
    });
    await routesFlip.handleStart(startBody(), null, rr, ids);
    assert.strictEqual(rr.status, 200, 'first descriptor values accepted once');
    assert.strictEqual(insertEndpoint, ENDPOINT_ID, 'insert uses first-read endpoint only');
    assert.strictEqual(ins, 1);
    assert.strictEqual(reads.client_id, 1);
    assert.strictEqual(reads.location_id, 1);
    assert.strictEqual(reads.endpoint_id, 1);
  }

  // Proxy rows array with wrong endpoint → 503, zero insert
  {
    const rowsProxy = new Proxy([goodRow()], {
      getPrototypeOf() { return Array.prototype; },
      get(t, p) {
        if (p === 'length') return 1;
        if (p === '0') return goodRow({ endpoint_id: OTHER_ENDPOINT });
        return t[p];
      },
      getOwnPropertyDescriptor(t, p) {
        if (p === 'length') {
          return {
            configurable: false,
            enumerable: false,
            writable: true,
            value: 1,
          };
        }
        if (p === '0') {
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: goodRow({ endpoint_id: OTHER_ENDPOINT }),
          };
        }
        return Object.getOwnPropertyDescriptor(t, p);
      },
      ownKeys() { return ['0', 'length']; },
    });
    await assertRejectResolve('proxy rows wrong endpoint', { rows: rowsProxy });
  }

  // result.rows accessor
  {
    const result = {};
    Object.defineProperty(result, 'rows', {
      enumerable: true,
      get() { return [goodRow()]; },
    });
    await assertRejectResolve('rows accessor', result);
  }

  // Extra key on row
  await assertRejectResolve('row extra key', {
    rows: [{ ...goodRow(), extra: 'evil' }],
  });

  // Wrong key order
  await assertRejectResolve('row wrong order', {
    rows: [{
      endpoint_id: ENDPOINT_ID,
      client_id: CLIENT_ID,
      location_id: LOCATION_UUID,
    }],
  });

  // Symbol on row
  {
    const row = goodRow();
    row[Symbol('x')] = 'evil';
    await assertRejectResolve('row symbol', { rows: [row] });
  }

  // Uppercase UUID rejected (canonical lowercase only)
  await assertRejectResolve('uppercase endpoint', {
    rows: [goodRow({ endpoint_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'.toUpperCase() })],
  });
  await assertRejectResolve('uppercase client_id', {
    rows: [goodRow({ client_id: 'aabbccdd-eeff-4123-8456-7890abcdef01'.toUpperCase() })],
  });

  // Mutating rows after return must not affect start (snapshot copies values)
  {
    const mutableRow = goodRow();
    let ins = 0;
    let insertEndpoint = null;
    const rr = res();
    const routesMut = routesWithQuery(async (sql, params) => {
      if (String(sql).includes('FROM clients c') || String(sql) === SQL_RESOLVE_START_BINDING) {
        return { rows: [mutableRow] };
      }
      // Mutate after resolve would have returned — service.start uses snapshot only.
      mutableRow.endpoint_id = OTHER_ENDPOINT;
      mutableRow.client_id = '99999999-9999-9999-9999-999999999999';
      ins += 1;
      insertEndpoint = params[4];
      return { rows: [{ expires_at: new Date(Date.now() + 600000) }] };
    });
    await routesMut.handleStart(startBody(), null, rr, ids);
    assert.strictEqual(rr.status, 200);
    assert.strictEqual(insertEndpoint, ENDPOINT_ID);
    assert.strictEqual(ins, 1);
  }

  // ── snapshotResolveQueryResult: one-read descriptors + pg metadata ───────
  {
    // Ordinary realistic pg QueryResult metadata accepted (empty + one row).
    const emptyPg = {
      command: 'SELECT',
      rowCount: 0,
      oid: null,
      rows: [],
      fields: [],
    };
    assert.deepStrictEqual(snapshotResolveQueryResult(emptyPg), Object.freeze({ kind: 'empty' }));

    const onePg = {
      command: 'SELECT',
      rowCount: 1,
      oid: null,
      rows: [goodRow()],
      fields: [{ name: 'client_id' }],
    };
    const oneSnap = snapshotResolveQueryResult(onePg);
    assert.strictEqual(oneSnap.kind, 'one');
    assert.strictEqual(oneSnap.row.endpoint_id, ENDPOINT_ID);
    assert.strictEqual(Object.isFrozen(oneSnap.row), true);

    // Multi-row invalid.
    assert.deepStrictEqual(
      snapshotResolveQueryResult({ rows: [goodRow(), goodRow()] }),
      Object.freeze({ kind: 'invalid' }),
    );

    // Root symbol / accessor / non-ordinary proto rejected.
    const withSym = { rows: [goodRow()] };
    withSym[Symbol('x')] = 1;
    assert.strictEqual(snapshotResolveQueryResult(withSym).kind, 'invalid');

    const rootAccessor = {};
    Object.defineProperty(rootAccessor, 'rows', {
      enumerable: true,
      get() { return [goodRow()]; },
    });
    assert.strictEqual(snapshotResolveQueryResult(rootAccessor).kind, 'invalid');

    const metaAccessor = { rows: [goodRow()] };
    Object.defineProperty(metaAccessor, 'rowCount', {
      enumerable: true,
      get() { return 1; },
    });
    assert.strictEqual(snapshotResolveQueryResult(metaAccessor).kind, 'invalid');

    assert.strictEqual(
      snapshotResolveQueryResult(Object.create({ rows: [goodRow()] })).kind,
      'invalid',
    );

    // Sparse / wrong ownKeys forms rejected (never direct length read).
    const sparse = [];
    sparse.length = 1; // no index 0 own key
    assert.strictEqual(snapshotResolveQueryResult({ rows: sparse }).kind, 'invalid');

    // length-1 array whose ownKeys report an extra non-index key → invalid
    const extraKeyRows = new Proxy([goodRow()], {
      getPrototypeOf() { return Array.prototype; },
      ownKeys() { return ['0', 'extra', 'length']; },
      getOwnPropertyDescriptor(t, prop) {
        if (prop === 'length') {
          return {
            configurable: false,
            enumerable: false,
            writable: true,
            value: 1,
          };
        }
        if (prop === '0') {
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: goodRow(),
          };
        }
        if (prop === 'extra') {
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: 'evil',
          };
        }
        return undefined;
      },
    });
    assert.strictEqual(snapshotResolveQueryResult({ rows: extraKeyRows }).kind, 'invalid');

    // Empty with extra own key rejected.
    const emptyExtra = [];
    emptyExtra.extra = true;
    assert.strictEqual(snapshotResolveQueryResult({ rows: emptyExtra }).kind, 'invalid');
  }

  // Proxy flipping root/rows length/index descriptors: exact observation counts,
  // first-read values only, no substitution/insert on second flip.
  {
    const obs = {
      rootOwnKeys: 0,
      rootDesc: Object.create(null),
      rowsOwnKeys: 0,
      lengthDesc: 0,
      indexDesc: 0,
      rootProto: 0,
      rowsProto: 0,
    };

    const realRow = goodRow();
    const realRows = [realRow];

    const rowsProxy = new Proxy(realRows, {
      getPrototypeOf() {
        obs.rowsProto += 1;
        return Array.prototype;
      },
      ownKeys() {
        obs.rowsOwnKeys += 1;
        return ['0', 'length'];
      },
      getOwnPropertyDescriptor(_t, prop) {
        if (prop === 'length') {
          obs.lengthDesc += 1;
          return {
            configurable: false,
            enumerable: false,
            writable: true,
            // First observation: length 1; subsequent would claim multi-row.
            value: obs.lengthDesc === 1 ? 1 : 99,
          };
        }
        if (prop === '0') {
          obs.indexDesc += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: obs.indexDesc === 1
              ? realRow
              : goodRow({ endpoint_id: OTHER_ENDPOINT }),
          };
        }
        return undefined;
      },
      get(_t, prop) {
        // Promise thenable probe only; snapshot must not direct-get data props.
        if (prop === 'then') return undefined;
        throw new Error(`direct rows get must not be used: ${String(prop)}`);
      },
    });

    const rootTarget = {
      command: 'SELECT',
      rowCount: 1,
      oid: null,
      rows: rowsProxy,
      fields: [],
    };
    const rootProxy = new Proxy(rootTarget, {
      getPrototypeOf() {
        obs.rootProto += 1;
        return Object.prototype;
      },
      ownKeys() {
        obs.rootOwnKeys += 1;
        return ['command', 'rowCount', 'oid', 'rows', 'fields'];
      },
      getOwnPropertyDescriptor(_t, prop) {
        obs.rootDesc[prop] = (obs.rootDesc[prop] || 0) + 1;
        if (prop === 'rows') {
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            // Second rows descriptor would substitute empty — must not be reread.
            value: obs.rootDesc.rows === 1 ? rowsProxy : [],
          };
        }
        if (prop === 'command' || prop === 'rowCount' || prop === 'oid' || prop === 'fields') {
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: rootTarget[prop],
          };
        }
        return undefined;
      },
      get(_t, prop) {
        if (prop === 'then') return undefined;
        throw new Error(`direct root get must not be used: ${String(prop)}`);
      },
    });

    const once = snapshotResolveQueryResult(rootProxy);
    assert.strictEqual(once.kind, 'one');
    assert.strictEqual(once.row.endpoint_id, ENDPOINT_ID);
    assert.strictEqual(obs.rootOwnKeys, 1, 'root ownKeys once');
    assert.strictEqual(obs.rootProto, 1, 'root getPrototypeOf once');
    assert.strictEqual(obs.rootDesc.rows, 1, 'rows descriptor once');
    assert.strictEqual(obs.rootDesc.command, 1);
    assert.strictEqual(obs.rootDesc.rowCount, 1);
    assert.strictEqual(obs.rootDesc.oid, 1);
    assert.strictEqual(obs.rootDesc.fields, 1);
    assert.strictEqual(obs.rowsOwnKeys, 1, 'rows ownKeys once');
    assert.strictEqual(obs.rowsProto, 1, 'rows getPrototypeOf once');
    assert.strictEqual(obs.lengthDesc, 1, 'length descriptor once');
    assert.strictEqual(obs.indexDesc, 1, 'index 0 descriptor once');

    // Second full snapshot sees flipped descriptors — must not reuse first values
    // as if reread without a fresh observation. Flipped rows descriptor yields
    // empty array → empty (not a silent reuse of the first one-row snapshot).
    const second = snapshotResolveQueryResult(rootProxy);
    assert.notStrictEqual(second.kind, 'one', 'must not reuse first one-row snapshot');
    assert.ok(second.kind === 'empty' || second.kind === 'invalid');
    assert.strictEqual(obs.rootOwnKeys, 2);
    assert.strictEqual(obs.rootDesc.rows, 2);
    // Second call short-circuits on empty rows; length/index not re-observed beyond first call.
    assert.strictEqual(obs.lengthDesc, 1, 'length not re-read after rows substituted empty');
    assert.strictEqual(obs.indexDesc, 1, 'index not re-read after rows substituted empty');

    // Handler path: one snapshot; insert uses first-read endpoint only.
    Object.keys(obs.rootDesc).forEach((k) => { obs.rootDesc[k] = 0; });
    obs.rootOwnKeys = 0;
    obs.rowsOwnKeys = 0;
    obs.lengthDesc = 0;
    obs.indexDesc = 0;
    obs.rootProto = 0;
    obs.rowsProto = 0;

    // Rebuild proxies with fresh counters for handler path.
    const hObs = {
      rootOwnKeys: 0,
      rowsDesc: 0,
      rowsOwnKeys: 0,
      lengthDesc: 0,
      indexDesc: 0,
    };
    const hRows = new Proxy([realRow], {
      getPrototypeOf() { return Array.prototype; },
      ownKeys() {
        hObs.rowsOwnKeys += 1;
        return ['0', 'length'];
      },
      getOwnPropertyDescriptor(_t, prop) {
        if (prop === 'length') {
          hObs.lengthDesc += 1;
          return {
            configurable: false,
            enumerable: false,
            writable: true,
            value: hObs.lengthDesc === 1 ? 1 : 2,
          };
        }
        if (prop === '0') {
          hObs.indexDesc += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: hObs.indexDesc === 1
              ? realRow
              : goodRow({ endpoint_id: OTHER_ENDPOINT }),
          };
        }
        return undefined;
      },
      get(_t, prop) {
        if (prop === 'then') return undefined;
        throw new Error(`direct rows get: ${String(prop)}`);
      },
    });
    const hRoot = new Proxy({ rows: hRows }, {
      getPrototypeOf() { return Object.prototype; },
      ownKeys() {
        hObs.rootOwnKeys += 1;
        return ['rows'];
      },
      getOwnPropertyDescriptor(_t, prop) {
        if (prop === 'rows') {
          hObs.rowsDesc += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: hObs.rowsDesc === 1 ? hRows : [],
          };
        }
        return undefined;
      },
      get(_t, prop) {
        // async query result thenable probe — not a snapshot observation.
        if (prop === 'then') return undefined;
        throw new Error(`direct root get: ${String(prop)}`);
      },
    });

    let insertEndpoint = null;
    let ins = 0;
    const rr = res();
    const routesH = routesWithQuery(async (sql, params) => {
      if (String(sql).includes('FROM clients c') || String(sql) === SQL_RESOLVE_START_BINDING) {
        return hRoot;
      }
      ins += 1;
      insertEndpoint = params[4];
      return { rows: [{ expires_at: new Date(Date.now() + 600000) }] };
    });
    await routesH.handleStart(startBody(), null, rr, ids);
    assert.strictEqual(rr.status, 200, 'first descriptor values accepted once');
    assert.strictEqual(insertEndpoint, ENDPOINT_ID, 'no endpoint substitution');
    assert.strictEqual(ins, 1, 'exactly one insert');
    assert.strictEqual(hObs.rootOwnKeys, 1);
    assert.strictEqual(hObs.rowsDesc, 1);
    assert.strictEqual(hObs.rowsOwnKeys, 1);
    assert.strictEqual(hObs.lengthDesc, 1);
    assert.strictEqual(hObs.indexDesc, 1);
  }

  // SQL must pin endpoint_id param $2
  assert.match(SQL_RESOLVE_START_BINDING, /e\.id = \$2::uuid/);
  assert.match(SQL_RESOLVE_START_BINDING, /l\.location_id = \$1/);

  // Callback disabled still terminal 404 without runtime construction
  let constructed = false;
  r = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(v) { this.body = v; },
  };
  routes = createStaffEmailOAuthRoutes({
    runtimeEnv: { LUNA_DEPLOYMENT: 'sunset-staging' },
    sendJSON,
    assertStaffClientAccess() { return true; },
    withPgClient: () => { constructed = true; },
  });
  await routes.handleCallback(
    { state: Buffer.alloc(32, 4).toString('base64url'), code: 'opaque-code' },
    null,
    r,
    ids,
  );
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(constructed, false);

  // Callback enabled without readiness → fixed terminal, no leak
  r = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(v) { this.body = v; },
  };
  routes = createStaffEmailOAuthRoutes({
    runtimeEnv: {
      LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true',
      LUNA_DEPLOYMENT: 'sunset-staging',
      // missing client id/secret/envelope readiness
    },
    sendJSON,
    assertStaffClientAccess() { return true; },
    withPgClient: (fn) => fn({ query: async () => ({ rows: [] }) }),
  });
  await routes.handleCallback(
    { state: Buffer.alloc(32, 4).toString('base64url'), code: 'opaque-code' },
    null,
    r,
    ids,
  );
  assert.strictEqual(r.statusCode, 400);
  assert.match(r.headers['Content-Type'], /^text\/html/);
  assert.match(r.headers['Content-Security-Policy'], /default-src 'none'/);
  assert.match(r.body, /could not be accepted/i);
  assert.ok(!r.body.includes('opaque-code'));

  // Routes must not accept oauth envelope substitution / native DI keys
  const routesSrc = fs.readFileSync(
    path.join(__dirname, 'lib/staff-email-oauth-routes.js'),
    'utf8',
  );
  assert.equal(routesSrc.includes('oauthEnvelopeProvider'), false);
  assert.equal(routesSrc.includes('DEPENDENCY_KEYS_WITH_ENVELOPE'), false);
  assert.equal(routesSrc.includes('envelopeProvider'), false);
  assert.equal(routesSrc.includes('oauthHttps'), false);
  assert.equal(routesSrc.includes('oauthCrypto'), false);
  assert.equal(routesSrc.includes('oauthTimers'), false);
  assert.equal(routesSrc.includes('nativeRuntimeSurfaces'), false);
  assert.match(routesSrc, /snapshotStartBody/);
  assert.match(routesSrc, /productionNativeSurfaces/);
  assert.match(routesSrc, /snapshotResolveQueryResult/);
  assert.match(routesSrc, /PRODUCTION_HTTPS_REQUEST/);
  assert.match(routesSrc, /PRODUCTION_CRYPTO_CREATE_PUBLIC_KEY/);
  assert.match(routesSrc, /PRODUCTION_SET_TIMEOUT/);
  assert.match(routesSrc, /Reflect\.apply\(\s*PRODUCTION_HTTPS_REQUEST/);
  assert.equal(/Reflect\.apply\(\s*https\.request/.test(routesSrc), false);
  assert.equal(/rows\.length/.test(routesSrc), false);
  assert.match(routesSrc, /getOwnPropertyDescriptor\(rows,\s*'length'\)/);
  // Handler must call snapshot once — no validBody-then-reread / readStartBody path.
  assert.equal(routesSrc.includes('readStartBody'), false);
  assert.equal(/validBody\(body\)/.test(routesSrc.replace(/function validBody[\s\S]*?\n\}/, '')), false);

  console.log('PASS staff email OAuth routes hostile gates');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
