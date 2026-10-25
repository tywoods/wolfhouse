'use strict';
const assert = require('node:assert/strict');
const { createCheckQuoteBook, publicFailure } = require('./v3-booking-flow');
const { normalizeQuoteRequest, normalizeCapabilityChoice, ACCOMMODATION_ONLY } = require('./staff-request-contract');

function harness({ rooms = true, quoteFailure = null, throwCatalog = false, failBegin = false,
  failCommit = false, failTerminalUpdates = 0, catalogItems = null } = {}) {
  const attempts = new Map(); let executions = 0; let inTx = false; let staged = null;
  let beginFailures = failBegin ? 1 : 0; let commitFailures = failCommit ? 1 : 0;
  const pg = { async query(sql, params = []) {
    if (/INSERT INTO luna_v3_prepare_attempts/.test(sql)) {
      const key = params[2];
      if (attempts.has(key)) return { rows: [] };
      const row = { id: `attempt-${attempts.size + 1}`, request_fingerprint: params[3], outcome: 'started', receipt: null,
        created_at: '2000-01-01T00:00:00Z', execution_owner: params[4], execution_backend_pid: 42,
        execution_backend_start: '2026-01-01T00:00:00Z', lease_expires_at: '2999-01-01T00:00:00Z' };
      attempts.set(key, row); return { rows: [row] };
    }
    if (/FROM pg_stat_activity/.test(sql) || /SELECT 1 FROM pg_stat_activity/.test(sql)) return { rows: [{ '?column?': 1 }] };
    if (/FROM luna_v3_prepare_attempts/.test(sql)) {
      if (/WHERE id=\$1/.test(sql)) return { rows: [[...attempts.values()].find((value) => value.id === params[0])].filter(Boolean) };
      return { rows: [attempts.get(params[2])].filter(Boolean) };
    }
    if (/UPDATE luna_v3_prepare_attempts/.test(sql)) {
      const row = [...attempts.values()].find((value) => value.id === params[0]);
      if (/lease_expires_at=now\(\)\+interval/.test(sql)) return { rows: row ? [{ id: row.id }] : [] };
      if (/SET owner_released_at=COALESCE/.test(sql)) {
        if (row && row.outcome === 'started') row.owner_released_at = new Date().toISOString();
        return { rows: [] };
      }
      if (failTerminalUpdates > 0) { failTerminalUpdates -= 1; throw new Error('injected receipt update failure'); }
      if (row && row.outcome === 'started') {
        const outcome = /outcome='applied'/.test(sql) ? 'applied' : params[2];
        const mutation = { row, receipt: JSON.parse(params[1]), outcome };
        if (inTx) staged = mutation;
        else { row.receipt = mutation.receipt; row.outcome = mutation.outcome; }
      }
      return { rows: row ? [{ id: row.id, receipt: JSON.parse(params[1]) }] : [] };
    }
    if (/^BEGIN/.test(sql)) { if (beginFailures-- > 0) throw new Error('injected BEGIN failure'); inTx = true; return { rows: [] }; }
    if (sql === 'COMMIT') {
      if (commitFailures-- > 0) throw new Error('injected COMMIT failure');
      if (staged) { staged.row.receipt = staged.receipt; staged.row.outcome = staged.outcome; }
      staged = null; inTx = false; return { rows: [] };
    }
    if (sql === 'ROLLBACK') { staged = null; inTx = false; return { rows: [] }; }
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  } };
  const deps = {
    async getPricingCatalog() { if (throwCatalog) throw new Error('transport'); return { ok: true, items: catalogItems || [
      { item_type: 'package', item_code: 'package_none', label: 'Accommodation only' },
    ], rules: [] }; },
    async findRooms() { executions += 1; return rooms ? { ok: true, rooms: [{ roomCode: 'R1', bedOptions: [{ code: 'B1' }] }] } : { ok: true, rooms: [] }; },
    async quote() { return quoteFailure || { ok: true, totalCents: 10000, depositCents: 5000, remainingCents: 5000, currency: 'EUR', lineItems: [], perPerson: [] }; },
  };
  return { flow: createCheckQuoteBook(deps), pg, attempts, executions: () => executions };
}
const input = { action: 'prepare', purpose: 'quote', check_in: '2027-01-01', check_out: '2027-01-03',
  guests: [{}], room: { kind: 'shared' }, package: { code: 'package_none' }, add_ons: [] };
const context = (event, extra = {}) => ({ turnId: `turn:${event}`, sessionId: 'session', principalId: 'principal', authenticatedInboundEventId: event, ...extra });

async function run() {
  const catalog = { items: [{ item_type: 'package', item_code: 'package_none', label: 'Accommodation only' }] };
  assert.equal(normalizeQuoteRequest({ ...input, guests: [] }, catalog, [], {}).code, 'guests_required', 'missing guest facts refuse specifically');
  assert.equal(publicFailure({ code: 'staff_package_ineligible' }).message,
    'That package is not eligible for the requested stay.', 'ineligible choice is distinguished');
  assert.equal(publicFailure({ code: 'exact_bed_selection_required' }).message,
    'No eligible beds are available for the requested stay.', 'no-bed refusal is specific');
  const execute = async (h, value, event) => h.flow(h.pg, value, context(event));

  const refusal = harness({ rooms: false });
  assert(refusal.pg, 'harness must expose pg');
  const event1 = '11111111-1111-4111-8111-111111111111';
  const r1 = await execute(refusal, input, event1);
  assert.equal(r1.code, 'requested_room_unavailable');
  assert.equal(r1.outcome, 'rejected');
  assert.deepEqual(await execute(refusal, input, event1), r1, 'same request replays refusal');
  const changed = await execute(refusal, { ...input, check_out: '2027-01-04' }, event1);
  assert.equal(changed.code, 'prepare_event_payload_mismatch');
  const r2 = await execute(refusal, input, '22222222-2222-4222-8222-222222222222');
  assert.equal(r2.code, 'requested_room_unavailable', 'new inbound event gets a new attempt');

  const success = harness({});
  const [a, b] = await Promise.all([execute(success, input, event1), execute(success, input, event1)]);
  assert.equal([a, b].filter((row) => row.ok === true).length, 1);
  assert.equal([a, b].some((row) => row.code === 'prepare_event_in_progress'), true, 'parallel second prepare is blocked');
  assert.equal((await execute(success, input, event1)).ok, true, 'completed success replays after restart');

  const unknown = harness({ throwCatalog: true });
  const u1 = await execute(unknown, input, event1);
  assert.equal(u1.outcome, 'unknown');
  assert.deepEqual(await execute(unknown, input, event1), u1, 'unknown is terminal and replays');

  const issuedPackage = { item_type: 'package', item_code: 'package_wave', label: 'Wave Week', description: 'Seven-night package' };
  const issued = { revision: 'rev-1', choices: [normalizeCapabilityChoice(ACCOMMODATION_ONLY), normalizeCapabilityChoice(issuedPackage)] };
  const namedInput = { ...input, package: { name: 'Wave Week' } };
  const binding = { issuedCapabilityRevision: 'rev-1', issuedCapabilitySnapshot: issued };
  const named = harness({ catalogItems: [issuedPackage] });
  assert.equal((await named.flow(named.pg, namedInput, context('33333333-3333-4333-8333-333333333333', binding))).ok,
    true, 'unchanged name-only choice is accepted');
  const changedSemantics = harness({ catalogItems: [{ ...issuedPackage, description: 'Changed package' }] });
  assert.equal((await changedSemantics.flow(changedSemantics.pg, namedInput,
    context('44444444-4444-4444-8444-444444444444', binding))).code,
  'stale_capability_choice', 'name-only changed semantics are refused');
  assert.equal((await named.flow(named.pg, { ...namedInput, package: { code: 'package_none', name: 'Wave Week' } },
    context('55555555-5555-4555-8555-555555555555', binding))).code,
  'catalog_choice_conflict', 'code and name mismatch is refused');

  for (const [name, options, value] of [
    ['BEGIN', { failBegin: true }, input],
    ['validation receipt UPDATE', { failTerminalUpdates: 1 }, { ...input, guests: [] }],
    ['business rejection receipt UPDATE', { rooms: false, failTerminalUpdates: 1 }, input],
    ['success receipt UPDATE', { failTerminalUpdates: 1 }, input],
    ['double terminal UPDATE with pooled backend alive', { failTerminalUpdates: 2 }, input],
    ['success COMMIT', { failCommit: true }, input],
  ]) {
    const fault = harness(options);
    const first = await execute(fault, value, event1);
    assert.equal(first.outcome, 'unknown', `${name} failure must be caught and terminalized`);
    const before = fault.executions();
    assert.deepEqual(await execute(fault, value, event1), first, `${name} terminal receipt must replay`);
    assert.equal(fault.executions(), before, `${name} replay must not rerun business work`);
  }

  assert.equal(publicFailure({ code: 'staff_pricing_unavailable', message: 'Rental wetsuit has no configured price.',
    field_errors: [{ path: 'add_ons[0]', code: 'staff_pricing_unavailable', message: 'Rental wetsuit has no configured price.' }] }).field_errors[0].message,
  'Rental wetsuit has no configured price.', 'specific missing-price reason is preserved');
  console.log('persisted inbound-event prepare lifecycle tests passed');
}
run().catch((error) => { console.error(error.stack || error); process.exit(1); });
