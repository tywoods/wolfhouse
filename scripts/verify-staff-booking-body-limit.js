#!/usr/bin/env node
'use strict';
// Real loopback transport + production reader; payload sizes here are boundary
// specimens, not booking-save evidence. The companion Python test owns real SQL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const start = source.indexOf('function readBody(req) {');
assert.notEqual(start, -1, 'Production readBody anchor');
const end = source.indexOf('\n}\n', start) + 2;
const readBody = vm.runInNewContext('(' + source.slice(start, end) + ')', { Buffer });

async function exchange(route, raw) {
  let readerError = null;
  const server = http.createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      assert.equal(await readBody(req), body, 'Second consumer must use cached body');
      res.end(JSON.stringify({ bytes: Buffer.byteLength(body), parsed: JSON.parse(body) }));
    } catch (error) {
      readerError = error.message;
      if (!res.destroyed) { res.writeHead(400); res.end('reader rejected'); }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise(resolve => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: route, method: 'POST', headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw),
        } }, res => {
          let text = '';
          res.on('data', chunk => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, text }));
        });
      req.setTimeout(3000, () => req.destroy(new Error('test request timed out')));
      req.on('error', error => resolve({ transportError: error.code || error.message }));
      req.write(raw.slice(0, 7000));
      req.end(raw.slice(7000));
    });
    return { ...result, readerError };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

for (const route of ['/staff/bot/booking-create-from-plan', '/staff/bot/bookings/create']) {
  test(`${route}: accepted quote body above old 10KB cap reaches handler intact`, async () => {
    const raw = JSON.stringify({ accepted_quote: 'quote-boundary-specimen'.repeat(550) });
    assert(Buffer.byteLength(raw) > 10240);
    const result = await exchange(route, raw);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.readerError, null);
    assert.deepEqual(JSON.parse(result.text).parsed, JSON.parse(raw));
    assert.equal(JSON.parse(result.text).bytes, Buffer.byteLength(raw));
  });
}

test('validated booking body survives the internal create handoff without a second 10KB cap', async () => {
  const { makeInMemoryBotReq } = require('./lib/staff-bot-v2-routes');
  const body = { accepted_quote: 'quote-boundary-specimen'.repeat(550) };
  const raw = JSON.stringify(body);
  assert(Buffer.byteLength(raw) > 10240);
  const admitted = await exchange('/staff/bot/booking-create-from-plan', raw);
  assert.equal(admitted.status, 200, JSON.stringify(admitted));
  assert.equal(await readBody(makeInMemoryBotReq(body, {})), raw);
});

test('unrelated routes retain their existing 10KB limit', async () => {
  const result = await exchange('/staff/auth/login', JSON.stringify({ value: 'x'.repeat(11000) }));
  assert.equal(result.readerError, 'body too large');
  assert.equal(result.transportError, 'ECONNRESET');
});

test('booking allowance remains bounded at 1MiB', async () => {
  const result = await exchange('/staff/bot/booking-create-from-plan',
    JSON.stringify({ value: 'x'.repeat(1024 * 1024) }));
  assert.equal(result.readerError, 'body too large');
  assert.equal(result.transportError, 'ECONNRESET');
});
