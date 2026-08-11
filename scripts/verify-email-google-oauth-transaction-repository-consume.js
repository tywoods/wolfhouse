'use strict';

/** RED-only offline contract for atomic Google OAuth transaction consume. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, 'lib', 'email-google-oauth-transaction-repository.js');
const owner = require(MODULE_PATH);
const { createGoogleOAuthTransactionRepository } = owner;
const freeze = Object.freeze;
const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION = '12345678-90ab-4cde-8fab-1234567890ab';
const OPERATION = '99999999-8888-4777-8666-555555555555';
const LOCATION = '11111111-2222-4333-8444-555555555555';
const ENDPOINT = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const STAFF = 'abcdef01-2345-4678-89ab-cdef01234567';
const STATE = '0123456789abcdef'.repeat(4);
const VERIFIER = `${'V'.repeat(41)}-._~`;
const NONCE = `${'N'.repeat(42)}_`;
const CONSUMED = '2026-08-11T12:05:00.000Z';
const LEAK = 'HOSTILE_GOOGLE_CONSUME_VALUE_NEVER_LOG';
const SQL = "UPDATE tenant_email_google_oauth_transactions SET consumed_at=$4::timestamptz WHERE state_hash=$1::bytea AND client_id=$2::uuid AND auth_session_id=$3::uuid AND consumed_at IS NULL AND expires_at>$4::timestamptz AND authorization_intent='initial_connect' AND scope_version='phase_a_v2' RETURNING operation_id, location_id, endpoint_id, staff_user_id, code_verifier, nonce";

function input(patch = {}) { return freeze({ stateHash: STATE, clientId: CLIENT, authSessionId: SESSION, consumedAt: CONSUMED, ...patch }); }
function row(patch = {}, frozen = true) {
  const value = { operation_id: OPERATION, location_id: LOCATION, endpoint_id: ENDPOINT,
    staff_user_id: STAFF, code_verifier: VERIFIER, nonce: NONCE, ...patch };
  return frozen ? freeze(value) : value;
}
function result(rows = [row()], frozen = true) {
  const list = frozen ? freeze(rows) : rows;
  const value = { rows: list };
  return frozen ? freeze(value) : value;
}
function queryOwner(fn = function query() { return result(); }) { return freeze({ query: fn }); }
function repository(query = queryOwner()) { return createGoogleOAuthTransactionRepository(freeze({ queryOwner: query })); }
function expected() { return { operationId: OPERATION, locationId: LOCATION, endpointId: ENDPOINT,
  staffUserId: STAFF, codeVerifier: VERIFIER, nonce: NONCE }; }
function assertClean(error) {
  assert.equal(error.name, 'GoogleOAuthTransactionRepositoryError');
  assert.equal(error.code, 'GOOGLE_OAUTH_TRANSACTION_REPOSITORY_FAILED');
  assert.equal(error.message, 'GOOGLE_OAUTH_TRANSACTION_REPOSITORY_FAILED');
  assert.equal(Object.isFrozen(error), true);
  assert.deepEqual(Object.keys(error), ['code']);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  const rendered = `${error}\n${error.stack || ''}\n${JSON.stringify(error)}`;
  for (const secret of [STATE, VERIFIER, NONCE, LEAK]) assert.equal(rendered.includes(secret), false);
  return true;
}
async function rejects(action) { await assert.rejects(Promise.resolve().then(action), assertClean); }
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('keeps the sole frozen owner export and exposes exact frozen ordered create/consume repository surface', async () => {
  let calls = 0; const value = repository(queryOwner(() => { calls += 1; return result(); }));
  assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(Reflect.ownKeys(owner), ['createGoogleOAuthTransactionRepository']);
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(Reflect.ownKeys(value), ['create', 'consume']);
  await Promise.resolve(); assert.equal(calls, 0);
});

test('executes exactly one atomic fixed Google UPDATE with exact params and fresh digest buffer', async () => {
  const calls = []; const q = queryOwner(function query(text, params) { calls.push({ text, params, receiver: this }); return result(); });
  const repo = repository(q); const first = await repo.consume(input()); const second = await repo.consume(input());
  assert.equal(calls.length, 2); assert.strictEqual(calls[0].receiver, q); assert.equal(calls[0].text, SQL);
  assert.equal(calls[1].text, SQL); assert.deepEqual(calls[0].params.slice(1), [CLIENT, SESSION, CONSUMED]);
  assert.ok(Buffer.isBuffer(calls[0].params[0])); assert.equal(calls[0].params[0].toString('hex'), STATE);
  assert.notStrictEqual(calls[0].params[0], calls[1].params[0]);
  assert.deepEqual(first, expected()); assert.deepEqual(second, expected());
});

test('SQL is structurally one atomic update with no preselect, Microsoft table, or prior generation', async () => {
  let text; await repository(queryOwner(sql => { text = sql; return result([]); })).consume(input());
  assert.equal(text, SQL); assert.match(text, /^UPDATE tenant_email_google_oauth_transactions SET consumed_at=\$4::timestamptz WHERE /);
  assert.equal(/\bSELECT\b/i.test(text), false); assert.equal(/tenant_email_oauth_transactions|microsoft/i.test(text), false);
  assert.equal(/prior_generation/i.test(text), false);
  for (const fragment of ['state_hash=$1::bytea', 'client_id=$2::uuid', 'auth_session_id=$3::uuid',
    'consumed_at IS NULL', 'expires_at>$4::timestamptz', "authorization_intent='initial_connect'", "scope_version='phase_a_v2'",
    'RETURNING operation_id, location_id, endpoint_id, staff_user_id, code_verifier, nonce']) assert.ok(text.includes(fragment));
});

test('accepts direct and genuine native Promise zero/one outputs; zero rows is an ordinary null miss', async () => {
  for (const frozen of [false, true]) {
    assert.equal(await repository(queryOwner(() => result([], frozen))).consume(input()), null);
    assert.deepEqual(await repository(queryOwner(() => Promise.resolve(result([], frozen)))).consume(input()), null);
    assert.deepEqual(await repository(queryOwner(() => result([row({}, frozen)], frozen))).consume(input()), expected());
    assert.deepEqual(await repository(queryOwner(() => Promise.resolve(result([row({}, frozen)], frozen)))).consume(input()), expected());
  }
});

test('requires exact frozen ordered data-only consume input and burns no query when invalid', async () => {
  const good = input(); const bad = [undefined, null, {}, { ...good }, freeze({ ...good, extra: true }),
    freeze({ clientId: CLIENT, stateHash: STATE, authSessionId: SESSION, consumedAt: CONSUMED }),
    freeze(Object.assign(Object.create(null), good)), freeze({ ...good, [Symbol('x')]: true }),
    new Proxy(good, { ownKeys() { throw new Error(LEAK); } })];
  const accessor = { ...good }; Object.defineProperty(accessor, 'stateHash', { enumerable: true, get() { throw new Error(LEAK); } }); freeze(accessor); bad.push(accessor);
  for (const value of bad) { let calls = 0; await rejects(() => repository(queryOwner(() => { calls += 1; return result(); })).consume(value)); assert.equal(calls, 0); }
});

test('validates lowercase digest, canonical UUIDv4 owners, and canonical millisecond UTC consumedAt before query', async () => {
  const patches = [{ stateHash: STATE.toUpperCase() }, { stateHash: 'a'.repeat(63) }, { stateHash: new String(STATE) },
    { clientId: CLIENT.toUpperCase() }, { clientId: 'aaaaaaaa-bbbb-3ccc-8ddd-eeeeeeeeeeee' },
    { authSessionId: SESSION.toUpperCase() }, { authSessionId: 'not-a-uuid' },
    { consumedAt: '2026-08-11T12:05:00Z' }, { consumedAt: '2026-08-11 12:05:00.000+00' },
    { consumedAt: 'not-a-date' }, { consumedAt: '2026-02-30T12:00:00.000Z' },
    { consumedAt: '2026-13-01T12:00:00.000Z' }, { consumedAt: '2026-02-29T12:00:00.000Z' },
    { consumedAt: new String(CONSUMED) }];
  for (const patch of patches) { let calls = 0; await rejects(() => repository(queryOwner(() => { calls += 1; return result(); })).consume(input(patch))); assert.equal(calls, 0); }
  assert.equal(await repository(queryOwner(() => result([]))).consume(
    input({ consumedAt: '2028-02-29T12:00:00.000Z' }),
  ), null);
});

test('pins inherited factory receiver/query method and defeats later mutation and function call/apply substitution', async () => {
  let calls = 0; let traps = 0; let receiver;
  function query() { calls += 1; receiver = this; return result([]); }
  Object.defineProperties(query, { call: { value() { traps += 1; } }, apply: { value() { traps += 1; } } });
  const q = queryOwner(query); const consume = repository(q).consume;
  assert.throws(() => { q.query = () => result(); }, TypeError);
  assert.equal(await consume(input()), null); assert.equal(calls, 1); assert.equal(traps, 0); assert.strictEqual(receiver, q);
});

test('rejects hostile, spoofed, subclass, and cross-realm promises without assimilating then', async () => {
  let invoked = 0; const specimens = [freeze({ then() { invoked += 1; } }),
    Object.setPrototypeOf({ then() { invoked += 1; } }, Promise.prototype),
    new Proxy({ then() { invoked += 1; } }, { getPrototypeOf() { return Promise.prototype; } }),
    new (class ChildPromise extends Promise {})(resolve => resolve(result([]))),
    vm.runInNewContext('Promise.resolve(Object.freeze({rows:Object.freeze([])}))')];
  for (const value of specimens) await rejects(() => repository(queryOwner(() => value)).consume(input()));
  assert.equal(invoked, 0);
});

test('accepts exact consistent mutable/frozen rows and returns a new exact frozen minimized DTO', async () => {
  for (const frozen of [false, true]) {
    const databaseRow = row({}, frozen); const dto = await repository(queryOwner(() => result([databaseRow], frozen))).consume(input());
    assert.notStrictEqual(dto, databaseRow); assert.deepEqual(dto, expected()); assert.equal(Object.isFrozen(dto), true);
    assert.deepEqual(Reflect.ownKeys(dto), ['operationId', 'locationId', 'endpointId', 'staffUserId', 'codeVerifier', 'nonce']);
    for (const key of ['stateHash', 'clientId', 'authSessionId', 'consumedAt']) assert.equal(key in dto, false);
  }
});

test('validates returned shape and grammar without binding returned IDs to consume owner IDs', async () => {
  const dto = await repository(queryOwner(() => result([row({ operation_id: CLIENT, location_id: SESSION,
    endpoint_id: OPERATION, staff_user_id: LOCATION })]))).consume(input());
  assert.deepEqual(dto, { operationId: CLIENT, locationId: SESSION, endpointId: OPERATION,
    staffUserId: LOCATION, codeVerifier: VERIFIER, nonce: NONCE });
});

test('rejects multiple, malformed, mixed-freeze, accessor, proxy, and noncanonical returned values with sanitized error', async () => {
  const accessor = { ...row({}, false) }; Object.defineProperty(accessor, 'nonce', { enumerable: true, get() { throw new Error(LEAK); } }); freeze(accessor);
  const malformed = [undefined, null, {}, freeze({ rows: [] }), result([row(), row()]),
    result([{ ...row() }]), result([row({}, false)]), result([row()], false),
    result([freeze({ location_id: LOCATION, operation_id: OPERATION, endpoint_id: ENDPOINT, staff_user_id: STAFF, code_verifier: VERIFIER, nonce: NONCE })]),
    result([row({ operation_id: 'not-a-uuid' })]), result([row({ location_id: ENDPOINT.toUpperCase() })]),
    result([row({ code_verifier: 'A'.repeat(42) })]), result([row({ nonce: `${'A'.repeat(42)}.` })]), result([accessor]),
    new Proxy(result(), { ownKeys() { throw new Error(LEAK); } })];
  for (const value of malformed) await rejects(() => repository(queryOwner(() => value)).consume(input()));
});

test('sanitizes synchronous/Promise query failures, logs nothing, and never retries', async () => {
  const originals = [console.log, console.info, console.warn, console.error]; const logs = [];
  [console.log, console.info, console.warn, console.error] = originals.map(() => (...args) => logs.push(args));
  try {
    for (const failure of [() => { throw new Error(`${LEAK}:${VERIFIER}`); }, () => Promise.reject(new Error(`${LEAK}:${NONCE}`))]) {
      let calls = 0; await rejects(() => repository(queryOwner(() => { calls += 1; return failure(); })).consume(input())); assert.equal(calls, 1);
    }
    assert.deepEqual(logs, []);
  } finally { [console.log, console.info, console.warn, console.error] = originals; }
});

test('pins intrinsics before child query poisoning for zero, one, malformed handling and DTO freezing', async () => {
  const saved = { freeze: Object.freeze, isFrozen: Object.isFrozen, getPrototypeOf: Object.getPrototypeOf,
    getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor, hasOwn: Object.hasOwn, create: Object.create,
    ownKeys: Reflect.ownKeys, apply: Reflect.apply, regexTest: RegExp.prototype.test,
    promise: global.Promise, arrayIsArray: Array.isArray };
  async function poisoned(output, rejectExpected) {
    let answer; let caught;
    try {
      answer = await repository(queryOwner(() => {
        Object.freeze = value => value; Object.isFrozen = () => false; Object.getPrototypeOf = () => { throw new Error(LEAK); };
        Object.getOwnPropertyDescriptor = () => { throw new Error(LEAK); }; Object.hasOwn = () => false; Object.create = () => { throw new Error(LEAK); };
        Reflect.ownKeys = () => { throw new Error(LEAK); }; Reflect.apply = () => { throw new Error(LEAK); }; RegExp.prototype.test = () => false;
        Array.isArray = () => false; global.Promise = function PoisonPromise() { throw new Error(LEAK); }; return output;
      })).consume(input());
    } catch (error) { caught = error; }
    finally { Object.freeze = saved.freeze; Object.isFrozen = saved.isFrozen; Object.getPrototypeOf = saved.getPrototypeOf;
      Object.getOwnPropertyDescriptor = saved.getOwnPropertyDescriptor; Object.hasOwn = saved.hasOwn; Object.create = saved.create;
      Reflect.ownKeys = saved.ownKeys; Reflect.apply = saved.apply; RegExp.prototype.test = saved.regexTest;
      Array.isArray = saved.arrayIsArray; global.Promise = saved.promise; }
    if (rejectExpected) { assert.ok(caught, 'malformed poisoned output rejected'); assertClean(caught); }
    else if (caught) throw caught;
    return answer;
  }
  assert.equal(await poisoned(result([]), false), null);
  const dto = await poisoned(result(), false); assert.equal(saved.isFrozen(dto), true); assert.deepEqual(dto, expected());
  await poisoned(result([row({ nonce: 'bad' })]), true);
});

test('is reusable and concurrent with one query per consume and isolated digest buffers', async () => {
  const buffers = []; let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  const repo = repository(queryOwner((text, params) => { calls += 1; buffers.push(params[0]); return gate.then(() => result([])); }));
  const first = repo.consume(input()); const second = repo.consume(input()); release();
  assert.deepEqual(await Promise.all([first, second]), [null, null]); assert.equal(calls, 2); assert.notStrictEqual(buffers[0], buffers[1]);
  buffers[0][0] = 255; assert.equal(buffers[1].toString('hex'), STATE); await repo.consume(input()); assert.equal(calls, 3);
});

test('repository source has no ambient environment, logging, network, or provider SDK authority', () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  for (const pattern of [/process\s*\./, /console\s*\./, /fetch\s*\(/, /https?\s*\./, /axios/i,
    /googleapis/i, /@google/i, /client_secret/i, /authorization_code/i]) assert.equal(pattern.test(source), false, `${pattern} forbidden`);
});

(async () => {
  for (const { name, run } of tests) { await run(); process.stdout.write(`ok - ${name}\n`); }
  assert.equal(tests.length, 15);
  process.stdout.write('PASS verify:email-google-oauth-transaction-repository-consume (15 named offline tests)\n');
})().catch(error => { process.stderr.write(`${error && error.stack ? error.stack : error}\n`); process.exitCode = 1; });
