'use strict';

/**
 * RED-only offline contract for the pure end-to-end Google authorization-code operation.
 * The production composition owner is intentionally absent. This test has no credential
 * provider, callback/route, ambient environment, database, deployment, or live network.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nativeCrypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { GOOGLE_PHASE_A_SCOPES } = require('./lib/email-google-verified-grant-custody');
const { parseGrantEnvelopeAadV1, validateGrantEnvelopeRecordV1 } = require('./lib/email-grant-envelope-provider-contract');

// Authentic RED: GREEN must provide this sole pure composition owner.
const operationOwner = require('./lib/email-google-authorization-code-operation');
const { createGoogleAuthorizationCodeOperation } = operationOwner;

const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENDPOINT = '11111111-2222-4333-8444-555555555555';
const OPERATION = '99999999-8888-4777-8666-555555555555';
const ACTOR = 'abcdef01-2345-4678-89ab-cdef01234567';
const NONCE = 'google-operation-nonce-never-log';
const APPLICATION_CLIENT = '9876543210-web_client.v2.apps.googleusercontent.com';
const REDIRECT = 'https://mail.example.test/private/google/callback';
const CODE = '4/0A+GOOGLE_OPERATION_CODE_NEVER_LOG';
const VERIFIER = `${'V'.repeat(41)}-._~`;
const CLIENT_SECRET = 'GOOGLE_OPERATION_CLIENT_SECRET_NEVER_LOG+/%?=&!';
const ACCESS = 'GOOGLE_OPERATION_ACCESS_TOKEN_NEVER_LOG';
const REFRESH = 'GOOGLE_OPERATION_REFRESH_TOKEN_NEVER_LOG';
const EMAIL = 'Owner.Case+Google@Example.COM';
const SUBJECT = 'Google-Subject_123';
const NOW = 1_900_000_000;
const KID = 'offline-google-operation-key';
const LEAK = 'HOSTILE_OPERATION_VALUE_NEVER_LOG';
const SCOPE = GOOGLE_PHASE_A_SCOPES.join(' ');
const pair = nativeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherPair = nativeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = pair.publicKey.export({ format: 'jwk' });
const freeze = Object.freeze;
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const atHash = value => nativeCrypto.createHash('sha256').update(value, 'ascii').digest().subarray(0, 16).toString('base64url');

function config(patch = {}) {
  return freeze({
    clientId: CLIENT, endpointId: ENDPOINT, operationId: OPERATION, actorStaffUserId: ACTOR,
    expectedNonce: NONCE, expectedClientId: APPLICATION_CLIENT,
    applicationClientId: APPLICATION_CLIENT, redirectUri: REDIRECT, ...patch,
  });
}
function input(patch = {}) {
  return freeze({ authorizationCode: CODE, codeVerifier: VERIFIER, clientSecret: CLIENT_SECRET, ...patch });
}
function signedToken(claimPatch = {}, signingPair = pair) {
  const signingInput = `${b64({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64({
    iss: 'https://accounts.google.com', aud: APPLICATION_CLIENT, sub: SUBJECT, email: EMAIL,
    email_verified: true, nonce: NONCE, name: 'Google Owner', exp: NOW + 600, iat: NOW - 10,
    at_hash: atHash(ACCESS), ...claimPatch,
  })}`;
  return `${signingInput}.${nativeCrypto.sign('RSA-SHA256', Buffer.from(signingInput), signingPair.privateKey).toString('base64url')}`;
}
function tokenBody(spec = {}) {
  return JSON.stringify({
    access_token: ACCESS, expires_in: 3600, refresh_token: REFRESH,
    scope: SCOPE, token_type: 'Bearer', id_token: signedToken(), ...spec.tokenPatch,
  });
}
function envelope() {
  return freeze({
    envelope_version: 'v1', aead_alg: 'AES-256-GCM', kek_wrap_alg: 'A256KW',
    kek_key_name: 'offline-operation-kek', kek_key_version: 'v1-test-0001',
    nonce: Buffer.alloc(12, 1), ciphertext: Buffer.alloc(32, 2), auth_tag: Buffer.alloc(16, 3),
    wrapped_dek: Buffer.alloc(40, 4), operation_id: OPERATION,
  });
}
function transportResponse(statusCode, body) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.headers = { 'content-type': 'application/json' };
  response.destroy = function destroy() {};
  response.deliver = callback => {
    callback(response); response.emit('data', Buffer.from(body)); response.emit('end'); response.emit('close');
  };
  return response;
}
function harness(spec = {}) {
  const calls = { requests: [], timers: [], crypto: [], seal: [], install: [], clock: [], open: 0, rewrap: 0 };
  const https = freeze({ request(options, callback) {
    calls.requests.push({ options, receiver: this });
    if (spec.httpsThrow) throw new Error(`${LEAK}:${CLIENT_SECRET}`);
    const request = new EventEmitter(); request.destroy = function destroy() {};
    request.end = function end(body) {
      calls.requests[calls.requests.length - 1].body = body;
      if (options.hostname === 'oauth2.googleapis.com') {
        const payload = spec.rawTokenBody === undefined ? tokenBody(spec) : spec.rawTokenBody;
        transportResponse(spec.tokenStatus || 200, payload).deliver(callback);
      } else if (options.hostname === 'www.googleapis.com') {
        const jwk = { ...publicJwk, kid: KID, use: 'sig', alg: 'RS256' };
        transportResponse(200, JSON.stringify({ keys: [jwk] })).deliver(callback);
      } else throw new Error('unexpected offline destination');
    };
    return request;
  } });
  const timers = freeze({
    setTimeout(callback, milliseconds) { calls.timers.push({ method: 'set', receiver: this, milliseconds }); return freeze({ callback, milliseconds }); },
    clearTimeout(handle) { calls.timers.push({ method: 'clear', receiver: this, handle }); },
  });
  const crypto = freeze({
    createPublicKey(value) { calls.crypto.push({ method: 'createPublicKey', receiver: this }); return nativeCrypto.createPublicKey(value); },
    verify(...args) { calls.crypto.push({ method: 'verify', receiver: this }); return nativeCrypto.verify(...args); },
  });
  const clock = freeze({ nowEpochSeconds() { calls.clock.push(this); return NOW; } });
  const envelopeProvider = freeze({
    async sealGrantPayload(value) { calls.seal.push({ value, receiver: this }); if (spec.sealThrow) throw new Error(`${LEAK}:${REFRESH}`); return envelope(); },
    async openGrantPayload() { calls.open += 1; throw new Error('must not open'); },
    async rewrapGrantDek() { calls.rewrap += 1; throw new Error('must not rewrap'); },
  });
  const installer = freeze({ async installVerifiedGrant(value) {
    calls.install.push({ value, receiver: this }); if (spec.installThrow) throw new Error(`${LEAK}:${ACCESS}`);
    return freeze({ status: 'installed' });
  } });
  const dependencies = freeze({ https, crypto, timers, envelopeProvider, clock, installer });
  return { calls, dependencies, https, crypto, timers, envelopeProvider, clock, installer };
}
function noEffects(calls) {
  assert.equal(calls.requests.length, 0); assert.equal(calls.timers.length, 0); assert.equal(calls.crypto.length, 0);
  assert.equal(calls.seal.length, 0); assert.equal(calls.install.length, 0); assert.equal(calls.clock.length, 0);
  assert.equal(calls.open, 0); assert.equal(calls.rewrap, 0);
}
function create(spec = {}, cfg = config()) {
  const h = harness(spec); return { ...h, service: createGoogleAuthorizationCodeOperation(cfg, h.dependencies) };
}
function assertClean(error) {
  assert.equal(error.name, 'GoogleAuthorizationCodeOperationError');
  assert.equal(error.code, 'GOOGLE_AUTHORIZATION_CODE_OPERATION_FAILED');
  assert.equal(error.message, 'GOOGLE_AUTHORIZATION_CODE_OPERATION_FAILED');
  assert.equal(Object.isFrozen(error), true);
  const rendered = `${error}\n${error.stack || ''}\n${JSON.stringify(error)}`;
  for (const secret of [CODE, CLIENT_SECRET, ACCESS, REFRESH, NONCE, EMAIL, LEAK]) assert.equal(rendered.includes(secret), false);
  return true;
}
async function rejects(action) { await assert.rejects(Promise.resolve().then(action), assertClean); }
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('exports only the frozen factory and returns the exact request one-shot surface without construction effects', async () => {
  assert.equal(Object.isFrozen(operationOwner), true);
  assert.deepEqual(Reflect.ownKeys(operationOwner), ['createGoogleAuthorizationCodeOperation']);
  const c = create(); assert.equal(Object.isFrozen(c.service), true);
  assert.deepEqual(Reflect.ownKeys(c.service), ['exchangeAuthorizationCode']); noEffects(c.calls);
});

test('performs the complete fixed token POST, Google JWKS verification, seal, and minimized install', async () => {
  const c = create(); const ack = await c.service.exchangeAuthorizationCode(input());
  assert.deepEqual(ack, { status: 'custodied' }); assert.equal(Object.isFrozen(ack), true);
  assert.equal(c.calls.requests.length, 2);
  const [post, jwks] = c.calls.requests;
  assert.deepEqual(post.options, { protocol: 'https:', hostname: 'oauth2.googleapis.com', port: 443, method: 'POST', path: '/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(post.body), Accept: 'application/json' }, agent: false });
  assert.deepEqual([...new URLSearchParams(post.body)], [
    ['client_id', APPLICATION_CLIENT], ['client_secret', CLIENT_SECRET], ['grant_type', 'authorization_code'],
    ['code', CODE], ['redirect_uri', REDIRECT], ['code_verifier', VERIFIER],
  ]);
  assert.deepEqual(jwks.options, { protocol: 'https:', hostname: 'www.googleapis.com', port: 443, method: 'GET',
    path: '/oauth2/v3/certs', headers: { Accept: 'application/json' }, agent: false });
  assert.deepEqual(c.calls.crypto.map(call => call.method), ['createPublicKey', 'verify']);
  assert.equal(c.calls.seal.length, 1); assert.equal(c.calls.install.length, 1);
});

test('installs only verified identity and sealed refresh grant with canonical authority identity', async () => {
  const c = create(); await c.service.exchangeAuthorizationCode(input());
  const sealed = c.calls.seal[0].value;
  assert.deepEqual(Reflect.ownKeys(sealed), ['refresh_token', 'aad', 'operation_id']);
  assert.equal(sealed.refresh_token, REFRESH); assert.equal(sealed.operation_id, OPERATION);
  assert.deepEqual(parseGrantEnvelopeAadV1(sealed.aad).value, { client_id: CLIENT, endpoint_id: ENDPOINT, grant_generation: 1n, operation_id: OPERATION });
  const installed = c.calls.install[0].value;
  assert.deepEqual(Reflect.ownKeys(installed), ['clientId', 'endpointId', 'operationId', 'actorStaffUserId', 'identity', 'envelope']);
  assert.deepEqual(installed.identity, { providerTenantId: 'https://accounts.google.com', providerPrincipalId: SUBJECT,
    mailboxAddress: EMAIL, displayName: 'Google Owner' });
  assert.equal(validateGrantEnvelopeRecordV1(installed.envelope).ok, true);
  for (const key of ['accessToken', 'refreshToken', 'idToken', 'scope']) assert.equal(key in installed, false);
});

test('shares exact HTTPS and timers owners across exchange and JWKS and preserves every dependency receiver', async () => {
  const c = create(); await c.service.exchangeAuthorizationCode(input());
  assert.ok(c.calls.requests.every(call => call.receiver === c.https));
  assert.ok(c.calls.timers.every(call => call.receiver === c.timers));
  assert.ok(c.calls.crypto.every(call => call.receiver === c.crypto));
  assert.equal(c.calls.clock[0], c.clock); assert.equal(c.calls.seal[0].receiver, c.envelopeProvider);
  assert.equal(c.calls.install[0].receiver, c.installer); assert.equal(c.calls.open, 0); assert.equal(c.calls.rewrap, 0);
  assert.deepEqual(c.calls.timers.filter(x => x.method === 'set').map(x => x.milliseconds), [10000, 5000]);
});

test('requires the exact frozen ordered eight-field data-only configuration before child side effects', async () => {
  const good = config();
  const bad = [undefined, null, {}, { ...good }, freeze({ ...good, extra: 1 }),
    freeze({ endpointId: ENDPOINT, clientId: CLIENT, operationId: OPERATION, actorStaffUserId: ACTOR, expectedNonce: NONCE,
      expectedClientId: APPLICATION_CLIENT, applicationClientId: APPLICATION_CLIENT, redirectUri: REDIRECT }),
    freeze(Object.assign(Object.create(null), good)), new Proxy(good, { ownKeys() { throw new Error(LEAK); } })];
  const accessor = { ...good }; Object.defineProperty(accessor, 'clientId', { enumerable: true, get() { throw new Error(LEAK); } }); freeze(accessor); bad.push(accessor);
  for (const cfg of bad) { const h = harness(); assert.throws(() => createGoogleAuthorizationCodeOperation(cfg, h.dependencies), assertClean); noEffects(h.calls); }
});

test('requires exact frozen ordered dependencies and exact merged child owner shapes before effects', async () => {
  const h = harness(); const good = h.dependencies;
  const bad = [undefined, {}, { ...good }, freeze({ ...good, extra: 1 }),
    freeze({ crypto: good.crypto, https: good.https, timers: good.timers, envelopeProvider: good.envelopeProvider, clock: good.clock, installer: good.installer }),
    freeze({ ...good, https: freeze({ request: 1 }) }), freeze({ ...good, timers: freeze({ setTimeout() {}, clearTimeout() {}, extra() {} }) }),
    freeze({ ...good, envelopeProvider: freeze({ sealGrantPayload() {}, openGrantPayload() {}, rewrapGrantDek() {}, extra: 1 }) }),
    new Proxy(good, { getPrototypeOf() { throw new Error(LEAK); } })];
  for (const dependencies of bad) { assert.throws(() => createGoogleAuthorizationCodeOperation(config(), dependencies), assertClean); noEffects(h.calls); }
});

test('rejects expected/application client mismatch before HTTPS, crypto, seal, clock, or install', async () => {
  const h = harness();
  assert.throws(() => createGoogleAuthorizationCodeOperation(config({ expectedClientId: 'other.apps.googleusercontent.com' }), h.dependencies), assertClean);
  noEffects(h.calls);
});

test('pins frozen configuration/dependencies at construction and performs no deferred construction work', async () => {
  const c = create(); await Promise.resolve(); noEffects(c.calls);
  for (const owner of [c.https, c.crypto, c.timers, c.envelopeProvider, c.clock, c.installer]) assert.equal(Object.isFrozen(owner), true);
  assert.throws(() => { c.https.request = () => {}; }, TypeError);
  await c.service.exchangeAuthorizationCode(input()); assert.equal(c.calls.install.length, 1);
});

test('delegates one-shot ownership directly to request without a second wrapper or divergent burn', async () => {
  const c = create(); await rejects(() => c.service.exchangeAuthorizationCode(input({ codeVerifier: 'short' })));
  await rejects(() => c.service.exchangeAuthorizationCode(input())); noEffects(c.calls);
});

test('invalid signature, nonce, or audience prevents sealing and installation', async () => {
  const cases = [
    { tokenPatch: { id_token: signedToken({}, otherPair) } },
    { tokenPatch: { id_token: signedToken({ nonce: 'wrong' }) } },
    { tokenPatch: { id_token: signedToken({ aud: 'wrong.apps.googleusercontent.com' }) } },
  ];
  for (const tokenPatch of cases) { const c = create({ tokenPatch }); await rejects(() => c.service.exchangeAuthorizationCode(input())); assert.equal(c.calls.seal.length, 0); assert.equal(c.calls.install.length, 0); }
});

test('invalid scope or malformed/non-success exact token response prevents crypto, seal, and install', async () => {
  const specimens = [
    { tokenPatch: { scope: `${SCOPE} https://www.googleapis.com/auth/gmail.send` } },
    { tokenPatch: { future_extension: 'bad' } },
    { tokenStatus: 400, rawTokenBody: JSON.stringify({ error: LEAK }) },
  ];
  for (const spec of specimens) { const c = create(spec); await rejects(() => c.service.exchangeAuthorizationCode(input())); assert.equal(c.calls.crypto.length, 0); assert.equal(c.calls.seal.length, 0); assert.equal(c.calls.install.length, 0); }
});

test('child throws are sanitized, contain no raw code/token/secret, emit no logs, and stop downstream work', async () => {
  const originals = [console.log, console.info, console.warn, console.error]; const logs = [];
  [console.log, console.info, console.warn, console.error] = originals.map(() => (...args) => logs.push(args));
  try {
    for (const spec of [{ httpsThrow: true }, { sealThrow: true }, { installThrow: true }]) {
      const c = create(spec); await rejects(() => c.service.exchangeAuthorizationCode(input()));
      if (spec.httpsThrow) assert.equal(c.calls.crypto.length, 0);
      if (spec.sealThrow) assert.equal(c.calls.install.length, 0);
    }
    assert.deepEqual(logs, []);
  } finally { [console.log, console.info, console.warn, console.error] = originals; }
});

test('child configuration validation remains authoritative but all factory failures use one fixed sanitized operation error', async () => {
  const patches = [{ clientId: 'bad' }, { expectedNonce: '' }, { applicationClientId: 'bad' }, { redirectUri: 'http://evil.test/cb' }];
  for (const patch of patches) { const h = harness(); assert.throws(() => createGoogleAuthorizationCodeOperation(config(patch), h.dependencies), assertClean); noEffects(h.calls); }
});

test('source imports exactly four merged owners in construction order and contains no ambient or runtime capabilities', async () => {
  const source = fs.readFileSync(require.resolve('./lib/email-google-authorization-code-operation'), 'utf8');
  const imports = [...source.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)].map(match => match[1]);
  assert.deepEqual(imports, [
    './email-google-verified-grant-composition', './email-google-token-response-custody',
    './email-google-token-exchange-custody', './email-google-authorization-code-request',
  ]);
  const calls = ['createGoogleVerifiedGrantComposition(', 'createGoogleTokenResponseCustody(',
    'createGoogleTokenExchangeCustody(', 'createGoogleAuthorizationCodeRequest('];
  const positions = calls.map(call => { assert.equal(source.split(call).length - 1, 1); return source.indexOf(call); });
  assert.ok(positions.every((position, index) => index === 0 || positions[index - 1] < position));
  for (const forbidden of [/node:https/, /googleapis|@googleapis\//, /process\.env/, /secretProvider/i,
    /callback|router|express|createServer|listen\s*\(/i, /\b(?:database|postgres|sql|deploy)\b/i,
    /console\.(?:log|info|warn|error)/, /\bfetch\s*\(/, /credential/i]) assert.equal(forbidden.test(source), false, `${forbidden}`);
});

(async () => {
  for (const { name, run } of tests) { await run(); process.stdout.write(`ok - ${name}\n`); }
  assert.equal(tests.length, 14);
  process.stdout.write('PASS verify:email-google-authorization-code-operation (14 named offline tests)\n');
})().catch(error => { process.stderr.write(`${error && error.stack ? error.stack : error}\n`); process.exitCode = 1; });
