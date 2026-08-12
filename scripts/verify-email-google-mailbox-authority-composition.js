'use strict';

/** Offline RED specification: compose verified OIDC identity with the one-shot
 * Gmail profile evidence owner and the pure mailbox-authority contract. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const owner = require('./lib/email-google-mailbox-authority-composition');
const { createGoogleMailboxAuthorityComposition } = owner;

const AUDIENCE = 'google-confidential-web-client';
const NONCE = 'server-owned-nonce-never-output';
const TOKEN = 'access-token-never-output';
const SUBJECT = 'Google-Sub_123:CaseSensitive';
const EMAIL = 'Owner.Case+Mailbox@Example.COM';
const HISTORY = '9876543210123456789';
const LEAK = 'hostile-authority-secret';
const NOW = 1_900_000_000;
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function idToken(patch = {}) { return `${b64({ alg: 'RS256', kid: 'key' })}.${b64({ iss: 'https://accounts.google.com', aud: AUDIENCE, sub: SUBJECT, email: EMAIL, email_verified: true, nonce: NONCE, exp: NOW + 600, iat: NOW, ...patch })}.${Buffer.from('signed').toString('base64url')}`; }

function config(patch = {}) { return Object.freeze({ expectedAudience: AUDIENCE, expectedNonce: NONCE, requestTimeoutMs: 5000, responseBytesMax: 16384, ...patch }); }
function identity(patch = {}) { return Object.freeze({ providerTenantId: 'https://accounts.google.com', providerPrincipalId: SUBJECT, mailboxAddress: EMAIL, displayName: 'Owner Case', ...patch }); }
function operation(patch = {}) { return Object.freeze({ idToken: idToken(), accessToken: TOKEN, nowEpochSeconds: NOW, ...patch }); }
function harness(spec = {}) {
  const calls = { request: [], timers: [] };
  let callback;
  const response = new EventEmitter(); response.statusCode = 200; response.headers = { 'content-type': 'application/json' }; response.destroy = function destroy() {};
  const request = new EventEmitter(); request.destroy = function destroy() {}; request.end = function end() {
    callback(response);
    response.emit('data', Buffer.from(JSON.stringify(spec.profile || { emailAddress: EMAIL, historyId: HISTORY })));
    response.emit('end');
  };
  const https = Object.freeze({ request(options, cb) { calls.request.push({ options, receiver: this }); callback = cb; return request; } });
  const timers = Object.freeze({ setTimeout(fn, ms) { calls.timers.push({ fn, ms, receiver: this }); return Object.freeze({}); }, clearTimeout() {} });
  const signatureVerifier = Object.freeze({ async verifySignature(input) { calls.signature = [input]; if (spec.badSignature) throw Error(LEAK); return Object.freeze({ verified: true }); } });
  const dependencies = Object.freeze({ https, timers, signatureVerifier });
  return { service: createGoogleMailboxAuthorityComposition(config(), dependencies), calls, https };
}
async function rejected(action) {
  await assert.rejects(Promise.resolve().then(action), error => {
    assert.equal(error.name, 'GoogleMailboxAuthorityCompositionError');
    assert.equal(error.code, 'GOOGLE_MAILBOX_AUTHORITY_COMPOSITION_FAILED');
    assert.equal(Object.isFrozen(error), true);
    const text = `${error}\n${error.stack || ''}`;
    for (const secret of [TOKEN, NONCE, EMAIL, LEAK]) assert.equal(text.includes(secret), false);
    return true;
  });
}
const tests = []; const test = (name, run) => tests.push({ name, run });

test('exports only a frozen factory and exact frozen operation surface', async () => {
  assert.deepEqual(Object.keys(owner), ['createGoogleMailboxAuthorityComposition']); assert.equal(Object.isFrozen(owner), true);
  const h = harness(); assert.deepEqual(Reflect.ownKeys(h.service), ['deriveAuthority']); assert.equal(Object.isFrozen(h.service), true); assert.equal(h.calls.request.length, 0);
});
test('construction is inert and performs no provider, timer, DB, route, or environment work', async () => { const h = harness(); await Promise.resolve(); assert.deepEqual(h.calls, { request: [], timers: [] }); });
test('requires exact frozen ordered config and dependencies without accessors, proxies, inherited or excess fields', async () => {
  const h = harness();
  for (const bad of [{ ...config() }, Object.freeze({ ...config(), extra: 1 }), Object.freeze({ expectedNonce: NONCE, expectedAudience: AUDIENCE, requestTimeoutMs: 5000, responseBytesMax: 16384 }), Object.freeze(Object.assign(Object.create(null), config()))]) assert.throws(() => createGoogleMailboxAuthorityComposition(bad, Object.freeze({ https: h.https, timers: Object.freeze({ setTimeout() {}, clearTimeout() {} }) })));
  const accessor = { ...config() }; Object.defineProperty(accessor, 'expectedAudience', { enumerable: true, get() { throw new Error(LEAK); } }); Object.freeze(accessor); assert.throws(() => createGoogleMailboxAuthorityComposition(accessor, {}));
  assert.throws(() => createGoogleMailboxAuthorityComposition(config(), new Proxy(Object.freeze({}), { ownKeys() { throw new Error(LEAK); } })));
});
test('executes fixed Gmail profile transport exactly once only during operation', async () => {
  const h = harness(); const result = await h.service.deriveAuthority(operation()); assert.equal(h.calls.request.length, 1); assert.equal(h.calls.request[0].receiver, h.https);
  assert.equal(h.calls.request[0].options.path, '/gmail/v1/users/me/profile'); assert.equal(h.calls.request[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  await rejected(() => h.service.deriveAuthority(operation())); assert.equal(h.calls.request.length, 1); assert.equal(result.authority.activation_enabled, false);
});
test('returns frozen sanitized authority and evidence from matching verified identity/profile snapshots', async () => {
  const result = await harness().service.deriveAuthority(operation()); assert.equal(Object.isFrozen(result), true); assert.deepEqual(Reflect.ownKeys(result), ['authority', 'evidence']);
  assert.equal(Object.isFrozen(result.authority), true); assert.equal(result.authority.provider_resource_id, SUBJECT); assert.equal(result.authority.public_address, EMAIL); assert.equal(result.authority.cryptographically_verified, true); assert.equal(result.authority.binding_status, 'verified_profile_match'); assert.equal(result.authority.activation_enabled, false);
  assert.deepEqual(result.evidence, { provider: 'gmail_api', profile_email_address: EMAIL, gmail_history_id: HISTORY, evidence_role: 'profile_match_and_sync_cursor_not_authorization' }); assert.equal(Object.isFrozen(result.evidence), true);
  const rendered = JSON.stringify(result); for (const secret of [TOKEN, NONCE]) assert.equal(rendered.includes(secret), false);
  for (const key of ['accessToken', 'idToken', 'refreshToken', 'send', 'write', 'request']) assert.equal(key in result, false);
});
test('verifies token internally, accepts absent name, and rejects wrong audience, nonce, or signature before profile transport', async () => {
  assert.equal((await harness().service.deriveAuthority(operation())).authority.cryptographically_verified, true);
  for (const patch of [{ aud: 'wrong' }, { nonce: 'wrong' }]) { const h = harness(); await rejected(() => h.service.deriveAuthority(operation({ idToken: idToken(patch) }))); assert.equal(h.calls.request.length, 0); }
  const bad = harness({ badSignature: true }); await rejected(() => bad.service.deriveAuthority(operation())); assert.equal(bad.calls.request.length, 0);
});
test('forged plain identity cannot produce verified authority', async () => { const h = harness(); await rejected(() => h.service.deriveAuthority(Object.freeze({ accessToken: TOKEN, verifiedIdentity: identity() }))); assert.equal(h.calls.request.length, 0); });
test('rejects exact profile mismatch even by email case and does not return hostile authority', async () => { for (const emailAddress of ['other@example.com', EMAIL.toLowerCase()]) { const h = harness({ profile: { emailAddress, historyId: HISTORY } }); await rejected(() => h.service.deriveAuthority(operation())); } });
test('rejects unverified, noncanonical, mutable, inherited, accessor, proxy, and excess identity/operation records before transport', async () => {
  const variants = [identity({ providerTenantId: 'accounts.google.com' }), identity({ extra: LEAK }), { ...identity() }, Object.freeze(Object.assign(Object.create(null), identity()))];
  const accessor = { ...identity() }; Object.defineProperty(accessor, 'mailboxAddress', { enumerable: true, get() { throw new Error(LEAK); } }); Object.freeze(accessor); variants.push(accessor, new Proxy(identity(), { getPrototypeOf() { throw new Error(LEAK); } }));
  for (const verifiedIdentity of variants) { const h = harness(); await rejected(() => h.service.deriveAuthority(Object.freeze({ accessToken: TOKEN, verifiedIdentity }))); assert.equal(h.calls.request.length, 0); }
  const h = harness(); await rejected(() => h.service.deriveAuthority(Object.freeze({ ...operation(), extra: true }))); assert.equal(h.calls.request.length, 0);
});
test('does not accept or expose an injected generic authority capability', async () => {
  const h = harness();
  await rejected(() => h.service.deriveAuthority(Object.freeze({ accessToken: TOKEN, verifiedIdentity: identity(), authority: Object.freeze({ send() { throw new Error(LEAK); } }) })));
  assert.equal(h.calls.request.length, 0);
});
test('sanitizes profile transport failures and logs nothing', async () => {
  const seen = []; const old = console.error; console.error = (...args) => seen.push(args); try { const h = harness({ profile: { emailAddress: `${LEAK}@example.com`, historyId: 'bad' } }); await rejected(() => h.service.deriveAuthority(operation())); assert.deepEqual(seen, []); } finally { console.error = old; }
});
test('post-load intrinsic poisoning preserves valid authority and rejects malformed profile evidence', async () => {
  const good = harness(); const badEmail = harness({ profile: { emailAddress: 'not-an-email', historyId: HISTORY } });
  const badHistory = harness({ profile: { emailAddress: EMAIL, historyId: '1e3' } });
  const originals = { test: RegExp.prototype.test, some: Array.prototype.some, Reflect: global.Reflect, Object: global.Object };
  let valid; let malformedEmail; let malformedHistory;
  try {
    RegExp.prototype.test = () => true; Array.prototype.some = () => false;
    global.Reflect = new Proxy({}, { get() { throw Error(LEAK); } }); global.Object = function PoisonedObject() { throw Error(LEAK); };
    valid = await good.service.deriveAuthority(operation());
    try { await badEmail.service.deriveAuthority(operation()); } catch (error) { malformedEmail = error; }
    try { await badHistory.service.deriveAuthority(operation()); } catch (error) { malformedHistory = error; }
  } finally { RegExp.prototype.test = originals.test; Array.prototype.some = originals.some; global.Reflect = originals.Reflect; global.Object = originals.Object; }
  assert.equal(valid.authority.cryptographically_verified, true);
  assert.equal(malformedEmail.code, 'GOOGLE_MAILBOX_AUTHORITY_COMPOSITION_FAILED');
  assert.equal(malformedHistory.code, 'GOOGLE_MAILBOX_AUTHORITY_COMPOSITION_FAILED');
});
test('rejects malformed signatureVerifier capability shape through genuine identity construction', async () => {
  const h = harness(); const timers = Object.freeze({ setTimeout() {}, clearTimeout() {} });
  const bad = [{ async verifySignature() {} }, Object.freeze({ extra: true, async verifySignature() {} }),
    new Proxy(Object.freeze({ async verifySignature() {} }), {})];
  const accessor = {}; Object.defineProperty(accessor, 'verifySignature', { enumerable: true, get() { return async () => {}; } }); Object.freeze(accessor); bad.push(accessor);
  for (const signatureVerifier of bad) assert.throws(() => createGoogleMailboxAuthorityComposition(config(), Object.freeze({ https: h.https, timers, signatureVerifier })));
  const signatureVerifier = Object.freeze({ async verifySignature() { return Object.freeze({ verified: true }); } });
  assert.throws(() => createGoogleMailboxAuthorityComposition(config(), Object.freeze({ signatureVerifier, timers, https: h.https })));
});
test('source imports only existing profile request and pure authority contract and contains no activation surface', async () => {
  const source = fs.readFileSync(require.resolve('./lib/email-google-mailbox-authority-composition'), 'utf8');
  const imports = [...source.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)].map(x => x[1]).sort(); assert.deepEqual(imports, ['./email-google-gmail-profile-request', './email-google-mailbox-authority-contract', './email-google-oidc-id-token']);
  for (const forbidden of [/process\.env/, /\b(?:pg|postgres|database|sql)\b/i, /express|router|staff-query-api/i, /createServer|listen\s*\(/, /console\./, /gmail\.send|messages\.send/i]) assert.equal(forbidden.test(source), false, `${forbidden}`);
});

(async () => { for (const { name, run } of tests) { await run(); process.stdout.write(`ok - ${name}\n`); } process.stdout.write(`PASS verify:email-google-mailbox-authority-composition (${tests.length} named offline tests)\n`); })().catch(error => { process.stderr.write(`${error && error.stack ? error.stack : error}\n`); process.exitCode = 1; });
