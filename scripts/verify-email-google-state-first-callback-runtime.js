'use strict';
/**
 * Focused offline verifier for the pure state-first Google OAuth callback runtime.
 *
 * Contract:
 * - Public config is server-owned and fixture-free for client/application IDs.
 * - Caller input is only {query}; consumed state owns tenant client identity.
 * - Authentic callback-consume burns state first; resolver then factory run after.
 * - Resolver authority.secretRef is propagated verbatim into handoff.
 * - Real createTransactionCompletion(operation, handoff, secretProvider) 3-arg contract.
 * - No routes, SQL, env activation, network, or provider wiring in this owner.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const OWNER_PATH = path.join(__dirname, 'lib', 'email-google-state-first-callback-runtime.js');
const FACTORY_PATH = path.join(__dirname, 'lib', 'email-google-transaction-completion-factory.js');
const PACKAGE_PATH = path.join(__dirname, '..', 'package.json');
// Authentic RED: production module must be absent until GREEN.
const owner = require('./lib/email-google-state-first-callback-runtime');
const { createGoogleStateFirstCallbackRuntime } = owner;
const {
  createGoogleTransactionCompletionFactory,
} = require('./lib/email-google-transaction-completion-factory');
const freeze = Object.freeze;
const verifierIsFrozen = Object.isFrozen;
const VerifierPromise = Promise;
const verifierPromiseResolve = Promise.resolve;
const verifierApply = Reflect.apply;
const TENANT = 'sunset';
const LOCATION_KEY = 'sunset-somo';
const REDIRECT = 'https://sunset-staging.lunafrontdesk.com/staff/email/google/callback';
// Distinct dynamic server-owned IDs — not production fixture pins.
const CLIENT_A = 'a1111111-bbbb-4ccc-8ddd-eeeeeeeeeee1';
const CLIENT_B = 'b2222222-bbbb-4ccc-8ddd-eeeeeeeeeee2';
const APP_A = '1111111111-runtime-a.apps.googleusercontent.com';
const APP_B = '2222222222-runtime-b.apps.googleusercontent.com';
const AUTH = 'c3333333-bbbb-4ccc-8ddd-eeeeeeeeeee3';
const LOCATION = 'd4444444-bbbb-4ccc-8ddd-eeeeeeeeeee4';
const ENDPOINT = 'e5555555-bbbb-4ccc-8ddd-eeeeeeeeeee5';
const OPERATION = 'f6666666-bbbb-4ccc-8ddd-eeeeeeeeeee6';
const STAFF = 'a7777777-bbbb-4ccc-8ddd-eeeeeeeeeee7';
const REF_A = 'secret-ref:email/google/runtime-a-oauth-client';
const REF_B = 'secret-ref:email/google/runtime-b-oauth-client';
const STATE = Buffer.alloc(32, 7).toString('base64url');
const VERIFIER = `${'V'.repeat(41)}-._~`;
const NONCE = `${'N'.repeat(42)}_`;
const CODE = '4/OFFLINE_STATE_FIRST_CODE';
const LEAK = 'HOSTILE_STATE_FIRST_PRIVATE_VALUE';
const NOW = '2026-08-12T00:00:00.000Z';
const FAILURE = 'GOOGLE_STATE_FIRST_CALLBACK_FAILED';
const DISABLED = 'GOOGLE_STATE_FIRST_CALLBACK_DISABLED';
const CONFIG_KEYS = freeze([
  'tenantSlug', 'locationKey', 'applicationClientId', 'redirectUri', 'callbackEnabled',
]);
function config(options = {}) {
  return freeze({
    tenantSlug: options.tenantSlug || TENANT,
    locationKey: LOCATION_KEY,
    applicationClientId: options.applicationClientId || APP_A,
    redirectUri: REDIRECT,
    callbackEnabled: options.callbackEnabled !== undefined ? options.callbackEnabled : true,
  });
}
function input(query = `state=${STATE}&code=${encodeURIComponent(CODE)}`, patch = {}) {
  return freeze({
    query,
    ...patch,
  });
}
function row(patch = {}) {
  return freeze({
    clientId: patch.clientId || CLIENT_A,
    authSessionId: AUTH,
    operationId: OPERATION,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    staffUserId: STAFF,
    codeVerifier: VERIFIER,
    nonce: NONCE,
    ...patch,
  });
}
function authority(patch = {}) {
  return freeze({
    tenantSlug: TENANT,
    clientId: patch.clientId || CLIENT_A,
    locationKey: LOCATION_KEY,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    secretRef: patch.secretRef || REF_A,
    ...patch,
  });
}
function clean(code) {
  return (error) => {
    assert.ok(error);
    assert.equal(error.code, code);
    assert.equal(error.stack, undefined);
    assert.equal(verifierIsFrozen(error), true);
    const rendered = `${error}\n${error.stack || ''}\n${JSON.stringify(error)}`;
    for (const privateValue of [LEAK, CODE, STATE, VERIFIER, NONCE, REF_A, REF_B, 'SECRET OFFLINE']) {
      assert.equal(rendered.includes(privateValue), false, `leak:${privateValue}`);
    }
    return true;
  };
}
async function rejects(action, code) {
  await assert.rejects(verifierApply(verifierPromiseResolve, VerifierPromise, []).then(action), clean(code));
}
function harness(options = {}) {
  const calls = [];
  const factoryArgs = [];
  const resolveArgs = [];
  const completeArgs = [];
  const rows = options.rows ? options.rows.slice() : [row()];
  const clientId = options.clientId || CLIENT_A;
  const applicationClientId = options.applicationClientId || APP_A;
  const secretRef = options.secretRef || REF_A;
  const cryptography = freeze({
    sha256Ascii(value) {
      calls.push({ step: 'hash', value, receiver: this });
      return crypto.createHash('sha256').update(value, 'ascii').digest();
    },
  });
  const clock = freeze({
    now() {
      calls.push({ step: 'clock', receiver: this });
      return NOW;
    },
  });
  const repository = freeze({
    consume(dto) {
      calls.push({ step: 'consume', dto, receiver: this });
      return rows.length ? rows.shift() : null;
    },
  });
  const endpointAuthorityResolver = freeze({
    resolveConsumedEndpointAuthority(dto) {
      calls.push({ step: 'resolve', dto, receiver: this });
      resolveArgs.push(dto);
      if (options.resolveThrow) throw new Error(`${LEAK}:resolve`);
      if (Object.hasOwn(options, 'authority')) return options.authority;
      return authority({ clientId, secretRef });
    },
  });
  const secretProvider = freeze({
    resolveClientSecret() {
      calls.push({ step: 'secret', receiver: this });
      throw new Error('dispatcher must not resolve secrets directly');
    },
  });
  const transactionCompletionFactory = freeze({
    createTransactionCompletion(operationConfig, handoffConfig, provider) {
      calls.push({
        step: 'factory',
        operationConfig,
        handoffConfig,
        provider,
        receiver: this,
        argc: arguments.length,
      });
      factoryArgs.push({ operationConfig, handoffConfig, provider, receiver: this, argc: arguments.length });
      if (options.factoryThrow) throw new Error(`${LEAK}:factory`);
      const service = freeze({
        completeAuthorization(dto) {
          calls.push({ step: 'complete', dto, receiver: this });
          completeArgs.push({ dto, receiver: this });
          if (options.completeThrow) throw new Error(`${LEAK}:complete`);
          return Object.hasOwn(options, 'ack') ? options.ack : freeze({ status: 'custodied' });
        },
      });
      return service;
    },
  });
  return {
    calls,
    factoryArgs,
    resolveArgs,
    completeArgs,
    cryptography,
    clock,
    repository,
    endpointAuthorityResolver,
    secretProvider,
    transactionCompletionFactory,
    dependencies: freeze({
      cryptography,
      clock,
      repository,
      endpointAuthorityResolver,
      transactionCompletionFactory,
      secretProvider,
    }),
    clientId,
    applicationClientId,
    secretRef,
  };
}
function create(h = harness(), cfg = config()) {
  return createGoogleStateFirstCallbackRuntime(cfg, h.dependencies);
}
function steps(h) {
  return h.calls.map((entry) => entry.step);
}
function expectedOperation(clientId, applicationClientId) {
  return freeze({
    clientId,
    endpointId: ENDPOINT,
    operationId: OPERATION,
    actorStaffUserId: STAFF,
    expectedNonce: NONCE,
    expectedClientId: applicationClientId,
    applicationClientId,
    redirectUri: REDIRECT,
  });
}
const tests = [];
function test(name, run) {
  tests.push({ name, run });
}
test('exports only the frozen factory', () => {
  assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(Reflect.ownKeys(owner), ['createGoogleStateFirstCallbackRuntime']);
});
test('creates inert exact frozen reusable surface without child effects', () => {
  const h = harness();
  const runtime = create(h);
  assert.equal(Object.isFrozen(runtime), true);
  assert.deepEqual(Reflect.ownKeys(runtime), ['configuration', 'completeCallback']);
  assert.equal(Object.isFrozen(runtime.configuration), true);
  assert.deepEqual(Reflect.ownKeys(runtime.configuration), CONFIG_KEYS.slice());
  assert.deepEqual(runtime.configuration, config());
  assert.equal(JSON.stringify(runtime).includes('secretRef'), false);
  assert.deepEqual(steps(h), []);
});
test('frozen configuration keys are exact and secretRef is never public', () => {
  const h = harness();
  const runtime = create(h);
  assert.deepEqual(Reflect.ownKeys(runtime.configuration), [
    'tenantSlug', 'locationKey', 'applicationClientId', 'redirectUri', 'callbackEnabled',
  ]);
  assert.equal('clientId' in runtime.configuration, false);
  assert.equal('secretRef' in runtime.configuration, false);
  assert.equal(runtime.configuration.tenantSlug, TENANT);
  assert.equal(runtime.configuration.locationKey, LOCATION_KEY);
  assert.equal(runtime.configuration.redirectUri, REDIRECT);
  assert.equal(typeof runtime.configuration.callbackEnabled, 'boolean');
});
test('accepts consumed records from two distinct valid client UUIDs and application client IDs', async () => {
  for (const pair of [
    { clientId: CLIENT_A, applicationClientId: APP_A, secretRef: REF_A },
    { clientId: CLIENT_B, applicationClientId: APP_B, secretRef: REF_B },
  ]) {
    const h = harness({ ...pair, rows: [row({ clientId: pair.clientId })] });
    const cfg = config({ applicationClientId: pair.applicationClientId });
    const runtime = createGoogleStateFirstCallbackRuntime(cfg, h.dependencies);
    assert.equal('clientId' in runtime.configuration, false);
    assert.equal(runtime.configuration.applicationClientId, pair.applicationClientId);
    const out = await runtime.completeCallback(input());
    assert.deepEqual(out, freeze({ status: 'received' }));
    assert.equal(h.factoryArgs.length, 1);
    assert.deepEqual(h.factoryArgs[0].operationConfig, expectedOperation(pair.clientId, pair.applicationClientId));
    assert.deepEqual(h.factoryArgs[0].handoffConfig, freeze({ secretRef: pair.secretRef }));
  }
});
test('rejects hostile extra clientId and malformed applicationClientId without effects', () => {
  const h = harness();
  for (const bad of [
    freeze({ ...config(), clientId: CLIENT_A }),
    config({ applicationClientId: 'missing-suffix' }),
    config({ applicationClientId: '.apps.googleusercontent.com' }),
    config({ applicationClientId: 'bad apps.googleusercontent.com' }),
    config({ callbackEnabled: 1 }),
    config({ callbackEnabled: 'true' }),
  ]) {
    assert.throws(() => createGoogleStateFirstCallbackRuntime(bad, h.dependencies), clean(FAILURE));
  }
  assert.deepEqual(steps(h), []);
});
test('construction rejects nonexact configuration and dependency bags', () => {
  const h = harness();
  const good = config();
  for (const bad of [
    undefined,
    {},
    { ...good },
    freeze({ ...good, secretRef: REF_A }),
    freeze({ ...good, extra: true }),
    freeze({
      callbackEnabled: true,
      tenantSlug: TENANT,
      locationKey: LOCATION_KEY,
      applicationClientId: APP_A,
      redirectUri: REDIRECT,
    }),
    new Proxy(good, {}),
    freeze({ ...good, tenantSlug: 'wolfhouse' }),
    freeze({ ...good, locationKey: 'other' }),
    freeze({ ...good, redirectUri: 'http://evil.test/callback' }),
  ]) {
    assert.throws(() => createGoogleStateFirstCallbackRuntime(bad, h.dependencies), clean(FAILURE));
  }
  for (const bad of [
    undefined,
    {},
    { ...h.dependencies },
    freeze({ ...h.dependencies, extra: 1 }),
    freeze({
      clock: h.clock,
      cryptography: h.cryptography,
      repository: h.repository,
      endpointAuthorityResolver: h.endpointAuthorityResolver,
      transactionCompletionFactory: h.transactionCompletionFactory,
      secretProvider: h.secretProvider,
    }),
    new Proxy(h.dependencies, {}),
    freeze({
      cryptography: h.cryptography,
      clock: h.clock,
      repository: h.repository,
      endpointAuthorityResolver: h.endpointAuthorityResolver,
      transactionCompletionFactory: h.transactionCompletionFactory,
      // missing secretProvider
    }),
  ]) {
    assert.throws(() => createGoogleStateFirstCallbackRuntime(good, bad), clean(FAILURE));
  }
  assert.deepEqual(steps(h), []);
});
test('disabled fails fresh stackless before input parse hash clock repository resolver factory', async () => {
  const h = harness();
  const runtime = create(h, config({ callbackEnabled: false }));
  let first;
  let second;
  try {
    await runtime.completeCallback(null);
  } catch (error) {
    first = error;
  }
  try {
    await runtime.completeCallback(input('hostile'));
  } catch (error) {
    second = error;
  }
  assert.ok(clean(DISABLED)(first));
  assert.ok(clean(DISABLED)(second));
  assert.notStrictEqual(first, second);
  assert.deepEqual(steps(h), []);
});
test('success orders authentic consume then authority then factory then completion', async () => {
  const h = harness();
  const out = await create(h).completeCallback(input());
  assert.deepEqual(out, freeze({ status: 'received' }));
  assert.equal(Object.isFrozen(out), true);
  assert.deepEqual(Reflect.ownKeys(out), ['status']);
  assert.deepEqual(steps(h), ['hash', 'clock', 'consume', 'resolve', 'factory', 'complete']);
  assert.strictEqual(h.calls.find((c) => c.step === 'hash').receiver, h.cryptography);
  assert.strictEqual(h.calls.find((c) => c.step === 'clock').receiver, h.clock);
  assert.strictEqual(h.calls.find((c) => c.step === 'consume').receiver, h.repository);
  assert.strictEqual(h.calls.find((c) => c.step === 'resolve').receiver, h.endpointAuthorityResolver);
  assert.strictEqual(h.calls.find((c) => c.step === 'factory').receiver, h.transactionCompletionFactory);
});
test('factory is invoked with exact three-argument contract and secretProvider owner receiver', async () => {
  const h = harness();
  await create(h).completeCallback(input());
  assert.equal(h.factoryArgs.length, 1);
  const call = h.factoryArgs[0];
  assert.equal(call.argc, 3);
  assert.strictEqual(call.provider, h.secretProvider);
  assert.strictEqual(call.receiver, h.transactionCompletionFactory);
  assert.equal(Object.isFrozen(call.operationConfig), true);
  assert.deepEqual(Reflect.ownKeys(call.operationConfig), [
    'clientId', 'endpointId', 'operationId', 'actorStaffUserId',
    'expectedNonce', 'expectedClientId', 'applicationClientId', 'redirectUri',
  ]);
  assert.deepEqual(call.operationConfig, expectedOperation(CLIENT_A, APP_A));
  assert.equal(Object.isFrozen(call.handoffConfig), true);
  assert.deepEqual(call.handoffConfig, freeze({ secretRef: REF_A }));
  assert.deepEqual(Reflect.ownKeys(call.handoffConfig), ['secretRef']);
  assert.equal('locationId' in call.operationConfig, false);
  assert.equal(steps(h).includes('secret'), false);
});
test('propagates resolver secretRef A and B verbatim into handoff with no substitution', async () => {
  for (const secretRef of [REF_A, REF_B]) {
    const h = harness({ secretRef, authority: authority({ secretRef }) });
    await create(h).completeCallback(input());
    assert.equal(h.factoryArgs.length, 1);
    assert.strictEqual(h.factoryArgs[0].handoffConfig.secretRef, secretRef);
    assert.deepEqual(h.factoryArgs[0].handoffConfig, freeze({ secretRef }));
    assert.deepEqual(h.resolveArgs[0], freeze({
      tenantSlug: TENANT,
      clientId: CLIENT_A,
      locationKey: LOCATION_KEY,
      locationId: LOCATION,
      endpointId: ENDPOINT,
    }));
  }
});
test('consumed record clientId alone owns resolver and completion flow', async () => {
  const dispatcherPath = require.resolve('./lib/email-google-state-first-callback-runtime');
  const consumePath = require.resolve('./lib/email-google-oauth-callback-consume');
  const savedLoad = Module._load;
  const savedDispatcher = require.cache[dispatcherPath];
  let consumeCalls = 0;
  const consumeCallback = freeze(function consumeCallback() {
    consumeCalls += 1;
    return freeze({
      status: 'consumed', authorizationCode: CODE, clientId: CLIENT_B, authSessionId: AUTH,
      operationId: OPERATION, locationId: LOCATION, endpointId: ENDPOINT,
      staffUserId: STAFF, codeVerifier: VERIFIER, nonce: NONCE,
    });
  });
  const seam = freeze({ createGoogleOAuthCallbackConsume() { return freeze({ consumeCallback }); } });
  try {
    delete require.cache[dispatcherPath];
    Module._load = function controlledLoad(request, parent, isMain) {
      if (parent && parent.filename === dispatcherPath
          && Module._resolveFilename(request, parent, isMain) === consumePath) return seam;
      return Reflect.apply(savedLoad, this, [request, parent, isMain]);
    };
    const freshCreate = require(dispatcherPath).createGoogleStateFirstCallbackRuntime;
    const h = harness({ clientId: CLIENT_B, rows: [] });
    const runtime = freshCreate(config(), h.dependencies);
    const out = await runtime.completeCallback(input());
    assert.deepEqual(out, freeze({ status: 'received' }));
    assert.equal(consumeCalls, 1);
    assert.equal(steps(h).includes('resolve'), true);
    assert.equal(steps(h).includes('factory'), true);
    assert.equal(steps(h).includes('secret'), false);
    assert.equal(h.resolveArgs[0].clientId, CLIENT_B);
    assert.equal(h.factoryArgs[0].operationConfig.clientId, CLIENT_B);
  } finally {
    Module._load = savedLoad;
    delete require.cache[dispatcherPath];
    if (savedDispatcher) require.cache[dispatcherPath] = savedDispatcher;
  }
});
test('invalid and genuine decline pass through without resolver factory or secret provider', async () => {
  const invalid = harness({ rows: [] });
  assert.deepEqual(
    await create(invalid).completeCallback(input()),
    freeze({ status: 'invalid' }),
  );
  assert.deepEqual(steps(invalid), ['hash', 'clock', 'consume']);
  const decline = harness();
  assert.deepEqual(
    await create(decline).completeCallback(input(`state=${STATE}&error=access_denied`)),
    freeze({ status: 'declined' }),
  );
  assert.deepEqual(steps(decline), ['hash', 'clock', 'consume']);
});
test('hostile raw queries are rejected by authentic callback consume before repository', async () => {
  for (const query of [
    'state=x&code=a',
    `state=${STATE}&code=a&code=b`,
    `state=${STATE}&error=other`,
    `state=${STATE}&code=%ZZ`,
    `state=${STATE}&code=a#x`,
  ]) {
    const h = harness();
    await rejects(() => create(h).completeCallback(input(query)), FAILURE);
    assert.equal(steps(h).includes('consume'), false);
    assert.equal(steps(h).includes('resolve'), false);
  }
});
test('all authority dimensions must exactly bind consumed transaction', async () => {
  const patches = [
    { tenantSlug: 'wolfhouse' },
    { clientId: CLIENT_B },
    { locationKey: 'other' },
    { locationId: AUTH },
    { endpointId: AUTH },
  ];
  for (const patch of patches) {
    const h = harness({ authority: authority(patch) });
    await rejects(() => create(h).completeCallback(input()), FAILURE);
    assert.equal(steps(h).includes('factory'), false);
  }
});
test('rejects mutable accessor symbol proxy and trapping authority without factory', async () => {
  const accessor = { ...authority() };
  Object.defineProperty(accessor, 'secretRef', {
    enumerable: true,
    get() {
      throw new Error(LEAK);
    },
  });
  Object.freeze(accessor);
  const trapping = new Proxy(authority(), {
    ownKeys() {
      throw new Error(LEAK);
    },
  });
  const values = [
    { ...authority() },
    accessor,
    freeze({ ...authority(), [Symbol('x')]: 1 }),
    new Proxy(authority(), {}),
    trapping,
    freeze({ ...authority(), extra: true }),
  ];
  for (const value of values) {
    const h = harness({ authority: value });
    await rejects(() => create(h).completeCallback(input()), FAILURE);
    assert.equal(steps(h).includes('factory'), false);
  }
});
test('async resolver success then async completion rejection is sanitized and burned once', async () => {
  const h = harness({
    authority: Promise.resolve(authority()),
    ack: Promise.reject(new Error(`${LEAK}:completion`)),
  });
  await rejects(() => create(h).completeCallback(input()), FAILURE);
  assert.equal(steps(h).filter((s) => s === 'consume').length, 1);
  assert.equal(steps(h).filter((s) => s === 'resolve').length, 1);
  assert.equal(steps(h).filter((s) => s === 'complete').length, 1);
});
test('async resolver rejection is sanitized after state is burned', async () => {
  const h = harness({
    authority: Promise.reject(new Error(`${LEAK}:resolver`)),
  });
  await rejects(() => create(h).completeCallback(input()), FAILURE);
  assert.equal(steps(h).filter((s) => s === 'consume').length, 1);
  assert.equal(steps(h).includes('factory'), false);
});
test('sync factory and unknown completion acknowledgement fail sanitized after burn', async () => {
  for (const options of [
    { factoryThrow: true },
    { completeThrow: true },
    { ack: freeze({ status: 'unknown' }) },
    { ack: freeze({ status: 'received' }) },
    { ack: null },
  ]) {
    const h = harness(options);
    await rejects(() => create(h).completeCallback(input()), FAILURE);
    assert.equal(steps(h).filter((s) => s === 'consume').length, 1);
  }
});
test('Promise subclasses cross-realm promises thenables and proxies fail without attacker traps', async () => {
  let thenCalls = 0;
  class SubPromise extends Promise {}
  const hostile = [
    freeze({
      then() {
        thenCalls += 1;
        return Promise.resolve(authority());
      },
    }),
    Object.setPrototypeOf({
      then() {
        thenCalls += 1;
        return Promise.resolve(authority());
      },
    }, Promise.prototype),
    vm.runInNewContext('Promise.resolve(1)'),
    new SubPromise((resolve) => resolve(authority())),
    new Proxy(Promise.resolve(authority()), {
      get(target, prop, receiver) {
        thenCalls += 1;
        return Reflect.get(target, prop, receiver);
      },
    }),
  ];
  for (const authorityValue of hostile) {
    const h = harness({ authority: authorityValue });
    await rejects(() => create(h).completeCallback(input()), FAILURE);
    assert.equal(steps(h).includes('factory'), false);
  }
  assert.equal(thenCalls, 0);
  // Same for completion acknowledgements after a valid authority.
  thenCalls = 0;
  for (const ack of [
    freeze({
      then() {
        thenCalls += 1;
      },
    }),
    vm.runInNewContext('Promise.resolve(Object.freeze({status:"custodied"}))'),
    new SubPromise((resolve) => resolve(freeze({ status: 'custodied' }))),
  ]) {
    const h = harness({ ack });
    await rejects(() => create(h).completeCallback(input()), FAILURE);
  }
  assert.equal(thenCalls, 0);
});
test('same repository row under concurrent callbacks resolves and completes once', async () => {
  const h = harness({ rows: [row()] });
  const runtime = create(h);
  const results = await Promise.all([
    runtime.completeCallback(input()),
    runtime.completeCallback(input()),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), ['invalid', 'received']);
  assert.equal(steps(h).filter((s) => s === 'resolve').length, 1);
  assert.equal(steps(h).filter((s) => s === 'complete').length, 1);
  assert.equal(steps(h).filter((s) => s === 'consume').length, 2);
});
test('completion result never leaks private material', async () => {
  const h = harness();
  const result = await create(h).completeCallback(input());
  assert.deepEqual(result, freeze({ status: 'received' }));
  for (const key of [
    'authorizationCode', 'codeVerifier', 'nonce', 'locationId', 'operationId',
    'secretRef', 'endpointId', 'staffUserId', 'clientId',
  ]) {
    assert.equal(key in result, false);
  }
  const rendered = JSON.stringify(result);
  for (const privateValue of [CODE, VERIFIER, NONCE, REF_A, STATE]) {
    assert.equal(rendered.includes(privateValue), false);
  }
});
test('dependency owner methods are pinned with original receivers', async () => {
  const h = harness();
  await create(h).completeCallback(input());
  assert.strictEqual(h.calls.find((c) => c.step === 'hash').receiver, h.cryptography);
  assert.strictEqual(h.calls.find((c) => c.step === 'clock').receiver, h.clock);
  assert.strictEqual(h.calls.find((c) => c.step === 'consume').receiver, h.repository);
  assert.strictEqual(h.calls.find((c) => c.step === 'resolve').receiver, h.endpointAuthorityResolver);
  assert.strictEqual(h.calls.find((c) => c.step === 'factory').receiver, h.transactionCompletionFactory);
  assert.strictEqual(h.completeArgs[0].receiver, h.factoryArgs[0]
    ? h.calls.find((c) => c.step === 'complete').receiver
    : null);
  // completeAuthorization receiver is the service object returned by factory
  assert.equal(typeof h.completeArgs[0].receiver.completeAuthorization, 'function');
});
test('captures Error constructor at import and resists global Error poisoning after import', async () => {
  const savedError = global.Error;
  try {
    global.Error = function PoisonedError() {
      throw savedError('poison-error-ctor');
    };
    const h = harness();
    // Construction and disabled path must still produce sanitized module errors.
    assert.throws(
      () => createGoogleStateFirstCallbackRuntime(config({ tenantSlug: 'evil' }), h.dependencies),
      clean(FAILURE),
    );
    const runtime = createGoogleStateFirstCallbackRuntime(config({ callbackEnabled: false }), h.dependencies);
    await rejects(() => runtime.completeCallback(input()), DISABLED);
  } finally {
    global.Error = savedError;
  }
});
test('post-import poisoning of Object Reflect RegExp Promise does not bypass validation', async () => {
  const saved = {
    Object: global.Object,
    Reflect: global.Reflect,
    RegExp: global.RegExp,
    Promise: global.Promise,
    Error: global.Error,
    freeze: Object.freeze,
    create: Object.create,
    ownKeys: Reflect.ownKeys,
    test: RegExp.prototype.test,
  };
  try {
    global.Object = function PoisonedObject() {
      throw saved.Error('poison');
    };
    global.Reflect = new Proxy({}, {
      get() {
        throw saved.Error('poison');
      },
    });
    global.RegExp = function PoisonedRegExp() {
      throw saved.Error('poison');
    };
    global.Promise = function PoisonedPromise() {
      throw saved.Error('poison');
    };
    global.Error = function PoisonedError() {
      throw saved.Error('poison');
    };
    Object.freeze = () => {
      throw saved.Error('poison');
    };
    Object.create = () => {
      throw saved.Error('poison');
    };
    Reflect.ownKeys = () => [];
    RegExp.prototype.test = () => true;
    const h = harness();
    assert.throws(
      () => createGoogleStateFirstCallbackRuntime(config({ tenantSlug: 'evil' }), h.dependencies),
      clean(FAILURE),
    );
    await rejects(
      () => createGoogleStateFirstCallbackRuntime(config(), h.dependencies)
        .completeCallback(input('bad')),
      FAILURE,
    );
  } finally {
    global.Object = saved.Object;
    global.Reflect = saved.Reflect;
    global.RegExp = saved.RegExp;
    global.Promise = saved.Promise;
    global.Error = saved.Error;
    Object.freeze = saved.freeze;
    Object.create = saved.create;
    Reflect.ownKeys = saved.ownKeys;
    RegExp.prototype.test = saved.test;
  }
});
test('source imports authentic consume and payload-free telemetry only and has no fixture client or application literals', () => {
  const source = fs.readFileSync(OWNER_PATH, 'utf8');
  assert.match(source, /require\('\.\/email-google-oauth-callback-consume'\)/);
  assert.match(source, /require\('\.\/email-microsoft-oauth-stage-telemetry'\)/);
  assert.equal(source.includes(CLIENT_A), false);
  assert.equal(source.includes(CLIENT_B), false);
  assert.equal(source.includes(APP_A), false);
  assert.equal(source.includes(APP_B), false);
  assert.equal(source.includes('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), false);
  assert.equal(source.includes('9876543210-sunset.apps.googleusercontent.com'), false);
  assert.equal(source.includes('9876543210-web.apps.googleusercontent.com'), false);
  assert.equal(source.includes('secret-ref:email/google/sunset-staging-oauth-client'), false);
  assert.equal(source.includes(REF_A), false);
  assert.equal(source.includes(REF_B), false);
  for (const re of [
    /process\.env/,
    /\.query\s*\(/,
    /googleapis|express|router|listen\s*\(/i,
    /@azure|keyvault|DefaultAzureCredential/i,
  ]) {
    assert.equal(re.test(source), false, String(re));
  }
  // Exact frozen dependency key order includes secretProvider.
  assert.match(source, /secretProvider/);
  assert.match(source, /endpointAuthorityResolver/);
  assert.match(source, /transactionCompletionFactory/);
});
test('production invokes createTransactionCompletion with third secretProvider and original receiver', () => {
  const source = fs.readFileSync(OWNER_PATH, 'utf8');
  // Must pass secret provider owner as third argument (not only handoff/config).
  assert.match(
    source,
    /createTransactionCompletion[\s\S]{0,120},\s*[\s\S]{0,80},\s*[A-Za-z_$][\w$]*\s*\)/,
  );
  assert.match(source, /secretProvider/);
  // Contract relation to real factory.
  const factorySource = fs.readFileSync(FACTORY_PATH, 'utf8');
  assert.match(
    factorySource,
    /function createTransactionCompletion\(\s*operationConfiguration\s*,\s*handoffConfiguration\s*,\s*secretProvider\s*\)/,
  );
  assert.equal(
    require('../package.json').scripts['verify:email-google-state-first-callback-runtime'],
    'node scripts/verify-email-google-state-first-callback-runtime.js',
  );
});
test('authentic factory owner composes through dispatcher and reaches secret provider', async () => {
  const effects = [];
  const inert = (name) => function inertMethod() { effects.push(name); throw new Error(LEAK); };
  const factory = createGoogleTransactionCompletionFactory(freeze({
    https: freeze({ request: inert('https') }),
    crypto: freeze({ createPublicKey: inert('createPublicKey'), verify: inert('verify') }),
    timers: freeze({ setTimeout: inert('setTimeout'), clearTimeout: inert('clearTimeout') }),
    envelopeProvider: freeze({ sealGrantPayload: inert('seal'), openGrantPayload: inert('open'),
      rewrapGrantDek: inert('rewrap') }),
    clock: freeze({ nowEpochSeconds: inert('nowEpochSeconds') }),
    installer: freeze({ installVerifiedGrant: inert('installVerifiedGrant') }),
  }));
  const h = harness();
  const providerCalls = [];
  const sentinel = new Error(`${LEAK}:secret-provider-sentinel`);
  const secretProvider = freeze({ resolveClientSecret(request) {
    providerCalls.push({ receiver: this, request }); throw sentinel;
  } });
  const dependencies = freeze({
    cryptography: h.cryptography,
    clock: h.clock,
    repository: h.repository,
    endpointAuthorityResolver: h.endpointAuthorityResolver,
    transactionCompletionFactory: factory,
    secretProvider,
  });
  const runtime = createGoogleStateFirstCallbackRuntime(config(), dependencies);
  await rejects(() => runtime.completeCallback(input()), FAILURE);
  assert.equal(steps(h).filter((step) => step === 'consume').length, 1);
  assert.equal(steps(h).filter((step) => step === 'resolve').length, 1);
  assert.equal(providerCalls.length, 1);
  assert.strictEqual(providerCalls[0].receiver, secretProvider);
  assert.deepEqual(providerCalls[0].request, freeze({ secretRef: REF_A }));
  assert.deepEqual(effects, []);
});
test('production module stays within physical LOC budget and is not minified', () => {
  const source = fs.readFileSync(OWNER_PATH, 'utf8');
  const lines = source.split('\n');
  assert.ok(lines.length <= 400, `production LOC ${lines.length} > 400`);
  // Readable: average line length should not look like an 84-line minify dump.
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const avg = nonEmpty.reduce((sum, line) => sum + line.length, 0) / Math.max(nonEmpty.length, 1);
  assert.ok(avg < 140, `average line length ${avg} suggests minification`);
  assert.ok(nonEmpty.length >= 80, 'production should remain readable with multiple statements');
});
test('verifier stays within readable LOC budget', () => {
  const source = fs.readFileSync(__filename, 'utf8');
  const lines = source.split('\n').length;
  assert.ok(lines <= 850, `verifier LOC ${lines} > 850`);
});
test('package exposes focused gate only', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  assert.equal(
    pkg.scripts['verify:email-google-state-first-callback-runtime'],
    'node scripts/verify-email-google-state-first-callback-runtime.js',
  );
});
(async () => {
  for (const entry of tests) {
    await entry.run();
    process.stdout.write(`ok - ${entry.name}\n`);
  }
  process.stdout.write(
    `PASS verify:email-google-state-first-callback-runtime (${tests.length} named offline tests)\n`,
  );
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
