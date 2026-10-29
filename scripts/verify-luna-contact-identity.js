'use strict';
const assert = require('assert');
const identity = require('./lib/luna-contact-identity');

(async () => {
  const calls = [];
  const pg = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: sql.includes('SELECT') ? [{ full_name: '  Ana   García ' }] : [{ full_name: 'Ana García' }] };
  }};
  assert.deepStrictEqual(await identity.readContactIdentity(pg, { clientSlug: 'wolfhouse-somo', phone: '+34600000001' }),
    { found: true, full_name: 'Ana García' });
  assert.deepStrictEqual(await identity.readContactIdentity(pg, { clientSlug: 'wolfhouse-somo', phone: '' }),
    { found: false, full_name: null });
  assert.deepStrictEqual(await identity.saveContactIdentity(pg, { clientSlug: 'wolfhouse-somo', phone: '+34600000001', fullName: ' Ana García ' }),
    { saved: true, full_name: 'Ana García' });
  assert.deepStrictEqual(calls[1].values, ['wolfhouse-somo', '+34600000001', 'Ana García']);
  assert.strictEqual(calls.some(({ values }) => values.includes(undefined)), false);
  assert.deepStrictEqual(await identity.handleContactIdentity(pg, {
    clientSlug: 'wolfhouse-somo', phone: '+34600111001', body: {},
  }), { status: 200, body: { success: true, found: true, full_name: 'Ana García' } });
  assert.deepStrictEqual(await identity.handleContactIdentity(pg, {
    clientSlug: 'wolfhouse-somo', phone: '+34600111001', body: { client_slug: 'wolfhouse-somo' },
  }), { status: 200, body: { success: true, found: true, full_name: 'Ana García' } });
  assert.deepStrictEqual(await identity.handleContactIdentity(pg, {
    clientSlug: 'wolfhouse-somo', phone: '+34600111001',
    body: { client_slug: 'wolfhouse-somo', location_id: 'wolfhouse-somo' },
  }), { status: 200, body: { success: true, found: true, full_name: 'Ana García' } });
  assert.deepStrictEqual(await identity.handleContactIdentity(pg, {
    clientSlug: 'wolfhouse-somo', phone: '+34600111001', body: { phone: 'attacker' },
  }), { status: 400, body: { success: false, error: 'invalid_contact_identity_input' } });
  console.log('PASS luna contact identity: trusted phone only, read/upsert customer full_name');
})().catch((error) => { console.error(error); process.exit(1); });
