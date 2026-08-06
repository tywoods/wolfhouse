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
  createMicrosoftGraphDelegatedMessagesTransport,
} = require('./lib/email-microsoft-graph-delegated-messages-transport');

const PLANTED = 'NEVER_LEAK_subject_addr_token';
const TOKEN = 'atok-NEVER_LEAK-abcdefghijklmnopqrstuvwxyz012345';

function noLeak(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return !text.includes('NEVER_LEAK') && !text.includes(PLANTED) && !text.includes(TOKEN);
}

function envelopeRow(patch = {}) {
  return {
    id: 'AAMkAG',
    subject: PLANTED,
    from: { emailAddress: { address: 'a@example.com', name: PLANTED } },
    receivedDateTime: '2026-01-01T00:00:00Z',
    isRead: true,
    conversationId: 'conv',
    hasAttachments: false,
    internetMessageId: '<x@y>',
    ...patch,
  };
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

    // Parser: bounded count only; never retains row content in return.
    const count = countBoundedMessageEnvelopes(JSON.stringify({
      value: [envelopeRow(), envelopeRow({ id: '2' })],
    }));
    assert.equal(count, 2);
    assert.equal(countBoundedMessageEnvelopes(JSON.stringify({ value: [] })), 0);

    for (const [name, body] of [
      ['too many rows', JSON.stringify({ value: Array.from({ length: 6 }, (_, i) => envelopeRow({ id: String(i) })) })],
      ['nextLink', JSON.stringify({ value: [envelopeRow()], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/evil' })],
      ['deltaLink', JSON.stringify({ value: [envelopeRow()], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/evil' })],
      ['body field', JSON.stringify({ value: [envelopeRow({ body: { content: PLANTED } })] })],
      ['bodyPreview', JSON.stringify({ value: [envelopeRow({ bodyPreview: PLANTED })] })],
      ['error object', JSON.stringify({ error: { code: 'Invalid', message: PLANTED } })],
      ['not array', JSON.stringify({ value: { id: 'x' } })],
      ['malformed', '{'],
    ]) {
      assert.equal(countBoundedMessageEnvelopes(body), null, name);
    }

    const transport = createMicrosoftGraphDelegatedMessagesTransport({
      httpsImpl: mockHttps(200, JSON.stringify({
        value: [envelopeRow(), envelopeRow({ id: 'b' }), envelopeRow({ id: 'c' })],
      })),
      timers: { setTimeout, clearTimeout },
    });
    const result = await transport.listMessageEnvelopeCount({ accessToken: TOKEN });
    assert.deepEqual(result, { message_count_bounded: 3 });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(noLeak(result), true);
    assert.equal(JSON.stringify(result).includes('subject'), false);
    assert.equal(JSON.stringify(result).includes(PLANTED), false);

    // Proxy response surface rejected.
    const ProxyHttps = function request(_opts, onResponse) {
      const target = new EventEmitter();
      target.statusCode = 200;
      const proxied = new Proxy(target, {
        get(t, prop) { return t[prop]; },
      });
      const req = new EventEmitter();
      req.end = () => {
        queueMicrotask(() => onResponse(proxied));
      };
      req.destroy = () => {};
      return req;
    };
    await mustFail(() => createMicrosoftGraphDelegatedMessagesTransport({
      httpsImpl: ProxyHttps,
      timers: { setTimeout, clearTimeout },
    }).listMessageEnvelopeCount({ accessToken: TOKEN }));

    // Non-200 / planted Graph error body never leaks.
    await mustFail(() => createMicrosoftGraphDelegatedMessagesTransport({
      httpsImpl: mockHttps(401, JSON.stringify({ error: { message: PLANTED } })),
      timers: { setTimeout, clearTimeout },
    }).listMessageEnvelopeCount({ accessToken: TOKEN }));

    // Path is fixed — transport must not accept top override via input.
    for (const bad of [
      null, {}, { accessToken: TOKEN, top: 50 }, { accessToken: '' },
      { accessToken: 'bad\ntoken' }, Object.create(null),
    ]) {
      await mustFail(() => createMicrosoftGraphDelegatedMessagesTransport({
        httpsImpl: mockHttps(200, JSON.stringify({ value: [] })),
        timers: { setTimeout, clearTimeout },
      }).listMessageEnvelopeCount(bad));
    }

    // Single-use burn.
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
    assert.deepEqual(logged, []);
  } finally {
    console.log = log;
    console.error = error;
  }
  log('verify:email-microsoft-graph-delegated-messages-transport: ok');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
