'use strict';

/**
 * Strict RED-only offline tracer for the one-shot Gmail getProfile network owner.
 * Production owner intentionally does not exist. This performs no live request,
 * route wiring, persistence, secret lookup, SDK use, installation, or deployment.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

// Authentic RED: GREEN must introduce exactly this private owner.
const owner = require('./lib/email-google-gmail-profile-request');
const { createGoogleGmailProfileRequest } = owner;

const FAILURE = 'GOOGLE_GMAIL_PROFILE_REQUEST_FAILED';
const TOKEN = `ya29.${'A'.repeat(40)}-NEVER_LEAK_ACCESS_TOKEN`;
const CONFIGURATION = Object.freeze({ requestTimeoutMs: 5000, responseBytesMax: 16384 });
const PROFILE = Object.freeze({ emailAddress: 'Owner.Case@example.test', historyId: '9876543210123456789' });
const SOURCE = JSON.stringify({ emailAddress: PROFILE.emailAddress, messagesTotal: 41, threadsTotal: 17, historyId: PROFILE.historyId });

function response(statusCode = 200, headers = { 'content-type': 'application/json; charset=UTF-8' }) {
  const value = new EventEmitter();
  value.statusCode = statusCode;
  value.headers = headers;
  value.destroyed = false;
  value.destroy = function destroy(error) { this.destroyed = true; this.destroyError = error; };
  return value;
}

function harness(overrides = {}) {
  const calls = []; const timers = [];
  const https = Object.freeze({
    request(options, callback) {
      const request = new EventEmitter();
      Object.assign(request, {
        destroyed: false, ended: 0,
        destroy(error) { this.destroyed = true; this.destroyError = error; },
        end(body) { this.ended += 1; this.body = body; },
      });
      calls.push({ options, callback, request });
      return request;
    },
    ...overrides.https,
  });
  const timersApi = Object.freeze({
    setTimeout(fn, ms) { const handle = { fn, ms, cleared: 0 }; timers.push(handle); return handle; },
    clearTimeout(handle) { handle.cleared += 1; },
    ...overrides.timers,
  });
  return { calls, timers, dependencies: Object.freeze({ https, timers: timersApi }) };
}
function service(h = harness()) { return { h, request: createGoogleGmailProfileRequest(CONFIGURATION, h.dependencies) }; }
function input(accessToken = TOKEN) { return Object.freeze({ accessToken }); }
function complete(h, body = SOURCE, specimen = response()) {
  h.calls[0].callback(specimen); specimen.emit('data', Buffer.from(body)); specimen.emit('end'); return specimen;
}
async function cleanReject(action) {
  await assert.rejects(Promise.resolve().then(action), error => {
    assert.equal(error.code, FAILURE); assert.equal(error.message, FAILURE);
    assert.deepEqual(Reflect.ownKeys(error), ['stack', 'message', 'code']);
    const rendered = `${String(error)}\n${error.stack || ''}\n${JSON.stringify(error)}`;
    assert.equal(rendered.includes('NEVER_LEAK'), false);
    for (const key of ['accessToken', 'token', 'body', 'response']) assert.equal(Object.hasOwn(error, key), false);
    return true;
  });
}
const tests = []; function test(name, run) { tests.push({ name, run }); }

test('exports only a frozen factory and constructs an exact frozen one-shot owner without effects', () => {
  assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(Reflect.ownKeys(owner), ['createGoogleGmailProfileRequest']);
  const { h, request } = service();
  assert.equal(Object.isFrozen(request), true); assert.deepEqual(Reflect.ownKeys(request), ['getProfile']);
  assert.equal(h.calls.length, 0); assert.equal(h.timers.length, 0);
});

test('requires exact frozen ordered configuration and exact frozen ordered dependencies', () => {
  const h = harness();
  const badConfigurations = [undefined, null, {}, { ...CONFIGURATION }, Object.freeze({ ...CONFIGURATION, extra: 1 }),
    Object.freeze({ responseBytesMax: 16384, requestTimeoutMs: 5000 }), Object.freeze({ requestTimeoutMs: 4999, responseBytesMax: 16384 }),
    Object.freeze({ requestTimeoutMs: 5000, responseBytesMax: 16385 }), Object.freeze(Object.assign(Object.create(null), CONFIGURATION)),
    new Proxy(CONFIGURATION, { ownKeys() { throw new Error(TOKEN); } })];
  for (const value of badConfigurations) assert.throws(() => createGoogleGmailProfileRequest(value, h.dependencies), { code: FAILURE });
  const badDependencies = [undefined, null, {}, { ...h.dependencies }, Object.freeze({ ...h.dependencies, extra: 1 }),
    Object.freeze({ timers: h.dependencies.timers, https: h.dependencies.https }),
    Object.freeze({ https: Object.freeze({ request() {}, extra: true }), timers: h.dependencies.timers }),
    Object.freeze({ https: h.dependencies.https, timers: Object.freeze({ setTimeout() {}, clearTimeout() {}, extra: true }) }),
    new Proxy(h.dependencies, { getPrototypeOf() { throw new Error(TOKEN); } })];
  for (const value of badDependencies) assert.throws(() => createGoogleGmailProfileRequest(CONFIGURATION, value), { code: FAILURE });
});

test('pins dependency methods and receivers and ignores poisoned function-owned call', async () => {
  const calls = []; const timerHandles = []; let httpsReceiver; let timerReceiver;
  function requestMethod(options, callback) {
    httpsReceiver = this;
    const request = new EventEmitter();
    Object.assign(request, { destroyed: false, destroy(error) { this.destroyed = true; this.destroyError = error; }, end(body) { this.body = body; } });
    calls.push({ options, callback, request }); return request;
  }
  function setTimeoutMethod(fn, ms) { timerReceiver = this; const handle = { fn, ms, cleared: 0 }; timerHandles.push(handle); return handle; }
  Object.defineProperty(requestMethod, 'call', { value() { throw new Error(TOKEN); } });
  Object.defineProperty(setTimeoutMethod, 'call', { value() { throw new Error(TOKEN); } });
  const https = Object.freeze({ request: requestMethod });
  const timers = Object.freeze({ setTimeout: setTimeoutMethod, clearTimeout(handle) { handle.cleared += 1; } });
  const dependencies = Object.freeze({ https, timers });
  const pending = createGoogleGmailProfileRequest(CONFIGURATION, dependencies).getProfile(input());
  const incoming = response(); calls[0].callback(incoming); incoming.emit('data', SOURCE); incoming.emit('end'); await pending;
  assert.strictEqual(httpsReceiver, https); assert.strictEqual(timerReceiver, timers); assert.equal(calls.length, 1); assert.equal(timerHandles.length, 1);
});

test('emits the sole fixed GET with exact authorization and accept headers and no body', async () => {
  const { h, request } = service(); const pending = request.getProfile(input());
  assert.equal(h.calls.length, 1); const call = h.calls[0];
  assert.deepEqual(call.options, Object.freeze({ protocol: 'https:', hostname: 'gmail.googleapis.com', port: 443,
    method: 'GET', path: '/gmail/v1/users/me/profile', headers: Object.freeze({ Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }) }));
  assert.equal(Object.isFrozen(call.options), true); assert.equal(Object.isFrozen(call.options.headers), true);
  assert.equal(call.request.ended, 1); assert.equal(call.request.body, undefined); assert.equal(h.timers[0].ms, 5000);
  complete(h); assert.deepEqual(await pending, PROFILE);
});

test('returns only exact frozen case-preserving authority fields and discards bounded documented totals', async () => {
  const { h, request } = service(); const pending = request.getProfile(input()); complete(h);
  const result = await pending;
  assert.equal(Object.isFrozen(result), true); assert.deepEqual(Reflect.ownKeys(result), ['emailAddress', 'historyId']);
  assert.equal(result.emailAddress, 'Owner.Case@example.test'); assert.equal(result.historyId, '9876543210123456789');
  assert.equal(Object.hasOwn(result, 'messagesTotal'), false); assert.equal(Object.hasOwn(result, 'threadsTotal'), false);
});

test('accepts the documented exact source variants and bounded nonnegative integer totals only', async () => {
  for (const source of [
    { emailAddress: 'a@b.test', historyId: '0' },
    { emailAddress: 'a@b.test', messagesTotal: 0, threadsTotal: 0, historyId: '1' },
    { emailAddress: 'a@b.test', messagesTotal: 4294967295, threadsTotal: 4294967295, historyId: '9' },
  ]) { const { h, request } = service(); const pending = request.getProfile(input()); complete(h, JSON.stringify(source)); await pending; }
  for (const patch of [{ messagesTotal: -1 }, { threadsTotal: 1.5 }, { messagesTotal: 4294967296 }, { threadsTotal: '1' }]) {
    const { h, request } = service(); const pending = request.getProfile(input()); complete(h, JSON.stringify({ ...JSON.parse(SOURCE), ...patch })); await cleanReject(() => pending);
  }
});

test('rejects malformed JSON, invalid identity fields, and undocumented extra source fields', async () => {
  const bodies = ['{', 'null', '[]', '{}', JSON.stringify({ emailAddress: 'a@b.test', historyId: '01' }),
    JSON.stringify({ emailAddress: ' a@b.test', historyId: '1' }), JSON.stringify({ emailAddress: 'é@b.test', historyId: '1' }),
    JSON.stringify({ emailAddress: 'a@b.test', historyId: 1 }), JSON.stringify({ ...JSON.parse(SOURCE), extra: true })];
  for (const body of bodies) { const { h, request } = service(); const pending = request.getProfile(input()); complete(h, body); await cleanReject(() => pending); }
});

test('requires sole 200 and sole JSON content type and never follows redirects', async () => {
  for (const specimen of [response(302), response(400), response(200, {}), response(200, { 'content-type': 'text/html' }),
    response(200, { 'content-type': ['application/json', 'application/json'] }), response(200, { 'content-type': 'application/json', location: ['x', 'y'] })]) {
    const { h, request } = service(); const pending = request.getProfile(input()); complete(h, SOURCE, specimen); await cleanReject(() => pending); assert.equal(h.calls.length, 1);
  }
});

test('requires canonical declared content length and rejects invalid UTF-8 before parsing', async () => {
  {
    const encoded = Buffer.from(SOURCE);
    const specimen = response(200, { 'content-type': 'application/json', 'content-length': String(encoded.length) });
    const { h, request } = service(); const pending = request.getProfile(input()); complete(h, SOURCE, specimen);
    assert.deepEqual(await pending, PROFILE);
  }
  for (const length of ['01', '-1', '1.5', '16385', String(Buffer.byteLength(SOURCE) + 1)]) {
    const specimen = response(200, { 'content-type': 'application/json', 'content-length': length });
    const { h, request } = service(); const pending = request.getProfile(input()); complete(h, SOURCE, specimen);
    await cleanReject(() => pending);
  }
  {
    const { h, request } = service(); const pending = request.getProfile(input()); const specimen = response();
    h.calls[0].callback(specimen); specimen.emit('data', Buffer.from([0xc3, 0x28])); specimen.emit('end');
    await cleanReject(() => pending);
  }
});

test('fails closed on aborted or premature response close and synchronous request acquisition errors', async () => {
  for (const event of ['aborted', 'close']) {
    const { h, request } = service(); const pending = request.getProfile(input()); const specimen = response();
    h.calls[0].callback(specimen); specimen.emit(event); await cleanReject(() => pending);
    assert.equal(specimen.destroyed, true); assert.equal(h.calls[0].request.destroyed, true);
  }
  {
    const h = harness({ https: { request() { throw new Error(TOKEN); } } });
    const request = createGoogleGmailProfileRequest(CONFIGURATION, h.dependencies);
    await cleanReject(() => request.getProfile(input())); assert.equal(h.timers[0].cleared, 1);
  }
});

test('allows exactly 16384 response bytes and destroys request and response at plus one', async () => {
  const exactBody = `${SOURCE.slice(0, -1)},"padding":"${'x'.repeat(16384 - Buffer.byteLength(SOURCE) - 14)}"}`;
  // Extra field makes exact-boundary parse fail, but only after end rather than as byte overflow.
  { const { h, request } = service(); const pending = request.getProfile(input()); const incoming = response(); h.calls[0].callback(incoming); incoming.emit('data', Buffer.from(exactBody)); assert.equal(incoming.destroyed, false); incoming.emit('end'); await cleanReject(() => pending); }
  { const { h, request } = service(); const pending = request.getProfile(input()); const incoming = response(); h.calls[0].callback(incoming);
    incoming.emit('data', Buffer.alloc(16384)); incoming.emit('data', Buffer.from('x'));
    assert.equal(incoming.destroyed, true); assert.equal(h.calls[0].request.destroyed, true); await cleanReject(() => pending); }
});

test('times out once, clears timer, destroys active handles, and masks transport failures', async () => {
  { const { h, request } = service(); const pending = request.getProfile(input()); h.timers[0].fn();
    assert.equal(h.calls[0].request.destroyed, true); assert.equal(h.timers[0].cleared, 1); await cleanReject(() => pending); }
  { const { h, request } = service(); const pending = request.getProfile(input()); h.calls[0].request.emit('error', new Error(TOKEN)); await cleanReject(() => pending); assert.equal(h.timers[0].cleared, 1); }
  { const { h, request } = service(); const pending = request.getProfile(input()); const incoming = response(); h.calls[0].callback(incoming); incoming.emit('error', new Error(TOKEN)); await cleanReject(() => pending); assert.equal(incoming.destroyed, true); }
});

test('burns before reflecting exact frozen ordered token input and validates visible ASCII 1..8192', async () => {
  const bad = [undefined, null, {}, { accessToken: TOKEN }, Object.freeze({ accessToken: TOKEN, extra: 1 }),
    Object.freeze(Object.assign(Object.create(null), { accessToken: TOKEN })), new Proxy(input(), { ownKeys() { throw new Error(TOKEN); } }),
    input(''), input('bad token'), input('bad\n'), input('é'), input('x'.repeat(8193)), input(7)];
  const accessor = {}; Object.defineProperty(accessor, 'accessToken', { enumerable: true, get() { throw new Error(TOKEN); } }); Object.freeze(accessor); bad.push(accessor);
  for (const value of bad) { const { h, request } = service(); await cleanReject(() => request.getProfile(value)); await cleanReject(() => request.getProfile(input())); assert.equal(h.calls.length, 0); }
});

test('rejects concurrent and reentrant reuse, makes one request, retries zero times, and logs nothing', async () => {
  const captured = []; const originalLog = console.log; const originalError = console.error;
  console.log = console.error = (...values) => captured.push(values);
  try {
    const { h, request } = service(); const pending = request.getProfile(input());
    await cleanReject(() => request.getProfile(input())); complete(h); assert.deepEqual(await pending, PROFILE);
    await cleanReject(() => request.getProfile(input())); assert.equal(h.calls.length, 1); assert.deepEqual(captured, []);
  } finally { console.log = originalLog; console.error = originalError; }
});

(async () => {
  for (const { name, run } of tests) { await run(); process.stdout.write(`ok - ${name}\n`); }
  const source = fs.readFileSync(require.resolve('./lib/email-google-gmail-profile-request'), 'utf8');
  for (const forbidden of [/googleapis/, /\bfetch\b/, /process\.env/, /database|postgres|route|callback|persist|install|binding/i,
    /console\./, /followRedirect|retry/i, /gmail\/v1\/users\/(?!me\/profile)/]) assert.equal(forbidden.test(source), false, `forbidden capability: ${forbidden}`);
  assert.equal(tests.length, 14);
  console.log('PASS verify:email-google-gmail-profile-request (14 strict offline tests)');
})().catch(error => { console.error(error); process.exitCode = 1; });
