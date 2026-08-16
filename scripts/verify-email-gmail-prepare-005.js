'use strict';
const assert = require('node:assert/strict');
const PgResult = require('pg/lib/result');
const { createGoogleOAuthTransactionRepository } = require('./lib/email-google-oauth-transaction-repository');

const OPERATION = '99999999-8888-4777-8666-555555555555';
const EXPIRES = '2026-08-16T10:43:21.284Z';
const frozen = Object.freeze;
const input = frozen({
  clientId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  locationId: '11111111-2222-4333-8444-555555555555',
  endpointId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  staffUserId: 'abcdef01-2345-4678-89ab-cdef01234567',
  authSessionId: '12345678-90ab-4cde-8fab-1234567890ab',
  operationId: OPERATION,
  stateHash: '0123456789abcdef'.repeat(4),
  codeVerifier: `${'V'.repeat(41)}-._~`,
  nonce: `${'N'.repeat(42)}_`,
  issuedAt: '2026-08-16T10:33:21.284Z',
  expiresAt: EXPIRES,
});
function row() { return { operation_id: OPERATION, expires_at: EXPIRES }; }
function repository(output) {
  return createGoogleOAuthTransactionRepository(frozen({
    queryOwner: frozen({ query() { return output; } }),
  }));
}
async function accept(output, label = 'accepted result') {
  try {
    assert.deepEqual(await repository(output).create(input),
      { operationId: OPERATION, expiresAt: EXPIRES });
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}
async function reject(output) {
  await assert.rejects(Promise.resolve().then(() => repository(output).create(input)), error => {
    assert.equal(error.name, 'GoogleOAuthTransactionRepositoryError');
    assert.equal(error.code, 'GOOGLE_OAUTH_TRANSACTION_REPOSITORY_FAILED');
    return true;
  });
}

(async () => {
  const genuine = new PgResult();
  genuine.command = 'INSERT'; genuine.rowCount = 1; genuine.oid = 0;
  genuine.rows = [row()];
  await accept(genuine, 'genuine');

  await accept(frozen({ rows: frozen([frozen(row())]) }), 'frozen synthetic');
  await accept({ rows: [row()], command: 'INSERT', rowCount: 1, oid: 0,
    fields: [], _parsers: undefined, _types: undefined, RowCtor: null,
    rowAsArray: false, _prebuiltEmptyResultObject: null, harmless: 'ignored data' }, 'root data extras');

  const accessorExtra = { rows: [row()] };
  Object.defineProperty(accessorExtra, 'command', { enumerable: true, get() { throw new Error('must not run'); } });
  const accessorRows = {};
  Object.defineProperty(accessorRows, 'rows', { enumerable: true, get() { throw new Error('must not run'); } });
  const symbol = { rows: [row()], [Symbol('hostile')]: true };
  await reject(accessorExtra);
  await reject(accessorRows);
  await reject(symbol);
  await reject({ command: 'INSERT' });
  await reject(new Proxy({ rows: [row()] }, { ownKeys() { throw new Error('hostile ownKeys'); } }));
  await reject(new Proxy({ rows: [row()] }, {
    ownKeys() { return ['rows', 'rows']; },
  }));
  await reject(new Proxy({ rows: [row()], command: 'INSERT' }, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'command') throw new Error('hostile descriptor');
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  }));
  await reject(new Proxy({ rows: [row()] }, {
    isExtensible() { throw new Error('hostile extensibility trap'); },
  }));

  let ownKeysReads = 0; const descriptorReads = new Map();
  const target = { command: 'INSERT', rows: [row()], rowCount: 1 };
  const once = new Proxy(target, {
    ownKeys(inner) { ownKeysReads += 1; return Reflect.ownKeys(inner); },
    getOwnPropertyDescriptor(inner, key) {
      descriptorReads.set(key, (descriptorReads.get(key) || 0) + 1);
      return Reflect.getOwnPropertyDescriptor(inner, key);
    },
    get() { throw new Error('broad property access forbidden'); },
  });
  await reject(once);
  assert.equal(ownKeysReads, 0);
  assert.deepEqual([...descriptorReads], []);

  console.log('PASS EMAIL-GMAIL-PREPARE-005 genuine pg Result acknowledgement and hostile root metadata fail closed');
})().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
