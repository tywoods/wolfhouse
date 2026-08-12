'use strict';

const assert = require('assert/strict');
const {
  ERROR_CODE,
  createSunsetGoogleEndpointPrepare,
} = require('./lib/email-sunset-google-endpoint-prepare');

const input = Object.freeze({
  clientId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  locationId: 'sunset-somo',
  publicAddress: 'desk@sunset.example',
  actorStaffUserId: 'abcdef01-2345-4678-89ab-cdef01234567',
});
const endpointId = '11111111-2222-4333-8444-555555555555';
function result(sql) {
  if (/FROM clients/.test(sql)) return { rows: [{ client_id: input.clientId }] };
  if (/FROM tenant_locations/.test(sql)) return { rows: [{ location_id: input.locationId }] };
  if (/INSERT INTO/.test(sql)) return { rows: [{ id: endpointId }] };
  return { rows: [] };
}
function rejected(error) { return error && error.code === ERROR_CODE; }

(async () => {
  let selected = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'query', {
    enumerable: true,
    get() {
      selected += 1;
      return async (sql) => result(sql);
    },
  });
  assert.throws(
    () => createSunsetGoogleEndpointPrepare(Object.freeze({ client: accessor })),
    rejected,
    'query accessors must be rejected without selection',
  );
  assert.equal(selected, 0);

  const callsA = [];
  const callsB = [];
  const client = {
    async query(sql) { callsA.push(sql); return result(sql); },
  };
  const owner = createSunsetGoogleEndpointPrepare(Object.freeze({ client }));
  client.query = async (sql) => { callsB.push(sql); return result(sql); };
  const ack = await owner.prepareDisabledDelegatedEndpoint(input);
  assert.deepEqual(ack, { endpointId });
  assert.equal(callsA.length, 9, 'all transaction statements use factory-pinned query');
  assert.equal(callsB.length, 0, 'post-factory mutation cannot switch connections');
  console.log('PASS query is selected and bound exactly once');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
