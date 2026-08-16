'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { types: utilTypes } = require('node:util');
const Result = require(require.resolve('pg/lib/result', {
  paths: [path.resolve(__dirname, '../../WH-orchestrator')],
}));
const { createGoogleConsumedEndpointAuthorityResolver } = require('./lib/email-google-consumed-endpoint-authority-resolver');

const freeze = Object.freeze;
const CLIENT = 'a1111111-bbbb-4ccc-8ddd-eeeeeeeeeee1';
const LOCATION = 'c3333333-bbbb-4ccc-8ddd-eeeeeeeeeee3';
const ENDPOINT = 'e5555555-bbbb-4ccc-8ddd-eeeeeeeeeee5';
const SECRET_REF = 'kv:email/google/client-a';
const FAILURE = 'GOOGLE_CONSUMED_ENDPOINT_AUTHORITY_FAILED';
const input = freeze({ tenantSlug: 'sunset', clientId: CLIENT, locationKey: 'sunset-somo',
  locationId: LOCATION, endpointId: ENDPOINT });
const row = () => freeze({ id: ENDPOINT, client_id: CLIENT, location_id: LOCATION,
  channel: 'email', provider: 'gmail_api', secret_ref: SECRET_REF, active: true });
function result(rows = [row()]) {
  const value = new Result();
  value.command = 'SELECT';
  value.rowCount = rows.length;
  value.rows = freeze(rows);
  return value;
}
function owner(value) {
  const db = freeze({ query() { return Promise.resolve(value); } });
  return createGoogleConsumedEndpointAuthorityResolver(freeze({ db }));
}
async function rejects(value) {
  await assert.rejects(() => owner(value).resolveConsumedEndpointAuthority(input),
    (error) => error && error.code === FAILURE && error.stack === undefined);
}
async function main() {
  const genuine = result();
  assert.equal(genuine.constructor, Result);
  assert.equal(utilTypes.isProxy(genuine), false);
  const ack = await owner(genuine).resolveConsumedEndpointAuthority(input);
  assert.deepEqual(ack, freeze({ tenantSlug: 'sunset', clientId: CLIENT,
    locationKey: 'sunset-somo', locationId: LOCATION, endpointId: ENDPOINT,
    secretRef: SECRET_REF }));
  assert.equal(Object.isFrozen(ack), true);

  await rejects(result([]));
  const missing = result(); delete missing.rows; await rejects(missing);
  const symbolic = result(); symbolic[Symbol('rows')] = symbolic.rows; await rejects(symbolic);
  const accessor = result(); Object.defineProperty(accessor, 'command', {
    get() { throw new Error('metadata accessor read'); }, enumerable: true,
  }); await rejects(accessor);
  const rowsAccessor = result(); const rows = rowsAccessor.rows; delete rowsAccessor.rows;
  Object.defineProperty(rowsAccessor, 'rows', { get() { throw new Error('rows read'); }, enumerable: true });
  await rejects(rowsAccessor); assert.equal(rows.length, 1);

  let traps = 0;
  const hostile = new Proxy(result(), {
    ownKeys() { traps += 1; throw new Error('trap'); },
    getOwnPropertyDescriptor() { traps += 1; throw new Error('trap'); },
    getPrototypeOf() { traps += 1; throw new Error('trap'); },
  });
  await rejects(hostile);
  const target = result();
  const duplicate = new Proxy(target, { ownKeys() { traps += 1; return ['rows', 'rows']; } });
  await rejects(duplicate);
  const revocable = Proxy.revocable(result(), { ownKeys() { traps += 1; throw new Error('trap'); } });
  revocable.revoke(); await rejects(revocable.proxy);
  assert.equal(traps, 0);

  console.log('EMAIL-GMAIL-AUTHORITY-001 verifier: PASS');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
