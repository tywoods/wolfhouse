'use strict';
// Real ordinary command -> execute -> PGlite SQL. No live inventory/payments/sends.
const assert = require('node:assert/strict');
const { runPayload } = require('./verify-luna-create-booking-occupants');
const { buildWolfhouseBookingCreateCommand } = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { loadConfig } = require('./lib/wolfhouse-quote-calculator');
const payload = {
  confirm: true, check_in: '2026-10-16', check_out: '2026-10-18',
  client_slug: 'wolfhouse-somo', guest_count: 2, guest_name: 'Clara Fischer',
  guests: [{ name: 'Clara Fischer' }, { name: 'Mateo Ruiz' }],
  phone: '+99900002814', package_code: 'package_none', room_type: 'shared',
  room_preference: 'shared', group_gender: 'mixed', payment_choice: 'full',
  room_name_hints: [
    { name: 'Clara Fischer', hint: 'female', confidence: 0.95, ambiguous: false },
    { name: 'Mateo Ruiz', hint: 'male', confidence: 0.95, ambiguous: false },
  ],
  selected_bed_codes: ['R5-B1', 'R4-B1'],
};
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const copy = () => structuredClone(payload);
function rejected(result, stage) {
  assert.equal(result.ok, false, JSON.stringify(result.body));
  if (stage) assert.equal(result.stage, stage);
  assert.equal(result.sql_calls.some(call => ['booking_create', 'occupant_insert', 'payment_update', 'commit'].includes(call.kind)), false);
  assert.equal(result.body.needs_human, false);
}
async function accepted(body, hooks) {
  const result = await runPayload(body, hooks);
  assert.equal(result.ok, true, JSON.stringify(result.body));
  assert.deepEqual(result.assigned_bed_codes, body.selected_bed_codes);
  assert.deepEqual(result.occupants.map(g => g.assigned_bed_code), body.selected_bed_codes);
  assert.deepEqual(result.occupants.map(g => g.guest_name), body.guests.map(g => g.name));
  return result;
}
const splitOnly = db => db.query("UPDATE beds SET sellable = bed_code IN ('R5-B1', 'R4-B1')");
test('accepted Clara/Mateo split survives mixed-only allocator shortage', () => accepted(copy(), { beforeBuild: splitOnly }));
test('other available mixed beds never replace explicit beds or guest mapping', () => accepted(copy()));
test('per-person correction permits valid split despite stale group summary', () => {
  const body = copy(); body.group_gender = 'female'; body.room_name_hints[1].explicit_gender = 'male';
  return accepted(body);
});
test('execution rechecks explicit per-person correction ahead of stale group', async () => {
  const body = copy(); body.group_gender = 'female'; body.room_name_hints[1].hint = 'female';
  body.selected_bed_codes = ['R5-B1', 'R5-B2'];
  rejected(await runPayload(body, { beforeExecute: (_db, command) => {
    command.transportBody.room_name_hints[1].explicit_gender = 'male';
  } }), 'execute');
});
test('reordered hint list binds by exact guest name, not hint position', () => {
  const body = copy(); body.room_name_hints.reverse(); return accepted(body);
});
test('explicit guest correction beats opposite provisional hint', () => {
  const body = copy(); body.guests[0].explicit_gender = 'female'; body.room_name_hints[0].hint = 'male'; return accepted(body);
});
for (const [name, mutate] of [
  ['swapped guest beds', p => p.selected_bed_codes.reverse()],
  ['missing per-guest eligibility', p => delete p.room_name_hints],
  ['ambiguous hint', p => p.room_name_hints[0].ambiguous = true],
  ['low confidence', p => p.room_name_hints[0].confidence = 0.69],
  ['boolean confidence', p => p.room_name_hints[0].confidence = true],
  ['wrong-name hint', p => p.room_name_hints[0].name = 'Unrelated Guest'],
  ['duplicate-name hints', p => p.room_name_hints.push({ ...p.room_name_hints[0] })],
  ['explicit opposite statement', p => p.guests[0].explicit_gender = 'male'],
  ['unknown bed', p => p.selected_bed_codes[0] = 'UNKNOWN-B1'],
  ['duplicate bed', p => p.selected_bed_codes[1] = p.selected_bed_codes[0]],
  ['missing guest bed', p => p.selected_bed_codes.pop()],
  ['extra bed', p => p.selected_bed_codes.push('R1-B1')],
  ['malformed selection type', p => p.selected_bed_codes = { bed: 'R5-B1' }],
  ['nested bed array', p => p.selected_bed_codes[0] = ['R5-B1']],
  ['blank CSV slots', p => p.selected_bed_codes = ', ,'],
  ['dropped CSV slot', p => p.selected_bed_codes = 'R5-B1,,R4-B1'],
  ['blank array slot', p => p.selected_bed_codes.push('')],
  ['group cannot override explicit hint', p => {
    p.group_gender = 'female'; p.selected_bed_codes = ['R5-B1', 'R5-B2'];
    p.room_name_hints[1].explicit_gender = 'male';
  }],
  ['conflicting person-level explicit sources', p => {
    p.guests[0].explicit_gender = 'female'; p.room_name_hints[0].explicit_gender = 'male';
  }],
  ['invalid character', p => p.selected_bed_codes[0] = "R5-B1'"],
]) test(name + ' fails closed without substitute', async () => {
  const body = copy(); mutate(body); rejected(await runPayload(body), 'build');
});
for (const [name, sql] of [
  ['unsellable bed', "UPDATE beds SET sellable=false WHERE bed_code='R5-B1'"],
  ['inactive bed', "UPDATE beds SET active=false WHERE bed_code='R5-B1'"],
  ['inactive room', "UPDATE rooms SET active=false WHERE room_code='R5'"],
  ['changed room eligibility', "UPDATE rooms SET room_type='male_only' WHERE room_code='R5'"],
  ['unrecognized room eligibility', "UPDATE rooms SET room_type='unrecognized' WHERE room_code='R5'"],
]) for (const stage of ['build', 'execute']) test(`${name} at ${stage} fails closed`, async () => {
  rejected(await runPayload(copy(), { [stage === 'build' ? 'beforeBuild' : 'beforeExecute']: db => db.query(sql) }), stage);
});
async function block(db, operator = false) {
  const booking = await db.query(`INSERT INTO bookings (client_id, booking_code, guest_name, status, check_in, check_out, guest_count)
    SELECT id, 'WH-OFFLINE-BLOCK', 'Offline blocker', 'confirmed', '2026-10-16', '2026-10-18', 1 FROM clients RETURNING id`);
  await db.query(`INSERT INTO booking_beds (client_id, booking_id, bed_code, room_code, assignment_type, assignment_start_date, assignment_end_date)
    SELECT id, $1, $2, 'R5', $3, '2026-10-16', '2026-10-18' FROM clients`,
  [booking.rows[0].id, operator ? 'R5-B2' : 'R5-B1', operator ? 'operator_block' : 'guest']);
}
for (const stage of ['build', 'execute']) for (const operator of [false, true]) test(`${operator ? 'room operator block' : 'occupied bed'} at ${stage} fails closed`, async () => {
  rejected(await runPayload(copy(), { [stage === 'build' ? 'beforeBuild' : 'beforeExecute']: db => block(db, operator) }), stage);
});
test('actual bot HTTP handler preserves the typed stale-selection rejection', async () => {
  const failure = await runPayload(copy(), { beforeExecute: db => block(db) });
  rejected(failure, 'execute');
  // SQL rejection above is real; inject its result at the service boundary to
  // exercise the unmodified HTTP handler mapper without a live listener/auth.
  const src = require('node:fs').readFileSync(require.resolve('./staff-query-api.js'), 'utf8');
  const start = src.indexOf('async function handleBotBookingCreate(req, res, user, authMode) {');
  const end = src.indexOf('\n}\n', start) + 2;
  assert(start > 0 && end > start);
  const context = {
    BOT_BOOKING_ENABLED: true, STAFF_AUTH_REQUIRED: true, DEFAULT_CLIENT: 'wolfhouse-somo',
    BOOKING_CREATE_CHANNELS: { LUNA_WHATSAPP: 'luna_whatsapp' },
    appendAuditLog() {}, readBody: async () => JSON.stringify(copy()),
    resolveBotHandlerTrustedClientSlug: () => 'wolfhouse-somo', loadWolfhouseQuoteConfigWithOverlay: async () => ({}),
    withPgClient: fn => fn({}), buildWolfhouseBookingCreateCommand: async () => ({ ok: true, command: {} }),
    executeWolfhouseBookingCreate: async () => failure,
    sendJSON: (_res, status, body) => ({ status, body }), send400: (_res, error) => ({ status: 400, body: { error } }),
  };
  const vm = require('node:vm'); vm.createContext(context); vm.runInContext(src.slice(start, end), context);
  const out = await context.handleBotBookingCreate({}, {}, null, 'fixture');
  assert.equal(out.status, 409); assert.equal(out.body.reason_code, 'availability_changed');
  assert.equal(out.body.needs_human, false); assert.equal(out.body.write_performed, false);
});
test('DB read failure cannot fall through to allocation or write', async () => {
  const result = await buildWolfhouseBookingCreateCommand({ channel: 'luna_whatsapp', trustedClientSlug: 'wolfhouse-somo',
    transportBody: copy(), quoteConfig: loadConfig(), pgClient: { query: async () => { throw new Error('offline DB failure'); } } });
  assert.equal(result.ok, false); assert.equal(result.body.reason_code, 'availability_recheck_failed');
});
test('unknown composition retains explicitly selected mixed beds', () => {
  const body = copy(); delete body.room_name_hints; delete body.group_gender;
  body.selected_bed_codes = ['R1-B2', 'R1-B1']; return accepted(body);
});
test('legacy no-selection path still auto-assigns', async () => {
  const body = copy(); delete body.selected_bed_codes;
  const result = await runPayload(body);
  assert.equal(result.ok, true, JSON.stringify(result.body)); assert.equal(result.assigned_bed_codes.length, 2);
});
(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed++; console.log('PASS ' + name); }
    catch (error) { console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log(`Explicit bed selection: ${passed}/${tests.length} passed; offline PGlite, no live writes or sends.`);
  if (passed !== tests.length) process.exitCode = 1;
})();
