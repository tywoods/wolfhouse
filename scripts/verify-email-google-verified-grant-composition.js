'use strict';

/**
 * RED-only, offline specification for the complete Google verified-grant chain.
 * The missing owner must only compose the three already-merged cryptographic
 * children; it must not acquire credentials, exchange tokens, or own one-shot
 * state independently of delegated custody.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nativeCrypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const {
  parseGrantEnvelopeAadV1,
  validateGrantEnvelopeRecordV1,
} = require('./lib/email-grant-envelope-provider-contract');
const { CONFIG_KEYS, GOOGLE_PHASE_A_SCOPES } = require('./lib/email-google-verified-grant-custody');

// Authentic RED: this is the sole missing production artifact for GREEN.
const compositionOwner = require('./lib/email-google-verified-grant-composition');
const { createGoogleVerifiedGrantComposition } = compositionOwner;

const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENDPOINT = '11111111-2222-4333-8444-555555555555';
const OPERATION = '99999999-8888-4777-8666-555555555555';
const ACTOR = 'abcdef01-2345-4678-89ab-cdef01234567';
const NONCE = 'google-nonce-secret-never-log';
const OAUTH_CLIENT = 'google-confidential-web-client';
const ACCESS = 'google-access-secret-never-output';
const REFRESH = 'google-refresh-secret-never-output';
const SUBJECT = 'Google-Sub_123:CaseSensitive';
const EMAIL = 'Owner.Case+Grant@Example.COM';
const DISPLAY = 'Owner Case';
const NOW = 1_900_000_000;
const KID = 'offline-google-key';
const LEAK = 'hostile-child-secret-never-log';
const SCOPE = GOOGLE_PHASE_A_SCOPES.join(' ');
const pair = nativeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherPair = nativeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = pair.publicKey.export({ format: 'jwk' });
const atHash = value => nativeCrypto.createHash('sha256').update(value, 'ascii').digest().subarray(0, 16).toString('base64url');
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function config(patch = {}) {
  return Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    operationId: OPERATION,
    actorStaffUserId: ACTOR,
    expectedNonce: NONCE,
    expectedClientId: OAUTH_CLIENT,
    ...patch,
  });
}
function signedToken(claimPatch = {}, signingPair = pair, headerPatch = {}) {
  const header = { alg: 'RS256', kid: KID, typ: 'JWT', ...headerPatch };
  const claims = {
    iss: 'https://accounts.google.com', aud: OAUTH_CLIENT, sub: SUBJECT,
    email: EMAIL, email_verified: true, nonce: NONCE, name: DISPLAY,
    exp: NOW + 600, iat: NOW - 10, at_hash: atHash(ACCESS), ...claimPatch,
  };
  const signingInput = `${b64(header)}.${b64(claims)}`;
  const signature = nativeCrypto.sign('RSA-SHA256', Buffer.from(signingInput), signingPair.privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}
function selected(patch = {}) {
  return Object.freeze({
    accessToken: ACCESS,
    refreshToken: REFRESH,
    tokenType: 'Bearer',
    expiresIn: 3600,
    scope: SCOPE,
    idToken: signedToken(),
    ...patch,
  });
}
function envelope() {
  return Object.freeze({
    envelope_version: 'v1', aead_alg: 'AES-256-GCM', kek_wrap_alg: 'A256KW',
    kek_key_name: 'offline-test-kek', kek_key_version: 'v1-test-0001',
    nonce: Buffer.alloc(12, 1), ciphertext: Buffer.alloc(32, 2),
    auth_tag: Buffer.alloc(16, 3), wrapped_dek: Buffer.alloc(40, 4),
    operation_id: OPERATION,
  });
}
function harness(spec = {}) {
  const calls = { request: [], crypto: [], clock: [], seal: [], open: 0, rewrap: 0, install: [] };
  const https = Object.freeze({ request(options, callback) {
    if (spec.requestThrow) throw new Error(`${LEAK}:https`);
    const response = new EventEmitter();
    response.statusCode = 200;
    response.headers = { 'content-type': 'application/json' };
    response.destroy = function destroy() {};
    const request = new EventEmitter();
    request.destroy = function destroy() {};
    const exchange = { options, receiver: this, request, response };
    calls.request.push(exchange);
    request.end = function end() {
      const isProfile = options.path === '/gmail/v1/users/me/profile';
      const body = JSON.stringify(isProfile
        ? { emailAddress: spec.profileEmail || EMAIL, historyId: '123456' }
        : { keys: [{ ...publicJwk, kid: spec.jwksKid || KID, use: 'sig', alg: 'RS256' }] });
      callback(response);
      response.emit('data', Buffer.from(body));
      response.emit('end');
      response.removeAllListeners();
      request.removeAllListeners();
    };
    return request;
  } });
  const crypto = Object.freeze({
    createPublicKey(input) { calls.crypto.push({ method: 'createPublicKey', receiver: this }); return nativeCrypto.createPublicKey(input); },
    verify(...args) { calls.crypto.push({ method: 'verify', receiver: this }); return nativeCrypto.verify(...args); },
  });
  const timers = Object.freeze({
    setTimeout(callback, ms) { assert.equal(ms, 5000); return Object.freeze({ callback }); },
    clearTimeout() {},
  });
  const clock = Object.freeze({ nowEpochSeconds() { calls.clock.push(this); return NOW; } });
  const envelopeProvider = Object.freeze({
    async sealGrantPayload(input) {
      calls.seal.push({ input, receiver: this });
      if (spec.sealThrow) throw new Error(`${LEAK}:${REFRESH}`);
      return Object.hasOwn(spec, 'sealResult') ? spec.sealResult : envelope();
    },
    async openGrantPayload() { calls.open += 1; throw new Error('must not open'); },
    async rewrapGrantDek() { calls.rewrap += 1; throw new Error('must not rewrap'); },
  });
  const installer = Object.freeze({
    async installVerifiedGrant(input) {
      calls.install.push({ input, receiver: this });
      if (spec.installThrow) throw new Error(`${LEAK}:${ACCESS}`);
      return Object.hasOwn(spec, 'installAck') ? spec.installAck : Object.freeze({ status: 'installed' });
    },
  });
  const dependencies = Object.freeze({ https, crypto, timers, envelopeProvider, clock, installer });
  return { dependencies, https, crypto, timers, envelopeProvider, clock, installer, calls };
}
function create(spec = {}, cfg = config()) {
  const h = harness(spec);
  return { ...h, service: createGoogleVerifiedGrantComposition(cfg, h.dependencies) };
}
function noWork(calls) {
  assert.equal(calls.request.length, 0);
  assert.equal(calls.crypto.length, 0);
  assert.equal(calls.clock.length, 0);
  assert.equal(calls.seal.length, 0);
  assert.equal(calls.install.length, 0);
  assert.equal(calls.open, 0);
  assert.equal(calls.rewrap, 0);
}
function secretFree(value) {
  const rendered = JSON.stringify(value, (_key, item) => Buffer.isBuffer(item) ? '<bytes>' : item);
  for (const secret of [ACCESS, REFRESH, NONCE, LEAK]) assert.equal(rendered.includes(secret), false);
}
async function rejected(action) {
  await assert.rejects(Promise.resolve().then(action), error => {
    const rendered = `${error && error.name}\n${error && error.code}\n${error && error.message}\n${error && error.stack}`;
    for (const secret of [ACCESS, REFRESH, NONCE, EMAIL, LEAK]) assert.equal(rendered.includes(secret), false);
    assert.equal(Object.isFrozen(error), true);
    return true;
  });
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('exports only the smallest frozen composition factory and frozen custody surface', async () => {
  assert.deepEqual(Object.keys(compositionOwner), ['createGoogleVerifiedGrantComposition']);
  assert.equal(Object.isFrozen(compositionOwner), true);
  const c = create();
  assert.deepEqual(Reflect.ownKeys(c.service), ['acceptValidatedTokens']);
  assert.equal(Object.isFrozen(c.service), true);
  noWork(c.calls);
});

test('requires exact frozen config in the custody CONFIG_KEYS order', async () => {
  assert.deepEqual([...CONFIG_KEYS], ['clientId', 'endpointId', 'operationId', 'actorStaffUserId', 'expectedNonce', 'expectedClientId']);
  const h = harness();
  const reordered = Object.freeze({ endpointId: ENDPOINT, clientId: CLIENT, operationId: OPERATION, actorStaffUserId: ACTOR, expectedNonce: NONCE, expectedClientId: OAUTH_CLIENT });
  for (const bad of [{ ...config() }, Object.freeze({ ...config(), extra: 1 }), reordered, Object.freeze(Object.assign(Object.create(null), config()))])
    assert.throws(() => createGoogleVerifiedGrantComposition(bad, h.dependencies));
  const accessor = { ...config() }; Object.defineProperty(accessor, 'clientId', { enumerable: true, get() { throw new Error(LEAK); } }); Object.freeze(accessor);
  assert.throws(() => createGoogleVerifiedGrantComposition(accessor, h.dependencies));
  assert.throws(() => createGoogleVerifiedGrantComposition(new Proxy(config(), { ownKeys() { throw new Error(LEAK); } }), h.dependencies));
  noWork(h.calls);
});

test('requires exact frozen ordered dependencies and exact frozen method owners', async () => {
  const h = harness();
  const good = h.dependencies;
  const variants = [
    { ...good }, Object.freeze({ ...good, extra: 1 }),
    Object.freeze({ crypto: good.crypto, https: good.https, timers: good.timers, envelopeProvider: good.envelopeProvider, clock: good.clock, installer: good.installer }),
    Object.freeze({ ...good, https: Object.freeze({ request: 1 }) }),
    Object.freeze({ ...good, crypto: Object.freeze({ createPublicKey() {}, verify() {}, extra() {} }) }),
    Object.freeze({ ...good, timers: Object.freeze({ setTimeout() {}, clearTimeout() {}, [Symbol('x')]: 1 }) }),
    Object.freeze({ ...good, clock: Object.freeze({ nowEpochSeconds() {}, extra: 1 }) }),
    Object.freeze({ ...good, installer: Object.freeze({ installVerifiedGrant() {}, extra: 1 }) }),
  ];
  for (const dependencies of variants) assert.throws(() => createGoogleVerifiedGrantComposition(config(), dependencies));
  const accessor = { ...good }; Object.defineProperty(accessor, 'https', { enumerable: true, get() { throw new Error(LEAK); } }); Object.freeze(accessor);
  assert.throws(() => createGoogleVerifiedGrantComposition(config(), accessor));
  assert.throws(() => createGoogleVerifiedGrantComposition(config(), new Proxy(good, { getPrototypeOf() { throw new Error(LEAK); } })));
  noWork(h.calls);
});

test('performs no network, crypto, clock, seal, or install during factory construction', async () => {
  const c = create();
  noWork(c.calls);
  await Promise.resolve();
  noWork(c.calls);
});

test('binds one Gmail profile check between transaction-nonce identity verification and custody', async () => {
  const c = create();
  const ack = await Reflect.apply(c.service.acceptValidatedTokens, c.service, [selected()]);
  assert.deepEqual(ack, { status: 'accepted' });
  assert.equal(Object.isFrozen(ack), true);
  assert.equal(c.calls.request.length, 2);
  assert.deepEqual(c.calls.request[0].options, {
    protocol: 'https:', hostname: 'www.googleapis.com', port: 443, method: 'GET',
    path: '/oauth2/v3/certs', headers: { Accept: 'application/json' }, agent: false,
  });
  assert.equal(c.calls.request[1].options.path, '/gmail/v1/users/me/profile');
  assert.deepEqual(c.calls.crypto.map(x => x.method), ['createPublicKey', 'verify']);
  assert.equal(c.calls.seal.length, 1);
  assert.equal(c.calls.install.length, 1);
  secretFree(ack);
});

test('JWKS and profile use distinct request/response lifecycles without cross-delivery or retained listeners', async () => {
  const c = create();
  await c.service.acceptValidatedTokens(selected());
  assert.equal(c.calls.request.length, 2);
  const [jwks, profile] = c.calls.request;
  assert.notStrictEqual(jwks.request, profile.request);
  assert.notStrictEqual(jwks.response, profile.response);
  assert.equal(jwks.options.hostname, 'www.googleapis.com');
  assert.equal(jwks.options.path, '/oauth2/v3/certs');
  assert.equal(profile.options.hostname, 'www.googleapis.com');
  assert.equal(profile.options.path, '/gmail/v1/users/me/profile');
  for (const exchange of [jwks, profile]) {
    assert.equal(exchange.request.listenerCount('error'), 0);
    assert.equal(exchange.response.listenerCount('data'), 0);
    assert.equal(exchange.response.listenerCount('end'), 0);
    assert.equal(exchange.response.listenerCount('error'), 0);
    assert.equal(exchange.response.listenerCount('aborted'), 0);
  }
});

test('wrong Gmail profile prevents seal and install after genuine nonce verification', async () => {
  const c = create({ profileEmail: 'other@example.test' });
  await rejected(() => c.service.acceptValidatedTokens(selected()));
  assert.equal(c.calls.request.length, 2);
  assert.equal(c.calls.seal.length, 0);
  assert.equal(c.calls.install.length, 0);
});

test('produces verified four-field identity, refresh-only canonical AAD, and minimized installer DTO', async () => {
  const c = create();
  await c.service.acceptValidatedTokens(selected());
  const seal = c.calls.seal[0].input;
  assert.deepEqual(Reflect.ownKeys(seal), ['refresh_token', 'aad', 'operation_id']);
  assert.equal(seal.refresh_token, REFRESH);
  assert.equal(seal.operation_id, OPERATION);
  assert.deepEqual(parseGrantEnvelopeAadV1(seal.aad).value, {
    client_id: CLIENT, endpoint_id: ENDPOINT, grant_generation: 1n, operation_id: OPERATION,
  });
  const install = c.calls.install[0].input;
  assert.deepEqual(Reflect.ownKeys(install), ['clientId', 'endpointId', 'operationId', 'actorStaffUserId', 'identity', 'envelope']);
  assert.deepEqual(install.identity, {
    providerTenantId: 'https://accounts.google.com', providerPrincipalId: SUBJECT,
    mailboxAddress: EMAIL, displayName: DISPLAY,
  });
  assert.deepEqual(Reflect.ownKeys(install.identity), ['providerTenantId', 'providerPrincipalId', 'mailboxAddress', 'displayName']);
  assert.equal(validateGrantEnvelopeRecordV1(install.envelope).ok, true);
  secretFree(install);
  for (const key of ['accessToken', 'refreshToken', 'idToken', 'refresh_token', 'scope']) assert.equal(key in install, false);
});

test('preserves every injected receiver through the complete chain', async () => {
  const c = create();
  await c.service.acceptValidatedTokens(selected());
  assert.equal(c.calls.request[0].receiver, c.https);
  assert.equal(c.calls.crypto[0].receiver, c.crypto);
  assert.equal(c.calls.crypto[1].receiver, c.crypto);
  assert.equal(c.calls.clock[0], c.clock);
  assert.equal(c.calls.seal[0].receiver, c.envelopeProvider);
  assert.equal(c.calls.install[0].receiver, c.installer);
  assert.equal(c.calls.open, 0); assert.equal(c.calls.rewrap, 0);
});

test('delegates one-shot ownership to custody without a divergent composition burn', async () => {
  const c = create();
  await rejected(() => c.service.acceptValidatedTokens(selected({ tokenType: 'MAC' })));
  await rejected(() => c.service.acceptValidatedTokens(selected()));
  noWork(c.calls);
});

test('signature and token substitution prevent sealing and installation', async () => {
  const badSignature = signedToken({}, otherPair);
  const substitutedAccess = selected({ accessToken: `${ACCESS}-substituted` });
  for (const input of [selected({ idToken: badSignature }), substitutedAccess]) {
    const c = create(); await rejected(() => c.service.acceptValidatedTokens(input));
    assert.equal(c.calls.seal.length, 0); assert.equal(c.calls.install.length, 0);
  }
});

test('nonce, client, email_verified, and JWKS kid failures prevent seal/install', async () => {
  const cases = [
    { input: selected({ idToken: signedToken({ nonce: 'wrong' }) }) },
    { input: selected({ idToken: signedToken({ aud: 'wrong-client' }) }) },
    { input: selected({ idToken: signedToken({ email_verified: false }) }) },
    { spec: { jwksKid: 'other-kid' }, input: selected() },
  ];
  for (const item of cases) {
    const c = create(item.spec); await rejected(() => c.service.acceptValidatedTokens(item.input));
    assert.equal(c.calls.seal.length, 0); assert.equal(c.calls.install.length, 0);
  }
});

test('child failures and malformed thenable/ack results are sanitized and stop downstream work', async () => {
  for (const spec of [
    { requestThrow: true }, { sealThrow: true }, { sealResult: Object.freeze({ then(resolve, reject) { reject(new Error(LEAK)); } }) },
    { installThrow: true }, { installAck: Object.freeze({ status: 'accepted' }) },
    { installAck: Object.freeze({ then(resolve) { resolve(Object.freeze({ status: 'wrong' })); } }) },
  ]) {
    const c = create(spec); await rejected(() => c.service.acceptValidatedTokens(selected()));
    if (spec.requestThrow) { assert.equal(c.calls.seal.length, 0); assert.equal(c.calls.install.length, 0); }
    if (spec.sealThrow || spec.sealResult) assert.equal(c.calls.install.length, 0);
  }
});

test('post-factory substitution cannot replace pinned methods', async () => {
  const c = create();
  for (const owner of [c.https, c.crypto, c.timers, c.envelopeProvider, c.clock, c.installer]) {
    assert.equal(Object.isFrozen(owner), true);
  }
  assert.throws(() => { c.https.request = () => { throw new Error(LEAK); }; }, TypeError);
  assert.throws(() => { c.installer.installVerifiedGrant = () => { throw new Error(LEAK); }; }, TypeError);
  await c.service.acceptValidatedTokens(selected());
  assert.equal(c.calls.install.length, 1);
});

test('hostile failures emit no logs and expose no raw token material', async () => {
  const seen = [];
  const originals = [console.log, console.info, console.warn, console.error];
  [console.log, console.info, console.warn, console.error] = originals.map(() => (...args) => seen.push(args));
  try {
    const c = create({ installThrow: true });
    await rejected(() => c.service.acceptValidatedTokens(selected()));
    assert.deepEqual(seen, []);
  } finally { [console.log, console.info, console.warn, console.error] = originals; }
});

test('source is pure composition importing only the three merged child owners', async () => {
  const source = fs.readFileSync(require.resolve('./lib/email-google-verified-grant-composition'), 'utf8');
  const relativeImports = [...source.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)].map(match => match[1]).sort();
  assert.deepEqual(relativeImports, [
    './email-google-gmail-profile-request',
    './email-google-oidc-id-token',
    './email-google-oidc-jwks-verifier',
    './email-google-verified-grant-custody',
  ]);
  const childCalls = [
    'createGoogleOidcJwksVerifier(',
    'createGoogleOidcVerifiedIdentity(',
    'createGoogleVerifiedGrantCustodyAdapter(',
  ];
  const childPositions = childCalls.map(name => {
    assert.equal(source.split(name).length - 1, 1, `exactly one child construction: ${name}`);
    return source.indexOf(name);
  });
  assert.ok(childPositions[0] < childPositions[1] && childPositions[1] < childPositions[2],
    'merged children are constructed in JWKS -> identity -> custody order');
  for (const forbidden of [
    /\bfetch\s*\(/, /https\.(?:get|request)\s*\(/, /googleapis|@googleapis\//,
    /token[_-]?exchange/i, /authorization[_-]?code/i, /process\.env/,
    /\b(?:pg|postgres|database|sql)\b/i, /staff-query-api|express|router/i,
    /console\.(?:log|info|warn|error)/, /createServer|listen\s*\(/,
  ]) assert.equal(forbidden.test(source), false, `forbidden capability ${forbidden}`);
  for (const forbiddenExport of ['createGoogleOidcJwksVerifier', 'createGoogleOidcVerifiedIdentity', 'createGoogleVerifiedGrantCustodyAdapter'])
    assert.equal(Object.hasOwn(compositionOwner, forbiddenExport), false);
});

(async () => {
  for (const { name, run } of tests) { await run(); process.stdout.write(`ok - ${name}\n`); }
  process.stdout.write(`PASS verify:email-google-verified-grant-composition (${tests.length} named offline tests)\n`);
})().catch(error => { process.stderr.write(`${error && error.stack ? error.stack : error}\n`); process.exitCode = 1; });
