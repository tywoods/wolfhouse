'use strict';

/**
 * Strict RED-only tracer for the preconfigured real Google transaction-completion adapter.
 * It deliberately reuses the merged operation and handoff owners instead of duplicating
 * their RSA/JWT/token harness. No route, environment, database, live network, SDK,
 * deployment, telemetry, credential, or logging capability exists here.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Authentic RED: GREEN must add this sole adapter owner.
const owner = require('./lib/email-google-transaction-completion-factory');
const { createGoogleTransactionCompletionFactory } = owner;
const {
  createGoogleOAuthCallbackCompletion,
} = require('./lib/email-google-oauth-callback-completion');

const freeze = Object.freeze;
const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENDPOINT = '11111111-2222-4333-8444-555555555555';
const OPERATION = '99999999-8888-4777-8666-555555555555';
const ACTOR = 'abcdef01-2345-4678-89ab-cdef01234567';
const NONCE = 'google-transaction-nonce-never-log';
const APP_CLIENT = '9876543210-web_client.v2.apps.googleusercontent.com';
const REDIRECT = 'https://mail.example.test/private/google/callback';
const REF = 'secret-ref:email/google/oauth-client';
const CODE = '4/0A+GOOGLE_TRANSACTION_CODE_NEVER_LOG';
const VERIFIER = `${'V'.repeat(41)}-._~`;
const SECRET = 'GOOGLE_TRANSACTION_SECRET_NEVER_LOG';
const LEAK = 'HOSTILE_TRANSACTION_COMPLETION_VALUE_NEVER_LOG';

function operationConfig(patch = {}) { return freeze({
  clientId: CLIENT, endpointId: ENDPOINT, operationId: OPERATION, actorStaffUserId: ACTOR,
  expectedNonce: NONCE, expectedClientId: APP_CLIENT, applicationClientId: APP_CLIENT,
  redirectUri: REDIRECT, ...patch,
}); }
function handoffConfig(patch = {}) { return freeze({ secretRef: REF, ...patch }); }
function provider(fn = function resolveClientSecret() { throw new Error(`${LEAK}:${SECRET}`); }) {
  return freeze({ resolveClientSecret: fn });
}
function harness() {
  const calls = { https: 0, crypto: 0, timers: 0, envelope: 0, clock: 0, installer: 0 };
  const https = freeze({ request() { calls.https += 1; throw new Error(LEAK); } });
  const crypto = freeze({ createPublicKey() { calls.crypto += 1; throw new Error(LEAK); }, verify() { calls.crypto += 1; throw new Error(LEAK); } });
  const timers = freeze({ setTimeout() { calls.timers += 1; throw new Error(LEAK); }, clearTimeout() { calls.timers += 1; throw new Error(LEAK); } });
  const envelopeProvider = freeze({ sealGrantPayload() { calls.envelope += 1; throw new Error(LEAK); }, openGrantPayload() { calls.envelope += 1; throw new Error(LEAK); }, rewrapGrantDek() { calls.envelope += 1; throw new Error(LEAK); } });
  const clock = freeze({ nowEpochSeconds() { calls.clock += 1; throw new Error(LEAK); } });
  const installer = freeze({ installVerifiedGrant() { calls.installer += 1; throw new Error(LEAK); } });
  return { calls, dependencies: freeze({ https, crypto, timers, envelopeProvider, clock, installer }) };
}
function noEffects(calls) { assert.deepEqual(calls, { https: 0, crypto: 0, timers: 0, envelope: 0, clock: 0, installer: 0 }); }
function clean(error) {
  assert.equal(error.name, 'GoogleTransactionCompletionFactoryError');
  assert.equal(error.code, 'GOOGLE_TRANSACTION_COMPLETION_FACTORY_FAILED');
  assert.equal(error.message, 'GOOGLE_TRANSACTION_COMPLETION_FACTORY_FAILED');
  assert.equal(Object.isFrozen(error), true); assert.deepEqual(Object.keys(error), ['code']);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  const rendered = `${error}\n${error.stack || ''}\n${JSON.stringify(error)}`;
  for (const privateValue of [LEAK, CODE, VERIFIER, SECRET, NONCE, REF]) assert.equal(rendered.includes(privateValue), false);
  return true;
}
function handoffClean(error) {
  assert.equal(error.name, 'GoogleClientSecretHandoffError');
  assert.equal(error.code, 'GOOGLE_CLIENT_SECRET_HANDOFF_FAILED');
  assert.equal(error.message, 'GOOGLE_CLIENT_SECRET_HANDOFF_FAILED');
  assert.equal(Object.hasOwn(error, 'cause'), false); return true;
}
const tests = []; function test(name, run) { tests.push({ name, run }); }

test('exports only the frozen factory and returns the exact frozen reusable surface without construction effects', () => {
  const h = harness(); const service = createGoogleTransactionCompletionFactory(h.dependencies);
  assert.equal(Object.isFrozen(owner), true); assert.deepEqual(Reflect.ownKeys(owner), ['createGoogleTransactionCompletionFactory']);
  assert.equal(Object.isFrozen(service), true); assert.deepEqual(Reflect.ownKeys(service), ['createTransactionCompletion']);
  assert.equal(service.createTransactionCompletion.length, 3); noEffects(h.calls);
});

test('requires exact frozen ordered six owners and every exact frozen existing method set', () => {
  const h = harness(); const d = h.dependencies;
  const bad = [undefined, null, {}, { ...d }, freeze({ ...d, extra: true }),
    freeze({ crypto: d.crypto, https: d.https, timers: d.timers, envelopeProvider: d.envelopeProvider, clock: d.clock, installer: d.installer }),
    freeze({ ...d, https: freeze({ request: 1 }) }),
    freeze({ ...d, crypto: freeze({ createPublicKey() {}, verify() {}, randomBytes() {} }) }),
    freeze({ ...d, timers: freeze({ setTimeout() {} }) }),
    freeze({ ...d, envelopeProvider: freeze({ sealGrantPayload() {}, openGrantPayload() {} }) }),
    freeze({ ...d, clock: freeze({ nowEpochSeconds() {}, extra() {} }) }),
    freeze({ ...d, installer: { installVerifiedGrant() {} } })];
  for (const value of bad) assert.throws(() => createGoogleTransactionCompletionFactory(value), clean);
  noEffects(h.calls);
});

test('validates exact frozen operation, handoff, and provider boundaries before any capability effect', () => {
  const h = harness(); const factory = createGoogleTransactionCompletionFactory(h.dependencies); const p = provider();
  const badOperations = [undefined, {}, { ...operationConfig() }, freeze({ ...operationConfig(), extra: true }),
    freeze({ endpointId: ENDPOINT, clientId: CLIENT, operationId: OPERATION, actorStaffUserId: ACTOR, expectedNonce: NONCE, expectedClientId: APP_CLIENT, applicationClientId: APP_CLIENT, redirectUri: REDIRECT }),
    operationConfig({ clientId: 'bad' }), operationConfig({ expectedNonce: '' }), operationConfig({ applicationClientId: 'bad' }),
    operationConfig({ expectedClientId: 'other.apps.googleusercontent.com' }), operationConfig({ redirectUri: 'http://evil.test/callback' })];
  for (const value of badOperations) assert.throws(() => factory.createTransactionCompletion(value, handoffConfig(), p), clean);
  const badHandoffs = [undefined, {}, { secretRef: REF }, freeze({ secretRef: REF, extra: true }), handoffConfig({ secretRef: SECRET })];
  for (const value of badHandoffs) assert.throws(() => factory.createTransactionCompletion(operationConfig(), value, p), clean);
  const badProviders = [undefined, {}, { resolveClientSecret() {} }, freeze({ resolveClientSecret: 1 }), freeze({ resolveClientSecret() {}, extra: true })];
  for (const value of badProviders) assert.throws(() => factory.createTransactionCompletion(operationConfig(), handoffConfig(), value), clean);
  noEffects(h.calls);
});

test('rejects hostile boundary proxies and accessors with sanitized adapter failure and no effects', () => {
  const h = harness(); const factory = createGoogleTransactionCompletionFactory(h.dependencies); let traps = 0;
  const hostile = new Proxy(operationConfig(), { getPrototypeOf() { traps += 1; throw new Error(LEAK); }, ownKeys() { traps += 1; throw new Error(LEAK); } });
  assert.throws(() => factory.createTransactionCompletion(hostile, handoffConfig(), provider()), clean);
  const accessor = {}; Object.defineProperty(accessor, 'secretRef', { enumerable: true, get() { traps += 1; throw new Error(LEAK); } }); freeze(accessor);
  assert.throws(() => factory.createTransactionCompletion(operationConfig(), accessor, provider()), clean);
  assert.equal(traps, 0); noEffects(h.calls);
});

test('keeps canonical HTTPS valid and rejects HTTP after post-load URL getter changes', () => {
  const h = harness();
  const factory = createGoogleTransactionCompletionFactory(h.dependencies);
  const names = ['protocol', 'username', 'password', 'hash', 'search', 'port', 'hostname', 'href'];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(URL.prototype, name)]));
  const poisoned = {
    protocol: 'https:', username: '', password: '', hash: '', search: '', port: '',
    hostname: 'mail.example.test', href: 'http://evil.test/callback',
  };
  try {
    for (const name of names) Object.defineProperty(URL.prototype, name, {
      configurable: true, enumerable: originals.get(name).enumerable, get() { return poisoned[name]; },
    });
    assert.throws(() => factory.createTransactionCompletion(
      operationConfig({ redirectUri: 'http://evil.test/callback' }), handoffConfig(), provider(),
    ), clean);
    const completion = factory.createTransactionCompletion(operationConfig(), handoffConfig(), provider());
    assert.deepEqual(Reflect.ownKeys(completion), ['completeAuthorization']);
    const callbackConsume = freeze({ consumeCallback() { return freeze({ status: 'invalid' }); } });
    const callback = createGoogleOAuthCallbackCompletion(freeze({
      applicationClientId: APP_CLIENT, redirectUri: REDIRECT, secretRef: REF,
    }), freeze({ callbackConsume, secretProvider: provider(), transactionCompletionFactory: factory }));
    assert.deepEqual(callback.completeCallback(freeze({
      clientId: CLIENT, authSessionId: ENDPOINT, query: 'state=ignored&code=ignored',
    })), freeze({ status: 'invalid' }));
    noEffects(h.calls);
  } finally {
    for (const name of names) Object.defineProperty(URL.prototype, name, originals.get(name));
  }
});

test('composes the real operation and real handoff, preserving provider receiver without network or retries', async () => {
  const h = harness(); let calls = 0; let receiver;
  const secretProvider = provider(function resolveClientSecret(dto) { calls += 1; receiver = this;
    assert.equal(Object.isFrozen(dto), true); assert.deepEqual(dto, { secretRef: REF }); throw new Error(`${LEAK}:${SECRET}`); });
  const completion = createGoogleTransactionCompletionFactory(h.dependencies)
    .createTransactionCompletion(operationConfig(), handoffConfig(), secretProvider);
  assert.equal(Object.isFrozen(completion), true); assert.deepEqual(Reflect.ownKeys(completion), ['completeAuthorization']); noEffects(h.calls);
  await assert.rejects(Promise.resolve().then(() => completion.completeAuthorization(freeze({ authorizationCode: CODE, codeVerifier: VERIFIER }))), handoffClean);
  assert.equal(calls, 1); assert.strictEqual(receiver, secretProvider); noEffects(h.calls);
  await assert.rejects(Promise.resolve().then(() => completion.completeAuthorization(freeze({ authorizationCode: CODE, codeVerifier: VERIFIER }))), handoffClean);
  assert.equal(calls, 1); noEffects(h.calls);
});

test('reuses one factory concurrently while creating isolated handoff one-shot instances', async () => {
  const h = harness(); let calls = 0; const p = provider(() => { calls += 1; throw new Error(LEAK); });
  const factory = createGoogleTransactionCompletionFactory(h.dependencies);
  const first = factory.createTransactionCompletion(operationConfig(), handoffConfig(), p);
  const second = factory.createTransactionCompletion(operationConfig(), handoffConfig(), p);
  assert.notStrictEqual(first, second);
  await Promise.all([first, second].map(service => assert.rejects(Promise.resolve().then(() => service.completeAuthorization(freeze({ authorizationCode: CODE, codeVerifier: VERIFIER }))), handoffClean)));
  assert.equal(calls, 2); noEffects(h.calls);
});

test('pins dependency methods and intrinsics against post-construction poisoning', () => {
  const h = harness(); const factory = createGoogleTransactionCompletionFactory(h.dependencies);
  assert.throws(() => { h.dependencies.https.request = () => {}; }, TypeError);
  const completion = factory.createTransactionCompletion(operationConfig(), handoffConfig(), provider());
  assert.deepEqual(Reflect.ownKeys(completion), ['completeAuthorization']); noEffects(h.calls);
});

test('source imports only the native proxy detector and exactly the two real owners once', () => {
  const sourcePath = path.join(__dirname, 'lib/email-google-transaction-completion-factory.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const imports = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
  assert.deepEqual(imports, ['node:util', './email-google-authorization-code-operation', './email-google-client-secret-handoff', './email-microsoft-oauth-stage-telemetry']);
  assert.equal(source.split('createGoogleAuthorizationCodeOperation(').length - 1, 1);
  assert.equal(source.split('createGoogleClientSecretHandoff(').length - 1, 1);
  assert.ok(source.indexOf('createGoogleAuthorizationCodeOperation(') < source.indexOf('createGoogleClientSecretHandoff('));
  for (const forbidden of [/process\s*\./, /console\s*\./, /node:https/, /\bfetch\s*\(/, /express|router|callback|middleware/i,
    /\b(?:database|postgres|sql|deploy)\b/i, /googleapis|@googleapis\//, /setTimeout\s*\(/, /resolveClientSecret\s*\(/])
    assert.equal(forbidden.test(source), false, `${forbidden}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['verify:email-google-transaction-completion-factory'], 'node scripts/verify-email-google-transaction-completion-factory.js');
});

(async () => {
  for (const { name, run } of tests) { await run(); process.stdout.write(`ok - ${name}\n`); }
  assert.equal(tests.length, 9);
  process.stdout.write('PASS verify:email-google-transaction-completion-factory (9 named offline tests)\n');
})().catch(error => { process.stderr.write(`${error && error.stack ? error.stack : error}\n`); process.exitCode = 1; });
