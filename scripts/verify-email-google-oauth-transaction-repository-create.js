'use strict';

/**
 * RED-only offline contract for the typed Google OAuth transaction repository create seam.
 * The production module is intentionally absent. No environment, route, network, SDK,
 * deployment, live database, credential, token, authorization code, or send capability exists here.
 */
const assert = require('node:assert/strict');
const vm = require('node:vm');

// Authentic RED: GREEN must provide this sole typed repository owner.
const owner = require('./lib/email-google-oauth-transaction-repository');
const { createGoogleOAuthTransactionRepository } = owner;

const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const LOCATION = '11111111-2222-4333-8444-555555555555';
const ENDPOINT = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const STAFF = 'abcdef01-2345-4678-89ab-cdef01234567';
const SESSION = '12345678-90ab-4cde-8fab-1234567890ab';
const OPERATION = '99999999-8888-4777-8666-555555555555';
const STATE = '0123456789abcdef'.repeat(4);
const VERIFIER = `${'V'.repeat(41)}-._~`;
const NONCE = `${'N'.repeat(42)}_`;
const ISSUED = '2026-08-11T12:00:00.000Z';
const EXPIRES = '2026-08-11T12:10:00.000Z';
const LEAK = 'HOSTILE_GOOGLE_TRANSACTION_VALUE_NEVER_LOG';
const freeze = Object.freeze;
const SQL = `INSERT INTO tenant_email_google_oauth_transactions (
  client_id, location_id, endpoint_id, staff_user_id, auth_session_id,
  operation_id, state_hash, code_verifier, nonce, authorization_intent,
  scope_version, issued_at, expires_at
) VALUES (
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
  $6::uuid, $7::bytea, $8::text, $9::text, 'initial_connect',
  'phase_a_v2', $10::timestamptz, $11::timestamptz
)
RETURNING operation_id, expires_at`;

function input(patch = {}) {
  return freeze({ clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT,
    staffUserId: STAFF, authSessionId: SESSION, operationId: OPERATION,
    stateHash: STATE, codeVerifier: VERIFIER, nonce: NONCE,
    issuedAt: ISSUED, expiresAt: EXPIRES, ...patch });
}
function row(patch = {}) { return freeze({ operation_id: OPERATION, expires_at: EXPIRES, ...patch }); }
function result(value = row()) { return freeze({ rows: freeze([value]) }); }
function queryOwner(fn = function query() { return result(); }) { return freeze({ query: fn }); }
function create(query = queryOwner()) {
  return createGoogleOAuthTransactionRepository(freeze({ queryOwner: query }));
}
function assertClean(error) {
  assert.equal(error.name, 'GoogleOAuthTransactionRepositoryError');
  assert.equal(error.code, 'GOOGLE_OAUTH_TRANSACTION_REPOSITORY_FAILED');
  assert.equal(error.message, 'GOOGLE_OAUTH_TRANSACTION_REPOSITORY_FAILED');
  assert.equal(Object.isFrozen(error), true);
  assert.deepEqual(Object.keys(error), ['code']);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  const rendered = `${error}\n${error.stack || ''}\n${JSON.stringify(error)}`;
  for (const value of [STATE, VERIFIER, NONCE, LEAK]) assert.equal(rendered.includes(value), false);
  return true;
}
async function rejects(action) { await assert.rejects(Promise.resolve().then(action), assertClean); }
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('exports only the frozen factory and constructs exact frozen reusable create surface without effects', async () => {
  let calls = 0; const repository = create(queryOwner(() => { calls += 1; return result(); }));
  assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(Reflect.ownKeys(owner), ['createGoogleOAuthTransactionRepository']);
  assert.equal(Object.isFrozen(repository), true);
  assert.deepEqual(Reflect.ownKeys(repository), ['create']);
  await Promise.resolve(); assert.equal(calls, 0);
});

test('executes one fixed Google INSERT with explicit authority columns, constants, casts, and exact params', async () => {
  const calls = []; const q = queryOwner(function query(text, params) { calls.push({ text, params, receiver: this }); return result(); });
  const ack = await create(q).create(input());
  assert.equal(calls.length, 1); assert.strictEqual(calls[0].receiver, q); assert.equal(calls[0].text, SQL);
  assert.deepEqual(calls[0].params.slice(0, 6), [CLIENT, LOCATION, ENDPOINT, STAFF, SESSION, OPERATION]);
  assert.ok(Buffer.isBuffer(calls[0].params[6])); assert.equal(calls[0].params[6].toString('hex'), STATE);
  assert.deepEqual(calls[0].params.slice(7), [VERIFIER, NONCE, ISSUED, EXPIRES]);
  assert.deepEqual(ack, { operationId: OPERATION, expiresAt: EXPIRES }); assert.equal(Object.isFrozen(ack), true);
  assert.deepEqual(Reflect.ownKeys(ack), ['operationId', 'expiresAt']);
  for (const key of ['stateHash', 'codeVerifier', 'nonce']) assert.equal(key in ack, false);
});

test('SQL is insert-only, Google-specific, and delegates endpoint eligibility to migration trigger', async () => {
  let text; await create(queryOwner(sql => { text = sql; return result(); })).create(input());
  assert.match(text, /^INSERT INTO tenant_email_google_oauth_transactions/);
  assert.equal(/\bSELECT\b/i.test(text), false); assert.equal(/microsoft/i.test(text), false);
  assert.equal(/authorization_code|client_secret|token/i.test(text), false);
  assert.match(text, /'initial_connect'/); assert.match(text, /'phase_a_v2'/);
  assert.match(text, /RETURNING operation_id, expires_at$/);
});

test('accepts direct or genuine same-realm native Promise query results', async () => {
  assert.deepEqual(await create().create(input()), { operationId: OPERATION, expiresAt: EXPIRES });
  assert.deepEqual(await create(queryOwner(() => ({ rows: [{ operation_id: OPERATION, expires_at: EXPIRES }] }))).create(input()),
    { operationId: OPERATION, expiresAt: EXPIRES });
  assert.deepEqual(await create(queryOwner(() => Promise.resolve(result()))).create(input()), { operationId: OPERATION, expiresAt: EXPIRES });
});

test('requires exact frozen ordered queryOwner configuration and exact nested query owner', async () => {
  const q = queryOwner(); const good = freeze({ queryOwner: q });
  const bad = [undefined, null, {}, { ...good }, freeze({ ...good, extra: true }),
    freeze({ queryOwner: q, [Symbol('x')]: true }), freeze(Object.assign(Object.create(null), good)),
    freeze({ queryOwner: freeze({ query() {}, extra: true }) }), freeze({ queryOwner: { query() {} } }),
    new Proxy(good, { ownKeys() { throw new Error(LEAK); } })];
  const accessor = {}; Object.defineProperty(accessor, 'queryOwner', { enumerable: true, get() { throw new Error(LEAK); } }); freeze(accessor); bad.push(accessor);
  for (const value of bad) assert.throws(() => createGoogleOAuthTransactionRepository(value), assertClean);
});

test('pins query function and receiver and defeats method mutation and function-owned call/apply', async () => {
  let calls = 0; let traps = 0; let receiver;
  function query() { calls += 1; receiver = this; return result(); }
  Object.defineProperties(query, { call: { value() { traps += 1; } }, apply: { value() { traps += 1; } } });
  const q = queryOwner(query); const repository = create(q);
  assert.throws(() => { q.query = () => result(); }, TypeError);
  await repository.create(input()); assert.equal(calls, 1); assert.equal(traps, 0); assert.strictEqual(receiver, q);
});

test('requires exact frozen ordered data-only create input and burns no query on invalid input', async () => {
  const good = input(); const bad = [undefined, null, {}, { ...good }, freeze({ ...good, extra: true }),
    freeze({ locationId: LOCATION, clientId: CLIENT, endpointId: ENDPOINT, staffUserId: STAFF, authSessionId: SESSION,
      operationId: OPERATION, stateHash: STATE, codeVerifier: VERIFIER, nonce: NONCE, issuedAt: ISSUED, expiresAt: EXPIRES }),
    freeze(Object.assign(Object.create(null), good)), freeze({ ...good, [Symbol('x')]: true }),
    new Proxy(good, { getPrototypeOf() { throw new Error(LEAK); } })];
  const accessor = { ...good }; Object.defineProperty(accessor, 'clientId', { enumerable: true, get() { throw new Error(LEAK); } }); freeze(accessor); bad.push(accessor);
  for (const value of bad) { let calls = 0; await rejects(() => create(queryOwner(() => { calls += 1; return result(); })).create(value)); assert.equal(calls, 0); }
});

test('validates canonical UUID, digest, verifier, nonce, and immutable canonical timestamps before query', async () => {
  const patches = [
    { clientId: CLIENT.toUpperCase() }, { locationId: 'not-a-uuid' }, { endpointId: '11111111-2222-3333-8444-555555555555' },
    { stateHash: STATE.toUpperCase() }, { stateHash: 'a'.repeat(63) },
    { codeVerifier: 'A'.repeat(42) }, { codeVerifier: 'A'.repeat(129) }, { codeVerifier: `${'A'.repeat(42)}+` },
    { nonce: 'A'.repeat(42) }, { nonce: 'A'.repeat(129) }, { nonce: `${'A'.repeat(42)}~` },
    { issuedAt: '2026-08-11T12:00:00Z' }, { expiresAt: ISSUED }, { expiresAt: '2026-08-11T12:10:00.001Z' },
    { issuedAt: new String(ISSUED) }, { expiresAt: new String(EXPIRES) },
  ];
  for (const patch of patches) { let calls = 0; await rejects(() => create(queryOwner(() => { calls += 1; return result(); })).create(input(patch))); assert.equal(calls, 0); }
  await create().create(input({ codeVerifier: 'A'.repeat(43), nonce: 'A'.repeat(43), expiresAt: '2026-08-11T12:00:00.001Z' }));
  await create().create(input({ codeVerifier: `${'A'.repeat(124)}-._~`, nonce: `${'A'.repeat(127)}_` }));
});

test('rejects custom, proxy, spoofed, subclass, and cross-realm promises without invoking then', async () => {
  let invoked = 0;
  const specimens = [freeze({ then() { invoked += 1; } }),
    new Proxy({ then() { invoked += 1; } }, { getPrototypeOf() { return Promise.prototype; } }),
    Object.setPrototypeOf({ then() { invoked += 1; } }, Promise.prototype),
    new (class ChildPromise extends Promise {})(resolve => resolve(result())),
    vm.runInNewContext('Promise.resolve(Object.freeze({rows:Object.freeze([])}))')];
  for (const value of specimens) await rejects(() => create(queryOwner(() => value)).create(input()));
  assert.equal(invoked, 0);
});

test('safely snapshots exact one-row driver output and requires exact unchanged operation and expiry', async () => {
  const accessorRow = { operation_id: OPERATION }; Object.defineProperty(accessorRow, 'expires_at', { enumerable: true, get() { throw new Error(LEAK); } }); freeze(accessorRow);
  const malformed = [undefined, null, {}, { rows: [] }, freeze({ rows: freeze([]) }),
    freeze({ rows: freeze([row(), row()]) }), freeze({ rows: freeze([{ ...row() }]) }),
    freeze({ rows: freeze([freeze({ expires_at: EXPIRES, operation_id: OPERATION })]) }),
    result(row({ operation_id: CLIENT })),
    result(row({ operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })),
    result(row({ expires_at: '2026-08-11T12:09:59.999Z' })),
    result(row({ expires_at: '2026-08-11 12:10:00+00' })), result(accessorRow),
    new Proxy(result(), { ownKeys() { throw new Error(LEAK); } })];
  for (const value of malformed) await rejects(() => create(queryOwner(() => value)).create(input()));
});

test('returns a new minimized frozen acknowledgement rather than exposing row identity', async () => {
  const databaseRow = row(); const ack = await create(queryOwner(() => result(databaseRow))).create(input());
  assert.notStrictEqual(ack, databaseRow); assert.deepEqual(ack, { operationId: OPERATION, expiresAt: EXPIRES });
});

test('sanitizes sync and async query failures, emits no logs, and never retries', async () => {
  const originals = [console.log, console.info, console.warn, console.error]; const logs = [];
  [console.log, console.info, console.warn, console.error] = originals.map(() => (...args) => logs.push(args));
  try {
    for (const fn of [() => { throw new Error(`${LEAK}:${VERIFIER}`); }, () => Promise.reject(new Error(`${LEAK}:${NONCE}`))]) {
      let calls = 0; await rejects(() => create(queryOwner(() => { calls += 1; return fn(); })).create(input())); assert.equal(calls, 1);
    }
    assert.deepEqual(logs, []);
  } finally { [console.log, console.info, console.warn, console.error] = originals; }
});

test('pins intrinsics so hostile query poisoning cannot defeat post-query validation or DTO freezing', async () => {
  const saved = { freeze: Object.freeze, isFrozen: Object.isFrozen, getPrototypeOf: Object.getPrototypeOf,
    getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor, hasOwn: Object.hasOwn, create: Object.create,
    ownKeys: Reflect.ownKeys, apply: Reflect.apply, regexTest: RegExp.prototype.test,
    promise: global.Promise, arrayIsArray: Array.isArray };
  let ack;
  try {
    const output = result(); const q = queryOwner(() => {
      Object.freeze = value => value; Object.isFrozen = () => false; Object.getPrototypeOf = () => { throw new Error(LEAK); };
      Object.getOwnPropertyDescriptor = () => { throw new Error(LEAK); }; Object.hasOwn = () => false;
      Object.create = () => { throw new Error(LEAK); }; Reflect.ownKeys = () => { throw new Error(LEAK); };
      Reflect.apply = () => { throw new Error(LEAK); }; RegExp.prototype.test = () => { throw new Error(LEAK); };
      Array.isArray = () => false; global.Promise = function PoisonPromise() { throw new Error(LEAK); }; return output;
    });
    ack = await create(q).create(input());
  } finally { Object.freeze = saved.freeze; Object.isFrozen = saved.isFrozen; Object.getPrototypeOf = saved.getPrototypeOf;
    Object.getOwnPropertyDescriptor = saved.getOwnPropertyDescriptor; Object.hasOwn = saved.hasOwn; Object.create = saved.create;
    Reflect.ownKeys = saved.ownKeys; Reflect.apply = saved.apply; RegExp.prototype.test = saved.regexTest;
    Array.isArray = saved.arrayIsArray; global.Promise = saved.promise; }
  assert.equal(saved.isFrozen(ack), true); assert.deepEqual(saved.ownKeys(ack), ['operationId', 'expiresAt']);
});

test('is reusable and concurrent with exactly one query and isolated digest buffer per create', async () => {
  const buffers = []; let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  const repository = create(queryOwner((text, params) => { calls += 1; buffers.push(params[6]); return gate.then(() => result()); }));
  const first = repository.create(input()); const second = repository.create(input({ operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
  release(); await Promise.all([first, second]); assert.equal(calls, 2); assert.notStrictEqual(buffers[0], buffers[1]);
  buffers[0][0] = 255; assert.equal(buffers[1].toString('hex'), STATE);
  await repository.create(input()); assert.equal(calls, 3);
});

(async () => {
  for (const { name, run } of tests) { await run(); process.stdout.write(`ok - ${name}\n`); }
  assert.equal(tests.length, 14);
  process.stdout.write('PASS verify:email-google-oauth-transaction-repository-create (14 named offline tests)\n');
})().catch(error => { process.stderr.write(`${error && error.stack ? error.stack : error}\n`); process.exitCode = 1; });
