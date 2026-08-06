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
const {
  createEmailOAuthStageTelemetry,
} = require('./lib/email-microsoft-oauth-stage-telemetry');

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
  const composition = createMicrosoftVerifiedIdentityComposition(Object.freeze({
    oidcValidator: oidc.oidcValidator,
    graphIdentity: graph.graphIdentity,
  }));
  return { composition, oidc, graph };
}

function goodInput(patch = {}) {
  return Object.freeze({
    idToken: goodIdToken(),
    accessToken: ACCESS,
    expectedNonce: NONCE,
    expectedClientId: CLIENT,
    nowEpochSeconds: NOW,
    ...patch,
  });
}

function stubInput(patch = {}) {
  return Object.freeze({
    idToken: 'stub-id-token',
    accessToken: ACCESS,
    expectedNonce: NONCE,
    expectedClientId: CLIENT,
    nowEpochSeconds: NOW,
    ...patch,
  });
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

const OUTPUT_KEYS_LOCAL = [
  'providerTenantId',
  'providerPrincipalId',
  'mailboxAddress',
  'displayName',
];

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

function mergedComposition(jwksConfig = {}, graphSpec = {}) {
  const harness = jwksHarness(jwksConfig);
  const signatureVerifier = createMicrosoftOidcJwksSignatureVerifier(harness.dependencies);
  const oidcValidator = createMicrosoftOidcIdTokenValidator({ signatureVerifier });
  const graph = graphFake(graphSpec);
  const composition = createMicrosoftVerifiedIdentityComposition(Object.freeze({
    oidcValidator,
    graphIdentity: graph.service,
  }));
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

test('passes exact OIDC and Graph input shapes only from one snapshot', async function exactDependencyInputs() {
  const { composition, oidc, graph } = compositionFromStubs();
  const input = stubInput();
  await composition.verifyIdentity(input);
  assert.deepEqual(Reflect.ownKeys(oidc.calls[0].request), [
    'idToken',
    'expectedNonce',
    'expectedClientId',
    'nowEpochSeconds',
  ]);
  assert.equal(Object.isFrozen(oidc.calls[0].request), true);
  assert.equal('accessToken' in oidc.calls[0].request, false);
  assert.equal(oidc.calls[0].request.idToken, input.idToken);
  assert.equal(oidc.calls[0].request.expectedNonce, input.expectedNonce);
  assert.equal(oidc.calls[0].request.expectedClientId, input.expectedClientId);
  assert.equal(oidc.calls[0].request.nowEpochSeconds, input.nowEpochSeconds);
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
  const composition = createMicrosoftVerifiedIdentityComposition(Object.freeze({
    oidcValidator,
    graphIdentity,
  }));
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
  const composition = createMicrosoftVerifiedIdentityComposition(Object.freeze({
    oidcValidator,
    graphIdentity,
  }));
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

// ── Frozen contract: outer deps, input, each child output ──────────────────

test('rejects unfrozen outer dependencies bag even when children are frozen', async function unfrozenOuterDependencies() {
  const oidc = stubOidc();
  const graph = stubGraph();
  const unfrozen = {
    oidcValidator: oidc.oidcValidator,
    graphIdentity: graph.graphIdentity,
  };
  assert.equal(Object.isFrozen(unfrozen), false);
  assert.throws(
    () => createMicrosoftVerifiedIdentityComposition(unfrozen),
    (error) => error.code === ERROR_CODE && !String(error).includes(LEAK),
  );
});

test('rejects unfrozen top-level input without calling either child', async function unfrozenTopLevelInput() {
  const { composition, oidc, graph } = compositionFromStubs();
  const unfrozen = {
    idToken: 'stub-id-token',
    accessToken: ACCESS,
    expectedNonce: NONCE,
    expectedClientId: CLIENT,
    nowEpochSeconds: NOW,
  };
  assert.equal(Object.isFrozen(unfrozen), false);
  await expectSanitizedFailure(() => composition.verifyIdentity(unfrozen));
  assert.equal(oidc.calls.length, 0);
  assert.equal(graph.calls.length, 0);
});

test('rejects unfrozen OIDC child result without calling Graph', async function unfrozenOidcChildResult() {
  const unfrozenOidc = {
    providerTenantId: TID,
    providerPrincipalId: PRINCIPAL,
  };
  assert.equal(Object.isFrozen(unfrozenOidc), false);
  const fresh = compositionFromStubs(
    { result: unfrozenOidc },
    {
      result: Object.freeze({
        providerSubjectId: PRINCIPAL,
        mailboxAddress: 'ada@example.com',
        displayName: 'Ada Lovelace',
      }),
    },
  );
  await expectSanitizedFailure(() => fresh.composition.verifyIdentity(stubInput()));
  assert.equal(fresh.oidc.calls.length, 1);
  assert.equal(fresh.graph.calls.length, 0);
});

test('rejects unfrozen Graph child result sanitized', async function unfrozenGraphChildResult() {
  const unfrozenGraph = {
    providerSubjectId: PRINCIPAL,
    mailboxAddress: 'ada@example.com',
    displayName: 'Ada Lovelace',
  };
  assert.equal(Object.isFrozen(unfrozenGraph), false);
  const fresh = compositionFromStubs(
    {
      result: Object.freeze({
        providerTenantId: TID,
        providerPrincipalId: PRINCIPAL,
      }),
    },
    { result: unfrozenGraph },
  );
  await expectSanitizedFailure(() => fresh.composition.verifyIdentity(stubInput()));
  assert.equal(fresh.oidc.calls.length, 1);
  assert.equal(fresh.graph.calls.length, 1);
});

// ── Malformed snapshotted input: zero child calls ──────────────────────────

test('rejects malformed snapshotted input bounds with zero child calls', async function malformedInputZeroChildCalls() {
  const cases = [
    stubInput({ idToken: '' }),
    stubInput({ idToken: 'x'.repeat(32769) }),
    stubInput({ idToken: 'has\nnewline' }),
    stubInput({ accessToken: '' }),
    stubInput({ accessToken: 'x'.repeat(16385) }),
    stubInput({ accessToken: 'has space' }),
    stubInput({ accessToken: 'has\ttab' }),
    stubInput({ expectedNonce: '' }),
    stubInput({ expectedNonce: 'n'.repeat(513) }),
    stubInput({ expectedNonce: 'bad\nnonce' }),
    stubInput({ expectedClientId: '' }),
    stubInput({ expectedClientId: 'c'.repeat(257) }),
    stubInput({ nowEpochSeconds: -1 }),
    stubInput({ nowEpochSeconds: 1.5 }),
    stubInput({ nowEpochSeconds: Number.MAX_SAFE_INTEGER + 1 }),
  ];
  for (const bad of cases) {
    const fresh = compositionFromStubs();
    await expectSanitizedFailure(() => fresh.composition.verifyIdentity(bad));
    assert.equal(fresh.oidc.calls.length, 0, 'OIDC must not run on malformed input');
    assert.equal(fresh.graph.calls.length, 0, 'Graph must not run on malformed input');
  }
});

// ── Mailbox Graph contract: malformed / uppercase / space / no-domain ──────

test('rejects malformed uppercase space and no-domain Graph mailbox addresses', async function mailboxContractHostiles() {
  const mailboxes = [
    'not-an-email',
    'Ada@Example.COM', // uppercase noncanonical — composer must not case-fold
    ' ada@example.com', // leading space
    'ada@example.com ', // trailing space
    'ada@example.com', // wait this is valid - skip
    'ada example@example.com', // internal space
    'ada@', // no domain
    'ada@localhost', // no-dot domain (Graph regex requires a dot label)
    'ada@example', // single label domain
    'ada@@example.com',
    'ada@ex..ample.com',
    '',
    'a@b', // too short / no multi-label domain
  ];
  // Filter to only invalid ones for the loop clarity
  const invalid = [
    'not-an-email',
    'Ada@Example.COM',
    ' ada@example.com',
    'ada@example.com ',
    'ada example@example.com',
    'ada@',
    'ada@localhost',
    'ada@example',
    'ada@@example.com',
    'ada@ex..ample.com',
    '',
    'a@b',
  ];
  for (const mailboxAddress of invalid) {
    const fresh = compositionFromStubs(
      {
        result: Object.freeze({
          providerTenantId: TID,
          providerPrincipalId: PRINCIPAL,
        }),
      },
      {
        result: Object.freeze({
          providerSubjectId: PRINCIPAL,
          mailboxAddress,
          displayName: 'Ada Lovelace',
        }),
      },
    );
    await expectSanitizedFailure(() => fresh.composition.verifyIdentity(stubInput()));
    assert.equal(fresh.oidc.calls.length, 1);
    assert.equal(fresh.graph.calls.length, 1);
  }
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
    Object.freeze({ oidcValidator: goodOidc }),
    Object.freeze({ graphIdentity: goodGraph }),
    Object.freeze({ oidcValidator: goodOidc, graphIdentity: goodGraph, extra: 1 }),
    Object.freeze({ oidcValidator: {}, graphIdentity: goodGraph }),
    Object.freeze({ oidcValidator: goodOidc, graphIdentity: {} }),
    Object.freeze({ oidcValidator: Object.freeze({ validate: 1 }), graphIdentity: goodGraph }),
    Object.freeze({ oidcValidator: Object.freeze({ validate() {}, extra: 1 }), graphIdentity: goodGraph }),
    Object.freeze({ oidcValidator: { validate() {} }, graphIdentity: goodGraph }), // child not frozen
    Object.freeze({ oidcValidator: goodOidc, graphIdentity: { fetchIdentity() {} } }),
    Object.freeze({ [Symbol('x')]: 1, oidcValidator: goodOidc, graphIdentity: goodGraph }),
    // unfrozen bag with good children
    { oidcValidator: goodOidc, graphIdentity: goodGraph },
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
    () => createMicrosoftVerifiedIdentityComposition(Object.freeze(accessor)),
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
  const badInputs = [
    null,
    undefined,
    [],
    {},
    Object.create(null),
    Object.freeze({ ...{
      idToken: 'stub-id-token',
      accessToken: ACCESS,
      expectedNonce: NONCE,
      expectedClientId: CLIENT,
      nowEpochSeconds: NOW,
      extra: 1,
    } }),
    Object.freeze({
      idToken: 'x',
      accessToken: ACCESS,
      expectedNonce: NONCE,
      expectedClientId: CLIENT,
    }),
    Object.assign(Object.create({ inherited: 1 }), {
      idToken: 'stub-id-token',
      accessToken: ACCESS,
      expectedNonce: NONCE,
      expectedClientId: CLIENT,
      nowEpochSeconds: NOW,
    }),
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
  await expectSanitizedFailure(() => accessored.composition.verifyIdentity(Object.freeze(accessor)));
  assert.equal(accessored.oidc.calls.length, 0);

  const withSymbol = {
    idToken: 'stub-id-token',
    accessToken: ACCESS,
    expectedNonce: NONCE,
    expectedClientId: CLIENT,
    nowEpochSeconds: NOW,
  };
  Object.defineProperty(withSymbol, Symbol('trap'), { value: LEAK, enumerable: false });
  const symbolled = compositionFromStubs();
  await expectSanitizedFailure(() => symbolled.composition.verifyIdentity(Object.freeze(withSymbol)));
  assert.equal(symbolled.oidc.calls.length, 0);

  const protoTrap = new Proxy(stubInput(), {
    getPrototypeOf() { throw new Error(LEAK); },
  });
  const proxied = compositionFromStubs();
  await expectSanitizedFailure(() => proxied.composition.verifyIdentity(protoTrap));
  assert.equal(proxied.oidc.calls.length, 0);
});

// ── Hostile result shapes (including unfrozen already covered above) ───────

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
  outerComposition = createMicrosoftVerifiedIdentityComposition(Object.freeze({
    oidcValidator: reentrantOidc,
    graphIdentity: reentrantGraph.graphIdentity,
  }));
  const reentrantResult = await outerComposition.verifyIdentity(stubInput());
  assertExactOutput(reentrantResult);
  assert.equal(reentrantError && reentrantError.code, ERROR_CODE);
  assert.equal(reentrantGraph.calls.length, 1);
});

// ── Output freeze / minimization + nullable displayName ────────────────────

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
  assert.equal(Object.isFrozen(result), true);
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

// ── Lone-surrogate principal collision defenses ────────────────────────────

const GOOD_MAILBOX = 'ada@example.com';

function graphResult(subjectId, displayName = 'Ada Lovelace') {
  return Object.freeze({
    providerSubjectId: subjectId,
    mailboxAddress: GOOD_MAILBOX,
    displayName,
  });
}

function oidcResult(principalId = PRINCIPAL) {
  return Object.freeze({
    providerTenantId: TID,
    providerPrincipalId: principalId,
  });
}

test('rejects Graph providerSubjectId with lone high/low surrogates in all positions', async function loneSurrogatePositionsReject() {
  // Lone high (U+D800..U+DBFF) and lone low (U+DC00..U+DFFF) at start/middle/end.
  const specimens = [
    '\uD800', // lone high alone
    '\uDBFF', // lone high upper bound
    '\uDC00', // lone low alone
    '\uDFFF', // lone low upper bound
    `\uD800${PRINCIPAL}`, // high at start
    `${PRINCIPAL}\uD800`, // high at end
    `${PRINCIPAL.slice(0, 4)}\uD800${PRINCIPAL.slice(4)}`, // high in middle
    `\uDC00${PRINCIPAL}`, // low at start
    `${PRINCIPAL}\uDC00`, // low at end
    `${PRINCIPAL.slice(0, 4)}\uDC00${PRINCIPAL.slice(4)}`, // low in middle
  ];
  for (const subject of specimens) {
    const fresh = compositionFromStubs(
      { result: oidcResult(PRINCIPAL) },
      { result: graphResult(subject) },
    );
    await expectSanitizedFailure(() => fresh.composition.verifyIdentity(stubInput()));
    assert.equal(fresh.oidc.calls.length, 1);
    assert.equal(fresh.graph.calls.length, 1);
  }
});

test('rejects Graph providerSubjectId with malformed adjacent surrogate sequences', async function malformedAdjacentSurrogatesReject() {
  const specimens = [
    '\uD800\uD800', // high + high
    '\uDC00\uDC00', // low + low
    '\uDC00\uD800', // low + high (wrong order)
    '\uD800\uD800\uDC00', // high + valid-looking pair starting mid-sequence
    '\uD83D\uD800', // high + high (emoji high without its low)
    '\uDE00', // lone low half of an emoji
    `${PRINCIPAL}\uD800\uDBFF`, // trailing double high
    `\uDC00\uDFFF${PRINCIPAL}`, // leading double low
  ];
  for (const subject of specimens) {
    const fresh = compositionFromStubs(
      { result: oidcResult(PRINCIPAL) },
      { result: graphResult(subject) },
    );
    await expectSanitizedFailure(() => fresh.composition.verifyIdentity(stubInput()));
    assert.equal(fresh.graph.calls.length, 1);
  }
});

test('rejects explicit OIDC U+FFFD vs Graph lone-high collision without false match', async function fffdVsLoneHighCollisionRejects() {
  // Node Buffer.from maps lone high surrogates to U+FFFD UTF-8 bytes; a naive
  // UTF-8 compare would treat Graph '\uD800' as matching OIDC '\uFFFD'.
  const oidcReplacement = '\uFFFD';
  const graphLoneHigh = '\uD800';
  assert.deepEqual(
    Buffer.from(graphLoneHigh, 'utf8'),
    Buffer.from(oidcReplacement, 'utf8'),
    'precondition: Buffer collapses lone high to U+FFFD bytes',
  );

  const fresh = compositionFromStubs(
    { result: oidcResult(oidcReplacement) },
    { result: graphResult(graphLoneHigh) },
  );
  await expectSanitizedFailure(() => fresh.composition.verifyIdentity(stubInput()));
  assert.equal(fresh.oidc.calls.length, 1);
  assert.equal(fresh.graph.calls.length, 1);

  // Also reject lone low colliding the same way.
  const graphLoneLow = '\uDC00';
  assert.deepEqual(Buffer.from(graphLoneLow, 'utf8'), Buffer.from(oidcReplacement, 'utf8'));
  const lowCase = compositionFromStubs(
    { result: oidcResult(oidcReplacement) },
    { result: graphResult(graphLoneLow) },
  );
  await expectSanitizedFailure(() => lowCase.composition.verifyIdentity(stubInput()));
  assert.equal(lowCase.graph.calls.length, 1);

  // When both sides genuinely share U+FFFD (no surrogates), match remains allowed.
  const genuine = compositionFromStubs(
    { result: oidcResult(oidcReplacement) },
    { result: graphResult(oidcReplacement) },
  );
  const matched = await genuine.composition.verifyIdentity(stubInput());
  assert.equal(matched.providerPrincipalId, oidcReplacement);
  assert.equal(Object.isFrozen(matched), true);
});

test('accepts valid surrogate-pair and emoji principals when both children agree', async function validSurrogatePairsAndEmojiAccepted() {
  const emoji = '😀'; // U+1F600 = \uD83D\uDE00 (valid pair)
  const mixed = `id-${emoji}-ok`;
  for (const principal of [emoji, mixed, 'café-ascii-safe']) {
    // café uses no surrogates; included as control that non-ASCII non-surrogate still works.
    if (principal === 'café-ascii-safe') {
      // OIDC principal uses boundedOidcText which allows non-ASCII without unpaired surrogates.
    }
    const fresh = compositionFromStubs(
      { result: oidcResult(principal) },
      { result: graphResult(principal) },
    );
    const result = await fresh.composition.verifyIdentity(stubInput());
    assert.equal(result.providerPrincipalId, principal);
    assert.equal(result.mailboxAddress, GOOD_MAILBOX);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(fresh.oidc.calls.length, 1);
    assert.equal(fresh.graph.calls.length, 1);
  }

  // Valid pair on Graph but different OIDC principal still mismatches (no false match).
  const mismatch = compositionFromStubs(
    { result: oidcResult(PRINCIPAL) },
    { result: graphResult(emoji) },
  );
  await expectSanitizedFailure(() => mismatch.composition.verifyIdentity(stubInput()));
});

// ── Graph mail ≠ UPN: prefer mail; stage graph_identity_verified ───────────

const REALISTIC_SMTP = 'support@lunafrontdesk.com';
const REALISTIC_UPN = 'support@lunafrontdesk.onmicrosoft.com';

test('merged factories prefer Graph mail over differing valid UPN and emit graph_identity_verified', async function mailDiffersFromUpnReachesVerified() {
  // Live GoDaddy/M365 shape: primary SMTP (mail) and login UPN both valid, not equal.
  // Identity selection must prefer mail; OIDC oid == Graph id still binds principal.
  assert.notEqual(REALISTIC_SMTP, REALISTIC_UPN);
  const stages = [];
  const stageTelemetry = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5',
    logger(event) { stages.push(event.stage); },
  }));
  const harness = jwksHarness();
  const signatureVerifier = createMicrosoftOidcJwksSignatureVerifier(harness.dependencies);
  const oidcValidator = createMicrosoftOidcIdTokenValidator({ signatureVerifier });
  const graph = graphFake({
    body: JSON.stringify({
      id: PRINCIPAL,
      displayName: 'Luna Support',
      mail: 'Support@LunaFrontDesk.COM',
      userPrincipalName: REALISTIC_UPN,
    }),
  });
  const composition = createMicrosoftVerifiedIdentityComposition(Object.freeze({
    oidcValidator,
    graphIdentity: graph.service,
    stageTelemetry,
  }));
  const result = await composition.verifyIdentity(goodInput());
  assert.deepEqual(result, {
    providerTenantId: TID,
    providerPrincipalId: PRINCIPAL,
    mailboxAddress: REALISTIC_SMTP,
    displayName: 'Luna Support',
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(graph.calls.length, 1);
  assert.deepEqual(stages, ['oidc_verified', 'graph_identity_verified']);
  // Downstream installer ownership: only this mailboxAddress binds public_address.
  assert.equal(result.mailboxAddress, REALISTIC_SMTP);
  assert.notEqual(result.mailboxAddress, REALISTIC_UPN);
});

test('merged factories use UPN when mail absent; still reach graph_identity_verified', async function mailAbsentUsesUpn() {
  const stages = [];
  const stageTelemetry = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5',
    logger(event) { stages.push(event.stage); },
  }));
  const harness = jwksHarness();
  const signatureVerifier = createMicrosoftOidcJwksSignatureVerifier(harness.dependencies);
  const oidcValidator = createMicrosoftOidcIdTokenValidator({ signatureVerifier });
  const graph = graphFake({
    body: JSON.stringify({
      id: PRINCIPAL,
      displayName: 'Luna Support',
      mail: null,
      userPrincipalName: REALISTIC_UPN,
    }),
  });
  const composition = createMicrosoftVerifiedIdentityComposition(Object.freeze({
    oidcValidator,
    graphIdentity: graph.service,
    stageTelemetry,
  }));
  const result = await composition.verifyIdentity(goodInput());
  assert.equal(result.mailboxAddress, REALISTIC_UPN);
  assert.deepEqual(stages, ['oidc_verified', 'graph_identity_verified']);
});

test('merged factories fail closed on malformed mail with valid UPN before graph_identity_verified', async function malformedMailBlocksVerified() {
  const stages = [];
  const stageTelemetry = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5',
    logger(event) { stages.push(event.stage); },
  }));
  const harness = jwksHarness();
  const signatureVerifier = createMicrosoftOidcJwksSignatureVerifier(harness.dependencies);
  const oidcValidator = createMicrosoftOidcIdTokenValidator({ signatureVerifier });
  const graph = graphFake({
    body: JSON.stringify({
      id: PRINCIPAL,
      displayName: 'Luna Support',
      mail: 'not-an-email',
      userPrincipalName: REALISTIC_UPN,
    }),
  });
  const composition = createMicrosoftVerifiedIdentityComposition(Object.freeze({
    oidcValidator,
    graphIdentity: graph.service,
    stageTelemetry,
  }));
  await expectSanitizedFailure(() => composition.verifyIdentity(goodInput()));
  assert.deepEqual(stages, ['oidc_verified']);
  assert.equal(stages.includes('graph_identity_verified'), false);
});

test('merged factories fail closed on malformed UPN with valid mail before graph_identity_verified', async function malformedUpnBlocksVerified() {
  const stages = [];
  const stageTelemetry = createEmailOAuthStageTelemetry(Object.freeze({
    requestId: 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5',
    logger(event) { stages.push(event.stage); },
  }));
  const harness = jwksHarness();
  const signatureVerifier = createMicrosoftOidcJwksSignatureVerifier(harness.dependencies);
  const oidcValidator = createMicrosoftOidcIdTokenValidator({ signatureVerifier });
  const graph = graphFake({
    body: JSON.stringify({
      id: PRINCIPAL,
      displayName: 'Luna Support',
      mail: REALISTIC_SMTP,
      userPrincipalName: 'not-an-email',
    }),
  });
  const composition = createMicrosoftVerifiedIdentityComposition(Object.freeze({
    oidcValidator,
    graphIdentity: graph.service,
    stageTelemetry,
  }));
  await expectSanitizedFailure(() => composition.verifyIdentity(goodInput()));
  assert.deepEqual(stages, ['oidc_verified']);
  assert.equal(stages.includes('graph_identity_verified'), false);
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
