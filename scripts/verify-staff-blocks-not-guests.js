'use strict';

// Real read queries against isolated PostgreSQL (PGlite). No network or staging writes.
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { listSunsetBookingsAdmin, exportSunsetBookingsAdminCsv } = require('./lib/sunset-bookings-admin-data');

async function schema(db) {
  await db.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text);
    CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid,
      phone text, full_name text, email text, language text, notes text, location_id text,
      crm_tags jsonb DEFAULT '{}', updated_at timestamptz DEFAULT now());
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid,
      customer_id uuid, phone text, display_name text, email text, language text, needs_human boolean DEFAULT false,
      conversation_stage text, last_message_preview text, updated_at timestamptz DEFAULT now(), metadata jsonb DEFAULT '{}');
    CREATE TABLE staff_handoffs (id uuid, conversation_id uuid, status text);
    CREATE TABLE bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid,
      customer_id uuid, booking_code text, guest_name text, phone text, email text,
      status text DEFAULT 'confirmed', payment_status text DEFAULT 'not_requested',
      booking_source text DEFAULT 'manual_staff', operator_name text, block_type text DEFAULT 'none',
      check_in date DEFAULT CURRENT_DATE, check_out date DEFAULT CURRENT_DATE + 2,
      package_code text, guest_count int DEFAULT 1, total_amount_cents int DEFAULT 10000,
      amount_paid_cents int DEFAULT 0, balance_due_cents int DEFAULT 10000,
      metadata jsonb DEFAULT '{}', hidden boolean DEFAULT false, created_at timestamptz DEFAULT now());
    CREATE TABLE booking_service_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid,
      client_slug text, booking_code text, guest_name text, service_type text DEFAULT 'accommodation',
      service_date date DEFAULT CURRENT_DATE, quantity int DEFAULT 1,
      amount_due_cents int DEFAULT 0, amount_paid_cents int DEFAULT 0, status text DEFAULT 'confirmed',
      payment_status text DEFAULT 'not_requested', notes text, source text,
      service_time_local text, service_time_local_end text, metadata jsonb DEFAULT '{}', created_at timestamptz DEFAULT now());
    CREATE TYPE payment_record_status AS ENUM ('paid', 'checkout_created');
    CREATE TABLE payments (id uuid, booking_id uuid, client_id uuid, status payment_record_status,
      amount_paid_cents int, paid_at timestamptz, finance_exclusion text, metadata jsonb DEFAULT '{}');
    CREATE TABLE booking_refund_records (id uuid, booking_id uuid, client_id uuid, client_slug text, amount_cents int,
      effective_date date, reason text, staff_user_id uuid, staff_email text, staff_role text,
      idempotency_key text, source text, created_at timestamptz, location_id text);
    CREATE TABLE waiver_form_requests (id uuid, booking_id uuid, client_id uuid, client_slug text,
      status text, request_mode text, public_id text, target_count int, created_at timestamptz);
    CREATE TABLE waiver_form_submissions (id uuid, request_id uuid, status text);
  `);
}

async function seed(db, slug, n) {
  const clientId = `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  await db.query('INSERT INTO clients VALUES ($1, $2)', [clientId, slug]);
  const rows = [
    ['guest-unpaid', 'confirmed', 'none', '+340001', {}, 10000, 0],
    ['guest-partial', 'confirmed', 'none', '+340002', {}, 10000, 4000],
    ['guest-paid', 'confirmed', 'none', '+340003', {}, 10000, 10000],
    ['guest-private-room', 'confirmed', 'none', '+340004', { private_room: true }, 10000, 0],
    ['guest-operator', 'confirmed', 'none', '+340005', {}, 10000, 0],
    ['guest-named-blocked', 'confirmed', 'none', '+340006', {}, 10000, 0],
    ['block-staff', 'blocked', 'none', 'staff-block', { staff_calendar_block: true, staff_source: 'staff_block' }, 0, 0],
    ['block-cancelled', 'cancelled', 'none', 'staff-block', { staff_calendar_block: true }, 0, 0],
    ['block-operator', 'confirmed', 'whole_room', '+340007', {}, 0, 0],
    ['block-external', 'blocked', 'none', 'owner-schedule', { external_calendar: { connection_id: 'fixture' } }, 0, 0],
    ['block-companion', 'blocked', 'none', 'staff-block', { staff_calendar_block: true, block_type: 'private_room_companion' }, 0, 0],
    ['block-stale-status', 'confirmed', 'none', '+340008', { staff_calendar_block: true }, 5000, 0],
    ['block-staff-source', 'cancelled', 'none', '+340009', { staff_source: 'staff_block' }, 0, 0],
  ];
  for (const [code, status, blockType, phone, meta, total, paid] of rows) {
    await db.query(`INSERT INTO bookings (client_id,booking_code,guest_name,phone,status,block_type,
      metadata,total_amount_cents,amount_paid_cents,balance_due_cents,booking_source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8::int-$9::int,$10)`,
    [clientId, code, code === 'guest-named-blocked' ? 'Blocked' : code, phone, status, blockType,
      JSON.stringify({ ...meta, location_id: 'sunset-somo' }), total, paid,
      code.includes('operator') ? 'operator' : 'manual_staff']);
  }
  return { clientSlug: slug, locationId: slug === 'sunset' ? 'sunset-somo' : null, lodging: slug !== 'sunset' };
}

async function verifyBookings(db, scope) {
  const result = await listSunsetBookingsAdmin(db, scope, { limit: 200 });
  assert.deepEqual(result.rows.map(r => r.booking_code).sort(), [
    'guest-unpaid', 'guest-partial', 'guest-paid', 'guest-private-room', 'guest-operator', 'guest-named-blocked',
  ].sort(), `${scope.clientSlug}: Bookings must exclude inventory blocks, not guest names/source/private rooms`);
  assert.equal(result.summary.unpaid_count, 4);
  const unpaid = await listSunsetBookingsAdmin(db, scope, { status: 'unpaid', limit: 1 });
  assert.equal(unpaid.total_count, 4, 'count excludes blocks before paging');
  assert.equal(unpaid.summary.unpaid_count, 4);
  assert.equal(unpaid.rows.length, 1);
  assert.ok(unpaid.rows[0].booking_code.startsWith('guest-'));
  const csv = await exportSunsetBookingsAdminCsv(db, scope, { status: 'unpaid' });
  assert.equal(csv.row_count, 4);
  assert.ok(!csv.csv.includes('block-staff'));
  // Reads must not remove or mutate any of the rows used by Schedule.
  const stored = await db.query('SELECT COUNT(*)::int AS n FROM bookings b JOIN clients c ON c.id=b.client_id WHERE c.slug=$1', [scope.clientSlug]);
  assert.equal(stored.rows[0].n, 13);
  console.log(`PASS ${scope.clientSlug}: Bookings + unpaid rows/counts/paging + CSV; persisted blocks untouched`);
}

async function verifyLodgingFallback(db, scope) {
  if (!scope.lodging) return;
  // Ordinary entrypoint: a legacy hidden value breaks the primary read's boolean
  // cast, so the actual catch must fall back without restoring inventory rows.
  await db.query(`UPDATE bookings b SET metadata = metadata || '{"hidden":"legacy"}'
    FROM clients c WHERE c.id=b.client_id AND c.slug=$1 AND b.booking_code='guest-unpaid'`, [scope.clientSlug]);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const all = await listSunsetBookingsAdmin(db, scope, {limit:200});
    assert.ok(errors.some(e=>e.includes('22P02')), 'fixture must exercise real fallback, not primary query');
    assert.equal(all.total_count, 6, 'fallback retains real guest bookings only');
    assert.equal(all.summary.unpaid_count, 4, 'fallback unpaid chip excludes blocks');
    assert.ok(all.rows.every(r=>r.booking_code.startsWith('guest-')));
    const unpaid = await listSunsetBookingsAdmin(db, scope, {status:'unpaid',limit:1});
    assert.equal(unpaid.total_count, 4, 'fallback excludes blocks before unpaid count/paging');
    assert.equal(unpaid.summary.unpaid_count, 4);
    assert.equal(unpaid.rows.length, 1);
    assert.ok(unpaid.rows[0].booking_code.startsWith('guest-'));
  } finally {
    console.error = originalError;
    await db.query(`UPDATE bookings b SET metadata = metadata - 'hidden'
      FROM clients c WHERE c.id=b.client_id AND c.slug=$1 AND b.booking_code='guest-unpaid'`, [scope.clientSlug]);
  }
  console.log('PASS wolfhouse-somo: real 22P02 fallback excludes blocks before rows/unpaid chip/count/paging');
}

async function verifyCustomers(db, scope) {
  const { buildCustomerListParams, buildCustomerListCountsParams } = require('./lib/staff-customer-queries');
  const client = (await db.query('SELECT id FROM clients WHERE slug=$1', [scope.clientSlug])).rows[0].id;
  // Simulate the existing booking touch trigger, including its block-only identities.
  await db.query(`INSERT INTO customers (client_id,phone,full_name,location_id)
    SELECT client_id, phone, MIN(guest_name), 'sunset-somo' FROM bookings
    WHERE client_id=$1 GROUP BY client_id,phone`, [client]);
  await db.query(`INSERT INTO customers (client_id,phone,full_name,location_id) VALUES
    ($1,'+349001','Manual lead','sunset-somo'),
    ($1,'emailcust1:abcdef','Email-only lead','sunset-somo'),
    ($1,'+349002','Real conversation with block','sunset-somo')`, [client]);
  await db.query(`INSERT INTO conversations (client_id,phone,display_name)
    VALUES ($1,'+349002','Real conversation with block')`, [client]);
  await db.query(`INSERT INTO bookings (client_id,booking_code,phone,status,metadata) VALUES
    ($1,'mixed-guest-block','+340001','blocked','{"location_id":"sunset-somo"}'),
    ($1,'conversation-block','+349002','blocked','{"location_id":"sunset-somo"}')`, [client]);
  // A leaked service attached to a block must not promote the retained real contact.
  await db.query(`INSERT INTO booking_service_records (booking_id,client_slug,service_type)
    SELECT id,$2,'surf_lesson' FROM bookings WHERE client_id=$1 AND booking_code='conversation-block'`, [client, scope.clientSlug]);
  const query = { location: scope.locationId, limit: 200 };
  const expected = ['+340001','+340002','+340003','+340004','+340005','+340006','+349001','+349002','emailcust1:abcdef'].sort();
  const opts = buildCustomerListParams(scope.clientSlug, query);
  const all = (await db.query(opts.sql, opts.params)).rows;
  assert.deepEqual(all.map(r=>r.phone).sort(), expected, `${scope.clientSlug}: Guests excludes block-only identities, preserves real contacts`);
  assert.equal(all.find(r=>r.phone==='+340001').booking_count, 1, 'mixed guest count excludes block');
  assert.equal(all.find(r=>r.phone==='+349002').booking_count, 0);
  assert.equal(all.find(r=>r.phone==='+349002').service_count, 0);
  const filters = ['all','hot_leads','unpaid','warm_leads','checked_in_now','lesson_today','waiver_pending','equipment_out'];
  const countsOpts = buildCustomerListCountsParams(scope.clientSlug, query, filters.map(key=>({key,filter:key})));
  const counts = (await db.query(countsOpts.sql, countsOpts.params)).rows[0];
  for (const filter of filters) {
    const o = buildCustomerListParams(scope.clientSlug, {...query,filter});
    const rows = (await db.query(o.sql,o.params)).rows;
    assert.equal(counts[filter],rows.length, `${filter}: list/count parity`);
    assert.ok(rows.every(r=>expected.includes(r.phone)));
    if (filter==='hot_leads') assert.equal(rows.length,6);
    if (filter==='unpaid') assert.equal(rows.length,5);
    if (['lesson_today','waiver_pending','equipment_out'].includes(filter)) assert.equal(rows.length,0);
  }
  const first = buildCustomerListParams(scope.clientSlug, {...query,limit:2}, {keyset:true});
  let page = (await db.query(first.sql,first.params)).rows;
  const paged = [];
  while (page.length) {
    paged.push(...page.map(r=>r.phone));
    const cursor = page.at(-1);
    const next = buildCustomerListParams(scope.clientSlug, {...query,limit:2}, {keyset:true,cursor});
    page = (await db.query(next.sql,next.params)).rows;
  }
  assert.deepEqual(paged.sort(),expected,'keyset pages retain all real guests exactly once');
  const { buildInboxViewQuery, buildInboxViewCountsPlan } = require('./lib/staff-inbox-saved-views');
  const plan = buildInboxViewCountsPlan({clientSlug:scope.clientSlug,query});
  const customerPass = plan.passes.find(p=>p.source==='customers');
  assert.ok(customerPass, 'ordinary Inbox guest rail uses customer owner');
  const rail = (await db.query(customerPass.sql,customerPass.params)).rows[0];
  for (const viewId of ['all_people','hot_leads','unpaid']) {
    const built = buildInboxViewQuery({clientSlug:scope.clientSlug,viewId,query,page:{limit:200}});
    assert.ok(built.ok);
    const rows = (await db.query(built.sql,built.params)).rows;
    assert.equal(rail[viewId],rows.length,'ordinary Inbox view/rail count parity');
    assert.ok(rows.every(r=>expected.includes(r.phone)));
    assert.equal(rows.length,viewId==='all_people'?9:viewId==='hot_leads'?6:5);
  }
  console.log(`PASS ${scope.clientSlug}: Guests + hot/unpaid/chip parity + service exclusion + keyset paging + ordinary Inbox views`);
}

async function verifyTenantAndLocationScope(db) {
  const { buildCustomerListParams, buildCustomerListCountsParams } = require('./lib/staff-customer-queries');
  const clients = (await db.query('SELECT id,slug FROM clients')).rows;
  const sunset = clients.find(c=>c.slug==='sunset').id;
  const wolfhouse = clients.find(c=>c.slug==='wolfhouse-somo').id;
  await db.query(`INSERT INTO customers (client_id,phone,full_name,location_id,crm_tags) VALUES
    ($1,'+348881','Block-only here, real elsewhere','sunset-somo','{"hot_lead":true}'),
    ($2,'+348881','Real guest in other tenant',NULL,'{}'),
    ($1,'+348882','Guest with second-location block','sunset-somo','{}')`, [sunset,wolfhouse]);
  await db.query(`INSERT INTO bookings (client_id,booking_code,phone,status,metadata) VALUES
    ($1,'cross-tenant-block','+348881','blocked','{"location_id":"sunset-somo"}'),
    ($2,'cross-tenant-guest','+348881','confirmed','{}'),
    ($1,'multi-location-guest','+348882','confirmed','{"location_id":"sunset-somo"}'),
    ($1,'multi-location-block','+348882','blocked','{"location_id":"sunset-sardinero"}')`, [sunset,wolfhouse]);
  await db.query(`INSERT INTO booking_service_records (booking_id,client_slug,service_type)
    SELECT id,'sunset','surf_lesson' FROM bookings
    WHERE client_id=$1 AND booking_code='multi-location-block'`, [sunset]);
  for (const filter of ['all','hot_leads','unpaid']) {
    const q = buildCustomerListParams('sunset',{location:'sunset-somo',filter,limit:200});
    const rows = (await db.query(q.sql,q.params)).rows;
    assert.ok(!rows.some(r=>r.phone==='+348881'), 'another tenant cannot rescue a block-only customer, even manually tagged hot');
    assert.ok(rows.some(r=>r.phone==='+348882'), 'retain the actual private/mixed guest');
    const other = buildCustomerListParams('wolfhouse-somo',{filter,limit:200});
    assert.ok((await db.query(other.sql,other.params)).rows.some(r=>r.phone==='+348881'), 'other tenant real guest remains');
  }
  const query = {location:'sunset-sardinero',limit:200};
  const second = buildCustomerListParams('sunset',query);
  assert.equal((await db.query(second.sql,second.params)).rows.length,0, 'blocks/services cannot admit a guest into a second school');
  const counts = buildCustomerListCountsParams('sunset',query,[{key:'all',filter:'all'},{key:'hot_leads',filter:'hot_leads'}]);
  assert.deepEqual((await db.query(counts.sql,counts.params)).rows[0],{all:0,hot_leads:0});
  // A genuine service/booking in the second school still grants normal membership.
  await db.query(`INSERT INTO bookings (client_id,booking_code,phone,status,metadata)
    VALUES ($1,'second-school-guest','+348882','confirmed','{"location_id":"sunset-sardinero"}')`, [sunset]);
  assert.deepEqual((await db.query(second.sql,second.params)).rows.map(r=>r.phone),['+348882']);
  assert.deepEqual((await db.query(counts.sql,counts.params)).rows[0],{all:1,hot_leads:1});
  console.log('PASS tenant isolation + manual hot tag cannot rescue block-only identity + Sunset school membership/count parity');
}

async function main() {
  const db = new PGlite();
  try {
    await schema(db);
    for (const [slug, n] of [['sunset', 1], ['wolfhouse-somo', 2]]) {
      const scope = await seed(db, slug, n);
      await verifyBookings(db, scope);
      await verifyLodgingFallback(db, scope);
      await verifyCustomers(db, scope);
    }
    await verifyTenantAndLocationScope(db);
  } finally { await db.close(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
