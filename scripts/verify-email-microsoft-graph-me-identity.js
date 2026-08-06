'use strict';

const assert = require('assert/strict');
const http = require('http');
const { EventEmitter } = require('events');
const { Socket } = require('net');
const { createMicrosoftGraphMeIdentityTransport } = require('./lib/email-microsoft-graph-me-identity');

const TOKEN = 'offline-token-DO-NOT-LOG-7f1a';
const GOOD = { id: 'graph-id-1', displayName: 'Ada Lovelace', mail: 'Ada@Example.COM', userPrincipalName: 'ada@example.com' };

/**
 * Real Node http.IncomingMessage response shape: headers live on the prototype
 * as a native getter (not own data). Production Graph /me responses look like this.
 */
function nativeIncomingMessageResponse(spec = {}) {
  const res = new http.IncomingMessage(new Socket());
  res.statusCode = spec.status === undefined ? 200 : spec.status;
  // Setter populates internal state; getter remains the non-own prototype accessor.
  res.headers = spec.headers || { 'content-type': 'application/json; charset=utf-8' };
  res.destroyCount = 0;
  res.destroy = () => { res.destroyCount += 1; };
  // Precondition: headers must NOT be own data (the production bug surface).
  assert.equal(Object.prototype.hasOwnProperty.call(res, 'headers'), false);
  const ownHeadersDesc = Object.getOwnPropertyDescriptor(res, 'headers');
  assert.equal(ownHeadersDesc, undefined);
  return res;
}

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
        let res;
        if (spec.nativeResponse) {
          res = nativeIncomingMessageResponse({
            status: spec.status,
            headers: spec.headers,
          });
        } else if (spec.responseFactory) {
          res = spec.responseFactory({ status: spec.status, headers: spec.headers });
        } else {
          res = new EventEmitter();
          res.statusCode = spec.status === undefined ? 200 : spec.status;
          res.headers = spec.headers || { 'content-type': 'application/json; charset=utf-8' };
          res.destroyCount = 0;
          res.destroy = () => { res.destroyCount += 1; };
        }
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

  // ── Mail / UPN selection (Microsoft allows these to differ) ──────────────
  // Live root cause after scope fix: Graph /me returns distinct valid mail and
  // userPrincipalName (GoDaddy/M365 aliases). Equality gate rejected identity
  // so the pipeline never emitted graph_identity_verified.
  // Prefer canonical mail when present; otherwise canonical UPN. Validate each
  // present nonempty field independently; never silently skip hostile mail.
  // Selected mailboxAddress is the sole ownership key matched to endpoint
  // public_address at install time (exact equals — no alias lists).
  const REALISTIC_MAIL = 'support@lunafrontdesk.com';
  const REALISTIC_UPN = 'support@lunafrontdesk.onmicrosoft.com';
  const REALISTIC_ME = {
    id: 'graph-id-godaddy-1',
    displayName: 'Luna Support',
    mail: 'Support@LunaFrontDesk.COM',
    userPrincipalName: REALISTIC_UPN,
  };
  assert.notEqual(REALISTIC_MAIL, REALISTIC_UPN, 'fixture precondition: mail and UPN differ');

  const preferMail = await (await one({ body: JSON.stringify(REALISTIC_ME) })).promise;
  assert.deepEqual(preferMail, {
    providerSubjectId: 'graph-id-godaddy-1',
    mailboxAddress: REALISTIC_MAIL,
    displayName: 'Luna Support',
  });
  assert.deepEqual(Object.keys(preferMail), ['providerSubjectId', 'mailboxAddress', 'displayName']);
  assert(Object.isFrozen(preferMail));
  // Ownership binding surface: installer compares public_address to this field only.
  assert.equal(preferMail.mailboxAddress, REALISTIC_MAIL);
  assert.notEqual(preferMail.mailboxAddress, REALISTIC_UPN);

  // mail null / omitted / empty → use canonical UPN when present and valid.
  for (const mail of [null, undefined, '']) {
    const body = { id: 'upn-only-1', userPrincipalName: 'Ada@Example.COM', displayName: 'Ada' };
    if (mail !== undefined) body.mail = mail;
    const result = await (await one({ body: JSON.stringify(body) })).promise;
    assert.deepEqual(result, {
      providerSubjectId: 'upn-only-1',
      mailboxAddress: 'ada@example.com',
      displayName: 'Ada',
    });
  }

  // UPN null / omitted / empty → use canonical mail when present and valid.
  for (const upn of [null, undefined, '']) {
    const body = { id: 'mail-only-1', mail: 'Support@LunaFrontDesk.COM', displayName: 'Support' };
    if (upn !== undefined) body.userPrincipalName = upn;
    const result = await (await one({ body: JSON.stringify(body) })).promise;
    assert.deepEqual(result, {
      providerSubjectId: 'mail-only-1',
      mailboxAddress: REALISTIC_MAIL,
      displayName: 'Support',
    });
  }

  // Require at least one present valid mailbox field.
  for (const body of [
    { id: 'none-1' },
    { id: 'none-2', mail: null, userPrincipalName: null },
    { id: 'none-3', mail: '', userPrincipalName: '' },
    { id: 'none-4', mail: null },
    { id: 'none-5', userPrincipalName: null },
  ]) {
    await rejectsCode((await one({ body: JSON.stringify(body) })).promise, 'IDENTITY_INVALID');
  }

  // Fail-closed: malformed present mail must not fall through to a valid UPN.
  for (const mail of [
    'not-an-email',
    'support@',
    'support@localhost',
    ' support@lunafrontdesk.com',
    'support@lunafrontdesk.com ',
    'a@b',
    'support@@lunafrontdesk.com',
    'support@luna..frontdesk.com',
  ]) {
    await rejectsCode(
      (await one({
        body: JSON.stringify({
          id: 'hostile-mail-1',
          mail,
          userPrincipalName: REALISTIC_UPN,
          displayName: 'X',
        }),
      })).promise,
      'IDENTITY_INVALID',
    );
  }

  // Fail-closed: malformed present UPN must not be ignored when mail is valid.
  for (const upn of [
    'not-an-email',
    'support@',
    'support@localhost',
    ' support@lunafrontdesk.com',
    'support@lunafrontdesk.com ',
    'a@b',
    'support@@lunafrontdesk.com',
  ]) {
    await rejectsCode(
      (await one({
        body: JSON.stringify({
          id: 'hostile-upn-1',
          mail: REALISTIC_MAIL,
          userPrincipalName: upn,
          displayName: 'X',
        }),
      })).promise,
      'IDENTITY_INVALID',
    );
  }

  // Equal after lowercasing remains accepted (case-insensitive identity of same address).
  const sameAfterCase = await (await one({
    body: JSON.stringify({
      id: 'same-case-1',
      mail: 'Ada@Example.COM',
      userPrincipalName: 'ada@example.com',
      displayName: 'Ada',
    }),
  })).promise;
  assert.equal(sameAfterCase.mailboxAddress, 'ada@example.com');

  // ── Native IncomingMessage headers (production Graph response shape) ─────
  // Live root cause: statusCode is own data (HTTP 200 accepted) but headers is a
  // non-own native getter on http.IncomingMessage.prototype. readOwnData(response,
  // 'headers') always returned undefined → content-type check failed as
  // RESPONSE_INVALID → no graph_headers_accepted. Own-data EventEmitter mocks
  // passed; production Node responses did not.
  {
    const nativeOk = await one({ nativeResponse: true });
    const nativeResult = await nativeOk.promise;
    assert.deepEqual(nativeResult, {
      providerSubjectId: 'graph-id-1',
      mailboxAddress: 'ada@example.com',
      displayName: 'Ada Lovelace',
    });
    assert(Object.isFrozen(nativeResult));
    // Confirm the response that succeeded was genuinely non-own headers.
    assert.equal(Object.prototype.hasOwnProperty.call(nativeOk.transport.calls[0].res, 'headers'), false);
  }

  // Native path still enforces content-type / content-length gates.
  await rejectsCode(
    (await one({
      nativeResponse: true,
      headers: { 'content-type': 'text/plain' },
    })).promise,
    'RESPONSE_INVALID',
  );
  await rejectsCode(
    (await one({
      nativeResponse: true,
      headers: {
        'content-type': 'application/json',
        'content-length': String(1_000_000),
      },
    })).promise,
    'RESPONSE_TOO_LARGE',
  );

  // Array / obs-fold ambiguity: content-type must be a single string (not array).
  await rejectsCode(
    (await one({
      nativeResponse: true,
      headers: { 'content-type': ['application/json', 'text/plain'] },
    })).promise,
    'RESPONSE_INVALID',
  );
  await rejectsCode(
    (await one({
      headers: { 'content-type': ['application/json'] },
    })).promise,
    'RESPONSE_INVALID',
  );
  // Comma-joined duplicate content-type fails exact application/json gate.
  await rejectsCode(
    (await one({
      nativeResponse: true,
      headers: { 'content-type': 'application/json, text/plain' },
    })).promise,
    'RESPONSE_INVALID',
  );
  // Malformed content-length (non-digits / duplicates joined) rejected.
  await rejectsCode(
    (await one({
      nativeResponse: true,
      headers: {
        'content-type': 'application/json',
        'content-length': '12,34',
      },
    })).promise,
    'RESPONSE_INVALID',
  );

  // Hostile custom prototype getter: must NOT be trusted (only pinned IM getter
  // or own-data plain mocks). Attacker-shaped response with getter → fail closed.
  {
    const HostileProto = {
      get headers() {
        throw new Error('hostile headers getter ' + TOKEN);
      },
    };
    await rejectsCode(
      (await one({
        responseFactory() {
          const res = Object.create(HostileProto);
          // statusCode own-data 200 so we reach header inspection.
          res.statusCode = 200;
          res.destroyCount = 0;
          res.destroy = () => { res.destroyCount += 1; };
          // Event surface for stream path (should not reach body on fail-closed headers).
          const ee = new EventEmitter();
          res.on = ee.on.bind(ee);
          res.once = ee.once.bind(ee);
          res.emit = ee.emit.bind(ee);
          return res;
        },
      })).promise,
      'RESPONSE_INVALID',
    );
  }

  // Subclass / foreign prototype that shadows headers getter is rejected even if
  // it claims to look like IncomingMessage.
  {
    function FakeIncomingMessage() {
      EventEmitter.call(this);
      this.statusCode = 200;
      this.destroyCount = 0;
      this.destroy = () => { this.destroyCount += 1; };
    }
    Object.setPrototypeOf(FakeIncomingMessage.prototype, http.IncomingMessage.prototype);
    Object.defineProperty(FakeIncomingMessage.prototype, 'headers', {
      configurable: true,
      enumerable: false,
      get() {
        return { 'content-type': 'application/json; charset=utf-8' };
      },
    });
    await rejectsCode(
      (await one({
        responseFactory() {
          return new FakeIncomingMessage();
        },
      })).promise,
      'RESPONSE_INVALID',
    );
  }

  // Post-init ambient monkeypatch proof: rebinding require('http').IncomingMessage
  // (or attempting to redefine the prototype getter) must not divert the pin.
  // Node's native headers descriptor is non-configurable — redefine throws; pin
  // still serves genuine IncomingMessage instances constructed from the real class.
  {
    const originalIM = http.IncomingMessage;
    let redefineThrew = false;
    try {
      Object.defineProperty(http.IncomingMessage.prototype, 'headers', {
        configurable: true,
        enumerable: false,
        get() {
          return { 'content-type': 'text/html', 'x-hostile': TOKEN };
        },
      });
    } catch {
      redefineThrew = true;
    }
    assert.equal(redefineThrew, true, 'native headers getter must remain non-configurable');
    // Ambient replacement of the http export binding must not divert the pin.
    http.IncomingMessage = function HostileIncomingMessage() {
      throw new Error('ambient IncomingMessage replacement ' + TOKEN);
    };
    try {
      const patched = await one({
        responseFactory() {
          const r = new originalIM(new Socket());
          r.statusCode = 200;
          r.headers = { 'content-type': 'application/json; charset=utf-8' };
          r.destroyCount = 0;
          r.destroy = () => { r.destroyCount += 1; };
          assert.equal(Object.prototype.hasOwnProperty.call(r, 'headers'), false);
          assert.equal(r.constructor, originalIM);
          return r;
        },
      });
      const result = await patched.promise;
      assert.equal(result.providerSubjectId, 'graph-id-1');
      assert.equal(result.mailboxAddress, 'ada@example.com');
    } finally {
      http.IncomingMessage = originalIM;
    }
  }

  // Own-data plain mock path remains accepted (regression guard for unit tests).
  {
    const plain = await one({});
    assert.equal((await plain.promise).providerSubjectId, 'graph-id-1');
    assert.equal(Object.prototype.hasOwnProperty.call(plain.transport.calls[0].res, 'headers'), true);
  }

  console.log('PASS verify:email-microsoft-graph-me-identity (offline hostile single-use transport/validator gate)');
}

main().catch((error) => {
  console.error('FAIL verify:email-microsoft-graph-me-identity:', error && error.message ? error.message : 'unknown');
  process.exitCode = 1;
});
