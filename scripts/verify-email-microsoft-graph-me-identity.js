'use strict';

const assert = require('assert/strict');
const { EventEmitter } = require('events');
const { createMicrosoftGraphMeIdentityTransport } = require('./lib/email-microsoft-graph-me-identity');

const TOKEN = 'offline-token-DO-NOT-LOG-7f1a';
const GOOD = { id: 'graph-id-1', displayName: 'Ada Lovelace', mail: 'Ada@Example.COM', userPrincipalName: 'ada@example.com' };

function manualTimers({ synchronous = false, throws = false } = {}) {
  const state = { handles: [], clears: [] };
  const timers = {
    setTimeout(callback, milliseconds) {
      if (throws) throw new Error('timer secret ' + TOKEN);
      const handle = { callback, milliseconds };
      state.handles.push(handle);
      if (synchronous) callback();
      return handle;
    },
    clearTimeout(handle) { state.clears.push(handle); },
  };
  return { timers, state };
}

function fake(spec = {}) {
  const calls = [];
  const clock = spec.clock || manualTimers();
  const httpsImpl = (options, callback) => {
    if (spec.requestThrows) throw new Error('request secret ' + TOKEN);
    const req = new EventEmitter();
    req.destroyCount = 0;
    req.destroy = () => { req.destroyCount += 1; };
    req.end = () => {
      const call = { options, req };
      calls.push(call);
      if (spec.never) return;
      if (spec.requestError) { queueMicrotask(() => req.emit('error', new Error(TOKEN))); return; }
      const emitResponse = () => {
        const res = new EventEmitter();
        res.statusCode = spec.status === undefined ? 200 : spec.status;
        res.headers = spec.headers || { 'content-type': 'application/json; charset=utf-8' };
        res.destroyCount = 0;
        res.destroy = () => { res.destroyCount += 1; };
        call.res = res;
        callback(res);
        if (spec.onResponse) { spec.onResponse({ req, res, clock }); return; }
        const chunks = spec.chunks || [Buffer.from(spec.body === undefined ? JSON.stringify(GOOD) : spec.body)];
        for (const chunk of chunks) res.emit('data', chunk);
        if (!spec.noEnd) res.emit('end');
      };
      if (spec.syncResponse) emitResponse(); else queueMicrotask(emitResponse);
    };
    return req;
  };
  const service = createMicrosoftGraphMeIdentityTransport({ httpsImpl, timers: clock.timers });
  return { service, fetch: service.fetchIdentity, calls, clock };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'MicrosoftGraphIdentityError');
    assert.equal(error.code, code);
    assert.equal(error.message, {
      INPUT_INVALID: 'Microsoft Graph identity input is invalid.', REQUEST_FAILED: 'Microsoft Graph identity request failed.',
      DEADLINE_EXCEEDED: 'Microsoft Graph identity request timed out.', RESPONSE_TOO_LARGE: 'Microsoft Graph identity response was too large.',
      HTTP_ERROR: 'Microsoft Graph identity request was rejected.', RESPONSE_INVALID: 'Microsoft Graph identity response was invalid.',
      IDENTITY_INVALID: 'Microsoft Graph identity was invalid.',
    }[code]);
    assert.deepEqual(Object.keys(error), ['code']);
    assert(!String(error.stack).includes(TOKEN));
    return true;
  });
}

async function one(spec, input = { accessToken: TOKEN }) {
  const transport = fake(spec);
  return { transport, promise: transport.fetch(input) };
}

async function main() {
  // Exact frozen factory/service contract; no reusable singleton export.
  const exported = require('./lib/email-microsoft-graph-me-identity');
  assert.deepEqual(Object.keys(exported), ['createMicrosoftGraphMeIdentityTransport']);
  assert(Object.isFrozen(exported));
  const transport = fake();
  assert.deepEqual(Object.keys(transport.service), ['fetchIdentity']);
  assert(Object.isFrozen(transport.service));
  const result = await transport.fetch({ accessToken: TOKEN });
  assert.deepEqual(result, { providerSubjectId: 'graph-id-1', mailboxAddress: 'ada@example.com', displayName: 'Ada Lovelace' });
  assert.deepEqual(Object.keys(result), ['providerSubjectId', 'mailboxAddress', 'displayName']);
  assert(Object.isFrozen(result));
  assert(!('id' in result) && !('mailbox' in result));
  assert.equal(transport.clock.state.clears.length, 1);
  const options = transport.calls[0].options;
  assert(Object.isFrozen(options) && Object.isFrozen(options.headers));
  assert.deepEqual({ protocol: options.protocol, hostname: options.hostname, host: options.host, port: options.port, method: options.method, path: options.path, agent: options.agent }, {
    protocol: 'https:', hostname: 'graph.microsoft.com', host: 'graph.microsoft.com', port: 443, method: 'GET',
    path: '/v1.0/me?$select=id,displayName,mail,userPrincipalName', agent: false,
  });
  assert.deepEqual(options.headers, { Accept: 'application/json', Authorization: ['Bearer', TOKEN].join(' ') });

  // Dependency traps/accessors/symbols/extra keys are masked at factory time.
  for (const deps of [null, [], { nope: 1 }, { httpsImpl: 1 }, { timers: {} }, { [Symbol('x')]: 1 }]) {
    assert.throws(() => createMicrosoftGraphMeIdentityTransport(deps), (e) => e.code === 'INPUT_INVALID' && !String(e).includes(TOKEN));
  }
  const depAccessor = {};
  Object.defineProperty(depAccessor, 'httpsImpl', { get() { throw new Error(TOKEN); } });
  assert.throws(() => createMicrosoftGraphMeIdentityTransport(depAccessor), (e) => e.code === 'INPUT_INVALID');
  const depProxy = new Proxy({}, { ownKeys() { throw new Error(TOKEN); } });
  assert.throws(() => createMicrosoftGraphMeIdentityTransport(depProxy), (e) => e.code === 'INPUT_INVALID');

  // Atomic single-use: invalid, sequential, concurrent, and validation-reentrant attempts all burn first.
  const invalidFirst = fake();
  await rejectsCode(invalidFirst.fetch({ accessToken: '' }), 'INPUT_INVALID');
  await rejectsCode(invalidFirst.fetch({ accessToken: TOKEN }), 'INPUT_INVALID');
  const sequential = fake();
  await sequential.fetch({ accessToken: TOKEN });
  await rejectsCode(sequential.fetch({ accessToken: TOKEN }), 'INPUT_INVALID');
  const concurrent = fake({ never: true });
  const pending = concurrent.fetch({ accessToken: TOKEN });
  await rejectsCode(concurrent.fetch({ accessToken: TOKEN }), 'INPUT_INVALID');
  concurrent.clock.state.handles[0].callback();
  await rejectsCode(pending, 'DEADLINE_EXCEEDED');
  const reentrant = fake();
  const inputProxy = new Proxy({}, { getPrototypeOf() { void reentrant.fetch({ accessToken: TOKEN }).catch(() => {}); throw new Error(TOKEN); } });
  await rejectsCode(reentrant.fetch(inputProxy), 'INPUT_INVALID');
  assert.equal(reentrant.calls.length, 0);

  const nonenumerable = {};
  Object.defineProperty(nonenumerable, 'accessToken', { value: TOKEN });
  for (const input of [null, {}, Object.create(null), { accessToken: '' }, { accessToken: 'a'.repeat(16385) },
    { accessToken: 'has space' }, { accessToken: TOKEN, extra: 1 }, { accessToken: TOKEN, [Symbol('x')]: 1 }, nonenumerable]) {
    await rejectsCode(fake().fetch(input), 'INPUT_INVALID');
  }
  assert.equal((await fake().fetch({ accessToken: 'x' })).providerSubjectId, 'graph-id-1');
  assert.equal((await fake().fetch({ accessToken: 'x'.repeat(16384) })).providerSubjectId, 'graph-id-1');

  // Exact 200 only; status/body/header secrets never leak.
  for (const status of [201, 204, 302, 401]) await rejectsCode((await one({ status, body: TOKEN })).promise, 'HTTP_ERROR');
  await rejectsCode((await one({ headers: { 'content-type': 'text/html', location: TOKEN } })).promise, 'RESPONSE_INVALID');
  await rejectsCode((await one({ requestError: true })).promise, 'REQUEST_FAILED');
  await rejectsCode((await one({ requestThrows: true })).promise, 'REQUEST_FAILED');

  // Buffer-only and cap-before-add/store, destroying both active objects exactly once.
  const nonBuffer = await one({ chunks: ['not-a-buffer'], noEnd: true });
  await rejectsCode(nonBuffer.promise, 'RESPONSE_INVALID');
  assert.equal(nonBuffer.transport.calls[0].req.destroyCount, 1);
  assert.equal(nonBuffer.transport.calls[0].res.destroyCount, 1);
  const overflow = await one({ chunks: [Buffer.alloc(32768), Buffer.alloc(1)], noEnd: true });
  await rejectsCode(overflow.promise, 'RESPONSE_TOO_LARGE');
  assert.equal(overflow.transport.calls[0].req.destroyCount, 1);
  assert.equal(overflow.transport.calls[0].res.destroyCount, 1);

  // Response lifecycle permutations and late/duplicate events settle once.
  for (const event of ['error', 'aborted', 'close']) {
    const lifecycle = await one({ noEnd: true, onResponse: ({ res }) => { res.emit(event, new Error(TOKEN)); res.emit('end'); res.emit('aborted'); } });
    await rejectsCode(lifecycle.promise, 'REQUEST_FAILED');
    assert.equal(lifecycle.transport.clock.state.clears.length, 1);
  }
  const endedClose = await one({ onResponse: ({ res }) => { res.emit('data', Buffer.from(JSON.stringify(GOOD))); res.emit('end'); res.emit('close'); } });
  assert.equal((await endedClose.promise).providerSubjectId, 'graph-id-1');

  // Timeout after response acquisition destroys response+request; late events are inert.
  const deadline = await one({ noEnd: true, onResponse: ({ res, clock }) => {
    res.emit('data', Buffer.from('{'));
    clock.state.handles[0].callback();
    res.emit('data', Buffer.alloc(32768)); res.emit('end'); res.emit('error', new Error(TOKEN));
  } });
  await rejectsCode(deadline.promise, 'DEADLINE_EXCEEDED');
  assert.equal(deadline.transport.calls[0].req.destroyCount, 1);
  assert.equal(deadline.transport.calls[0].res.destroyCount, 1);
  assert.equal(deadline.transport.clock.state.clears.length, 1);

  // Synchronous timer callback and timer throw are TDZ-safe; acquired handle cleared exactly once.
  const syncClock = manualTimers({ synchronous: true });
  const syncTimer = fake({ clock: syncClock, never: true });
  await rejectsCode(syncTimer.fetch({ accessToken: TOKEN }), 'DEADLINE_EXCEEDED');
  assert.equal(syncClock.state.clears.length, 1);
  const throwingTimer = fake({ clock: manualTimers({ throws: true }) });
  await rejectsCode(throwingTimer.fetch({ accessToken: TOKEN }), 'REQUEST_FAILED');
  assert.equal(throwingTimer.calls.length, 0);

  // Strict duplicate/dangerous parser, including escaped and nested probes.
  const invalidJson = ['{', '[]', 'null',
    '{"id":"a","id":"b","mail":"a@example.com"}',
    '{"id":"a","mail":"a@example.com","nested":{"__proto__":1}}',
    '{"id":"a","mail":"a@example.com","nested":{"\\u005f\\u005fproto__":1}}',
    '{"id":"x\\ud800y","mail":"x@example.com"}',
    '{"id":"x","displayName":"x\\ud800y","mail":"x@example.com"}',
    '{"id":"x\\udc00y","mail":"x@example.com"}',
    '{"id":"a","mail":"a@example.com","nested":{"safe":1,"s\\u0061fe":2}}'];
  for (const body of invalidJson) await rejectsCode((await one({ body })).promise, 'RESPONSE_INVALID');

  for (const displayName of [null, undefined, '']) {
    const body = { id: 'x', mail: 'x@example.com' };
    if (displayName !== undefined) body.displayName = displayName;
    assert.equal((await (await one({ body: JSON.stringify(body) })).promise).displayName, null);
  }
  assert.equal((await (await one({ body: JSON.stringify({ id: 'x', mail: 'x@example.com', displayName: ' X ' }) })).promise).displayName, ' X ');
  assert.equal((await (await one({ body: JSON.stringify({ id: 'x', mail: 'x@example.com', displayName: 'Wave 🏄' }) })).promise).displayName, 'Wave 🏄');
  for (const displayName of [1, {}, 'bad\nname', 'x'.repeat(257)]) {
    await rejectsCode((await one({ body: JSON.stringify({ id: 'x', mail: 'x@example.com', displayName }) })).promise, 'IDENTITY_INVALID');
  }

  console.log('PASS verify:email-microsoft-graph-me-identity (offline hostile single-use transport/validator gate)');
}

main().catch((error) => {
  console.error('FAIL verify:email-microsoft-graph-me-identity:', error && error.message ? error.message : 'unknown');
  process.exitCode = 1;
});
