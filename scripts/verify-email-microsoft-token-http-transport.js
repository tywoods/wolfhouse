'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  TOKEN_HOST, TOKEN_PATH, RESPONSE_LIMIT_BYTES, DEADLINE_MS,
  createMicrosoftTokenHttpTransport,
} = require('./lib/email-microsoft-token-http-transport');

function harness() {
  const calls = [];
  const timers = [];
  const timerApi = {
    setTimeout(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cleared = true; },
  };
  const httpsImpl = {
    request(options, callback) {
      const request = new EventEmitter();
      Object.assign(request, {
        destroyed: false, endedBody: undefined,
        destroy(error) { this.destroyed = true; this.destroyError = error; },
        end(body) { this.endedBody = body; },
      });
      calls.push({ options, callback, request });
      return request;
    },
  };
  return { calls, timers, timerApi, httpsImpl };
}

function response(statusCode, contentType) {
  const incoming = new EventEmitter();
  incoming.statusCode = statusCode;
  incoming.headers = contentType === undefined ? {} : { 'content-type': contentType };
  incoming.destroyed = false;
  incoming.destroy = function destroy(error) { this.destroyed = true; this.destroyError = error; };
  return incoming;
}

async function rejectedCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, code);
    assert.equal(error.code, code);
    assert.deepEqual(Object.keys(error).sort(), ['code']);
    return true;
  });
}

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const captured = [];
  console.log = (...args) => captured.push(args);
  console.error = (...args) => captured.push(args);
  try {
    {
      const h = harness();
      const transport = createMicrosoftTokenHttpTransport({ httpsImpl: h.httpsImpl, timers: h.timerApi });
      const pending = transport.postTokenForm({ body: 'code=TOP-SECRET&client_secret=MORE-SECRET' });
      assert.equal(h.calls.length, 1);
      const call = h.calls[0];
      assert.deepEqual(call.options, {
        protocol: 'https:', hostname: TOKEN_HOST, port: 443, method: 'POST', path: TOKEN_PATH,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(call.request.endedBody),
          Accept: 'application/json',
        },
      });
      assert.equal(Object.isFrozen(call.options), true);
      assert.equal(TOKEN_HOST, 'login.microsoftonline.com');
      assert.equal(TOKEN_PATH, '/organizations/oauth2/v2.0/token');
      assert.equal(h.timers[0].ms, DEADLINE_MS);
      h.timers[0].fn();
      assert.equal(call.request.destroyed, true, 'deadline must destroy request');
      await rejectedCode(pending, 'microsoft_token_request_timed_out');
    }

    {
      const h = harness();
      const pending = createMicrosoftTokenHttpTransport({ httpsImpl: h.httpsImpl, timers: h.timerApi })
        .postTokenForm({ body: 'code=x' });
      const incoming = response(200, 'application/json; charset=utf-8');
      h.calls[0].callback(incoming);
      incoming.emit('data', Buffer.alloc(RESPONSE_LIMIT_BYTES));
      assert.equal(incoming.destroyed, false);
      incoming.emit('data', Buffer.from('x'));
      assert.equal(incoming.destroyed, true, 'overflow must immediately destroy response');
      assert.equal(h.calls[0].request.destroyed, true, 'overflow must immediately destroy request');
      incoming.emit('data', Buffer.alloc(RESPONSE_LIMIT_BYTES));
      incoming.emit('end');
      await rejectedCode(pending, 'microsoft_token_response_too_large');
    }

    for (const specimen of [
      { statusCode: 400, contentType: 'application/json', body: '{"error":"invalid_grant"}' },
      { statusCode: 200, contentType: 'text/html', body: '<html>not json</html>' },
      { statusCode: 302, contentType: 'application/json', body: '{}' },
    ]) {
      const h = harness();
      const pending = createMicrosoftTokenHttpTransport({ httpsImpl: h.httpsImpl, timers: h.timerApi })
        .postTokenForm({ body: 'code=x' });
      const incoming = response(specimen.statusCode, specimen.contentType);
      h.calls[0].callback(incoming);
      incoming.emit('data', specimen.body);
      incoming.emit('end');
      assert.deepEqual(await pending, specimen);
      assert.equal(h.calls.length, 1, 'redirect responses must never be followed');
      assert.equal(h.timers[0].cleared, true);
    }

    {
      const h = harness();
      const pending = createMicrosoftTokenHttpTransport({ httpsImpl: h.httpsImpl, timers: h.timerApi })
        .postTokenForm({ body: 'client_secret=TOP-SECRET' });
      h.calls[0].request.emit('error', new Error('socket leaked client_secret=TOP-SECRET'));
      await rejectedCode(pending, 'microsoft_token_transport_failed');
    }

    for (const bad of [
      null, {}, { body: 'x', url: 'https://evil.example' }, { body: 'x', hostname: 'evil.example' },
      { body: 'x', method: 'GET' }, { body: 'x', followRedirects: true }, { body: Buffer.from('x') },
    ]) {
      const h = harness();
      await rejectedCode(
        createMicrosoftTokenHttpTransport({ httpsImpl: h.httpsImpl, timers: h.timerApi }).postTokenForm(bad),
        'microsoft_token_request_invalid',
      );
      assert.equal(h.calls.length, 0);
    }

    assert.deepEqual(captured, [], 'transport and hostile cases must not log secrets or errors');
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  originalLog('PASS Microsoft token HTTP transport hostile offline gates');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
