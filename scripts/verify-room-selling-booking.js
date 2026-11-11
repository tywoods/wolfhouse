'use strict';
// Real application SQL against the existing disk-backed offline fixture. No sends.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { seedOfflineBookingDb } = require('./verify-luna-create-booking-occupants');
const { PGlite } = require('@electric-sql/pglite');
const { buildWolfhouseBookingCreateCommand, executeWolfhouseBookingCreate } = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { buildWolfhouseAvailabilityCommand, executeWolfhouseAvailabilityCheck } = require('./lib/luna-front-desk-accommodation-availability-service');
const { getBedCalendarBlocksQuery } = require('./lib/staff-bed-calendar-queries');
const CLIENT = 'wolfhouse-somo';
const DEFAULT_OUT = path.resolve(__dirname, '../../../artifacts/ale-launch-20261111/private-opt/inventory');
function payload(type = 'private', count = 2, key = `${type}-${count}`) {
  return { confirm: true, client_slug: CLIENT, check_in: '2026-10-16', check_out: '2026-10-19',
    guest_count: count, guest_name: 'Offline A', guests: ['Offline A', 'Offline B', 'Offline C'].slice(0, count).map(name => ({ name })),
    phone: '+999****001', package_code: 'package_none', room_type: type,
    room_preference: type === 'shared' ? 'mixed' : 'private', payment_choice: 'full',
    selected_bed_codes: ['R1-B2', 'R1-B1', 'R1-B3'].slice(0, count), idempotency_key: `private-opt-${key}` };
}
async function seed(db, body = payload()) {
  await seedOfflineBookingDb(db, body);
  await db.exec("ALTER TYPE booking_status ADD VALUE 'blocked'; ALTER TABLE bookings ADD room_preference text;");
  await db.query("UPDATE rooms SET selling_mode='private_optional' WHERE room_code='R1'");
  // Synthetic Staff-owned tariff, deliberately not a legacy-double tariff.
  await db.query(`INSERT INTO wh_pricing_rules (client_slug,item_type,item_code,season_code,unit,amount_cents,currency,active)
    VALUES ($1,'supplement','private',NULL,'per_room_per_night',1700,'EUR',true)`, [CLIENT]);
}
async function build(pg, body, channel = 'luna_whatsapp') {
  return buildWolfhouseBookingCreateCommand({ channel, trustedClientSlug: CLIENT, transportBody: body,
    actor: { staff_user_id: 'offline-operator', staff_role: 'operator' }, pgClient: pg });
}
async function create(pg, body, channel = 'luna_whatsapp') {
  const built = await build(pg, body, channel);
  return built.ok && !built.recovered ? executeWolfhouseBookingCreate(pg, built.command, { stripeConfig: { stripeLinksEnabled: false } }) : built;
}
async function availability(pg, body) {
  const built = buildWolfhouseAvailabilityCommand({ channel: 'bot_http', trustedClientSlug: CLIENT,
    transportBody: body, demoCalendarEnrichment: false });
  assert.equal(built.ok, true, JSON.stringify(built));
  const result = await executeWolfhouseAvailabilityCheck(pg, built.command);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.body;
}
async function snapshot(db) {
  const tables = ['bookings', 'booking_beds', 'booking_guests', 'payments', 'booking_service_records',
    'booking_conversation_links', 'booking_confirmation_owed', 'workflow_events', 'customers', 'conversations'];
  const result = {};
  for (const table of tables) result[table] = (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return result;
}
async function roomBlocks(db, start, end) {
  return (await db.query(getBedCalendarBlocksQuery(), [CLIENT, start, end])).rows.filter(r => r.room_code === 'R1');
}
async function run(out = DEFAULT_OUT) {
  fs.mkdirSync(out, { recursive: true });
  const report = { engine: 'PGlite real PostgreSQL SQL, disk-backed; NOT concurrency proof',
    scope: 'Staff services/create/inventory; model wording and rendered UI require separate acceptance evidence', cases: [] };
  async function test(name, fn) {
    const dir = fs.mkdtempSync(path.join(out, 'db-'));
    let db = new PGlite(dir);
    const calls = [];
    const pg = { query: async (sql, args) => { calls.push({ sql, args }); return db.query(sql, args); } };
    const evidence = { name, passed: false };
    try {
      await seed(db);
      await fn({ pg, get db() { return db; }, evidence, reopen: async () => { await db.close(); db = new PGlite(dir); } });
      evidence.passed = true;
      console.log(`PASS ${name}`);
    } catch (error) {
      evidence.error = error.stack;
      console.error(`FAIL ${name}: ${error.message}`);
    } finally {
      evidence.calls = calls;
      await db.close();
      fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(evidence, null, 2));
      report.cases.push({ name, passed: evidence.passed, error: evidence.error });
    }
  }
  const commercial = {};
  for (const count of [1, 2, 3]) for (const type of ['private', 'double']) {
    await test(`${type}-${count}-whole-room`, async ctx => {
      const body = payload(type, count);
      // No supplied gender and no R6 assumption: Staff must select an ordinary room.
      const searchBody = { ...body }; delete searchBody.selected_bed_codes;
      const offered = await availability(ctx.pg, searchBody);
      ctx.evidence.offered = offered;
      assert.equal(offered.selected_room_code, 'R1');
      assert.equal(offered.needs_clarification, false);
      assert.equal(offered.selected_bed_codes.length, count);
      assert.ok(offered.available_beds.filter(b => offered.selected_bed_codes.includes(b.bed_code)).every(b => b.selected_selling_mode === 'private'));
      body.conversation_id = (await ctx.db.query('SELECT id FROM conversations LIMIT 1')).rows[0].id;
      const result = await create(ctx.pg, body); ctx.evidence.created = result;
      assert.equal(result.ok, true, JSON.stringify(result.body));
      const supplement = result.body.quote.line_items.filter(line => line.code === 'room_supplement');
      assert.equal(supplement.length, 1);
      assert.equal(supplement[0].total_cents, 1700 * 3, 'one Staff-priced room supplement, never per blocked bed');
      assert.equal(result.body.quote.total_cents, 4000 * 3 * count + 1700 * 3);
      const beforeRetry = await snapshot(ctx.db);
      const retry = await create(ctx.pg, body); ctx.evidence.retry = retry;
      assert.equal(retry.ok, true, JSON.stringify(retry.body));
      assert.equal(retry.body.booking_id, result.body.booking_id);
      assert.deepEqual(await snapshot(ctx.db), beforeRetry, 'retry must not write extra parents/blocks/payments/links');
      await ctx.reopen();
      const parent = (await ctx.db.query('SELECT * FROM bookings WHERE id=$1', [result.body.booking_id])).rows[0];
      const companions = (await ctx.db.query("SELECT * FROM bookings WHERE metadata->>'private_room_parent_booking_id'=$1", [parent.id])).rows;
      assert.equal(companions.length, 1);
      assert.equal(parent.guest_count, count);
      assert.equal(parent.primary_room_code, 'R1');
      assert.ok(['private', 'double'].includes(parent.requested_room_type));
      assert.equal((await ctx.db.query("SELECT selling_mode FROM rooms WHERE room_code='R1'")).rows[0].selling_mode, 'private_optional');
      const guests = (await ctx.db.query('SELECT * FROM booking_guests ORDER BY guest_number')).rows;
      assert.equal(guests.length, count, 'no fictitious guests for blocked beds');
      assert.deepEqual(guests.map(g => g.guest_name), body.guests.map(g => g.name));
      assert.deepEqual(guests.map(g => g.assigned_bed_code), body.selected_bed_codes);
      for (const block of companions) {
        assert.equal(block.status, 'blocked'); assert.equal(block.client_id, parent.client_id);
        assert.equal(block.metadata.block_type, 'private_room_companion');
        assert.equal(Number(block.total_amount_cents), 0); assert.equal(Number(block.deposit_required_cents), 0);
        assert.equal((await ctx.db.query('SELECT * FROM payments WHERE booking_id=$1', [block.id])).rows.length, 0);
      }
      const all = (await ctx.db.query("SELECT bed_code FROM beds WHERE room_id=(SELECT id FROM rooms WHERE room_code='R1') ORDER BY bed_code")).rows.map(b => b.bed_code);
      const nights = [['2026-10-16','2026-10-17'], ['2026-10-17','2026-10-18'], ['2026-10-18','2026-10-19']];
      ctx.evidence.nights = [];
      for (const [start, end] of nights) {
        const blocks = await roomBlocks(ctx.db, start, end);
        assert.deepEqual(blocks.map(b => b.bed_code).sort(), all, 'exactly one coverage row per physical bed/night');
        const shared = await availability(ctx.pg, { ...payload('shared', 1), selected_bed_codes: undefined, check_in: start, check_out: end });
        assert.ok(!shared.available_beds.some(b => b.room_code === 'R1'), 'shared search excludes whole room');
        ctx.evidence.nights.push({ start, end, blocks, shared });
        for (const bed of all) {
          const attempt = await create(ctx.pg, { ...payload('shared', 1, `manual-${bed}-${start}`),
            selected_bed_codes: [bed], check_in: start, check_out: end, staff_payment_choice: 'unpaid' }, 'manual_staff');
          assert.equal(attempt.ok, false, `Staff manual placement must reject ${bed}: ${JSON.stringify(attempt)}`);
          assert.ok(JSON.stringify(attempt.body).match(/overlap|occupied|unavailable|availability_changed|incompatible_preselected_beds/), JSON.stringify(attempt.body));
        }
      }
      assert.deepEqual(await snapshot(ctx.db), beforeRetry, 'failed manual placements must not mutate');
      assert.equal((await roomBlocks(ctx.db, '2026-10-19', '2026-10-20')).length, 0);
      const adjacent = await create(ctx.pg, { ...payload('private', count, `adjacent-${type}-${count}`), check_in: '2026-10-19', check_out: '2026-10-22' });
      assert.equal(adjacent.ok, true, 'checkout-day adjacent create: ' + JSON.stringify(adjacent.body));
      commercial[`${type}-${count}`] = { total: parent.total_amount_cents, deposit: parent.deposit_required_cents,
        room: parent.primary_room_code, mode: parent.requested_room_type, preference: parent.room_preference,
        blocks: all, occupantBeds: guests.map(g => g.assigned_bed_code) };
      ctx.evidence.readback = { parent, companions, guests, adjacent };
    });
  }
  await test('double-private-synonyms', async () => {
    for (const count of [1, 2, 3]) {
      assert.ok(commercial[`private-${count}`] && commercial[`double-${count}`], 'both alias cases must finish');
      assert.deepEqual(commercial[`double-${count}`], commercial[`private-${count}`], 'same price, saved mode, real occupants and whole-room coverage');
    }
  });
  await test('companion-failure-atomic-rollback', async ctx => {
    const body = payload('private', 1, 'forced-rollback');
    body.conversation_id = (await ctx.db.query('SELECT id FROM conversations LIMIT 1')).rows[0].id;
    // Real DB failure AFTER the companion is inserted, exercising rollback of the
    // parent, occupants, payments, CRM and durable conversation links as well.
    await ctx.db.exec(`CREATE FUNCTION reject_companion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.metadata->>'block_type'='private_room_companion' THEN
        RAISE EXCEPTION 'forced_companion_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_companion BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION reject_companion();`);
    const before = await snapshot(ctx.db);
    let result;
    try { result = await create(ctx.pg, body); } catch (e) { result = { ok: false, error: e.message }; }
    ctx.evidence.failure = result;
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result), /forced_companion_failure/);
    assert.deepEqual(await snapshot(ctx.db), before, 'companion failure must roll back every business table');
    await ctx.db.exec('DROP TRIGGER reject_companion ON bookings; DROP FUNCTION reject_companion();');
    const recovered = await create(ctx.pg, body); assert.equal(recovered.ok, true, JSON.stringify(recovered));
    const after = await snapshot(ctx.db);
    assert.equal((await create(ctx.pg, body)).body.booking_id, recovered.body.booking_id);
    assert.deepEqual(await snapshot(ctx.db), after);
    ctx.evidence.recovered = recovered;
  });
  await test('shared-and-private-only-regressions', async ctx => {
    // Shared private-optional inventory retains ordinary mixed-bed semantics.
    const shared = payload('shared', 1, 'shared-first');
    const first = await create(ctx.pg, shared); ctx.evidence.shared = first;
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal((await ctx.db.query("SELECT * FROM bookings WHERE metadata->>'block_type'='private_room_companion'")).rows.length, 0);
    assert.equal((await roomBlocks(ctx.db, shared.check_in, shared.check_out)).length, 1);
    const before = await snapshot(ctx.db);
    const exclusive = await create(ctx.pg, { ...payload('private', 1, 'occupied-private'), selected_bed_codes: ['R1-B1'] });
    assert.equal(exclusive.ok, false, 'an existing shared occupant must prevent private sale');
    assert.deepEqual(await snapshot(ctx.db), before);
    const second = await create(ctx.pg, { ...shared, idempotency_key: 'private-opt-shared-second', selected_bed_codes: ['R1-B1'] });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(first.body.quote.total_cents, second.body.quote.total_cents, 'ordinary shared prices unchanged');
    await ctx.db.query("UPDATE rooms SET selling_mode='private' WHERE room_code='R1'");
    const privateOnlyBefore = await snapshot(ctx.db);
    const unrelated = await create(ctx.pg, { ...shared, idempotency_key: 'private-opt-private-only-shared', selected_bed_codes: ['R1-B3'] });
    assert.equal(unrelated.ok, false, 'Private-only cannot sell spare beds to unrelated guests');
    assert.deepEqual(await snapshot(ctx.db), privateOnlyBefore);
    const onlySearch = await availability(ctx.pg, { ...shared, selected_bed_codes: undefined, check_in: '2026-10-19', check_out: '2026-10-22' });
    assert.ok(!onlySearch.selected_bed_codes.some(b => b.startsWith('R1-')), 'shared allocator must not sell a Private-only bed');
    const onlyPrivate = await create(ctx.pg, { ...payload('private', 1, 'private-only-private'), check_in: '2026-10-19', check_out: '2026-10-22' });
    assert.equal(onlyPrivate.ok, true, JSON.stringify(onlyPrivate));
    ctx.evidence.regressions = { exclusive, second, unrelated, onlySearch, onlyPrivate };
  });
  await test('shared-fill-ranking-and-person-bound-eligibility', async ctx => {
    const request = { ...payload('shared', 2, 'rank'), selected_bed_codes: undefined };
    const optional = await availability(ctx.pg, request);
    await ctx.db.query("UPDATE rooms SET selling_mode='shared' WHERE room_code='R1'");
    const shared = await availability(ctx.pg, request);
    assert.deepEqual(optional.selected_bed_codes, shared.selected_bed_codes, 'optional flag must not change shared fill ranking');
    assert.deepEqual(optional.available_beds, shared.available_beds);
    await ctx.db.query("UPDATE rooms SET selling_mode='private_optional' WHERE room_code='R1'");
    const before = await snapshot(ctx.db);
    const bad = await create(ctx.pg, { ...payload('shared', 2, 'person-bound'), room_preference: 'any',
      guests: [{ name: 'Offline A', explicit_gender: 'male' }, { name: 'Offline B', explicit_gender: 'female' }],
      selected_bed_codes: ['R5-B1', 'R2-B1'] });
    assert.equal(bad.ok, false, 'wrong person-to-gendered-bed mapping must remain refused');
    assert.deepEqual(await snapshot(ctx.db), before);
    const good = await create(ctx.pg, { ...payload('shared', 2, 'person-bound-valid'), room_preference: 'any',
      guests: [{ name: 'Offline A', explicit_gender: 'male' }, { name: 'Offline B', explicit_gender: 'female' }],
      selected_bed_codes: ['R2-B1', 'R5-B1'] });
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.deepEqual((await ctx.db.query('SELECT assigned_bed_code FROM booking_guests ORDER BY guest_number')).rows.map(r => r.assigned_bed_code), ['R2-B1','R5-B1']);
    ctx.evidence.results = { optional, shared, bad, good };
  });
  await test('maintenance-and-operator-exclusion', async ctx => {
    await ctx.db.query("UPDATE beds SET sellable=false WHERE bed_code='R1-B5'");
    let before = await snapshot(ctx.db);
    const maintenance = await create(ctx.pg, payload('private', 1, 'maintenance'));
    assert.equal(maintenance.ok, false, 'private sale cannot silently omit an unsellable companion bed');
    assert.deepEqual(await snapshot(ctx.db), before, 'maintenance refusal leaves no partial parent');
    await ctx.db.query("UPDATE beds SET sellable=true WHERE bed_code='R1-B5'");
    // Existing Staff/operator block representation, not a new reservation model.
    await ctx.db.query(`WITH block AS (
      INSERT INTO bookings (client_id,booking_code,guest_name,status,payment_status,check_in,check_out,guest_count,metadata)
      SELECT id,'OFFLINE-OPERATOR','Blocked','blocked','not_requested','2026-10-16','2026-10-19',1,'{"staff_calendar_block":true}' FROM clients RETURNING id,client_id
    ) INSERT INTO booking_beds (client_id,booking_id,bed_id,bed_code,room_code,assignment_start_date,assignment_end_date,assignment_type)
      SELECT block.client_id,block.id,bd.id,bd.bed_code,'R1','2026-10-16','2026-10-19','operator_block'
      FROM block CROSS JOIN beds bd WHERE bd.bed_code='R1-B5'`);
    before = await snapshot(ctx.db);
    const operator = await create(ctx.pg, payload('double', 1, 'operator'));
    assert.equal(operator.ok, false, 'operator-blocked sibling prevents whole-room sale');
    assert.deepEqual(await snapshot(ctx.db), before);
    ctx.evidence.results = { maintenance, operator };
  });
  report.passed = report.cases.every(c => c.passed);
  fs.writeFileSync(path.join(out, 'booking.json'), JSON.stringify(report, null, 2));
  return report;
}
module.exports = { payload, seed, build, create, availability, snapshot, roomBlocks, run, DEFAULT_OUT };
if (require.main === module) run(path.resolve(process.argv[2] || DEFAULT_OUT)).then(r => { if (!r.passed) process.exitCode = 1; }).catch(e => { console.error(e); process.exitCode = 1; });
