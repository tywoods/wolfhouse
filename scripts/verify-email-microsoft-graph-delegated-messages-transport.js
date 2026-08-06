'use strict';

/**
 * Hostile-path gate for delegated Graph Mail.ReadBasic messages health transport.
 * Proves allowlisted graph_stage diagnostics without leaking response/token material.
 */

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const {
  FAILURE_CODE,
  PATH,
  TOP_MAX,
  SELECT_FIELDS,
  GRAPH_STAGES,
  countBoundedMessageEnvelopes,
  classifyMessageEnvelopeBody,
  classifyParsedMessageEnvelopeList,
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

async function mustFailStage(action, stage) {
  await assert.rejects(action, (error) => error.code === FAILURE_CODE
    && error.graph_stage === stage
    && Object.isFrozen(error)
    && noLeak(error)
    && noLeak(error.message)
    && !String(error.stack || '').includes(TOKEN)
    && !JSON.stringify(error).includes('content-type')
    && !JSON.stringify(error).includes(PLANTED));
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

function transportWith(httpsImpl, timers) {
  return createMicrosoftGraphDelegatedMessagesTransport({
    httpsImpl,
    timers: timers || { setTimeout, clearTimeout },
  });
}

async function main() {
  const logged = [];
  const log = console.log;
  const error = console.error;
  console.log = console.error = (...v) => logged.push(v);
  try {
    assert.deepEqual([...GRAPH_STAGES], [
      'request_error',
      'timeout',
      'response_surface_invalid',
      'http_status_not_200',
      'content_type_invalid',
      'stream_invalid',
      'stream_aborted',
      'response_too_large',
      'utf8_invalid',
      'json_invalid',
      'top_shape_invalid',
      'row_keyset_invalid',
      'row_value_invalid',
      'success',
    ]);
    assert.equal(TOP_MAX, 5);
    assert.equal(PATH.includes('$top=5'), true);
    assert.equal(SELECT_FIELDS.includes('subject'), true);
    assert.equal(SELECT_FIELDS.includes('body'), false);
    assert.equal(SELECT_FIELDS.includes('hasAttachments'), false);
    assert.equal(PATH.includes('hasAttachments'), false);

    assert.equal(countBoundedMessageEnvelopes(listBody([
      envelopeRow(), envelopeRow({ id: '2' }),
    ])), 2);
    assert.equal(countBoundedMessageEnvelopes(JSON.stringify({ value: [] })), 0);
    assert.equal(countBoundedMessageEnvelopes(listBody([])), 0);
    assert.equal(classifyMessageEnvelopeBody(listBody([envelopeRow()])).stage, 'success');
    assert.equal(classifyMessageEnvelopeBody(listBody([envelopeRow()])).count, 1);

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

    assert.equal(classifyMessageEnvelopeBody(listBody(
      Array.from({ length: 6 }, (_, i) => envelopeRow({ id: String(i) })),
    )).stage, 'top_shape_invalid');
    assert.equal(classifyMessageEnvelopeBody(listBody([envelopeRow()], {
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/evil',
    })).stage, 'top_shape_invalid');
    assert.equal(classifyMessageEnvelopeBody(listBody([envelopeRow({ hasAttachments: false })])).stage,
      'row_keyset_invalid');
    assert.equal(classifyMessageEnvelopeBody(listBody([envelopeRow({ id: '' })])).stage,
      'row_value_invalid');
    assert.equal(classifyMessageEnvelopeBody('{').stage, 'json_invalid');
    assert.equal(classifyMessageEnvelopeBody(`\ufffd`).stage, 'utf8_invalid');
    assert.equal(classifyMessageEnvelopeBody(Buffer.alloc(70_000, 0x61).toString('utf8')).stage,
      'response_too_large');

    const nestedDup = '{"value":[{"id":"1","subject":"s","from":{"emailAddress":{"address":"a@b.c","name":"n","address":"dup@b.c"}},"receivedDateTime":"2026-01-01T00:00:00Z","isRead":true,"conversationId":"c","internetMessageId":"<x>"}]}';
    assert.equal(countBoundedMessageEnvelopes(nestedDup), null, 'nested duplicate address');
    assert.equal(classifyMessageEnvelopeBody(nestedDup).stage, 'json_invalid');

    assert.equal(countBoundedMessageEnvelopes(listBody([
      envelopeRow({ ['__proto__']: { polluted: true } }),
    ])), null);
    assert.equal(acceptParsedMessageEnvelopeList(new Proxy({ value: [] }, {})), null, 'proxy top');
    assert.equal(classifyParsedMessageEnvelopeList(new Proxy({ value: [] }, {})).stage,
      'top_shape_invalid');

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
    assert.equal(classifyParsedMessageEnvelopeList({ value: [inheritedRow] }).stage,
      'row_keyset_invalid');

    const accessorRow = { ...envelopeRow() };
    Object.defineProperty(accessorRow, 'subject', {
      get() { return PLANTED; },
      enumerable: true,
      configurable: true,
    });
    assert.equal(acceptParsedMessageEnvelopeList({ value: [accessorRow] }), null, 'accessor row field');
    assert.equal(classifyParsedMessageEnvelopeList({ value: [accessorRow] }).stage,
      'row_keyset_invalid');

    const proxyRow = new Proxy(envelopeRow(), {});
    assert.equal(acceptParsedMessageEnvelopeList({ value: [proxyRow] }), null, 'proxy row');

    const transport = transportWith(mockHttps(200, listBody([
      envelopeRow(), envelopeRow({ id: 'b' }), envelopeRow({ id: 'c' }),
    ])));
    const result = await transport.listMessageEnvelopeCount({ accessToken: TOKEN });
    assert.deepEqual(result, { message_count_bounded: 3, graph_stage: 'success' });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(noLeak(result), true);
    assert.equal(JSON.stringify(result).includes('subject'), false);
    assert.equal(JSON.stringify(result).includes(PLANTED), false);

    // --- Prove every transport terminal stage ---
    await mustFailStage(() => transportWith(function request() {
      throw new Error(PLANTED);
    }).listMessageEnvelopeCount({ accessToken: TOKEN }), 'request_error');

    {
      let timeoutFn = null;
      const hang = createRetainingHttps('hang');
      const p = transportWith(hang.request, {
        setTimeout: (fn) => { timeoutFn = fn; return 1; },
        clearTimeout: () => {},
      }).listMessageEnvelopeCount({ accessToken: TOKEN });
      timeoutFn();
      await mustFailStage(() => p, 'timeout');
    }

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
    await mustFailStage(
      () => transportWith(ProxyHttps).listMessageEnvelopeCount({ accessToken: TOKEN }),
      'response_surface_invalid',
    );

    await mustFailStage(
      () => transportWith(mockHttps(401, JSON.stringify({ error: { message: PLANTED } })))
        .listMessageEnvelopeCount({ accessToken: TOKEN }),
      'http_status_not_200',
    );

    await mustFailStage(
      () => transportWith(mockHttps(200, JSON.stringify({ value: [] }), {
        'content-type': 'text/plain',
      })).listMessageEnvelopeCount({ accessToken: TOKEN }),
      'content_type_invalid',
    );

    await mustFailStage(
      () => transportWith(function request(_opts, onResponse) {
        const response = new EventEmitter();
        response.statusCode = 200;
        Object.defineProperty(response, 'headers', {
          value: { 'content-type': 'application/json' },
          enumerable: true,
          configurable: true,
        });
        const req = new EventEmitter();
        req.destroy = () => {};
        response.destroy = () => {};
        req.end = () => {
          queueMicrotask(() => {
            onResponse(response);
            response.emit('data', 'not-a-buffer');
          });
        };
        return req;
      }).listMessageEnvelopeCount({ accessToken: TOKEN }),
      'stream_invalid',
    );

    await mustFailStage(
      () => transportWith(function request(_opts, onResponse) {
        const response = new EventEmitter();
        response.statusCode = 200;
        Object.defineProperty(response, 'headers', {
          value: { 'content-type': 'application/json' },
          enumerable: true,
          configurable: true,
        });
        const req = new EventEmitter();
        req.destroy = () => {};
        response.destroy = () => {};
        req.end = () => {
          queueMicrotask(() => {
            onResponse(response);
            response.emit('aborted');
          });
        };
        return req;
      }).listMessageEnvelopeCount({ accessToken: TOKEN }),
      'stream_aborted',
    );

    await mustFailStage(
      () => transportWith(function request(_opts, onResponse) {
        const response = new EventEmitter();
        response.statusCode = 200;
        Object.defineProperty(response, 'headers', {
          value: { 'content-type': 'application/json' },
          enumerable: true,
          configurable: true,
        });
        const req = new EventEmitter();
        req.destroy = () => {};
        response.destroy = () => {};
        req.end = () => {
          queueMicrotask(() => {
            onResponse(response);
            response.emit('data', Buffer.alloc(70_000, 0x61));
          });
        };
        return req;
      }).listMessageEnvelopeCount({ accessToken: TOKEN }),
      'response_too_large',
    );

    await mustFailStage(
      () => transportWith(mockHttps(200, `\ufffd`))
        .listMessageEnvelopeCount({ accessToken: TOKEN }),
      'utf8_invalid',
    );

    await mustFailStage(
      () => transportWith(mockHttps(200, '{'))
        .listMessageEnvelopeCount({ accessToken: TOKEN }),
      'json_invalid',
    );

    await mustFailStage(
      () => transportWith(mockHttps(200, JSON.stringify({ value: { id: 'x' } })))
        .listMessageEnvelopeCount({ accessToken: TOKEN }),
      'top_shape_invalid',
    );

    await mustFailStage(
      () => transportWith(mockHttps(200, listBody([envelopeRow({ importance: 'high' })])))
        .listMessageEnvelopeCount({ accessToken: TOKEN }),
      'row_keyset_invalid',
    );

    await mustFailStage(
      () => transportWith(mockHttps(200, listBody([envelopeRow({ id: '' })])))
        .listMessageEnvelopeCount({ accessToken: TOKEN }),
      'row_value_invalid',
    );

    for (const bad of [
      null, {}, { accessToken: TOKEN, top: 50 }, { accessToken: '' },
      { accessToken: 'bad\ntoken' }, Object.create(null),
    ]) {
      await mustFailStage(
        () => transportWith(mockHttps(200, JSON.stringify({ value: [] })))
          .listMessageEnvelopeCount(bad),
        'request_error',
      );
    }

    const once = transportWith(mockHttps(200, JSON.stringify({ value: [] })));
    await once.listMessageEnvelopeCount({ accessToken: TOKEN });
    await mustFailStage(() => once.listMessageEnvelopeCount({ accessToken: TOKEN }), 'request_error');

    assert.throws(
      () => createMicrosoftGraphDelegatedMessagesTransport({ httpsImpl: 'nope' }),
      (e) => e.code === FAILURE_CODE && e.graph_stage === 'request_error' && noLeak(e),
    );

    // Token scrub regressions preserved.
    {
      let timeoutFn = null;
      const hostile = createRetainingHttps('hang');
      const hangPromise = transportWith(hostile.request, {
        setTimeout: (fn) => { timeoutFn = fn; return 1; },
        clearTimeout: () => {},
      }).listMessageEnvelopeCount({ accessToken: TOKEN });
      assert.equal(hostile.sawTokenDuringCall(), true);
      assertRetainedOptionsScrubbed(hostile.getRetainedOptions(), 'after request creation');
      timeoutFn();
      await mustFailStage(() => hangPromise, 'timeout');
      assertRetainedOptionsScrubbed(hostile.getRetainedOptions(), 'after timeout');
    }
    {
      const hostile = createRetainingHttps('throw');
      await mustFailStage(
        () => transportWith(hostile.request).listMessageEnvelopeCount({ accessToken: TOKEN }),
        'request_error',
      );
      assertRetainedOptionsScrubbed(hostile.getRetainedOptions(), 'after sync throw');
    }
    {
      const hostile = createRetainingHttps('success');
      const graphInput = { accessToken: TOKEN };
      const ok = await transportWith(hostile.request).listMessageEnvelopeCount(graphInput);
      assert.deepEqual(ok, { message_count_bounded: 0, graph_stage: 'success' });
      assertRetainedOptionsScrubbed(hostile.getRetainedOptions(), 'after async success');
      assert.equal(graphInput.accessToken, TOKEN);
    }
    {
      const hostile = createRetainingHttps('async-error');
      await mustFailStage(
        () => transportWith(hostile.request).listMessageEnvelopeCount({ accessToken: TOKEN }),
        'stream_invalid',
      );
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
