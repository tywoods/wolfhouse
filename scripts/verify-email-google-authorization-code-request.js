'use strict';

/**
 * RED-only offline contract for private Google authorization-code form construction.
 * The production owner is intentionally absent. No network, secret provider, route,
 * callback, database, telemetry, SDK, or deployment capability is exercised here.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Authentic RED: GREEN must provide this sole private form-construction owner.
const owner = require('./lib/email-google-authorization-code-request');
const { createGoogleAuthorizationCodeRequest } = owner;

const FAILURE_CODE = 'GOOGLE_AUTHORIZATION_CODE_REQUEST_FAILED';
const CLIENT_ID = '9876543210-web_client.v2.apps.googleusercontent.com';
const REDIRECT_URI = 'https://mail.example.test/private/google/callback';
const CODE = '4/0A+code%?=&!NEVER_LEAK_CODE';
const VERIFIER = `${'A'.repeat(41)}-._~`;
const SECRET = 'secret+/%?=&!NEVER_LEAK_SECRET';
const ACK = Object.freeze({ status: 'custodied' });
const SUCCESS_KEYS = ['status'];
const INPUT_KEYS = ['authorizationCode', 'codeVerifier', 'clientSecret'];
const FORM_KEYS = ['client_id', 'client_secret', 'grant_type', 'code', 'redirect_uri', 'code_verifier'];

function freeze(value) { return Object.freeze(value); }
function custody(fn = function exchangeAndCustody() { return ACK; }) {
  return freeze({ exchangeAndCustody: fn });
}
function configuration(exchangeCustody = custody(), patch = {}) {
  return freeze({ applicationClientId: CLIENT_ID, redirectUri: REDIRECT_URI, exchangeCustody, ...patch });
}
function input(patch = {}) {
  return freeze({ authorizationCode: CODE, codeVerifier: VERIFIER, clientSecret: SECRET, ...patch });
}
function service(exchangeCustody, patch) {
  return createGoogleAuthorizationCodeRequest(configuration(exchangeCustody, patch));
}
function expectedBody(code = CODE, verifier = VERIFIER, secret = SECRET, clientId = CLIENT_ID, redirect = REDIRECT_URI) {
  return new URLSearchParams([
    ['client_id', clientId], ['client_secret', secret], ['grant_type', 'authorization_code'],
    ['code', code], ['redirect_uri', redirect], ['code_verifier', verifier],
  ]).toString();
}
function codeForBodyBytes(target, secret = '%'.repeat(4096)) {
  const base = Buffer.byteLength(expectedBody('', VERIFIER, secret), 'ascii');
  for (let length = 1; length <= 8192; length += 1) {
    const encoded = (target - base - length) / 2;
    if (Number.isInteger(encoded) && encoded >= 0 && encoded <= length) {
      return `${'%'.repeat(encoded)}${'A'.repeat(length - encoded)}`;
    }
  }
  throw new Error(`boundary specimen unavailable: ${target}`);
}
async function cleanReject(action) {
  await assert.rejects(Promise.resolve().then(action), error => {
    assert.equal(error.code, FAILURE_CODE);
    assert.equal(error.message, FAILURE_CODE);
    const rendered = `${String(error)}\n${error.stack || ''}\n${JSON.stringify(error)}`;
    assert.equal(rendered.includes('NEVER_LEAK'), false);
    for (const key of ['authorizationCode', 'codeVerifier', 'clientSecret', 'body', 'code', 'client_secret']) {
      assert.equal(Object.hasOwn(error, key), false);
    }
    return true;
  });
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('exports only the frozen factory and returns an exact frozen one-shot owner', async () => {
  assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(Reflect.ownKeys(owner), ['createGoogleAuthorizationCodeRequest']);
  const exchange = service();
  assert.equal(Object.isFrozen(exchange), true);
  assert.deepEqual(Reflect.ownKeys(exchange), ['exchangeAuthorizationCode']);
});

test('constructs the exact canonical ordered Google form and forwards one frozen body', async () => {
  let calls = 0; let received;
  const exchangeCustody = custody(function exchangeAndCustody(dto) { calls += 1; received = dto; return ACK; });
  const result = await service(exchangeCustody).exchangeAuthorizationCode(input());
  assert.equal(calls, 1); assert.equal(Object.isFrozen(received), true);
  assert.deepEqual(Reflect.ownKeys(received), ['body']);
  assert.equal(received.body, expectedBody());
  assert.deepEqual([...new URLSearchParams(received.body)], [
    ['client_id', CLIENT_ID], ['client_secret', SECRET], ['grant_type', 'authorization_code'],
    ['code', CODE], ['redirect_uri', REDIRECT_URI], ['code_verifier', VERIFIER],
  ]);
  assert.deepEqual(Reflect.ownKeys(result), SUCCESS_KEYS); assert.equal(Object.isFrozen(result), true);
  assert.strictEqual(result, ACK, 'the exact sealed downstream acknowledgement is shared');
});

test('percent-encodes reserved characters without raw plus ambiguity and adds no optional fields', async () => {
  let body;
  await service(custody(dto => { ({ body } = dto); return ACK; })).exchangeAuthorizationCode(input());
  assert.match(body, /client_secret=secret%2B%2F%25%3F%3D%26%21NEVER_LEAK_SECRET/);
  assert.match(body, /code=4%2F0A%2Bcode%25%3F%3D%26%21NEVER_LEAK_CODE/);
  const form = new URLSearchParams(body);
  assert.deepEqual([...form.keys()], FORM_KEYS);
  for (const absent of ['scope', 'access_type', 'include_granted_scopes', 'nonce', 'state']) assert.equal(form.has(absent), false);
  assert.equal(form.get('code'), CODE); assert.equal(form.get('client_secret'), SECRET);
});

test('requires exact frozen ordered data-only configuration and exact sealed custody', async () => {
  const goodCustody = custody(); const good = configuration(goodCustody);
  const variants = [undefined, null, {}, { ...good }, freeze({ ...good, extra: true }),
    freeze({ redirectUri: REDIRECT_URI, applicationClientId: CLIENT_ID, exchangeCustody: goodCustody }),
    freeze(Object.assign(Object.create(null), good)),
    freeze({ applicationClientId: CLIENT_ID, redirectUri: REDIRECT_URI, exchangeCustody: { exchangeAndCustody() { return ACK; } } }),
    freeze({ applicationClientId: CLIENT_ID, redirectUri: REDIRECT_URI, exchangeCustody: freeze({ exchangeAndCustody() { return ACK; }, extra: true }) }),
    new Proxy(good, { ownKeys() { throw new Error(SECRET); } }),
  ];
  const accessor = {};
  Object.defineProperties(accessor, {
    applicationClientId: { enumerable: true, get() { throw new Error(SECRET); } },
    redirectUri: { enumerable: true, value: REDIRECT_URI }, exchangeCustody: { enumerable: true, value: goodCustody },
  }); Object.freeze(accessor); variants.push(accessor);
  for (const value of variants) assert.throws(() => createGoogleAuthorizationCodeRequest(value), { code: FAILURE_CODE });
});

test('pins custody method and receiver at factory construction', async () => {
  let receiver; let originalCalls = 0; let replacementCalls = 0;
  const exchangeCustody = custody(function exchangeAndCustody() { receiver = this; originalCalls += 1; return ACK; });
  const exchange = service(exchangeCustody);
  assert.throws(() => { exchangeCustody.exchangeAndCustody = () => { replacementCalls += 1; return ACK; }; }, TypeError);
  await exchange.exchangeAuthorizationCode(input());
  assert.equal(receiver, exchangeCustody); assert.equal(originalCalls, 1); assert.equal(replacementCalls, 0);

  let trapped = 0; let invoked = 0;
  function pinned() { invoked += 1; return ACK; }
  Object.defineProperty(pinned, 'call', { value() { trapped += 1; return ACK; } });
  await service(custody(pinned)).exchangeAuthorizationCode(input());
  assert.equal(invoked, 1); assert.equal(trapped, 0, 'forwarding must not trust a function-owned call property');
});

test('accepts broad bounded canonical Google web client IDs without UUID overfit', async () => {
  for (const applicationClientId of ['1-a.apps.googleusercontent.com', 'Client_9.web-v2.apps.googleusercontent.com']) {
    let body; await service(custody(dto => { ({ body } = dto); return ACK; }), { applicationClientId })
      .exchangeAuthorizationCode(input());
    assert.equal(new URLSearchParams(body).get('client_id'), applicationClientId);
  }
  for (const applicationClientId of ['', '.apps.googleusercontent.com', 'bad.example.com', 'bad space.apps.googleusercontent.com',
    'bad/.apps.googleusercontent.com', 'bad?.apps.googleusercontent.com', 'bad#.apps.googleusercontent.com',
    'é.apps.googleusercontent.com', `${'a'.repeat(256)}.apps.googleusercontent.com`]) {
    assert.throws(() => service(custody(), { applicationClientId }), { code: FAILURE_CODE });
  }
});

test('accepts only bounded canonical HTTPS redirect URLs and retains the exact configured string', async () => {
  const redirects = ['https://example.test/', 'https://example.test/oauth/google/callback', 'https://xn--bcher-kva.example/cb'];
  for (const redirectUri of redirects) {
    let body; await service(custody(dto => { ({ body } = dto); return ACK; }), { redirectUri }).exchangeAuthorizationCode(input());
    assert.equal(new URLSearchParams(body).get('redirect_uri'), redirectUri);
  }
  for (const redirectUri of ['', 'http://example.test/cb', 'https://user:pass@example.test/cb', 'https://example.test/cb#x',
    'https://example.test/cb?x=1', 'https://EXAMPLE.test/cb', 'https://example.test:443/cb', 'https://example.test:8443/cb',
    'https://example.test/a/../cb', `https://example.test/${'a'.repeat(2049)}`]) {
    assert.throws(() => service(custody(), { redirectUri }), { code: FAILURE_CODE });
  }
});

test('requires exact frozen ordered input and burns before hostile reflection', async () => {
  const bad = [undefined, null, {}, { ...input() }, freeze({ ...input(), extra: true }),
    freeze({ codeVerifier: VERIFIER, authorizationCode: CODE, clientSecret: SECRET }),
    freeze(Object.assign(Object.create(null), input())), freeze({ authorizationCode: CODE, codeVerifier: VERIFIER, clientSecret: SECRET, [Symbol('x')]: true }),
    new Proxy(input(), { getPrototypeOf() { throw new Error(CODE); } })];
  const accessor = { codeVerifier: VERIFIER, clientSecret: SECRET };
  Object.defineProperty(accessor, 'authorizationCode', { enumerable: true, get() { throw new Error(CODE); } }); Object.freeze(accessor); bad.push(accessor);
  for (const value of bad) { let calls = 0; const exchange = service(custody(() => { calls += 1; return ACK; })); await cleanReject(() => exchange.exchangeAuthorizationCode(value)); await cleanReject(() => exchange.exchangeAuthorizationCode(input())); assert.equal(calls, 0); }
});

test('validates authorization code as visible ASCII 1..8192', async () => {
  for (const authorizationCode of ['', 'bad\n', 'é', 'a'.repeat(8193), 7]) {
    let calls = 0; await cleanReject(() => service(custody(() => { calls += 1; return ACK; })).exchangeAuthorizationCode(input({ authorizationCode }))); assert.equal(calls, 0);
  }
  await service().exchangeAuthorizationCode(input({ authorizationCode: 'a'.repeat(8192) }));
});

test('validates RFC7636 unreserved PKCE verifier at 43..128 characters', async () => {
  for (const codeVerifier of ['A'.repeat(42), 'A'.repeat(129), `${'A'.repeat(42)}+`, `${'A'.repeat(42)}%`, 'é'.repeat(43), 7]) {
    await cleanReject(() => service().exchangeAuthorizationCode(input({ codeVerifier })));
  }
  for (const codeVerifier of ['A'.repeat(43), `${'A'.repeat(124)}-._~`]) await service().exchangeAuthorizationCode(input({ codeVerifier }));
});

test('validates client secret as visible ASCII 1..4096', async () => {
  for (const clientSecret of ['', 'bad\n', 'é', 'x'.repeat(4097), 7]) await cleanReject(() => service().exchangeAuthorizationCode(input({ clientSecret })));
  await service().exchangeAuthorizationCode(input({ clientSecret: 'x'.repeat(4096) }));
});

test('snapshots all input and configuration values before downstream reentrant mutation', async () => {
  const mutableInput = input(); let body;
  const exchangeCustody = custody(dto => {
    body = dto.body;
    assert.throws(() => { mutableInput.authorizationCode = 'changed'; }, TypeError);
    return ACK;
  });
  await service(exchangeCustody).exchangeAuthorizationCode(mutableInput);
  assert.equal(body, expectedBody());
});

test('permits exactly 32768 encoded ASCII bytes and rejects encoded boundary plus one before custody', async () => {
  const boundarySecret = '%'.repeat(4096);
  const exactCode = codeForBodyBytes(32768, boundarySecret); let calls = 0; let body;
  await service(custody(dto => { calls += 1; ({ body } = dto); return ACK; }))
    .exchangeAuthorizationCode(input({ authorizationCode: exactCode, clientSecret: boundarySecret }));
  assert.equal(Buffer.byteLength(body, 'ascii'), 32768); assert.equal(calls, 1);
  const overCode = codeForBodyBytes(32769, boundarySecret); calls = 0;
  await cleanReject(() => service(custody(() => { calls += 1; return ACK; }))
    .exchangeAuthorizationCode(input({ authorizationCode: overCode, clientSecret: boundarySecret })));
  assert.equal(calls, 0);
});

test('requires the exact frozen custody acknowledgement and masks throws, thenables, and malformed values', async () => {
  const malformed = [undefined, null, {}, { status: 'custodied' }, freeze({ status: 'wrong' }),
    freeze({ status: 'custodied', extra: true }), freeze(Object.assign(Object.create(null), { status: 'custodied' })),
    freeze({ then(resolve) { resolve(ACK); } })];
  for (const value of malformed) await cleanReject(() => service(custody(() => value)).exchangeAuthorizationCode(input()));
  await cleanReject(() => service(custody(() => { throw new Error(`${CODE}:${SECRET}`); })).exchangeAuthorizationCode(input()));
  await cleanReject(() => service(custody(() => Promise.reject(new Error(`${CODE}:${SECRET}`)))).exchangeAuthorizationCode(input()));
});

test('rejects concurrent and reentrant reuse, calls custody once, and emits no secret-bearing logs', async () => {
  const logged = []; const originalLog = console.log; const originalError = console.error;
  console.log = console.error = (...values) => logged.push(values);
  try {
    let release; let calls = 0; let exchange;
    const waiting = new Promise(resolve => { release = resolve; });
    const exchangeCustody = custody(async () => {
      calls += 1; await cleanReject(() => exchange.exchangeAuthorizationCode(input())); await waiting; return ACK;
    });
    exchange = service(exchangeCustody);
    const pending = exchange.exchangeAuthorizationCode(input());
    await cleanReject(() => exchange.exchangeAuthorizationCode(input())); release();
    assert.strictEqual(await pending, ACK); assert.equal(calls, 1); assert.deepEqual(logged, []);
  } finally { console.log = originalLog; console.error = originalError; }
});

(async () => {
  for (const { name, run } of tests) { await run(); process.stdout.write(`ok - ${name}\n`); }
  const source = fs.readFileSync(require.resolve('./lib/email-google-authorization-code-request'), 'utf8');
  for (const forbidden of [/node:https/, /googleapis/, /process\.env/, /secretProvider/, /telemetry/i, /console\./,
    /database|postgres|callback|state|nonce/i, /access_type|include_granted_scopes|\bscope\b/]) {
    assert.equal(forbidden.test(source), false, `forbidden capability or form field: ${forbidden}`);
  }
  assert.equal(tests.length, 15);
  console.log('PASS verify:email-google-authorization-code-request (15 tests)');
})().catch(error => { console.error(error); process.exitCode = 1; });
