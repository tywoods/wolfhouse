'use strict';

const assert = require('assert/strict');
const nativeCrypto = require('crypto');
const { EventEmitter } = require('events');
const { createMicrosoftOidcJwksSignatureVerifier } = require('./lib/email-microsoft-oidc-jwks-verifier');
const { createMicrosoftOidcIdTokenValidator } = require('./lib/email-microsoft-oidc-id-token');

const FAILURE_CODE = 'MICROSOFT_OIDC_JWKS_VERIFICATION_FAILED';
const pair = nativeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const alternatePair = nativeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const exportedJwk = pair.publicKey.export({ format: 'jwk' });
const kid = 'offline-key';
const signingInput = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvZmZsaW5lIn0';
const validSignature = nativeCrypto.sign('RSA-SHA256', Buffer.from(signingInput), pair.privateKey);

function frozenRecord(record) {
  return Object.freeze(record);
}

function validJwks(overrides = {}) {
  return JSON.stringify({
    keys: [{ ...exportedJwk, kid, use: 'sig', alg: 'RS256', ...overrides }],
  });
}

function makeHarness(configuration = {}) {
  const state = {
    clearCalls: [],
    requestCalls: 0,
    requestDestroyed: 0,
    responseDestroyed: 0,
    options: null,
    deadline: null,
    responseCallback: null,
  };

  const response = new EventEmitter();
  response.statusCode = configuration.statusCode === undefined ? 200 : configuration.statusCode;
  response.headers = configuration.headers || {
    'content-type': 'application/json',
  };
  response.destroy = function destroyResponse() {
    state.responseDestroyed += 1;
  };

  const request = new EventEmitter();
  request.destroy = function destroyRequest() {
    state.requestDestroyed += 1;
  };
  request.end = function endRequest() {
    if (configuration.endThrows) {
      throw new Error('hostile request end');
    }
    if (configuration.manualResponse) {
      return;
    }
    state.responseCallback(response);
    if (configuration.events) {
      for (const [name, value] of configuration.events) {
        response.emit(name, value);
      }
      return;
    }
    const body = configuration.body === undefined ? validJwks() : configuration.body;
    const chunks = configuration.chunks || [Buffer.from(body)];
    for (const chunk of chunks) {
      response.emit('data', chunk);
    }
    response.emit('end');
    response.emit('close');
  };

  const https = frozenRecord({
    request(options, callback) {
      state.requestCalls += 1;
      state.options = options;
      state.responseCallback = callback;
      if (configuration.requestThrows) {
        throw new Error('hostile request');
      }
      if (configuration.callbackBeforeReturn) {
        callback(response);
      }
      if (configuration.deadlineBeforeReturn) {
        state.deadline();
      }
      return configuration.invalidRequest || request;
    },
  });

  const crypto = configuration.crypto || frozenRecord({
    createPublicKey: nativeCrypto.createPublicKey,
    verify: nativeCrypto.verify,
  });

  const timers = configuration.timers || frozenRecord({
    setTimeout(callback, milliseconds) {
      assert.equal(milliseconds, 5000);
      state.deadline = callback;
      if (configuration.synchronousDeadline) {
        callback();
      }
      if (configuration.timerThrows) {
        throw new Error('hostile timer');
      }
      return configuration.timerHandle || frozenRecord({ id: 1 });
    },
    clearTimeout(handle) {
      state.clearCalls.push(handle);
      if (configuration.clearThrows) {
        throw new Error('hostile clear');
      }
    },
  });

  return {
    dependencies: frozenRecord({ https, crypto, timers }),
    request,
    response,
    state,
  };
}

function verificationRequest(overrides = {}) {
  return frozenRecord({
    signingInput,
    signature: validSignature,
    alg: 'RS256',
    kid,
    ...overrides,
  });
}

async function expectSanitizedFailure(action) {
  await assert.rejects(
    Promise.resolve().then(action),
    (error) => {
      assert.equal(error.name, 'MicrosoftOidcJwksVerificationError');
      assert.equal(error.code, FAILURE_CODE);
      assert.equal(error.message, 'Microsoft OIDC signature verification failed.');
      assert.equal(Object.isFrozen(error), true);
      assert.equal(error.message.includes(signingInput), false);
      return true;
    },
  );
}

async function verifyWith(configuration, input = verificationRequest()) {
  const harness = makeHarness(configuration);
  const verifier = createMicrosoftOidcJwksSignatureVerifier(harness.dependencies);
  return { harness, result: await verifier.verify(input) };
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test('accepts a generated RSA signature and returns an exact sealed acknowledgement', async function acceptsSignature() {
  const { harness, result } = await verifyWith({});
  assert.deepEqual(result, { verified: true });
  assert.equal(Object.isSealed(result), true);
  assert.deepEqual(Reflect.ownKeys(result), ['verified']);
  assert.equal(harness.state.clearCalls.length, 1);
});

test('uses only the fixed Microsoft organizations JWKS destination', async function checksFixedDestination() {
  const { harness } = await verifyWith({});
  assert.deepEqual(harness.state.options, {
    protocol: 'https:',
    hostname: 'login.microsoftonline.com',
    port: 443,
    method: 'GET',
    path: '/organizations/discovery/v2.0/keys',
    headers: { Accept: 'application/json' },
    agent: false,
  });
  assert.equal(Object.isFrozen(harness.state.options), true);
  assert.equal(Object.isFrozen(harness.state.options.headers), true);
});

test('preserves verifier receiver compatibility', async function checksVerifierReceiver() {
  const harness = makeHarness();
  const verifier = createMicrosoftOidcJwksSignatureVerifier(harness.dependencies);
  assert.deepEqual(await Reflect.apply(verifier.verify, verifier, [verificationRequest()]), { verified: true });
});

test('claims single use atomically before reflecting on hostile input', async function claimsSingleUseFirst() {
  const harness = makeHarness();
  const verifier = createMicrosoftOidcJwksSignatureVerifier(harness.dependencies);
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('trap'); } });
  await expectSanitizedFailure(() => verifier.verify(hostile));
  await expectSanitizedFailure(() => verifier.verify(verificationRequest()));
  assert.equal(harness.state.requestCalls, 0);
});

test('rejects altered signing input, signature, algorithm, and kid', async function rejectsAlteredInputs() {
  const cases = [
    verificationRequest({ signingInput: `${signingInput}x` }),
    verificationRequest({ signature: Buffer.from(validSignature).fill(0) }),
    verificationRequest({ alg: 'none' }),
    verificationRequest({ kid: 'other-key' }),
  ];
  for (const input of cases) {
    const harness = makeHarness();
    await expectSanitizedFailure(() => createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(input));
  }
});

test('requires exact frozen dependency records and methods', async function rejectsDependencyShapes() {
  const valid = makeHarness().dependencies;
  const variants = [
    { ...valid },
    frozenRecord({ ...valid, extra: true }),
    frozenRecord({ https: { request() {} }, crypto: valid.crypto, timers: valid.timers }),
    frozenRecord({ https: frozenRecord({ request: 1 }), crypto: valid.crypto, timers: valid.timers }),
    frozenRecord({ https: valid.https, crypto: frozenRecord({ verify() {}, createPublicKey() {}, extra() {} }), timers: valid.timers }),
    frozenRecord({ https: valid.https, crypto: valid.crypto, timers: frozenRecord({ setTimeout() {} }) }),
    frozenRecord(Object.assign(Object.create(null), valid)),
    frozenRecord({ ...valid, [Symbol('hidden')]: true }),
  ];
  const accessor = {};
  Object.defineProperty(accessor, 'https', { enumerable: true, get() { return valid.https; } });
  Object.defineProperty(accessor, 'crypto', { enumerable: true, value: valid.crypto });
  Object.defineProperty(accessor, 'timers', { enumerable: true, value: valid.timers });
  Object.freeze(accessor);
  variants.push(accessor);
  variants.push(new Proxy(valid, { ownKeys() { throw new Error('trap'); } }));
  for (const dependencies of variants) {
    assert.throws(() => createMicrosoftOidcJwksSignatureVerifier(dependencies), { code: FAILURE_CODE });
  }
});

test('requires an exact frozen input with data descriptors and no symbols', async function rejectsInputShapes() {
  const variants = [
    { ...verificationRequest() },
    frozenRecord({ ...verificationRequest(), extra: true }),
    frozenRecord({ ...verificationRequest(), [Symbol('hidden')]: true }),
    frozenRecord(Object.assign(Object.create(null), verificationRequest())),
  ];
  const accessor = { ...verificationRequest() };
  Object.defineProperty(accessor, 'kid', { enumerable: true, get() { return kid; } });
  Object.freeze(accessor);
  variants.push(accessor);
  for (const input of variants) {
    const harness = makeHarness();
    await expectSanitizedFailure(() => createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(input));
  }
});

test('does not start HTTPS when the deadline callback fires synchronously', async function handlesSynchronousDeadline() {
  const harness = makeHarness({ synchronousDeadline: true });
  await expectSanitizedFailure(() => createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest()));
  assert.equal(harness.state.requestCalls, 0);
  assert.equal(harness.state.clearCalls.length, 1);
});

test('does not start HTTPS when timer acquisition throws', async function handlesTimerThrow() {
  const harness = makeHarness({ timerThrows: true });
  await expectSanitizedFailure(() => createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest()));
  assert.equal(harness.state.requestCalls, 0);
  assert.equal(harness.state.clearCalls.length, 0);
});

test('destroys a request acquired after timeout exactly once and clears the timer once', async function destroysLateRequest() {
  const harness = makeHarness({ deadlineBeforeReturn: true });
  await expectSanitizedFailure(() => createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest()));
  assert.equal(harness.state.requestDestroyed, 1);
  assert.equal(harness.state.clearCalls.length, 1);
});

test('destroys a response delivered after timeout', async function destroysLateResponse() {
  const harness = makeHarness({ manualResponse: true });
  const promise = createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest());
  harness.state.deadline();
  harness.state.responseCallback(harness.response);
  await expectSanitizedFailure(() => promise);
  assert.equal(harness.state.requestDestroyed, 1);
  assert.equal(harness.state.responseDestroyed, 1);
  assert.equal(harness.state.clearCalls.length, 1);
});

test('settles once across timeout and duplicate late stream events', async function ignoresLateDuplicates() {
  const harness = makeHarness({ manualResponse: true });
  const promise = createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest());
  harness.state.responseCallback(harness.response);
  harness.state.deadline();
  harness.response.emit('error', new Error('late'));
  harness.response.emit('aborted');
  harness.response.emit('close');
  harness.response.emit('end');
  await expectSanitizedFailure(() => promise);
  assert.equal(harness.state.clearCalls.length, 1);
});

test('accepts only exact 200 and strict JSON content types', async function checksHttpMetadata() {
  const badCases = [
    { statusCode: 201 },
    { statusCode: '200' },
    { headers: { 'content-type': 'text/plain' } },
    { headers: { 'content-type': 'application/json; charset=latin1' } },
    { headers: { 'content-type': ['application/json'] } },
    { headers: {} },
  ];
  for (const configuration of badCases) {
    const harness = makeHarness(configuration);
    await expectSanitizedFailure(() => createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest()));
  }
  await verifyWith({ headers: { 'content-type': 'Application/JSON ; charset=UTF-8' } });
});

test('enforces canonical declared content length and exact received length', async function checksContentLength() {
  const body = validJwks();
  const badLengths = ['65537', '01', '-1', '1.0', `${Buffer.byteLength(body) + 1}`];
  for (const length of badLengths) {
    const harness = makeHarness({ body, headers: { 'content-type': 'application/json', 'content-length': length } });
    await expectSanitizedFailure(() => createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest()));
  }
  await verifyWith({ body, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } });
});

test('rejects non-Buffer chunks and checks the streaming cap before storing', async function checksStreamingCap() {
  for (const chunks of [['not-a-buffer'], [Buffer.alloc(65536), Buffer.alloc(1)]]) {
    const harness = makeHarness({ chunks });
    await expectSanitizedFailure(() => createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest()));
    assert.equal(harness.state.responseDestroyed, 1);
  }
});

test('rejects fatal UTF-8 decoding errors', async function rejectsBadUtf8() {
  const harness = makeHarness({ chunks: [Buffer.from([0xc3, 0x28])] });
  await expectSanitizedFailure(() => createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest()));
});

test('handles request and response failures, aborts, timeouts, premature closes, and throws', async function handlesLifecycleFailures() {
  const cases = [
    { requestThrows: true },
    { endThrows: true },
    { invalidRequest: {} },
    { events: [['error', new Error('response')]] },
    { events: [['aborted']] },
    { events: [['timeout']] },
    { events: [['close']] },
  ];
  for (const configuration of cases) {
    const harness = makeHarness(configuration);
    await expectSanitizedFailure(() => createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest()));
    assert.equal(harness.state.clearCalls.length, 1);
  }

  for (const event of ['error', 'abort', 'timeout', 'close']) {
    const harness = makeHarness({ manualResponse: true });
    const promise = createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest());
    harness.request.emit(event, event === 'error' ? new Error('request') : undefined);
    await expectSanitizedFailure(() => promise);
  }
});

test('rejects duplicate, escaped dangerous, surrogate, depth, and collection JSON attacks', async function rejectsHostileJson() {
  const deep = `${'{"a":'.repeat(12)}0${'}'.repeat(12)}`;
  const largeArray = JSON.stringify({ keys: Array.from({ length: 65 }, () => null) });
  const largeObject = `{${Array.from({ length: 65 }, (_, index) => `"x${index}":0`).join(',')}}`;
  const bodies = [
    '{"keys":[],"keys":[]}',
    '{"keys":[{"kid":"offline-key","\\u005f_proto__":1}]}',
    '{"keys":[{"kid":"offline-key","constructor":1}]}',
    '{"keys":[{"kid":"\\ud800"}]}',
    deep,
    largeArray,
    largeObject,
  ];
  for (const body of bodies) {
    const harness = makeHarness({ body });
    await expectSanitizedFailure(() => createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest()));
  }
});

test('requires one and only one matching bounded JWKS key', async function checksKeySelection() {
  const duplicate = JSON.stringify({ keys: [
    { ...exportedJwk, kid, use: 'sig' },
    { ...exportedJwk, kid, use: 'sig' },
  ] });
  const tooMany = JSON.stringify({ keys: Array.from({ length: 65 }, (_, index) => ({ ...exportedJwk, kid: `k${index}` })) });
  const bodies = [JSON.stringify({ keys: [] }), duplicate, tooMany, JSON.stringify({ keys: [{ ...exportedJwk, kid: 'other' }] })];
  for (const body of bodies) {
    const harness = makeHarness({ body });
    await expectSanitizedFailure(() => createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest()));
  }
});

test('requires RSA signing RS256 key metadata', async function checksKeyMetadata() {
  const variants = [
    { kty: 'EC' },
    { use: 'enc' },
    { alg: 'RS512' },
  ];
  for (const overrides of variants) {
    const harness = makeHarness({ body: validJwks(overrides) });
    await expectSanitizedFailure(() => createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest()));
  }
});

test('rejects noncanonical or malformed modulus and exponent parameters', async function checksRsaParameters() {
  const evenModulus = Buffer.from(exportedJwk.n, 'base64url');
  evenModulus[evenModulus.length - 1] &= 0xfe;
  const shortModulus = Buffer.alloc(255, 0xff).toString('base64url');
  const lowModulus = Buffer.concat([Buffer.from([0x7f]), Buffer.alloc(255, 0xff)]).toString('base64url');
  const variants = [
    { n: '' },
    { n: `${exportedJwk.n}=` },
    { n: shortModulus },
    { n: lowModulus },
    { n: evenModulus.toString('base64url') },
    { e: '' },
    { e: Buffer.from([0, 3]).toString('base64url') },
    { e: Buffer.from([2]).toString('base64url') },
    { e: Buffer.from([1]).toString('base64url') },
    { e: Buffer.alloc(5, 1).toString('base64url') },
  ];
  for (const overrides of variants) {
    const harness = makeHarness({ body: validJwks(overrides) });
    await expectSanitizedFailure(() => createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest()));
  }
});

test('passes only selected JWK fields and exact bytes to native-shaped crypto methods', async function checksCryptoArguments() {
  let publicKeyArgument;
  let verifyArguments;
  const crypto = frozenRecord({
    createPublicKey(argument) {
      publicKeyArgument = argument;
      return pair.publicKey;
    },
    verify(...args) {
      verifyArguments = args;
      return true;
    },
  });
  const harness = makeHarness({ body: validJwks({ unknown: 'discard-me' }), crypto });
  const result = await createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest());
  assert.deepEqual(result, { verified: true });
  assert.deepEqual(Reflect.ownKeys(publicKeyArgument.key), ['kty', 'n', 'e', 'alg', 'use', 'kid']);
  assert.equal(publicKeyArgument.key.unknown, undefined);
  assert.deepEqual({ ...publicKeyArgument, key: undefined }, { key: undefined, format: 'jwk' });
  assert.equal(verifyArguments[0], 'RSA-SHA256');
  assert.deepEqual(verifyArguments[1], Buffer.from(signingInput));
  assert.equal(verifyArguments[2], pair.publicKey);
  assert.equal(verifyArguments[3], validSignature);
});

test('requires crypto verification to return strict true', async function checksStrictTrue() {
  const crypto = frozenRecord({
    createPublicKey() { return pair.publicKey; },
    verify() { return 1; },
  });
  const harness = makeHarness({ crypto });
  await expectSanitizedFailure(() => createMicrosoftOidcJwksSignatureVerifier(harness.dependencies).verify(verificationRequest()));
});

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createToken(header, claims, privateKey = pair.privateKey) {
  const encodedHeader = encodeJson(header);
  const encodedClaims = encodeJson(claims);
  const input = `${encodedHeader}.${encodedClaims}`;
  const signature = nativeCrypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${signature}`;
}

function validatorFor(configuration = {}) {
  const harness = makeHarness(configuration);
  const signatureVerifier = createMicrosoftOidcJwksSignatureVerifier(harness.dependencies);
  return createMicrosoftOidcIdTokenValidator({ signatureVerifier });
}

test('verifies a generated RSA token through the merged ID token validator', async function checksValidatorEndToEnd() {
  const now = 1900000000;
  const tenant = '01234567-89ab-4def-8123-456789abcdef';
  const nonce = 'offline-nonce';
  const client = 'offline-client';
  const header = { alg: 'RS256', kid, typ: 'JWT' };
  const claims = {
    tid: tenant,
    oid: 'principal',
    sub: 'subject',
    aud: client,
    nonce,
    iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
    exp: now + 600,
    iat: now - 1,
    nbf: now - 1,
  };
  const input = { expectedNonce: nonce, expectedClientId: client, nowEpochSeconds: now };
  const result = await validatorFor().validate({ idToken: createToken(header, claims), ...input });
  assert.deepEqual(result, { providerTenantId: tenant, providerPrincipalId: 'principal' });

  const hostileTokens = [
    createToken({ ...header, alg: 'none' }, claims),
    createToken({ ...header, kid: 'other' }, claims),
    createToken(header, { ...claims, aud: 'wrong-client' }),
    createToken(header, { ...claims, nonce: 'wrong-nonce' }),
    createToken(header, claims, alternatePair.privateKey),
  ];
  for (const idToken of hostileTokens) {
    await assert.rejects(
      validatorFor().validate({ idToken, ...input }),
      { code: 'MICROSOFT_OIDC_ID_TOKEN_INVALID' },
    );
  }

  await assert.rejects(
    validatorFor({ body: validJwks({ n: alternatePair.publicKey.export({ format: 'jwk' }).n }) })
      .validate({ idToken: createToken(header, claims), ...input }),
    { code: 'MICROSOFT_OIDC_ID_TOKEN_INVALID' },
  );
});

async function runTests() {
  for (const { name, run } of tests) {
    await run();
    process.stdout.write(`ok - ${name}\n`);
  }
  process.stdout.write(`PASS verify:email-microsoft-oidc-jwks-verifier (${tests.length} named offline tests)\n`);
}

runTests().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
