'use strict';

/**
 * RED-only offline contract for the pure Google OAuth authorization-start owner.
 * No route, authentication middleware, environment, secret, provider call, callback,
 * SDK, deployment, live database, token, authorization code, or send capability.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { GOOGLE_PHASE_A_SCOPES } = require('./lib/email-google-verified-grant-custody');

// Authentic RED: GREEN must provide this sole provider-specific pure owner.
const owner = require('./lib/email-google-oauth-start');
const { createGoogleOAuthStart } = owner;

const freeze = Object.freeze;
const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const LOCATION = '11111111-2222-4333-8444-555555555555';
const ENDPOINT = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const STAFF = 'abcdef01-2345-4678-89ab-cdef01234567';
const SESSION = '12345678-90ab-4cde-8fab-1234567890ab';
const OPERATION = '99999999-8888-4777-8666-555555555555';
const APPLICATION_CLIENT = '9876543210-web_client.v2.apps.googleusercontent.com';
const REDIRECT = 'https://mail.example.test/private/google/callback';
const ISSUED = '2026-08-11T12:00:00.000Z';
const EXPIRES = '2026-08-11T12:10:00.000Z';
const AUTHORITY = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = GOOGLE_PHASE_A_SCOPES.join(' ');
const LEAK = 'HOSTILE_GOOGLE_START_VALUE_NEVER_DISCLOSE';
const PARAMS = freeze([
  'client_id', 'response_type', 'redirect_uri', 'response_mode', 'scope', 'state', 'nonce',
  'code_challenge', 'code_challenge_method', 'prompt',
]);
const byteSets = freeze([
  Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
  Buffer.from(Array.from({ length: 32 }, (_, index) => index + 32)),
  Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index)),
]);
const STATE = byteSets[0].toString('base64url');
const NONCE = byteSets[1].toString('base64url');
const VERIFIER = byteSets[2].toString('base64url');
const STATE_HASH = crypto.createHash('sha256').update(STATE, 'ascii').digest('hex');
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');

function config(patch = {}) {
  return freeze({ enabled: true, applicationClientId: APPLICATION_CLIENT, redirectUri: REDIRECT, ...patch });
}
function input(patch = {}) {
  return freeze({ clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT,
    staffUserId: STAFF, authSessionId: SESSION, ...patch });
}
function ack(patch = {}) { return freeze({ operationId: OPERATION, expiresAt: EXPIRES, ...patch }); }
function harness(patch = {}) {
  const calls = { uuid: [], bytes: [], sha: [], now: [], create: [] };
  let byteIndex = 0;
  const cryptography = freeze({
    randomUUID() { calls.uuid.push({ receiver: this }); return OPERATION; },
    randomBytes(size) { calls.bytes.push({ size, receiver: this }); return Buffer.from(byteSets[byteIndex++]); },
    sha256Ascii(value) {
      calls.sha.push({ value, receiver: this });
      return crypto.createHash('sha256').update(value, 'ascii').digest();
    },
  });
  const clock = freeze({ now() { calls.now.push({ receiver: this }); return ISSUED; } });
  const repository = freeze({ create(dto) { calls.create.push({ dto, receiver: this }); return ack(); } });
  return { calls, cryptography, clock, repository,
    dependencies: freeze({ cryptography, clock, repository }), ...patch };
}
function create(h = harness(), cfg = config()) { return createGoogleOAuthStart(cfg, h.dependencies); }
function clean(error) {
  assert.equal(error.name, 'GoogleOAuthStartError');
  assert.equal(error.code, 'GOOGLE_OAUTH_START_FAILED');
  assert.equal(error.message, 'GOOGLE_OAUTH_START_FAILED');
  assert.equal(Object.isFrozen(error), true);
  assert.deepEqual(Object.keys(error), ['code']);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  const rendered = `${error}\n${error.stack || ''}\n${JSON.stringify(error)}`;
  for (const secret of [LEAK, STATE, NONCE, VERIFIER, STATE_HASH, OPERATION]) assert.equal(rendered.includes(secret), false);
  return true;
}
async function rejects(action) { await assert.rejects(Promise.resolve().then(action), clean); }
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('exports only the frozen factory and constructs one frozen reusable start surface without effects', async () => {
  const h = harness(); const service = create(h);
  assert.equal(Object.isFrozen(owner), true); assert.deepEqual(Reflect.ownKeys(owner), ['createGoogleOAuthStart']);
  assert.equal(Object.isFrozen(service), true); assert.deepEqual(Reflect.ownKeys(service), ['start']);
  assert.deepEqual(h.calls, { uuid: [], bytes: [], sha: [], now: [], create: [] });
});

test('requires exact frozen ordered deployment configuration and exact true activation before effects', async () => {
  const good = config();
  const bad = [undefined, null, {}, { ...good }, freeze({ ...good, extra: true }),
    freeze({ applicationClientId: APPLICATION_CLIENT, enabled: true, redirectUri: REDIRECT }),
    freeze(Object.assign(Object.create(null), good)), freeze({ ...good, [Symbol('x')]: true }),
    config({ enabled: false }), config({ enabled: 'true' }), config({ enabled: 1 }),
    config({ applicationClientId: 'other.apps.googleusercontent.com' }),
    config({ applicationClientId: '9876543210-UPPER.apps.googleusercontent.com' }),
    config({ redirectUri: 'http://mail.example.test/callback' }), config({ redirectUri: 'https://user@mail.example.test/callback' }),
    config({ redirectUri: 'https://mail.example.test/callback#fragment' }),
    new Proxy(good, { ownKeys() { throw new Error(LEAK); } })];
  const accessor = {}; Object.defineProperties(accessor, {
    enabled: { enumerable: true, get() { throw new Error(LEAK); } },
    applicationClientId: { enumerable: true, value: APPLICATION_CLIENT }, redirectUri: { enumerable: true, value: REDIRECT },
  }); freeze(accessor); bad.push(accessor);
  for (const value of bad) { const h = harness(); assert.throws(() => create(h, value), clean); assert.deepEqual(h.calls, { uuid: [], bytes: [], sha: [], now: [], create: [] }); }
});

test('requires exact frozen ordered narrow dependency owners and pins every method and receiver', async () => {
  const h = harness();
  const bad = [undefined, null, {}, { ...h.dependencies }, freeze({ ...h.dependencies, extra: true }),
    freeze({ clock: h.clock, cryptography: h.cryptography, repository: h.repository }),
    freeze({ cryptography: freeze({ ...h.cryptography, extra: true }), clock: h.clock, repository: h.repository }),
    freeze({ cryptography: h.cryptography, clock: { now() {} }, repository: h.repository }),
    freeze({ cryptography: h.cryptography, clock: h.clock, repository: freeze({ create: 1 }) }),
    new Proxy(h.dependencies, { getPrototypeOf() { throw new Error(LEAK); } })];
  for (const value of bad) assert.throws(() => createGoogleOAuthStart(config(), value), clean);
  const service = create(h);
  await service.start(input());
  assert.strictEqual(h.calls.uuid[0].receiver, h.cryptography);
  for (const call of h.calls.bytes) assert.strictEqual(call.receiver, h.cryptography);
  for (const call of h.calls.sha) assert.strictEqual(call.receiver, h.cryptography);
  assert.strictEqual(h.calls.now[0].receiver, h.clock); assert.strictEqual(h.calls.create[0].receiver, h.repository);
});

test('rejects nonfrozen, proxy, accessor, extra, symbol, wrong-order, wrong-prototype, or noncanonical authority input before effects', async () => {
  const good = input(); const bad = [undefined, null, {}, { ...good }, freeze({ ...good, extra: true }),
    freeze({ locationId: LOCATION, clientId: CLIENT, endpointId: ENDPOINT, staffUserId: STAFF, authSessionId: SESSION }),
    freeze(Object.assign(Object.create(null), good)), freeze({ ...good, [Symbol('x')]: true }),
    input({ clientId: CLIENT.toUpperCase() }), input({ locationId: 'not-a-uuid' }),
    input({ endpointId: '11111111-2222-3333-8444-555555555555' }),
    input({ state: STATE }), input({ nonce: NONCE }), input({ codeVerifier: VERIFIER }), input({ operationId: OPERATION }),
    new Proxy(good, { getOwnPropertyDescriptor() { throw new Error(LEAK); } })];
  const accessor = { ...good }; Object.defineProperty(accessor, 'clientId', { enumerable: true, get() { throw new Error(LEAK); } }); freeze(accessor); bad.push(accessor);
  for (const value of bad) { const h = harness(); await rejects(() => create(h).start(value)); assert.deepEqual(h.calls, { uuid: [], bytes: [], sha: [], now: [], create: [] }); }
});

test('generates UUIDv4 plus three isolated 32-byte base64url values and derives state hex and S256 challenge', async () => {
  const h = harness(); const result = await create(h).start(input());
  assert.equal(h.calls.uuid.length, 1); assert.deepEqual(h.calls.bytes.map(call => call.size), [32, 32, 32]);
  assert.deepEqual(h.calls.sha.map(call => call.value), [STATE, VERIFIER]);
  for (const value of [STATE, NONCE, VERIFIER, CHALLENGE]) assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  assert.match(STATE_HASH, /^[0-9a-f]{64}$/);
  const url = new URL(result.authorizationUrl);
  assert.equal(url.searchParams.get('state'), STATE); assert.equal(url.searchParams.get('nonce'), NONCE);
  assert.equal(url.searchParams.get('code_challenge'), CHALLENGE);
});

test('persists exactly one exact frozen ordered repository DTO with fixed 600-second canonical lifetime', async () => {
  const h = harness(); await create(h).start(input()); assert.equal(h.calls.create.length, 1);
  const dto = h.calls.create[0].dto; assert.equal(Object.isFrozen(dto), true);
  assert.deepEqual(Reflect.ownKeys(dto), ['clientId', 'locationId', 'endpointId', 'staffUserId', 'authSessionId',
    'operationId', 'stateHash', 'codeVerifier', 'nonce', 'issuedAt', 'expiresAt']);
  assert.deepEqual(dto, { clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT, staffUserId: STAFF,
    authSessionId: SESSION, operationId: OPERATION, stateHash: STATE_HASH, codeVerifier: VERIFIER, nonce: NONCE,
    issuedAt: ISSUED, expiresAt: EXPIRES });
  assert.equal(Date.parse(dto.expiresAt) - Date.parse(dto.issuedAt), 600000);
});

test('returns only a fixed-endpoint deterministic ordered Google URL and canonical expiry after persistence', async () => {
  let completed = false; const h = harness();
  h.repository = freeze({ create(dto) { h.calls.create.push({ dto, receiver: this }); completed = true; return ack(); } });
  h.dependencies = freeze({ cryptography: h.cryptography, clock: h.clock, repository: h.repository });
  const result = await create(h).start(input()); assert.equal(completed, true);
  assert.equal(Object.isFrozen(result), true); assert.deepEqual(Reflect.ownKeys(result), ['authorizationUrl', 'expiresAt']);
  assert.equal(result.expiresAt, EXPIRES); const url = new URL(result.authorizationUrl);
  assert.equal(url.origin + url.pathname, AUTHORITY); assert.deepEqual([...url.searchParams.keys()], PARAMS);
  assert.deepEqual([...url.searchParams.entries()], [
    ['client_id', APPLICATION_CLIENT], ['response_type', 'code'], ['redirect_uri', REDIRECT], ['response_mode', 'query'],
    ['scope', SCOPE], ['state', STATE], ['nonce', NONCE], ['code_challenge', CHALLENGE],
    ['code_challenge_method', 'S256'], ['prompt', 'consent'],
  ]);
  assert.deepEqual(GOOGLE_PHASE_A_SCOPES, ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose']);
  assert.equal(url.searchParams.has('gmail.send'), false); assert.equal(result.authorizationUrl.includes('gmail.send'), false);
  for (const key of ['nonce', 'state', 'codeVerifier', 'stateHash', 'operationId', 'clientId', 'endpointId']) assert.equal(key in result, false);
});

test('accepts only exact direct or same-realm native Promise repository acknowledgement matching operation and expiry', async () => {
  for (const output of [ack(), Promise.resolve(ack())]) {
    const h = harness(); h.repository = freeze({ create(dto) { h.calls.create.push({ dto, receiver: this }); return output; } });
    h.dependencies = freeze({ cryptography: h.cryptography, clock: h.clock, repository: h.repository });
    assert.equal((await create(h).start(input())).expiresAt, EXPIRES);
  }
  let thenCalls = 0;
  const malformed = [undefined, null, {}, { ...ack() }, freeze({ ...ack(), extra: true }),
    freeze({ expiresAt: EXPIRES, operationId: OPERATION }), ack({ operationId: CLIENT }),
    ack({ expiresAt: '2026-08-11T12:09:59.999Z' }), freeze({ then() { thenCalls += 1; } }),
    new (class ChildPromise extends Promise {})(resolve => resolve(ack())), vm.runInNewContext('Promise.resolve(Object.freeze({operationId:"99999999-8888-4777-8666-555555555555",expiresAt:"2026-08-11T12:10:00.000Z"}))')];
  for (const output of malformed) { const h = harness(); h.repository = freeze({ create() { return output; } }); h.dependencies = freeze({ cryptography: h.cryptography, clock: h.clock, repository: h.repository }); await rejects(() => create(h).start(input())); }
  assert.equal(thenCalls, 0);
});

test('does not disclose an authorization URL while an asynchronous persistence acknowledgement is pending', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const h = harness();
  h.repository = freeze({ create(dto) { h.calls.create.push({ dto, receiver: this }); return gate; } });
  h.dependencies = freeze({ cryptography: h.cryptography, clock: h.clock, repository: h.repository });
  let disclosed = false; const pending = create(h).start(input()).then(() => { disclosed = true; });
  await Promise.resolve(); assert.equal(h.calls.create.length, 1); assert.equal(disclosed, false);
  release(ack()); await pending; assert.equal(disclosed, true);
});

test('fails closed on malformed generated values or clock before persistence and never retries', async () => {
  const cases = [
    h => { h.cryptography = freeze({ ...h.cryptography, randomUUID() { return 'not-uuid'; } }); },
    h => { h.cryptography = freeze({ ...h.cryptography, randomBytes() { return Buffer.alloc(31); } }); },
    h => { h.cryptography = freeze({ ...h.cryptography, randomBytes() { return new Uint8Array(32); } }); },
    h => { h.cryptography = freeze({ ...h.cryptography, sha256Ascii() { return Buffer.alloc(31); } }); },
    h => { h.clock = freeze({ now() { return '2026-08-11T12:00:00Z'; } }); },
  ];
  for (const mutate of cases) { const h = harness(); mutate(h); h.dependencies = freeze({ cryptography: h.cryptography, clock: h.clock, repository: h.repository }); await rejects(() => create(h).start(input())); assert.equal(h.calls.create.length, 0); }
});

test('sanitizes generation and repository failures, emits no logs, and performs no retry', async () => {
  const originals = [console.log, console.info, console.warn, console.error]; const logs = [];
  [console.log, console.info, console.warn, console.error] = originals.map(() => (...args) => logs.push(args));
  try {
    for (const asyncFailure of [false, true]) { const h = harness(); let calls = 0;
      h.repository = freeze({ create() { calls += 1; if (asyncFailure) return Promise.reject(new Error(`${LEAK}:${STATE}`)); throw new Error(`${LEAK}:${VERIFIER}`); } });
      h.dependencies = freeze({ cryptography: h.cryptography, clock: h.clock, repository: h.repository });
      await rejects(() => create(h).start(input())); assert.equal(calls, 1);
    }
    assert.deepEqual(logs, []);
  } finally { [console.log, console.info, console.warn, console.error] = originals; }
});

test('is reusable and concurrent with isolated material and exactly one write per accepted call', async () => {
  let operationIndex = 0; let byte = 0; let release; const gate = new Promise(resolve => { release = resolve; }); const writes = [];
  const cryptography = freeze({ randomUUID() { operationIndex += 1; return operationIndex === 1 ? OPERATION : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; },
    randomBytes(size) { byte += 1; return Buffer.alloc(size, byte); },
    sha256Ascii(value) { return crypto.createHash('sha256').update(value, 'ascii').digest(); } });
  const clock = freeze({ now() { return ISSUED; } });
  const repository = freeze({ create(dto) { writes.push(dto); return gate.then(() => freeze({ operationId: dto.operationId, expiresAt: dto.expiresAt })); } });
  const service = createGoogleOAuthStart(config(), freeze({ cryptography, clock, repository }));
  const first = service.start(input()); const second = service.start(input()); assert.equal(writes.length, 2);
  assert.notEqual(writes[0].operationId, writes[1].operationId); assert.notEqual(writes[0].stateHash, writes[1].stateHash);
  assert.notEqual(writes[0].codeVerifier, writes[1].codeVerifier); assert.notEqual(writes[0].nonce, writes[1].nonce);
  release(); await Promise.all([first, second]); await service.start(input()); assert.equal(writes.length, 3);
});

test('uses captured intrinsics and pinned functions despite function-owned and post-construction poisoning', async () => {
  const h = harness(); let traps = 0;
  for (const ownerValue of [h.cryptography, h.clock, h.repository]) for (const key of Reflect.ownKeys(ownerValue)) {
    const fn = ownerValue[key]; Object.defineProperties(fn, { call: { value() { traps += 1; } }, apply: { value() { traps += 1; } } });
  }
  const service = create(h); const saved = { apply: Reflect.apply, freeze: Object.freeze, Promise: global.Promise,
    URL: global.URL, from: Buffer.from, isBuffer: Buffer.isBuffer, test: RegExp.prototype.test };
  let result;
  try {
    Reflect.apply = () => { throw new Error(LEAK); }; Object.freeze = value => value;
    global.Promise = function PoisonPromise() { throw new Error(LEAK); }; global.URL = function PoisonURL() { throw new Error(LEAK); };
    Buffer.from = () => { throw new Error(LEAK); }; Buffer.isBuffer = () => false; RegExp.prototype.test = () => { throw new Error(LEAK); };
    result = await service.start(input());
  } finally { Reflect.apply = saved.apply; Object.freeze = saved.freeze; global.Promise = saved.Promise;
    global.URL = saved.URL; Buffer.from = saved.from; Buffer.isBuffer = saved.isBuffer; RegExp.prototype.test = saved.test; }
  assert.equal(traps, 0); assert.equal(saved.freeze === Object.freeze, true); assert.equal(Object.isFrozen(result), true);
});

test('production owner is structurally pure and has no ambient or capability-bearing imports', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'lib/email-google-oauth-start.js'), 'utf8');
  for (const forbidden of [/process\s*\.\s*env/, /node:https|require\(['"]https['"]\)/, /fetch\s*\(/,
    /express|router|middleware/i, /clientSecret|authorizationCode|accessToken|refreshToken/, /googleapis|google-auth-library/i,
    /console\s*\./, /gmail\.send/]) assert.equal(forbidden.test(source), false, String(forbidden));
  assert.equal(/require\(['"](?:node:)?crypto['"]\)/.test(source), false, 'cryptography must remain injected');
});

(async () => {
  for (const { name, run } of tests) { await run(); process.stdout.write(`ok - ${name}\n`); }
  assert.equal(tests.length, 14);
  process.stdout.write('PASS verify:email-google-oauth-start (14 named offline tests)\n');
})().catch(error => { process.stderr.write(`${error && error.stack ? error.stack : error}\n`); process.exitCode = 1; });
