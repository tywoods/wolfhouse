'use strict';

/**
 * RED-only offline contract for the fixed Google token exchange and immediate custody seam.
 * Production owner is intentionally absent. This suite performs no live network activity.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createGoogleTokenResponseCustody } = require('./lib/email-google-token-response-custody');
const { GOOGLE_PHASE_A_SCOPES } = require('./lib/email-google-verified-grant-custody');
// Authentic RED: this sole production owner must be supplied by GREEN.
const owner = require('./lib/email-google-token-exchange-custody');
const { createGoogleTokenExchangeCustody } = owner;

const FAILURE_CODE = 'GOOGLE_TOKEN_EXCHANGE_CUSTODY_FAILED';
const LEAK = 'GOOGLE_EXCHANGE_SECRET_NEVER_LEAK';
const FORM = `code=${LEAK}&client_id=offline-client&client_secret=${LEAK}`;
const TOKEN_BODY = JSON.stringify({
  access_token: 'offline-access', expires_in: 3600, refresh_token: 'offline-refresh',
  scope: GOOGLE_PHASE_A_SCOPES.join(' '), token_type: 'Bearer', id_token: 'a.b.c',
});
const DTO_KEYS = ['statusCode', 'contentType', 'body'];
const SUCCESS = Object.freeze({ status: 'custodied' });
function freeze(value) { return Object.freeze(value); }
function input(body = FORM) { return freeze({ body }); }

function makeHarness(configuration = {}) {
  const state = {
    requests: 0, options: null, endedBody: null, responseCallback: null, deadline: null,
    requestDestroyed: 0, responseDestroyed: 0, clearCalls: [], custodyCalls: 0,
    received: null, httpsReceiver: null, setReceiver: null, clearReceiver: null, custodyReceiver: null,
  };
  const response = new EventEmitter();
  response.statusCode = configuration.statusCode === undefined ? 200 : configuration.statusCode;
  response.headers = configuration.headers === undefined ? { 'content-type': 'application/json' } : configuration.headers;
  response.destroy = function destroy() { state.responseDestroyed += 1; };
  const request = new EventEmitter();
  request.destroy = function destroy() { state.requestDestroyed += 1; };
  request.end = function end(body) {
    state.endedBody = body;
    if (configuration.endThrows) throw new Error(`${LEAK}:end`);
    if (configuration.manualResponse) return;
    state.responseCallback(response);
    const events = configuration.events || [
      ['data', Buffer.from(configuration.responseBody === undefined ? TOKEN_BODY : configuration.responseBody)], ['end'], ['close'],
    ];
    for (const [name, value] of events) response.emit(name, value);
  };
  const https = freeze({ request(options, callback) {
    state.httpsReceiver = this; state.requests += 1; state.options = options; state.responseCallback = callback;
    if (configuration.requestThrows) throw new Error(`${LEAK}:request`);
    if (configuration.callbackBeforeReturn) callback(response);
    if (configuration.deadlineBeforeReturn) state.deadline();
    return configuration.invalidRequest || request;
  } });
  const timers = freeze({
    setTimeout(callback, milliseconds) {
      state.setReceiver = this; assert.equal(milliseconds, 10000); state.deadline = callback;
      if (configuration.synchronousDeadline) callback();
      if (configuration.timerThrows) throw new Error(`${LEAK}:timer`);
      return configuration.timerHandle || freeze({ id: 1 });
    },
    clearTimeout(handle) {
      state.clearReceiver = this; state.clearCalls.push(handle);
      if (configuration.clearThrows) throw new Error(`${LEAK}:clear`);
    },
  });
  const responseCustody = configuration.responseCustody || freeze({
    async acceptTokenResponse(dto) {
      state.custodyReceiver = this; state.custodyCalls += 1; state.received = dto;
      if (configuration.custodyThrows) throw new Error(`${LEAK}:custody`);
      return configuration.custodyAck === undefined ? SUCCESS : configuration.custodyAck;
    },
  });
  return { state, request, response, https, timers, responseCustody,
    dependencies: freeze({ https, timers, responseCustody }) };
}

async function cleanReject(action) {
  await assert.rejects(Promise.resolve().then(action), error => {
    assert.equal(error.name, 'GoogleTokenExchangeCustodyError');
    assert.equal(error.code, FAILURE_CODE);
    assert.equal(error.message, FAILURE_CODE);
    assert.equal(Object.isFrozen(error), true);
    const rendered = `${String(error)}\n${error.stack || ''}\n${JSON.stringify(error)}`;
    assert.equal(rendered.includes(LEAK), false);
    for (const key of ['body', 'access_token', 'refresh_token', 'id_token', 'code', 'client_secret']) {
      assert.equal(Object.hasOwn(error, key), false);
    }
    return true;
  });
}
function service(harness) { return createGoogleTokenExchangeCustody(harness.dependencies); }
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('exports only the frozen factory and returns an exact frozen one-shot owner', async () => {
  assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(Reflect.ownKeys(owner), ['createGoogleTokenExchangeCustody']);
  const exchange = service(makeHarness());
  assert.equal(Object.isFrozen(exchange), true);
  assert.deepEqual(Reflect.ownKeys(exchange), ['exchangeAndCustody']);
});

test('uses only the fixed frozen Google token destination and exact form bytes', async () => {
  const h = makeHarness();
  const result = await service(h).exchangeAndCustody(input());
  assert.deepEqual(result, SUCCESS); assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(Reflect.ownKeys(result), ['status']);
  assert.deepEqual(h.state.options, {
    protocol: 'https:', hostname: 'oauth2.googleapis.com', port: 443, method: 'POST', path: '/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(FORM), Accept: 'application/json' },
    agent: false,
  });
  assert.equal(Object.isFrozen(h.state.options), true); assert.equal(Object.isFrozen(h.state.options.headers), true);
  assert.equal(h.state.endedBody, FORM); assert.equal(h.state.requests, 1);
});

test('pins exact dependency receivers and immediately hands off exact frozen response DTO once', async () => {
  const h = makeHarness(); await service(h).exchangeAndCustody(input());
  assert.equal(h.state.httpsReceiver, h.https); assert.equal(h.state.setReceiver, h.timers);
  assert.equal(h.state.clearReceiver, h.timers); assert.equal(h.state.custodyReceiver, h.responseCustody);
  assert.equal(h.state.custodyCalls, 1); assert.equal(Object.isFrozen(h.state.received), true);
  assert.deepEqual(Reflect.ownKeys(h.state.received), DTO_KEYS);
  assert.deepEqual(h.state.received, { statusCode: 200, contentType: 'application/json', body: TOKEN_BODY });
  assert.equal(h.state.clearCalls.length, 1);
});

test('requires exact frozen ordered data-only dependencies and pins methods at creation', async () => {
  const good = makeHarness().dependencies;
  const variants = [undefined, {}, { ...good }, freeze({ ...good, extra: true }),
    freeze({ timers: good.timers, https: good.https, responseCustody: good.responseCustody }),
    freeze({ https: freeze({ request: 1 }), timers: good.timers, responseCustody: good.responseCustody }),
    freeze({ https: good.https, timers: freeze({ setTimeout() {}, clearTimeout() {}, extra() {} }), responseCustody: good.responseCustody }),
    freeze({ https: good.https, timers: good.timers, responseCustody: freeze({ acceptTokenResponse: 1 }) }),
    freeze(Object.assign(Object.create(null), good)), new Proxy(good, { ownKeys() { throw new Error(LEAK); } }),
  ];
  const accessor = {}; Object.defineProperty(accessor, 'https', { enumerable: true, get() { throw new Error(LEAK); } });
  Object.defineProperty(accessor, 'timers', { enumerable: true, value: good.timers });
  Object.defineProperty(accessor, 'responseCustody', { enumerable: true, value: good.responseCustody }); Object.freeze(accessor); variants.push(accessor);
  for (const deps of variants) assert.throws(() => createGoogleTokenExchangeCustody(deps), { code: FAILURE_CODE });
});

test('burns one-shot before hostile reflection and rejects concurrent and reentrant reuse', async () => {
  const h = makeHarness({ manualResponse: true }); const exchange = service(h);
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error(LEAK); }, ownKeys() { throw new Error(LEAK); } });
  await cleanReject(() => exchange.exchangeAndCustody(hostile)); await cleanReject(() => exchange.exchangeAndCustody(input()));
  assert.equal(h.state.requests, 0);
  const h2 = makeHarness({ manualResponse: true }); const exchange2 = service(h2);
  const pending = exchange2.exchangeAndCustody(input()); await cleanReject(() => exchange2.exchangeAndCustody(input()));
  h2.state.responseCallback(h2.response); h2.response.emit('data', Buffer.from(TOKEN_BODY)); h2.response.emit('end'); await pending;
});

test('requires exact frozen {body} and snapshots nonempty visible ASCII form bytes through 32768', async () => {
  const bad = [{ body: 'x' }, freeze({ body: 'x', url: 'https://evil.example' }), freeze({ url: 'https://evil.example', body: 'x' }),
    freeze({ body: '' }), freeze({ body: 'a b' }), freeze({ body: 'x\n' }), freeze({ body: 'é' }), freeze({ body: 'x'.repeat(32769) }),
    freeze({ body: `${'x'.repeat(32767)}π` }), freeze(Object.assign(Object.create(null), { body: 'x' }))];
  for (const value of bad) { const h = makeHarness(); await cleanReject(() => service(h).exchangeAndCustody(value)); assert.equal(h.state.requests, 0); }
  const h = makeHarness({ manualResponse: true }); const mutable = 'x'.repeat(32768); const pending = service(h).exchangeAndCustody(input(mutable));
  assert.equal(h.state.endedBody, mutable); h.state.responseCallback(h.response); h.response.emit('data', Buffer.from(TOKEN_BODY)); h.response.emit('end'); await pending;
});

test('establishes deadline first and handles synchronous deadline or timer acquisition throw without HTTPS', async () => {
  for (const configuration of [{ synchronousDeadline: true }, { timerThrows: true }]) {
    const h = makeHarness(configuration); await cleanReject(() => service(h).exchangeAndCustody(input())); assert.equal(h.state.requests, 0);
    assert.equal(h.state.clearCalls.length, configuration.timerThrows ? 0 : 1);
  }
});

test('handles callback/deadline before request return and destroys late request or response exactly once', async () => {
  const callback = makeHarness({ callbackBeforeReturn: true });
  const pending = service(callback).exchangeAndCustody(input());
  callback.response.emit('data', Buffer.from(TOKEN_BODY)); callback.response.emit('end'); assert.deepEqual(await pending, SUCCESS);
  const lateRequest = makeHarness({ deadlineBeforeReturn: true }); await cleanReject(() => service(lateRequest).exchangeAndCustody(input()));
  assert.equal(lateRequest.state.requestDestroyed, 1); assert.equal(lateRequest.state.clearCalls.length, 1);
  const lateResponse = makeHarness({ manualResponse: true }); const failed = service(lateResponse).exchangeAndCustody(input()); lateResponse.state.deadline();
  lateResponse.state.responseCallback(lateResponse.response); await cleanReject(() => failed);
  assert.equal(lateResponse.state.requestDestroyed, 1); assert.equal(lateResponse.state.responseDestroyed, 1);
});

test('accepts integer HTTP status 100..599 and strict JSON content type while parser owns status 200', async () => {
  for (const statusCode of [100, 400, 599]) { const h = makeHarness({ statusCode }); assert.deepEqual(await service(h).exchangeAndCustody(input()), SUCCESS); }
  for (const contentType of ['application/json', 'Application/JSON ; charset=UTF-8']) {
    const h = makeHarness({ headers: { 'content-type': contentType } }); await service(h).exchangeAndCustody(input());
  }
  for (const configuration of [{ statusCode: 99 }, { statusCode: 600 }, { statusCode: '200' }, { headers: {} },
    { headers: { 'content-type': 'text/json' } }, { headers: { 'content-type': 'application/json; charset=latin1' } },
    { headers: { 'content-type': ['application/json'] } }]) {
    const h = makeHarness(configuration); await cleanReject(() => service(h).exchangeAndCustody(input())); assert.equal(h.state.custodyCalls, 0);
  }
});

test('enforces canonical optional content length 0..65536 and exact received length', async () => {
  for (const length of ['65537', '01', '-1', '1.0', String(Buffer.byteLength(TOKEN_BODY) + 1)]) {
    const h = makeHarness({ headers: { 'content-type': 'application/json', 'content-length': length } });
    await cleanReject(() => service(h).exchangeAndCustody(input())); assert.equal(h.state.custodyCalls, 0);
  }
  const h = makeHarness({ headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(TOKEN_BODY)) } }); await service(h).exchangeAndCustody(input());
});

test('requires Buffer chunks, caps before storage, and fatally decodes UTF-8 without replacement', async () => {
  for (const events of [[['data', 'string'], ['end']], [['data', Buffer.alloc(65536)], ['data', Buffer.alloc(1)], ['end']],
    [['data', Buffer.from([0xc3, 0x28])], ['end']], [['data', Buffer.from('\ufffd')], ['end']]]) {
    const h = makeHarness({ events }); await cleanReject(() => service(h).exchangeAndCustody(input()));
    assert.equal(h.state.custodyCalls, 0); assert.equal(h.state.responseDestroyed, 1);
  }
});

test('settles once across request/response failures, aborts, timeouts, premature close, end throw, and duplicates', async () => {
  for (const configuration of [{ requestThrows: true }, { endThrows: true }, { invalidRequest: {} },
    { events: [['error', new Error(LEAK)]] }, { events: [['aborted']] }, { events: [['timeout']] }, { events: [['close']] }]) {
    const h = makeHarness(configuration); await cleanReject(() => service(h).exchangeAndCustody(input())); assert.ok(h.state.clearCalls.length <= 1);
  }
  for (const event of ['error', 'abort', 'timeout', 'close']) {
    const h = makeHarness({ manualResponse: true }); const pending = service(h).exchangeAndCustody(input());
    h.request.emit(event, event === 'error' ? new Error(LEAK) : undefined); await cleanReject(() => pending); assert.equal(h.state.clearCalls.length, 1);
  }
  const h = makeHarness({ manualResponse: true, clearThrows: true }); const pending = service(h).exchangeAndCustody(input()); h.state.responseCallback(h.response);
  h.response.emit('error', new Error(LEAK)); h.response.emit('aborted'); h.response.emit('timeout'); h.response.emit('close'); h.response.emit('end');
  await cleanReject(() => pending); assert.equal(h.state.clearCalls.length, 1); assert.equal(h.state.custodyCalls, 0);
});

test('requires exact frozen custodied acknowledgement, never collects after settle, and never returns raw bytes', async () => {
  for (const acknowledgement of [null, {}, freeze({ status: 'custodied', extra: true }), freeze({ status: 'accepted' }), freeze(Object.assign(Object.create(null), { status: 'custodied' }))]) {
    const h = makeHarness({ custodyAck: acknowledgement }); await cleanReject(() => service(h).exchangeAndCustody(input())); assert.equal(h.state.custodyCalls, 1);
  }
  const h = makeHarness({ manualResponse: true }); const pending = service(h).exchangeAndCustody(input()); h.state.responseCallback(h.response);
  h.response.emit('data', Buffer.from(TOKEN_BODY)); h.response.emit('end'); const result = await pending;
  h.response.emit('data', Buffer.from(LEAK)); h.response.emit('end'); assert.deepEqual(result, SUCCESS); assert.equal(JSON.stringify(result).includes(TOKEN_BODY), false);
});

test('keeps the deadline active through a custody acknowledgement that never settles', async () => {
  const responseCustody = freeze({ acceptTokenResponse() { return new Promise(() => {}); } });
  const h = makeHarness({ manualResponse: true, responseCustody });
  const pending = service(h).exchangeAndCustody(input());
  h.state.responseCallback(h.response);
  h.response.emit('data', Buffer.from(TOKEN_BODY));
  h.response.emit('end');
  await Promise.resolve();
  assert.equal(h.state.clearCalls.length, 0);
  h.state.deadline();
  await cleanReject(() => pending);
  assert.equal(h.state.clearCalls.length, 1);
  assert.equal(h.state.requestDestroyed, 1);
  assert.equal(h.state.responseDestroyed, 1);
});

test('composes with real response custody: non-200 reaches custody then rejects, and source excludes ambient authorities', async () => {
  let validated = 0;
  const real = createGoogleTokenResponseCustody(freeze({ custody: freeze({ async acceptValidatedTokens() { validated += 1; return freeze({ status: 'accepted' }); } }) }));
  const good = makeHarness({ responseCustody: real }); assert.deepEqual(await service(good).exchangeAndCustody(input()), SUCCESS); assert.equal(validated, 1);
  const non200 = makeHarness({ responseCustody: createGoogleTokenResponseCustody(freeze({ custody: freeze({ async acceptValidatedTokens() { throw new Error(LEAK); } }) })), statusCode: 400,
    responseBody: JSON.stringify({ error: LEAK }) });
  await cleanReject(() => service(non200).exchangeAndCustody(input()));
  const source = fs.readFileSync(path.join(__dirname, 'lib/email-google-token-exchange-custody.js'), 'utf8');
  for (const forbidden of ["require('node:https')", 'require("node:https")', "require('googleapis')", 'require("googleapis")', 'process.env', 'express', 'router', 'database', 'postgres',
    'client_secret', 'authorization_code', 'console.', 'fetch(', 'postTokenForm']) assert.equal(source.includes(forbidden), false, forbidden);
  assert.deepEqual([...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)], []);
});

(async () => {
  const originalLog = console.log; const originalError = console.error; const captured = [];
  console.log = console.error = (...args) => captured.push(args);
  try { for (const { name, run } of tests) { await run(); originalLog(`ok - ${name}`); } }
  finally { console.log = originalLog; console.error = originalError; }
  for (const entry of captured) assert.equal(entry.map(String).join(' ').includes(LEAK), false);
  originalLog(`verify:email-google-token-exchange-custody: ok (${tests.length} tests)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
