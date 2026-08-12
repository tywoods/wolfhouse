'use strict';

const assert = require('assert/strict');
const mod = require('./lib/email-sunset-google-endpoint-prepare');
const {
  ERROR_CODE, FORCED_CAPABILITIES, SQL_INSERT_ENDPOINT,
  SQL_EXISTING_BY_LOCATION, SQL_EXISTING_BY_ADDRESS,
  createSunsetGoogleEndpointPrepare,
} = mod;
const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACTOR = 'abcdef01-2345-4678-89ab-cdef01234567';
const ENDPOINT = '11111111-2222-4333-8444-555555555555';
const input = (patch = {}) => Object.freeze({
  clientId: CLIENT, locationId: 'sunset-somo', publicAddress: 'Desk@Sunset.Example',
  actorStaffUserId: ACTOR, ...patch,
});
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const fails = (error) => error && error.code === ERROR_CODE;

function fake(options = {}) {
  const calls = [];
  let commitAttempted = false;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params, receiver: this });
      if (sql === 'COMMIT') { commitAttempted = true; if (options.commitFail) throw Error('ambiguous'); }
      if (options.failAt && calls.length === options.failAt) throw Error('db detail');
      if (/FROM clients/.test(sql)) return { command: 'SELECT', rowCount: 1, rows: options.noClient ? [] : [{ client_id: CLIENT }] };
      if (/FROM tenant_locations/.test(sql)) return { rowCount: 1, rows: options.noLocation ? [] : [{ location_id: 'sunset-somo' }] };
      if (sql === SQL_EXISTING_BY_LOCATION) return { rows: options.sameLocation ? [{ id: ENDPOINT }] : [] };
      if (sql === SQL_EXISTING_BY_ADDRESS) return { rows: options.sameAddress ? [{ id: ENDPOINT }] : [] };
      if (/INSERT INTO/.test(sql)) return { command: 'INSERT', rowCount: 1, rows: [{ id: ENDPOINT }] };
      return { command: sql, rows: [] };
    },
  };
  return { client, calls, commitAttempted: () => commitAttempted };
}

test('happy path is exact, disabled Gmail delegated, and native Result compatible', async () => {
  const f = fake();
  const ack = await createSunsetGoogleEndpointPrepare(Object.freeze({ client: f.client }))
    .prepareDisabledDelegatedEndpoint(input());
  assert.deepEqual(ack, { endpointId: ENDPOINT });
  assert.equal(Object.isFrozen(ack), true);
  assert.deepEqual(f.calls.map((c) => c.sql === SQL_INSERT_ENDPOINT ? 'INSERT' : c.sql.split(' ')[0]),
    ['BEGIN', 'SELECT', 'SELECT', 'SELECT', 'SELECT', 'SELECT', 'SELECT', 'INSERT', 'COMMIT']);
  assert.ok(f.calls.every((c) => c.receiver === f.client));
  const insert = f.calls[7];
  assert.deepEqual(insert.params, [CLIENT, 'sunset-somo', 'desk@sunset.example', JSON.stringify(FORCED_CAPABILITIES), ACTOR]);
  assert.match(SQL_INSERT_ENDPOINT, /'gmail_api'.*false, false, 'off', false.*'delegated_authorization_code'.*'google_delegated_oauth'.*'unverified_offline'/);
  assert.match(SQL_INSERT_ENDPOINT, /secret-ref:email\/google\/sunset-staging-oauth-client/);
  assert.match(SQL_EXISTING_BY_LOCATION, /provider = 'gmail_api'/);
  assert.match(SQL_EXISTING_BY_ADDRESS, /provider = 'gmail_api'/);
});

test('query own data function is selected and receiver-bound once', async () => {
  let selected = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'query', { get() { selected += 1; return async () => ({ rows: [] }); } });
  assert.throws(() => createSunsetGoogleEndpointPrepare(Object.freeze({ client: accessor })), fails);
  assert.equal(selected, 0);
  const f = fake();
  const original = f.client.query;
  const owner = createSunsetGoogleEndpointPrepare(Object.freeze({ client: f.client }));
  f.client.query = async () => { throw Error('switched'); };
  await owner.prepareDisabledDelegatedEndpoint(input());
  assert.equal(f.calls.length, 9);
  assert.ok(f.calls.every((c) => c.receiver === f.client));
  assert.notEqual(f.client.query, original);
});

test('rejects pool shapes, inherited query, and malformed exact frozen input', async () => {
  assert.throws(() => createSunsetGoogleEndpointPrepare(Object.freeze({ client: { query() {}, connect() {} } })), fails);
  assert.throws(() => createSunsetGoogleEndpointPrepare(Object.freeze({ client: Object.create({ query() {} }) })), fails);
  for (const bad of [null, { ...input() }, Object.freeze({ ...input(), extra: true }), input({ clientId: 'bad' }), input({ locationId: 'Bad' })]) {
    const f = fake();
    const owner = createSunsetGoogleEndpointPrepare(Object.freeze({ client: f.client }));
    await assert.rejects(() => owner.prepareDisabledDelegatedEndpoint(bad), fails);
    assert.equal(f.calls.length, 0);
  }
});

test('rejects transparent and trapping Proxy outer dependencies before reflection with zero SQL', async () => {
  for (const handler of [{}, (() => {
    let traps = 0;
    return {
      handler: {
        getPrototypeOf() { traps += 1; throw Error('dependency trap'); },
        ownKeys() { traps += 1; throw Error('dependency trap'); },
        getOwnPropertyDescriptor() { traps += 1; throw Error('dependency trap'); },
        get() { traps += 1; throw Error('dependency trap'); },
      },
      traps: () => traps,
    };
  })()]) {
    const f = fake();
    const trapCount = handler.traps || (() => 0);
    const proxyHandler = handler.handler || handler;
    const dependencies = new Proxy(Object.freeze({ client: f.client }), proxyHandler);
    assert.throws(() => createSunsetGoogleEndpointPrepare(dependencies), fails);
    assert.equal(trapCount(), 0);
    assert.equal(f.calls.length, 0);
  }
});

test('rejects transparent Proxy clients at the factory with zero SQL', async () => {
  const f = fake();
  const client = new Proxy(f.client, {});
  assert.throws(
    () => createSunsetGoogleEndpointPrepare(Object.freeze({ client })),
    fails,
  );
  assert.equal(f.calls.length, 0);
});

test('rejects transparent Proxy frozen exact inputs with zero SQL', async () => {
  const f = fake();
  const owner = createSunsetGoogleEndpointPrepare(Object.freeze({ client: f.client }));
  const proxiedInput = new Proxy(input(), {});
  await assert.rejects(() => owner.prepareDisabledDelegatedEndpoint(proxiedInput), fails);
  assert.equal(f.calls.length, 0);
});

test('Proxy rejection executes no client or input traps', async () => {
  const f = fake();
  let clientTraps = 0;
  const trappingClient = new Proxy(f.client, {
    getPrototypeOf() { clientTraps += 1; throw Error('client trap'); },
    getOwnPropertyDescriptor() { clientTraps += 1; throw Error('client trap'); },
    get() { clientTraps += 1; throw Error('client trap'); },
    has() { clientTraps += 1; throw Error('client trap'); },
  });
  assert.throws(
    () => createSunsetGoogleEndpointPrepare(Object.freeze({ client: trappingClient })),
    fails,
  );
  assert.equal(clientTraps, 0);
  assert.equal(f.calls.length, 0);

  const owner = createSunsetGoogleEndpointPrepare(Object.freeze({ client: f.client }));
  let inputTraps = 0;
  const trappingInput = new Proxy(input(), {
    getPrototypeOf() { inputTraps += 1; throw Error('input trap'); },
    ownKeys() { inputTraps += 1; throw Error('input trap'); },
    getOwnPropertyDescriptor() { inputTraps += 1; throw Error('input trap'); },
    get() { inputTraps += 1; throw Error('input trap'); },
  });
  await assert.rejects(() => owner.prepareDisabledDelegatedEndpoint(trappingInput), fails);
  assert.equal(inputTraps, 0);
  assert.equal(f.calls.length, 0);
});

test('Sunset proof, active location, and Gmail duplicates fail with rollback', async () => {
  for (const option of ['noClient', 'noLocation', 'sameLocation', 'sameAddress']) {
    const f = fake({ [option]: true });
    await assert.rejects(() => createSunsetGoogleEndpointPrepare(Object.freeze({ client: f.client }))
      .prepareDisabledDelegatedEndpoint(input()), fails);
    assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(f.calls.some((c) => /INSERT INTO/.test(c.sql)), false);
  }
});

test('rollback precedes commit ambiguity and never follows commit attempt', async () => {
  const before = fake({ failAt: 3 });
  await assert.rejects(() => createSunsetGoogleEndpointPrepare(Object.freeze({ client: before.client }))
    .prepareDisabledDelegatedEndpoint(input()), fails);
  assert.equal(before.calls.at(-1).sql, 'ROLLBACK');
  const after = fake({ commitFail: true });
  await assert.rejects(() => createSunsetGoogleEndpointPrepare(Object.freeze({ client: after.client }))
    .prepareDisabledDelegatedEndpoint(input()), fails);
  assert.equal(after.commitAttempted(), true);
  assert.equal(after.calls.at(-1).sql, 'COMMIT');
});

test('single use and sanitized errors', async () => {
  const f = fake();
  const owner = createSunsetGoogleEndpointPrepare(Object.freeze({ client: f.client }));
  await owner.prepareDisabledDelegatedEndpoint(input());
  await assert.rejects(() => owner.prepareDisabledDelegatedEndpoint(input()), fails);
  assert.equal(f.calls.length, 9);
});

(async () => {
  for (const [name, fn] of tests) { await fn(); console.log(`ok - ${name}`); }
  console.log(`PASS ${tests.length} tests`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
