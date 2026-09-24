'use strict';

// Local, real PostgreSQL execution only; no API/network or persisted data.
// Run: node scripts/verify-staff-customer-eligibility-performance.js
// Gate on executed booking scan loops, not machine-dependent wall-clock limits.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { PGlite } = require('@electric-sql/pglite');
const {
  getCustomerListQuery,
  getCustomerListCountsQuery,
} = require('./lib/staff-customer-queries');

const TENANT = '00000000-0000-0000-0000-000000000001';
const OTHER = '00000000-0000-0000-0000-000000000002';
const CUSTOMER = '00000000-0000-0000-0000-000000000003';
const VIEWS = ['all', 'hot_leads', 'unpaid', 'warm_leads', 'checked_in_now']
  .map(key => ({ key, filter: key }));

async function schema(db) {
  await db.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text UNIQUE);
    CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid,
      phone text, full_name text, email text, language text, notes text, location_id text,
      crm_tags jsonb DEFAULT '{}', updated_at timestamptz DEFAULT now());
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid,
      customer_id uuid, phone text, display_name text, email text, language text,
      needs_human boolean DEFAULT false, conversation_stage text, last_message_preview text,
      updated_at timestamptz DEFAULT now(), metadata jsonb DEFAULT '{}');
    CREATE TABLE bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid,
      customer_id uuid, phone text, status text DEFAULT 'confirmed', block_type text DEFAULT 'none',
      metadata jsonb DEFAULT '{}', balance_due_cents int DEFAULT 100,
      check_in date DEFAULT CURRENT_DATE, check_out date DEFAULT CURRENT_DATE + 2);
    CREATE TABLE booking_service_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid,
      client_slug text, service_type text, service_date date, quantity int, status text,
      metadata jsonb DEFAULT '{}', created_at timestamptz DEFAULT now());
    CREATE TABLE staff_handoffs (id uuid, conversation_id uuid, status text);
    INSERT INTO clients VALUES ('${TENANT}', 'wolfhouse-somo'), ('${OTHER}', 'other');
  `);
}

function nodes(plan) {
  return [plan, ...(plan.Plans || []).flatMap(nodes)];
}

async function verifyPerformance(db) {
  const size = 1000;
  await db.exec(`
    INSERT INTO customers (client_id, phone, full_name, crm_tags)
      SELECT '${TENANT}', '+346' || lpad(n::text, 8, '0'), 'Guest ' || n, '{"lead":true}'
      FROM generate_series(1, ${size}) n;
    INSERT INTO bookings (client_id, customer_id, phone)
      SELECT client_id, id, phone FROM customers;
    ANALYZE;
  `);
  const queries = [
    ['list', getCustomerListQuery({ accommodationCrm: true }), ['wolfhouse-somo', 100, 0]],
    ['counts', getCustomerListCountsQuery({ accommodationCrm: true, views: VIEWS }), ['wolfhouse-somo']],
  ];
  const repeated = [];
  for (const [label, sql, params] of queries) {
    const start = performance.now();
    const result = await db.query(`EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) ${sql}`, params);
    const elapsed = Math.round(performance.now() - start);
    const scans = nodes(result.rows[0]['QUERY PLAN'][0].Plan)
      .filter(n => n['Relation Name'] === 'bookings' && /Scan/.test(n['Node Type']));
    const scanLoops = scans.reduce((sum, n) => sum + n['Actual Loops'], 0);
    console.log(`${label}: customers=${size}, elapsed_ms=${elapsed}, booking_scan_loops=${scanLoops}, scans=${JSON.stringify(scans.map(n => ({ alias: n.Alias, loops: n['Actual Loops'] })))}`);
    if (scanLoops > 20) repeated.push(`${label}: ${scanLoops} booking scan loops`);
  }
  assert.deepEqual(repeated, [], 'eligibility must not rescan bookings per customer (constant scan budget: 20)');
  const count = await db.query(queries[1][1], queries[1][2]);
  assert.equal(count.rows[0].all, size);
  assert.equal(count.rows[0].hot_leads, size);
  console.log('PASS 1000-customer list/count eligibility scan budget and totals');
}

async function verifySemantics(db) {
  const block = (phone, extra = {}) => ({ phone, status: 'blocked', ...extra });
  const guest = (phone, extra = {}) => ({ phone, ...extra });
  const linked = { customer: CUSTOMER };
  const cases = [
    { name: 'standalone manual lead' },
    { name: 'standalone email lead', phone: 'emailcust1:abc123' },
    { name: 'block by normalized phone', bookings: [block('34 600-001')], visible: false },
    { name: 'block by ID with null phone', bookings: [block(null, linked)], visible: false },
    { name: 'unrelated block', bookings: [block('+34999999')] },
    { name: 'guest by phone rescues ID block', bookings: [block(null, linked), guest('34 600-001')] },
    { name: 'guest by ID rescues phone block', bookings: [block('+34600001'), guest(null, linked)] },
    { name: 'cancelled guest rescues block', bookings: [block('+34600001'), guest('+34600001', { status: 'cancelled' })] },
    { name: 'conversation by phone rescues ID block', bookings: [block(null, linked)], conversations: [{ phone: '34 600-001' }] },
    { name: 'conversation by ID rescues phone block', bookings: [block('+34600001')], conversations: [{ phone: null, ...linked }] },
    { name: 'sentinel staff remains hidden', phone: 'staff-block', conversations: [{ phone: 'staff-block', ...linked }], visible: false },
    { name: 'sentinel owner remains hidden', phone: 'owner-schedule', bookings: [guest('+34999999', linked)], visible: false },
    { name: 'opaque exact block', phone: 'emailcust1:abc123', bookings: [block('emailcust1:abc123')], visible: false },
    { name: 'opaque exact conversation rescues block', phone: 'emailv1:abc123', bookings: [block('emailv1:abc123')], conversations: [{ phone: 'emailv1:abc123' }] },
    { name: 'opaque exact guest rescues block', phone: 'email:abc123', bookings: [block('email:abc123'), guest('email:abc123')] },
    { name: 'opaque same digits cannot hide lead', phone: 'emailcust1:abc123', bookings: [block('emailcust1:def123')] },
    { name: 'opaque same digits cannot rescue block', phone: 'emailcust1:abc123', bookings: [block('emailcust1:abc123'), guest('emailcust1:def123')], visible: false },
    { name: 'opaque cannot match real phone', phone: '+1123', bookings: [block('emailcust1:abc123')] },
    { name: 'case-insensitive opaque prefix detection', phone: 'EMAILV1:abc123', bookings: [block('+1123')] },
    { name: 'opaque identity remains case-sensitive', phone: 'EMAIL:abc123', bookings: [block('email:abc123')] },
    { name: 'digitless keys cannot collide', phone: 'email:alice', bookings: [block('email:bob'), block('staff-block'), block('')] },
    { name: 'nonopaque digitless exact match', phone: 'legacy-lead', bookings: [block('legacy-lead')], visible: false },
    { name: 'nonopaque digitless unequal keys', phone: 'legacy-lead', bookings: [block('other-lead'), block(null)] },
    { name: 'other tenant block cannot hide lead by phone or ID', bookings: [block('+34600001', { tenant: OTHER, ...linked })] },
    { name: 'other tenant guest cannot rescue block', bookings: [block('+34600001'), guest('+34600001', { tenant: OTHER, ...linked })], visible: false },
    { name: 'other tenant conversation cannot rescue block', bookings: [block('+34600001')], conversations: [{ phone: '+34600001', tenant: OTHER, ...linked }], visible: false },
    { name: 'block in other location still hides block-only identity', bookings: [block('+34600001', { location: 'sunset-loredo' })], visible: false },
    { name: 'guest in other location rescues mixed identity', bookings: [block('+34600001'), guest('+34600001', { location: 'sunset-loredo' })] },
    { name: 'block alone cannot grant second-location membership', location: 'sunset-loredo', bookings: [block('+34600001')], conversations: [{ phone: '+34600001' }], scopedVisible: false },
    { name: 'guest grants second-location membership', location: 'sunset-loredo', bookings: [guest('+34600001')] },
    { name: 'empty phone remains hidden', phone: '', visible: false },
    { name: 'null phone remains hidden', phone: null, visible: false },
  ];
  for (const scenario of cases) {
    await db.exec('TRUNCATE customers, bookings, conversations, booking_service_records');
    const phone = Object.hasOwn(scenario, 'phone') ? scenario.phone : '+34600001';
    await db.query(`INSERT INTO customers (id,client_id,phone,full_name,location_id,crm_tags)
      VALUES ($1,$2,$3,$4,$5,'{"vip":true}')`,
    [CUSTOMER, TENANT, phone, scenario.name, scenario.location || 'sunset-somo']);
    for (const b of scenario.bookings || []) {
      await db.query(`INSERT INTO bookings (client_id,customer_id,phone,status,metadata)
        VALUES ($1,$2,$3,$4,$5)`, [b.tenant || TENANT, b.customer || null, b.phone,
        b.status || 'confirmed', JSON.stringify({ location_id: b.location || 'sunset-somo' })]);
    }
    for (const c of scenario.conversations || []) {
      await db.query('INSERT INTO conversations (client_id,customer_id,phone) VALUES ($1,$2,$3)',
        [c.tenant || TENANT, c.customer || null, c.phone]);
    }
    for (const locationScoped of [false, true]) {
      const opts = { locationScoped, accommodationCrm: true };
      const params = ['wolfhouse-somo', ...(locationScoped ? ['sunset-somo'] : [])];
      const expected = (locationScoped ? scenario.scopedVisible ?? scenario.visible : scenario.visible) === false ? 0 : 1;
      const label = `${scenario.name} (${locationScoped ? 'location' : 'tenant'})`;
      const counts = (await db.query(getCustomerListCountsQuery({ ...opts, views: VIEWS }), params)).rows[0];
      assert.equal(counts.all, expected, `${label}: count eligibility`);
      for (const { filter } of VIEWS) {
        const rows = (await db.query(getCustomerListQuery({ ...opts, filter }), [...params, 100, 0])).rows;
        assert.equal(rows.length, counts[filter], `${label}: ${filter} list/count parity`);
        if (filter === 'all' && expected) {
          assert.equal(rows[0].phone, phone, `${label}: retained identity`);
          assert.equal(rows[0].crm_tags.vip, true, `${label}: CRM tags preserved`);
        }
      }
    }
  }
  console.log(`PASS ${cases.length} identity/tenant/location scenarios, scoped and unscoped list/count/filter parity`);
}

async function main() {
  const db = new PGlite();
  try {
    await schema(db);
    if (!process.argv.includes('--semantics-only')) await verifyPerformance(db);
    await verifySemantics(db);
  } finally {
    await db.close();
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
