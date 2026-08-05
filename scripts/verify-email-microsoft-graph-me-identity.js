'use strict';

const assert = require('assert/strict');
const { EventEmitter } = require('events');
const {
  createMicrosoftGraphMeIdentityTransport,
  fetchMicrosoftGraphMeIdentity,
} = require('./lib/email-microsoft-graph-me-identity');

const TOKEN = 'offline-token-DO-NOT-LOG-7f1a';
const good = { id: 'graph-id-1', displayName: 'Ada Lovelace', mail: 'Ada@Example.COM', userPrincipalName: 'ada@example.com' };

function fake(spec = {}) {
  const calls = [];
  const requestImpl = (options, callback) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.end = () => {
      calls.push({ options, req });
      if (spec.never) return;
      if (spec.requestError) return queueMicrotask(() => req.emit('error', new Error('secret=' + TOKEN)));
      queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = spec.status === undefined ? 200 : spec.status;
        res.headers = spec.headers || { 'content-type': 'application/json; charset=utf-8' };
        res.destroyed = false;
        res.destroy = () => { res.destroyed = true; };
        calls[calls.length - 1].res = res;
        callback(res);
        if (spec.chunks) spec.chunks.forEach((chunk) => res.emit('data', chunk));
        else if (spec.body !== null) res.emit('data', spec.body === undefined ? JSON.stringify(good) : spec.body);
        if (!spec.noEnd) res.emit('end');
      });
    };
    return req;
  };
  return { fetch: createMicrosoftGraphMeIdentityTransport({ requestImpl }), calls };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'MicrosoftGraphIdentityError');
    assert.equal(error.code, code);
    assert.equal(Object.keys(error).join(','), 'code');
    assert(!String(error.stack).includes(TOKEN));
    return true;
  });
}

async function main() {
  const priorProxy = [process.env.HTTPS_PROXY, process.env.HTTP_PROXY, process.env.NO_PROXY];
  process.env.HTTPS_PROXY = 'http://attacker.invalid:9999/' + TOKEN;
  process.env.HTTP_PROXY = 'http://attacker.invalid:9999/' + TOKEN;
  process.env.NO_PROXY = '';
  try {
    const transport = fake();
    const result = await transport.fetch({ accessToken: TOKEN });
    assert.deepEqual(result, { id: 'graph-id-1', displayName: 'Ada Lovelace', mailbox: 'ada@example.com' });
    assert(Object.isFrozen(result));
    assert.equal(Object.keys(result).join(','), 'id,displayName,mailbox');
    assert.equal(transport.calls.length, 1);
    const options = transport.calls[0].options;
    assert.deepEqual({ protocol: options.protocol, hostname: options.hostname, host: options.host, port: options.port, method: options.method, path: options.path, agent: options.agent }, {
      protocol: 'https:', hostname: 'graph.microsoft.com', host: 'graph.microsoft.com', port: 443,
      method: 'GET', path: '/v1.0/me?$select=id,displayName,mail,userPrincipalName', agent: false,
    });
    assert.deepEqual(options.headers, { Accept: 'application/json', Authorization: 'Bearer ' + TOKEN });
    assert(!JSON.stringify(options).includes('attacker.invalid'));

    for (const input of [null, {}, { accessToken: TOKEN, extra: 1 }, { accessToken: '' }, { accessToken: 'has space' }, Object.create(null)]) {
      await rejectsCode(fake().fetch(input), 'INPUT_INVALID');
    }
    const accessor = {};
    Object.defineProperty(accessor, 'accessToken', { enumerable: true, get() { throw new Error(TOKEN); } });
    await rejectsCode(fake().fetch(accessor), 'INPUT_INVALID');
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error(TOKEN); } });
    await rejectsCode(fake().fetch(proxy), 'INPUT_INVALID');

    await rejectsCode(fake({ status: 302, headers: { location: 'https://evil.invalid/' + TOKEN } }).fetch({ accessToken: TOKEN }), 'HTTP_ERROR');
    await rejectsCode(fake({ status: 401, body: TOKEN }).fetch({ accessToken: TOKEN }), 'HTTP_ERROR');
    await rejectsCode(fake({ headers: { 'content-type': 'text/html' } }).fetch({ accessToken: TOKEN }), 'RESPONSE_INVALID');
    const declared = fake({ headers: { 'content-type': 'application/json', 'content-length': '40000' } });
    await rejectsCode(declared.fetch({ accessToken: TOKEN }), 'RESPONSE_TOO_LARGE');
    assert(declared.calls[0].res.destroyed);

    const overflow = fake({ chunks: [Buffer.alloc(20000), Buffer.alloc(20000)], noEnd: true });
    await rejectsCode(overflow.fetch({ accessToken: TOKEN }), 'RESPONSE_TOO_LARGE');
    assert(overflow.calls[0].req.destroyed);
    await rejectsCode(fake({ requestError: true }).fetch({ accessToken: TOKEN }), 'REQUEST_FAILED');

    const invalidJson = ['{', '[]', 'null', '{"id":"a","id":"b","displayName":"x","mail":"x@y.com"}',
      '{"id":"a","displayName":"x","mail":"x@y.com","nested":{"__proto__":1}}'];
    for (const body of invalidJson) await rejectsCode(fake({ body }).fetch({ accessToken: TOKEN }), 'RESPONSE_INVALID');

    const invalidIdentity = [
      { displayName: 'A', mail: 'a@example.com' },
      { id: '1', displayName: '', mail: 'a@example.com' },
      { id: '1', displayName: 'A', mail: null, userPrincipalName: null },
      { id: '1', displayName: 'A', mail: 'a@example.com', userPrincipalName: 'b@example.com' },
      { id: '1', displayName: 'A', mail: ' a@example.com' },
      { id: '1', displayName: 'A', mail: 'a@localhost' },
    ];
    for (const body of invalidIdentity) await rejectsCode(fake({ body: JSON.stringify(body) }).fetch({ accessToken: TOKEN }), 'IDENTITY_INVALID');

    const unknown = fake({ body: JSON.stringify({ ...good, accessToken: TOKEN, '@odata.context': 'discard', nested: { harmless: true } }) });
    const selected = await unknown.fetch({ accessToken: TOKEN });
    assert.deepEqual(Object.keys(selected), ['id', 'displayName', 'mailbox']);
    assert(!JSON.stringify(selected).includes(TOKEN));

    const upnOnly = await fake({ body: JSON.stringify({ id: '2', displayName: 'Grace', mail: null, userPrincipalName: 'Grace@Example.org' }) }).fetch({ accessToken: TOKEN });
    assert.equal(upnOnly.mailbox, 'grace@example.org');

    // The production export is not dependency-configurable and does not inspect proxy variables.
    assert.equal(typeof fetchMicrosoftGraphMeIdentity, 'function');

    const timeout = fake({ never: true });
    await rejectsCode(timeout.fetch({ accessToken: TOKEN }), 'DEADLINE_EXCEEDED');
    assert(timeout.calls[0].req.destroyed);

    console.log('PASS verify:email-microsoft-graph-me-identity (offline hostile transport/validator gate)');
  } finally {
    [process.env.HTTPS_PROXY, process.env.HTTP_PROXY, process.env.NO_PROXY] = priorProxy;
  }
}

main().catch((error) => {
  console.error('FAIL verify:email-microsoft-graph-me-identity:', error && error.message ? error.message : 'unknown');
  process.exitCode = 1;
});
