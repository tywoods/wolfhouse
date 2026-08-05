'use strict';

const assert = require('assert/strict');
const { createMicrosoftOidcIdTokenValidator } = require('./lib/email-microsoft-oidc-id-token');

const NOW = 1900000000;
const TID = '01234567-89ab-4def-8123-456789abcdef';
const NONCE = 'nonce-secret-never-leak';
const CLIENT = 'client-id';
const LEAK = 'JWT-CLAIMS-SECRET-DO-NOT-LEAK';
const baseClaims = { tid: TID, oid: 'principal-1', sub: 'subject-1', aud: CLIENT, nonce: NONCE,
  iss: `https://login.microsoftonline.com/${TID}/v2.0`, exp: NOW + 600, iat: NOW - 10, nbf: NOW - 10 };
const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
function token(header = { alg: 'RS256', kid: 'key-1', typ: 'JWT' }, claims = baseClaims, signature = Buffer.from([0, 1, 2, 254, 255])) {
  return `${b64(header)}.${b64(claims)}.${Buffer.from(signature).toString('base64url')}`;
}
function verifier(spec = {}) {
  const calls = [];
  const dependency = Object.freeze({ async verify(request) {
    calls.push({ request, thisValue: this });
    if (spec.throw) throw new Error(`${LEAK} verifier`);
    if (spec.wait) await spec.wait;
    return spec.ack === undefined ? Object.seal({ verified: true }) : spec.ack;
  } });
  return { dependency, calls };
}
function service(spec) { const v = verifier(spec); return { validator: createMicrosoftOidcIdTokenValidator({ signatureVerifier: v.dependency }), ...v }; }
const input = (idToken = token(), patch = {}) => ({ idToken, expectedNonce: NONCE, expectedClientId: CLIENT, nowEpochSeconds: NOW, ...patch });
async function rejected(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'MicrosoftOidcIdTokenError'); assert.equal(error.code, 'MICROSOFT_OIDC_ID_TOKEN_INVALID');
    assert.equal(error.message, 'Microsoft OIDC ID token validation failed.'); assert.deepEqual(Object.keys(error), ['code']);
    assert(!String(error.stack).includes(LEAK) && !String(error).includes(NONCE)); return true;
  });
}

async function main() {
  const exported = require('./lib/email-microsoft-oidc-id-token');
  assert.deepEqual(Object.keys(exported), ['createMicrosoftOidcIdTokenValidator']); assert(Object.isFrozen(exported));
  const good = service(); const result = await good.validator.validate(input());
  assert.deepEqual(result, { providerTenantId: TID, providerPrincipalId: 'principal-1' });
  assert.deepEqual(Object.keys(result), ['providerTenantId', 'providerPrincipalId']); assert(Object.isFrozen(result));
  assert(!('idToken' in result) && !('claims' in result) && !('nonce' in result));
  assert.equal(good.calls.length, 1); assert.equal(good.calls[0].thisValue, good.dependency); assert(Object.isFrozen(good.calls[0].request));
  assert.equal(good.calls[0].request.signingInput, token().split('.').slice(0, 2).join('.'));
  assert.deepEqual(good.calls[0].request.signature, Buffer.from([0, 1, 2, 254, 255]));
  assert.deepEqual({ alg: good.calls[0].request.alg, kid: good.calls[0].request.kid }, { alg: 'RS256', kid: 'key-1' });

  for (const deps of [null, {}, { signatureVerifier: {} }, { signatureVerifier: { verify() {} } },
    { signatureVerifier: Object.freeze({ verify: 1 }) }, { signatureVerifier: Object.freeze({ verify() {}, extra: 1 }) }]) {
    assert.throws(() => createMicrosoftOidcIdTokenValidator(deps), (e) => e.code === 'MICROSOFT_OIDC_ID_TOKEN_INVALID');
  }
  const accessor = {}; Object.defineProperty(accessor, 'signatureVerifier', { get() { throw new Error(LEAK); }, enumerable: true });
  assert.throws(() => createMicrosoftOidcIdTokenValidator(accessor), (e) => e.code === 'MICROSOFT_OIDC_ID_TOKEN_INVALID');

  // Atomic burn, including concurrent calls.
  const once = service(); await rejected(once.validator.validate(input('bad'))); await rejected(once.validator.validate(input()));
  let release; const waiting = new Promise((resolve) => { release = resolve; }); const concurrent = service({ wait: waiting });
  const first = concurrent.validator.validate(input()); await rejected(concurrent.validator.validate(input())); release(); await first;

  // Exact input and bounds.
  for (const bad of [null, {}, [], { ...input(), extra: 1 }, { ...input(), nowEpochSeconds: 1.5 },
    { ...input(), expectedNonce: '' }, { ...input(), expectedClientId: '' }, { ...input(), idToken: 'x'.repeat(32769) }]) await rejected(service().validator.validate(bad));

  // Compact/canonical bounded base64url and UTF-8/JSON hostility.
  const malformed = ['', 'a.b', 'a.b.c.d', '=.eA.eA', 'eA=.eA.eA', 'A.eA.eA',
    `${b64('{')}.${b64(baseClaims)}.AA`, `${b64('{"alg":"RS256","kid":"k"}')}..AA`,
    `${b64('{"alg":"RS256","kid":"k"}')}.${Buffer.from([0xff]).toString('base64url')}.AA`,
    `${'A'.repeat(2049)}.${b64(baseClaims)}.AA`, `${b64({ alg: 'RS256', kid: 'k' })}.${b64(baseClaims)}.${'A'.repeat(2049)}`];
  for (const jwt of malformed) await rejected(service().validator.validate(input(jwt)));
  const strictJson = [
    '{"alg":"RS256","alg":"none","kid":"k"}', '{"alg":"RS256","kid":"k","__proto__":1}',
    '{"alg":"RS256","kid":"k","nested":{"\\u0063onstructor":1}}', '{"alg":"RS256","kid":"x\\ud800"}',
  ];
  for (const rawHeader of strictJson) await rejected(service().validator.validate(input(`${b64(rawHeader)}.${b64(baseClaims)}.AA`)));
  for (const rawClaims of ['{"tid":"a","tid":"b"}', '{"nested":{"prototype":1}}', '{"oid":"x\\udc00"}'])
    await rejected(service().validator.validate(input(`${b64({ alg: 'RS256', kid: 'k' })}.${b64(rawClaims)}.AA`)));

  for (const header of [{ alg: 'none', kid: 'k' }, { alg: 'RS256' }, { alg: 'RS256', kid: '' },
    { alg: 'RS256', kid: 'x'.repeat(257) }, { alg: 'RS256', kid: 'k', typ: 'jwt' }, { alg: ['RS256'], kid: 'k' },
    { alg: 'RS256', kid: 'k', crit: [] }, { alg: 'RS256', kid: 'k', crit: ['future'], future: true },
    { alg: 'RS256', kid: 'k', crit: ['b64'], b64: true }, { alg: 'RS256', kid: 'k', crit: ['b64'], b64: false }])
    await rejected(service().validator.validate(input(token(header))));

  const claimMutations = [
    { tid: TID.toUpperCase() }, { tid: 'not-uuid' }, { oid: '' }, { oid: 1 }, { sub: '' }, { sub: 1 },
    { sub: 'bad\nsubject' }, { sub: 'x'.repeat(257) },
    { aud: [CLIENT] }, { aud: 'other' }, { nonce: 'other' }, { iss: `https://login.microsoftonline.com/${TID}/v2.0/` },
    { azp: 'other' }, { azp: [CLIENT] }, { exp: NOW - 301 }, { exp: NOW + 10, iat: NOW + 11 },
    { iat: NOW + 301 }, { nbf: NOW + 301 }, { exp: NOW + 86401, iat: NOW }, { exp: 1.5 }, { nbf: null },
  ];
  for (const patch of claimMutations) await rejected(service().validator.validate(input(token(undefined, { ...baseClaims, ...patch }))));
  const missingSub = { ...baseClaims }; delete missingSub.sub;
  await rejected(service().validator.validate(input(token(undefined, missingSub))));
  await rejected(service().validator.validate(input(`${b64({ alg: 'RS256', kid: 'k' })}.${b64('{"tid":"01234567-89ab-4def-8123-456789abcdef","oid":"x","sub":"x\\ud800"}')}.AA`)));
  assert.deepEqual(await service().validator.validate(input(token(undefined, { ...baseClaims, azp: CLIENT }))), result);

  // Verification is mandatory and all verifier failures/ack tricks are masked. No claims return before it resolves.
  await rejected(service({ throw: true }).validator.validate(input(token(undefined, { ...baseClaims, oid: LEAK }))));
  for (const ack of [undefined, null, true, {}, { verified: true }, Object.seal({ verified: false }),
    Object.seal({ verified: true, extra: 1 }), Object.freeze(Object.create(null, { verified: { value: true } }))]) {
    if (ack === undefined) continue;
    await rejected(service({ ack }).validator.validate(input()));
  }
  let openRelease; const blocker = new Promise((resolve) => { openRelease = resolve; }); const bound = service({ wait: blocker });
  let settled = false; const pending = bound.validator.validate(input()).then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false); openRelease(); await pending; assert.equal(settled, true);

  console.log('PASS verify:email-microsoft-oidc-id-token (offline hostile signature-bound claims gate)');
}
main().catch((error) => { console.error('FAIL verify:email-microsoft-oidc-id-token:', error?.message || 'unknown'); process.exitCode = 1; });
