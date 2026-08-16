'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const Result = require(require.resolve('pg/lib/result', {
  paths: [path.resolve(__dirname, '../../WH-orchestrator')],
}));
const { createGoogleConsumedEndpointAuthorityResolver } = require('./lib/email-google-consumed-endpoint-authority-resolver');

const freeze = Object.freeze;
const CLIENT = 'a1111111-bbbb-4ccc-8ddd-eeeeeeeeeee1';
const LOCATION = 'c3333333-bbbb-4ccc-8ddd-eeeeeeeeeee3';
const ENDPOINT = 'e5555555-bbbb-4ccc-8ddd-eeeeeeeeeee5';
const REF = 'kv:email/google/client-a';
const FAILURE = 'GOOGLE_CONSUMED_ENDPOINT_AUTHORITY_FAILED';
const input = freeze({ tenantSlug: 'sunset', clientId: CLIENT, locationKey: 'sunset-somo',
  locationId: LOCATION, endpointId: ENDPOINT });
function mutableRow() { return { id: ENDPOINT, client_id: CLIENT, location_id: LOCATION,
  channel: 'email', provider: 'gmail_api', secret_ref: REF, active: true }; }
function genuine(rows = [mutableRow()]) {
  const value = new Result();
  value.command = 'SELECT'; value.rowCount = rows.length; value.oid = null; value.rows = rows;
  return value;
}
function resolver(result) {
  return createGoogleConsumedEndpointAuthorityResolver(freeze({
    db: freeze({ query() { return Promise.resolve(result); } }),
  }));
}
async function rejects(result) {
  await assert.rejects(() => resolver(result).resolveConsumedEndpointAuthority(input),
    error => error && error.code === FAILURE && error.stack === undefined);
}
function trappingProxy(target, counts) {
  return new Proxy(target, {
    ownKeys() { counts.ownKeys += 1; throw new Error('AUTHORITY-002 trap'); },
    getOwnPropertyDescriptor() { counts.getOwnPropertyDescriptor += 1; throw new Error('AUTHORITY-002 trap'); },
    getPrototypeOf() { counts.getPrototypeOf += 1; throw new Error('AUTHORITY-002 trap'); },
    isExtensible() { counts.isExtensible += 1; throw new Error('AUTHORITY-002 trap'); },
  });
}
(async () => {
  const live = genuine();
  assert.equal(live.constructor, Result);
  assert.equal(Object.isFrozen(live), false); assert.equal(Object.isFrozen(live.rows), false);
  assert.equal(Object.isFrozen(live.rows[0]), false);
  const ack = await resolver(live).resolveConsumedEndpointAuthority(input);
  assert.deepEqual(ack, freeze({ tenantSlug: 'sunset', clientId: CLIENT, locationKey: 'sunset-somo',
    locationId: LOCATION, endpointId: ENDPOINT, secretRef: REF }));

  await rejects(genuine([])); await rejects(genuine([mutableRow(), mutableRow()]));
  const symbolRows = genuine(); symbolRows.rows[Symbol('x')] = true; await rejects(symbolRows);
  const extraRows = genuine(); extraRows.rows.extra = true; await rejects(extraRows);
  const sparse = genuine([]); sparse.rows.length = 1; await rejects(sparse);
  const accessorRows = genuine([]); Object.defineProperty(accessorRows.rows, '0', {
    enumerable: true, configurable: true, get() { throw new Error('AUTHORITY-002 accessor'); },
  }); accessorRows.rows.length = 1; await rejects(accessorRows);
  const driftRows = genuine(); Object.defineProperty(driftRows.rows, '0', {
    value: mutableRow(), enumerable: true, writable: false, configurable: true,
  }); await rejects(driftRows);
  const rowSymbol = genuine(); rowSymbol.rows[0][Symbol('x')] = true; await rejects(rowSymbol);
  const rowExtra = genuine(); rowExtra.rows[0].extra = true; await rejects(rowExtra);
  const rowReordered = genuine(); rowReordered.rows[0] = { active: true, secret_ref: REF,
    provider: 'gmail_api', channel: 'email', location_id: LOCATION, client_id: CLIENT, id: ENDPOINT };
  await rejects(rowReordered);
  const rowAccessor = genuine(); Object.defineProperty(rowAccessor.rows[0], 'secret_ref', {
    enumerable: true, configurable: true, get() { throw new Error('AUTHORITY-002 accessor'); },
  }); await rejects(rowAccessor);
  const mixedRow = genuine(); freeze(mixedRow.rows[0]); await rejects(mixedRow);
  const mixedRows = genuine(); freeze(mixedRows.rows); await rejects(mixedRows);

  const counts = { ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0, isExtensible: 0 };
  await rejects(trappingProxy(genuine(), counts));
  const proxyRows = genuine(); proxyRows.rows = trappingProxy(proxyRows.rows, counts); await rejects(proxyRows);
  const proxyRow = genuine(); proxyRow.rows[0] = trappingProxy(proxyRow.rows[0], counts); await rejects(proxyRow);
  assert.deepEqual(counts, { ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0, isExtensible: 0 });

  console.log('PASS EMAIL-GMAIL-AUTHORITY-002 genuine mutable pg Result and strict envelope/rows/row parity');
})().catch(error => { console.error(error); process.exitCode = 1; });
