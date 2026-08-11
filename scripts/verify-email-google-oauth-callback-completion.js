'use strict';

/**
 * Strict RED-only tracer for the pure Google OAuth callback completion owner.
 *
 * A focused callback-composition test must not duplicate the authorization operation's
 * RSA/JWT, HTTPS and envelope harness (already exhaustively owned by its verifier).
 * Therefore this owner consumes a specifically named, preconfigured
 * `transactionCompletionFactory`. A separate adapter owner will statically bind the real
 * authorization operation and secret handoff, so neither boundary has unused imports or
 * a generic caller-controlled factory.
 * No route, environment, network, database, deployment, credential or logging capability.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Authentic RED: this sole production composition owner is intentionally absent.
const owner = require('./lib/email-google-oauth-callback-completion');
const { createGoogleOAuthCallbackCompletion } = owner;

const freeze = Object.freeze;
const APP_CLIENT = '9876543210-web.apps.googleusercontent.com';
const REDIRECT = 'https://mail.example.test/private/google/callback';
const REF = 'secret-ref:email/google/oauth-client';
const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OPERATION = '99999999-8888-4777-8666-555555555555';
const LOCATION = '11111111-2222-4333-8444-555555555555';
const ENDPOINT = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const STAFF = 'abcdef01-2345-4678-89ab-cdef01234567';
const NONCE = `${'N'.repeat(42)}_`;
const VERIFIER = `${'V'.repeat(41)}-._~`;
const CODE = '4/0A+PRIVATE_CALLBACK_CODE';
const LEAK = 'HOSTILE_CALLBACK_COMPLETION_PRIVATE_VALUE';
const ACK = freeze({ status: 'custodied' });

function config(patch = {}) { return freeze({ applicationClientId: APP_CLIENT, redirectUri: REDIRECT, secretRef: REF, ...patch }); }
function callbackInput(patch = {}) { return freeze({ clientId: CLIENT, authSessionId: OPERATION, query: 'code=private&state=private', ...patch }); }
function consumed(patch = {}) { return freeze({ status: 'consumed', authorizationCode: CODE, clientId: CLIENT,
  operationId: OPERATION, locationId: LOCATION, endpointId: ENDPOINT, staffUserId: STAFF,
  codeVerifier: VERIFIER, nonce: NONCE, ...patch }); }
function harness(spec = {}) {
  const calls = { consume: [], factory: [], complete: [], secret: [] };
  const callbackConsume = freeze({ consumeCallback(value) { calls.consume.push({ value, receiver: this });
    if (spec.consumeThrow) throw new Error(`${LEAK}:${CODE}`);
    return Object.hasOwn(spec, 'consumeResult') ? spec.consumeResult : consumed(); } });
  const secretProvider = freeze({ resolveClientSecret(value) { calls.secret.push({ value, receiver: this });
    throw new Error('completion factory owns handoff; callback owner must not resolve directly'); } });
  const transactionCompletionFactory = freeze({ createTransactionCompletion(operationConfig, handoffConfig, provider) {
    calls.factory.push({ operationConfig, handoffConfig, provider, receiver: this });
    if (spec.factoryThrow) throw new Error(`${LEAK}:${NONCE}`);
    return freeze({ completeAuthorization(value) { calls.complete.push({ value, receiver: this });
      if (spec.completeThrow) throw new Error(`${LEAK}:${VERIFIER}`);
      return Object.hasOwn(spec, 'completeResult') ? spec.completeResult : ACK; } });
  } });
  const dependencies = freeze({ callbackConsume, secretProvider, transactionCompletionFactory });
  return { calls, callbackConsume, secretProvider, transactionCompletionFactory, dependencies };
}
function create(h = harness(), cfg = config()) { return createGoogleOAuthCallbackCompletion(cfg, h.dependencies); }
function clean(error) {
  assert.equal(error.name, 'GoogleOAuthCallbackCompletionError');
  assert.equal(error.code, 'GOOGLE_OAUTH_CALLBACK_COMPLETION_FAILED');
  assert.equal(error.message, 'GOOGLE_OAUTH_CALLBACK_COMPLETION_FAILED');
  assert.equal(Object.isFrozen(error), true); assert.deepEqual(Object.keys(error), ['code']);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  const rendered = `${error}\n${error.stack || ''}\n${JSON.stringify(error)}`;
  for (const privateValue of [LEAK, CODE, VERIFIER, NONCE, REF]) assert.equal(rendered.includes(privateValue), false);
  return true;
}
async function rejects(action) { await assert.rejects(Promise.resolve().then(action), clean); }
const tests = []; function test(name, run) { tests.push({ name, run }); }

test('exports only the frozen factory and creates an inert exact frozen reusable service', () => {
  const h = harness(); const service = create(h);
  assert.equal(Object.isFrozen(owner), true); assert.deepEqual(Reflect.ownKeys(owner), ['createGoogleOAuthCallbackCompletion']);
  assert.equal(Object.isFrozen(service), true); assert.deepEqual(Reflect.ownKeys(service), ['completeCallback']);
  assert.deepEqual(h.calls, { consume: [], factory: [], complete: [], secret: [] });
});

test('requires exact frozen ordered configuration and narrow dependency owners before effects', () => {
  const h = harness(); const good = config();
  assert.throws(() => createGoogleOAuthCallbackCompletion(undefined, h.dependencies), clean);
  for (const value of [{}, { ...good }, freeze({ ...good, extra: true }),
    freeze({ redirectUri: REDIRECT, applicationClientId: APP_CLIENT, secretRef: REF }), new Proxy(good, {})])
    assert.throws(() => create(h, value), clean);
  const d = h.dependencies;
  for (const value of [undefined, {}, { ...d }, freeze({ ...d, extra: true }),
    freeze({ secretProvider: d.secretProvider, callbackConsume: d.callbackConsume, transactionCompletionFactory: d.transactionCompletionFactory })])
    assert.throws(() => createGoogleOAuthCallbackCompletion(good, value), clean);
  assert.deepEqual(h.calls, { consume: [], factory: [], complete: [], secret: [] });
});

test('passes the exact callback input once with pinned method and receiver', async () => {
  const h = harness({ consumeResult: freeze({ status: 'invalid' }) }); const input = callbackInput();
  assert.deepEqual(await create(h).completeCallback(input), { status: 'invalid' });
  assert.equal(h.calls.consume.length, 1); assert.strictEqual(h.calls.consume[0].value, input);
  assert.strictEqual(h.calls.consume[0].receiver, h.callbackConsume);
});

test('returns exact minimal invalid and declined statuses without constructing transaction authority', async () => {
  for (const status of ['invalid', 'declined']) {
    const h = harness({ consumeResult: freeze({ status }) }); const result = await create(h).completeCallback(callbackInput());
    assert.deepEqual(result, { status }); assert.deepEqual(Reflect.ownKeys(result), ['status']); assert.equal(Object.isFrozen(result), true);
    assert.equal(h.calls.factory.length, 0); assert.equal(h.calls.complete.length, 0); assert.equal(h.calls.secret.length, 0);
  }
});

test('validates callback result again and constructs no authority for malformed or hostile output', async () => {
  let traps = 0;
  const bad = [null, {}, freeze({ status: 'consumed' }), freeze({ ...consumed(), extra: true }),
    freeze({ locationId: LOCATION, status: 'consumed', authorizationCode: CODE, clientId: CLIENT, operationId: OPERATION,
      endpointId: ENDPOINT, staffUserId: STAFF, codeVerifier: VERIFIER, nonce: NONCE }),
    new Proxy(consumed(), { ownKeys() { traps += 1; throw new Error(LEAK); } })];
  for (const consumeResult of bad) { const h = harness({ consumeResult }); await rejects(() => create(h).completeCallback(callbackInput())); assert.equal(h.calls.factory.length, 0); }
  assert.equal(traps, 0);
});

test('maps consumed custody exactly, validates then drops locationId, and preserves construction order', async () => {
  const h = harness(); const result = await create(h).completeCallback(callbackInput());
  assert.deepEqual(h.calls.factory.map(() => 'factory').concat(h.calls.complete.map(() => 'complete')), ['factory', 'complete']);
  assert.equal(h.calls.factory.length, 1); const call = h.calls.factory[0];
  assert.strictEqual(call.receiver, h.transactionCompletionFactory); assert.strictEqual(call.provider, h.secretProvider);
  assert.equal(Object.isFrozen(call.operationConfig), true);
  assert.deepEqual(Reflect.ownKeys(call.operationConfig), ['clientId', 'endpointId', 'operationId', 'actorStaffUserId',
    'expectedNonce', 'expectedClientId', 'applicationClientId', 'redirectUri']);
  assert.deepEqual(call.operationConfig, { clientId: CLIENT, endpointId: ENDPOINT, operationId: OPERATION,
    actorStaffUserId: STAFF, expectedNonce: NONCE, expectedClientId: APP_CLIENT,
    applicationClientId: APP_CLIENT, redirectUri: REDIRECT });
  assert.equal(Object.isFrozen(call.handoffConfig), true);
  assert.deepEqual(call.handoffConfig, { secretRef: REF });
  assert.deepEqual(Reflect.ownKeys(call.handoffConfig), ['secretRef']);
  assert.equal('locationId' in call.operationConfig, false); assert.deepEqual(result, { status: 'received' });
});

test('invokes one-shot handoff once with exact code/verifier and returns no private material', async () => {
  const h = harness(); const result = await create(h).completeCallback(callbackInput());
  assert.equal(h.calls.complete.length, 1); const dto = h.calls.complete[0].value;
  assert.equal(Object.isFrozen(dto), true); assert.deepEqual(Reflect.ownKeys(dto), ['authorizationCode', 'codeVerifier']);
  assert.deepEqual(dto, { authorizationCode: CODE, codeVerifier: VERIFIER });
  assert.deepEqual(result, { status: 'received' }); assert.equal(Object.isFrozen(result), true);
  for (const key of ['authorizationCode', 'codeVerifier', 'nonce', 'locationId', 'operationId', 'secretRef']) assert.equal(key in result, false);
  assert.equal(h.calls.secret.length, 0);
});

test('accepts only direct or exact native Promise boundaries and rejects spoof/custom/cross-realm promises without then traps', async () => {
  assert.deepEqual(await create(harness({ consumeResult: Promise.resolve(consumed()), completeResult: Promise.resolve(ACK) })).completeCallback(callbackInput()), { status: 'received' });
  let thenCalls = 0; const hostile = [freeze({ then() { thenCalls += 1; } }),
    Object.setPrototypeOf({ then() { thenCalls += 1; } }, Promise.prototype), vm.runInNewContext('Promise.resolve(Object.freeze({status:"invalid"}))')];
  for (const consumeResult of hostile) await rejects(() => create(harness({ consumeResult })).completeCallback(callbackInput()));
  for (const completeResult of hostile) await rejects(() => create(harness({ completeResult })).completeCallback(callbackInput()));
  assert.equal(thenCalls, 0);
});

test('requires exact frozen custodied acknowledgement before returning received', async () => {
  for (const completeResult of [undefined, {}, { status: 'custodied' }, freeze({ status: 'wrong' }), freeze({ status: 'custodied', extra: true })])
    await rejects(() => create(harness({ completeResult })).completeCallback(callbackInput()));
});

test('sanitizes every post-consume failure without callback retry, logs, or secret resolution', async () => {
  const originals = [console.log, console.info, console.warn, console.error]; const logs = [];
  [console.log, console.info, console.warn, console.error] = originals.map(() => (...args) => logs.push(args));
  try {
    for (const spec of [{ factoryThrow: true }, { completeThrow: true }, { completeResult: Promise.reject(new Error(LEAK)) }]) {
      const h = harness(spec); await rejects(() => create(h).completeCallback(callbackInput()));
      assert.equal(h.calls.consume.length, 1); assert.ok(h.calls.factory.length <= 1); assert.ok(h.calls.complete.length <= 1); assert.equal(h.calls.secret.length, 0);
    }
    assert.deepEqual(logs, []);
  } finally { [console.log, console.info, console.warn, console.error] = originals; }
});

test('isolates concurrent callback transactions while keeping the service reusable', async () => {
  const h = harness(); const service = create(h);
  const results = await Promise.all([service.completeCallback(callbackInput({ query: 'one' })), service.completeCallback(callbackInput({ query: 'two' }))]);
  assert.deepEqual(results, [freeze({ status: 'received' }), freeze({ status: 'received' })]);
  assert.equal(h.calls.consume.length, 2); assert.equal(h.calls.factory.length, 2); assert.equal(h.calls.complete.length, 2);
  assert.notStrictEqual(h.calls.factory[0].operationConfig, h.calls.factory[1].operationConfig);
  await service.completeCallback(callbackInput({ query: 'three' })); assert.equal(h.calls.consume.length, 3);
});

test('pins intrinsics and child methods and rejects proxies with zero traps after hostile child execution', async () => {
  const h = harness({ consumeResult: freeze({ status: 'invalid' }) }); const service = create(h); let traps = 0;
  const proxy = new Proxy(callbackInput(), { getPrototypeOf() { traps += 1; return Object.prototype; }, ownKeys() { traps += 1; return []; } });
  await rejects(() => service.completeCallback(proxy)); assert.equal(traps, 0);
  const saved = { freeze: Object.freeze, ownKeys: Reflect.ownKeys, apply: Reflect.apply };
  try { Object.freeze = value => value; Reflect.ownKeys = () => { throw new Error(LEAK); }; Reflect.apply = () => { throw new Error(LEAK); };
    assert.deepEqual(await service.completeCallback(callbackInput()), { status: 'invalid' });
  } finally { Object.freeze = saved.freeze; Reflect.ownKeys = saved.ownKeys; Reflect.apply = saved.apply; }
});

test('source remains an offline pure mapper and delegates only to the named transaction completion factory', () => {
  const sourcePath = path.join(__dirname, 'lib/email-google-oauth-callback-completion.js'); const source = fs.readFileSync(sourcePath, 'utf8');
  const imports = [...source.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)].map(match => match[1]);
  assert.deepEqual(imports, []);
  assert.match(source, /transactionCompletionFactory/);
  for (const forbidden of [/process\s*\./, /console\s*\./, /node:https/, /\bfetch\s*\(/, /express|router|middleware/i,
    /\b(?:database|postgres|sql|deploy)\b/i, /googleapis|@googleapis\//, /setTimeout|setInterval/]) assert.equal(forbidden.test(source), false, `${forbidden}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['verify:email-google-oauth-callback-completion'], 'node scripts/verify-email-google-oauth-callback-completion.js');
});

(async () => {
  for (const { name, run } of tests) { await run(); process.stdout.write(`ok - ${name}\n`); }
  assert.equal(tests.length, 13);
  process.stdout.write('PASS verify:email-google-oauth-callback-completion (13 named offline tests)\n');
})().catch(error => { process.stderr.write(`${error && error.stack ? error.stack : error}\n`); process.exitCode = 1; });
