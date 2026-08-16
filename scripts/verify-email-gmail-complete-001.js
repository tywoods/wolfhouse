'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const PgResult = require('pg/lib/result');
const { createGoogleOAuthTransactionRepository } = require('./lib/email-google-oauth-transaction-repository');
const { createGoogleOAuthCallbackConsume } = require('./lib/email-google-oauth-callback-consume');

const freeze = Object.freeze;
const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION = '12345678-90ab-4cde-8fab-1234567890ab';
const OPERATION = '99999999-8888-4777-8666-555555555555';
const LOCATION = '11111111-2222-4333-8444-555555555555';
const ENDPOINT = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const STAFF = 'abcdef01-2345-4678-89ab-cdef01234567';
const VERIFIER = `${'V'.repeat(41)}-._~`;
const NONCE = `${'N'.repeat(42)}_`;
const STATE = Buffer.alloc(32, 7).toString('base64url');
const CODE = 'dummy-local-authorization-code';
const NOW = '2026-08-16T12:00:00.000Z';
function row() { return { client_id: CLIENT, auth_session_id: SESSION, operation_id: OPERATION,
  location_id: LOCATION, endpoint_id: ENDPOINT, staff_user_id: STAFF, code_verifier: VERIFIER, nonce: NONCE }; }
function genuine(rows = [row()]) {
  const value = new PgResult();
  value.command = 'UPDATE'; value.rowCount = rows.length; value.oid = 0; value.rows = rows;
  return value;
}
function callbackFor(output, attempts) {
  const queryOwner = freeze({ query() { return output; } });
  const repository = createGoogleOAuthTransactionRepository(freeze({ queryOwner }));
  const callbackConsume = createGoogleOAuthCallbackConsume(freeze({
    cryptography: freeze({ sha256Ascii(value) { return crypto.createHash('sha256').update(value, 'ascii').digest(); } }),
    clock: freeze({ now() { return NOW; } }), repository: freeze({ consume: repository.consume }),
  }));
  return freeze({ async completeCallback(input) {
    const consumed = await callbackConsume.consumeCallback(input);
    attempts.push({ consumed });
    throw new Error('TOKEN_ATTEMPT_BOUNDARY');
  } });
}
async function cleanReject(output) {
  await assert.rejects(Promise.resolve().then(() => callbackFor(output, []).completeCallback(freeze({ query: `state=${STATE}&code=${CODE}` }))),
    error => error && error.code === 'GOOGLE_OAUTH_CALLBACK_CONSUME_FAILED'
      && !`${error.stack || ''}`.includes('HOSTILE_COMPLETE_001'));
}

(async () => {
  const attempts = [];
  await assert.rejects(Promise.resolve().then(() => callbackFor(genuine(), attempts).completeCallback(
    freeze({ query: `state=${STATE}&code=${CODE}` }))),
  /TOKEN_ATTEMPT_BOUNDARY/);
  assert.equal(attempts.length, 1, 'genuine pg Result must reach token-attempt boundary after local consume');
  process.stdout.write('ok - genuine pg Result reaches token-attempt boundary\n');

  const frozenRow = freeze(row());
  const frozenResult = freeze({ rows: freeze([frozenRow]) });
  const frozenAttempts = [];
  await assert.rejects(Promise.resolve().then(() => callbackFor(frozenResult, frozenAttempts).completeCallback(
    freeze({ query: `state=${STATE}&code=${CODE}` }))));
  assert.equal(frozenAttempts.length, 1, 'frozen synthetic parity');

  const accessorExtra = { rows: [row()] };
  Object.defineProperty(accessorExtra, 'command', { enumerable: true, get() { throw new Error('HOSTILE_COMPLETE_001'); } });
  const accessorRows = {};
  Object.defineProperty(accessorRows, 'rows', { enumerable: true, get() { throw new Error('HOSTILE_COMPLETE_001'); } });
  for (const hostile of [accessorExtra, accessorRows, { rows: [row()], [Symbol('hostile')]: true }]) await cleanReject(hostile);

  const proxyTrapCounts = { ownKeys: 0, getOwnPropertyDescriptor: 0, isExtensible: 0 };
  const hostileProxies = [
    new Proxy({ rows: [row()] }, { ownKeys() {
      proxyTrapCounts.ownKeys += 1; throw new Error('HOSTILE_COMPLETE_001');
    } }),
    new Proxy({ rows: [row()], command: 'UPDATE' }, { getOwnPropertyDescriptor(target, key) {
      proxyTrapCounts.getOwnPropertyDescriptor += 1;
      if (key === 'command') throw new Error('HOSTILE_COMPLETE_001');
      return Reflect.getOwnPropertyDescriptor(target, key);
    } }),
    new Proxy({ rows: [row()] }, { isExtensible() {
      proxyTrapCounts.isExtensible += 1; throw new Error('HOSTILE_COMPLETE_001');
    } }),
  ];
  for (const hostile of hostileProxies) await cleanReject(hostile);
  assert.deepEqual(proxyTrapCounts, { ownKeys: 0, getOwnPropertyDescriptor: 0, isExtensible: 0 },
    'native proxy rejection must run before all reflective result inspection');

  assert.equal(await createGoogleOAuthTransactionRepository(freeze({ queryOwner: freeze({ query() { return genuine([]); } }) }))
    .consume(freeze({ stateHash: crypto.createHash('sha256').update(STATE, 'ascii').digest('hex'), consumedAt: NOW })), null);
  console.log('PASS EMAIL-GMAIL-COMPLETE-001 genuine pg Result local callback completion and hostile metadata fail closed');
})().catch(error => { process.stderr.write(`${error && error.stack ? error.stack : error}\n`); process.exitCode = 1; });
