'use strict';

/**
 * Hostile-path gate for delegated Graph Mail.ReadBasic messages health transport.
 */

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const {
  FAILURE_CODE,
  PATH,
  TOP_MAX,
  SELECT_FIELDS,
  countBoundedMessageEnvelopes,
  acceptParsedMessageEnvelopeList,
  createMicrosoftGraphDelegatedMessagesTransport,
} = require('./lib/email-microsoft-graph-delegated-messages-transport');

const PLANTED = 'NEVER_LEAK_subject_addr_token';
const TOKEN = 'atok-NEVER_LEAK-abcdefghijklmnopqrstuvwxyz012345';

function noLeak(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return !text.includes('NEVER_LEAK') && !text.includes(PLANTED) && !text.includes(TOKEN);
}

function emailAddress(patch = {}) {
  return { address: 'a@example.com', name: 'n', ...patch };
}

function envelopeRow(patch = {}) {
  const base = {
    id: 'AAMkAG',
    subject: PLANTED,
    from: { emailAddress: emailAddress() },
    receivedDateTime: '2026-01-01T00:00:00Z',
    isRead: true,
    conversationId: 'conv',
    internetMessageId: '<x@y>',
  };
  return { ...base, ...patch };
}

function listBody(rows, extras = {}) {
  return JSON.stringify({
    '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users(...)/messages',
    value: rows,
    ...extras,
  });
}

async function mustFail(action) {
  await assert.rejects(action, (error) => error.code === FAILURE_CODE
    && noLeak(error)
    && noLeak(error.message));
}

function mockHttps(statusCode, body, headerOverrides = {}) {
  return function request(options, onResponse) {
    assert.equal(options.hostname, 'graph.microsoft.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.path, PATH);
    assert.equal(PATH.includes('hasAttachments'), false, 'request path must not select hasAttachments');
    assert.match(options.headers.Authorization, /^Bearer /);
    assert.equal(options.headers.Authorization.includes(TOKEN), true);
    const response = new EventEmitter();
    response.statusCode = statusCode;
    Object.defineProperty(response, 'headers', {
      value: {
        'content-type': 'application/json',
        ...headerOverrides,
      },
      enumerable: true,
      configurable: true,
    });
    const req = new EventEmitter();
    req.end = () => {
      queueMicrotask(() => {
        onResponse(response);
        const buf = Buffer.from(body, 'utf8');
        response.emit('data', buf);
        response.emit('end');
      });
    };
    req.destroy = () => {};
    response.destroy = () => {};
    return req;
  };
}

function assertNoTokenSurface(value, label) {
  const text = typeof value === 'string'
    ? value
    : (() => {
      try { return JSON.stringify(value); } catch { return String(value); }
    })();
  assert.equal(text.includes(TOKEN), false, `${label}: must not contain token`);
  assert.equal(text.includes('Bearer'), false, `${label}: must not contain Bearer`);
  assert.equal(text.includes('NEVER_LEAK'), false, `${label}: must not contain planted secret`);
}

function assertRetainedOptionsScrubbed(retained, label) {
  assert.ok(retained, `${label}: options must have been retained by hostile request`);
  assert.equal(Object.isFrozen(retained), false, `${label}: retained options must not be frozen`);
  assert.ok(retained.headers, `${label}: headers object still reachable`);
  assert.equal(Object.isFrozen(retained.headers), false, `${label}: retained headers must not be frozen`);
  assert.equal(retained.headers.Authorization, null, `${label}: Authorization cleared`);
  assertNoTokenSurface(retained, label);
  assertNoTokenSurface(retained.headers, `${label} headers`);
}

/**
 * Hostile https.request that retains the options object reference for post-call scrub proofs.
 */
function createRetainingHttps(behavior) {
  let retainedOptions = null;
  let sawTokenDuringCall = false;
  let callbackInvocations = 0;

  function request(options, onResponse) {
    retainedOptions = options;
    sawTokenDuringCall = Boolean(
      options
      && options.headers
      && typeof options.headers.Authorization === 'string'
      && options.headers.Authorization.includes(TOKEN),
    );
    if (behavior === 'throw') {
      throw new Error(`planted-request-throw-${PLANTED}`);
    }
    const req = new EventEmitter();
    req.destroy = () => {};
    if (behavior === 'hang') {
      req.end = () => {};
      return req;
    }
    const response = new EventEmitter();
    response.statusCode = 200;
    Object.defineProperty(response, 'headers', {
      value: { 'content-type': 'application/json' },
      enumerable: true,
      configurable: true,
    });
    response.destroy = () => {};
    req.end = () => {
      queueMicrotask(() => {
        callbackInvocations += 1;
        onResponse(response);
        if (behavior === 'async-error') {
          response.emit('error', new Error(`planted-async-${PLANTED}`));
          return;
        }
        response.emit('data', Buffer.from(JSON.stringify({ value: [] }), 'utf8'));
        response.emit('end');
      });
    };
    return req;
  }

  return {
    request,
    getRetainedOptions: () => retainedOptions,
    sawTokenDuringCall: () => sawTokenDuringCall,
    callbackInvocations: () => callbackInvocations,
  };
}

async function main() {
  const logged = [];
  const log = console.log;
  const error = console.error;
  console.log = console.error = (...v) => logged.push(v);
  try {
    assert.equal(TOP_MAX, 5);
    assert.equal(PATH.includes('$top=5'), true);
    assert.equal(SELECT_FIELDS.includes('subject'), true);
    assert.equal(SELECT_FIELDS.includes('body'), false);
    assert.equal(SELECT_FIELDS.includes('hasAttachments'), false);
    assert.equal(PATH.includes('hasAttachments'), false);
    assert.deepEqual([...SELECT_FIELDS], [
      'id', 'subject', 'from', 'receivedDateTime', 'isRead',
      'conversationId', 'internetMessageId',
    ]);

    assert.equal(countBoundedMessageEnvelopes(listBody([
      envelopeRow(), envelopeRow({ id: '2' }),
    ])), 2);
    assert.equal(countBoundedMessageEnvelopes(JSON.stringify({ value: [] })), 0);
    assert.equal(countBoundedMessageEnvelopes(listBody([])), 0);

    for (const [name, body] of [
      ['too many rows', listBody(Array.from({ length: 6 }, (_, i) => envelopeRow({ id: String(i) })))],
      ['nextLink', listBody([envelopeRow()], { '@odata.nextLink': 'https://graph.microsoft.com/v1.0/evil' })],
      ['deltaLink', listBody([envelopeRow()], { '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/evil' })],
      ['unexpected top key', listBody([envelopeRow()], { '@odata.count': 1 })],
      ['error object', JSON.stringify({ error: { code: 'Invalid', message: PLANTED } })],
      ['body field', listBody([envelopeRow({ body: { content: PLANTED } })])],
      ['bodyPreview', listBody([envelopeRow({ bodyPreview: PLANTED })])],
      ['uniqueBody', listBody([envelopeRow({ uniqueBody: { content: PLANTED } })])],
      ['hasAttachments row', listBody([envelopeRow({ hasAttachments: false })])],
      ['attachments row', listBody([envelopeRow({ attachments: [] })])],
      ['missing required field', listBody([{
        id: 'x', subject: 's', from: { emailAddress: emailAddress() },
        receivedDateTime: '2026-01-01T00:00:00Z', isRead: true, conversationId: 'c',
      }])],
      ['extra row field', listBody([envelopeRow({ importance: 'high' })])],
      ['not array', JSON.stringify({ value: { id: 'x' } })],
      ['malformed', '{'],
      ['top-level duplicate value', '{"value":[],"value":[]}'],
    ]) {
      assert.equal(countBoundedMessageEnvelopes(body), null, name);
    }

    // Nested duplicate keys at every parsed object depth.
    const nestedDup = '{"value":[{"id":"1","subject":"s","from":{"emailAddress":{"address":"a@b.c","name":"n","address":"dup@b.c"}},"receivedDateTime":"2026-01-01T00:00:00Z","isRead":true,"conversationId":"c","internetMessageId":"<x>"}]}';
    assert.equal(countBoundedMessageEnvelopes(nestedDup), null, 'nested duplicate address');

    const nestedFromDup = '{"value":[{"id":"1","subject":"s","from":{"emailAddress":{"address":"a@b.c","name":"n"},"emailAddress":{"address":"x@y.z","name":"z"}},"receivedDateTime":"2026-01-01T00:00:00Z","isRead":true,"conversationId":"c","internetMessageId":"<x>"}]}';
    assert.equal(countBoundedMessageEnvelopes(nestedFromDup), null, 'nested duplicate emailAddress');

    // Dangerous / unexpected content fields
    assert.equal(countBoundedMessageEnvelopes(listBody([
      envelopeRow({ ['__proto__']: { polluted: true } }),
    ])), null);
    assert.equal(countBoundedMessageEnvelopes(listBody([
      envelopeRow({ constructor: { name: 'x' } }),
    ])), null);

    // Proxy / accessor / inherited rejection on parsed surfaces.
    assert.equal(acceptParsedMessageEnvelopeList(new Proxy({ value: [] }, {})), null, 'proxy top');
    const accessorTop = {};
    Object.defineProperty(accessorTop, 'value', {
      get() { return []; },
      enumerable: true,
      configurable: true,
    });
    assert.equal(acceptParsedMessageEnvelopeList(accessorTop), null, 'accessor top value');

    const inheritedProto = { importance: 'high' };
    const inheritedRow = Object.create(inheritedProto);
    Object.assign(inheritedRow, envelopeRow());
    assert.equal(acceptParsedMessageEnvelopeList({ value: [inheritedRow] }), null, 'inherited row');

    const accessorRow = { ...envelopeRow() };
    Object.defineProperty(accessorRow, 'subject', {
      get() { return PLANTED; },
      enumerable: true,
      configurable: true,
    });
    assert.equal(acceptParsedMessageEnvelopeList({ value: [accessorRow] }), null, 'accessor row field');

    const proxyRow = new Proxy(envelopeRow(), {});
    assert.equal(acceptParsedMessageEnvelopeList({ value: [proxyRow] }), null, 'proxy row');

    const transport = createMicrosoftGraphDelegatedMessagesTransport({
      httpsImpl: mockHttps(200, listBody([
        envelopeRow(), envelopeRow({ id: 'b' }), envelopeRow({ id: 'c' }),
      ])),
      timers: { setTimeout, clearTimeout },
    });
    const result = await transport.listMessageEnvelopeCount({ accessToken: TOKEN });
    assert.deepEqual(result, { message_count_bounded: 3 });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(noLeak(result), true);
    assert.equal(JSON.stringify(result).includes('subject'), false);
    assert.equal(JSON.stringify(result).includes(PLANTED), false);

    const ProxyHttps = function request(_opts, onResponse) {
      const target = new EventEmitter();
      target.statusCode = 200;
      const proxied = new Proxy(target, {
        get(t, prop) { return t[prop]; },
      });
      const req = new EventEmitter();
      req.end = () => { queueMicrotask(() => onResponse(proxied)); };
      req.destroy = () => {};
      return req;
    };
    await mustFail(() => createMicrosoftGraphDelegatedMessagesTransport({
      httpsImpl: ProxyHttps,
      timers: { setTimeout, clearTimeout },
    }).listMessageEnvelopeCount({ accessToken: TOKEN }));

    await mustFail(() => createMicrosoftGraphDelegatedMessagesTransport({
      httpsImpl: mockHttps(401, JSON.stringify({ error: { message: PLANTED } })),
      timers: { setTimeout, clearTimeout },
    }).listMessageEnvelopeCount({ accessToken: TOKEN }));

    for (const bad of [
      null, {}, { accessToken: TOKEN, top: 50 }, { accessToken: '' },
      { accessToken: 'bad\ntoken' }, Object.create(null),
    ]) {
      await mustFail(() => createMicrosoftGraphDelegatedMessagesTransport({
        httpsImpl: mockHttps(200, JSON.stringify({ value: [] })),
        timers: { setTimeout, clearTimeout },
      }).listMessageEnvelopeCount(bad));
    }

    const once = createMicrosoftGraphDelegatedMessagesTransport({
      httpsImpl: mockHttps(200, JSON.stringify({ value: [] })),
      timers: { setTimeout, clearTimeout },
    });
    await once.listMessageEnvelopeCount({ accessToken: TOKEN });
    await mustFail(() => once.listMessageEnvelopeCount({ accessToken: TOKEN }));

    assert.throws(
      () => createMicrosoftGraphDelegatedMessagesTransport({ httpsImpl: 'nope' }),
      (e) => e.code === FAILURE_CODE && noLeak(e),
    );

    // --- Access-token lifetime: hostile request retains options; must be scrubbed ---

    // 1) Request creation success: scrubbed synchronously after https.request returns.
    {
      let timeoutFn = null;
      const hostile = createRetainingHttps('hang');
      const hangPromise = createMicrosoftGraphDelegatedMessagesTransport({
        httpsImpl: hostile.request,
        timers: {
          setTimeout: (fn) => { timeoutFn = fn; return 1; },
          clearTimeout: () => {},
        },
      }).listMessageEnvelopeCount({ accessToken: TOKEN });
      assert.equal(hostile.sawTokenDuringCall(), true, 'token present only during request call');
      assertRetainedOptionsScrubbed(hostile.getRetainedOptions(), 'after request creation');
      assert.equal(typeof timeoutFn, 'function');
      timeoutFn();
      await assert.rejects(hangPromise, (error) => error.code === FAILURE_CODE && noLeak(error));
      assertRetainedOptionsScrubbed(hostile.getRetainedOptions(), 'after timeout');
      assertNoTokenSurface(
        hostile.getRetainedOptions() && hostile.getRetainedOptions().headers,
        'headers after timeout',
      );
    }

    // 2) Synchronous request throw: scrubbed in finally; error sanitized.
    {
      const hostile = createRetainingHttps('throw');
      await assert.rejects(
        () => createMicrosoftGraphDelegatedMessagesTransport({
          httpsImpl: hostile.request,
          timers: { setTimeout, clearTimeout },
        }).listMessageEnvelopeCount({ accessToken: TOKEN }),
        (error) => error.code === FAILURE_CODE && noLeak(error) && !String(error).includes(TOKEN),
      );
      assert.equal(hostile.sawTokenDuringCall(), true);
      assertRetainedOptionsScrubbed(hostile.getRetainedOptions(), 'after sync throw');
    }

    // 3) Asynchronous Graph success: scrubbed before response callback; DTO clean.
    {
      const hostile = createRetainingHttps('success');
      const graphInput = { accessToken: TOKEN };
      const ok = await createMicrosoftGraphDelegatedMessagesTransport({
        httpsImpl: hostile.request,
        timers: { setTimeout, clearTimeout },
      }).listMessageEnvelopeCount(graphInput);
      assert.deepEqual(ok, { message_count_bounded: 0 });
      assert.equal(Object.isFrozen(ok), true);
      assertNoTokenSurface(ok, 'success DTO');
      assert.equal(hostile.callbackInvocations(), 1);
      assertRetainedOptionsScrubbed(hostile.getRetainedOptions(), 'after async success');
      // Caller input is not mutated by transport (orchestrator clears its own bag).
      assert.equal(graphInput.accessToken, TOKEN);
    }

    // 4) Asynchronous error path: scrubbed; callback/errors clean.
    {
      const hostile = createRetainingHttps('async-error');
      await assert.rejects(
        () => createMicrosoftGraphDelegatedMessagesTransport({
          httpsImpl: hostile.request,
          timers: { setTimeout, clearTimeout },
        }).listMessageEnvelopeCount({ accessToken: TOKEN }),
        (error) => error.code === FAILURE_CODE && noLeak(error),
      );
      assert.equal(hostile.callbackInvocations(), 1);
      assertRetainedOptionsScrubbed(hostile.getRetainedOptions(), 'after async error');
    }

    assert.deepEqual(logged, []);
  } finally {
    console.log = log;
    console.error = error;
  }
  log('verify:email-microsoft-graph-delegated-messages-transport: ok');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
