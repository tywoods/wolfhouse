'use strict';

/**
 * RED-only offline contract for Google token-response parsing and the custody handoff.
 * The missing owner consumes an already-buffered transport DTO. It does not exchange
 * authorization codes and does not own HTTP, credentials, persistence, or telemetry.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createGoogleVerifiedGrantComposition } = require('./lib/email-google-verified-grant-composition');
const { GOOGLE_PHASE_A_SCOPES } = require('./lib/email-google-verified-grant-custody');

// Authentic RED: production must add this sole missing owner.
const owner = require('./lib/email-google-token-response-custody');
const { createGoogleTokenResponseCustody } = owner;

const FAILURE_CODE = 'GOOGLE_TOKEN_RESPONSE_CUSTODY_FAILED';
const ACCESS = 'GOOGLE_RESPONSE_ACCESS_SECRET_NEVER_LEAK';
const REFRESH = 'GOOGLE_RESPONSE_REFRESH_SECRET_NEVER_LEAK';
const ID_TOKEN = 'header.GOOGLE_RESPONSE_ID_SECRET_NEVER_LEAK.signature';
const LEAK = 'HOSTILE_RESPONSE_SECRET_NEVER_LEAK';
const SCOPE = GOOGLE_PHASE_A_SCOPES.join(' ');
const INPUT_KEYS = ['statusCode', 'contentType', 'body'];
const SELECTED_KEYS = ['accessToken', 'refreshToken', 'tokenType', 'expiresIn', 'scope', 'idToken'];
const GOOD = {
  access_token: ACCESS,
  expires_in: 3600,
  refresh_token: REFRESH,
  scope: SCOPE,
  token_type: 'Bearer',
  id_token: ID_TOKEN,
};
function frozenInput(body = JSON.stringify(GOOD), patch = {}) {
  return Object.freeze({ statusCode: 200, contentType: 'application/json; charset=utf-8', body, ...patch });
}
function config(acceptValidatedTokens) {
  return Object.freeze({ custody: Object.freeze({ acceptValidatedTokens }) });
}
function cleanError(error) {
  assert.equal(error.code, FAILURE_CODE);
  assert.equal(error.message, FAILURE_CODE);
  const rendered = `${String(error)}\n${error.stack || ''}\n${JSON.stringify(error)}`;
  for (const secret of [ACCESS, REFRESH, ID_TOKEN, LEAK]) assert.equal(rendered.includes(secret), false);
  for (const key of ['access_token', 'refresh_token', 'id_token', 'accessToken', 'refreshToken', 'idToken']) {
    assert.equal(Object.hasOwn(error, key), false);
  }
  return true;
}
async function rejects(input, accept = async () => Object.freeze({ status: 'accepted' })) {
  let calls = 0;
  const service = createGoogleTokenResponseCustody(config(async value => { calls += 1; return accept(value); }));
  await assert.rejects(service.acceptTokenResponse(input), cleanError);
  assert.ok(calls <= 1);
  return calls;
}
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('exports only the frozen factory and returns an exact frozen one-shot owner', async () => {
  assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(Reflect.ownKeys(owner), ['createGoogleTokenResponseCustody']);
  const service = createGoogleTokenResponseCustody(config(async () => Object.freeze({ status: 'accepted' })));
  assert.equal(Object.isFrozen(service), true);
  assert.deepEqual(Reflect.ownKeys(service), ['acceptTokenResponse']);
});

test('pins the exact frozen custody receiver and hands off exact frozen selected DTO', async () => {
  let calls = 0; let received; let receiver;
  const custody = Object.freeze({ async acceptValidatedTokens(value) {
    calls += 1; received = value; receiver = this;
    assert.throws(() => { value.accessToken = 'changed'; });
    return Object.freeze({ status: 'accepted' });
  } });
  const service = createGoogleTokenResponseCustody(Object.freeze({ custody }));
  const result = await service.acceptTokenResponse(frozenInput());
  assert.equal(calls, 1); assert.equal(receiver, custody);
  assert.equal(Object.isFrozen(received), true);
  assert.deepEqual(Reflect.ownKeys(received), SELECTED_KEYS);
  assert.deepEqual(received, Object.freeze({ accessToken: ACCESS, refreshToken: REFRESH,
    tokenType: 'Bearer', expiresIn: 3600, scope: SCOPE, idToken: ID_TOKEN }));
  assert.deepEqual(result, { status: 'custodied' });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(Reflect.ownKeys(result), ['status']);
  assert.equal(JSON.stringify(result).includes(ACCESS), false);
});

test('factory requires exact frozen data-only config/custody and pins method at creation', async () => {
  const good = async () => Object.freeze({ status: 'accepted' });
  const bad = [undefined, null, {}, Object.freeze({}), { custody: Object.freeze({ acceptValidatedTokens: good }) },
    Object.freeze({ custody: { acceptValidatedTokens: good } }),
    Object.freeze({ custody: Object.freeze({ acceptValidatedTokens: good }), extra: true }),
    Object.freeze({ custody: Object.freeze({ acceptValidatedTokens: good, extra: true }) }),
    Object.freeze({ custody: Object.freeze({ acceptValidatedTokens: 1 }) }),
    Object.freeze(Object.create(null)),
    new Proxy({}, { ownKeys() { throw new Error(LEAK); } }),
    Object.freeze({ get custody() { throw new Error(LEAK); } }),
  ];
  for (const value of bad) assert.throws(() => createGoogleTokenResponseCustody(value), cleanError);
  let original = 0; let replacement = 0;
  const custody = { async acceptValidatedTokens() { original += 1; return Object.freeze({ status: 'accepted' }); } };
  Object.freeze(custody);
  const service = createGoogleTokenResponseCustody(Object.freeze({ custody }));
  assert.throws(() => { custody.acceptValidatedTokens = async () => { replacement += 1; }; });
  await service.acceptTokenResponse(frozenInput());
  assert.equal(original, 1); assert.equal(replacement, 0);
});

test('burns one-shot before any hostile input reflection, including concurrent and reentrant calls', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  const service = createGoogleTokenResponseCustody(config(async () => { calls += 1; await gate; return Object.freeze({ status: 'accepted' }); }));
  const first = service.acceptTokenResponse(frozenInput());
  await Promise.resolve();
  await assert.rejects(service.acceptTokenResponse(frozenInput()), cleanError);
  release(); await first; assert.equal(calls, 1);

  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error(LEAK); }, ownKeys() { throw new Error(LEAK); } });
  const burned = createGoogleTokenResponseCustody(config(async () => Object.freeze({ status: 'accepted' })));
  await assert.rejects(burned.acceptTokenResponse(hostile), cleanError);
  await assert.rejects(burned.acceptTokenResponse(frozenInput()), cleanError);

  let reentrant;
  const reentrantService = createGoogleTokenResponseCustody(config(async () => {
    reentrant = reentrantService.acceptTokenResponse(frozenInput());
    return Object.freeze({ status: 'accepted' });
  }));
  await reentrantService.acceptTokenResponse(frozenInput());
  await assert.rejects(reentrant, cleanError);
});

test('requires exact frozen ordered data-only transport DTO', async () => {
  const body = JSON.stringify(GOOD);
  const cases = [
    { statusCode: 200, contentType: 'application/json', body },
    Object.freeze({ contentType: 'application/json', statusCode: 200, body }),
    Object.freeze({ statusCode: 200, contentType: 'application/json', body, extra: 1 }),
    Object.freeze(Object.assign(Object.create(null), { statusCode: 200, contentType: 'application/json', body })),
    Object.freeze(Object.defineProperty({ statusCode: 200, contentType: 'application/json' }, 'body', { get() { throw new Error(LEAK); }, enumerable: true })),
    new Proxy(frozenInput(), { ownKeys() { throw new Error(LEAK); } }),
  ];
  for (const value of cases) assert.equal(await rejects(value), 0);
  assert.deepEqual(Reflect.ownKeys(frozenInput()), INPUT_KEYS);
});

test('rejects wrong HTTP status/content type and malformed or unsafe UTF-8 JSON bodies', async () => {
  for (const input of [
    frozenInput(undefined, { statusCode: 201 }), frozenInput(undefined, { statusCode: '200' }),
    frozenInput(undefined, { contentType: 'text/json' }), frozenInput(undefined, { contentType: 'application/json; charset=latin1' }),
    frozenInput(undefined, { contentType: 'application/json; charset=utf-8; x=y' }), frozenInput(''), frozenInput(' '),
    frozenInput('{'), frozenInput(`${JSON.stringify(GOOD)} trailing`), frozenInput('\ufeff' + JSON.stringify(GOOD)),
    frozenInput(JSON.stringify(GOOD) + '\ud800'), frozenInput(JSON.stringify({ ...GOOD, access_token: '\ufffd' })),
    frozenInput(JSON.stringify({ ...GOOD, access_token: '\ud800' })),
  ]) assert.equal(await rejects(input), 0);
  for (const type of ['application/json', 'APPLICATION/JSON', 'application/json;charset=UTF-8', 'application/json ; charset = utf-8']) {
    const svc = createGoogleTokenResponseCustody(config(async () => Object.freeze({ status: 'accepted' })));
    assert.deepEqual(await svc.acceptTokenResponse(frozenInput(undefined, { contentType: type })), { status: 'custodied' });
  }
});

test('enforces nonempty <=65536 UTF-8 bytes independently of JavaScript length', async () => {
  const make = bytes => {
    const base = JSON.stringify({ ...GOOD, id_token: ID_TOKEN, scope: SCOPE, padding: '' });
    return base.replace('"padding":""', `"padding":"${'p'.repeat(bytes - Buffer.byteLength(base))}"`);
  };
  // Unknown padding is rejected by field policy even at cap; cap+1 must also reject before custody.
  assert.equal(Buffer.byteLength(make(65536)), 65536);
  assert.equal(Buffer.byteLength(make(65537)), 65537);
  assert.equal(await rejects(frozenInput(make(65536))), 0);
  assert.equal(await rejects(frozenInput(make(65537))), 0);
  assert.equal(await rejects(frozenInput('😀'.repeat(16385))), 0);
});

test('rejects duplicate top-level names including escaped-equivalent and prototype hazards', async () => {
  const prefix = JSON.stringify(GOOD).slice(1, -1);
  for (const body of [
    `{${prefix},"token_type":"Bearer"}`,
    `{${prefix},"token_ty\\u0070e":"Bearer"}`,
    `{${prefix},"access_\\u0074oken":"other"}`,
    `{${prefix},"__proto__":{}}`, `{${prefix},"prototype":{}}`, `{${prefix},"constructor":{}}`,
    `{${prefix},"\\u005f_proto__":{}}`,
  ]) assert.equal(await rejects(frozenInput(body)), 0);
});

test('allows exactly six Google success fields and rejects every unknown/optional field', async () => {
  for (const key of ['refresh_token_expires_in', 'expires', 'client_info', 'issued_token_type', 'future_extension']) {
    assert.equal(await rejects(frozenInput(JSON.stringify({ ...GOOD, [key]: 604800 }))), 0);
  }
  for (const key of Object.keys(GOOD)) {
    const value = { ...GOOD }; delete value[key];
    assert.equal(await rejects(frozenInput(JSON.stringify(value))), 0);
  }
});

test('validates token fields, expiry, compact id token, and delegates exact scope authority', async () => {
  const bad = [
    { token_type: 'bearer' }, { token_type: 'Basic' }, { expires_in: 0 }, { expires_in: 86401 },
    { expires_in: 1.5 }, { expires_in: '3600' }, { access_token: '' }, { access_token: 'a b' },
    { access_token: 'a\n' }, { access_token: 'é' }, { access_token: 'a'.repeat(8193) },
    { refresh_token: '' }, { refresh_token: 'r'.repeat(8193) }, { id_token: '' },
    { id_token: 'two.parts' }, { id_token: 'four.parts.are.bad' }, { id_token: 'a b.c.d' },
    { id_token: 'é.b.c' }, { id_token: 'a'.repeat(32767) + '.b.c' },
    { scope: 'openid email' }, { scope: `${SCOPE} https://www.googleapis.com/auth/gmail.send` },
    { scope: SCOPE.replace(' ', '  ') }, { scope: SCOPE.split(' ').reverse().join(' ') + ' openid' },
  ];
  for (const patch of bad) assert.equal(await rejects(frozenInput(JSON.stringify({ ...GOOD, ...patch }))), 0);
  for (const patch of [{ expires_in: 1 }, { expires_in: 86400 }, { access_token: 'a'.repeat(8192) },
    { refresh_token: 'r'.repeat(8192) }, { id_token: `a.${'b'.repeat(32764)}.c` },
    { scope: GOOGLE_PHASE_A_SCOPES.slice().reverse().join(' ') }]) {
    let selected;
    const svc = createGoogleTokenResponseCustody(config(async value => { selected = value; return Object.freeze({ status: 'accepted' }); }));
    await svc.acceptTokenResponse(frozenInput(JSON.stringify({ ...GOOD, ...patch })));
    assert.equal(selected.scope, SCOPE);
  }
});

test('requires exact frozen synchronous custody acknowledgement and sanitizes throw/thenable failures', async () => {
  for (const ack of [null, {}, { status: 'accepted' }, Object.freeze({ status: 'accepted', extra: true }),
    Object.freeze({ status: 'rejected' }), Object.freeze(Object.assign(Object.create(null), { status: 'accepted' }))]) {
    assert.equal(await rejects(frozenInput(), async () => ack), 1);
  }
  assert.equal(await rejects(frozenInput(), async () => { throw new Error(`${LEAK}:${ACCESS}`); }), 1);
  assert.equal(await rejects(frozenInput(), () => ({ then() { throw new Error(`${LEAK}:${REFRESH}`); } })), 1);
});

test('is structurally compatible with the real composition custody contract and remains offline-only', async () => {
  assert.equal(typeof createGoogleVerifiedGrantComposition, 'function');
  assert.deepEqual(GOOGLE_PHASE_A_SCOPES, Object.freeze(['openid', 'email',
    'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose']));
  const source = fs.readFileSync(path.join(__dirname, 'lib/email-google-token-response-custody.js'), 'utf8');
  for (const forbidden of ['node:https', 'https.request', 'oauth2.googleapis.com/token', 'client_secret',
    'authorization_code', 'googleapis', 'process.env', 'express', 'router', 'database', 'postgres',
    'console.', 'fetch(']) assert.equal(source.includes(forbidden), false, forbidden);
  const imports = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
  assert.deepEqual(imports, ['./email-google-verified-grant-custody']);
});

(async () => {
  const originalLog = console.log; const originalError = console.error; const logs = [];
  console.log = console.error = (...args) => logs.push(args);
  try {
    for (const { name, run } of tests) { await run(); originalLog(`ok - ${name}`); }
    for (const entry of logs) {
      const rendered = entry.map(String).join(' ');
      for (const secret of [ACCESS, REFRESH, ID_TOKEN, LEAK]) assert.equal(rendered.includes(secret), false);
    }
  } finally { console.log = originalLog; console.error = originalError; }
  originalLog(`verify:email-google-token-response-custody: ok (${tests.length} tests)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
