'use strict';

/**
 * RED-only offline contract for Google OIDC verified identity.
 *
 * Sources pinned by this contract:
 * - Google OpenID Connect: iss is accounts.google.com or https://accounts.google.com;
 *   aud identifies this client; azp is required for a multi-audience token; nonce,
 *   exp, iat, sub, email, email_verified and name have their documented meanings;
 *   at_hash, when emitted, binds the access token. Google's documented profile
 *   claims hd, given_name, family_name, picture and locale are signed metadata.
 * - Existing G2b/custody boundaries: canonical provider tenant is
 *   https://accounts.google.com, sub is durable identity, hd is metadata (not
 *   tenant ownership), mailbox email is case-preserving, and accessToken is in
 *   the custody request. It is never delegated to signature authority or returned,
 *   but is used locally when optional at_hash is present. Profile metadata is
 *   bounded/type-checked and discarded; it cannot affect durable identity.
 * - Mature Microsoft validator: 300-second skew, 86400-second maximum lifetime,
 *   canonical compact JWT decoding, mandatory signature authority first, and
 *   sanitized one-shot failure semantics.
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

// Authentic RED: the Google owner is intentionally absent until GREEN.
const googleOidc = require('./lib/email-google-oidc-id-token');
const { createGoogleOidcVerifiedIdentity } = googleOidc;

const NOW = 1_900_000_000;
const NONCE = 'GOOGLE_NONCE_SECRET_NEVER_LEAK';
const CLIENT = 'google-confidential-web-client';
const ACCESS = 'GOOGLE_ACCESS_TOKEN_SECRET_NEVER_LEAK';
const SUBJECT = 'Google-Sub_123:CaseSensitive';
const EMAIL = 'Owner.Case+Oidc@Example.COM';
const LEAK = 'HOSTILE_SIGNATURE_SECRET_NEVER_LEAK';
const ISSUER = 'https://accounts.google.com';
const atHash = accessToken => createHash('sha256').update(accessToken, 'ascii').digest().subarray(0, 16).toString('base64url');
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const BASE_HEADER = Object.freeze({ alg: 'RS256', kid: 'google-key-1', typ: 'JWT' });
const BASE_CLAIMS = Object.freeze({
  iss: ISSUER, aud: CLIENT, sub: SUBJECT, email: EMAIL, email_verified: true,
  nonce: NONCE, name: 'Owner Case', exp: NOW + 600, iat: NOW - 10,
  at_hash: atHash(ACCESS),
});
function token(header = BASE_HEADER, claims = BASE_CLAIMS, signature = Buffer.from([0, 1, 2, 254, 255])) {
  return `${b64(header)}.${b64(claims)}.${Buffer.from(signature).toString('base64url')}`;
}
function request(idToken = token(), patch = {}) {
  return Object.freeze({
    idToken, accessToken: ACCESS, expectedNonce: NONCE,
    expectedClientId: CLIENT, nowEpochSeconds: NOW, ...patch,
  });
}
function harness(spec = {}) {
  const calls = [];
  const order = [];
  const signatureVerifier = Object.freeze({
    async verifySignature(input) {
      order.push('signature');
      calls.push({ input, receiver: this });
      if (spec.throw) throw new Error(`${LEAK}:${NONCE}:${ACCESS}`);
      if (spec.wait) await spec.wait;
      return Object.hasOwn(spec, 'ack') ? spec.ack : Object.freeze({ verified: true });
    },
  });
  const dependencies = Object.freeze({ signatureVerifier });
  return {
    service: createGoogleOidcVerifiedIdentity(dependencies),
    signatureVerifier, calls, order,
  };
}
async function invalid(action) {
  await assert.rejects(Promise.resolve().then(action), error => {
    assert.equal(error.name, 'GoogleOidcVerifiedIdentityError');
    assert.equal(error.code, 'GOOGLE_OIDC_VERIFIED_IDENTITY_INVALID');
    assert.equal(error.message, 'Google OIDC verified identity validation failed.');
    assert.equal(Object.isFrozen(error), true);
    assert.deepEqual(Object.keys(error), ['code']);
    const rendered = `${error}\n${error.stack || ''}`;
    for (const secret of [NONCE, ACCESS, LEAK, EMAIL]) assert.equal(rendered.includes(secret), false);
    return true;
  });
}
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('exports only the smallest frozen factory and exact frozen service', async () => {
  assert.deepEqual(Object.keys(googleOidc), ['createGoogleOidcVerifiedIdentity']);
  assert.equal(Object.isFrozen(googleOidc), true);
  const { service } = harness();
  assert.deepEqual(Reflect.ownKeys(service), ['verifyIdentity']);
  assert.equal(Object.isFrozen(service), true);
});

test('returns canonical minimal verified identity and preserves case', async () => {
  const { service } = harness();
  const result = await service.verifyIdentity(request());
  assert.deepEqual(result, {
    providerTenantId: ISSUER, providerPrincipalId: SUBJECT,
    mailboxAddress: EMAIL, displayName: 'Owner Case',
  });
  assert.deepEqual(Reflect.ownKeys(result), [
    'providerTenantId', 'providerPrincipalId', 'mailboxAddress', 'displayName',
  ]);
  assert.equal(Object.isFrozen(result), true);
  for (const key of ['idToken', 'accessToken', 'claims', 'nonce', 'hd']) assert.equal(key in result, false);
});

test('normalizes both documented exact Google issuer forms to canonical tenant', async () => {
  for (const iss of ['accounts.google.com', 'https://accounts.google.com']) {
    const result = await harness().service.verifyIdentity(request(token(BASE_HEADER, { ...BASE_CLAIMS, iss })));
    assert.equal(result.providerTenantId, ISSUER);
  }
  for (const iss of ['http://accounts.google.com', 'https://accounts.google.com/', 'ACCOUNTS.GOOGLE.COM']) {
    await invalid(() => harness().service.verifyIdentity(request(token(BASE_HEADER, { ...BASE_CLAIMS, iss }))));
  }
});

test('passes only exact frozen compact signing authority input and receiver', async () => {
  const h = harness();
  await h.service.verifyIdentity(request());
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].receiver, h.signatureVerifier);
  assert.equal(Object.isFrozen(h.calls[0].input), true);
  assert.deepEqual(Reflect.ownKeys(h.calls[0].input), ['signingInput', 'signature', 'alg', 'kid']);
  assert.equal(h.calls[0].input.signingInput, token().split('.').slice(0, 2).join('.'));
  assert.deepEqual(h.calls[0].input.signature, Buffer.from([0, 1, 2, 254, 255]));
  assert.equal(h.calls[0].input.alg, 'RS256');
  assert.equal(h.calls[0].input.kid, 'google-key-1');
  assert.equal(JSON.stringify(h.calls[0].input).includes(ACCESS), false);
});

test('requires exact frozen dependencies and verifySignature authority', async () => {
  const goodVerifier = Object.freeze({ async verifySignature() { return Object.freeze({ verified: true }); } });
  const bad = [null, {}, Object.freeze({}), { signatureVerifier: goodVerifier },
    Object.freeze({ signatureVerifier: {} }),
    Object.freeze({ signatureVerifier: Object.freeze({ verifySignature: 1 }) }),
    Object.freeze({ signatureVerifier: Object.freeze({ verifySignature() {}, extra: true }) }),
    Object.freeze({ signatureVerifier: goodVerifier, extra: true })];
  const accessor = {}; Object.defineProperty(accessor, 'signatureVerifier', { enumerable: true, get() { throw new Error(LEAK); } }); Object.freeze(accessor); bad.push(accessor);
  bad.push(new Proxy(Object.freeze({ signatureVerifier: goodVerifier }), { ownKeys() { throw new Error(LEAK); } }));
  for (const dependencies of bad) assert.throws(() => createGoogleOidcVerifiedIdentity(dependencies), { code: 'GOOGLE_OIDC_VERIFIED_IDENTITY_INVALID' });
});

test('requires exact frozen five-field custody request and contains access token use to optional at_hash', async () => {
  const variants = [
    { ...request() }, Object.freeze({ ...request(), extra: true }),
    Object.freeze({ ...request(), accessToken: '' }), Object.freeze({ ...request(), accessToken: 'x'.repeat(8193) }),
    Object.freeze({ ...request(), expectedNonce: '' }), Object.freeze({ ...request(), expectedClientId: '' }),
    Object.freeze({ ...request(), nowEpochSeconds: 1.5 }), Object.freeze({ ...request(), idToken: 'x'.repeat(32769) }),
    Object.freeze(Object.assign(Object.create(null), request())),
  ];
  const accessor = { ...request() }; Object.defineProperty(accessor, 'accessToken', { enumerable: true, get() { throw new Error(LEAK); } }); Object.freeze(accessor); variants.push(accessor);
  variants.push(new Proxy(request(), { getPrototypeOf() { throw new Error(LEAK); } }));
  for (const value of variants) await invalid(() => harness().service.verifyIdentity(value));
  const noHash = { ...BASE_CLAIMS }; delete noHash.at_hash;
  const a = await harness().service.verifyIdentity(request(token(BASE_HEADER, noHash), { accessToken: 'printable-unbound-a' }));
  const b = await harness().service.verifyIdentity(request(token(BASE_HEADER, noHash), { accessToken: 'printable-unbound-b' }));
  assert.deepEqual(a, b); // token-endpoint ID tokens do not universally carry at_hash
});

test('validates optional RS256 at_hash canonically after signature without delegating access token', async () => {
  const correct = harness();
  await correct.service.verifyIdentity(request());
  assert.equal(correct.calls.length, 1);
  assert.equal(JSON.stringify(correct.calls[0].input).includes(ACCESS), false);

  const changed = harness();
  await invalid(() => changed.service.verifyIdentity(request(token(), { accessToken: `${ACCESS}-changed` })));
  assert.equal(changed.calls.length, 1); // a claim is trusted/compared only after signature authority

  for (const value of [atHash(ACCESS).slice(0, 21), `${atHash(ACCESS)}=`,
    atHash(ACCESS).replace(/.$/, '+'), Buffer.alloc(17).toString('base64url'), 1, null]) {
    const h = harness();
    await invalid(() => h.service.verifyIdentity(request(token(BASE_HEADER, { ...BASE_CLAIMS, at_hash: value }))));
    assert.equal(h.calls.length, 1);
  }
});

test('is atomically one-shot like the mature Microsoft signature-bound validator', async () => {
  const first = harness();
  await invalid(() => first.service.verifyIdentity(request('bad')));
  await invalid(() => first.service.verifyIdentity(request()));
  let release; const wait = new Promise(resolve => { release = resolve; });
  const concurrent = harness({ wait });
  const pending = concurrent.service.verifyIdentity(request());
  await invalid(() => concurrent.service.verifyIdentity(request()));
  release(); await pending;
});

test('rejects noncanonical compact serialization, size, UTF-8, JSON, and duplicate-key attacks', async () => {
  const malformed = ['', 'a.b', 'a.b.c.d', '=.eA.eA', 'eA=.eA.eA', 'A.eA.eA',
    `${b64('{')}.${b64(BASE_CLAIMS)}.AA`, `${b64(BASE_HEADER)}..AA`,
    `${b64(BASE_HEADER)}.${Buffer.from([0xff]).toString('base64url')}.AA`,
    `${'A'.repeat(2049)}.${b64(BASE_CLAIMS)}.AA`, `${b64(BASE_HEADER)}.${b64(BASE_CLAIMS)}.${'A'.repeat(2049)}`];
  for (const jwt of malformed) await invalid(() => harness().service.verifyIdentity(request(jwt)));
  for (const raw of ['{"alg":"RS256","alg":"none","kid":"k"}', '{"alg":"RS256","kid":"k","__proto__":1}', '{"alg":"RS256","kid":"x\\ud800"}'])
    await invalid(() => harness().service.verifyIdentity(request(`${b64(raw)}.${b64(BASE_CLAIMS)}.AA`)));
  for (const raw of ['{"iss":"accounts.google.com","iss":"evil"}', '{"sub":"x\\udc00"}', '{"nested":{"constructor":1}}'])
    await invalid(() => harness().service.verifyIdentity(request(`${b64(BASE_HEADER)}.${b64(raw)}.AA`)));
});

test('pins RS256, optional exact JWT typ, bounded kid, and rejects critical or unknown header fields', async () => {
  const bad = [{ alg: 'none', kid: 'k' }, { alg: 'RS256' }, { alg: 'RS256', kid: '' },
    { alg: 'RS256', kid: 'x'.repeat(257) }, { alg: 'RS256', kid: 'k', typ: 'jwt' },
    { alg: ['RS256'], kid: 'k' }, { alg: 'RS256', kid: 'k', crit: [] },
    { alg: 'RS256', kid: 'k', x5u: 'https://evil.example/key' }];
  for (const header of bad) await invalid(() => harness().service.verifyIdentity(request(token(header))));
  await harness().service.verifyIdentity(request(token({ alg: 'RS256', kid: 'k' })));
});

test('allowlists documented Google profile claims as bounded discard-only metadata', async () => {
  const allowed = [...Object.keys(BASE_CLAIMS), 'azp', 'hd', 'given_name', 'family_name', 'picture', 'locale'];
  const required = ['iss', 'aud', 'sub', 'email', 'email_verified', 'nonce', 'exp', 'iat'];
  for (const key of required) { const claims = { ...BASE_CLAIMS }; delete claims[key]; await invalid(() => harness().service.verifyIdentity(request(token(BASE_HEADER, claims)))); }
  await invalid(() => harness().service.verifyIdentity(request(token(BASE_HEADER, { ...BASE_CLAIMS, unknown_googleish_claim: 'x' }))));
  await invalid(() => harness().service.verifyIdentity(request(token(BASE_HEADER, { ...BASE_CLAIMS, hd: 'Bad Domain' }))));
  const metadata = {
    hd: 'workspace.example', given_name: 'Owner', family_name: 'Case',
    picture: 'https://lh3.googleusercontent.com/a/example', locale: 'en-US',
  };
  const result = await harness().service.verifyIdentity(request(token(BASE_HEADER, { ...BASE_CLAIMS, ...metadata })));
  for (const key of Object.keys(metadata)) assert.equal(key in result, false);
  assert.equal(result.providerTenantId, ISSUER); // hd is never tenant authority
  for (const claims of [
    { given_name: 1 }, { family_name: 'bad\nname' }, { given_name: 'x'.repeat(257) },
    { picture: 'javascript:alert(1)' }, { picture: `https://example.test/${'x'.repeat(2049)}` },
    { locale: {} }, { locale: 'not a locale!' }, { hd: 'x'.repeat(254) },
  ]) await invalid(() => harness().service.verifyIdentity(request(token(BASE_HEADER, { ...BASE_CLAIMS, ...claims }))));
  for (const key of Object.keys(metadata)) assert(allowed.includes(key));
});

test('pins audience string/array and authorized-party semantics exactly', async () => {
  const valid = [
    { aud: CLIENT }, { aud: CLIENT, azp: CLIENT },
    { aud: [CLIENT], azp: CLIENT }, { aud: [CLIENT, 'second-client'], azp: CLIENT },
  ];
  for (const patch of valid) await harness().service.verifyIdentity(request(token(BASE_HEADER, { ...BASE_CLAIMS, ...patch })));
  const bad = [{ aud: 'other' }, { aud: [CLIENT] }, { aud: [CLIENT, CLIENT], azp: CLIENT },
    { aud: [CLIENT, 'second-client'] }, { aud: [CLIENT, 'second-client'], azp: 'second-client' },
    { aud: [], azp: CLIENT }, { aud: [CLIENT, 1], azp: CLIENT }, { aud: CLIENT, azp: ['bad'] }];
  for (const patch of bad) await invalid(() => harness().service.verifyIdentity(request(token(BASE_HEADER, { ...BASE_CLAIMS, ...patch }))));
});

test('pins nonce, subject, email verification, case-preserving mailbox, and safe display name', async () => {
  const bad = [{ nonce: 'other' }, { sub: '' }, { sub: ' bad' }, { sub: 'bad\nsub' }, { sub: 'x'.repeat(256) },
    { email_verified: false }, { email_verified: 1 }, { email: 'not-an-email' }, { email: 'a..b@example.com' },
    { email: 'a@localhost' }, { email: 'x'.repeat(245) + '@example.com' }];
  for (const patch of bad) await invalid(() => harness().service.verifyIdentity(request(token(BASE_HEADER, { ...BASE_CLAIMS, ...patch }))));
  for (const name of ['', 'bad\nname', 'x'.repeat(257), 1]) {
    const result = await harness().service.verifyIdentity(request(token(BASE_HEADER, { ...BASE_CLAIMS, name })));
    assert.equal(result.displayName, null);
  }
  const noName = { ...BASE_CLAIMS }; delete noName.name;
  assert.equal((await harness().service.verifyIdentity(request(token(BASE_HEADER, noName)))).displayName, null);
});

test('uses Microsoft-grounded 300-second skew and 86400-second maximum token lifetime', async () => {
  const valid = [{ exp: NOW - 299 }, { iat: NOW + 300 }, { iat: NOW, exp: NOW + 86400 }];
  for (const patch of valid) await harness().service.verifyIdentity(request(token(BASE_HEADER, { ...BASE_CLAIMS, ...patch })));
  const bad = [{ exp: NOW - 300 }, { iat: NOW + 301 }, { exp: NOW + 10, iat: NOW + 10 },
    { iat: NOW, exp: NOW + 86401 }, { exp: 1.5 }, { iat: null }];
  for (const patch of bad) await invalid(() => harness().service.verifyIdentity(request(token(BASE_HEADER, { ...BASE_CLAIMS, ...patch }))));
});

test('accepts claims only after strict frozen signature acknowledgement and masks failures', async () => {
  await invalid(() => harness({ throw: true }).service.verifyIdentity(request(token(BASE_HEADER, { ...BASE_CLAIMS, sub: LEAK }))));
  const badAcks = [null, true, {}, { verified: true }, Object.seal({ verified: true }),
    Object.freeze({ verified: false }), Object.freeze({ verified: true, extra: true }),
    Object.freeze(Object.create(null, { verified: { value: true, enumerable: true } }))];
  for (const ack of badAcks) await invalid(() => harness({ ack }).service.verifyIdentity(request()));
  let release; const wait = new Promise(resolve => { release = resolve; }); const h = harness({ wait });
  let settled = false; const pending = h.service.verifyIdentity(request()).then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false); assert.deepEqual(h.order, ['signature']);
  release(); await pending; assert.equal(settled, true);
});

(async () => {
  for (const { name, run } of tests) { await run(); process.stdout.write(`ok - ${name}\n`); }
  process.stdout.write(`PASS verify:email-google-oidc-verified-identity (${tests.length} named offline tests)\n`);
})().catch(error => { process.stderr.write(`${error && error.stack ? error.stack : error}\n`); process.exitCode = 1; });
