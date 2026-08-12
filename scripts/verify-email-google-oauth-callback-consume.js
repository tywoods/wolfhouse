'use strict';

/**
 * RED-only offline contract for the pure Google OAuth callback consume owner.
 * No completion, token exchange, secret/provider call, route, environment,
 * telemetry, network, deployment, or live database capability.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Authentic RED: this provider-specific production owner is intentionally absent.
const owner = require('./lib/email-google-oauth-callback-consume');
const { createGoogleOAuthCallbackConsume } = owner;

const freeze = Object.freeze;
const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION = '12345678-90ab-4cde-8fab-1234567890ab';
const OPERATION = '99999999-8888-4777-8666-555555555555';
const LOCATION = '11111111-2222-4333-8444-555555555555';
const ENDPOINT = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const STAFF = 'abcdef01-2345-4678-89ab-cdef01234567';
const STATE = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64url');
const STATE_HASH = crypto.createHash('sha256').update(STATE, 'ascii').digest('hex');
const CODE = 'google-code+/%?=visible-but-private';
const VERIFIER = `${'V'.repeat(41)}-._~`;
const NONCE = `${'N'.repeat(42)}_`;
const NOW = '2026-08-11T12:05:00.000Z';
const LEAK = 'HOSTILE_GOOGLE_CALLBACK_VALUE_NEVER_DISCLOSE';

function input(query = `code=${encodeURIComponent(CODE)}&state=${STATE}`, patch = {}) {
  return freeze({ query, ...patch });
}
function row(patch = {}) {
  return freeze({ clientId: CLIENT, authSessionId: SESSION, operationId: OPERATION, locationId: LOCATION, endpointId: ENDPOINT,
    staffUserId: STAFF, codeVerifier: VERIFIER, nonce: NONCE, ...patch });
}
function expected(code = CODE) {
  return { status: 'consumed', authorizationCode: code, clientId: CLIENT, authSessionId: SESSION, operationId: OPERATION,
    locationId: LOCATION, endpointId: ENDPOINT, staffUserId: STAFF, codeVerifier: VERIFIER, nonce: NONCE };
}
function harness(spec = {}) {
  const calls = { sha: [], now: [], consume: [] };
  const cryptography = freeze({ sha256Ascii(value) { calls.sha.push({ value, receiver: this });
    if (spec.shaThrow) throw new Error(LEAK); return spec.shaValue || crypto.createHash('sha256').update(value, 'ascii').digest(); } });
  const clock = freeze({ now() { calls.now.push({ receiver: this }); if (spec.clockThrow) throw new Error(LEAK); return spec.now || NOW; } });
  const repository = freeze({ consume(dto) { calls.consume.push({ dto, receiver: this });
    if (spec.repoThrow) throw new Error(LEAK); return Object.hasOwn(spec, 'repoValue') ? spec.repoValue : row(); } });
  return { calls, cryptography, clock, repository, dependencies: freeze({ cryptography, clock, repository }) };
}
function create(h = harness()) { return createGoogleOAuthCallbackConsume(h.dependencies); }
function clean(error) {
  assert.equal(error.name, 'GoogleOAuthCallbackConsumeError');
  assert.equal(error.code, 'GOOGLE_OAUTH_CALLBACK_CONSUME_FAILED');
  assert.equal(error.message, 'GOOGLE_OAUTH_CALLBACK_CONSUME_FAILED');
  assert.equal(Object.isFrozen(error), true);
  assert.deepEqual(Object.keys(error), ['code']);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  const rendered = `${error}\n${error.stack || ''}\n${JSON.stringify(error)}`;
  for (const value of [LEAK, STATE, STATE_HASH, CODE, VERIFIER, NONCE]) assert.equal(rendered.includes(value), false);
  return true;
}
async function rejects(action) { await assert.rejects(Promise.resolve().then(action), clean); }
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('exports only the frozen factory and constructs an inert exact frozen reusable service', () => {
  const h = harness(); const service = create(h);
  assert.equal(Object.isFrozen(owner), true); assert.deepEqual(Reflect.ownKeys(owner), ['createGoogleOAuthCallbackConsume']);
  assert.equal(Object.isFrozen(service), true); assert.deepEqual(Reflect.ownKeys(service), ['consumeCallback']);
  assert.deepEqual(h.calls, { sha: [], now: [], consume: [] });
});

test('requires exact frozen ordered narrow dependency owners, native non-proxies, and pins methods and receivers', async () => {
  const h = harness(); const bad = [undefined, null, {}, { ...h.dependencies }, freeze({ ...h.dependencies, extra: true }),
    freeze({ clock: h.clock, cryptography: h.cryptography, repository: h.repository }),
    freeze({ cryptography: freeze({ sha256Ascii() {}, extra() {} }), clock: h.clock, repository: h.repository }),
    freeze({ cryptography: h.cryptography, clock: freeze({ now: 1 }), repository: h.repository })];
  for (const value of bad) assert.throws(() => createGoogleOAuthCallbackConsume(value), clean);
  let traps = 0; const proxy = new Proxy(h.dependencies, { getPrototypeOf() { traps += 1; return Object.prototype; }, ownKeys() { traps += 1; return []; } });
  assert.throws(() => createGoogleOAuthCallbackConsume(proxy), clean); assert.equal(traps, 0);
  await create(h).consumeCallback(input());
  assert.strictEqual(h.calls.sha[0].receiver, h.cryptography); assert.strictEqual(h.calls.now[0].receiver, h.clock);
  assert.strictEqual(h.calls.consume[0].receiver, h.repository);
});

test('requires exact frozen ordered canonical owner input and bounded primitive ASCII raw query before effects', async () => {
  const good = input(); const bad = [undefined, null, {}, { ...good }, freeze({ ...good, extra: true }),
    freeze({ query: good.query, clientId: CLIENT }), freeze(Object.assign(Object.create(null), good)),
    freeze({ ...good, [Symbol('x')]: true }), input(new String(good.query)),
    input(`?${good.query}`), input('a'.repeat(16385)), input('code=olé&state=' + STATE)];
  const accessor = { ...good }; Object.defineProperty(accessor, 'query', { enumerable: true, get() { throw new Error(LEAK); } }); freeze(accessor); bad.push(accessor);
  let traps = 0; bad.push(new Proxy(good, { getOwnPropertyDescriptor() { traps += 1; throw new Error(LEAK); } }));
  for (const value of bad) { const h = harness(); await rejects(() => create(h).consumeCallback(value)); assert.deepEqual(h.calls, { sha: [], now: [], consume: [] }); }
  assert.equal(traps, 0);
});

test('parses success independent of parameter order, hashes state once, and atomically consumes exact owner DTO', async () => {
  for (const query of [`state=${STATE}&code=${encodeURIComponent(CODE)}`, `code=${encodeURIComponent(CODE)}&state=${STATE}`]) {
    const h = harness(); const result = await create(h).consumeCallback(input(query));
    assert.deepEqual(h.calls.sha.map(call => call.value), [STATE]); assert.equal(h.calls.now.length, 1); assert.equal(h.calls.consume.length, 1);
    const dto = h.calls.consume[0].dto; assert.equal(Object.isFrozen(dto), true);
    assert.deepEqual(Reflect.ownKeys(dto), ['stateHash', 'consumedAt']);
    assert.deepEqual(dto, { stateHash: STATE_HASH, consumedAt: NOW });
    assert.deepEqual(result, expected()); assert.equal(Object.isFrozen(result), true);
  }
});

test('rejects malformed percent encoding, duplicates, empties, unknowns, fragments, ambiguity, and forbidden authority material without burn', async () => {
  const malformed = ['', 'code=x', `state=${STATE}`, `state=${STATE}&code=x&error=access_denied`,
    `state=${STATE}&code=x&code=y`, `state=${STATE}&state=${STATE}&code=x`, `state=${STATE}&code=x&`,
    `state=${STATE}&code=x&&`, `state=${STATE}&=x&code=x`, `state=${STATE}&code=x&scope=y`,
    `state=${STATE}&code=x#fragment`, `state=${STATE}&code=%`, `state=${STATE}&code=%GG`,
    `state=${STATE}&code=x&clientId=${CLIENT}`, `state=${STATE}&code=x&nonce=${NONCE}`,
    `state=${STATE}&code=x&codeVerifier=${VERIFIER}`, `state=${STATE}&code=x&operationId=${OPERATION}`];
  for (const query of malformed) { const h = harness(); await rejects(() => create(h).consumeCallback(input(query)));
    assert.equal(h.calls.sha.length, 0); assert.equal(h.calls.now.length, 0); assert.equal(h.calls.consume.length, 0); }
});

test('accepts only exact state and visible ASCII bounded authorization code grammar', async () => {
  const malformed = [`state=${STATE.slice(1)}&code=x`, `state=${STATE}=&code=x`, `state=${STATE}&code=`,
    `state=${STATE}&code=${encodeURIComponent('\n')}`, `state=${STATE}&code=${'x'.repeat(8193)}`];
  for (const query of malformed) { const h = harness(); await rejects(() => create(h).consumeCallback(input(query))); assert.equal(h.calls.consume.length, 0); }
  const h = harness(); assert.equal((await create(h).consumeCallback(input(`state=${STATE}&code=${'x'.repeat(8192)}`))).status, 'consumed');
});

test('recognized access_denied burns before returning exact minimal declined status', async () => {
  const h = harness(); const result = await create(h).consumeCallback(input(`error=access_denied&state=${STATE}`));
  assert.equal(h.calls.consume.length, 1); assert.deepEqual(h.calls.sha.map(call => call.value), [STATE]);
  assert.deepEqual(result, { status: 'declined' }); assert.equal(Object.isFrozen(result), true); assert.deepEqual(Reflect.ownKeys(result), ['status']);
  for (const key of ['error', 'state', 'stateHash', 'operationId', 'codeVerifier', 'nonce']) assert.equal(key in result, false);
});

test('rejects unrecognized or malformed provider declines without consuming', async () => {
  for (const query of [`state=${STATE}&error=temporarily_unavailable`, `state=${STATE}&error=ACCESS_DENIED`,
    `state=${STATE}&error=access_denied&error_description=no`, `state=${STATE}&error=`]) {
    const h = harness(); await rejects(() => create(h).consumeCallback(input(query))); assert.equal(h.calls.consume.length, 0);
  }
});

test('maps repository null after success or decline to one exact frozen invalid status, including replay and cross-owner miss', async () => {
  for (const query of [`state=${STATE}&code=x`, `state=${STATE}&error=access_denied`]) {
    const h = harness({ repoValue: null }); const result = await create(h).consumeCallback(input(query));
    assert.deepEqual(result, { status: 'invalid' }); assert.equal(Object.isFrozen(result), true); assert.deepEqual(Reflect.ownKeys(result), ['status']);
    assert.equal(h.calls.consume.length, 1);
  }
});

test('validates exact frozen repository DTO again before releasing minimized consumed material', async () => {
  const malformed = [undefined, {}, { ...row() }, freeze({ ...row(), extra: true }),
    freeze({ clientId: CLIENT, authSessionId: SESSION, locationId: LOCATION, operationId: OPERATION, endpointId: ENDPOINT, staffUserId: STAFF, codeVerifier: VERIFIER, nonce: NONCE }),
    row({ operationId: 'bad' }), row({ codeVerifier: 'x'.repeat(42) }), row({ nonce: 'bad' })];
  const accessor = { ...row() }; Object.defineProperty(accessor, 'nonce', { enumerable: true, get() { throw new Error(LEAK); } }); freeze(accessor); malformed.push(accessor);
  let traps = 0; malformed.push(new Proxy(row(), { ownKeys() { traps += 1; throw new Error(LEAK); } }));
  for (const repoValue of malformed) await rejects(() => create(harness({ repoValue })).consumeCallback(input()));
  assert.equal(traps, 0);
  const result = await create().consumeCallback(input()); assert.deepEqual(Reflect.ownKeys(result),
    ['status', 'authorizationCode', 'clientId', 'authSessionId', 'operationId', 'locationId', 'endpointId', 'staffUserId', 'codeVerifier', 'nonce']);
  for (const key of ['state', 'stateHash', 'rawRow', 'error', 'token', 'accessToken', 'refreshToken']) assert.equal(key in result, false);
});

test('accepts direct or exact same-realm native Promise repository result only and awaits consume acknowledgement before disclosure', async () => {
  assert.deepEqual(await create(harness({ repoValue: row() })).consumeCallback(input()), expected());
  assert.deepEqual(await create(harness({ repoValue: Promise.resolve(row()) })).consumeCallback(input()), expected());
  let thenCalls = 0; const hostile = [freeze({ then() { thenCalls += 1; } }), Object.setPrototypeOf({ then() { thenCalls += 1; } }, Promise.prototype),
    new (class ChildPromise extends Promise {})(resolve => resolve(row())), vm.runInNewContext('Promise.resolve(Object.freeze({}))')];
  for (const repoValue of hostile) await rejects(() => create(harness({ repoValue })).consumeCallback(input()));
  assert.equal(thenCalls, 0);
  let release; const gate = new Promise(resolve => { release = resolve; }); const h = harness({ repoValue: gate });
  let disclosed = false; const pending = create(h).consumeCallback(input()).then(() => { disclosed = true; });
  await Promise.resolve(); assert.equal(h.calls.consume.length, 1); assert.equal(disclosed, false); release(row()); await pending; assert.equal(disclosed, true);
});

test('fails closed on malformed clock/hash and dependency failures with no retry, logs, or leaks', async () => {
  const cases = [{ now: '2026-08-11T12:05:00Z' }, { now: '2026-02-30T12:05:00.000Z' }, { shaValue: Buffer.alloc(31) },
    { shaValue: new Uint8Array(32) }, { clockThrow: true }, { shaThrow: true }, { repoThrow: true }];
  const originals = [console.log, console.info, console.warn, console.error]; const logs = [];
  [console.log, console.info, console.warn, console.error] = originals.map(() => (...args) => logs.push(args));
  try { for (const spec of cases) { const h = harness(spec); await rejects(() => create(h).consumeCallback(input())); assert.ok(h.calls.consume.length <= 1); } assert.deepEqual(logs, []); }
  finally { [console.log, console.info, console.warn, console.error] = originals; }
});

test('is reusable and concurrent with exactly one isolated repository consume per accepted callback', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const h = harness({ repoValue: gate }); const service = create(h);
  const first = service.consumeCallback(input('state=' + STATE + '&code=one'));
  const second = service.consumeCallback(input('code=two&state=' + STATE)); assert.equal(h.calls.consume.length, 2);
  assert.notStrictEqual(h.calls.consume[0].dto, h.calls.consume[1].dto); release(row());
  assert.deepEqual((await Promise.all([first, second])).map(value => value.authorizationCode), ['one', 'two']);
  await service.consumeCallback(input('state=' + STATE + '&code=three')); assert.equal(h.calls.consume.length, 3);
});

test('uses captured intrinsics and rejects proxies before traps despite hostile child and post-construction poisoning', async () => {
  const h = harness(); const service = create(h); let traps = 0;
  const proxied = new Proxy(input(), { getPrototypeOf() { traps += 1; return Object.prototype; }, ownKeys() { traps += 1; return []; } });
  await rejects(() => service.consumeCallback(proxied)); assert.equal(traps, 0);
  const saved = { apply: Reflect.apply, freeze: Object.freeze, ownKeys: Reflect.ownKeys, decode: global.decodeURIComponent,
    test: RegExp.prototype.test, Promise: global.Promise, isBuffer: Buffer.isBuffer };
  let result;
  try { Reflect.apply = () => { throw new Error(LEAK); }; Object.freeze = value => value; Reflect.ownKeys = () => { throw new Error(LEAK); };
    global.decodeURIComponent = () => { throw new Error(LEAK); }; RegExp.prototype.test = () => { throw new Error(LEAK); };
    global.Promise = function PoisonPromise() { throw new Error(LEAK); }; Buffer.isBuffer = () => false;
    result = await service.consumeCallback(input());
  } finally { Reflect.apply = saved.apply; Object.freeze = saved.freeze; Reflect.ownKeys = saved.ownKeys; global.decodeURIComponent = saved.decode;
    RegExp.prototype.test = saved.test; global.Promise = saved.Promise; Buffer.isBuffer = saved.isBuffer; }
  assert.deepEqual(result, expected()); assert.equal(saved.freeze(result), result); assert.equal(Object.isFrozen(result), true);
});

test('owner source remains pure and package registration names only this offline verifier', () => {
  const source = fs.readFileSync(path.join(__dirname, 'lib/email-google-oauth-callback-consume.js'), 'utf8');
  for (const forbidden of [/process\s*\./, /console\s*\./, /fetch\s*\(/, /node:https|require\(['"]https['"]\)/,
    /express|router|middleware/i, /googleapis|google-auth-library|@google/i, /clientSecret|accessToken|refreshToken/,
    /require\(['"](?:node:)?crypto['"]\)/, /telemetry|metrics/i]) assert.equal(forbidden.test(source), false, String(forbidden));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['verify:email-google-oauth-callback-consume'], 'node scripts/verify-email-google-oauth-callback-consume.js');
});

(async () => {
  for (const { name, run } of tests) { await run(); process.stdout.write(`ok - ${name}\n`); }
  assert.equal(tests.length, 15);
  process.stdout.write('PASS verify:email-google-oauth-callback-consume (15 named offline tests)\n');
})().catch(error => { process.stderr.write(`${error && error.stack ? error.stack : error}\n`); process.exitCode = 1; });
