'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, calculateWolfhouseQuote } = require('../wolfhouse-quote-calculator');
const api = require('./index');
const v3 = require('./v3-operations');
const { FORBIDDEN_TRANSPORTS, createLunaV3StaffAuthorities } = require('./v3-staff-authorities');

function quote(guestPackages) {
  const config = loadConfig();
  config.seasons = [{ code:'summer', active:true, bookable:true, priority:1,
    ranges:[{ start_month:1,start_day:1,end_month:12,end_day:31 }] }];
  return calculateWolfhouseQuote({ client_slug:'wolfhouse-somo', check_in:'2027-07-01', check_out:'2027-07-08',
    guest_count:2, room_type:'shared', guest_packages:guestPackages, payment_choice:'deposit',
    uses_per_guest_deposits:true }, config);
}

const ordered = quote([{guest_number:1,package_code:'uluwatu'},{guest_number:2,package_code:'package_none'}]);
const reversed = quote([{guest_number:2,package_code:'package_none'},{guest_number:1,package_code:'uluwatu'}]);
assert.equal(ordered.success, true);
assert.equal(reversed.success, true);
assert.equal(reversed.total_cents, ordered.total_cents);
assert.deepEqual(reversed.per_guest_deposits.map(x=>x.guest_number).sort(), [1,2]);
for (const malformed of [
  [{guest_number:1,package_code:'uluwatu'},{guest_number:1,package_code:'package_none'}],
  [{guest_number:0,package_code:'uluwatu'},{guest_number:2,package_code:'package_none'}],
  [{guest_number:3,package_code:'uluwatu'},{guest_number:2,package_code:'package_none'}],
  [{guest_number:1.5,package_code:'uluwatu'},{guest_number:2,package_code:'package_none'}],
]) assert.equal(quote(malformed).success, false, JSON.stringify(malformed));
console.log('PASS R17-6 calculator rejects malformed ordinals and accepts reversed valid order');

assert.equal(Object.isFrozen(api), true);
assert.throws(() => { api.sendPaymentLink = async () => { throw new Error('broken sendPaymentLink selected'); }; }, TypeError);
const original = v3.sendPaymentLink;
// Build a fresh registry while the selected dependency is poisoned.  Mutating
// v3 after `index` was loaded only changes an object the registry no longer
// consults and was the old test's false positive.
const indexPath = require.resolve('./index');
const cachedIndex = require.cache[indexPath];
v3.sendPaymentLink = async () => { throw new Error('broken sendPaymentLink selected'); };
delete require.cache[indexPath];
const poisonedApi = require('./index');
v3.sendPaymentLink = original;
delete require.cache[indexPath];
require.cache[indexPath] = cachedIndex;
const selectedNegative = poisonedApi.createOperations(async fn => fn({ query: async () => {
  throw new Error('selected dispatch unexpectedly reached postgres');
} }));
let savedReceipt = null;
const registry = api.createOperations(async fn => fn({ query: async (sql, params=[]) => {
  if (/FROM luna_v3_sessions s JOIN clients c/.test(sql)) return { rows:[{
    id:'session', client_id:'client', slug:'wolfhouse-somo', selected_booking_id:null, write_admitted:true,
  }] };
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows:[] };
  if (/INSERT INTO luna_v3_operations/.test(sql)) return { rows:[{
    id:'operation', request_fingerprint:params[4], receipt:null,
  }] };
  if (/SELECT request_fingerprint,receipt FROM luna_v3_operations/.test(sql)) return { rows:[{
    request_fingerprint:require('node:crypto').createHash('sha256').update(JSON.stringify({
      booking_id:'booking', guest_id:'guest', operation_key:'negative', payment_choice:'deposit',
    })).digest('hex'), receipt:savedReceipt,
  }] };
  if (/UPDATE luna_v3_operations SET receipt=/.test(sql)) { savedReceipt=JSON.parse(params[1]); return { rows:[] }; }
  throw new Error(`unexpected durable-refusal query: ${sql}`);
} }));
(async () => {
  await assert.rejects(
    () => selectedNegative.send_payment_link(
      { booking_id:'booking', guest_id:'guest', payment_choice:'deposit', operation_key:'negative' },
      { tenantId:'wolfhouse-somo', authenticated:true, sessionId:'luna-v3:test', principalId:'principal', writeAllowed:true },
    ),
    /broken sendPaymentLink selected/,
  );
  const productionBoundary = createLunaV3StaffAuthorities({});
  for (const transport of FORBIDDEN_TRANSPORTS) {
    await assert.rejects(
      () => productionBoundary[transport]({ deliberatelyInvokeBoundary:true }),
      (error) => error.code === 'luna_v3_transport_forbidden' && error.transport === transport,
      `${transport} production boundary did not fail closed`,
    );
  }
  const staffComposition = fs.readFileSync(path.join(__dirname,'../../staff-query-api.js'),'utf8');
  assert.match(staffComposition, /createLunaV3StaffOperations\(withPgClient, LUNA_V3_STAFF_AUTHORITIES\)/);
  const result = await registry.send_payment_link({ booking_id:'booking', guest_id:'guest', payment_choice:'deposit', operation_key:'negative' },
    { tenantId:'wolfhouse-somo', authenticated:true, sessionId:'luna-v3:test', principalId:'principal', writeAllowed:true });
    assert.equal(result.code, 'booking_not_selected');
    const operations = fs.readFileSync(path.join(__dirname,'v3-operations.js'),'utf8');
    assert.match(operations, /UPDATE booking_transfers SET status='declined'/);
    assert.match(operations, /Number\(g\.guest_number\)!==i\+1/);
    const migration = fs.readFileSync(path.join(__dirname,'../../../database/migrations/120_luna_v3_constraint_ownership_and_transfer_decline.sql'),'utf8');
    assert.match(migration, /COMMENT ON CONSTRAINT luna_v3_sessions_guest_phone_bounded/);
    assert.doesNotMatch(migration, /DROP CONSTRAINT IF EXISTS luna_v3_sessions_guest_phone_bounded/);
    assert.match(migration, /phone constraint ownership is foreign\/newer/);
    assert.match(migration, /luna_v3_transfer_requests_authoritative_required_120/);
    console.log('PASS R17-7/8/12 identity check, authoritative decline, truthful selected-dispatch negative, connected production transport boundaries fail closed, constraint ownership guards');
})().catch((error) => { throw error; });
