'use strict';

/**
 * Hostile offline gate for Stage 6 Microsoft verified-identity composition.
 * Uses real merged OIDC ID-token + JWKS factories (generated RSA), fake Graph
 * transport, and direct stub dependencies. No custody/callback/routes/DB/live.
 */

const assert = require('assert/strict');
const nativeCrypto = require('crypto');
const { EventEmitter } = require('events');
const {
  ERROR_CODE,
  ERROR_MESSAGE,
  createMicrosoftVerifiedIdentityComposition,
} = require('./lib/email-microsoft-verified-identity');
const { createMicrosoftOidcIdTokenValidator } = require('./lib/email-microsoft-oidc-id-token');
const { createMicrosoftOidcJwksSignatureVerifier } = require('./lib/email-microsoft-oidc-jwks-verifier');
const { createMicrosoftGraphMeIdentityTransport } = require('./lib/email-microsoft-graph-me-identity');

const NOW = 1900000000;
const TID = '01234567-89ab-4def-8123-456789abcdef';
const PRINCIPAL = 'principal-oidc-graph-match-1';
const NONCE = 'offline-nonce-NEVER-LEAK-7f1a';
const CLIENT = 'offline-client-id';
const ACCESS = 'offline-access-token-DO-NOT-LOG-9c2b';
const LEAK = 'VERIFIED-IDENTITY-SECRET-DO-NOT-LEAK';
const KID = 'offline-verified-key';

const pair = nativeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const alternatePair = nativeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const exportedJwk = pair.publicKey.export({ format: 'jwk' });

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

function frozenRecord(record) {
  return Object.freeze(record);
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createToken(header, claims, privateKey = pair.privateKey) {
  const encodedHeader = encodeJson(header);
  const encodedClaims = encodeJson(claims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = nativeCrypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function baseClaims(patch = {}) {
  return {
    tid: TID,
    oid: PRINCIPAL,
    sub: 'subject-1',
    aud: CLIENT,
    nonce: NONCE,
    iss: `https://login.microsoftonline.com/${TID}/v2.0`,
    exp: NOW + 600,
    iat: NOW - 1,
    nbf: NOW - 1,
    ...patch,
  };
}

function baseHeader(patch = {}) {
  return { alg: 'RS256', kid: KID, typ: 'JWT', ...patch };
}

function goodIdToken(claimPatch, headerPatch, privateKey) {
  return createToken(baseHeader(headerPatch), baseClaims(claimPatch), privateKey);
}

function validJwks(overrides = {}) {
  return JSON.stringify({
    keys: [{ ...exportedJwk, kid: KID, use: 'sig', alg: 'RS256', ...overrides }],
  });
}

function jwksHarness(configuration = {}) {
  const state = {
    requestCalls: 0,
    httpsReceiver: null,
    options: null,
  };
  const response = new EventEmitter();
  response.statusCode = configuration.statusCode === undefined ? 200 : configuration.statusCode;
  response.headers = configuration.headers || { 'content-type': 'application/json' };
  response.destroy = function destroyResponse() {};
  const request = new EventEmitter();
  request.destroy = function destroyRequest() {};
  request.end = function endRequest() {
    state.responseCallback(response);
    const body = configuration.body === undefined ? validJwks() : configuration.body;
    for (const chunk of configuration.chunks || [Buffer.from(body)]) {
      response.emit('data', chunk);
    }
    response.emit('end');
    response.emit('close');
  };
  const https = frozenRecord({
    request(options, callback) {
      state.httpsReceiver = this;
      state.requestCalls += 1;
      state.options = options;
      state.responseCallback = callback;
      return request;
    },
  });
  const crypto = frozenRecord({
    createPublicKey(input) { return nativeCrypto.createPublicKey(input); },
    verify(...args) { return nativeCrypto.verify(...args); },
  });
  const timers = frozenRecord({
    setTimeout(callback) {
      state.deadline = callback;
      return frozenRecord({ id: 1 });
    },
    clearTimeout() {},
  });
  return {
    dependencies: frozenRecord({ https, crypto, timers }),
    state,
  };
}

function graphFake(spec = {}) {
  const calls = [];
  const timers = {
    setTimeout(callback) {
      return { callback };
    },
    clearTimeout() {},
  };
  const httpsImpl = (options, callback) => {
    if (spec.requestThrows) throw new Error(`graph request ${LEAK}`);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      const call = { options, req };
      calls.push(call);
      if (spec.never) return;
      queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = spec.status === undefined ? 200 : spec.status;
        res.headers = spec.headers || { 'content-type': 'application/json; charset=utf-8' };
        res.destroy = () => {};
        call.res = res;
        callback(res);
        if (spec.onResponse) {
          spec.onResponse({ req, res });
          return;
        }
        const body = spec.body === undefined
          ? JSON.stringify({
            id: PRINCIPAL,
            displayName: 'Ada Lovelace',
            mail: 'Ada@Example.COM',
            userPrincipalName: 'ada@example.com',
          })
          : spec.body;
        for (const chunk of spec.chunks || [Buffer.from(body)]) {
          res.emit('data', chunk);
        }
        if (!spec.noEnd) res.emit('end');
      });
    };
    return req;
  };
  const service = createMicrosoftGraphMeIdentityTransport({ httpsImpl, timers });
  return { service, calls, fetch: service.fetchIdentity };
}

function stubOidc(spec = {}) {
  const calls = [];
  const oidcValidator = Object.freeze({
    async validate(request) {
      calls.push({ request, thisValue: this });
      if (spec.wait) await spec.wait;
      if (spec.throw) throw new Error(`${LEAK} oidc`);
      if (spec.result !== undefined) return spec.result;
      return Object.freeze({
        providerTenantId: TID,
        providerPrincipalId: PRINCIPAL,
      });
    },
  });
  return { oidcValidator, calls };
}

function stubGraph(spec = {}) {
  const calls = [];
  const graphIdentity = Object.freeze({
    async fetchIdentity(request) {
      calls.push({ request, thisValue: this });
      if (spec.wait) await spec.wait;
      if (spec.throw) throw new Error(`${LEAK} graph`);
      if (spec.result !== undefined) return spec.result;
      return Object.freeze({
        providerSubjectId: PRINCIPAL,
        mailboxAddress: 'ada@example.com',
        displayName: 'Ada Lovelace',
      });
    },
  });
  return { graphIdentity, calls };
}

function compositionFromStubs(oidcSpec, graphSpec) {
  const oidc = stubOidc(oidcSpec);
  const graph = stubGraph(graphSpec);
  const composition = createMicrosoftVerifiedIdentityComposition({
    oidcValidator: oidc.oidcValidator,
    graphIdentity: graph.graphIdentity,
  });
  return { composition, oidc, graph };
}

function goodInput(patch = {}) {
  return {
    idToken: goodIdToken(),
    accessToken: ACCESS,
    expectedNonce: NONCE,
    expectedClientId: CLIENT,
    nowEpochSeconds: NOW,
    ...patch,
  };
}

function stubInput(patch = {}) {
  return {
    idToken: 'stub-id-token',
    accessToken: ACCESS,
    expectedNonce: NONCE,
    expectedClientId: CLIENT,
    nowEpochSeconds: NOW,
    ...patch,
  };
}

async function expectSanitizedFailure(action) {
  await assert.rejects(Promise.resolve().then(action), (error) => {
    assert.equal(error.name, 'MicrosoftVerifiedIdentityError');
    assert.equal(error.code, ERROR_CODE);
    assert.equal(error.message, ERROR_MESSAGE);
    assert.equal(Object.isFrozen(error), true);
    assert.deepEqual(Object.keys(error), ['code']);
    assert.equal(String(error).includes(LEAK), false);
    assert.equal(String(error).includes(NONCE), false);
    assert.equal(String(error).includes(ACCESS), false);
    assert.equal(String(error.stack || '').includes(LEAK), false);
    return true;
  });
}

function assertExactOutput(result) {
  assert.deepEqual(result, {
    providerTenantId: TID,
    providerPrincipalId: PRINCIPAL,
    mailboxAddress: 'ada@example.com',
    displayName: 'Ada Lovelace',
  });
  assert.deepEqual(Object.keys(result), [...OUTPUT_KEYS_LOCAL]);
  assert.deepEqual(Reflect.ownKeys(result), [...OUTPUT_KEYS_LOCAL]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal('idToken' in result, false);
  assert.equal('accessToken' in result, false);
  assert.equal('providerSubjectId' in result, false);
  assert.equal('nonce' in result, false);
}

const OUTPUT_KEYS_LOCAL = [
  'providerTenantId',
  'providerPrincipalId',
  'mailboxAddress',
  'displayName',
];

function mergedComposition(jwksConfig = {}, graphSpec = {}) {
  const harness = jwksHarness(jwksConfig);
  const signatureVerifier = createMicrosoftOidcJwksSignatureVerifier(harness.dependencies);
  const oidcValidator = createMicrosoftOidcIdTokenValidator({ signatureVerifier });
  const graph = graphFake(graphSpec);
  const composition = createMicrosoftVerifiedIdentityComposition({
    oidcValidator,
    graphIdentity: graph.service,
  });
  return { composition, harness, graph };
}

// ── Factory / export surface ───────────────────────────────────────────────

test('exports only the frozen factory and fixed error constants', async function exportSurface() {
  const exported = require('./lib/email-microsoft-verified-identity');
  assert.deepEqual(Object.keys(exported), [
    'ERROR_CODE',
    'ERROR_MESSAGE',
    'createMicrosoftVerifiedIdentityComposition',
  ]);
  assert.equal(Object.isFrozen(exported), true);
  assert.equal(exported.ERROR_CODE, 'MICROSOFT_VERIFIED_IDENTITY_INVALID');
  assert.equal(exported.ERROR_MESSAGE, 'Microsoft verified identity validation failed.');
});

test('returns a frozen single-method composition with verifyIdentity', async function frozenCompositionShape() {
  const { composition } = compositionFromStubs();
  assert.deepEqual(Object.keys(composition), ['verifyIdentity']);
  assert.deepEqual(Reflect.ownKeys(composition), ['verifyIdentity']);
  assert.equal(Object.isFrozen(composition), true);
  assert.equal(typeof composition.verifyIdentity, 'function');
});

// ── Happy path: stubs + real merged factories ──────────────────────────────

test('happy path via stubs returns exact ordered frozen minimized identity', async function happyPathStubs() {
  const { composition, oidc, graph } = compositionFromStubs();
  const result = await composition.verifyIdentity(stubInput());
  assertExactOutput(result);
  assert.equal(oidc.calls.length, 1);
  assert.equal(graph.calls.length, 1);
});

test('happy path via real OIDC+JWKS+Graph factories with generated RSA', async function happyPathMergedFactories() {
  const { composition, harness, graph } = mergedComposition();
  const result = await composition.verifyIdentity(goodInput());
  assertExactOutput(result);
  assert.equal(harness.state.requestCalls, 1);
  assert.equal(graph.calls.length, 1);
  assert.equal(
    graph.calls[0].options.headers.Authorization,
    ['Bearer', ACCESS].join(' '),
  );
  assert.deepEqual(harness.state.options.hostname, 'login.microsoftonline.com');
  assert.deepEqual(graph.calls[0].options.hostname, 'graph.microsoft.com');
});

// ── Receivers (owner-preserving) ───────────────────────────────────────────

test('preserves exact oidcValidator and graphIdentity receivers', async function preservesReceivers() {
  const { composition, oidc, graph } = compositionFromStubs();
  await composition.verifyIdentity(stubInput());
  assert.equal(oidc.calls[0].thisValue, oidc.oidcValidator);
  assert.equal(graph.calls[0].thisValue, graph.graphIdentity);
});

// ── Exact shapes passed to dependencies ────────────────────────────────────

test('passes exact OIDC and Graph input shapes only', async function exactDependencyInputs() {
  const { composition, oidc, graph } = compositionFromStubs();
  await composition.verifyIdentity(stubInput());
  assert.deepEqual(Reflect.ownKeys(oidc.calls[0].request), [
    'idToken',
    'expectedNonce',
    'expectedClientId',
    'nowEpochSeconds',
  ]);
  assert.equal(Object.isFrozen(oidc.calls[0].request), true);
  assert.equal('accessToken' in oidc.calls[0].request, false);
  assert.deepEqual(Reflect.ownKeys(graph.calls[0].request), ['accessToken']);
  assert.equal(Object.isFrozen(graph.calls[0].request), true);
  assert.equal(graph.calls[0].request.accessToken, ACCESS);
});

// ── Order: OIDC first, Graph second; no Graph on OIDC failure ──────────────

test('calls OIDC before Graph and never Graph when OIDC fails', async function oidcFirstNoGraphOnOidcFailure() {
  const order = [];
  const oidcValidator = Object.freeze({
    async validate() {
      order.push('oidc');
      throw new Error(`${LEAK} oidc-fail`);
    },
  });
  const graphIdentity = Object.freeze({
    async fetchIdentity() {
      order.push('graph');
      return Object.freeze({
        providerSubjectId: PRINCIPAL,
        mailboxAddress: 'ada@example.com',
        displayName: 'Ada',
      });
    },
  });
  const composition = createMicrosoftVerifiedIdentityComposition({ oidcValidator, graphIdentity });
  await expectSanitizedFailure(() => composition.verifyIdentity(stubInput()));
  assert.deepEqual(order, ['oidc']);
});

test('invokes Graph only after successful OIDC', async function graphAfterSuccessfulOidc() {
  const order = [];
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const oidcValidator = Object.freeze({
    async validate() {
      order.push('oidc-start');
      await waiting;
      order.push('oidc-end');
      return Object.freeze({
        providerTenantId: TID,
        providerPrincipalId: PRINCIPAL,
      });
    },
  });
  const graphIdentity = Object.freeze({
    async fetchIdentity() {
      order.push('graph');
      return Object.freeze({
        providerSubjectId: PRINCIPAL,
        mailboxAddress: 'ada@example.com',
        displayName: 'Ada Lovelace',
      });
    },
  });
  const composition = createMicrosoftVerifiedIdentityComposition({ oidcValidator, graphIdentity });
  const pending = composition.verifyIdentity(stubInput());
  await Promise.resolve();
  assert.deepEqual(order, ['oidc-start']);
  release();
  await pending;
  assert.deepEqual(order, ['oidc-start', 'oidc-end', 'graph']);
});

// ── Principal mismatch ─────────────────────────────────────────────────────

test('rejects OIDC principal vs Graph subject mismatch without leaking either id', async function principalMismatch() {
  const { composition, graph } = compositionFromStubs(
    { result: Object.freeze({ providerTenantId: TID, providerPrincipalId: PRINCIPAL }) },
    {
      result: Object.freeze({
        providerSubjectId: `${PRINCIPAL}-DIFFERENT`,
        mailboxAddress: 'ada@example.com',
        displayName: 'Ada Lovelace',
      }),
    },
  );
  await expectSanitizedFailure(() => composition.verifyIdentity(stubInput()));
  assert.equal(graph.calls.length, 1);
  const mismatched = compositionFromStubs(
    {},
    {
      result: Object.freeze({
        providerSubjectId: 'other-principal',
        mailboxAddress: 'ada@example.com',
        displayName: null,
      }),
    },
  );
  await expectSanitizedFailure(() => mismatched.composition.verifyIdentity(stubInput()));
});

test('merged factories reject principal mismatch after both dependencies succeed', async function mergedPrincipalMismatch() {
  const { composition, graph } = mergedComposition({}, {
    body: JSON.stringify({
      id: 'different-graph-subject',
      displayName: 'Ada Lovelace',
      mail: 'ada@example.com',
      userPrincipalName: 'ada@example.com',
    }),
  });
  await expectSanitizedFailure(() => composition.verifyIdentity(goodInput()));
  assert.equal(graph.calls.length, 1);
});

// ── Dependency / input traps, accessors, symbols ───────────────────────────

test('masks hostile factory dependency traps accessors symbols and extra keys', async function hostileFactoryDeps() {
  const goodOidc = stubOidc().oidcValidator;
  const goodGraph = stubGraph().graphIdentity;
  const hostiles = [
    null,
    undefined,
    [],
    {},
    { oidcValidator: goodOidc },
    { graphIdentity: goodGraph },
    { oidcValidator: goodOidc, graphIdentity: goodGraph, extra: 1 },
    { oidcValidator: {}, graphIdentity: goodGraph },
    { oidcValidator: goodOidc, graphIdentity: {} },
    { oidcValidator: Object.freeze({ validate: 1 }), graphIdentity: goodGraph },
    { oidcValidator: Object.freeze({ validate() {}, extra: 1 }), graphIdentity: goodGraph },
    { oidcValidator: { validate() {} }, graphIdentity: goodGraph }, // not frozen
    { oidcValidator: goodOidc, graphIdentity: { fetchIdentity() {} } },
    { [Symbol('x')]: 1, oidcValidator: goodOidc, graphIdentity: goodGraph },
  ];
  for (const deps of hostiles) {
    assert.throws(
      () => createMicrosoftVerifiedIdentityComposition(deps),
      (error) => error.code === ERROR_CODE && !String(error).includes(LEAK),
    );
  }

  const accessor = {};
  Object.defineProperty(accessor, 'oidcValidator', {
    enumerable: true,
    get() { throw new Error(LEAK); },
  });
  Object.defineProperty(accessor, 'graphIdentity', {
    enumerable: true,
    value: goodGraph,
  });
  assert.throws(
    () => createMicrosoftVerifiedIdentityComposition(accessor),
    (error) => error.code === ERROR_CODE && !String(error).includes(LEAK),
  );

  const proxy = new Proxy({}, {
    getPrototypeOf() { throw new Error(LEAK); },
    ownKeys() { throw new Error(LEAK); },
  });
  assert.throws(
    () => createMicrosoftVerifiedIdentityComposition(proxy),
    (error) => error.code === ERROR_CODE && !String(error).includes(LEAK),
  );
});

test('masks hostile input accessors symbols extra keys and wrong prototypes', async function hostileInputs() {
  const { composition } = compositionFromStubs();
  const badInputs = [
    null,
    undefined,
    [],
    {},
    Object.create(null),
    { ...stubInput(), extra: 1 },
    { idToken: 'x', accessToken: ACCESS, expectedNonce: NONCE, expectedClientId: CLIENT },
    Object.assign(Object.create({ inherited: 1 }), stubInput()),
  ];
  for (const bad of badInputs) {
    const fresh = compositionFromStubs();
    await expectSanitizedFailure(() => fresh.composition.verifyIdentity(bad));
    assert.equal(fresh.oidc.calls.length, 0);
    assert.equal(fresh.graph.calls.length, 0);
  }

  const accessor = {
    accessToken: ACCESS,
    expectedNonce: NONCE,
    expectedClientId: CLIENT,
    nowEpochSeconds: NOW,
  };
  Object.defineProperty(accessor, 'idToken', {
    enumerable: true,
    get() { throw new Error(LEAK); },
  });
  const accessored = compositionFromStubs();
  await expectSanitizedFailure(() => accessored.composition.verifyIdentity(accessor));
  assert.equal(accessored.oidc.calls.length, 0);

  const withSymbol = stubInput();
  Object.defineProperty(withSymbol, Symbol('trap'), { value: LEAK, enumerable: false });
  // Symbol own key makes ownKeys length differ from exact five string keys.
  const symbolled = compositionFromStubs();
  await expectSanitizedFailure(() => symbolled.composition.verifyIdentity(withSymbol));
  assert.equal(symbolled.oidc.calls.length, 0);

  const protoTrap = new Proxy(stubInput(), {
    getPrototypeOf() { throw new Error(LEAK); },
  });
  const proxied = compositionFromStubs();
  await expectSanitizedFailure(() => proxied.composition.verifyIdentity(protoTrap));
  assert.equal(proxied.oidc.calls.length, 0);
});

// ── Mutable outputs and token races ────────────────────────────────────────

test('snapshots tokens before await so post-OIDC input mutation cannot race Graph', async function tokenRaceSnapshot() {
  const mutable = stubInput();
  let graphToken;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const oidcValidator = Object.freeze({
    async validate() {
      mutable.accessToken = `mutated-${LEAK}`;
      mutable.idToken = `mutated-id-${LEAK}`;
      mutable.expectedNonce = 'mutated-nonce';
      mutable.expectedClientId = 'mutated-client';
      mutable.nowEpochSeconds = 0;
      await waiting;
      return Object.freeze({
        providerTenantId: TID,
        providerPrincipalId: PRINCIPAL,
      });
    },
  });
  const graphIdentity = Object.freeze({
    async fetchIdentity(request) {
      graphToken = request.accessToken;
      return Object.freeze({
        providerSubjectId: PRINCIPAL,
        mailboxAddress: 'ada@example.com',
        displayName: 'Ada Lovelace',
      });
    },
  });
  const composition = createMicrosoftVerifiedIdentityComposition({ oidcValidator, graphIdentity });
  const pending = composition.verifyIdentity(mutable);
  await Promise.resolve();
  release();
  const result = await pending;
  assert.equal(graphToken, ACCESS);
  assertExactOutput(result);
});

test('copies dependency outputs so later mutation of returned objects is ignored', async function mutableDependencyOutputs() {
  const oidcMutable = {
    providerTenantId: TID,
    providerPrincipalId: PRINCIPAL,
  };
  const graphMutable = {
    providerSubjectId: PRINCIPAL,
    mailboxAddress: 'ada@example.com',
    displayName: 'Ada Lovelace',
  };
  const oidcValidator = Object.freeze({
    async validate() { return oidcMutable; },
  });
  const graphIdentity = Object.freeze({
    async fetchIdentity() { return graphMutable; },
  });
  const composition = createMicrosoftVerifiedIdentityComposition({ oidcValidator, graphIdentity });
  const pending = composition.verifyIdentity(stubInput());
  const result = await pending;
  oidcMutable.providerTenantId = '00000000-0000-4000-8000-000000000000';
  oidcMutable.providerPrincipalId = LEAK;
  graphMutable.mailboxAddress = 'evil@example.com';
  graphMutable.displayName = LEAK;
  graphMutable.providerSubjectId = LEAK;
  assertExactOutput(result);
  assert.equal(result.mailboxAddress, 'ada@example.com');
  assert.equal(result.displayName, 'Ada Lovelace');
});

test('rejects hostile OIDC or Graph result shapes without leaking', async function hostileResultShapes() {
  const goodOidc = Object.freeze({
    providerTenantId: TID,
    providerPrincipalId: PRINCIPAL,
  });
  const goodGraph = Object.freeze({
    providerSubjectId: PRINCIPAL,
    mailboxAddress: 'ada@example.com',
    displayName: 'Ada Lovelace',
  });
  const oidcHostiles = [
    null,
    Object.freeze({ providerTenantId: TID }),
    Object.freeze({ providerTenantId: TID, providerPrincipalId: PRINCIPAL, extra: 1 }),
    Object.freeze({ providerTenantId: 'NOT-A-UUID', providerPrincipalId: PRINCIPAL }),
    Object.freeze({ providerTenantId: TID, providerPrincipalId: '' }),
  ];
  for (const oidcResult of oidcHostiles) {
    const fresh = compositionFromStubs(
      oidcResult === null ? { throw: true } : { result: oidcResult },
      { result: goodGraph },
    );
    await expectSanitizedFailure(() => fresh.composition.verifyIdentity(stubInput()));
    assert.equal(fresh.graph.calls.length, 0, 'Graph must not run on OIDC result failure');
  }
  const graphHostiles = [
    null,
    Object.freeze({ providerSubjectId: PRINCIPAL, mailboxAddress: 'ada@example.com' }),
    Object.freeze({
      providerSubjectId: PRINCIPAL,
      mailboxAddress: 'ada@example.com',
      displayName: 'Ada',
      extra: LEAK,
    }),
    Object.freeze({
      providerSubjectId: '',
      mailboxAddress: 'ada@example.com',
      displayName: null,
    }),
  ];
  for (const graphResult of graphHostiles) {
    const fresh = compositionFromStubs(
      { result: goodOidc },
      graphResult === null ? { throw: true } : { result: graphResult },
    );
    await expectSanitizedFailure(() => fresh.composition.verifyIdentity(stubInput()));
    assert.equal(fresh.oidc.calls.length, 1);
    assert.equal(fresh.graph.calls.length, 1);
  }
});

// ── Reentrant / concurrent single-use ──────────────────────────────────────

test('burns on first use including invalid input concurrent and reentrant calls', async function singleUseAtomicBurn() {
  const invalid = compositionFromStubs();
  await expectSanitizedFailure(() => invalid.composition.verifyIdentity(null));
  await expectSanitizedFailure(() => invalid.composition.verifyIdentity(stubInput()));
  assert.equal(invalid.oidc.calls.length, 0);
  assert.equal(invalid.graph.calls.length, 0);

  const sequential = compositionFromStubs();
  await sequential.composition.verifyIdentity(stubInput());
  await expectSanitizedFailure(() => sequential.composition.verifyIdentity(stubInput()));
  assert.equal(sequential.oidc.calls.length, 1);
  assert.equal(sequential.graph.calls.length, 1);

  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const concurrent = compositionFromStubs({ wait: waiting });
  const first = concurrent.composition.verifyIdentity(stubInput());
  await expectSanitizedFailure(() => concurrent.composition.verifyIdentity(stubInput()));
  release();
  await first;
  assert.equal(concurrent.oidc.calls.length, 1);
  assert.equal(concurrent.graph.calls.length, 1);

  // Reentrant second call from inside OIDC must already see burned composition.
  let reentrantError = null;
  let outerComposition;
  const reentrantOidc = Object.freeze({
    async validate() {
      try {
        await outerComposition.verifyIdentity(stubInput());
      } catch (error) {
        reentrantError = error;
      }
      return Object.freeze({
        providerTenantId: TID,
        providerPrincipalId: PRINCIPAL,
      });
    },
  });
  const reentrantGraph = stubGraph();
  outerComposition = createMicrosoftVerifiedIdentityComposition({
    oidcValidator: reentrantOidc,
    graphIdentity: reentrantGraph.graphIdentity,
  });
  const reentrantResult = await outerComposition.verifyIdentity(stubInput());
  assertExactOutput(reentrantResult);
  assert.equal(reentrantError && reentrantError.code, ERROR_CODE);
  assert.equal(reentrantGraph.calls.length, 1);
});

// ── Output freeze / minimization ───────────────────────────────────────────

test('output is frozen minimized and key-ordered without token fields', async function outputFreezeMinimization() {
  const { composition } = compositionFromStubs({
    result: Object.freeze({
      providerTenantId: TID,
      providerPrincipalId: PRINCIPAL,
    }),
  }, {
    result: Object.freeze({
      providerSubjectId: PRINCIPAL,
      mailboxAddress: 'ada@example.com',
      displayName: null,
    }),
  });
  const result = await composition.verifyIdentity(stubInput());
  assert.deepEqual(Object.keys(result), OUTPUT_KEYS_LOCAL);
  assert.equal(result.displayName, null);
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => {
    result.providerPrincipalId = LEAK;
  });
  assert.throws(() => {
    result.extra = LEAK;
  });
  assert.equal(result.providerPrincipalId, PRINCIPAL);
  assert.equal('extra' in result, false);
});

// ── Sanitized fixed error from dependency throws ───────────────────────────

test('masks OIDC and Graph throws into one fixed sanitized error', async function sanitizedDependencyErrors() {
  await expectSanitizedFailure(() => compositionFromStubs({ throw: true }).composition.verifyIdentity(stubInput()));
  const graphThrow = compositionFromStubs({}, { throw: true });
  await expectSanitizedFailure(() => graphThrow.composition.verifyIdentity(stubInput()));
  assert.equal(graphThrow.oidc.calls.length, 1);
  assert.equal(graphThrow.graph.calls.length, 1);
});

// ── Merged factory hostility: bad token / bad graph HTTP ───────────────────

test('merged factories fail closed on hostile JWKS signature and never call Graph', async function mergedBadSignatureNoGraph() {
  const { composition, graph } = mergedComposition();
  const badToken = createToken(baseHeader(), baseClaims(), alternatePair.privateKey);
  await expectSanitizedFailure(() => composition.verifyIdentity(goodInput({ idToken: badToken })));
  assert.equal(graph.calls.length, 0);
});

test('merged factories fail closed on Graph HTTP rejection after OIDC success', async function mergedGraphHttpFailure() {
  const { composition, harness, graph } = mergedComposition({}, { status: 401, body: '{"error":"nope"}' });
  await expectSanitizedFailure(() => composition.verifyIdentity(goodInput()));
  assert.equal(harness.state.requestCalls, 1);
  assert.equal(graph.calls.length, 1);
});

test('accepts null displayName from Graph when principals match', async function nullDisplayName() {
  const { composition } = compositionFromStubs({}, {
    result: Object.freeze({
      providerSubjectId: PRINCIPAL,
      mailboxAddress: 'ada@example.com',
      displayName: null,
    }),
  });
  const result = await composition.verifyIdentity(stubInput());
  assert.equal(result.displayName, null);
  assert.deepEqual(Object.keys(result), OUTPUT_KEYS_LOCAL);
});

test('does not log or print secrets during success or failure paths', async function noLogsOrLeaks() {
  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { logged.push(args); };
  console.error = (...args) => { logged.push(args); };
  try {
    const ok = compositionFromStubs();
    await ok.composition.verifyIdentity(stubInput({ accessToken: ACCESS, expectedNonce: NONCE }));
    await expectSanitizedFailure(() => compositionFromStubs({ throw: true }).composition.verifyIdentity(
      stubInput({ accessToken: `${ACCESS}-${LEAK}`, expectedNonce: NONCE }),
    ));
    assert.deepEqual(logged, []);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

async function runTests() {
  for (const { name, run } of tests) {
    await run();
    process.stdout.write(`ok - ${name}\n`);
  }
  process.stdout.write(
    `PASS verify:email-microsoft-verified-identity (${tests.length} named offline tests)\n`,
  );
}

runTests().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
