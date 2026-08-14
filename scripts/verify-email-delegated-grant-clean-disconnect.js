'use strict';
const assert = require('assert/strict');
const {
  clearDelegatedGrantAfterRevoke,
  clearPreviouslyRevokedGrant,
} = require('./lib/email-delegated-grant-custodian');

const CLIENT = '11111111-1111-4111-8111-111111111111';
const ENDPOINT = '22222222-2222-4222-8222-222222222222';

function fakeClient(expectedStatus) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (String(sql) === 'BEGIN' || String(sql) === 'COMMIT' || String(sql) === 'ROLLBACK') return { rows: [] };
      if (String(sql).includes('DELETE FROM tenant_email_delegated_grants')) {
        assert.match(String(sql), new RegExp(`grant_status='${expectedStatus}'`));
        return { rows: [{ grant_generation: '7' }] };
      }
      if (String(sql).includes("SET binding_status='unverified_offline'")) return { rows: [{ id: ENDPOINT }] };
      throw new Error('unexpected_sql');
    },
  };
}

(async () => {
  const leased = fakeClient('lease_held');
  const out = await clearDelegatedGrantAfterRevoke({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    leaseToken: '33333333-3333-4333-8333-333333333333',
    expectedGeneration: 7,
    operationId: '44444444-4444-4444-8444-444444444444',
  }, { client: leased });
  assert.deepEqual(out, { ok: true, value: { grant_present: false, grant_status: null, grant_generation: 7, reconcile_state: null } });
  assert.match(leased.calls[1].sql, /grant_lease_until > clock_timestamp\(\)/);
  assert.equal(leased.calls.at(-1).sql, 'COMMIT');

  const legacy = fakeClient('revoked');
  const legacyOut = await clearPreviouslyRevokedGrant({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    expectedGeneration: 7,
  }, { client: legacy });
  assert.deepEqual(legacyOut, { ok: true, value: { grant_present: false, grant_status: null, grant_generation: 7, reconcile_state: null } });
  assert.match(legacy.calls[1].sql, /grant_lease_token IS NULL/);
  assert.match(legacy.calls[1].sql, /grant_lease_owner IS NULL/);
  for (const reset of [leased.calls[2].sql, legacy.calls[2].sql]) {
    assert.match(reset, /provider_tenant_id=NULL/);
    assert.match(reset, /provider_principal_oid=NULL/);
    assert.match(reset, /provider_resource_id=NULL/);
    assert.match(reset, /default_automation_mode='off'/);
    assert.doesNotMatch(reset, /provider_mailbox_id|provider_home_account_id|provider_principal_id|automation_enabled/);
    assert.match(reset, /inbound_enabled=false/);
    assert.match(reset, /outbound_enabled=false/);
  }
  assert.equal(legacy.calls.at(-1).sql, 'COMMIT');
  console.log('PASS clean disconnect removes leased and legacy-revoked rows for reinstall');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
