'use strict';
const assert = require('assert');
const { MAX_CUSTOMER_PROFILE_DELETE_COUNT, parseCustomerDeleteBody, deleteCustomerProfiles } = require('./lib/staff-customer-profile-delete');

(async () => {
  assert.strictEqual(MAX_CUSTOMER_PROFILE_DELETE_COUNT, 100);
  assert.deepStrictEqual(parseCustomerDeleteBody({ phones: [' +351 912-345-678 ', '+351912345678'] }), { ok: true, phones: ['+351912345678'] });
  assert.strictEqual(parseCustomerDeleteBody({ phones: [] }).ok, false);
  assert.strictEqual(parseCustomerDeleteBody({ phones: Array.from({length: 101}, (_, i) => `+3519${String(i).padStart(8, '0')}`) }).ok, false);

  const calls = [];
  const pg = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (sql.includes('DELETE FROM customers')) return { rows: [{ phone: '+351912345678' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }};
  const result = await deleteCustomerProfiles(pg, 'sunset', ['+351912345678']);
  assert.strictEqual(result.deleted_count, 1);
  assert(calls[0].sql === 'BEGIN' && calls.at(-1).sql === 'COMMIT');
  const del = calls.find(c => c.sql.includes('DELETE FROM customers'));
  assert(del.sql.includes('USING clients') && del.sql.includes('c.slug = $1') && del.sql.includes('phone = ANY($2::text[])'));
  assert(!calls.some(c => /DELETE FROM (bookings|conversations|messages|booking_service_records|payments)/i.test(c.sql)));
  console.log('verify:sunset-customer-delete — ALL CHECKS PASSED');
})().catch(err => { console.error(err); process.exit(1); });
